// @vitest-environment node
/**
 * Tests import-prefill — Validierung der Checklisten-Query-Params
 * (advisory Prefill auf den Import-Zielseiten).
 */
import { describe, it, expect } from 'vitest';
import { parseImportPrefill, prefillRangeLabel } from '../import-prefill';

const params = (init: Record<string, string>) => new URLSearchParams(init);

describe('parseImportPrefill', () => {
  it('liest from/to/scope/target', () => {
    const p = parseImportPrefill(
      params({ from: '2026-07-01', to: '2026-07-08', scope: 'range', target: 'tagesumsatz' }),
    );
    expect(p).toEqual({
      from: '2026-07-01',
      to: '2026-07-08',
      scope: 'range',
      target: 'tagesumsatz',
      year: null,
      month: null,
    });
  });

  it('liest year/month (Budget/Reporting)', () => {
    const p = parseImportPrefill(params({ year: '2026', month: '6', target: 'istkosten' }));
    expect(p?.year).toBe(2026);
    expect(p?.month).toBe(6);
  });

  it('gibt null zurück ohne verwertbare Params (z. B. nur ?tab=…)', () => {
    expect(parseImportPrefill(params({ tab: 'verlauf' }))).toBeNull();
    expect(parseImportPrefill(params({}))).toBeNull();
  });

  it('verwirft invalide Werte statt sie durchzureichen', () => {
    expect(parseImportPrefill(params({ from: 'nicht-ein-datum' }))).toBeNull();
    expect(parseImportPrefill(params({ year: '99999' }))).toBeNull();
    expect(parseImportPrefill(params({ month: '13', year: '2026' }))?.month).toBeNull();
    // to < from → to wird verworfen
    const p = parseImportPrefill(params({ from: '2026-07-08', to: '2026-07-01' }));
    expect(p?.from).toBe('2026-07-08');
    expect(p?.to).toBeNull();
  });
});

describe('prefillRangeLabel', () => {
  it('formatiert Zeitraum, Einzeltag, Monat und Jahr', () => {
    expect(
      prefillRangeLabel(parseImportPrefill(params({ from: '2026-07-01', to: '2026-07-08' }))!),
    ).toBe('01.07.–08.07.2026');
    expect(
      prefillRangeLabel(parseImportPrefill(params({ from: '2026-07-04', to: '2026-07-04' }))!),
    ).toBe('04.07.2026');
    expect(prefillRangeLabel(parseImportPrefill(params({ year: '2026', month: '7' }))!)).toBe(
      'Juli 2026',
    );
    expect(prefillRangeLabel(parseImportPrefill(params({ year: '2026' }))!)).toBe('2026');
  });
});
