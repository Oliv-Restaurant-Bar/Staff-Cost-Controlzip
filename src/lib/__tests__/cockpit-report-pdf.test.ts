// @vitest-environment node
/**
 * Modell-Builder des strukturierten Cockpit-PDF-Exports:
 * Sektions-Zuordnung, Richtungs-Logik der Δ-Chips, Ampel-Schwellen,
 * «—» für fehlende Werte (nie 0), Zahlformat mit Apostroph-Tausendern.
 */
import { describe, it, expect } from 'vitest';
import {
  buildWochenPdfModel, buildVerlaufPdfModel, buildJahresvergleichPdfModel,
  fmtWert, fmtZahl, wkqAmpel, pkqAmpel, budgetAmpel,
} from '@/lib/cockpit-report-pdf';
import type { MrRow, WochenverlaufDaten, JahresvergleichDaten } from '@/lib/monatsreport';

function row(partial: Partial<MrRow>): MrRow {
  return {
    type: 'data', budget: null, vj: null, vjMonth: null, week: null,
    weekBudget: null, monthBudget: null, month: null, fmt: 'chf',
    ...partial,
  };
}

describe('fmtZahl / fmtWert', () => {
  it('setzt Apostroph-Tausender und fixe Dezimalstellen', () => {
    expect(fmtZahl(1234567.891, 2)).toBe("1'234'567.89");
    expect(fmtZahl(-9876, 0)).toBe("-9'876");
  });
  it('null/undefined → «—», nie 0', () => {
    expect(fmtWert(null, 'chf')).toBe('—');
    expect(fmtWert(undefined, 'count')).toBe('—');
  });
  it('formatiert je MrFormat', () => {
    expect(fmtWert(35.57, 'pct')).toBe('35.6 %');
    expect(fmtWert(1234.6, 'count')).toBe("1'235");
    expect(fmtWert(412.4, 'hours')).toBe('412 h');
    expect(fmtWert(14778.07, 'chf')).toBe("14'778");
  });
});

describe('Ampel-Schwellen', () => {
  it('WKQ: ≤30 grün, ≤35 gelb, >35 rot; null → keine Ampel', () => {
    expect(wkqAmpel(29.9)?.stufe).toBe('gruen');
    expect(wkqAmpel(30)?.stufe).toBe('gruen');
    expect(wkqAmpel(32)?.stufe).toBe('gelb');
    expect(wkqAmpel(35)?.stufe).toBe('gelb');
    expect(wkqAmpel(35.1)?.stufe).toBe('rot');
    expect(wkqAmpel(null)).toBeNull();
    // Immer Wert + Label (nie Farbe allein).
    expect(wkqAmpel(36.2)?.label).toContain('36.2');
    expect(wkqAmpel(36.2)?.label).toContain('über Ziel');
  });
  it('PKQ gegen 40 %: ≤40 grün, ≤44 gelb, >44 rot', () => {
    expect(pkqAmpel(38)?.stufe).toBe('gruen');
    expect(pkqAmpel(40)?.stufe).toBe('gruen');
    expect(pkqAmpel(42)?.stufe).toBe('gelb');
    expect(pkqAmpel(44.5)?.stufe).toBe('rot');
    expect(pkqAmpel(null)).toBeNull();
  });
  it('Budget-Ampel (mehr = besser): ≥100 % grün, ≥95 % gelb, sonst rot; ohne Budget keine', () => {
    expect(budgetAmpel(105, 100)?.stufe).toBe('gruen');
    expect(budgetAmpel(97, 100)?.stufe).toBe('gelb');
    expect(budgetAmpel(90, 100)?.stufe).toBe('rot');
    expect(budgetAmpel(90, null)).toBeNull();
    expect(budgetAmpel(90, 0)).toBeNull(); // nie durch 0
  });
});

