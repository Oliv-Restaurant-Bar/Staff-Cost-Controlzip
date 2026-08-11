// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isoWeekKeyOf, weekLabelOf, groupTotals, flagAnomalies, topInvoices,
  wochenWkq, analyseKpis, direkterWarenaufwand, buildDirektKontoVergleich, nurDirektAnteil, buildKontoDrilldown,
  buildKorrekturVorschlaege, buildMwstBuendelungBefunde, fmtChfText,
} from '@/lib/waren-analyse';
import { buildWarenkostenExport, warenkostenExportFileName } from '@/lib/warenkosten-export';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';

let seq = 0;
function inv(partial: Partial<InvoiceEntry> & { date: string; amountNet: number }): InvoiceEntry {
  return {
    id: `e${++seq}`, supplierName: 'Prodega', amountGross: partial.amountNet * 1.026,
    vatIncluded: true, vatRate: 2.6, createdAt: '', updatedAt: '',
    ...partial,
  } as InvoiceEntry;
}

describe('isoWeekKeyOf', () => {
  it('ISO-Wochenjahr über Jahresgrenzen', () => {
    expect(isoWeekKeyOf('2026-01-01')).toBe('2026-W01'); // Do
    expect(isoWeekKeyOf('2025-12-29')).toBe('2026-W01'); // Mo derselben Woche
    expect(isoWeekKeyOf('2026-07-27')).toBe('2026-W31');
    expect(weekLabelOf('2026-W05')).toBe('KW 5');
  });
});

describe('groupTotals', () => {
  const list = [
    inv({ date: '2026-07-01', amountNet: 100, supplierName: 'A', warenkonto: '4000' }),
    inv({ date: '2026-07-02', amountNet: 300, supplierName: 'B', warenkonto: '4020' }),
    inv({ date: '2026-07-03', amountNet: 50, supplierName: 'A', kontoSplits: [
      { warenkonto: '4000', amountNet: 30, amountGross: 31 },
      { warenkonto: '4020', amountNet: 20, amountGross: 21 },
    ] }),
  ];
  it('Lieferant: Top-Betrag zuerst', () => {
    const rows = groupTotals(list, 'supplier');
    expect(rows.map(r => r.key)).toEqual(['B', 'A']);
    expect(rows[1].totalNet).toBe(150);
  });
  it('Konto: Splits zählen pro Konto', () => {
    const rows = groupTotals(list, 'konto', [{ value: '4000', label: '4000 – LM' }]);
    const k4000 = rows.find(r => r.key === '4000')!;
    expect(k4000.totalNet).toBe(130);
    expect(k4000.label).toBe('4000 – LM');
    expect(rows.find(r => r.key === '4020')!.totalNet).toBe(320);
  });
  it('Woche/Monat chronologisch', () => {
    const rows = groupTotals([
      inv({ date: '2026-07-13', amountNet: 10 }), inv({ date: '2026-07-06', amountNet: 5 }),
    ], 'week');
    expect(rows.map(r => r.key)).toEqual(['2026-W28', '2026-W29']);
  });
});

describe('flagAnomalies', () => {
  it('Lieferant: letzte Woche > +30% vs. Schnitt der Vorwochen → rot', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 100, supplierName: 'A' }), // W28
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'A' }), // W29
      inv({ date: '2026-07-20', amountNet: 200, supplierName: 'A' }), // W30 → 2x Schnitt
      inv({ date: '2026-07-06', amountNet: 100, supplierName: 'B' }),
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'B' }),
      inv({ date: '2026-07-20', amountNet: 110, supplierName: 'B' }), // +10% → ok
    ];
    const rows = flagAnomalies(groupTotals(list, 'supplier'), list, 'supplier');
    expect(rows.find(r => r.key === 'A')!.flagged).toBe(true);
    expect(rows.find(r => r.key === 'A')!.deltaPct).toBe(100); // 200 vs. Schnitt 100
    expect(rows.find(r => r.key === 'B')!.flagged).toBe(false);
    expect(rows.find(r => r.key === 'B')!.deltaPct).toBe(10);
  });
  it('zu wenig Vorwochen → keine Markierung', () => {
    const list = [
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'A' }),
      inv({ date: '2026-07-20', amountNet: 500, supplierName: 'A' }),
    ];
    const rows = flagAnomalies(groupTotals(list, 'supplier'), list, 'supplier');
    expect(rows[0].flagged).toBe(false);
  });
  it('Woche: Ausreisser-Woche wird markiert', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 100 }),
      inv({ date: '2026-07-13', amountNet: 100 }),
      inv({ date: '2026-07-20', amountNet: 400 }),
    ];
    const rows = flagAnomalies(groupTotals(list, 'week'), list, 'week');
    const w30 = rows.find(r => r.key === '2026-W30')!;
    expect(w30.flagged).toBe(true);
    expect(w30.deltaPct).toBe(300); // 400 vs. Schnitt 100
    expect(rows.find(r => r.key === '2026-W28')!.flagged).toBe(false);
  });
});

