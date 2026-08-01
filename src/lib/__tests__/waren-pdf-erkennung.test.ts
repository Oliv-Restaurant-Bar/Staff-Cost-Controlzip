// @vitest-environment node
/**
 * PDF-Erkennung Warenrechnungen — pure Parsing-/Matching-Logik:
 * Lieferanten-Matching (Alias, normalisiert, Reihenfolge/Rechtsform egal),
 * Volltext-Suche und Feld-Erkennung (Datum/Betrag/MWST/Referenz).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSupplierKey, matchSupplier, findSupplierInText, parseInvoiceText,
} from '../waren-pdf-erkennung';

const SUPPLIERS = ['Prodega', 'Transgourmet', 'Blaser Café', 'Metzgerei Spahni', 'Siebe Dupf'];

describe('normalizeSupplierKey', () => {
  it('Umlaute, Akzente, Punktuation, Case', () => {
    expect(normalizeSupplierKey('Blaser Café')).toBe('blaser cafe');
    expect(normalizeSupplierKey('MÜLLER-Bäckerei AG')).toBe('mueller baeckerei ag');
  });
});

describe('matchSupplier', () => {
  it('Alias gewinnt vor allem anderen', () => {
    const hit = matchSupplier('TG Schweiz', SUPPLIERS, { 'tg schweiz': 'Transgourmet' });
    expect(hit).toEqual({ name: 'Transgourmet', via: 'alias' });
  });
  it('exakter normalisierter Name (Case/Umlaut egal)', () => {
    expect(matchSupplier('blaser café', SUPPLIERS, {})?.name).toBe('Blaser Café');
  });
  it('Token-Reihenfolge egal', () => {
    expect(matchSupplier('Café Blaser', SUPPLIERS, {})?.via).toBe('tokens');
  });
  it('Rechtsform/Zusätze ignoriert (enthalten)', () => {
    expect(matchSupplier('Transgourmet Schweiz AG', SUPPLIERS, {})?.name).toBe('Transgourmet');
  });
  it('unbekannt/mehrdeutig → null', () => {
    expect(matchSupplier('Pistor', SUPPLIERS, {})).toBeNull();
    expect(matchSupplier('', SUPPLIERS, {})).toBeNull();
  });
});

describe('findSupplierInText', () => {
  it('findet Lieferant im Volltext (längster Treffer gewinnt)', () => {
    const text = 'Rechnung\nProdega Markt Bern\nTotal CHF 500.00';
    expect(findSupplierInText(text, SUPPLIERS, {})).toBe('Prodega');
  });
  it('Alias im Volltext', () => {
    expect(findSupplierInText('Lieferung von TG Schweiz Basel', SUPPLIERS, { 'tg schweiz': 'Transgourmet' }))
      .toBe('Transgourmet');
  });
  it('kein Treffer → null', () => {
    expect(findSupplierInText('Irgendein Text ohne Lieferant', SUPPLIERS, {})).toBeNull();
  });
  it('sehr kurze Ein-Token-Namen matchen nie im Volltext (False-Positive-Schutz)', () => {
    expect(findSupplierInText('Rechnung an la Bar co KG', ['La', 'Co'], {})).toBeNull();
  });
});

describe('parseInvoiceText', () => {
  const text = `Metzgerei Spahni AG
    Rechnungs-Nr.: RE-2026-0815
    Rechnungsdatum: 15.07.2026
    Lieferdatum 14.07.2026
    Zwischensumme 1'234.50
    MWST 2.6 % 32.10
    Total CHF 1'266.60`;

  it('Lieferdatum hat Vorrang vor Rechnungsdatum', () => {
    const r = parseInvoiceText(text);
    expect(r.date).toBe('2026-07-14');
    expect(r.dateSicher).toBe(true);
  });
  it('Total (Label) als Brutto-Betrag, sicher', () => {
    const r = parseInvoiceText(text);
    expect(r.amount).toBeCloseTo(1266.6);
    expect(r.amountSicher).toBe(true);
  });
  it('MWST-Satz und Referenz erkannt', () => {
    const r = parseInvoiceText(text);
    expect(r.vatRate).toBe(2.6);
    expect(r.reference).toBe('RE-2026-0815');
  });
  it('ohne Labels: grösster Betrag + erstes Datum, beides unsicher', () => {
    const r = parseInvoiceText('Lieferung 03.07.2026 Positionen 12.50 908.75 45.00');
    expect(r.date).toBe('2026-07-03');
    expect(r.dateSicher).toBe(false);
    expect(r.amount).toBeCloseTo(908.75);
    expect(r.amountSicher).toBe(false);
  });
  it('leerer Text → alles null, kein Crash', () => {
    const r = parseInvoiceText('');
    expect(r.date).toBeNull();
    expect(r.amount).toBeNull();
    expect(r.vatRate).toBeNull();
    expect(r.reference).toBeNull();
  });
});
