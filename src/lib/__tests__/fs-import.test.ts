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
  kvSetStrict: vi.fn(async (key: string, value: unknown) => { kv.set(key, JSON.parse(JSON.stringify(value))); }),
  kvRemove: vi.fn(async (key: string) => { kv.delete(key); }),
}));

import { kernImportiereFsRechnungen } from '@/lib/fs-import';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { ParsedCsvRechnung, WarenPosition } from '@/lib/waren-positionen';
import { zaehlendeEintraege } from '@/lib/waren-monatsabgleich';

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
  it('Monatsrechnung: DIESELBE Lieferung doppelt im Batch bleibt EIN Eintrag (exakter Referenz-Upsert auch gegen frisch Erstelltes)', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('D-1', '2026-07-10', 5) },
      { r: rechnung('D-1', '2026-07-10', 5) },
    ], { quelle: 'monatsrechnung', erlaubteNeu: ['D-1|2026-07-10'] });
    expect(res.neu + res.ersetzt + res.ueberschrieben).toBeGreaterThan(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].reference).toBe('D-1');
    expect(monat[0].final).toBe(true);
  });

  it('Monatsrechnung: zwei Lieferungen am selben Tag mit gleichem Betrag werden BEIDE gebucht (kein «bereits final»-Selbstmatch im selben Lauf)', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('D-1', '2026-07-10', 5) },
      { r: rechnung('D-2', '2026-07-10', 5) },
    ], { quelle: 'monatsrechnung', erlaubteNeu: ['D-1|2026-07-10', 'D-2|2026-07-10'] });
    expect(res.neu).toBe(2);
    expect(res.bereitsFinal).toBe(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat.map(e => e.reference).sort()).toEqual(['D-1', 'D-2']);
    expect(monat.every(e => e.final === true)).toBe(true);
  });

  it('receiptPath: Import-Beleg wird verknüpft, Re-Import ersetzt ihn, manueller Beleg gewinnt', async () => {
    // 1) Erst-Import mit Import-Beleg
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('B-1', '2026-07-05'), receiptPath: 'oliv/import/feldschloesschen--b-1.pdf' },
    ]);
    let monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat[0].receiptPath).toBe('oliv/import/feldschloesschen--b-1.pdf');
    // 2) Re-Import mit neuem Import-Beleg → ersetzt (nicht dupliziert)
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('B-1', '2026-07-05'), receiptPath: 'oliv/import/feldschloesschen--b-1.v2.pdf' },
    ]);
    monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].receiptPath).toBe('oliv/import/feldschloesschen--b-1.v2.pdf');
    // 3) Manueller Beleg am Eintrag (Pfad ohne /import/) überlebt den Re-Import
    monat[0].receiptPath = 'oliv/inv-123.pdf';
    kv.set('supplier_invoices_2026-07', JSON.parse(JSON.stringify(monat)));
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('B-1', '2026-07-05'), receiptPath: 'oliv/import/feldschloesschen--b-1.v3.pdf' },
    ]);
    monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat[0].receiptPath).toBe('oliv/inv-123.pdf');
    // 4) Ohne neuen Beleg bleibt der bestehende erhalten
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('B-1', '2026-07-05') }]);
    monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat[0].receiptPath).toBe('oliv/inv-123.pdf');
  });

  it('bucht neu mit Lieferdatum und kennzeichnet quelle=monatsrechnung', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('L-1', '2026-07-30') }], { quelle: 'monatsrechnung' });
    expect(res.neu).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].quelle).toBe('monatsrechnung');
    expect(monat[0].date).toBe('2026-07-30');
  });

  it('erlaubteNeu (fail-closed): unbestätigte Frisch-Buchung wird übersprungen, bestätigte gebucht', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('N-1', '2026-07-10') },
      { r: rechnung('N-2', '2026-07-11') },
    ], { quelle: 'monatsrechnung', erlaubteNeu: ['n-1|2026-07-10'] });
    expect(res.neu).toBe(1);
    expect(res.neuUebersprungen).toBe(1);
    expect(res.hinweise.some(h => h.includes('N-2') && h.includes('NICHT gebucht'))).toBe(true);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat.map(e => e.reference)).toEqual(['N-1']);
  });

  it('erlaubteNeu: blosse Nummer ohne Datum bestätigt NICHT, leere LS-Nr nie', async () => {
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('N-1', '2026-07-10') },   // nur Nummer bestätigt → zu wenig
      { r: rechnung('', '2026-07-11') },      // leere Nr «bestätigt» → zählt nie
    ], { quelle: 'monatsrechnung', erlaubteNeu: ['n-1', '|2026-07-11'] });
    expect(res.neu).toBe(0);
    expect(res.neuUebersprungen).toBe(2);
  });

  it('erlaubteNeu blockiert nur Frisch-Buchungen — Bestands-Treffer werden weiterhin ersetzt', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('M-1', '2026-07-05') }]);
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT,
      [{ r: rechnung('M-1', '2026-07-05') }], { quelle: 'monatsrechnung', erlaubteNeu: [] });
    expect(res.neuUebersprungen).toBe(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(2);
    expect(zaehlendeEintraege(monat)).toHaveLength(1);
    expect(zaehlendeEintraege(monat)[0].final).toBe(true);
  });

  it('fsKategorien (Zusammenfassung MwSt.) übersteuern die Positions-Kontierung', async () => {
    const r = rechnung('L-Z1', '2026-07-10');
    // Netto der Rechnung: 300 — ZSF splittet auf Bier + Spirituosen
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{
      r,
      fsKategorien: [
        { name: 'Bier', netto81: 200, netto26: 0, netto00: 0, nettoTotal: 200 },
        { name: 'Spirituosen', netto81: 100, netto26: 0, netto00: 0, nettoTotal: 100 },
      ],
    }], { quelle: 'monatsrechnung' });
    expect(res.hinweise).toEqual([]);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    const m = Object.fromEntries((monat[0].kontoSplits ?? []).map(s => [s.warenkonto, s.amountNet]));
    expect(m).toEqual({ '4030': 200, '4040': 100 });
  });

  it('fsKategorien massgeblich, aber Positions-Netto weicht ab → Warnhinweis (Splits bleiben ZSF)', async () => {
    const r = rechnung('L-Z3', '2026-07-12'); // Positions-Netto 300
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{
      r,
      // Offizielles Netto (ZSF) = 280 → mit nettoOffiziell=280 greift die ZSF,
      // aber die Positionen (300) weichen ab → sichtbares Warnsignal.
      nettoOffiziell: 280,
      fsKategorien: [{ name: 'Bier', netto81: 280, netto26: 0, netto00: 0, nettoTotal: 280 }],
    }], { quelle: 'monatsrechnung' });
    expect(res.hinweise.some(h => /Positions-Netto .*weicht von der Zusammenfassung/.test(h))).toBe(true);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat[0].warenkonto ?? monat[0].kontoSplits?.[0]?.warenkonto).toBe('4030');
    expect(monat[0].amountNet).toBe(280); // offizieller ZSF-Betrag
  });

  it('fsKategorien mit abweichender Summe → sichtbarer Hinweis, Fallback auf Positionen', async () => {
    const r = rechnung('L-Z2', '2026-07-11'); // Netto 300, ganz Bier
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{
      r,
      fsKategorien: [{ name: 'Bier', netto81: 150, netto26: 0, netto00: 0, nettoTotal: 150 }],
    }], { quelle: 'monatsrechnung' });
    expect(res.hinweise.some(h => /deckt das Buchungs-Netto/.test(h))).toBe(true);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat[0].warenkonto ?? monat[0].kontoSplits?.[0]?.warenkonto).toBe('4030'); // aus Positionen
    expect(monat[0].amountNet).toBe(300);
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
    // Finaler Betrag zählt einmal; der ursprüngliche LS bleibt unverändert als Historie.
    const nach = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(nach).toHaveLength(2);
    expect(nach.find(e => e.id === prov.id)).toMatchObject({
      id: prov.id, amountNet: prov.amountNet, superseded: true,
    });
    const zaehlend = zaehlendeEintraege(nach);
    expect(zaehlend).toHaveLength(1);
    expect(zaehlend[0].final).toBe(true);
    expect(zaehlend[0].quelle).toBe('monatsrechnung');
    expect(zaehlend[0].amountNet).toBe(990);
  });

  it('vereinheitlicht WKQ AG und Fideco im produktiven Monatsrechnungs-Matching', async () => {
    await kernImportiereFsRechnungen(TENANT, 'WKQ AG', [{ r: rechnung('LS-F-1', '2026-07-12', 30) }]);
    const wkqLs = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];

    const res = await kernImportiereFsRechnungen(
      TENANT,
      'Fideco Schweiz',
      [{ r: rechnung('LS-F-1', '2026-07-12', 35) }],
      { quelle: 'monatsrechnung' },
    );

    expect(res.ueberschrieben).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat.find(e => e.id === wkqLs.id)).toMatchObject({
      supplierName: 'WKQ AG',
      amountNet: wkqLs.amountNet,
      superseded: true,
    });
    expect(zaehlendeEintraege(monat)).toHaveLength(1);
    expect(zaehlendeEintraege(monat)[0]).toMatchObject({
      supplierName: 'Fideco Schweiz',
      amountNet: 350,
      quelle: 'monatsrechnung',
      final: true,
    });
  });

  it('Monatsrechnung übernimmt das Lieferdatum je EINZELNER Lieferung — nie das Belegdatum', async () => {
    // provisorischer LS am 10.07.; Rechnung sagt: Lieferung war am 11.07.
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-50', '2026-07-10', 30) }]);
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{ r: rechnung('LS-50', '2026-07-11', 30) }], { quelle: 'monatsrechnung' });
    expect(res.ueberschrieben).toBe(1);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(2);
    expect(zaehlendeEintraege(monat)).toHaveLength(1);
    expect(zaehlendeEintraege(monat)[0].date).toBe('2026-07-11');
    expect(zaehlendeEintraege(monat)[0].final).toBe(true);
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
    expect(aug).toHaveLength(2);
    expect(zaehlendeEintraege(aug)).toHaveLength(1);
    expect(zaehlendeEintraege(aug)[0].reference).toBe('L-9');
    expect(zaehlendeEintraege(aug)[0].final).toBe(true);
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

