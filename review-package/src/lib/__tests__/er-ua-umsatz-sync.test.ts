// @vitest-environment node
/**
 * V003 — Synchronitätstest Erfolgsrechnung ≡ Umsatzabstimmung
 * ============================================================
 * Für denselben Tenant, dasselbe Jahr und denselben Monat gilt:
 *
 *   Umsatz der Erfolgsrechnung  ===  Referenz-Umsatz der Umsatzabstimmung
 *
 * Getestet über die GEMEINSAMEN ÖFFENTLICHEN READER (keine Zweitberechnung):
 *   - UA-Referenz:  sumDailyGrossForMonth (umsatzabstimmung-status, SSoT —
 *                   von UmsatzAbstimmung.tsx via getDailyGrossForMonth und
 *                   von der Startseiten-Monatsübersicht konsumiert)
 *   - ER-Umsatz:    applyEffectiveMonthRules / computeMonthlyIstGross
 *                   (effective-records + revenue-sync, SSoT der Erfolgsrechnung,
 *                   Regel 1: Tagesansicht schlägt reporting_v1 ohne 3xxx-Konten)
 *   - Blob-Zugriff: readLocalRecord (kv-blob-utils) über tenant-präfixierte Keys
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

import { sumDailyGrossForMonth } from '@/lib/umsatzabstimmung-status';
import { computeMonthlyIstGross } from '@/lib/revenue-sync';
import { applyEffectiveMonthRules } from '@/lib/effective-records';
import { readLocalRecord } from '@/lib/kv-blob-utils';
import { createEmptyMonth } from '@/types/reporting';

// Tenant-Keys wie in der App: Oliv unpräfixiert, Beaulieu mit Präfix.
const OLIV_DAILY_KEY = 'dailyBudgets';
const BEAULIEU_DAILY_KEY = 'beaulieu:dailyBudgets';

/** Tages-Blob eines Monats mit «krummen» Rohwerten (keine runden Zahlen). */
function buildMonthBlob(year: number, month: number, seed: number): Record<string, { actualRevenue: number }> {
  const days = new Date(year, month, 0).getDate();
  const blob: Record<string, { actualRevenue: number }> = {};
  const mm = String(month).padStart(2, '0');
  for (let d = 1; d <= days; d++) {
    blob[`${year}-${mm}-${String(d).padStart(2, '0')}`] = {
      actualRevenue: seed + d * 137.415 + (d % 3) * 0.07,
    };
  }
  return blob;
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
});

