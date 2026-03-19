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

    // ── Schritt 1: Rolle aus user_profiles laden ──
    try {
      const { data, error } = await (supabase as any)
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();

      console.log('[AUTH] user_profiles query result', { data, error });

      if (!error && data?.role) {
        console.log('[AUTH] ✅ Role from DB:', data.role);
        applyRole(data.role as UserRole);

        // E-Mail separat aktualisieren (fire-and-forget, nie blockierend)
        if (email) {
          (supabase as any)
            .from('user_profiles')
            .update({ email: email.toLowerCase() })
            .eq('id', userId)
            .then(() => {})
            .catch(() => {});
        }
        return;
      }

      // Row fehlt oder Fehler
      console.warn('[AUTH] ⚠️ No role in DB – data:', data, '– error:', error);
    } catch (ex) {
      console.error('[AUTH] ❌ Exception during user_profiles query:', ex);
    }

    // ── Fallback: feste E-Mail-Zuordnung ──
    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      const mappedRole = EMAIL_ROLE_MAP[email.toLowerCase()];
      console.log('[AUTH] 📧 Email fallback triggered →', mappedRole);
      applyRole(mappedRole);
      (supabase as any)
        .from('user_profiles')
        .upsert({ id: userId, role: mappedRole }, { onConflict: 'id' })
        .then(() => {})
        .catch(() => {});
      return;
    }

    // ── Letzter Fallback ──
    console.error('[AUTH] 🔴 All fallbacks exhausted – defaulting to kueche_manager',
      { userId, email });
    applyRole('kueche_manager');
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
