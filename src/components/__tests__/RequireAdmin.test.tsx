// @vitest-environment happy-dom
/**
 * D010 — RequireAdmin: zentraler Route-Guard für admin-only Flächen.
 *
 * Fixiert: (1) Admin sieht Admin-Bereiche, (2/3) eingeschränkte Rollen werden
 * beim direkten URL-Aufruf umgeleitet (5), (4) Gast-Sessions dürfen lesen
 * (allowGuest), aber PII-/Schreibflächen (allowGuest=false) bleiben zu,
 * (16) beaulieu_manager nur wo explizit erlaubt (allowBeaulieu).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const perms = {
  isAdmin: false,
  isGuest: false,
  isBeaulieuManager: false,
};

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => perms,
}));

import { RequireAdmin } from '@/components/RequireAdmin';

const renderGuarded = (opts: { allowGuest?: boolean; allowBeaulieu?: boolean; redirectTo?: string } = {}) =>
  render(
    <MemoryRouter initialEntries={['/geschuetzt']}>
      <Routes>
        <Route
          path="/geschuetzt"
          element={
            <RequireAdmin path="/geschuetzt" {...opts}>
              <div data-testid="ziel">Geschützter Inhalt</div>
            </RequireAdmin>
          }
        />
        <Route path="/" element={<div data-testid="startseite">Start</div>} />
        <Route path="/personal" element={<div data-testid="personal">Personal</div>} />
      </Routes>
    </MemoryRouter>,
  );

const setPerms = (over: Partial<typeof perms>) => {
  perms.isAdmin = false;
  perms.isGuest = false;
  perms.isBeaulieuManager = false;
  Object.assign(perms, over);
};

afterEach(() => cleanup());

describe('RequireAdmin — Route-Guard (D010 1–5, 16)', () => {
  it('(1) Admin sieht den geschützten Inhalt', () => {
    setPerms({ isAdmin: true });
    renderGuarded();
    expect(screen.getByTestId('ziel')).toBeTruthy();
  });

  it('(2/3/5) eingeschränkte Rolle (kein Admin-Flag): direkter URL-Aufruf → Redirect auf /', () => {
    setPerms({});
    renderGuarded();
    expect(screen.queryByTestId('ziel')).toBeNull();
    expect(screen.getByTestId('startseite')).toBeTruthy();
  });

  it('(4) Gast-Session (isAdmin schliesst Gäste ein) darf lesen, wenn allowGuest', () => {
    setPerms({ isAdmin: true, isGuest: true });
    renderGuarded({ allowGuest: true });
    expect(screen.getByTestId('ziel')).toBeTruthy();
  });

  it('(4) Gast-Session wird bei allowGuest=false (PII-/Schreibfläche) umgeleitet', () => {
    setPerms({ isAdmin: true, isGuest: true });
    renderGuarded({ allowGuest: false });
    expect(screen.queryByTestId('ziel')).toBeNull();
    expect(screen.getByTestId('startseite')).toBeTruthy();
  });

  it('(16) beaulieu_manager ohne allowBeaulieu → Redirect; mit allowBeaulieu → Zugriff', () => {
    setPerms({ isBeaulieuManager: true });
    renderGuarded();
    expect(screen.queryByTestId('ziel')).toBeNull();
    cleanup();
    renderGuarded({ allowBeaulieu: true });
    expect(screen.getByTestId('ziel')).toBeTruthy();
  });

  it('redirectTo wird respektiert (z.B. /personal statt /)', () => {
    setPerms({});
    renderGuarded({ redirectTo: '/personal' });
    expect(screen.getByTestId('personal')).toBeTruthy();
  });
});