describe('wochenWkq & topInvoices & analyseKpis', () => {
  it('WKQ je Woche mit Ampel, Wochen ohne Umsatz → null', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 350, warenkonto: '4060' }), // W28
      inv({ date: '2026-07-13', amountNet: 200, warenkonto: '4060' }), // W29
    ];
    const rev = { '2026-07-06': 500, '2026-07-07': 500 }; // nur W28: 1000
    const rows = wochenWkq(list, rev, 30);
    expect(rows[0]).toMatchObject({ weekKey: '2026-W28', wkqPct: 35, ampel: 'red' });
    expect(rows[1]).toMatchObject({ weekKey: '2026-W29', wkqPct: null, ampel: null });
  });
  it('topInvoices sortiert absteigend', () => {
    const list = [inv({ date: '2026-07-01', amountNet: 10 }), inv({ date: '2026-07-02', amountNet: 99 })];
    expect(topInvoices(list, 1)[0].amountNet).toBe(99);
  });
  it('analyseKpis: Anteile + Top-3', () => {
    const k = analyseKpis([
      inv({ date: '2026-07-01', amountNet: 60, warenkonto: '4060', supplierName: 'A' }),
      inv({ date: '2026-07-01', amountNet: 40, warenkonto: '4030', supplierName: 'B' }),
    ]);
    expect(k.totalNet).toBe(100);
    expect(k.foodSharePct).toBe(60);
    expect(k.top3.map(t => t.label)).toEqual(['A', 'B']);
    expect(analyseKpis([]).foodSharePct).toBeNull();
  });
});

describe('Export: Summenblöcke & Dateiname', () => {
  it('Dateiname Warenkosten_<Mandant>_<yyyy-MM>.xlsx', () => {
    expect(warenkostenExportFileName('2026-07-01', '2026-07-31', 'Oliv')).toBe('Warenkosten_Oliv_2026-07.xlsx');
    expect(warenkostenExportFileName('2026-06-01', '2026-07-31', 'Le Beaulieu')).toBe('Warenkosten_LeBeaulieu_2026-06-01_bis_2026-07-31.xlsx');
  });
  it('bySupplier/byKonto/byWeek korrekt aggregiert', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026', from: '2026-07-01', to: '2026-07-31', tenantName: 'Oliv',
      revenue: 1000,
      invoices: [
        { id: 'x1', date: '2026-07-06', supplierName: 'A', amountNet: 100, amountGross: 102.6, warenkonto: '4000', kategorie: 'Food' },
        { id: 'x2', date: '2026-07-06', supplierName: 'B', amountNet: 300, amountGross: 307.8, warenkonto: '4020', kategorie: 'Beverage' },
        { id: 'x3', date: '2026-07-13', supplierName: 'A', amountNet: 50, amountGross: 51.3, warenkonto: '4000', kategorie: 'Food' },
      ],
    });
    expect(data.bySupplier.map(r => r.label)).toEqual(['B', 'A']);
    expect(data.bySupplier[1]).toMatchObject({ totalNet: 150, count: 2 });
    expect(data.byKonto.find(r => r.label === '4000')!.totalNet).toBe(150);
    expect(data.byWeek.map(r => r.label)).toEqual(['KW 28', 'KW 29']);
    expect(data.fileName).toBe('Warenkosten_Oliv_2026-07.xlsx');
  });
});

