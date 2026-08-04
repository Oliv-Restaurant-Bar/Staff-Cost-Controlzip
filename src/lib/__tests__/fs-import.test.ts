// @vitest-environment node
/**
 * Regressionstests für die FS-Kern-Import-Pipeline (fs-import.ts):
 * - Lieferschein ersetzt eine PROVISORISCHE «aus Monatsrechnung»-Lieferung
 *   auch über die Monatsgrenze — im alten Monat bleiben KEINE verwaisten
 *   Rechnungen, Positionen oder Preis-Hinweise zurück.
 * - Upsert auf Referenz+Datum ersetzt statt dupliziert.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => (kv.has(key) ? kv.get(key) : null)),
  kvGetStrict: vi.fn(async (key: string) => (kv.has(key) ? kv.get(key) : null)),
  kvSet: vi.fn(async (key: string, value: unknown) => { kv.set(key, JSON.parse(JSON.stringify(value))); }),
  kvRemove: vi.fn(async (key: string) => { kv.delete(key); }),
}));

import { kernImportiereFsRechnungen } from '@/lib/fs-import';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { ParsedCsvRechnung, WarenPosition } from '@/lib/waren-positionen';

const TENANT = 'oliv' as never;
const LIEFERANT = 'Feldschlösschen';

const pos = (preis: number): WarenPosition => ({
  artNr: '10042', bezeichnung: 'Feldschlösschen Original 20/0.50', menge: 10,
  einheit: 'HAR', preis, positionspreis: preis * 10, mwstSatz: 8.1,
  mwstBetrag: Math.round(preis * 10 * 0.081 * 100) / 100, mwstCode: 1,
  warengruppe: 'Bier', warenkonto: '4030', status: 'auto',
} as unknown as WarenPosition);

const rechnung = (nr: string, datum: string, preis = 30): ParsedCsvRechnung => {
  const p = pos(preis);
  return {
    docKey: `${nr}|${datum}`, rechnungsNr: nr, datum, markt: 'Feldschlösschen',
    positionen: [p], nettoTotal: p.positionspreis,
    mwstTotal: p.mwstBetrag, bruttoTotal: Math.round((p.positionspreis + p.mwstBetrag) * 100) / 100,
  };
};

beforeEach(() => kv.clear());

describe('kernImportiereFsRechnungen', () => {
  it('bucht neu mit Lieferdatum und kennzeichnet quelle=monatsrechnung', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-1', '2026-07-30') }], { quelle: 'monatsrechnung' });
    expect(res.neu).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].quelle).toBe('monatsrechnung');
    expect(monat[0].date).toBe('2026-07-30');
  });

  it('echter Lieferschein ersetzt provisorische Lieferung über die Monatsgrenze — ohne Waisen', async () => {
    // 1) provisorisch aus Monatsrechnung, Ende Juli
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('77123', '2026-07-31', 30) }], { quelle: 'monatsrechnung' });
    // künstlichen Preis-Hinweis am provisorischen Eintrag ablegen (Waisen-Check)
    const provId = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0].id;
    kv.set('waren_preishinweise_2026-07_v1', { [provId]: [{ key: 'x' }] });
    // 2) echter Lieferschein, gleiche Referenz, Lieferdatum 1. August
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('77123', '2026-08-01', 30) }]);
    expect(res.provisorischErsetzt).toBe(1);
    expect(res.ersetzt).toBe(1);
    // Juli: komplett aufgeräumt
    expect(kv.get('supplier_invoices_2026-07') as InvoiceEntry[]).toHaveLength(0);
    expect(Object.keys((kv.get(`waren_positionen_2026-07_v1`) as Record<string, unknown>) ?? {})).toHaveLength(0);
    expect(Object.keys((kv.get('waren_preishinweise_2026-07_v1') as Record<string, unknown>) ?? {})).toHaveLength(0);
    // August: genau einer, nicht mehr provisorisch
    const aug = kv.get('supplier_invoices_2026-08') as InvoiceEntry[];
    expect(aug).toHaveLength(1);
    expect(aug[0].quelle).toBeUndefined();
    expect(aug[0].reference).toBe('77123');
  });

  it('Monatsrechnung überschreibt NIE eine echte Buchung (gleiche Referenz+Datum)', async () => {
    // 1) echter Einzel-Lieferschein
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-42', '2026-07-10', 30) }]);
    const echt = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    expect(echt.quelle).toBeUndefined();
    // 2) Monatsrechnung mit derselben Lieferung (abweichender Preis)
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-42', '2026-07-10', 99) }], { quelle: 'monatsrechnung' });
    expect(res.uebersprungen).toBe(1);
    expect(res.neu + res.ersetzt).toBe(0);
    // Buchung unverändert: nicht provisorisch, alter Betrag, gleiche ID
    const nach = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(nach).toHaveLength(1);
    expect(nach[0].id).toBe(echt.id);
    expect(nach[0].quelle).toBeUndefined();
    expect(nach[0].amountNet).toBe(echt.amountNet);
  });

  it('erneute Monatsrechnung aktualisiert die EIGENE provisorische Buchung (Upsert, kein Doppel)', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-77', '2026-07-12', 30) }], { quelle: 'monatsrechnung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-77', '2026-07-12', 31) }], { quelle: 'monatsrechnung' });
    expect(res.ersetzt).toBe(1);
    expect(res.uebersprungen).toBe(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].quelle).toBe('monatsrechnung');
  });

  it('AB-als-Lieferschein (Terravigna): AB provisorisch, Rechnung ersetzt via ±3 Tage/±0.10 — kein Doppel', async () => {
    // 1) Auftragsbestätigung 145095 vom 23.07. provisorisch buchen
    await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('145095', '2026-07-23', 30) }], { quelle: 'auftragsbestaetigung' });
    const prov = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    expect(prov.quelle).toBe('auftragsbestaetigung');
    expect(prov.note).toContain('provisorisch (Auftragsbestätigung)');
    // 2) Monatsrechnung: Lieferung 287812 vom 23.07., gleicher Betrag, andere Referenz
    const res = await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('287812', '2026-07-23', 30) }], { ersatzFensterTage: 3 });
    expect(res.provisorischErsetzt).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].quelle).toBeUndefined();
    expect(monat[0].reference).toBe('287812');
  });

  it('ersatzFensterTage=3: AB ausserhalb des Fensters wird NICHT ersetzt (frisch gebucht)', async () => {
    await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('145000', '2026-07-10', 30) }], { quelle: 'auftragsbestaetigung' });
    const res = await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('287800', '2026-07-15', 30) }], { ersatzFensterTage: 3 });
    expect(res.provisorischErsetzt).toBe(0);
    expect(res.neu).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])).toHaveLength(2);
  });

  it('AB-Re-Upload = Upsert der eigenen provisorischen Buchung (nie doppelt)', async () => {
    await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('145095', '2026-07-23', 30) }], { quelle: 'auftragsbestaetigung' });
    const res = await kernImportiereFsRechnungen(TENANT, 'Terravigna', [{ r: rechnung('145095', '2026-07-23', 31) }], { quelle: 'auftragsbestaetigung' });
    expect(res.ersetzt).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])).toHaveLength(1);
  });

  it('ersetzt provisorisch auch bei abweichender Referenz via ±7 Tage/±0.10', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('FAKT-9', '2026-07-29', 30) }], { quelle: 'monatsrechnung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-555', '2026-08-02', 30) }]);
    expect(res.provisorischErsetzt).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])).toHaveLength(0);
    expect((kv.get('supplier_invoices_2026-08') as InvoiceEntry[])).toHaveLength(1);
  });

  it('gleiche Referenz+Datum = Upsert, nie Duplikat; provisorische Übernahme ersetzt nichts Bestehendes', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-2', '2026-08-03', 30) }]);
    // Monatsrechnungs-Weg darf einen echten Lieferschein NICHT anfassen
    const res1 = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-9', '2026-08-03', 30) }], { quelle: 'monatsrechnung' });
    expect(res1.ersetzt).toBe(0);
    expect(res1.neu).toBe(1);
    // erneuter identischer Lieferschein = ersetzt
    const res2 = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-2', '2026-08-03', 31) }]);
    expect(res2.ersetzt).toBe(1);
    const aug = kv.get('supplier_invoices_2026-08') as InvoiceEntry[];
    expect(aug.filter(e => e.reference === 'L-2')).toHaveLength(1);
  });
});
