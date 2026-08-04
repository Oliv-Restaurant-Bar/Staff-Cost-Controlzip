import { createContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export type UserRole =
  | 'admin'
  | 'service_manager'
  | 'kueche_manager'
  | 'beaulieu_manager'
  /** Lesezugriff auf Beaulieu-Daten (z.B. Warenrechnungen); kein Schreiben */
  | 'beaulieu_viewer';

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  role: UserRole;
  /**
   * true sobald die Rolle für die aktuelle Session verbindlich feststeht
   * (aus persistiertem localStorage-Wert ODER nach loadUserRole).
   * Solange false UND ein User eingeloggt ist, dürfen keine rollen-gegateten
   * Routen gerendert werden (sonst kurzzeitig falsche Rechte).
   */
  roleResolved: boolean;
  isAdmin: boolean;
  isServiceManager: boolean;
  isKuecheManager: boolean;
  /** Beaulieu-Geschäftsführer: nur Beaulieu, kein Tenant-Wechsel, Vollzugriff */
  isBeaulieuManager: boolean;
  /** Beaulieu-Leser: nur Beaulieu, nur Lesezugriff */
  isBeaulieuViewer: boolean;
  /**
   * Increments on every confirmed auth event (boot, TOKEN_REFRESHED, SIGNED_IN).
   * Data-fetching pages must depend on this so they re-fetch after a background
   * token renewal even when user?.id hasn't changed.
   */
  sessionVersion: number;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

const VALID_ROLES: UserRole[] = [
  'admin', 'service_manager', 'kueche_manager', 'beaulieu_manager', 'beaulieu_viewer',
];

/** Liest die zuletzt bestätigte Rolle aus localStorage (validiert), sonst null. */
const readPersistedRole = (): UserRole | null => {
  try {
    const r = localStorage.getItem('user_role');
    return r && (VALID_ROLES as string[]).includes(r) ? (r as UserRole) : null;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]             = useState<User | null>(null);
  const [session, setSession]       = useState<Session | null>(null);
  const [loading, setLoading]       = useState(true);
  // Initial-Rolle: persistierte Rolle des letzten Logins (Refresh-Fall),
  // sonst restriktiver Default — NIE 'admin' (sonst sehen eingeschränkte
  // Logins beim Boot kurz Admin-Navigation/-Daten).
  const [role, setRole]             = useState<UserRole>(() => readPersistedRole() ?? 'kueche_manager');
  const [roleResolved, setRoleResolved] = useState<boolean>(() => readPersistedRole() !== null);
  const [sessionVersion, setSessionVersion] = useState(0);

  const bootDoneRef      = useRef(false);
  const currentUserIdRef = useRef<string | null>(null);

  const EMAIL_ROLE_MAP: Record<string, UserRole> = {
    'admin@olivbern.ch':            'admin',
    'berat@malenas.ch':             'admin',
    'service@olivbern.ch':          'service_manager',
    'kueche@olivbern.ch':           'kueche_manager',
    'info@restaurantbeaulieu.ch':   'beaulieu_manager',
  };

  const applyRole = (r: UserRole) => {
    setRole(r);
    setRoleResolved(true);
    localStorage.setItem('user_role', r);
    // [AUTH] debug logs for all roles
    console.log(`[AUTH] user role: ${r}`);
    if (r === 'beaulieu_manager') {
      console.log('[AUTH] tenant locked: beaulieu');
      console.log('[AUTH] allowed modules: dienstplanung, personal_fix, tagesansicht, tages_controlling');
      console.log('[AUTH] tenant switch hidden: true');
    }
  };

  // Helper: emit [AUTH] email log for beaulieu_manager
  const logBeaulieuEmail = (email: string | undefined, resolvedRole: UserRole) => {
    if (resolvedRole === 'beaulieu_manager' && email) {
      console.log(`[AUTH] email: ${email}`);
      console.log('[AUTH] role: beaulieu_manager');
    }
  };

  const loadUserRole = useCallback(async (userId: string, email?: string) => {
    console.log('[AUTH] loadUserRole start', { userId, email });

    try {
      const { data, error } = await supabase.rpc('get_my_role' as any);
      if (!error && data) {
        applyRole(data as UserRole);
        logBeaulieuEmail(email, data as UserRole);
        console.log('[AUTH] loadUserRole: resolved via RPC', data);
        syncEmail(userId, email);
        return;
      }
    } catch { /* fall through */ }

    try {
      const { data, error } = await (supabase as any)
        .from('user_profiles').select('role').eq('id', userId).maybeSingle();
      if (!error && data?.role) {
        applyRole(data.role as UserRole);
        logBeaulieuEmail(email, data.role as UserRole);
        console.log('[AUTH] loadUserRole: resolved via user_profiles', data.role);
        syncEmail(userId, email);
        return;
      }
    } catch { /* fall through */ }

    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      // Read-only Bootstrap-Fallback: NIE user_profiles automatisch schreiben
      // (produktive Profile dürfen durch blosses Einloggen nicht verändert werden).
      const r = EMAIL_ROLE_MAP[email.toLowerCase()];
      applyRole(r);
      logBeaulieuEmail(email, r);
      console.log('[AUTH] loadUserRole: resolved via email map (read-only fallback)', r);
      return;
    }

    console.warn('[AUTH] loadUserRole: Rolle konnte nicht geladen werden (RPC, user_profiles und E-Mail-Fallback ohne Treffer) — restriktiver Default kueche_manager');
    applyRole('kueche_manager');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncEmail = (userId: string, email?: string) => {
    if (!email) return;
    (supabase as any).from('user_profiles').update({ email: email.toLowerCase() })
      .eq('id', userId).then(() => {}).catch(() => {});
  };

  // ── completeBoot ────────────────────────────────────────────────────────────
  // Runs exactly once per auth session (guarded by bootDoneRef).
  // MUST NOT be async-blocked by loadUserRole — the app must render immediately.
  //
  // Design:
  //   1. Set React state synchronously → app unblocks (loading=false, data can load)
  //   2. Fire loadUserRole in background → role arrives a moment later
  //
  // This is safe because:
  //   - The initial role is the persisted role of the last login (refresh case)
  //     or the restrictive default 'kueche_manager' — never 'admin'.
  //   - While a user session exists and roleResolved=false, AppContent shows a
  //     spinner instead of role-gated routes (no wrong-permission flash).
  //   - sessionVersion=1 triggers SchedulePlanner to fetch with a valid JWT.
  //   - Role update re-renders the nav but doesn't re-fetch data.
  const completeBoot = useCallback((sess: Session | null, source: string) => {
    const wasBootDone = bootDoneRef.current;
    console.log('[AUTH] completeBoot from', source, { wasBootDone, hasSession: !!sess });

    if (wasBootDone) {
      console.log('[AUTH] completeBoot: boot already done — ignored (source:', source, ')');
      return;
    }
    bootDoneRef.current = true;

    setSession(sess);
    setUser(sess?.user ?? null);
    currentUserIdRef.current = sess?.user?.id ?? null;

    // ── UNBLOCK THE APP IMMEDIATELY ──────────────────────────────────────────
    // loading=false and sessionVersion++ are set BEFORE loadUserRole.
    // This ensures the UI is never blocked by a slow/hanging role query.
    setLoading(false);
    setSessionVersion(v => v + 1);

    // Load role in background — does NOT block boot.
    if (sess?.user) {
      loadUserRole(sess.user.id, sess.user.email).catch(err => {
        console.error('[AUTH] loadUserRole background error:', err);
      });
    }
  }, [loadUserRole]);

  useEffect(() => {

    // ── Boot strategy: THREE signals, whichever fires first wins ─────────────
    //
    //  A. getSession()    — synchronous-ish (awaits initializePromise + lock).
    //                       Typically resolves in <100ms for non-expired tokens.
    //
    //  B. INITIAL_SESSION — fired by Supabase's onAuthStateChange after
    //                       initializePromise resolves.  Backup if A is slow.
    //
    //  C. SIGNED_IN       — fired on actual login AND sometimes on init.
    //                       Used as a third fallback if A+B are delayed.
    //
    //  completeBoot() is synchronous and guarded by bootDoneRef — whichever
    //  signal wins, the rest are no-ops.
    //
    //  NO SAFETY TIMEOUT — a timeout produces an inconsistent half-booted state.
    //  With three signals, we're covered for all realistic scenarios.
    // ─────────────────────────────────────────────────────────────────────────

    // Signal A
    supabase.auth.getSession()
      .then(({ data: { session: sess } }) => {
        console.log('[AUTH] getSession() resolved', { hasSession: !!sess, bootDone: bootDoneRef.current });
        completeBoot(sess, 'getSession');
      })
      .catch(err => {
        console.error('[AUTH] getSession() threw:', err);
        completeBoot(null, 'getSession-error');
      });

    // Signals B + C (and TOKEN_REFRESHED, SIGNED_OUT, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, sess) => {
        console.log('[AUTH] onAuthStateChange', {
          event,
          bootDoneBefore: bootDoneRef.current,
          hasSession: !!sess,
          hasUser: !!sess?.user,
          userId: sess?.user?.id,
          currentUserId: currentUserIdRef.current,
          tokenExpiry: sess?.expires_at
            ? new Date(sess.expires_at * 1000).toISOString()
            : null,
        });

        // ── B: INITIAL_SESSION ───────────────────────────────────────────────
        if (event === 'INITIAL_SESSION') {
          completeBoot(sess, 'INITIAL_SESSION');
          return;
        }

        // ── C: SIGNED_IN as boot signal ──────────────────────────────────────
        // If boot hasn't completed yet (getSession + INITIAL_SESSION were too
        // slow or returned null), use SIGNED_IN to complete it.
        if (event === 'SIGNED_IN' && !bootDoneRef.current) {
          completeBoot(sess, 'SIGNED_IN-boot');
          return;
        }

        // ── SIGNED_IN post-boot (same user) ──────────────────────────────────
        // Supabase sometimes fires SIGNED_IN for background token renewals.
        // Just bump sessionVersion so data pages re-fetch.
        if (event === 'SIGNED_IN' && sess?.user?.id === currentUserIdRef.current) {
          setSession(sess);
          setUser(sess?.user ?? null);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN same user)');
            return v + 1;
          });
          return;
        }

        // ── SIGNED_IN post-boot (different user — e.g. logout then re-login) ─
        // Reset bootDone so completeBoot can run for the new user.
        if (event === 'SIGNED_IN') {
          bootDoneRef.current = false;
          completeBoot(sess, 'SIGNED_IN-reboot');
          return;
        }

        // ── TOKEN_REFRESHED ──────────────────────────────────────────────────
        if (event === 'TOKEN_REFRESHED') {
          setSession(sess);
          setUser(sess?.user ?? null);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(TOKEN_REFRESHED)');
            return v + 1;
          });
          return;
        }

        // ── USER_UPDATED ─────────────────────────────────────────────────────
        if (event === 'USER_UPDATED') {
          setSession(sess);
          setUser(sess?.user ?? null);
          return;
        }

        // ── SIGNED_OUT ───────────────────────────────────────────────────────
        // signOut() already called _clearLocalAuth() so this is a no-op in most
        // cases, but we run it again to be safe.
        if (event === 'SIGNED_OUT') {
          _clearLocalAuth();
          return;
        }
      }
    );

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeBoot]);

  // ── _clearLocalAuth ──────────────────────────────────────────────────────────
  // Resets all auth state.  Called by signOut() immediately AND by SIGNED_OUT
  // handler as a belt-and-suspenders fallback.
  const _clearLocalAuth = () => {
    setSession(null);
    setUser(null);
    setRole('kueche_manager');
    // Nächster Login muss die Rolle frisch auflösen — ein anderer Benutzer
    // darf nie die Rolle des vorherigen Benutzers erben.
    setRoleResolved(false);
    setLoading(false);
    localStorage.removeItem('user_role');
    bootDoneRef.current = false;
    currentUserIdRef.current = null;
    setSessionVersion(0);
  };

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    console.log('[AUTH] signIn', email);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.includes('Invalid login credentials'))
        return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
      if (error.message.includes('Email not confirmed'))
        return { error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.' };
      return { error: 'Anmeldung fehlgeschlagen: ' + error.message };
    }
    return { error: null };
  };

  const signOut = async () => {
    console.log('[AUTH] signOut start');

    // Step 1: clear local state IMMEDIATELY so the UI shows LoginPage right away.
    // Do NOT wait for Supabase's SIGNED_OUT event — it depends on the HTTP call
    // POST /auth/v1/logout succeeding.  If that call returns a non-404/401/403
    // error, Supabase skips _removeSession() and SIGNED_OUT is never fired.
    _clearLocalAuth();

    // Step 2: await the Supabase server-side signOut.
    // Yielding here lets React flush the Step 1 state updates (LoginPage appears)
    // while we wait for the HTTP round-trip.  Errors are NOT silently swallowed.
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('[AUTH] signOut error:', error.message, '| status:', (error as any).status);
      } else {
        console.log('[AUTH] signOut: success');
      }
    } catch (err) {
      console.error('[AUTH] signOut threw unexpectedly:', err);
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      loading,
      role,
      roleResolved,
      sessionVersion,
      isAdmin:            role === 'admin',
      isServiceManager:   role === 'service_manager',
      isKuecheManager:    role === 'kueche_manager',
      isBeaulieuManager:  role === 'beaulieu_manager',
      isBeaulieuViewer:   role === 'beaulieu_viewer',
      signIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};
