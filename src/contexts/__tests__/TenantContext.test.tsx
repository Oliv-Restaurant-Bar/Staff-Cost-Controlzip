// @vitest-environment happy-dom
/**
 * D010 — TenantContext: Mandanten-Auswahl, Lock und Reset.
 *
 * Fixiert: (6/7) gesperrte Benutzer können den Mandanten nicht wechseln,
 * (8) freie Benutzer wechseln sicher, (9) eine ungültige gespeicherte
 * Tenant-Auswahl wird verworfen, (10/11) resetTenant leert Auswahl + Lock,
 * damit ein neuer Login nie die Auswahl des Vorgängers erbt.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TenantProvider, useTenant } from '@/contexts/TenantContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <TenantProvider>{children}</TenantProvider>
);

beforeEach(() => {
  localStorage.clear();
});

describe('TenantContext — gespeicherte Auswahl (D010 9, 12)', () => {
  it('(9) ungültiger gespeicherter Tenant wird verworfen → Default oliv', () => {
    localStorage.setItem('active_tenant', 'kaputt');
    const { result } = renderHook(() => useTenant(), { wrapper });
    expect(result.current.tenantId).toBe('oliv');
  });

  it('(12) gültige gespeicherte Auswahl bleibt nach Neu-Mount (Session-Refresh) erhalten', () => {
    localStorage.setItem('active_tenant', 'beaulieu');
    const { result } = renderHook(() => useTenant(), { wrapper });
    expect(result.current.tenantId).toBe('beaulieu');
  });
});

describe('TenantContext — Wechsel + Lock (D010 6–8)', () => {
  it('(8) freier Benutzer wechselt sicher und die Auswahl wird persistiert', () => {
    const { result } = renderHook(() => useTenant(), { wrapper });
    act(() => result.current.setTenant('beaulieu'));
    expect(result.current.tenantId).toBe('beaulieu');
    expect(localStorage.getItem('active_tenant')).toBe('beaulieu');
    act(() => result.current.setTenant('oliv'));
    expect(result.current.tenantId).toBe('oliv');
  });

  it('(6/7) gesperrter Benutzer: setTenant wird blockiert, Auswahl bleibt', () => {
    const { result } = renderHook(() => useTenant(), { wrapper });
    act(() => result.current.lockTenant('beaulieu'));
    expect(result.current.tenantId).toBe('beaulieu');
    expect(result.current.tenantLocked).toBe(true);
    act(() => result.current.setTenant('oliv'));
    expect(result.current.tenantId).toBe('beaulieu'); // Wechsel verweigert
    expect(localStorage.getItem('active_tenant')).toBe('beaulieu');
  });

  it('unlockTenant hebt den Lock auf, danach ist Wechsel wieder möglich', () => {
    const { result } = renderHook(() => useTenant(), { wrapper });
    act(() => result.current.lockTenant('beaulieu'));
    act(() => result.current.unlockTenant());
    expect(result.current.tenantLocked).toBe(false);
    act(() => result.current.setTenant('oliv'));
    expect(result.current.tenantId).toBe('oliv');
  });

  it('tenantKey: oliv unpräfixiert (Bestand), beaulieu präfixiert (Datentrennung)', () => {
    const { result } = renderHook(() => useTenant(), { wrapper });
    expect(result.current.tenantKey('reporting_v1')).toBe('reporting_v1');
    act(() => result.current.setTenant('beaulieu'));
    expect(result.current.tenantKey('reporting_v1')).toBe('beaulieu:reporting_v1');
  });
});

describe('TenantContext — resetTenant bei Logout/Benutzerwechsel (D010 10–11)', () => {
  it('(10/11) resetTenant leert persistierte Auswahl, hebt Lock auf, State → oliv', () => {
    const { result } = renderHook(() => useTenant(), { wrapper });
    act(() => result.current.lockTenant('beaulieu'));
    act(() => result.current.resetTenant());
    expect(result.current.tenantId).toBe('oliv');
    expect(result.current.tenantLocked).toBe(false);
    expect(localStorage.getItem('active_tenant')).toBeNull();
    // Nächster Login startet neutral — keine geerbte Auswahl.
  });
});
