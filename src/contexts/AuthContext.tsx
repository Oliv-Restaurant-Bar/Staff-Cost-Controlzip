import { createContext, useEffect, useRef, useState, ReactNode } from 'react';
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
   * Monotonically increasing counter — increments on every confirmed auth event:
   *   0 = initial (auth not yet settled)
   *   1 = boot complete (INITIAL_SESSION processed)
   *   2+ = subsequent TOKEN_REFRESHED or SIGNED_IN events
   *
   * Pages that fetch Supabase data MUST depend on this value so they
   * re-fetch automatically after a background token renewal even when
   * user?.id has not changed.
   */
  sessionVersion: number;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]       = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole]       = useState<UserRole>('admin');
  const [sessionVersion, setSessionVersion] = useState(0);

  // Whether INITIAL_SESSION has been processed (boot is done).
  const bootDoneRef = useRef(false);

  // User ID at last boot — used to distinguish "same user token refresh"
  // from "different user after sign-out + sign-in".
  const currentUserIdRef = useRef<string | null>(null);

  const EMAIL_ROLE_MAP: Record<string, UserRole> = {
    'admin@olivbern.ch':   'admin',
    'service@olivbern.ch': 'service_manager',
    'kueche@olivbern.ch':  'kueche_manager',
  };

  const applyRole = (r: UserRole) => {
    console.log('[AUTH] applyRole →', r);
    setRole(r);
    localStorage.setItem('user_role', r);
  };

  const loadUserRole = async (userId: string, email?: string) => {
    console.log('[AUTH] loadUserRole', { userId, email });

    // ── Weg 1: SECURITY DEFINER RPC ───────────────────────────────────────────
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_my_role' as any);
      console.log('[AUTH] get_my_role RPC', { rpcData, rpcError });
      if (!rpcError && rpcData) {
        applyRole(rpcData as UserRole);
        syncEmail(userId, email);
        return;
      }
    } catch (ex) {
      console.error('[AUTH] RPC exception:', ex);
    }

    // ── Weg 2: Direktabfrage user_profiles ────────────────────────────────────
    try {
      const { data, error } = await (supabase as any)
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
      console.log('[AUTH] user_profiles direct', { data, error });
      if (!error && data?.role) {
        applyRole(data.role as UserRole);
        syncEmail(userId, email);
        return;
      }
    } catch (ex) {
      console.error('[AUTH] user_profiles exception:', ex);
    }

    // ── Weg 3: E-Mail-Mapping ──────────────────────────────────────────────────
    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      const r = EMAIL_ROLE_MAP[email.toLowerCase()];
      applyRole(r);
      (supabase as any)
        .from('user_profiles')
        .upsert({ id: userId, role: r }, { onConflict: 'id' })
        .then(() => {}).catch(() => {});
      return;
    }

    // ── Weg 4: Letzter Ausweg ─────────────────────────────────────────────────
    console.error('[AUTH] all role paths failed – defaulting to kueche_manager');
    applyRole('kueche_manager');
  };

  const syncEmail = (userId: string, email?: string) => {
    if (!email) return;
    (supabase as any)
      .from('user_profiles')
      .update({ email: email.toLowerCase() })
      .eq('id', userId)
      .then(() => {}).catch(() => {});
  };

  useEffect(() => {
    // ────────────────────────────────────────────────────────────────────────
    // WHY WE NO LONGER CALL getSession() HERE:
    //
    // In Supabase JS v2, getSession() reads the session from storage and MAY
    // return an expired access_token if the background refresh hasn't finished
    // yet.  Any Supabase queries made with that stale token get silently
    // rejected by RLS (0 rows, no error), causing the Incognito refresh bug.
    //
    // The CORRECT pattern (per Supabase v2 docs) is to rely on INITIAL_SESSION
    // from onAuthStateChange.  Supabase fires INITIAL_SESSION only AFTER
    // _recoverAndRefresh() has completed — meaning the token in storage is
    // guaranteed to be valid (or null) by the time we act on it.
    //
    // Sequence on page load:
    //   1. Supabase client initialises, reads localStorage
    //   2. If token expired → makes refresh network call (await)
    //   3. Fires INITIAL_SESSION with the fresh (or null) session
    //   4. We set loading=false and sessionVersion=1
    //   5. Protected pages mount and fetch data — always with a valid token
    // ────────────────────────────────────────────────────────────────────────

    // Safety timer: INITIAL_SESSION should arrive within a few seconds even on
    // slow connections.  8 s is generous enough to cover mobile 3G.
    // ── LIVE PROOF: this log proves the new AuthContext code is running ─────────
    console.error('🔴 [AUTH LIVE] AuthProvider useEffect mounted – NEW CODE ACTIVE');

    const safetyTimer = setTimeout(() => {
      if (!bootDoneRef.current) {
        console.warn('[AUTH] ⚠️ safety timeout – forcing loading=false after 8 s');
        bootDoneRef.current = true;
        setLoading(false);
        setSessionVersion(v => v + 1);
      }
    }, 8000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('[AUTH] onAuthStateChange', {
          event,
          hasSession:  !!session,
          userId:      session?.user?.id,
          email:       session?.user?.email,
          tokenExpiry: session?.expires_at
            ? new Date(session.expires_at * 1000).toISOString()
            : null,
          bootDone:    bootDoneRef.current,
          sameUser:    session?.user?.id === currentUserIdRef.current,
        });

        // ── INITIAL_SESSION ────────────────────────────────────────────────────
        // Primary boot signal — fired AFTER any pending token refresh.
        // This is the only event where loading is set from true → false.
        if (event === 'INITIAL_SESSION') {
          console.error('🔴 [AUTH LIVE] INITIAL_SESSION received', {
            hasSession: !!session,
            userId: session?.user?.id,
            tokenExpiry: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
          });
          clearTimeout(safetyTimer);
          setSession(session);
          setUser(session?.user ?? null);
          currentUserIdRef.current = session?.user?.id ?? null;
          if (session?.user) {
            await loadUserRole(session.user.id, session.user.email);
          }
          bootDoneRef.current = true;
          setLoading(false);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(INITIAL_SESSION – boot complete)');
            return v + 1;
          });
          return;
        }

        // ── TOKEN_REFRESHED ────────────────────────────────────────────────────
        // JWT renewed silently.  Bump sessionVersion so data pages re-fetch
        // with the fresh token even though user?.id hasn't changed.
        if (event === 'TOKEN_REFRESHED') {
          console.log('[AUTH] TOKEN_REFRESHED – fresh token, bumping sessionVersion');
          setSession(session);
          setUser(session?.user ?? null);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(TOKEN_REFRESHED)');
            return v + 1;
          });
          return;
        }

        // ── USER_UPDATED ───────────────────────────────────────────────────────
        if (event === 'USER_UPDATED') {
          setSession(session);
          setUser(session?.user ?? null);
          return;
        }

        // ── SIGNED_IN (same user, post-boot) ──────────────────────────────────
        // Supabase occasionally fires SIGNED_IN in addition to TOKEN_REFRESHED.
        // Treat it silently — just update session + bump version.
        if (event === 'SIGNED_IN' &&
            bootDoneRef.current &&
            session?.user?.id === currentUserIdRef.current) {
          console.log('[AUTH] SIGNED_IN (same user post-boot) – bumping sessionVersion');
          setSession(session);
          setUser(session?.user ?? null);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN same user)');
            return v + 1;
          });
          return;
        }

        // ── SIGNED_IN (new user or first login) ───────────────────────────────
        if (event === 'SIGNED_IN') {
          console.log('[AUTH] SIGNED_IN (new user / first login) – full role reload');
          setLoading(true);
          setSession(session);
          setUser(session?.user ?? null);
          if (session?.user) {
            currentUserIdRef.current = session.user.id;
            await loadUserRole(session.user.id, session.user.email);
          }
          setLoading(false);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN new user)');
            return v + 1;
          });
          return;
        }

        // ── SIGNED_OUT ─────────────────────────────────────────────────────────
        if (event === 'SIGNED_OUT') {
          console.error('🔴 [AUTH LIVE] SIGNED_OUT – clearing all state');
          setSession(null);
          setUser(null);
          setRole('kueche_manager');
          setLoading(false);
          // Clear persisted role so no stale data leaks to the next session
          localStorage.removeItem('user_role');
          bootDoneRef.current = false;
          currentUserIdRef.current = null;
          // Reset sessionVersion to 0 — next login will set it to 1
          setSessionVersion(0);
          return;
        }
      }
    );

    return () => {
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    console.log('[AUTH] signIn attempt', { email });
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error('[AUTH] signIn error', error.message);
      if (error.message.includes('Invalid login credentials')) {
        return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
      }
      if (error.message.includes('Email not confirmed')) {
        return { error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.' };
      }
      return { error: 'Anmeldung fehlgeschlagen: ' + error.message };
    }
    console.log('[AUTH] signIn success');
    return { error: null };
  };

  const signOut = async () => {
    console.error('🔴 [AUTH LIVE] signOut() called');
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('[AUTH] signOut error', error.message);
        // Force local state clear even if server call failed
        setSession(null);
        setUser(null);
        setRole('kueche_manager');
        localStorage.removeItem('user_role');
        bootDoneRef.current = false;
        currentUserIdRef.current = null;
        setSessionVersion(0);
      } else {
        console.log('[AUTH] signOut success – SIGNED_OUT event will follow');
      }
    } catch (ex) {
      console.error('[AUTH] signOut exception', ex);
      // Force local clear on any exception
      setSession(null);
      setUser(null);
      setRole('kueche_manager');
      localStorage.removeItem('user_role');
      bootDoneRef.current = false;
      currentUserIdRef.current = null;
      setSessionVersion(0);
    }
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