describe('wochenWkq: split-bewusste WKQ-Basis (A1)', () => {
  it('Betriebskosten-Konto fliesst NICHT in die Wochen-WKQ, Warenkonto schon', () => {
    const list = [
      inv({ date: '2026-07-27', amountNet: 100, warenkonto: '4020' }),
      inv({ date: '2026-07-27', amountNet: 50, warenkonto: '4500' }), // Betrieb
      inv({ date: '2026-07-28', amountNet: 30, warenkonto: 'Depot' }), // neutral
    ];
    const rows = wochenWkq(list, { '2026-07-27': 500, '2026-07-28': 500 }, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0].warenNet).toBeCloseTo(100, 2);
    expect(rows[0].wkqPct).toBeCloseTo(10, 2);
  });
});

describe('analyseKpis: direkter Warenaufwand (Befehl 08/2026)', () => {
  it('Hauptzahl = NUR Konten 4020–4070; übrige Konten & unkontiert separat', () => {
    const list = [
      inv({ date: '2026-07-01', amountNet: 100, warenkonto: '4000' }), // NICHT direkt → übrig
      inv({ date: '2026-07-01', amountNet: 40, warenkonto: '4030' }), // Bier → direkt/Beverage
      inv({ date: '2026-07-01', amountNet: 60, warenkonto: '4060' }), // Küche → direkt/Food
      inv({ date: '2026-07-02', amountNet: 25, warenkonto: '4500' }), // Betrieb → übrig
      inv({ date: '2026-07-03', amountNet: 10 }), // unkontiert → NICHT in Hauptzahl
    ];
    const k = analyseKpis(list);
    expect(k.totalNet).toBeCloseTo(100, 2);
    expect(k.relevantNet).toBeCloseTo(100, 2);
    expect(k.foodNet).toBeCloseTo(60, 2);
    expect(k.beverageNet).toBeCloseTo(40, 2);
    expect(k.uebrigNet).toBeCloseTo(125, 2);
    expect(k.unkontiertNet).toBeCloseTo(10, 2);
    expect(k.unkontiert).toBe(1);
    expect(k.foodSharePct).toBe(60);
  });
});

describe('direkterWarenaufwand & buildDirektKontoVergleich', () => {
  const list = [
    inv({ date: '2026-07-01', amountNet: 200, warenkonto: '4020' }),
    inv({ date: '2026-07-02', amountNet: 80, kontoSplits: [
      { warenkonto: '4060', amountNet: 50, amountGross: 51 },
      { warenkonto: '4090', amountNet: 20, amountGross: 21 },
      { warenkonto: 'Depot', amountNet: 10, amountGross: 10 },
    ] }),
    inv({ date: '2026-07-03', amountNet: 30, warenkonto: '40200' }), // 5-stellig → 4020
  ];
  it('Splits pro Konto, Depot neutral, 5-stellige Konten normalisiert', () => {
    const d = direkterWarenaufwand(list);
    expect(d.jeKonto['4020']).toBeCloseTo(230, 2);
    expect(d.jeKonto['4060']).toBeCloseTo(50, 2);
    expect(d.direktNet).toBeCloseTo(280, 2);
    expect(d.uebrigNet).toBeCloseTo(20, 2); // 4090
    expect(d.unkontiertNet).toBeCloseTo(0, 2); // Depot neutral
  });
  it('Gegenüberstellung: Differenz = ER − erfasst, fehlendes ER-Konto = 0', () => {
    const v = buildDirektKontoVergleich(list, { '4020': 250, '4060': 50 }, { '4020': '4020 Wein' });
    const z4020 = v.zeilen.find(z => z.konto === '4020')!;
    expect(z4020.label).toBe('4020 Wein');
    expect(z4020.erfasst).toBeCloseTo(230, 2);
    expect(z4020.diff).toBeCloseTo(20, 2);
    expect(v.zeilen.find(z => z.konto === '4030')!.er).toBe(0);
    expect(v.totalErfasst).toBeCloseTo(280, 2);
    expect(v.totalEr).toBeCloseTo(300, 2);
    expect(v.totalDiff).toBeCloseTo(20, 2);
    expect(v.zeilen).toHaveLength(6);
  });
  it('nurDirektAnteil: Splits anteilig reduziert, Nicht-Direktes entfernt', () => {
    const p = nurDirektAnteil(list.concat(inv({ date: '2026-07-04', amountNet: 99, warenkonto: '4090' })));
    expect(p).toHaveLength(3); // 4090-Rechnung raus
    const split = p.find(e => e.kontoSplits)!;
    expect(split.amountNet).toBeCloseTo(50, 2); // nur 4060-Anteil, 4090/Depot raus
    expect(split.kontoSplits).toHaveLength(1);
  });
  it('ohne ER-Daten: er/diff null (nie stille 0)', () => {
    const v = buildDirektKontoVergleich(list, null);
    expect(v.zeilen.every(z => z.er === null && z.diff === null)).toBe(true);
    expect(v.totalEr).toBeNull();
    expect(v.totalDiff).toBeNull();
  });
});

