// @vitest-environment node
/**
 * Excel-Export der Cockpit-Report-Tabelle — je Granularität die richtigen
 * Felder (Monat vs. Woche), korrekte Δ%-Berechnung und Färbung, Schwellen-Rot.
 * Node-Umgebung: jsdom lädt sonst `canvas` (libuuid) eager → Crash im Container.
 */
import { describe, it, expect } from 'vitest';
import { buildMonatsreportWorkbook, addWarenkostenSheet, vjColumnHeader } from './monatsreport-export';
import type { MrRow } from './monatsreport';

/** Bequemer MrRow-Builder mit sinnvollen Defaults (alle Felder gesetzt). */
function row(p: Partial<MrRow> & { label: string }): MrRow {
  return {
    type: 'data',
    fmt: 'chf',
    budget: null, vj: null, vjMonth: null,
    week: null, weekBudget: null, monthBudget: null, month: null,
    ...p,
  };
}

const GREEN = 'FF196B24';
const RED = 'FFC00000';

describe('buildMonatsreportWorkbook — Granularität', () => {
  // Eine Umsatz-Zeile mit unterschiedlichen Monats-/Wochenwerten, damit klar
  // ist, dass je Granularität die PASSENDEN Felder gezogen werden.
  const netto = row({
    label: 'Netto Umsatz', bold: true,
    // Woche
    budget: 7000, weekBudget: 7000, vj: 6500, week: 7350,
    // Monat
    monthBudget: 30000, vjMonth: 28000, month: 24000,
  });

  it('Monatssicht zieht monthBudget / vjMonth / month + Δ% gegen Monatsbudget', () => {
    const wb = buildMonatsreportWorkbook([netto], 7, 'monat');
    const ws = wb.worksheets[0];
    expect(ws.name).toContain('Monatsübersicht');
    const head = ws.getRow(1);
    expect(head.getCell(4).value).toBe('Ist (Monat)');
    const r = ws.getRow(2);
    expect(r.getCell(2).value).toBe(30000); // Budget = Monatsbudget
    expect(r.getCell(3).value).toBe(28000); // Vorjahr = vjMonth
    expect(r.getCell(4).value).toBe(24000); // Ist = month
    // Δ% = (24000-30000)/30000 = -20 %
    expect(r.getCell(5).value).toBeCloseTo(-20, 6);
    // Umsatz unter Budget = rot (nicht invertiert).
    expect((r.getCell(5).font as any).color.argb).toBe(RED);
  });

  it('Wochensicht zieht budget / vj / week + Δ% gegen Budget-Woche', () => {
    const wb = buildMonatsreportWorkbook([netto], 7, 'woche');
    const ws = wb.worksheets[0];
    expect(ws.name).toContain('Wochenübersicht');
    expect(ws.getRow(1).getCell(4).value).toBe('Woche');
    const r = ws.getRow(2);
    expect(r.getCell(2).value).toBe(7000);  // Budget = Woche
    expect(r.getCell(3).value).toBe(6500);  // Vorjahr = vj-Woche
    expect(r.getCell(4).value).toBe(7350);  // Ist = week
    // Δ% = (7350-7000)/7000 = +5 %
    expect(r.getCell(5).value).toBeCloseTo(5, 6);
    // Umsatz über Budget = grün.
    expect((r.getCell(5).font as any).color.argb).toBe(GREEN);
  });
});

describe('Vorjahres-Spaltenkopf — dynamisches Jahr (Ist ≠ Vorjahr)', () => {
  it('vjColumnHeader: Monat/Woche mit JJJJ−1, ohne Jahr Fallback «Vorjahr»', () => {
    expect(vjColumnHeader('monat', 2026)).toBe('Vorjahr (Monat 2025)');
    expect(vjColumnHeader('woche', 2026)).toBe('Vorjahr (Woche 2025)');
    expect(vjColumnHeader('monat', 2024)).toBe('Vorjahr (Monat 2023)');
    expect(vjColumnHeader('monat')).toBe('Vorjahr');
    expect(vjColumnHeader('woche', undefined)).toBe('Vorjahr');
  });

  it('Excel-Kopfzeile (Spalte 3) trägt das dynamische Vorjahr — Monat', () => {
    const wb = buildMonatsreportWorkbook([row({ label: 'Netto Umsatz' })], 7, 'monat', 2026);
    expect(wb.worksheets[0].getRow(1).getCell(3).value).toBe('Vorjahr (Monat 2025)');
  });

  it('Excel-Kopfzeile (Spalte 3) trägt das dynamische Vorjahr — Woche', () => {
    const wb = buildMonatsreportWorkbook([row({ label: 'Netto Umsatz' })], 7, 'woche', 2026);
    expect(wb.worksheets[0].getRow(1).getCell(3).value).toBe('Vorjahr (Woche 2025)');
  });

  it('ohne Jahr-Argument bleibt der Kopf «Vorjahr» (rückwärtskompatibel)', () => {
    const wb = buildMonatsreportWorkbook([row({ label: 'Netto Umsatz' })], 7, 'monat');
    expect(wb.worksheets[0].getRow(1).getCell(3).value).toBe('Vorjahr');
  });
});

