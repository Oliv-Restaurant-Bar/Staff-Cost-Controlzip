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
   * Increments on every successful auth event:
   *   - getSession() completed (boot)
   *   - TOKEN_REFRESHED (background JWT renewal)
   *   - SIGNED_IN (new user or post-boot)
   *
   * Pages that fetch Supabase data should depend on this value so they
   * automatically re-fetch after a token renewal, even when user?.id
   * hasn't changed.
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
  // Incremented on every confirmed auth event — lets consumers re-fetch data
  // after a background token renewal without requiring a user ID change.
  const [sessionVersion, setSessionVersion] = useState(0);

  // Track whether the initial getSession() boot sequence is complete.
  const bootDoneRef = useRef(false);

  // Track the user ID established by getSession() so we can detect whether a
  // subsequent SIGNED_IN event is a real new sign-in (different user) or just
  // a background token refresh.
  const currentUserIdRef = useRef<string | null>(null);

  // E-Mail-Fallback (greift nur wenn kein user_profiles-Eintrag existiert)
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
    console.log('[AUTH] loadUserRole called', { userId, email });

    // ── Weg 1: SECURITY DEFINER RPC ───────────────────────────────────────────
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_my_role' as any);
      console.log('[AUTH] get_my_role() RPC result', { rpcData, rpcError });
      if (!rpcError && rpcData) {
        console.log('[AUTH] ✅ Role via RPC:', rpcData);
        applyRole(rpcData as UserRole);
        syncEmail(userId, email);
        return;
      }
      console.warn('[AUTH] ⚠️ RPC returned no role:', rpcData, rpcError);
    } catch (ex) {
      console.error('[AUTH] ❌ RPC exception:', ex);
    }

    // ── Weg 2: Direktabfrage user_profiles ────────────────────────────────────
    try {
      const resp = await (supabase as any)
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
      const { data, error, status } = resp;
      console.log('[AUTH] Direct query result', { data, error, status });
      if (!error && data?.role) {
        console.log('[AUTH] ✅ Role via direct query:', data.role);
        applyRole(data.role as UserRole);
        syncEmail(userId, email);
        return;
      }
      console.warn('[AUTH] ⚠️ Direct query – no role', { data, error, status });
    } catch (ex) {
      console.error('[AUTH] ❌ Direct query exception:', ex);
    }

    // ── Weg 3: Feste E-Mail-Zuordnung ─────────────────────────────────────────
    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      const mappedRole = EMAIL_ROLE_MAP[email.toLowerCase()];
      console.log('[AUTH] 📧 Email fallback →', mappedRole);
      applyRole(mappedRole);
      (supabase as any)
        .from('user_profiles')
        .upsert({ id: userId, role: mappedRole }, { onConflict: 'id' })
        .then(() => {}).catch(() => {});
      return;
    }

    // ── Weg 4: Letzter Ausweg ─────────────────────────────────────────────────
    console.error('[AUTH] 🔴 All paths failed – defaulting to kueche_manager');
    applyRole('kueche_manager');
  };

  /** E-Mail in user_profiles nachführen (fire-and-forget) */
  const syncEmail = (userId: string, email?: string) => {
    if (!email) return;
    (supabase as any)
      .from('user_profiles')
      .update({ email: email.toLowerCase() })
      .eq('id', userId)
      .then(() => {}).catch(() => {});
  };

  useEffect(() => {
    // Safety net: if getSession never resolves (extreme edge case / network issue),
    // clear the loading spinner after 8 seconds so the app never hangs forever.
    const safetyTimer = setTimeout(() => {
      if (!bootDoneRef.current) {
        console.warn('[AUTH] ⚠️ Safety timeout — forcing loading=false after 8s');
        setLoading(false);
        bootDoneRef.current = true;
      }
    }, 8000);

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      clearTimeout(safetyTimer);
      console.log('[AUTH] getSession resolved', {
        hasSession: !!session,
        userId: session?.user?.id,
        email: session?.user?.email,
        tokenExpiry: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      });
      setSession(session);
      setUser(session?.user ?? null);
      currentUserIdRef.current = session?.user?.id ?? null;
      if (session?.user) {
        await loadUserRole(session.user.id, session.user.email);
      }
      setLoading(false);
      bootDoneRef.current = true;
      // Increment sessionVersion — tells all consumers the session is now ready
      setSessionVersion(v => v + 1);
      console.log('[AUTH] sessionVersion → 1 (boot complete)');
    });

    // ── Step 2: Listen for real auth transitions ───────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[AUTH] onAuthStateChange', {
        event,
        hasSession: !!session,
        userId: session?.user?.id,
        bootDone: bootDoneRef.current,
        sameUser: session?.user?.id === currentUserIdRef.current,
        tokenExpiry: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      });

      // ── INITIAL_SESSION: handled by getSession() above — always skip ──────────
      if (event === 'INITIAL_SESSION') {
        console.log('[AUTH] INITIAL_SESSION skipped — handled by getSession()');
        return;
      }

      // ── TOKEN_REFRESHED: JWT renewed, same user ────────────────────────────────
      // Update session AND increment sessionVersion so pages re-fetch with the
      // fresh token.  This is the key fix for the Incognito refresh bug: the
      // initial queries may have run with a stale token; incrementing
      // sessionVersion triggers a re-fetch with the now-valid JWT.
      if (event === 'TOKEN_REFRESHED') {
        console.log('[AUTH] TOKEN_REFRESHED – updating session + incrementing sessionVersion');
        setSession(session);
        setUser(session?.user ?? null);
        setSessionVersion(v => {
          console.log('[AUTH] sessionVersion →', v + 1, '(TOKEN_REFRESHED)');
          return v + 1;
        });
        return;
      }

      // ── USER_UPDATED: profile changed, same user ───────────────────────────────
      if (event === 'USER_UPDATED') {
        console.log('[AUTH] USER_UPDATED – silent session update');
        setSession(session);
        setUser(session?.user ?? null);
        return;
      }

      // ── SIGNED_IN (post-boot, same user) ──────────────────────────────────────
      // Supabase can fire SIGNED_IN after getSession() when it refreshes an expired
      // JWT in the background.  Also increment sessionVersion here so a re-fetch
      // is triggered if the initial load had stale data.
      if (event === 'SIGNED_IN' && bootDoneRef.current &&
          session?.user?.id === currentUserIdRef.current) {
        console.log('[AUTH] SIGNED_IN (same user, post-boot) – silent update + sessionVersion bump');
        setSession(session);
        setUser(session?.user ?? null);
        setSessionVersion(v => {
          console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN same user)');
          return v + 1;
        });
        return;
      }

      // ── SIGNED_IN (new user after sign-out) or pre-boot ───────────────────────
      if (event === 'SIGNED_IN') {
        console.log('[AUTH] SIGNED_IN (new/different user or pre-boot) – full role reload');
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          currentUserIdRef.current = session.user.id;
          setLoading(true);
          await loadUserRole(session.user.id, session.user.email);
          console.log('[AUTH] SIGNED_IN role load complete');
          setLoading(false);
          setSessionVersion(v => {
            console.log('[AUTH] sessionVersion →', v + 1, '(SIGNED_IN new user)');
            return v + 1;
          });
        }
        return;
      }

      // ── SIGNED_OUT: full reset ─────────────────────────────────────────────────
      if (event === 'SIGNED_OUT') {
        console.log('[AUTH] SIGNED_OUT – clearing auth state');
        setSession(null);
        setUser(null);
        setRole('kueche_manager');
        setLoading(false);
        bootDoneRef.current = false;
        currentUserIdRef.current = null;
        // Do NOT increment sessionVersion on sign-out — consumers should stop fetching
      }
    });

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.includes('Invalid login credentials')) {
        return { error: 'E-Mail-Adresse oder Passwort ist falsch.' };
      }
      if (error.message.includes('Email not confirmed')) {
        return { error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.' };
      }
      return { error: 'Anmeldung fehlgeschlagen: ' + error.message };
    }
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
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