describe('buildWochenPdfModel', () => {
  const meta = { reportTyp: 'Wochenübersicht', zeitraum: 'KW 32' };

  it('ordnet Zeilen den Sektionen zu — KEIN «Weitere Kennzahlen»-Sammelblock mehr', () => {
    const rows: MrRow[] = [
      row({ id: 'google_5_sterne', label: 'Google 5 Sterne', fmt: 'count', week: 4 }),
      row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 50000, weekBudget: 48000, budget: 48000 }),
      row({ id: 'gaeste_in', label: 'Gäste IN', fmt: 'count', week: 900 }),
      row({ id: 'personalquote', label: 'PKQ', fmt: 'pct', week: 42, weekBudget: 35.5, budget: 35.5, deltaPp: true, deltaInverted: true }),
      row({ id: 'warenkosten_total', label: 'Warenkosten total', week: 14000, wkqInline: { month: null, week: { pct: 31.2, ziel: 30, food: 28, bev: 20 } } }),
      row({ id: 'irgendwas_neues', label: 'Neu', week: 1 }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'KW 32' }], meta);
    expect(m.sektionen.map(s => s.titel)).toEqual(
      ['Umsatz', 'Gäste', 'Personal', 'Waren', 'Bewertungen']);
  });

  it('Warenkosten Food/Beverage landen im Waren-Block (id- und Label-Heuristik)', () => {
    const rows: MrRow[] = [
      row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 50000 }),
      row({ id: 'warenkosten_food', label: 'Warenkosten Food', week: 9000 }),
      row({ id: 'warenkosten_beverage', label: 'Warenkosten Beverage', week: 3000 }),
      row({ id: 'sonst_wareneinsatz', label: 'Wareneinsatz Sonstiges', week: 100 }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'KW 32' }], meta);
    const waren = m.sektionen.find(s => s.titel === 'Waren')!;
    expect(waren.rows.map(r => r.label)).toEqual(
      ['Warenkosten Food', 'Warenkosten Beverage', 'Wareneinsatz Sonstiges']);
  });

  it('Δ auf Anzeige-Rundung 0 → KEIN Chip (dezentes «—»)', () => {
    const rows: MrRow[] = [
      row({ id: 'netto_umsatz', label: 'Netto', week: 50000.2, weekBudget: 50000, budget: 50000 }),
      row({ id: 'personalquote', label: 'PKQ', fmt: 'pct', week: 35.51, weekBudget: 35.5, budget: 35.5, deltaPp: true }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'KW 32' }], meta);
    const alleRows = m.sektionen.flatMap(s => s.rows);
    expect(alleRows[0].zellen[0]!.delta).toBeNull();  // +0 CHF gerundet
    expect(alleRows[1].zellen[0]!.delta).toBeNull();  // +0.0 PP gerundet
  });

  it('granularity monat: Monatsfelder + Monats-WKQ-Ampel', () => {
    const rows: MrRow[] = [
      row({
        id: 'netto_umsatz', label: 'Netto', month: 210000, monthBudget: 200000,
        week: 50000, weekBudget: 48000, budget: 48000,
      }),
      row({
        id: 'warenkosten_total', label: 'Waren', month: 60000, week: 14000,
        wkqInline: { month: { pct: 36.1, ziel: 30, food: 30, bev: 20 }, week: { pct: 29, ziel: 30, food: null, bev: null } },
      }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'August 2026' }], {
      ...meta, reportTyp: 'Monatsübersicht', granularity: 'monat',
    });
    const alleRows = m.sektionen.flatMap(s => s.rows);
    expect(alleRows[0].zellen[0]!.ist.text).toBe("210'000");
    expect(alleRows[0].zellen[0]!.budget.text).toBe("200'000");
    expect(alleRows[0].zellen[0]!.delta?.haupt).toBe("+10'000");
    expect(alleRows[1].zellen[0]!.ist.ampel?.stufe).toBe('rot'); // Monats-WKQ 36.1
    expect(alleRows[1].notiz).toContain('Ziel-WKQ 30.0 %');
  });

  it('Δ-Chip richtungsabhängig: Umsatz über Budget grün, Kosten (PKQ) über Ziel rot', () => {
    const rows: MrRow[] = [
      row({ id: 'netto_umsatz', label: 'Netto', week: 52000, weekBudget: 50000, budget: 50000 }),
      row({ id: 'personalkosten', label: 'PK', week: 21000, weekBudget: 20000, budget: 20000, deltaInverted: true }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'KW 32' }], meta);
    const umsatz = m.sektionen.find(s => s.titel === 'Umsatz')!.rows[0].zellen[0]!;
    const pk = m.sektionen.find(s => s.titel === 'Personal')!.rows[0].zellen[0]!;
    expect(umsatz.delta?.ton).toBe('gruen');
    expect(umsatz.delta?.haupt).toBe("+2'000");
    expect(umsatz.delta?.sub).toBe('+4.0 %');
    expect(pk.delta?.ton).toBe('rot');
    expect(pk.delta?.haupt).toBe("+1'000");
  });

  it('PKQ: Δ in PP + Ampel; WKQ-Ampel nach Spezifikations-Schwellen', () => {
    const rows: MrRow[] = [
      row({ id: 'personalquote', label: 'PKQ', fmt: 'pct', week: 42.1, weekBudget: 35.5, budget: 35.5, deltaPp: true, deltaInverted: true }),
      row({ id: 'warenkosten_total', label: 'Waren', week: 14000, wkqInline: { month: null, week: { pct: 36.4, ziel: 30, food: null, bev: null } } }),
    ];
    const m = buildWochenPdfModel([{ rows, header: 'KW 32' }], meta);
    const pkq = m.sektionen.find(s => s.titel === 'Personal')!.rows[0].zellen[0]!;
    expect(pkq.delta?.haupt).toBe('+6.6 PP');
    expect(pkq.delta?.ton).toBe('rot');
    expect(pkq.ist.ampel?.stufe).toBe('gelb'); // 42.1 gegen 40
    const waren = m.sektionen.find(s => s.titel === 'Waren')!.rows[0].zellen[0]!;
    expect(waren.ist.ampel?.stufe).toBe('rot'); // 36.4 > 35
  });

  it('leere Spalte (rows=null) → Zelle null; fehlende Werte «—»; Kinder ausgelassen', () => {
    const rows: MrRow[] = [
      row({ id: 'netto_umsatz', label: 'Netto', week: null, weekBudget: null }),
      row({ id: 'lieferant_x', label: 'Lieferant X', week: 5, childOf: 'warenkosten_total' }),
    ];
    const m = buildWochenPdfModel([
      { rows: null, header: 'Vorwoche' },
      { rows, header: 'KW 32' },
    ], meta);
    const alleRows = m.sektionen.flatMap(s => s.rows);
    expect(alleRows).toHaveLength(1); // Kind ausgelassen
    expect(alleRows[0].zellen[0]).toBeNull();
    expect(alleRows[0].zellen[1]!.ist.text).toBe('—');
    expect(alleRows[0].zellen[1]!.delta).toBeNull();
    expect(m.gruppen.map(g => g.header)).toEqual(['Vorwoche', 'KW 32']);
  });

  it('Skeleton = letzte Spalte mit Daten; ältere Spalten per ID zugeordnet', () => {
    const alt: MrRow[] = [row({ id: 'netto_umsatz', label: 'Netto', week: 40000, weekBudget: 41000, budget: 41000 })];
    const neu: MrRow[] = [row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 50000, weekBudget: 48000, budget: 48000 })];
    const m = buildWochenPdfModel([
      { rows: alt, header: 'KW 31' }, { rows: neu, header: 'KW 32' },
    ], meta);
    const r = m.sektionen[0].rows[0];
    expect(r.label).toBe('Netto Umsatz');
    expect(r.zellen[0]!.ist.text).toBe("40'000");
    expect(r.zellen[0]!.delta?.ton).toBe('rot'); // 40000 < 41000 Budget
    expect(r.zellen[1]!.ist.text).toBe("50'000");
  });
});

