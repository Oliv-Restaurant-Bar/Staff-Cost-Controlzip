// @vitest-environment node
/**
 * Tests für den PDF-Monatsabschluss (monatsabschluss-pdf.ts):
 * reine Datenaufbereitung (§9-Inhalte) und PDF-Erzeugbarkeit.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMonatsabschlussPdf,
  buildMonatsabschlussPdfData,
  monatsabschlussPdfFilename,
  monthKeyLabel,
} from './monatsabschluss-pdf';
import { buildExportChecklist } from './buchhaltungs-export';
import {
  buildTagesabschlussRows,
  emptyTagesabschlussBlob,
  setCashDiffReasons,
  setTagesabschlussComment,
  upsertManualDay,
  type GnDayClosing,
  type TagesabschlussBlob,
} from './tagesabschluss';

const NOW = '2026-07-06T10:00:00.000Z';
const MONTH_KEY = '2026-07';

function makeClosing(date: string): GnDayClosing {
  return {
    date,
    grossRevenue: 1000,
    netRevenue: 925.07,
    tip: null,
    taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
    payments: [
      { name: 'Bar', count: 10, amount: 300 },
      { name: 'Mastercard', count: 8, amount: 550 },
      { name: 'TWINT', count: 4, amount: 100 },
      { name: 'Rechnung', count: 1, amount: 30 },
      { name: 'Gutschein', count: 1, amount: 20 },
    ],
    accountingLines: [],
    paymentAccounts: [],
  };
}

function fixture(): { blob: TagesabschlussBlob; closings: Record<string, GnDayClosing> } {
  const closings = { '2026-07-01': makeClosing('2026-07-01') };
  let blob = emptyTagesabschlussBlob();
  blob = { ...blob, anfangsbestand: { [MONTH_KEY]: { value: 500, updatedAt: NOW } } };
  // Cash Ist weicht ab → Differenz mit Begründung.
  blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 700, bemerkung: 'Ruhiger Tag' }, NOW);
  blob = setCashDiffReasons(blob, '2026-07-01', ['wechselgeld'], 'Wechselgeld nachgezählt', NOW);
  blob = setTagesabschlussComment(blob, '2026-07-01', 'twint', 'TWINT-Terminal spät synchronisiert', NOW);
  return { blob, closings };
}

describe('monthKeyLabel / Dateiname', () => {
  it('formatiert Monat und Dateinamen', () => {
    expect(monthKeyLabel('2026-07')).toBe('Juli 2026');
    expect(monthKeyLabel('2026-01')).toBe('Januar 2026');
    expect(monthKeyLabel('quatsch')).toBe('quatsch');
    expect(monatsabschlussPdfFilename('2026-07', 'Restaurant Oliv')).toBe(
      'monatsabschluss_restaurant-oliv_2026-07.pdf',
    );
  });
});

describe('buildMonatsabschlussPdfData', () => {
  it('enthält alle §9-Abschnitte: Kennzahlen, Differenzen, Begründungen, Kommentare, offene Punkte', () => {
    const { blob, closings } = fixture();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const checklist = buildExportChecklist(month, blob, MONTH_KEY);
    const data = buildMonatsabschlussPdfData({
      monthKey: MONTH_KEY,
      restaurantName: 'Restaurant Oliv',
      month,
      blob,
      checklist,
      generatedBy: 'admin@oliv.ch',
      generatedAt: NOW,
    });

    expect(data.titel).toBe('Monatsabschluss Juli 2026');
    expect(data.erstelltVon).toBe('admin@oliv.ch');

    // 9 Kennzahlen in Spec-Reihenfolge.
    expect(data.kennzahlen.map(k => k.label)).toEqual([
      'Anfangsbestand Kasse', 'Endbestand Kasse', 'Umsatz Total',
      'Kreditkarten Total (inkl. TWINT)', 'Debitoren Total', 'Barausgaben Total',
      'Verkaufte Gutscheine', 'Eingelöste Gutscheine', 'Einzahlungen Bank',
    ]);
    const kv = Object.fromEntries(data.kennzahlen.map(k => [k.label, k.value]));
    expect(kv['Anfangsbestand Kasse']).toBe('500.00');
    expect(kv['Umsatz Total']).toBe('1\u2019000.00');
    expect(kv['Kreditkarten Total (inkl. TWINT)']).toBe('650.00');

    // Differenzen-Zusammenfassung vorhanden.
    const diff = Object.fromEntries(data.differenzen.map(k => [k.label, k.value]));
    expect(diff['Tage mit Cash-Differenz']).toBe('1');
    expect(diff['davon begründet']).toBe('1');

    // Begründete Differenz mit Grund-Label + Notiz.
    expect(data.begruendeteDifferenzen).toHaveLength(1);
    expect(data.begruendeteDifferenzen[0].datum).toBe('01.07.2026');
    expect(data.begruendeteDifferenzen[0].notiz).toBe('Wechselgeld nachgezählt');
    expect(data.begruendeteDifferenzen[0].gruende.length).toBeGreaterThan(0);

    // Kommentare: Tagesbemerkung + TWINT-Feldkommentar.
    expect(data.kommentare.some(k => k.feld === 'Tag' && k.text === 'Ruhiger Tag')).toBe(true);
    expect(data.kommentare.some(k => k.text.includes('TWINT-Terminal'))).toBe(true);

    // Monat nicht abgeschlossen → offene Punkte vorhanden.
    expect(data.offenePunkte.length).toBeGreaterThan(0);
  });

  it('überspringt tombstoned Feld-Kommentare (deleted)', () => {
    const { blob, closings } = fixture();
    // TWINT-Kommentar später entfernen → Tombstone bleibt im Blob.
    const tombstoned = setTagesabschlussComment(blob, '2026-07-01', 'twint', '', '2026-07-07T10:00:00.000Z');
    const month = buildTagesabschlussRows(2026, 7, closings, tombstoned, {}, null, 500);
    const data = buildMonatsabschlussPdfData({
      monthKey: MONTH_KEY,
      restaurantName: 'Oliv',
      month,
      blob: tombstoned,
      checklist: buildExportChecklist(month, tombstoned, MONTH_KEY),
      generatedBy: 'a@b.ch',
      generatedAt: NOW,
    });
    expect(data.kommentare.some(k => k.text.includes('TWINT-Terminal'))).toBe(false);
    // Tagesbemerkung (days-Namespace) bleibt unberührt.
    expect(data.kommentare.some(k => k.feld === 'Tag' && k.text === 'Ruhiger Tag')).toBe(true);
  });

  it('zeigt „—" für Salden ohne Anker und leere Abschnitte ohne Einträge', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const blob = emptyTagesabschlussBlob();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const data = buildMonatsabschlussPdfData({
      monthKey: MONTH_KEY,
      restaurantName: 'Oliv',
      month,
      blob,
      checklist: buildExportChecklist(month, blob, MONTH_KEY),
      generatedBy: 'a@b.ch',
      generatedAt: NOW,
    });
    const kv = Object.fromEntries(data.kennzahlen.map(k => [k.label, k.value]));
    expect(kv['Anfangsbestand Kasse']).toBe('—');
    expect(kv['Endbestand Kasse']).toBe('—');
    expect(data.begruendeteDifferenzen).toEqual([]);
    expect(data.kommentare).toEqual([]);
  });
});

describe('buildMonatsabschlussPdf', () => {
  it('erzeugt ein nicht-leeres PDF (auch ohne Logo)', () => {
    const { blob, closings } = fixture();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const doc = buildMonatsabschlussPdf({
      monthKey: MONTH_KEY,
      restaurantName: 'Restaurant Oliv',
      month,
      blob,
      checklist: buildExportChecklist(month, blob, MONTH_KEY),
      generatedBy: 'admin@oliv.ch',
      generatedAt: NOW,
    });
    const out = doc.output('arraybuffer');
    expect(out.byteLength).toBeGreaterThan(1000);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('übersteht ein defektes Logo ohne Absturz', () => {
    const { blob, closings } = fixture();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const doc = buildMonatsabschlussPdf(
      {
        monthKey: MONTH_KEY,
        restaurantName: 'Oliv',
        month,
        blob,
        checklist: buildExportChecklist(month, blob, MONTH_KEY),
        generatedBy: 'a@b.ch',
        generatedAt: NOW,
      },
      'data:image/png;base64,KAPUTT',
    );
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
  });
});