describe('buildKontoDrilldown', () => {
  const jl = (accountNumber: string, text: string, soll: number): SageJournalEntry => ({
    date: '01.07.2026', text, accountNumber, accountName: '', soll, haben: 0, betrag: soll,
  } as unknown as SageJournalEntry);
  const entries = [
    // Feldschlösschen: App splittet 4030/4050
    inv({ date: '2026-07-01', amountNet: 900, supplierName: 'Feldschlösschen', kontoSplits: [
      { warenkonto: '4030', amountNet: 600, amountGross: 620 },
      { warenkonto: '4050', amountNet: 300, amountGross: 310 },
    ] }),
    inv({ date: '2026-07-02', amountNet: 200, supplierName: 'Brauerei X', warenkonto: '4030' }),
  ];
  const journal = [
    jl('4030', 'Feldschlösschen Getränke AG', 900), // FIBU alles auf 4030
    jl('4030', 'Brauerei X', 200),
    jl('4030', 'Unbekannter Text ohne Lieferant', 50),
  ];
  const input = {
    entries, journal, konto: '4030',
    supplierNames: ['Feldschlösschen', 'Brauerei X'],
    aliases: {},
  };
  it('je Lieferant App vs. FIBU auf dem Konto, Split-Hinweis bei Zuordnungs-Differenz', () => {
    const d = buildKontoDrilldown(input);
    expect(d.hatJournal).toBe(true);
    const fs = d.zeilen.find(z => z.lieferant === 'Feldschlösschen')!;
    expect(fs.app).toBeCloseTo(600, 2);
    expect(fs.fibu).toBeCloseTo(900, 2);
    expect(fs.diff).toBeCloseTo(300, 2);
    // Total über alle direkten Konten gleich (900=900) → reiner Konto-Split
    expect(fs.splitHinweis).not.toBeNull();
    expect(fs.splitHinweis!.totalDiff).toBeCloseTo(0, 2);
    expect(fs.splitHinweis!.reineZuordnung).toBe(true);
    expect(fs.splitHinweis!.appJeKonto).toEqual({ '4030': 600, '4050': 300 });
    expect(fs.splitHinweis!.fibuJeKonto).toEqual({ '4030': 900 });
    const bx = d.zeilen.find(z => z.lieferant === 'Brauerei X')!;
    expect(bx.diff).toBeCloseTo(0, 2);
    expect(bx.splitHinweis).toBeNull();
    expect(d.nichtZugeordnet).toBeCloseTo(50, 2);
    expect(d.fibuTotal).toBeCloseTo(1150, 2);
    expect(d.diffTotal).toBeCloseTo(350, 2);
  });
  it('teilweiser Ausgleich → Split-Hinweis mit reineZuordnung=false und Restbetrag', () => {
    // FIBU 4030=1000, App 4030=600 + 4050=300 → Konto-Diff +400, Rest +100 echt
    const d = buildKontoDrilldown({ ...input, journal: [jl('4030', 'Feldschlösschen Getränke AG', 1000)], entries: [entries[0]] });
    const fs = d.zeilen.find(z => z.lieferant === 'Feldschlösschen')!;
    expect(fs.diff).toBeCloseTo(400, 2);
    expect(fs.splitHinweis).not.toBeNull();
    expect(fs.splitHinweis!.reineZuordnung).toBe(false);
    expect(fs.splitHinweis!.totalDiff).toBeCloseTo(100, 2);
  });
  it('echter Fehlbetrag (Total weicht ab) → KEIN Split-Hinweis', () => {
    const d = buildKontoDrilldown({ ...input, journal: [jl('4030', 'Brauerei X', 500)], entries: [entries[1]] });
    const bx = d.zeilen.find(z => z.lieferant === 'Brauerei X')!;
    expect(bx.diff).toBeCloseTo(300, 2);
    expect(bx.splitHinweis).toBeNull();
  });
  it('ohne Journal degradiert: fibu/diff null, nur App-Seite', () => {
    const d = buildKontoDrilldown({ ...input, journal: null });
    expect(d.hatJournal).toBe(false);
    expect(d.fibuTotal).toBeNull();
    expect(d.nichtZugeordnet).toBeNull();
    const fs = d.zeilen.find(z => z.lieferant === 'Feldschlösschen')!;
    expect(fs.fibu).toBeNull();
    expect(fs.diff).toBeNull();
    expect(fs.splitHinweis).toBeNull();
    expect(fs.typ).toBeNull();
  });
  it('typ-Klassifikation: ok / zuordnung / fehlende_rechnung', () => {
    const d = buildKontoDrilldown(input);
    expect(d.zeilen.find(z => z.lieferant === 'Brauerei X')!.typ).toBe('ok');
    expect(d.zeilen.find(z => z.lieferant === 'Feldschlösschen')!.typ).toBe('zuordnung');
    const d2 = buildKontoDrilldown({ ...input, journal: [jl('4030', 'Brauerei X', 500)], entries: [entries[1]] });
    expect(d2.zeilen.find(z => z.lieferant === 'Brauerei X')!.typ).toBe('fehlende_rechnung');
  });
  it('unklar: App erfasst, FIBU (noch) nicht gebucht → diff negativ', () => {
    const d = buildKontoDrilldown({ ...input, journal: [jl('4030', 'Irgendwas anderes', 10)], entries: [entries[1]] });
    const bx = d.zeilen.find(z => z.lieferant === 'Brauerei X')!;
    expect(bx.diff).toBeCloseTo(-200, 2);
    expect(bx.typ).toBe('unklar');
  });
});