describe('V003 — ER-Umsatz ≡ UA-Referenz über die gemeinsamen öffentlichen Reader', () => {
  it('computeMonthlyIstGross (ER) === sumDailyGrossForMonth (UA) für alle 12 Monate 2024 inkl. Schaltmonat Februar', () => {
    // Jahres-Blob 2024 (Schaltjahr) + Stördaten aus Nachbarjahren, die beide
    // Reader gleichermassen ignorieren müssen.
    const blob: Record<string, { actualRevenue: number }> = {};
    for (let m = 1; m <= 12; m++) Object.assign(blob, buildMonthBlob(2024, m, 800 + m));
    blob['2023-12-31'] = { actualRevenue: 55555.55 };
    blob['2025-01-01'] = { actualRevenue: 66666.66 };

    for (let m = 1; m <= 12; m++) {
      const er = computeMonthlyIstGross(2024, m, blob);
      const ua = sumDailyGrossForMonth(blob, 2024, m);
      expect(er, `Monat ${m}`).toBeCloseTo(ua, 8);
      expect(er).toBeGreaterThan(0);
    }
    // Februar 2024 umfasst in BEIDEN Readern den 29. Tag
    const feb28 = Object.entries(blob)
      .filter(([k]) => k.startsWith('2024-02-') && k !== '2024-02-29')
      .reduce((s, [, v]) => s + v.actualRevenue, 0);
    expect(sumDailyGrossForMonth(blob, 2024, 2) - feb28).toBeCloseTo(blob['2024-02-29'].actualRevenue, 8);
  });

  it('Effektiver ER-Monats-Record (Regel 1, Brutto) trägt exakt die UA-Referenz als revenueActual', () => {
    const year = 2026;
    const month = 5;
    const blob = buildMonthBlob(year, month, 950);

    // Leerer reporting-Monat OHNE 3xxx-Konten → Regel 1 greift (Tagesansicht)
    const rec = createEmptyMonth(year, month);
    const effective = applyEffectiveMonthRules(rec, month, {
      year,
      dailyBudgets: blob,
      net: false, // Brutto-Sicht = dieselbe Basis wie die UA-Tagessumme
    });

    const uaRef = sumDailyGrossForMonth(blob, year, month);
    expect(effective.revenueActual).toBeDefined();
    expect(effective.revenueActual!).toBeCloseTo(uaRef, 8);
  });

  it('Matrix: Oliv 2024+2025, Beaulieu 2025+2026 synchron — Beaulieu 2024 bleibt fehlend (kein Rückfall auf 0)', () => {
    // Tenant-getrennte Tages-Blobs: Beaulieu hat KEINE 2024-Daten.
    const olivBlob: Record<string, { actualRevenue: number }> = {};
    const beaulieuBlob: Record<string, { actualRevenue: number }> = {};
    for (let m = 1; m <= 12; m++) {
      Object.assign(olivBlob, buildMonthBlob(2024, m, 500 + m));
      Object.assign(olivBlob, buildMonthBlob(2025, m, 1500 + m));
      Object.assign(beaulieuBlob, buildMonthBlob(2025, m, 3100 + m));
      Object.assign(beaulieuBlob, buildMonthBlob(2026, m, 5200 + m));
    }
    localStorageStore[OLIV_DAILY_KEY] = JSON.stringify(olivBlob);
    localStorageStore[BEAULIEU_DAILY_KEY] = JSON.stringify(beaulieuBlob);

    const cases: Array<{ key: string; year: number }> = [
      { key: OLIV_DAILY_KEY, year: 2024 },
      { key: OLIV_DAILY_KEY, year: 2025 },
      { key: BEAULIEU_DAILY_KEY, year: 2025 },
      { key: BEAULIEU_DAILY_KEY, year: 2026 },
    ];
    for (const { key, year } of cases) {
      const blob = readLocalRecord(key);
      for (let m = 1; m <= 12; m++) {
        const ua = sumDailyGrossForMonth(blob, year, m);
        const er = computeMonthlyIstGross(year, m, blob as Record<string, { actualRevenue?: number }>);
        // Numerischer Vergleich der Rohwerte — nie über formatierte Strings.
        expect(er, `${key} ${year}-${m}`).toBeCloseTo(ua, 8);
        expect(ua, `${key} ${year}-${m} hat Daten`).toBeGreaterThan(0);
      }
    }

    // Beaulieu 2024: keine Tagesdaten → Regel 1 greift NICHT, der leere
    // ER-Monats-Record behält revenueActual = undefined (fehlend ≠ 0).
    const beaulieu2024 = readLocalRecord(BEAULIEU_DAILY_KEY);
    for (let m = 1; m <= 12; m++) {
      const effective = applyEffectiveMonthRules(createEmptyMonth(2024, m), m, {
        year: 2024,
        dailyBudgets: beaulieu2024 as Record<string, { actualRevenue?: number }>,
        net: false,
      });
      expect(effective.revenueActual, `Beaulieu 2024-${m} bleibt fehlend`).toBeUndefined();
    }
  });

  it('Tenant-Isolation: Oliv- und Beaulieu-Reader liefern je die EIGENE Referenz (keine Vermischung)', () => {
    const year = 2026;
    const month = 3;
    const olivBlob = buildMonthBlob(year, month, 700);
    const beaulieuBlob = buildMonthBlob(year, month, 4200);
    localStorageStore[OLIV_DAILY_KEY] = JSON.stringify(olivBlob);
    localStorageStore[BEAULIEU_DAILY_KEY] = JSON.stringify(beaulieuBlob);

    // Identischer Lesepfad wie UmsatzAbstimmung.getDailyGrossForMonth:
    const olivUa = sumDailyGrossForMonth(readLocalRecord(OLIV_DAILY_KEY), year, month);
    const beaulieuUa = sumDailyGrossForMonth(readLocalRecord(BEAULIEU_DAILY_KEY), year, month);

    // ER-Seite je Tenant über denselben Blob:
    const olivEr = computeMonthlyIstGross(year, month, readLocalRecord(OLIV_DAILY_KEY) as Record<string, { actualRevenue?: number }>);
    const beaulieuEr = computeMonthlyIstGross(year, month, readLocalRecord(BEAULIEU_DAILY_KEY) as Record<string, { actualRevenue?: number }>);

    expect(olivEr).toBeCloseTo(olivUa, 8);
    expect(beaulieuEr).toBeCloseTo(beaulieuUa, 8);
    // Verschiedene Tenants → verschiedene Werte (kein Cross-Tenant-Leak)
    expect(Math.abs(olivUa - beaulieuUa)).toBeGreaterThan(1);
  });
});
