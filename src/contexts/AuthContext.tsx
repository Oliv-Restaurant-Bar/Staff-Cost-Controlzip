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
    setRole(r);
    localStorage.setItem('user_role', r);
  };

  const loadUserRole = async (userId: string, email?: string) => {
    // Immer frisch aus Supabase laden — kein Cache, kein Skip
    try {
      const { data, error } = await (supabase as any)
        .from('user_profiles')
        .select('role, email')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data?.role) {
        applyRole(data.role as UserRole);

        // E-Mail aktuell halten (fire-and-forget, kein Await)
        if (email && (!data.email || data.email !== email.toLowerCase())) {
          (supabase as any)
            .from('user_profiles')
            .update({ email: email.toLowerCase() })
            .eq('id', userId)
            .then(() => {});
        }
        return;
      }
    } catch {
      // DB nicht erreichbar → Fallback
    }

    // Fallback: feste E-Mail-Zuordnung
    if (email && EMAIL_ROLE_MAP[email.toLowerCase()]) {
      const mappedRole = EMAIL_ROLE_MAP[email.toLowerCase()];
      applyRole(mappedRole);
      // Eintrag für zukünftige Logins anlegen
      try {
        await (supabase as any)
          .from('user_profiles')
          .upsert(
            { id: userId, email: email.toLowerCase(), role: mappedRole },
            { onConflict: 'id' },
          );
      } catch { /* ignorieren */ }
      return;
    }

    // Letzter Fallback
    applyRole('kueche_manager');
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadUserRole(session.user.id, session.user.email);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadUserRole(session.user.id, session.user.email);
      } else {
        setRole('kueche_manager');
      }
      setLoading(false);
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