describe('buildVerlaufPdfModel', () => {
  const daten: WochenverlaufDaten = {
    weeks: [
      { kwYear: 2026, kw: 31, from: '2026-07-27', to: '2026-08-02' },
      { kwYear: 2026, kw: 32, from: '2026-08-03', to: '2026-08-09' },
    ],
    partialWeekIndex: 1,
    rows: [
      {
        label: 'Netto Umsatz', fmt: 'chf', values: [50000, null],
        budgetValues: [48000, null], id: 'netto_umsatz',
      },
      {
        label: 'Personalkosten', fmt: 'chf', values: [21000, 20000],
        budgetValues: [20000, 20000], budgetInverted: true, id: 'personalkosten',
      },
      {
        label: 'Warenkosten total', fmt: 'chf', values: [14000, null],
        wkqValues: [29.5, null], wkqZiel: 30, id: 'warenkosten_total',
      },
      { label: 'Lieferant X', fmt: 'chf', values: [5, 5], childOf: 'warenkosten_total' },
    ],
  };

  it('Wochengruppen mit KW-Label, laufende Woche markiert, Datumsbereich als Sub', () => {
    const m = buildVerlaufPdfModel(daten, { zeitraum: '2026', legende: [] });
    expect(m.gruppen[0].header).toBe('KW 31');
    expect(m.gruppen[1].header).toBe('KW 32 (laufend)');
    expect(m.gruppen[0].sub).toBe('27.07.–02.08.');
    expect(m.reportTyp).toBe('Wochenverlauf');
  });

  it('Vorjahres-Ansicht: VJ-Wert als Unterzeile (Ampel hat Vorrang)', () => {
    const mitVj: WochenverlaufDaten = {
      ...daten,
      rows: [
        { label: 'Netto Umsatz', fmt: 'chf', values: [50000, null], vjValues: [47000, null], id: 'netto_umsatz' },
        {
          label: 'Warenkosten total', fmt: 'chf', values: [14000, null],
          vjValues: [13500, null], wkqValues: [29.5, null], wkqZiel: 30, id: 'warenkosten_total',
        },
      ],
    };
    const m = buildVerlaufPdfModel(mitVj, { zeitraum: '2026', legende: [] });
    const alleRows = m.sektionen.flatMap(s => s.rows);
    expect(alleRows[0].zellen[0]!.ist.sub).toBe("VJ 47'000");
    expect(alleRows[0].zellen[1]!.ist.sub).toBeUndefined(); // VJ null → keine Zeile
    expect(alleRows[1].zellen[0]!.ist.sub).toBeUndefined(); // Ampel hat Vorrang
    expect(alleRows[1].zellen[0]!.ist.ampel?.stufe).toBe('gruen');
  });

  it('Δ nur bei Ist+Budget; Richtung invertiert bei Kosten; WKQ-Ampel; Kinder ausgelassen', () => {
    const m = buildVerlaufPdfModel(daten, { zeitraum: '2026', legende: [] });
    const alleRows = m.sektionen.flatMap(s => s.rows);
    expect(alleRows.map(r => r.label)).toEqual(['Netto Umsatz', 'Personalkosten', 'Warenkosten total']);
    const netto = alleRows[0];
    expect(netto.zellen[0]!.delta?.ton).toBe('gruen');
    expect(netto.zellen[1]!.ist.text).toBe('—');
    expect(netto.zellen[1]!.delta).toBeNull();
    const pk = alleRows[1];
    expect(pk.zellen[0]!.delta?.ton).toBe('rot');   // über Budget = schlecht
    expect(pk.zellen[1]!.delta).toBeNull();         // genau Budget (Δ 0) → kein Chip
    const waren = alleRows[2];
    expect(waren.zellen[0]!.ist.ampel?.stufe).toBe('gruen'); // 29.5 ≤ 30
    expect(waren.zellen[1]!.ist.ampel).toBeNull();
  });
});

