// @vitest-environment happy-dom
/**
 * T512 — Umsatzabstimmung 2024 (beide Mandanten): reale Regressionstests am
 * öffentlichen Einstiegspfad der Datenschicht (reporting-store loadYear/
 * saveMonth/availableYears mit tenant-präfixierten Keys, exakt wie die Seite
 * sie aufruft) plus die reine Status-/Jahres-/Deep-Link-Logik
 * (umsatzabstimmung-status). happy-dom liefert das echte localStorage-API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadYear, saveMonth, availableYears } from '@/lib/reporting-store';
import {
  buildUmsatzYearOptions,
  describeUmsatzMonth,
  getUmsatzRowStatus,
  parseUmsatzYearParam,
  sumDailyGrossForMonth,
} from '@/lib/umsatzabstimmung-status';

// Tenant-Key-Konvention 1:1 aus TenantContext: Oliv unpräfixiert, sonst `${id}:`.
const OLIV_KEY = 'reporting_v1';
const BEAULIEU_KEY = 'beaulieu:reporting_v1';
const CURRENT_YEAR = 2026;

beforeEach(() => {
  localStorage.clear();
});

describe('T512 — Jahresauswahl 2024 für beide Mandanten', () => {
  it('Oliv kann 2024 auswählen, auch ganz ohne 2024-Daten', () => {
    const opts = buildUmsatzYearOptions(availableYears(OLIV_KEY), CURRENT_YEAR, CURRENT_YEAR);
    expect(opts).toContain(2024);
  });

  it('Beaulieu kann 2024 auswählen, auch ganz ohne 2024-Daten', () => {
    const opts = buildUmsatzYearOptions(availableYears(BEAULIEU_KEY), CURRENT_YEAR, CURRENT_YEAR);
    expect(opts).toContain(2024);
  });

  it('Jahre mit Daten und das gewählte Jahr bleiben zusätzlich enthalten (absteigend, ohne Duplikate)', () => {
    const opts = buildUmsatzYearOptions([2023, 2026], CURRENT_YEAR, 2020);
    expect(opts).toEqual([2026, 2025, 2024, 2023, 2020]);
  });
});

describe('T512 — Tenant-Isolation der 2024-Daten', () => {
  it('Daten der beiden Mandanten bleiben strikt getrennt (getrennte Storage-Keys)', () => {
    saveMonth({ year: 2024, month: 3, grossRevenueManual: 111_000 }, 'manual', 'update', {}, OLIV_KEY);
    saveMonth({ year: 2024, month: 3, grossRevenueManual: 222_000 }, 'manual', 'update', {}, BEAULIEU_KEY);

    const oliv = loadYear(2024, OLIV_KEY);
    const beaulieu = loadYear(2024, BEAULIEU_KEY);
    expect(oliv[2].grossRevenueManual).toBe(111_000);
    expect(beaulieu[2].grossRevenueManual).toBe(222_000);
  });

  it('Oliv-Schreibvorgänge können Beaulieu niemals überschreiben und umgekehrt', () => {
    saveMonth({ year: 2024, month: 5, grossRevenueManual: 50_000 }, 'manual', 'update', {}, BEAULIEU_KEY);
    // Oliv schreibt denselben Monat — Beaulieu-Blob darf sich nicht ändern.
    const beaulieuBefore = localStorage.getItem(BEAULIEU_KEY);
    saveMonth({ year: 2024, month: 5, grossRevenueManual: 99_999 }, 'manual', 'update', {}, OLIV_KEY);
    expect(localStorage.getItem(BEAULIEU_KEY)).toBe(beaulieuBefore);
    expect(loadYear(2024, BEAULIEU_KEY)[4].grossRevenueManual).toBe(50_000);
  });

  it('Tagessummen sind je Mandant getrennt (eigene dailyBudgets-Blobs)', () => {
    const olivBlob = { '2024-04-01': { actualRevenue: 1000 } };
    const beaulieuBlob = { '2024-04-01': { actualRevenue: 7777 } };
    expect(sumDailyGrossForMonth(olivBlob, 2024, 4)).toBe(1000);
    expect(sumDailyGrossForMonth(beaulieuBlob, 2024, 4)).toBe(7777);
  });
});

describe('T512 — Jahresdaten 2024: vorhanden vs. fehlend (fehlend ≠ 0)', () => {
  it('vorhandene 2024-Monate werden geliefert, fehlende bleiben leer (undefined, nie 0)', () => {
    saveMonth({ year: 2024, month: 2, grossRevenueManual: 80_000 }, 'manual', 'update', {}, OLIV_KEY);
    const months = loadYear(2024, OLIV_KEY);
    expect(months).toHaveLength(12);
    expect(months[1].grossRevenueManual).toBe(80_000);
    // Fehlender Monat: KEIN Wert — nicht 0.
    expect(months[0].grossRevenueManual).toBeUndefined();
    expect(months[11].grossRevenueManual).toBeUndefined();
  });

  it('Auswahl 2024 lädt keine Daten aus 2025 oder 2026', () => {
    saveMonth({ year: 2025, month: 1, grossRevenueManual: 123_456 }, 'manual', 'update', {}, OLIV_KEY);
    saveMonth({ year: 2026, month: 1, grossRevenueManual: 654_321 }, 'manual', 'update', {}, OLIV_KEY);
    const months = loadYear(2024, OLIV_KEY);
    expect(months.every((m) => m.year === 2024)).toBe(true);
    expect(months.every((m) => (m.grossRevenueManual ?? 0) !== 123_456)).toBe(true);
    expect(months.every((m) => (m.grossRevenueManual ?? 0) !== 654_321)).toBe(true);
  });

  it('Tagessummen 2024 mischen keine Nachbarjahre/-monate ein (Prefix-Filter)', () => {
    const blob = {
      '2024-06-01': { actualRevenue: 100 },
      '2024-06-15': { actualRevenue: 200 },
      '2024-07-01': { actualRevenue: 999 },
      '2025-06-01': { actualRevenue: 999 },
      'kaputt': { actualRevenue: 999 },
    };
    expect(sumDailyGrossForMonth(blob, 2024, 6)).toBe(300);
  });

  it('reines Laden von 2024 löst keinen Write aus (localStorage bleibt unberührt)', () => {
    saveMonth({ year: 2024, month: 2, grossRevenueManual: 80_000 }, 'manual', 'update', {}, OLIV_KEY);
    const before = localStorage.getItem(OLIV_KEY);
    loadYear(2024, OLIV_KEY);
    availableYears(OLIV_KEY);
    expect(localStorage.getItem(OLIV_KEY)).toBe(before);
    expect(localStorage.getItem(BEAULIEU_KEY)).toBeNull();
  });
});

describe('T512 — Deep-Link und Statuslogik (unverändert)', () => {
  it('Deep-Link ?year=2024 wird akzeptiert, Unsinn ignoriert', () => {
    expect(parseUmsatzYearParam('2024')).toBe(2024);
    expect(parseUmsatzYearParam('1999')).toBeNull();
    expect(parseUmsatzYearParam('20244')).toBeNull();
    expect(parseUmsatzYearParam('abc')).toBeNull();
    expect(parseUmsatzYearParam(null)).toBeNull();
  });

  it('Zeilenstatus-Schwellen bleiben unverändert (<1 % ok, <3 % warning, sonst error)', () => {
    expect(getUmsatzRowStatus(undefined, 0)).toBe('missing');
    expect(getUmsatzRowStatus(undefined, 500)).toBe('warning');
    expect(getUmsatzRowStatus(100_000, 0)).toBe('warning');
    expect(getUmsatzRowStatus(100_000, 99_500)).toBe('ok');
    expect(getUmsatzRowStatus(100_000, 98_000)).toBe('warning');
    expect(getUmsatzRowStatus(100_000, 90_000)).toBe('error');
  });

  it('Monats-Kurzstatus: Zukunft nie „fehlend", sonst 1:1 aus dem Zeilenstatus', () => {
    expect(describeUmsatzMonth(undefined, 0, true)).toEqual({ status: 'not_due', text: 'Noch nicht fällig' });
    expect(describeUmsatzMonth(undefined, 0, false).status).toBe('missing');
    expect(describeUmsatzMonth(undefined, 500, false).text).toBe('Abstimmung noch nicht durchgeführt');
    expect(describeUmsatzMonth(100_000, 0, false).text).toBe('Tageseinträge fehlen');
    expect(describeUmsatzMonth(100_000, 99_500, false).status).toBe('ok');
    expect(describeUmsatzMonth(100_000, 90_000, false).status).toBe('error');
  });
});