describe('Matcher-Reihenfolge: exakte Referenz VOR Datum+Betrag (zwei Pässe)', () => {
  it('Monatsrechnung ersetzt den REFERENZ-Treffer, nicht den früheren Datum/Betrag-Kandidaten', async () => {
    // Zwei provisorische Lieferungen: gleicher Tag, gleicher Betrag, andere Referenzen
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('287001', '2026-07-10', 30) },
      { r: rechnung('287002', '2026-07-10', 30) },
    ]);
    const vorher = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    const e2 = vorher.find(e => e.reference === '287002')!;
    // Monatsrechnung nennt exakt 287002 — trotz identischem Datum/Betrag von 287001
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT,
      [{ r: rechnung('287002', '2026-07-10', 30) }], { quelle: 'monatsrechnung' });
    expect(res.ueberschrieben).toBe(1);
    const nach = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    const final = nach.find(e => e.final === true)!;
    expect(nach.find(e => e.id === e2.id)).toMatchObject({ superseded: true });
    expect(final.supersededById).toBeUndefined();
    expect(nach.find(e => e.reference === '287001')!.final).toBeUndefined();
  });
});

describe('AB→Rechnung ohne gemeinsame Referenz (Terravigna)', () => {
  it('ersetzt GENAU EINE provisorische AB im Fenster mit gelockerter Toleranz (1 %)', async () => {
    // AB provisorisch: brutto 324.30 (preis 30)
    await kernImportiereFsRechnungen(TENANT, LIEFERANT,
      [{ r: rechnung('AB-145095', '2026-07-28', 30) }], { quelle: 'auftragsbestaetigung' });
    // Rechnungs-Lieferung: andere Referenz, +2 Tage, Betrag weicht ~0.32 ab (>0.10, <1 %)
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT,
      [{ r: rechnung('287319', '2026-07-30', 30.03) }],
      { quelle: 'monatsrechnung', ersatzFensterTage: 3 });
    expect(res.ueberschrieben).toBe(1);
    const nach = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(nach).toHaveLength(2);
    expect(zaehlendeEintraege(nach)).toHaveLength(1);
    expect(zaehlendeEintraege(nach)[0].final).toBe(true);
  });

  it('bei MEHREREN AB-Kandidaten wird NIE geraten — Neu-Buchung, ABs bleiben', async () => {
    await kernImportiereFsRechnungen(TENANT, LIEFERANT, [
      { r: rechnung('AB-1', '2026-07-28', 30) },
      { r: rechnung('AB-2', '2026-07-28', 30) },
    ], { quelle: 'auftragsbestaetigung' });
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT,
      [{ r: rechnung('287400', '2026-07-30', 30.03) }],
      { quelle: 'monatsrechnung', ersatzFensterTage: 3 });
    expect(res.ueberschrieben).toBe(0);
    expect(res.neu).toBe(1);
    expect(kv.get('supplier_invoices_2026-07') as InvoiceEntry[]).toHaveLength(3);
  });
});

