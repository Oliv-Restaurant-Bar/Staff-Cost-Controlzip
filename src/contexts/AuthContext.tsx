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
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]       = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole]       = useState<UserRole>('admin');

  // Track whether the initial getSession() boot sequence is complete.
  // onAuthStateChange will skip INITIAL_SESSION so we don't double-load.
  const bootDoneRef = useRef(false);

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
    // ── Step 1: Immediate session check from localStorage cache (fast, <5 ms) ──
    // This is the ONLY place we call loadUserRole on initial boot.

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
      });
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await loadUserRole(session.user.id, session.user.email);
      }
      setLoading(false);
      bootDoneRef.current = true;
    });

    // ── Step 2: Listen for real auth transitions ───────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[AUTH] onAuthStateChange', {
        event,
        hasSession: !!session,
        userId: session?.user?.id,
      });

      // INITIAL_SESSION is already handled by getSession() above — skip it.
      // Firing it again would double-load the role and cause loading to bounce.
      if (event === 'INITIAL_SESSION') {
        console.log('[AUTH] INITIAL_SESSION skipped — handled by getSession()');
        return;
      }

      // TOKEN_REFRESHED: JWT renewed but user/role unchanged — update session
      // silently WITHOUT touching loading or re-fetching the role.
      // This prevents the global spinner from appearing every ~hour.
      if (event === 'TOKEN_REFRESHED') {
        console.log('[AUTH] Token refreshed – updating session silently');
        setSession(session);
        setUser(session?.user ?? null);
        return;
      }

      // SIGNED_IN, SIGNED_OUT, USER_UPDATED — handle normally
      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        setLoading(true);
        await loadUserRole(session.user.id, session.user.email);
        console.log('[AUTH] onAuthStateChange role load complete');
        setLoading(false);
      } else {
        console.log('[AUTH] No session → clearing role');
        setRole('kueche_manager');
        setLoading(false);
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
