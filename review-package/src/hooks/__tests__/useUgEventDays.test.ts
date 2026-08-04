// @vitest-environment happy-dom
/**
 * Race-Test der «UG/Event offen»-Toggles: schnelle Mehrfach-Toggles mit
 * verzögerten/umgeordneten Save-Antworten — persistiert werden muss am Ende
 * exakt der zuletzt gewollte Stand (kein out-of-order last-write-wins).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const saves: { dates: string[]; resolve: () => void; reject: (e: Error) => void }[] = [];

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/ug-event-days-db', () => ({
  loadUgEventDays: vi.fn(async () => new Set<string>()),
  saveUgEventDays: vi.fn(
    (_tenant: string, dates: Set<string>) =>
      new Promise<void>((resolve, reject) => {
        saves.push({ dates: [...dates].sort(), resolve, reject });
      }),
  ),
}));

import { useUgEventDays } from '@/hooks/useUgEventDays';
import { saveUgEventDays } from '@/lib/ug-event-days-db';

beforeEach(() => {
  saves.length = 0;
  vi.mocked(saveUgEventDays).mockClear();
});

describe('useUgEventDays — serialisierte Schreibzugriffe', () => {
  it('schnelles An/Aus/An: gespeichert wird nur der letzte gewollte Stand', async () => {
    const { result } = renderHook(() => useUgEventDays());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 3 Toggles in Folge, BEVOR irgendein Save antwortet.
    act(() => { result.current.toggle('2026-08-01'); });
    act(() => { result.current.toggle('2026-08-01'); });
    act(() => { result.current.toggle('2026-08-01'); });
    expect([...result.current.eventDays]).toEqual(['2026-08-01']); // UI = letzte Absicht

    // Veraltete Revisionen werden übersprungen: es committet genau EIN Save
    // mit dem zuletzt gewollten Endstand.
    await waitFor(() => expect(saves.length).toBe(1));
    expect(saves[0].dates).toEqual(['2026-08-01']);
    await act(async () => { saves[0].resolve(); });

    // Es darf kein weiterer (veralteter) Save mehr kommen.
    await new Promise((r) => setTimeout(r, 10));
    expect(saves.length).toBe(1);
    expect([...result.current.eventDays]).toEqual(['2026-08-01']);
  });

  it('Saves laufen strikt nacheinander (kein paralleler Upsert)', async () => {
    const { result } = renderHook(() => useUgEventDays());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.toggle('2026-08-01'); });
    await waitFor(() => expect(saves.length).toBe(1));
    act(() => { result.current.toggle('2026-08-02'); });

    // Zweiter Save darf erst starten, wenn der erste fertig ist.
    await new Promise((r) => setTimeout(r, 10));
    expect(saves.length).toBe(1);
    await act(async () => { saves[0].resolve(); });
    await waitFor(() => expect(saves.length).toBe(2));
    expect(saves[1].dates).toEqual(['2026-08-01', '2026-08-02']);
    await act(async () => { saves[1].resolve(); });
  });

  it('Fehler beim LETZTEN Stand: DB-Stand wird neu geladen (Rollback zur Wahrheit)', async () => {
    const { result } = renderHook(() => useUgEventDays());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.toggle('2026-08-01'); });
    await waitFor(() => expect(saves.length).toBe(1));
    await act(async () => { saves[0].reject(new Error('kaputt')); });

    await waitFor(() => expect([...result.current.eventDays]).toEqual([]));
  });
});