describe('Kreditoren-Übernahme finalisieren (Belegnummer-Match)', () => {
  const uebernahme = (over: Partial<InvoiceEntry> = {}): InvoiceEntry => ({
    id: 'kred_1', date: '2026-07-31', supplierName: 'Ambro Food AG',
    amountGross: 324.3, amountNet: 300, vatIncluded: true, vatRate: 8.1,
    reference: 'X-100', warenkonto: '4030', note: 'Kreditoren-Übernahme (provisorisch)',
    quelle: 'kreditoren_uebernahme', final: false,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    ...over,
  } as InvoiceEntry);

  it('Ambro-Szenario: Detail (gleiche Belegnr, echtes Lieferdatum) ERSETZT die Übernahme — EINE Rechnung, kein Duplikat', async () => {
    kv.set('supplier_invoices_2026-07', [uebernahme()]);
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('X-100', '2026-07-20', 30) }]);
    expect(res.kreditorenFinalisiert).toBe(1);
    expect(res.neu).toBe(0);
    expect(res.hinweise).toHaveLength(0); // Betrag identisch → kein Hinweis
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].id).toBe('kred_1');           // gleiche Rechnung, finalisiert
    expect(monat[0].date).toBe('2026-07-20');     // echtes Lieferdatum übernommen
    expect(monat[0].quelle).not.toBe('kreditoren_uebernahme');
  });

  it('Monatsrechnung finalisiert die Übernahme (final=true) — auch über die Monatsgrenze; Betragsabweichung > Toleranz gibt Hinweis', async () => {
    kv.set('supplier_invoices_2026-08', [uebernahme({ id: 'kred_2', date: '2026-08-31', amountGross: 999 })]);
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('X-100', '2026-07-20', 30) }], { quelle: 'monatsrechnung' });
    expect(res.kreditorenFinalisiert).toBe(1);
    expect(res.hinweise).toHaveLength(1); // 999 vs 324.30
    expect(kv.get('supplier_invoices_2026-08') as InvoiceEntry[]).toHaveLength(0); // Platzhalter weg
    const juli = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(juli).toHaveLength(1);
    expect(juli[0].final).toBe(true);
    expect(juli[0].amountGross).toBeCloseTo(324.3, 1); // Detail-Betrag massgeblich
  });

  it('Übernahme ohne Belegnummer: eindeutiger Betrag matcht, mehrdeutig wird NIE ersetzt (Hinweis)', async () => {
    kv.set('supplier_invoices_2026-07', [
      uebernahme({ id: 'kred_a', reference: undefined }),
      uebernahme({ id: 'kred_b', reference: undefined }),
    ]);
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('NEU-1', '2026-07-20', 30) }]);
    expect(res.kreditorenFinalisiert).toBe(0);
    expect(res.neu).toBe(1); // Neu-Buchung, Übernahmen bleiben zur Prüfung
    expect(res.hinweise.some(h => h.includes('manuell prüfen'))).toBe(true);
    expect(kv.get('supplier_invoices_2026-07') as InvoiceEntry[]).toHaveLength(3);
  });

  it('cross-Monat: FIBU-Match des Platzhalter-Monats wird mitbereinigt (keine «gematcht»-Leiche)', async () => {
    kv.set('supplier_invoices_2026-08', [uebernahme({ id: 'kred_3', date: '2026-08-31' })]);
    kv.set('waren_fibu_matches_2026-08_v1', {
      gruppen: [{ invoiceIds: ['kred_3'], buchungKeys: ['b1'] }],
      gesperrt: { invoiceIds: ['kred_3'], buchungKeys: [] },
    });
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('X-100', '2026-07-20', 30) }]);
    expect(res.kreditorenFinalisiert).toBe(1);
    const fibu = kv.get('waren_fibu_matches_2026-08_v1') as { gruppen: unknown[]; gesperrt: { invoiceIds: string[] } };
    expect(fibu.gruppen).toHaveLength(0);
    expect(fibu.gesperrt.invoiceIds).toHaveLength(0);
  });

  it('GLEICHES Datum: strikter Treffer auf den Platzhalter zählt als Finalisierung (nicht «ersetzt») und prüft den Betrag', async () => {
    kv.set('supplier_invoices_2026-07', [uebernahme({ id: 'kred_4', date: '2026-07-20', reference: 'X-100', amountGross: 999 })]);
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('X-100', '2026-07-20', 30) }]);
    expect(res.kreditorenFinalisiert).toBe(1);
    expect(res.ersetzt).toBe(0);
    expect(res.neu).toBe(0);
    expect(res.hinweise).toHaveLength(1); // 999 vs 324.30
    expect(kv.get('supplier_invoices_2026-07') as InvoiceEntry[]).toHaveLength(1);
  });

  it('Lieferschein eines Dual-Lieferanten mit EIGENER Nr. bleibt daneben stehen (keine Kaperung der Übernahme)', async () => {
    kv.set('supplier_invoices_2026-07', [uebernahme({ amountGross: 5000 })]);
    const res = await kernImportiereFsRechnungen(TENANT, 'Ambro Food AG',
      [{ r: rechnung('LS-77', '2026-07-20', 30) }]); // andere Ref, anderer Betrag
    expect(res.kreditorenFinalisiert).toBe(0);
    expect(res.neu).toBe(1);
    expect(kv.get('supplier_invoices_2026-07') as InvoiceEntry[]).toHaveLength(2);
  });
});