describe('buildMonatsreportWorkbook — Personal (Kosten-Invertierung & Schwelle)', () => {
  const pkKosten = row({
    label: 'Personalkosten (Monat = Hochrechnung)', bold: true, deltaInverted: true,
    budget: 7100, weekBudget: 7100, week: 8000,        // Woche über Budget
    monthBudget: 99400, month: 123961,                  // Monat über Budget (HR)
  });
  const pkq = row({
    label: 'Personalquote (PKQ)', fmt: 'pct', warnAbove: 40,
    budget: 35.5, week: 44.4, month: 48.9,
  });

  it('Kosten über Budget → Δ% rot (invertiert), Woche & Monat', () => {
    const wMonat = buildMonatsreportWorkbook([pkKosten], 7, 'monat').worksheets[0].getRow(2);
    // Δ% = (123961-99400)/99400 ≈ +24.7 %, aber Kosten drüber = rot.
    expect(wMonat.getCell(5).value as number).toBeGreaterThan(0);
    expect((wMonat.getCell(5).font as any).color.argb).toBe(RED);

    const wWoche = buildMonatsreportWorkbook([pkKosten], 7, 'woche').worksheets[0].getRow(2);
    expect(wWoche.getCell(5).value as number).toBeGreaterThan(0);
    expect((wWoche.getCell(5).font as any).color.argb).toBe(RED);
  });

  it('PKQ über Obergrenze (40 %) → Ist-Wert rot/fett, Monat & Woche', () => {
    const mIst = buildMonatsreportWorkbook([pkq], 7, 'monat').worksheets[0].getRow(2).getCell(4);
    expect(mIst.value).toBe(48.9);
    expect((mIst.font as any).color.argb).toBe(RED);
    expect((mIst.font as any).bold).toBe(true);

    const wIst = buildMonatsreportWorkbook([pkq], 7, 'woche').worksheets[0].getRow(2).getCell(4);
    expect(wIst.value).toBe(44.4);
    expect((wIst.font as any).color.argb).toBe(RED);
  });
});

describe('buildMonatsreportWorkbook — leer statt 0', () => {
  it('fehlende Werte bleiben leer (null), keine 0; Δ% leer bei fehlendem Budget', () => {
    const leer = row({ label: 'Food', budget: null, vjMonth: null, month: null, monthBudget: null });
    const r = buildMonatsreportWorkbook([leer], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(2).value).toBeNull();
    expect(r.getCell(3).value).toBeNull();
    expect(r.getCell(4).value).toBeNull();
    expect(r.getCell(5).value).toBeNull(); // kein Budget → kein Δ%
  });

  it('Leerzeilen (type=empty) erzeugen leere Excel-Zeilen', () => {
    const rows: MrRow[] = [
      row({ label: 'A', monthBudget: 10, month: 12 }),
      { type: 'empty', budget: null, vj: null, vjMonth: null, week: null, weekBudget: null, monthBudget: null, month: null },
      row({ label: 'B', monthBudget: 10, month: 8 }),
    ];
    const ws = buildMonatsreportWorkbook(rows, 7, 'monat').worksheets[0];
    expect(ws.getRow(2).getCell(1).value).toBe('A');
    expect(ws.getRow(3).getCell(1).value ?? null).toBeNull(); // Leerzeile
    expect(ws.getRow(4).getCell(1).value).toBe('B');
  });

  // ── Gruppen ab N Pax: fmt='countPax' → «Anzahl (Σ Personen)» als Text ──────
  it('countPax schreibt «Anzahl (Personen)» als Text in Ist & Vorjahr (Monat)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 3, monthPax: 70, vjMonth: 2, vjMonthPax: 45,
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(3).value).toBe('2 (45 Pers.)'); // Vorjahr = vjMonth (vjMonthPax)
    expect(r.getCell(4).value).toBe('3 (70 Pers.)'); // Ist = month (monthPax)
  });

  it('countPax MIT sharePct: Anteil als Unterzeile, Δ% = Veränderung vs. VJ', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 8, monthPax: 255, vjMonth: 2, vjMonthPax: 45,
      sharePct: { month: 1.8, week: null, vj: null, vjMonth: 2.4 },
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe('8 (255 Pers.)\n1.8 % Anteil Gäste IN'); // Pax in Klammern, Anteil Unterzeile
    expect(r.getCell(3).value).toBe('2 (45 Pers.)\n2.4 %');                  // VJ-Anteil als Unterzeile
    expect(r.getCell(5).value).toBeCloseTo(((8 - 2) / 2) * 100);             // Δ% = Veränderung vs. VJ
    expect(r.getCell(5).numFmt).toBe('+0.0" %";-0.0" %"');                   // mit Vorzeichen wie übrige Zeilen
  });

  it('count MIT sharePct: Anteil als Unterzeile (Ist mit Hinweis, VJ nur %); Δ% = vs. VJ', () => {
    const res = row({
      label: 'Reservierte Gäste', fmt: 'count',
      month: 2396, vjMonth: 2100,
      sharePct: { month: 17.2, week: null, vj: null, vjMonth: 25.9 },
    });
    const r = buildMonatsreportWorkbook([res], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe('2’396\n17.2 % Anteil Gäste IN'); // de-CH U+2019
    expect(r.getCell(3).value).toBe('2’100\n25.9 %');
    expect(r.getCell(5).value).toBeCloseTo(((2396 - 2100) / 2100) * 100);
  });

  it('sharePct ohne Gäste-IN-Basis (null): keine Anteil-Unterzeile, Zellen bleiben numerisch', () => {
    const res = row({
      label: 'Reservierte Gäste', fmt: 'count',
      month: 2396, vjMonth: 2100,
      sharePct: { month: null, week: null, vj: null, vjMonth: null },
    });
    const r = buildMonatsreportWorkbook([res], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe(2396);
    expect(r.getCell(3).value).toBe(2100); // kein Anteil → Zahl bleibt Zahl
    // Δ% = Veränderung vs. VJ gibt es weiterhin (unabhängig vom Anteil).
    expect(r.getCell(5).value).toBeCloseTo(((2396 - 2100) / 2100) * 100);
  });

  it('countPax zieht in der Wochensicht week/weekPax (Vorjahr-Woche leer)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      week: 1, weekPax: 22, vj: null,
      month: 3, monthPax: 70, vjMonth: 2, vjMonthPax: 45,
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'woche').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe('1 (22 Pers.)'); // Ist = week (weekPax)
    expect(r.getCell(3).value ?? '').toBe(''); // keine VJ-Woche
  });
});

