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

  it('echter Lieferschein ersetzt provisorische Lieferung (AB) über die Monatsgrenze — ohne Waisen', async () => {
    // 1) provisorisch (Auftragsbestätigung), Ende Juli
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('77123', '2026-07-31', 30) }], { quelle: 'auftragsbestaetigung' });
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

  it('Monatsrechnung ist MASSGEBLICH: überschreibt den provisorischen Lieferschein mit finalen Werten', async () => {
    // 1) provisorischer Einzel-Lieferschein
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-42', '2026-07-10', 30) }]);
    const prov = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    // 2) Monatsrechnung mit derselben Lieferung (finaler, abweichender Preis)
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-42', '2026-07-10', 99) }], { quelle: 'monatsrechnung' });
    expect(res.ueberschrieben).toBe(1);
    expect(res.ersetzt).toBe(1);
    // final: neuer Betrag, gleiche ID, final-Flag gesetzt — nie doppelt
    const nach = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(nach).toHaveLength(1);
    expect(nach[0].id).toBe(prov.id);
    expect(nach[0].final).toBe(true);
    expect(nach[0].quelle).toBe('monatsrechnung');
    expect(nach[0].amountNet).toBe(990);
  });

  it('Monatsrechnung übernimmt das Lieferdatum je EINZELNER Lieferung — nie das Belegdatum', async () => {
    // provisorischer LS am 10.07.; Rechnung sagt: Lieferung war am 11.07.
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-50', '2026-07-10', 30) }]);
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-50', '2026-07-11', 30) }], { quelle: 'monatsrechnung' });
    expect(res.ueberschrieben).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].date).toBe('2026-07-11');
    expect(monat[0].final).toBe(true);
  });

  it('nach Finalisierung: erneuter Lieferschein-Upload verschlechtert die finalen Werte NICHT («bereits final»)', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-60', '2026-07-05', 99) }], { quelle: 'monatsrechnung' });
    const final = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    // Lieferschein derselben Lieferung: exakt (Ref+Datum) UND nur per Referenz
    const res1 = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-60', '2026-07-05', 30) }]);
    expect(res1.bereitsFinal).toBe(1);
    const res2 = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-60', '2026-07-06', 30) }]);
    expect(res2.bereitsFinal).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].amountNet).toBe(final.amountNet);
    expect(monat[0].final).toBe(true);
  });

  it('zweite/falsche Monatsrechnung überschreibt eine FINALE Buchung NICHT (Datum/Betrag-Match ⇒ bereitsFinal)', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-70', '2026-07-05', 30) }], { quelle: 'monatsrechnung' });
    const final = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    // andere Referenz, gleiches Datum + Betrag → matcht nur via Datum/Betrag
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('FALSCH-1', '2026-07-05', 30) }], { quelle: 'monatsrechnung' });
    expect(res.bereitsFinal).toBe(1);
    expect(res.ueberschrieben + res.ersetzt + res.neu).toBe(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].id).toBe(final.id);
    expect(monat[0].reference).toBe('LS-70');
  });

  it('FINAL-Wache greift auch im Nachbarmonat (Fenster 3, Datum/Betrag-Match)', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-71', '2026-07-31', 30) }], { quelle: 'monatsrechnung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('FALSCH-2', '2026-08-01', 30) }], { quelle: 'monatsrechnung', ersatzFensterTage: 3 });
    expect(res.bereitsFinal).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])).toHaveLength(1);
    expect(kv.get('supplier_invoices_2026-08') ?? []).toHaveLength(0);
  });

  it('erneute Monatsrechnung aktualisiert die EIGENE finale Buchung (Upsert, kein Doppel)', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-77', '2026-07-12', 30) }], { quelle: 'monatsrechnung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-77', '2026-07-12', 31) }], { quelle: 'monatsrechnung' });
    expect(res.ersetzt).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].quelle).toBe('monatsrechnung');
    expect(monat[0].final).toBe(true);
    expect(monat[0].amountNet).toBe(310);
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

  it('ersetzt provisorisch (AB) auch bei abweichender Referenz via ±7 Tage/±0.10', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('FAKT-9', '2026-07-29', 30) }], { quelle: 'auftragsbestaetigung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-555', '2026-08-02', 30) }]);
    expect(res.provisorischErsetzt).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])).toHaveLength(0);
    expect((kv.get('supplier_invoices_2026-08') as InvoiceEntry[])).toHaveLength(1);
  });

  it('MR-Match ohne Referenz: exaktes Datum + Betrag ±0.10 — jede Lieferung existiert genau einmal', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-2', '2026-08-03', 30) }]);
    // Monatsrechnung listet dieselbe Lieferung unter anderer Nr (Datum+Betrag matchen)
    const res1 = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-9', '2026-08-03', 30) }], { quelle: 'monatsrechnung' });
    expect(res1.ueberschrieben).toBe(1);
    expect(res1.neu).toBe(0);
    const aug = kv.get('supplier_invoices_2026-08') as InvoiceEntry[];
    expect(aug).toHaveLength(1);
    expect(aug[0].reference).toBe('L-9');
    expect(aug[0].final).toBe(true);
  });

  it('MR mit abweichendem Betrag UND Datum matcht nicht (Fenster 0) — bucht frisch, kein Löschen', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-3', '2026-08-03', 30) }]);
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-4', '2026-08-05', 55) }], { quelle: 'monatsrechnung' });
    expect(res.neu).toBe(1);
    expect(res.ueberschrieben).toBe(0);
    expect((kv.get('supplier_invoices_2026-08') as InvoiceEntry[])).toHaveLength(2);
  });

  it('erneuter identischer Lieferschein (nicht final) = Upsert, nie Duplikat', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-5', '2026-08-03', 30) }]);
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-5', '2026-08-03', 31) }]);
    expect(res.ersetzt).toBe(1);
    const aug = kv.get('supplier_invoices_2026-08') as InvoiceEntry[];
    expect(aug.filter(e => e.reference === 'L-5')).toHaveLength(1);
  });
});