describe('finalDirekt (Lieferant ohne Monatsrechnung — Einzelrechnung bucht final)', () => {
  it('bucht sofort final (ohne quelle), Re-Import derselben Referenz upsertet idempotent', async () => {
    const res1 = await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('2144841', '2026-07-15') }],
      { finalDirekt: true, idPrefix: 'lpdf' });
    expect(res1.neu).toBe(1);
    let monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].final).toBe(true);
    expect(monat[0].quelle).toBeUndefined();

    // Re-Import: kein Doppel, kein «bereits final»-Skip — Upsert.
    const res2 = await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('2144841', '2026-07-15', 31) }],
      { finalDirekt: true, idPrefix: 'lpdf' });
    expect(res2.neu).toBe(0);
    expect(res2.ersetzt).toBe(1);
    expect(res2.bereitsFinal).toBe(0);
    monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    expect(monat[0].final).toBe(true);
    expect(monat[0].amountNet).toBe(310);
  });

  it('Re-Import mit korrigiertem Datum findet die finale Buchung per Referenz (Monate ±1)', async () => {
    await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('2144990', '2026-07-31') }],
      { finalDirekt: true });
    const res = await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('2144990', '2026-08-02') }],
      { finalDirekt: true });
    expect(res.neu).toBe(0);
    expect(res.ersetzt).toBe(1);
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[] | undefined) ?? []).toHaveLength(0);
    const aug = kv.get('supplier_invoices_2026-08') as InvoiceEntry[];
    expect(aug).toHaveLength(1);
    expect(aug[0].date).toBe('2026-08-02');
    expect(aug[0].final).toBe(true);
  });

  it('OHNE finalDirekt bleibt der «bereits final»-Schutz aktiv', async () => {
    await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('77', '2026-07-10') }],
      { finalDirekt: true });
    const res = await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('77', '2026-07-10') }]);
    expect(res.bereitsFinal).toBe(1);
    expect(res.ersetzt).toBe(0);
  });
});