describe('addWarenkostenSheet — zweites Blatt «Warenkosten»', () => {
  const waren = {
    suppliers: [
      { name: 'Migros', net: 300, count: 3 },
      { name: 'Weinhandel', net: 100, count: 1 },
    ],
    total: 400,
    revenue: 2000,
  };

  it('Lieferanten, Anteil vom Umsatz und Total mit WKQ (Anteile summieren sich zur WKQ)', () => {
    const wb = buildMonatsreportWorkbook([], 7, 'monat');
    addWarenkostenSheet(wb, waren, 30, 'Juli 2026');
    const ws = wb.getWorksheet('Warenkosten')!;
    expect(ws).toBeDefined();
    // Zeile 1 Titel, 2 Kopf, 3–4 Lieferanten, 5 Total
    expect(ws.getRow(3).getCell(1).value).toBe('Migros');
    expect(ws.getRow(3).getCell(2).value).toBe(300);
    expect(ws.getRow(3).getCell(3).value).toBeCloseTo(15); // 300/2000
    expect(ws.getRow(3).getCell(4).value).toBe(3);
    expect(ws.getRow(4).getCell(3).value).toBeCloseTo(5);  // 100/2000
    const total = ws.getRow(5);
    expect(total.getCell(1).value).toBe('Warenkosten total');
    expect(total.getCell(2).value).toBe(400);
    expect(total.getCell(3).value).toBeCloseTo(20); // WKQ = Σ Anteile (15+5)
    expect(total.getCell(4).value).toBe(4);
    // WKQ 20 % <= Ziel 30 % → grün
    expect((total.getCell(3).font?.color as { argb?: string })?.argb).toBe('FF196B24');
  });

  it('ohne Umsatz keine Anteile/WKQ (nie durch 0 teilen)', () => {
    const wb = buildMonatsreportWorkbook([], 7, 'woche');
    addWarenkostenSheet(wb, { ...waren, revenue: null }, 30, 'Woche');
    const ws = wb.getWorksheet('Warenkosten')!;
    expect(ws.getRow(3).getCell(3).value).toBeNull();
    expect(ws.getRow(5).getCell(3).value).toBeNull();
  });

  it('WKQ über Ziel wird rot markiert', () => {
    const wb = buildMonatsreportWorkbook([], 7, 'monat');
    addWarenkostenSheet(wb, { ...waren, revenue: 1000 }, 30, 'Juli 2026'); // WKQ 40 %
    const ws = wb.getWorksheet('Warenkosten')!;
    expect((ws.getRow(5).getCell(3).font?.color as { argb?: string })?.argb).toBe('FFC00000');
  });
});
