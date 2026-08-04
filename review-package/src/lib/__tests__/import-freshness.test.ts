// @vitest-environment happy-dom
// (supabase-transitive Importe brauchen DOM-Globals — wie gaeste-diff.test.ts)
import { describe, it, expect } from 'vitest';
import {
  computeAmpel, summarizeReadiness, maxDateKey, fmtIsoShort, shiftIso, diffDays,
  type SourceFreshness,
} from '@/lib/import-freshness';

const TODAY = '2026-08-02';

describe('computeAmpel', () => {
  it('grau ohne Daten', () => {
    expect(computeAmpel(null, TODAY)).toEqual({ status: 'gray', missingDays: 0 });
  });
  it('grün wenn Daten bis gestern (Toleranz 1)', () => {
    expect(computeAmpel('2026-08-01', TODAY).status).toBe('green');
    expect(computeAmpel('2026-08-02', TODAY).status).toBe('green'); // heute schon da
  });
  it('orange mit Fehl-Tagen bis gestern', () => {
    // vollständig bis 29.07. → fehlen 30.07., 31.07., 01.08. = 3 Tage
    expect(computeAmpel('2026-07-29', TODAY)).toEqual({ status: 'orange', missingDays: 3 });
    expect(computeAmpel('2026-07-31', TODAY)).toEqual({ status: 'orange', missingDays: 1 });
  });
  it('Toleranz 7 (Rezensionen): eine Woche zurück ist noch grün', () => {
    expect(computeAmpel('2026-07-26', TODAY, 7).status).toBe('green');
    expect(computeAmpel('2026-07-25', TODAY, 7).status).toBe('orange');
  });
});

function row(id: string, completeUntil: string | null, status: SourceFreshness['status']): SourceFreshness {
  return { id: id as SourceFreshness['id'], label: id, completeUntil, status, missingDays: 0 };
}

describe('summarizeReadiness', () => {
  it('alle grün → aktuell bis MIN-Datum', () => {
    const s = summarizeReadiness([row('a', '2026-08-01', 'green'), row('b', '2026-07-31', 'green')]);
    expect(s.allCurrent).toBe(true);
    expect(s.currentUntil).toBe('2026-07-31');
  });
  it('Rückstand listet die orangen Quellen', () => {
    const s = summarizeReadiness([row('a', '2026-08-01', 'green'), row('b', '2026-07-20', 'orange'), row('c', null, 'gray')]);
    expect(s.allCurrent).toBe(false);
    expect(s.behind).toEqual(['b']);
    expect(s.never).toEqual(['c']);
  });
  it('gar keine Daten → nicht allCurrent, currentUntil null', () => {
    const s = summarizeReadiness([row('a', null, 'gray')]);
    expect(s.allCurrent).toBe(false);
    expect(s.currentUntil).toBeNull();
  });
});

describe('maxDateKey', () => {
  it('ignoriert Nicht-Datums-Keys und nicht akzeptierte Werte', () => {
    expect(maxDateKey({ '2026-01-05': 3, '2026-02-01': 0, foo: 9 }, v => Number(v) > 0)).toBe('2026-01-05');
  });
  it('deckelt auf maxIso (Zukunft zählt nicht)', () => {
    expect(maxDateKey({ '2026-08-10': 1, '2026-07-30': 1 }, () => true, TODAY)).toBe('2026-07-30');
  });
  it('leer → null', () => {
    expect(maxDateKey({})).toBeNull();
    expect(maxDateKey(null)).toBeNull();
  });
});

describe('Datums-Helfer', () => {
  it('fmtIsoShort', () => {
    expect(fmtIsoShort('2026-08-02')).toBe('02.08.2026');
    expect(fmtIsoShort('2026-08-02', false)).toBe('02.08.');
    expect(fmtIsoShort(null)).toBe('—');
  });
  it('shiftIso/diffDays (auch über Monatsgrenzen)', () => {
    expect(shiftIso('2026-08-01', -1)).toBe('2026-07-31');
    expect(diffDays('2026-07-29', '2026-08-02')).toBe(4);
  });
});