describe('Kontierungs-Check & Korrektur-Vorschläge', () => {
  const jl = (accountNumber: string, text: string, soll: number): SageJournalEntry => ({
    date: '01.07.2026', text, accountNumber, accountName: '', soll, haben: 0, betrag: soll,
  } as unknown as SageJournalEntry);
  // Transgourmet-Fall (Juli Oliv): App 4060 31'440.94 + 4701 3'856.64;
  // FIBU 4060 33'293.33 (Non-Food ~1'852.39 falsch auf 4060), FIBU 4701 = Rest.
  const entries = [
    inv({ date: '2026-07-03', amountNet: 35297.58, supplierName: 'Transgourmet', kontoSplits: [
      { warenkonto: '4060', amountNet: 31440.94, amountGross: 0 },
      { warenkonto: '4701', amountNet: 3856.64, amountGross: 0 },
    ] }),
    inv({ date: '2026-07-04', amountNet: 8568.39, supplierName: 'Ambro', warenkonto: '4060' }),
  ];
  const journal = [
    jl('4060', 'Transgourmet Schweiz AG', 33293.33),
    jl('4701', 'Transgourmet Schweiz AG', 2004.25),
    jl('4060', 'Ambro', 8568.39),
  ];
  const base = { entries, journal, supplierNames: ['Transgourmet', 'Ambro'], aliases: {} };
  it('erkennt Non-Food fälschlich auf Warenkonto (typ=kontierung, Betrag ≈ 1852.39)', () => {
    const d = buildKontoDrilldown({ ...base, konto: '4060' });
    const tg = d.zeilen.find(z => z.lieferant === 'Transgourmet')!;
    expect(tg.diff).toBeCloseTo(1852.39, 2);
    expect(tg.typ).toBe('kontierung');
    expect(tg.kontierungsHinweis).not.toBeNull();
    expect(tg.kontierungsHinweis!.betrag).toBeCloseTo(1852.39, 2);
    expect(tg.kontierungsHinweis!.vonKonto).toBe('4060');
    expect(tg.kontierungsHinweis!.nachKonto).toBe('4701');
    expect(d.zeilen.find(z => z.lieferant === 'Ambro')!.typ).toBe('ok');
  });
  it('KEIN Kontierungs-Verdacht, wenn FIBU das Non-Food voll gebucht hat', () => {
    const d = buildKontoDrilldown({
      ...base, konto: '4060',
      journal: [jl('4060', 'Transgourmet Schweiz AG', 33293.33), jl('4701', 'Transgourmet Schweiz AG', 3856.64)],
    });
    const tg = d.zeilen.find(z => z.lieferant === 'Transgourmet')!;
    expect(tg.kontierungsHinweis).toBeNull();
    expect(tg.typ).toBe('fehlende_rechnung');
  });
  it('buildKorrekturVorschlaege: kopierbarer Umbuchungs-Text, Kontierung zuerst', () => {
    const v = buildKorrekturVorschlaege({ ...base, kontoNamen: { '4060': '4060 Küche', '4701': '4701 Betriebsmaterial' } });
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].typ).toBe('kontierung');
    expect(v[0].text).toBe("Umbuchung Transgourmet: CHF 1'852.39 von 4060 Küche -> 4701 Betriebsmaterial");
  });
  it('Defizit wird nur EINMAL zugeteilt: zwei positive Konto-Diffs, Vorschläge ≤ Defizit', () => {
    // App: 4060 900 + 4070 900 + 4701 100 (Non-Food); FIBU: 4060 1000, 4070 1000, kein 4701.
    // Non-Food-Defizit = 100, aber Diffs +100 auf ZWEI Konten → nur eine Zuteilung.
    const e = [inv({ date: '2026-07-03', amountNet: 1900, supplierName: 'Transgourmet', kontoSplits: [
      { warenkonto: '4060', amountNet: 900, amountGross: 0 },
      { warenkonto: '4070', amountNet: 900, amountGross: 0 },
      { warenkonto: '4701', amountNet: 100, amountGross: 0 },
    ] })];
    const j = [jl('4060', 'Transgourmet Schweiz AG', 1000), jl('4070', 'Transgourmet Schweiz AG', 1000)];
    const v = buildKorrekturVorschlaege({ entries: e, journal: j, supplierNames: ['Transgourmet'], aliases: {} });
    const kont = v.filter(x => x.typ === 'kontierung');
    expect(kont.reduce((s, x) => s + x.betrag, 0)).toBeCloseTo(100, 2);
    // Das andere Konto bleibt als fehlende Rechnung ausgewiesen.
    expect(v.some(x => x.typ === 'fehlende_rechnung' && Math.abs(x.betrag - 100) < 0.01)).toBe(true);
  });
  it('nachKonto = Konto mit dem Non-Food-DEFIZIT, nicht grösster App-Betrag', () => {
    // App: 4090 500 (in FIBU voll gebucht) + 4701 200 (in FIBU fehlend) + 4060 800; FIBU 4060 1000.
    const e = [inv({ date: '2026-07-03', amountNet: 1500, supplierName: 'Transgourmet', kontoSplits: [
      { warenkonto: '4060', amountNet: 800, amountGross: 0 },
      { warenkonto: '4090', amountNet: 500, amountGross: 0 },
      { warenkonto: '4701', amountNet: 200, amountGross: 0 },
    ] })];
    const j = [jl('4060', 'Transgourmet Schweiz AG', 1000), jl('4090', 'Transgourmet Schweiz AG', 500)];
    const d = buildKontoDrilldown({ entries: e, journal: j, konto: '4060', supplierNames: ['Transgourmet'], aliases: {} });
    const tg = d.zeilen.find(z => z.lieferant === 'Transgourmet')!;
    expect(tg.typ).toBe('kontierung');
    expect(tg.kontierungsHinweis!.nachKonto).toBe('4701');
    expect(tg.kontierungsHinweis!.betrag).toBeCloseTo(200, 2);
  });
  it('buildKorrekturVorschlaege: leer ohne Journal', () => {
    expect(buildKorrekturVorschlaege({ ...base, journal: null })).toEqual([]);
  });
  it('fmtChfText: de-CH-Apostroph-Format', () => {
    expect(fmtChfText(1852.39)).toBe("1'852.39");
  });
});

