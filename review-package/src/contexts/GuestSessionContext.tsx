import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface GuestSession {
  expiresAt: number;
  token: string;
}

interface GuestSessionContextValue {
  isGuest: boolean;
  guestExpiresAt: Date | null;
  guestMinutesLeft: number;
  clearGuestSession: () => void;
}

const GuestSessionContext = createContext<GuestSessionContextValue>({
  isGuest: false,
  guestExpiresAt: null,
  guestMinutesLeft: 0,
  clearGuestSession: () => {},
});

export const GUEST_SESSION_KEY = 'guest_session_v1';

export function GuestSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<GuestSession | null>(null);
  const [minutesLeft, setMinutesLeft] = useState(0);

  useEffect(() => {
    const raw = sessionStorage.getItem(GUEST_SESSION_KEY);
    if (raw) {
      try {
        const parsed: GuestSession = JSON.parse(raw);
        if (parsed.expiresAt > Date.now()) {
          setSession(parsed);
        } else {
          sessionStorage.removeItem(GUEST_SESSION_KEY);
        }
      } catch {
        sessionStorage.removeItem(GUEST_SESSION_KEY);
      }
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    const update = () => {
      const left = Math.max(0, Math.round((session.expiresAt - Date.now()) / 60000));
      setMinutesLeft(left);
      if (left === 0) {
        sessionStorage.removeItem(GUEST_SESSION_KEY);
        setSession(null);
      }
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, [session]);

  const clearGuestSession = () => {
    sessionStorage.removeItem(GUEST_SESSION_KEY);
    setSession(null);
  };

  return (
    <GuestSessionContext.Provider value={{
      isGuest: !!session,
      guestExpiresAt: session ? new Date(session.expiresAt) : null,
      guestMinutesLeft: minutesLeft,
      clearGuestSession,
    }}>
      {children}
    </GuestSessionContext.Provider>
  );
}

export function useGuestSession() {
  return useContext(GuestSessionContext);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface GuestToken {
  exp: number;
  hash: string;
}

export function encodeGuestToken(token: GuestToken): string {
  return btoa(JSON.stringify(token));
}

export function decodeGuestToken(raw: string): GuestToken | null {
  try {
    return JSON.parse(atob(raw)) as GuestToken;
  } catch {
    return null;
  }
}
