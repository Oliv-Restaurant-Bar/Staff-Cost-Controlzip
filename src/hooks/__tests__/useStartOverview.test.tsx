// @vitest-environment happy-dom
/**
 * Tests für useStartOverview — Lade-Hook der Startübersicht.
 * Fixiert die Testkatalog-Fälle (7) Tenant-Kontext ohne Vermischung und
 * (18) reines Laden löst KEINE Schreiboperation aus, sowie das
 * Teilfehler-Verhalten (Coverage scheitert → Karten bleiben, coverageError).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const tenantKey = (key: string) => `b_${key}`;
const mockTenant = { tenantId: 'beaulieu', tenantKey };

const fetchCockpitSignals = vi.fn();
const fetchMonthCoverage = vi.fn();

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => mockTenant,
}));
vi.mock('@/lib/import-cockpit-db', () => ({
  fetchCockpitSignals: (...args: unknown[]) => fetchCockpitSignals(...args),
}));
vi.mock('@/lib/import-tasks-db', () => ({
  fetchMonthCoverage: (...args: unknown[]) => fetchMonthCoverage(...args),
}));

import { useStartOverview } from '@/hooks/useStartOverview';

const SIGNALS = {
  zbericht: { latestDataDate: null },
  reservationen: { latestDataDate: null },
  dienstplanung: { latestDataDate: null },
};

beforeEach(() => {
  fetchCockpitSignals.mockReset().mockResolvedValue(SIGNALS);
  fetchMonthCoverage.mockReset().mockResolvedValue({});
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useStartOverview', () => {
  it('(7) übergibt den Tenant-Kontext an BEIDE Read-Fetches (keine Vermischung)', async () => {
    const { result } = renderHook(() => useStartOverview(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    expect(fetchCockpitSignals).toHaveBeenCalledWith({ tenantId: 'beaulieu', tenantKey });
    const now = new Date();
    expect(fetchMonthCoverage).toHaveBeenCalledWith(
      { tenantId: 'beaulieu', tenantKey },
      now.getFullYear(),
      now.getMonth() + 1,
    );
  });

  it('(18) reines Laden schreibt NIE (kein localStorage.setItem, nur Read-Fetches)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useStartOverview(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    expect(setItem).not.toHaveBeenCalled();
  });

  it('liefert Aufgaben + Typ-Zusammenfassung aus der SSoT-Kette (coverage leer → alles offen)', async () => {
    const { result } = renderHook(() => useStartOverview(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('unerwarteter Status');
    expect(state.coverageError).toBeNull();
    // Inhalt hängt vom realen Tagesdatum ab — hier zählt nur: SSoT-Kette lief durch.
    expect(Array.isArray(state.todayTasks)).toBe(true);
    expect(state.typeCompletions!.length).toBe(9);
  });

  it('Teilfehler: Coverage-Fetch scheitert → Karten bleiben, coverageError sichtbar', async () => {
    fetchMonthCoverage.mockRejectedValue(new Error('Netzwerkfehler'));
    const { result } = renderHook(() => useStartOverview(true));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    const state = result.current.state;
    if (state.status !== 'ready') throw new Error('unerwarteter Status');
    expect(state.data.cards).toHaveLength(4);
    expect(state.todayTasks).toBeNull();
    expect(state.typeCompletions).toBeNull();
    expect(state.coverageError).toBe('Netzwerkfehler');
  });

  it('Signale-Fetch scheitert → sichtbarer Fehlerzustand (kein stiller Fallback)', async () => {
    fetchCockpitSignals.mockRejectedValue(new Error('Supabase down'));
    const { result } = renderHook(() => useStartOverview(true));
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    const state = result.current.state;
    if (state.status !== 'error') throw new Error('unerwarteter Status');
    expect(state.message).toBe('Supabase down');
  });

  it('enabled=false → keine Fetches (Rollen-Gating bleibt in der Route)', async () => {
    renderHook(() => useStartOverview(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCockpitSignals).not.toHaveBeenCalled();
    expect(fetchMonthCoverage).not.toHaveBeenCalled();
  });
});