describe('finalDirekt kapert KEINE fremden Finalbuchungen', () => {
  it('manuelle/MR-finale Buchung gleicher Referenz bleibt unangetastet (bereitsFinal)', async () => {
    // Fremde finale Buchung: anderer id-Präfix (z.B. manuell) bzw. Monatsrechnung.
    await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('555', '2026-07-05') }],
      { quelle: 'monatsrechnung', idPrefix: 'mr' });
    const vorher = (kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0];
    expect(vorher.final).toBe(true);

    const res = await kernImportiereFsRechnungen(TENANT, 'Caporaso', [{ r: rechnung('555', '2026-07-05', 99) }],
      { finalDirekt: true, idPrefix: 'lpdf' });
    expect(res.bereitsFinal).toBe(1);
    expect(res.ersetzt).toBe(0);
    const nachher = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(nachher).toHaveLength(1);
    expect(nachher[0].amountNet).toBe(vorher.amountNet);
  });
});

describe('Sammelrechnung finalisiert NUR die in ihr gelisteten Lieferscheine', () => {
  it('Spahni-Szenario: MR vom 15. finalisiert LS 1+2, LS 3+4 bleiben provisorisch bis zur Monatsend-MR', async () => {
    // Vier provisorische Lieferscheine über den Monat.
    await kernImportiereFsRechnungen(TENANT, 'Spahni', [
      { r: rechnung('S1', '2026-07-05') },
      { r: rechnung('S2', '2026-07-12') },
      { r: rechnung('S3', '2026-07-20') },
      { r: rechnung('S4', '2026-07-28') },
    ], { idPrefix: 'lpdf' });

    // MR vom 15.: listet NUR S1+S2 (Lieferungen = LS-Nrn aus der Rechnung).
    const mr1 = await kernImportiereFsRechnungen(TENANT, 'Spahni', [
      { r: rechnung('S1', '2026-07-05') },
      { r: rechnung('S2', '2026-07-12') },
    ], { quelle: 'monatsrechnung', idPrefix: 'lpdf' });
    expect(mr1.ueberschrieben).toBe(2);
    expect(mr1.neu).toBe(0);

    let monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    const byRef = (ref: string) => zaehlendeEintraege(monat).find(e => e.reference === ref)!;
    expect(byRef('S1').final).toBe(true);
    expect(byRef('S2').final).toBe(true);
    expect(byRef('S3').final).toBeUndefined(); // NICHT von MR1 finalisiert
    expect(byRef('S4').final).toBeUndefined();
    expect(monat).toHaveLength(6); // 4 Lieferscheine historisch + 2 zählende MR-Lieferungen
    expect(zaehlendeEintraege(monat)).toHaveLength(4);

    // Monatsend-MR: listet S3+S4 → finalisiert genau diese.
    const mr2 = await kernImportiereFsRechnungen(TENANT, 'Spahni', [
      { r: rechnung('S3', '2026-07-20') },
      { r: rechnung('S4', '2026-07-28') },
    ], { quelle: 'monatsrechnung', idPrefix: 'lpdf' });
    expect(mr2.ueberschrieben).toBe(2);
    monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(8);
    expect(zaehlendeEintraege(monat)).toHaveLength(4);
    expect(zaehlendeEintraege(monat).every(e => e.final === true)).toBe(true);
  });

  it('Datum+Betrag-Fallback greift nur bei Fenster (Default 0 = exaktes LS-Datum), fremde Tage bleiben stehen', async () => {
    await kernImportiereFsRechnungen(TENANT, 'Spahni', [{ r: rechnung('X9', '2026-07-10') }], { idPrefix: 'lpdf' });
    // MR-Lieferung OHNE gemeinsame Nr, anderes Datum, gleicher Betrag → KEIN Match, bucht neu.
    const res = await kernImportiereFsRechnungen(TENANT, 'Spahni', [{ r: rechnung('L-777', '2026-07-11') }],
      { quelle: 'monatsrechnung', idPrefix: 'lpdf' });
    expect(res.neu).toBe(1);
    expect(res.ueberschrieben).toBe(0);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(2);
    expect(monat.find(e => e.reference === 'X9')!.final).toBeUndefined();
  });
});

