// @vitest-environment node
/**
 * Marketing-Import: verbindliche Marketing-Erkennung + Jahres-Ersatz-Semantik.
 *
 * Definition (für ALLE Monate gleich): NUR Bezeichnungen, die «marketing»
 * enthalten (case-insensitive, inkl. Tippvarianten). Maison/Rabatte/
 * Gutschein/Sponsoring/Einzelnamen zählen NIE.
 *
 * Speichern: Datei = massgebliche Quelle → ersetzt die Marketing-Tageswerte
 * der Datei-Jahre komplett (gleiche Tage ersetzen, Alt-Tage entfernen, nie
 * addieren); andere Jahre bleiben unberührt. Merge-Basis strikt aus dem KV.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isMarketingLabel } from '../maison-import';

const kv: { store: Record<string, unknown>; failGet: boolean } = { store: {}, failGet: false };

vi.mock('../supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => {
    if (kv.failGet) throw new Error('KV down');
    return kv.store[key] ?? null;
  }),
  kvSet: vi.fn(async (key: string, value: unknown) => { kv.store[key] = value; }),
}));

import { saveMaisonDailyReplaceYears } from '../maison-store';

const tk = (k: string) => k; // Oliv: unpräfixiert

// localStorage-Stub (node-Umgebung)
const ls = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => { ls.set(k, v); },
  removeItem: (k: string) => { ls.delete(k); },
});

describe('isMarketingLabel — verbindliche Definition', () => {
  it('zählt Marketing-Varianten (case-insensitive, Tippvarianten)', () => {
    for (const s of ['Marketing', 'marketing', 'MARKETING', 'marketing@', 'Marketing influencerin Tanja', ' marketing ']) {
      expect(isMarketingLabel(s), s).toBe(true);
    }
  });
  it('zählt NIE Maison/Rabatte/Gutschein/Sponsoring/Namen', () => {
    for (const s of ['Maison', 'Rabatte', 'Mitarbeiter Rabatt', 'Gutschein', 'Sponsoring', 'Tanja Muster', 'Bewirtung Hr. Meier', 'market', '']) {
      expect(isMarketingLabel(s), s).toBe(false);
    }
  });
});

describe('saveMaisonDailyReplaceYears — Jahres-Ersatz', () => {
  beforeEach(() => { kv.store = {}; kv.failGet = false; ls.clear(); });

  it('ersetzt Datei-Jahre komplett: gleiche Tage ersetzt, Alt-Tage entfernt, andere Jahre unberührt', async () => {
    kv.store['maison-daily'] = {
      '2026-01-05': 100,   // wird ersetzt
      '2026-03-09': 999,   // Alt-Tag nicht in Datei → entfernt
      '2025-12-31': 55.5,  // anderes Jahr → bleibt
    };
    await saveMaisonDailyReplaceYears(tk, [2026], {
      '2026-01-05': 120.4,
      '2026-07-01': 300,
    });
    expect(kv.store['maison-daily']).toEqual({
      '2025-12-31': 55.5,
      '2026-01-05': 120.4,
      '2026-07-01': 300,
    });
  });

  it('addiert nie doppelt: zweiter identischer Import ändert nichts', async () => {
    const daily = { '2026-07-01': 300, '2026-07-02': 150.25 };
    await saveMaisonDailyReplaceYears(tk, [2026], daily);
    await saveMaisonDailyReplaceYears(tk, [2026], daily);
    expect(kv.store['maison-daily']).toEqual(daily);
  });

  it('strikte Merge-Basis: KV-Lesefehler → KEIN Write (kein Remote-Wipe)', async () => {
    kv.store['maison-daily'] = { '2025-12-31': 55.5 };
    kv.failGet = true;
    await expect(saveMaisonDailyReplaceYears(tk, [2026], { '2026-07-01': 300 })).rejects.toThrow();
    kv.failGet = false;
    expect(kv.store['maison-daily']).toEqual({ '2025-12-31': 55.5 });
  });
});
