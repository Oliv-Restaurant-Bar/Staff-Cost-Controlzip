import { createContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export type UserRole = 'admin' | 'service_manager' | 'kueche_manager';

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  role: UserRole;
  isAdmin: boolean;
  isServiceManager: boolean;
  isKuecheManager: boolean;
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

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]             = useState<User | null>(null);
  const [session, setSession]       = useState<Session | null>(null);
  const [loading, setLoading]       = useState(true);
  const [role, setRole]             = useState<UserRole>('admin');
  const [sessionVersion, setSessionVersion] = useState(0);

  // Prevents double-boot when both getSession() and INITIAL_SESSION fire.
  const bootDoneRef     = useRef(false);
  const currentUserIdRef = useRef<string | null>(null);

  const EMAIL_ROLE_MAP: Record<string, UserRole> = {
    'admin@olivbern.ch':   'admin',
    'service@olivbern.ch': 'service_manager',
    'kueche@olivbern.ch':  'kueche_manager',
  };

  const applyRole = (r: UserRole) => {
    setRole(r);
    localStorage.setItem('user_role', r);
  };

  const loadUserRole = useCallback(async (userId: string, email?: string) => {
    console.log('[AUTH] loadUserRole', { userId, email });

    try {
      const { data, error } = await supabase.rpc('get_my_role' as any);
      if (!error && data) { applyRole(data as UserRole); syncEmail(userId, email); return; }
    } catch { /* fall through */ }

    try {
      const { data, error } = await (supabase as any)
        .from('user_profiles').select('role').eq('id', userId).maybeSingle();
      if (!error && data?.role) { applyRole(data.role as UserRole); syncEmail(userId, email); return; }
    } catch { /* fall through */ }

    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      const r = EMAIL_ROLE_MAP[email.toLowerCase()];
      applyRole(r);
      (supabase as any).from('user_profiles').upsert({ id: userId, role: r }, { onConflict: 'id' })
        .then(() => {}).catch(() => {});
      return;
    }

    console.error('[AUTH] all role paths failed – defaulting to kueche_manager');
    applyRole('kueche_manager');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncEmail = (userId: string, email?: string) => {
    if (!email) return;
    (supabase as any).from('user_profiles').update({ email: email.toLowerCase() })
      .eq('id', userId).then(() => {}).catch(() => {});
  };

  // ── Shared boot handler (called from EITHER getSession OR INITIAL_SESSION) ───
  // Protected by bootDoneRef so it runs exactly once per session.
  const completeBoot = useCallback(async (sess: Session | null, source: string) => {
    if (bootDoneRef.current) {
      console.log('[AUTH] boot already done, ignoring duplicate from', source);
      return;
    }
    bootDoneRef.current = true;

    console.error(`🔴 [AUTH LIVE] boot complete via ${source}`, {
      hasSession: !!sess,
      userId: sess?.user?.id,
      tokenExpiry: sess?.expires_at ? new Date(sess.expires_at * 1000).toISOString() : null,
    });

    setSession(sess);
    setUser(sess?.user ?? null);
    currentUserIdRef.current = sess?.user?.id ?? null;

    if (sess?.user) {
      await loadUserRole(sess.user.id, sess.user.email);
    }

    setLoading(false);
    setSessionVersion(v => v + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadUserRole]);

  useEffect(() => {
    console.error('🔴 [AUTH LIVE] AuthProvider mounted – NEW CODE ACTIVE');

    // ── Strategy: dual boot signals ───────────────────────────────────────────
    //
    // WHY dual signals?
    //
    // a) getSession()    – awaits initializePromise then acquires the lock and
    //                      reads/refreshes the session.  Usually fast (~0–100ms
    //                      for non-expired tokens).  Reliable first-signal.
    //
    // b) INITIAL_SESSION – fired by Supabase inside onAuthStateChange AFTER
    //                      initializePromise resolves and the lock is acquired.
    //                      Acts as a backup in case getSession() resolves while
    //                      the lock is still held (lock is queued, not blocking).
    //
    // completeBoot() is guarded by bootDoneRef so it runs EXACTLY ONCE.
    // Whichever signal arrives first wins; the other is ignored.
    //
    // NO SAFETY TIMEOUT – a timeout causes an inconsistent half-booted state
    // which is worse than a spinner.  If getSession() hangs (e.g. expired token
    // + slow network), INITIAL_SESSION will eventually arrive after the refresh.
    // ──────────────────────────────────────────────────────────────────────────

    // Signal A: getSession()
    supabase.auth.getSession()
      .then(({ data: { session } }) => completeBoot(session, 'getSession'))
      .catch(err => {
        console.error('[AUTH] getSession() threw unexpectedly:', err);
        completeBoot(null, 'getSession-error');
      });

    // Signal B: onAuthStateChange
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, sess) => {
        console.log('[AUTH] onAuthStateChange', {
          event,
          hasSession: !!sess,
          userId: sess?.user?.id,
          bootDone: bootDoneRef.current,
          tokenExpiry: sess?.expires_at ? new Date(sess.expires_at * 1000).toISOString() : null,
        });

        // ── INITIAL_SESSION ─────────────────────────────────────────────────
        // Backup boot signal; completeBoot() is a no-op if getSession() already won.
        if (event === 'INITIAL_SESSION') {
          console.error('🔴 [AUTH LIVE] INITIAL_SESSION received', { hasSession: !!sess, userId: sess?.user?.id });
          await completeBoot(sess, 'INITIAL_SESSION');
          return;
        }

        // ── TOKEN_REFRESHED ─────────────────────────────────────────────────
        // JWT renewed silently — bump sessionVersion so data pages re-fetch
        // with the fresh token even though user?.id hasn't changed.
        if (event === 'TOKEN_REFRESHED') {
          console.error('🔴 [AUTH LIVE] TOKEN_REFRESHED – bumping sessionVersion');
          setSession(sess);
          setUser(sess?.user ?? null);
          setSessionVersion(v => { console.log('[AUTH] sessionVersion →', v + 1, '(TOKEN_REFRESHED)'); return v + 1; });
          return;
        }

        // ── USER_UPDATED ────────────────────────────────────────────────────
        if (event === 'USER_UPDATED') {
          setSession(sess);
          setUser(sess?.user ?? null);
          return;
        }

        // ── SIGNED_IN (same user, post-boot) ────────────────────────────────
        // Supabase sometimes fires SIGNED_IN for background token renewals.
        // Bump sessionVersion so data pages re-fetch.
        if (event === 'SIGNED_IN' && bootDoneRef.current &&
            sess?.user?.id === currentUserIdRef.current) {
          console.error('🔴 [AUTH LIVE] SIGNED_IN (same user, post-boot) – bumping sessionVersion');
          setSession(sess);
          setUser(sess?.user ?? null);
          setSessionVersion(v => { console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN same)'); return v + 1; });
          return;
        }

        // ── SIGNED_IN (new user) ─────────────────────────────────────────────
        if (event === 'SIGNED_IN') {
          console.error('🔴 [AUTH LIVE] SIGNED_IN (new user / first login)');
          setLoading(true);
          setSession(sess);
          setUser(sess?.user ?? null);
          if (sess?.user) {
            currentUserIdRef.current = sess.user.id;
            await loadUserRole(sess.user.id, sess.user.email);
          }
          setLoading(false);
          setSessionVersion(v => { console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN new)'); return v + 1; });
          return;
        }

        // ── SIGNED_OUT ──────────────────────────────────────────────────────
        // This event may NOT fire if the Supabase server-side signOut HTTP call
        // returns an unexpected error.  The _clearLocalAuth() call in signOut()
        // below ensures the UI updates immediately regardless.
        if (event === 'SIGNED_OUT') {
          console.error('🔴 [AUTH LIVE] SIGNED_OUT event received');
          _clearLocalAuth();
          return;
        }
      }
    );

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeBoot]);

  // ── Local state reset (shared between signOut() and SIGNED_OUT handler) ─────
  const _clearLocalAuth = () => {
    console.error('🔴 [AUTH LIVE] local auth state cleared');
    setSession(null);
    setUser(null);
    setRole('kueche_manager');
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
      if (error.message.includes('Invalid login credentials')) return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
      if (error.message.includes('Email not confirmed')) return { error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.' };
      return { error: 'Anmeldung fehlgeschlagen: ' + error.message };
    }
    return { error: null };
  };

  const signOut = async () => {
    console.error('🔴 [AUTH LIVE] signOut() called');

    // ── CRITICAL: clear local state IMMEDIATELY ───────────────────────────────
    // Do NOT wait for the SIGNED_OUT event.  The Supabase signOut() HTTP call
    // (POST /auth/v1/logout) can fail or be slow, and if it returns any error
    // that is not 404/401/403, _removeSession() is skipped and SIGNED_OUT never
    // fires via onAuthStateChange.  We must not rely on that event for the UI.
    _clearLocalAuth();
    console.error('🔴 [AUTH LIVE] local state cleared – LoginPage should appear now');

    // Fire the Supabase server signOut in the background.
    // SIGNED_OUT event may or may not arrive; we don't care — state is already cleared.
    supabase.auth.signOut()
      .then(({ error }) => {
        if (error) {
          console.warn('[AUTH] background signOut had an error (OK – local state already cleared):', error.message);
        } else {
          console.log('[AUTH] background signOut completed cleanly');
        }
      })
      .catch(err => {
        console.warn('[AUTH] background signOut threw (OK – local state already cleared):', err);
      });
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      loading,
      role,
      sessionVersion,
      isAdmin:          role === 'admin',
      isServiceManager: role === 'service_manager',
      isKuecheManager:  role === 'kueche_manager',
      signIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};
