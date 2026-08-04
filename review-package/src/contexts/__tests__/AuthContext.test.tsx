// @vitest-environment happy-dom
/**
 * D010 — AuthContext: Rollenauflösung, Logout-Reset, keine Profil-Writes.
 *
 * Fixiert: (10) Logout leert Rolle + persistierten Rollen-Cache, (11) kein
 * Rollen-Erben zwischen Benutzern (roleResolved=false nach Logout),
 * (12/13) Session-Refresh behält die persistierte Rolle ohne Admin-Flash
 * (Default ist NIE admin), (18) Login löst KEINE Schreiboperation auf
 * user_profiles aus, wenn die Rolle über den E-Mail-Fallback kommt (D011).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useContext, type ReactNode } from 'react';

// ─── Supabase-Mock (rein lokal, keine Netzwerk-Calls) ────────────────────────

type AuthCallback = (event: string, sess: unknown) => void;
const authCallbacks: AuthCallback[] = [];
const getSessionMock = vi.fn();
const rpcMock = vi.fn();
const updateEq = vi.fn(() => Promise.resolve({ error: null }));
const updateMock = vi.fn(() => ({ eq: updateEq }));
const maybeSingleMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
const fromMock = vi.fn((_table: string) => ({
  update: updateMock,
  select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
}));
const signOutMock = vi.fn(() => Promise.resolve({ error: null }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (cb: AuthCallback) => {
        authCallbacks.push(cb);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signInWithPassword: vi.fn(),
      signOut: () => signOutMock(),
    },
    rpc: (fn: string) => rpcMock(fn),
    from: (table: string) => fromMock(table),
  },
}));

import { AuthProvider, AuthContext } from '@/contexts/AuthContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

const useAuthCtx = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthContext fehlt');
  return ctx;
};

const mkSession = (id: string, email: string) => ({
  user: { id, email },
  expires_at: Math.floor(Date.now() / 1000) + 3600,
});

beforeEach(() => {
  authCallbacks.length = 0;
  getSessionMock.mockReset().mockResolvedValue({ data: { session: null } });
  rpcMock.mockReset().mockResolvedValue({ data: null, error: { message: 'kein RPC' } });
  updateMock.mockClear();
  updateEq.mockClear();
  maybeSingleMock.mockClear().mockResolvedValue({ data: null, error: null });
  fromMock.mockClear();
  signOutMock.mockClear();
  localStorage.clear();
});

describe('AuthContext — Boot + persistierte Rolle (D010 12/13)', () => {
  it('(12) persistierte Rolle wird beim Boot übernommen, roleResolved sofort true', async () => {
    localStorage.setItem('user_role', 'service_manager');
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    expect(result.current.role).toBe('service_manager');
    expect(result.current.roleResolved).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('(13) ohne persistierte Rolle: restriktiver Default kueche_manager — NIE admin', async () => {
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    expect(result.current.role).toBe('kueche_manager');
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.roleResolved).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('ungültige persistierte Rolle wird verworfen (Default statt Übernahme)', async () => {
    localStorage.setItem('user_role', 'super_admin_kaputt');
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    expect(result.current.role).toBe('kueche_manager');
    expect(result.current.roleResolved).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('AuthContext — Rollenauflösung beim Login (D010 18 / D011)', () => {
  it('Rolle via RPC: wird angewendet und persistiert', async () => {
    getSessionMock.mockResolvedValue({ data: { session: mkSession('u1', 'admin@olivbern.ch') } });
    rpcMock.mockResolvedValue({ data: 'admin', error: null });
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    await waitFor(() => expect(result.current.role).toBe('admin'));
    expect(result.current.roleResolved).toBe(true);
    expect(localStorage.getItem('user_role')).toBe('admin');
  });

  it('(18) E-Mail-Fallback ist READ-ONLY: keine update()/Schreib-Calls auf user_profiles', async () => {
    getSessionMock.mockResolvedValue({ data: { session: mkSession('u2', 'service@olivbern.ch') } });
    // RPC und user_profiles liefern nichts → E-Mail-Fallback greift.
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    await waitFor(() => expect(result.current.role).toBe('service_manager'));
    expect(updateMock).not.toHaveBeenCalled(); // produktive Profile bleiben unangetastet
  });

  it('unbekannte E-Mail ohne RPC/Profil: restriktiver Default kueche_manager, kein Write', async () => {
    getSessionMock.mockResolvedValue({ data: { session: mkSession('u3', 'niemand@example.com') } });
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    await waitFor(() => expect(result.current.roleResolved).toBe(true));
    expect(result.current.role).toBe('kueche_manager');
    expect(result.current.isAdmin).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('AuthContext — Logout-Reset (D010 10/11)', () => {
  it('(10/11) signOut leert Rolle, Rollen-Cache und roleResolved — kein Erben beim nächsten Login', async () => {
    getSessionMock.mockResolvedValue({ data: { session: mkSession('u1', 'admin@olivbern.ch') } });
    rpcMock.mockResolvedValue({ data: 'admin', error: null });
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    await waitFor(() => expect(result.current.role).toBe('admin'));

    await act(async () => { await result.current.signOut(); });

    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.role).toBe('kueche_manager');   // restriktiver Default
    expect(result.current.roleResolved).toBe(false);       // nächster Login löst frisch auf
    expect(localStorage.getItem('user_role')).toBeNull();  // kein persistiertes Erbe
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('SIGNED_OUT-Event (Server-seitig) räumt ebenfalls auf', async () => {
    localStorage.setItem('user_role', 'admin');
    getSessionMock.mockResolvedValue({ data: { session: mkSession('u1', 'admin@olivbern.ch') } });
    rpcMock.mockResolvedValue({ data: 'admin', error: null });
    const { result } = renderHook(() => useAuthCtx(), { wrapper });
    await waitFor(() => expect(result.current.role).toBe('admin'));

    act(() => { authCallbacks.forEach(cb => cb('SIGNED_OUT', null)); });

    expect(result.current.user).toBeNull();
    expect(result.current.role).toBe('kueche_manager');
    expect(result.current.roleResolved).toBe(false);
    expect(localStorage.getItem('user_role')).toBeNull();
  });
});
