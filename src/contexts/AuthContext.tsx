import { createContext, useEffect, useState, ReactNode } from 'react';
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
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<UserRole>('admin');

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

    // ── Weg 1: SECURITY DEFINER RPC (umgeht RLS vollständig) ──────────────────
    // get_my_role() läuft als DB-Owner, liest user_profiles nach auth.uid().
    // Immunität gegen RLS-Konfigurationsprobleme.
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_my_role' as any);
      console.log('[AUTH] get_my_role() RPC result', { rpcData, rpcError });

      if (!rpcError && rpcData) {
        console.log('[AUTH] ✅ Role via RPC:', rpcData);
        applyRole(rpcData as UserRole);
        syncEmail(userId, email);
        return;
      }
      console.warn('[AUTH] ⚠️ RPC returned no role – rpcData:', rpcData, 'rpcError:', rpcError);
    } catch (ex) {
      console.error('[AUTH] ❌ RPC exception:', ex);
    }

    // ── Weg 2: Direktabfrage user_profiles (Fallback, falls RPC fehlt) ────────
    try {
      const resp = await (supabase as any)
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();

      const { data, error, status, statusText } = resp;
      console.log('[AUTH] Direct query result', { data, error, status, statusText });

      if (!error && data?.role) {
        console.log('[AUTH] ✅ Role via direct query:', data.role);
        applyRole(data.role as UserRole);
        syncEmail(userId, email);
        return;
      }
      console.warn('[AUTH] ⚠️ Direct query – no role', { data, error, status, statusText });
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
    console.error('[AUTH] 🔴 All paths failed – defaulting to kueche_manager',
      { userId, email });
    applyRole('kueche_manager');
  };

  /** E-Mail in user_profiles nachführen (fire-and-forget, nie blockierend) */
  const syncEmail = (userId: string, email?: string) => {
    if (!email) return;
    (supabase as any)
      .from('user_profiles')
      .update({ email: email.toLowerCase() })
      .eq('id', userId)
      .then(() => {}).catch(() => {});
  };

  useEffect(() => {
    // Initial session check – wait for role before hiding spinner
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      console.log('[AUTH] getSession resolved', {
        hasSession: !!session,
        userId: session?.user?.id,
        email: session?.user?.email,
      });
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await loadUserRole(session.user.id, session.user.email);  // ← awaited
      }
      setLoading(false);  // spinner hidden only after role is known
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('[AUTH] onAuthStateChange', {
        event,
        hasSession: !!session,
        userId: session?.user?.id,
        email: session?.user?.email,
      });
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        // Keep spinner up while we load the role so the wrong badge never flashes
        setLoading(true);
        await loadUserRole(session.user.id, session.user.email);  // ← awaited
        console.log('[AUTH] onAuthStateChange role load complete');
        setLoading(false);
      } else {
        console.log('[AUTH] No session → setting kueche_manager');
        setRole('kueche_manager');
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
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
      isAdmin: role === 'admin',
      isServiceManager: role === 'service_manager',
      isKuecheManager: role === 'kueche_manager',
      signIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};