// ── Regression 08/2026: FS-Einzelrechnung 87750197 (Positions-Netto ≠ ZSF) ──
describe('FS-Einzelrechnung mit Mietmaterial-Ermässigung (Netto-Abweichung 750)', () => {
  it('bucht nach ZSF (massgeblich) — Abweichung ist NUR Hinweis, nie Blocker', async () => {
    // Positions-Netto 4413.02, ZSF-Netto 5163.02 (Ermässigung fehlt in den
    // Positionen), Endbetrag CHF 5475.45 — der Split entspricht der Vorschau.
    const p = pos(30);
    const r: ParsedCsvRechnung = {
      docKey: '87750197|2026-07-01', rechnungsNr: '87750197', datum: '2026-07-01',
      markt: 'Feldschlösschen', positionen: [p],
      nettoTotal: 4413.02, mwstTotal: 357.43, bruttoTotal: 4770.45,
    };
    const fsKategorien = [
      { name: 'Bier',        netto81: 2100,    netto26: 0, netto00: 0, nettoTotal: 2100 },
      { name: 'Spirituosen', netto81: 1031.94, netto26: 0, netto00: 0, nettoTotal: 1031.94 },
      { name: 'Mineralwasser', netto81: 1090.08, netto26: 0, netto00: 0, nettoTotal: 1090.08 },
      { name: 'Mietmaterial', netto81: 375,     netto26: 0, netto00: 0, nettoTotal: 375 },
      { name: 'Leergut',     netto81: 0,       netto26: 0, netto00: 566, nettoTotal: 566 },
    ];
    const res = await kernImportiereFsRechnungen(TENANT, LIEFERANT, [{
      r, fsKategorien, nettoOffiziell: 5163.02, bruttoOffiziell: 5475.45,
    }], { quelle: 'monatsrechnung' });
    expect(res.neu).toBe(1);
    // Abweichung ist sichtbar (Hinweis), blockiert aber NICHT.
    expect(res.hinweise.some(h => /4413\.02.*weicht.*5163\.02/.test(h))).toBe(true);
    const monat = kv.get('supplier_invoices_2026-07') as InvoiceEntry[];
    expect(monat).toHaveLength(1);
    const e = monat[0];
    expect(e.amountNet).toBe(5163.02);
    expect(e.amountGross).toBe(5475.45);
    expect(e.final).toBe(true);
    const splitOf = (k: string) => e.kontoSplits?.find(s => s.warenkonto === k)?.amountNet;
    expect(splitOf('4030')).toBe(2100);
    expect(splitOf('4040')).toBe(1031.94);
    expect(splitOf('4050')).toBe(1090.08);
    expect(splitOf('4701')).toBe(375);
    expect(splitOf('4800')).toBe(566);
  });
});