// ─── Cross-Konto-Check: MwSt-Satz-Bündelung (Feldschlösschen Juli 2026, Oliv) ─
// TESTFESTE WERTE aus dem Build-Befehl — als Regressionstest fest verankert.

describe('buildMwstBuendelungBefunde — MwSt-Satz-Bündelung (Feldschlösschen 07/2026)', () => {
  const je = (accountNumber: string, text: string, soll: number, haben = 0, belegNr?: string): SageJournalEntry => ({
    date: '01.07.2026', text, accountNumber, accountName: '', soll, haben,
    amount: Math.abs(soll - haben), ...(belegNr ? { belegNr } : {}),
  } as unknown as SageJournalEntry);

  // App-Split (netto, Wahrheit): 4030 4'538.00 · 4040 2'789.30 · 4050 7'736.85 · 4701 465.00
  const entries = [
    inv({ date: '2026-07-05', amountNet: 15529.15, supplierName: 'Feldschlösschen', kontoSplits: [
      { warenkonto: '4030', amountNet: 4538.00, amountGross: 0 },
      { warenkonto: '4040', amountNet: 2789.30, amountGross: 0 },
      { warenkonto: '4050', amountNet: 7736.85, amountGross: 0 },
      { warenkonto: '4701', amountNet: 465.00, amountGross: 0 },
    ] }),
    inv({ date: '2026-07-06', amountNet: 769.50, supplierName: 'Paul Ullrich', warenkonto: '4040' }),
  ];
  // FIBU: Treuhänder bündelt nach MwSt-Satz auf 4030 (brutto 15'529.15 Soll),
  // dazu Doppelzahlungs-Gutschrift Beleg 1068 −2'075.75 → Netto 4030 = 13'453.40.
  // 4040: FS-Anteil 596.68 + Paul Ullrich 769.50 (Total 1'366.18). 4050/4701: 0.
  const journal = [
    je('4030', 'Feldschlösschen Getränke AG Sammelr. 8.1%', 10726.85),
    je('4030', 'Feldschlösschen Getränke AG Sammelr. 2.6%', 4802.30),
    je('4030', 'Feldschlösschen Getränke AG Gutschrift Doppelzahlung', 0, 2075.75, '1068'),
    je('4040', 'Feldschlösschen Getränke AG', 596.68),
    je('4040', 'Paul Ullrich AG', 769.50),
  ];
  const base = { entries, journal, supplierNames: ['Feldschlösschen', 'Paul Ullrich'], aliases: {} };

  it('EIN Befund für Feldschlösschen mit dem erwarteten Umbuchungs-Vorschlag', () => {
    const befunde = buildMwstBuendelungBefunde(base);
    expect(befunde).toHaveLength(1);
    const b = befunde[0];
    expect(b.lieferant).toBe('Feldschlösschen');
    expect(b.ueberschussKonto).toBe('4030');
    const um = Object.fromEntries(b.umbuchungen.map(u => [u.konto, u.delta]));
    expect(um['4030']).toBeCloseTo(-8915.40, 2);
    expect(um['4040']).toBeCloseTo(2192.62, 2);
    expect(um['4050']).toBeCloseTo(7736.85, 2);
    expect(um['4701']).toBeCloseTo(465.00, 2);
    // Überschusskonto zuerst im Vorschlag
    expect(b.umbuchungen[0].konto).toBe('4030');
  });

  it('Unerklärte Restdifferenz separat: Gutschrift Beleg 1068 −2\'075.75 auf 4030 — NICHT im Vorschlag', () => {
    const b = buildMwstBuendelungBefunde(base)[0];
    expect(b.restdifferenzen).toHaveLength(1);
    expect(b.restdifferenzen[0]).toMatchObject({ konto: '4030', belegNr: '1068' });
    expect(b.restdifferenzen[0].betrag).toBeCloseTo(-2075.75, 2);
    // Kopiertext enthält NUR die Umbuchungen, keine Restdifferenz
    expect(b.text).toContain('MwSt-Satz-Bündelung');
    expect(b.text).toContain("8'915.40");
    expect(b.text).toContain("+2'192.62");
    expect(b.text).toContain("+7'736.85");
    expect(b.text).toContain("+465.00");
    expect(b.text).not.toContain("2'075.75");
  });

  it('Paul Ullrich (nur 4040, korrekt gebucht) erhält KEINEN Befund', () => {
    const befunde = buildMwstBuendelungBefunde(base);
    expect(befunde.some(b => b.lieferant === 'Paul Ullrich')).toBe(false);
  });

  it('Drilldown 4030/4040/4050: FS-Zeile trägt den Befund (typ=kontierung), keine Einzel-Hinweise', () => {
    const befunde = buildMwstBuendelungBefunde(base);
    for (const konto of ['4030', '4040', '4050']) {
      const d = buildKontoDrilldown({ ...base, konto, buendelungen: befunde });
      const fs = d.zeilen.find(z => z.lieferant === 'Feldschlösschen')!;
      expect(fs.typ).toBe('kontierung');
      expect(fs.buendelung).not.toBeNull();
      expect(fs.splitHinweis).toBeNull();
      expect(fs.kontierungsHinweis).toBeNull();
    }
    // Paul Ullrich auf 4040 bleibt unauffällig (ok)
    const d4040 = buildKontoDrilldown({ ...base, konto: '4040', buendelungen: befunde });
    expect(d4040.zeilen.find(z => z.lieferant === 'Paul Ullrich')!.typ).toBe('ok');
  });

  it('buildKorrekturVorschlaege: EIN konsolidierter Vorschlag statt Einzel-Abweichungen je Konto', () => {
    const v = buildKorrekturVorschlaege(base);
    const fsVorschlaege = v.filter(x => x.lieferant === 'Feldschlösschen');
    expect(fsVorschlaege).toHaveLength(1);
    expect(fsVorschlaege[0].typ).toBe('kontierung');
    expect(fsVorschlaege[0].konto).toBe('4030');
    expect(fsVorschlaege[0].betrag).toBeCloseTo(8915.40, 2);
    expect(fsVorschlaege[0].text.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('ohne Journal: leere Befund-Liste (leer statt 0)', () => {
    expect(buildMwstBuendelungBefunde({ ...base, journal: null })).toEqual([]);
  });

  it('Kontonamen fliessen in den Kopiertext ein', () => {
    const b = buildMwstBuendelungBefunde({ ...base, kontoNamen: {
      '4030': '4030 Bier', '4040': '4040 Spirituosen', '4050': '4050 Mineral', '4701': '4701 Betriebsmaterial',
    } })[0];
    expect(b.text).toContain('4030 Bier');
    expect(b.text).toContain('4040 Spirituosen');
    expect(b.text).toContain('4050 Mineral');
    expect(b.text).toContain('4701 Betriebsmaterial');
  });
});

describe('MwSt-Satz-Bündelung — Abgrenzung (Architect-Regressionen)', () => {
  const je = (accountNumber: string, text: string, soll: number): SageJournalEntry => ({
    date: '01.07.2026', text, accountNumber, accountName: '', soll, haben: 0,
  } as unknown as SageJournalEntry);

  it('Food-Muster (Überschuss auf 4060, Defizite 4070/4701) ist KEINE MwSt-Bündelung', () => {
    const e = [inv({ date: '2026-07-03', amountNet: 3000, supplierName: 'Transgourmet', kontoSplits: [
      { warenkonto: '4060', amountNet: 1000, amountGross: 0 },
      { warenkonto: '4070', amountNet: 1500, amountGross: 0 },
      { warenkonto: '4701', amountNet: 500, amountGross: 0 },
    ] })];
    const j = [je('4060', 'Transgourmet Schweiz AG', 3000)];
    expect(buildMwstBuendelungBefunde({ entries: e, journal: j, supplierNames: ['Transgourmet'], aliases: {} })).toEqual([]);
  });

  it('unabhängige Abweichung desselben Lieferanten auf 4060 bleibt als Vorschlag sichtbar', () => {
    // Beverage-Bündelung (4030 Überschuss, 4040/4050 Defizite) + separat
    // fehlende Rechnung auf 4060 (FIBU 500, App 0).
    const e = [inv({ date: '2026-07-05', amountNet: 3000, supplierName: 'Feldschlösschen', kontoSplits: [
      { warenkonto: '4030', amountNet: 1000, amountGross: 0 },
      { warenkonto: '4040', amountNet: 800, amountGross: 0 },
      { warenkonto: '4050', amountNet: 1200, amountGross: 0 },
    ] })];
    const j = [
      je('4030', 'Feldschlösschen Getränke AG', 3000),
      je('4060', 'Feldschlösschen Getränke AG', 500),
    ];
    const base = { entries: e, journal: j, supplierNames: ['Feldschlösschen'], aliases: {} };
    const befunde = buildMwstBuendelungBefunde(base);
    expect(befunde).toHaveLength(1);
    expect(befunde[0].umbuchungen.map(u => u.konto).sort()).toEqual(['4030', '4040', '4050']);
    const v = buildKorrekturVorschlaege(base);
    // EIN konsolidierter Bündelungs-Vorschlag …
    expect(v.filter(x => x.typ === 'kontierung' && x.lieferant === 'Feldschlösschen')).toHaveLength(1);
    // … UND die unabhängige 4060-Abweichung bleibt erhalten.
    expect(v.some(x => x.konto === '4060' && x.lieferant === 'Feldschlösschen' && Math.abs(x.betrag - 500) < 0.01)).toBe(true);
  });
});