describe('buildJahresvergleichPdfModel', () => {
  const daten: JahresvergleichDaten = {
    curYear: 2026, vjYear: 2025, curFrom: '2026-01-01', curTo: '2026-08-11',
    vjFrom: '2025-01-01', vjTo: '2025-08-11', modus: 'ytd',
    rows: [
      { label: 'Netto-Umsatz', fmt: 'chf', cur: 900000, vj: 850000, budget: 880000 },
      { label: 'Personalkosten', fmt: 'chf', cur: 320000, vj: 310000, budget: 300000, deltaInverted: true },
      { label: 'Personalquote', fmt: 'pct', cur: 35.5, vj: 36.2, budget: 35.5, deltaInverted: true },
      { label: 'Gäste IN', fmt: 'count', cur: 21000, vj: null },
    ],
  } as JahresvergleichDaten;

  it('Ist | Budget | Δ gegen Budget — gleiche Semantik wie die Bildschirmtabelle', () => {
    const m = buildJahresvergleichPdfModel(daten, { zeitraum: '01.01.–11.08.', spaltenHeader: 'YTD 2026' });
    expect(m.reportTyp).toBe('Jahresvergleich');
    expect(m.gruppen).toEqual([{ header: 'YTD 2026', sub: null }]);
    const alleRows = m.sektionen.flatMap(s => s.rows);
    const umsatz = alleRows.find(r => r.label === 'Netto-Umsatz')!;
    expect(umsatz.zellen[0]!.delta?.ton).toBe('gruen');   // über Budget
    expect(umsatz.zellen[0]!.delta?.haupt).toBe("+20'000");
    expect(umsatz.zellen[0]!.ist.sub).toBe("VJ 2025: 850'000");
    const pk = alleRows.find(r => r.label === 'Personalkosten')!;
    expect(pk.zellen[0]!.delta?.ton).toBe('rot');         // Kosten über Budget
    const pkq = alleRows.find(r => r.label === 'Personalquote')!;
    expect(pkq.zellen[0]!.delta).toBeNull();              // Δ 0.0 PP → kein Chip
    const gaeste = alleRows.find(r => r.label === 'Gäste IN')!;
    expect(gaeste.zellen[0]!.delta).toBeNull();           // kein Budget → kein Chip
    expect(gaeste.zellen[0]!.budget.text).toBe('—');
    expect(gaeste.zellen[0]!.ist.sub).toBeUndefined();    // VJ null → keine Unterzeile
  });

  it('sortiert per Label-Heuristik in die fachlichen Sektionen', () => {
    const m = buildJahresvergleichPdfModel(daten, { zeitraum: 'x', spaltenHeader: '2026' });
    expect(m.sektionen.map(s => s.titel)).toEqual(['Umsatz', 'Gäste', 'Personal']);
  });
});

// ── Renderer-Geometrie: Δ-Chip-Text bleibt IMMER in der Δ-Zelle ─────────────
import { zeichneCockpitReport, type CrReportModel } from '@/lib/cockpit-report-pdf';

/** Fake-jsPDF: proportionale Textbreite, protokolliert alle text()-Aufrufe. */
function fakePdf() {
  let fontSize = 10;
  let font = { fontName: 'helvetica', fontStyle: 'normal' };
  const texts: Array<{ text: string; x: number; size: number; align?: string; width: number }> = [];
  const charW = (s: number) => (s / 72) * 25.4 * 0.6; // mm pro Zeichen (grob, deterministisch)
  const pdf = {
    setFillColor: () => {}, rect: () => {}, roundedRect: () => {},
    setDrawColor: () => {}, setLineWidth: () => {}, line: () => {},
    setTextColor: () => {}, addPage: () => {}, addImage: () => {},
    setFont: (n: string, st?: string) => { font = { fontName: n, fontStyle: st ?? 'normal' }; },
    getFont: () => font,
    setFontSize: (s: number) => { fontSize = s; },
    getTextWidth: (t: string) => t.length * charW(fontSize),
    text: (t: string, x: number, _y: number, opts?: { align?: string }) => {
      texts.push({ text: t, x, size: fontSize, align: opts?.align, width: t.length * charW(fontSize) });
    },
    getNumberOfPages: () => 1,
    internal: { pageSize: { getWidth: () => 297, getHeight: () => 210 } },
  };
  return { pdf: pdf as never, texts };
}

describe('zeichneCockpitReport — Δ-Chip-Geometrie (4 Gruppen, Extremwerte)', () => {
  it('zeichnet überlange Δ-Texte nie über die Δ-Zelle hinaus in die Budget-Spalte', () => {
    const hauptLang = "+123'456'789.00";
    const subLang = "+99'999.9 %";
    const zelle = {
      ist: { text: "9'999'999.00" }, budget: { text: "8'888'888.00" },
      delta: { haupt: hauptLang, sub: subLang, ton: 'gruen' as const },
    };
    const model: CrReportModel = {
      reportTyp: 'Test', zeitraum: 'Test', legende: [],
      gruppen: [1, 2, 3, 4].map(i => ({ header: `KW ${i}` })),
      sektionen: [{
        titel: 'Umsatz',
        rows: [{ label: 'Umsatz Total', bold: false, zellen: [zelle, zelle, zelle, zelle] }],
      }],
    };
    const { pdf, texts } = fakePdf();
    const branding = {
      displayName: 'Test', companyLine: 'Test AG', headerBg: [255, 255, 255],
      textPrimary: [0, 0, 0], textSecondary: [0, 0, 0], accentColor: [0, 0, 0],
    } as never;
    zeichneCockpitReport(pdf, model, branding, null, new Date('2026-08-11'), true);

    // Geometrie wie berechneSpalten: 4 Gruppen.
    const MARGIN = 13, CONTENT_W = 297 - 26;
    const minLabelW = Math.max(58, Math.min(80, CONTENT_W * 0.26));
    const gruppeW = Math.min(84, (CONTENT_W - minLabelW) / 4);
    const labelW = CONTENT_W - 4 * gruppeW;
    const teilW = gruppeW / 3;

    // Alle Δ-Chip-Texte (beginnen mit «+», rechtsbündig): linke Textkante
    // muss rechts vom Beginn der Δ-Zelle der jeweiligen Gruppe liegen.
    const chipTexte = texts.filter(t => t.text.startsWith('+') && t.align === 'right');
    expect(chipTexte.length).toBeGreaterThanOrEqual(4);
    for (const t of chipTexte) {
      const gi = Math.floor((t.x - MARGIN - labelW) / gruppeW);
      const deltaZelleStart = MARGIN + labelW + gi * gruppeW + 2 * teilW;
      expect(t.x - t.width).toBeGreaterThanOrEqual(deltaZelleStart - 0.01);
    }
  });
});
