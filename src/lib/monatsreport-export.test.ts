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
    // Kombinierte Δ-Zelle: abs gross, % darunter (−6'000.00 / −20.0 %).
    expect(r.getCell(5).value).toBe('−6’000.00\n-20.0 %');
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
    // Kombinierte Δ-Zelle: abs gross, % darunter.
    expect(r.getCell(5).value).toBe('+350.00\n+5.0 %');
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
    // Kombinierte Δ-Zelle: abs positiv (über Budget), Kosten drüber = rot.
    expect(String(wMonat.getCell(5).value)).toMatch(/^\+24’561\.00\n\+24\.7 %$/);
    expect((wMonat.getCell(5).font as any).color.argb).toBe(RED);

    const wWoche = buildMonatsreportWorkbook([pkKosten], 7, 'woche').worksheets[0].getRow(2);
    expect(String(wWoche.getCell(5).value)).toMatch(/^\+900\.00\n\+12\.7 %$/);
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

  // ── Gruppen ab N Pax: fmt='countPax' → «Personen (Anzahl Gruppen)» als Text.
  // Seit 08/2026: Hauptwert = PERSONEN (Budget-Einheit), Gruppen in Klammern.
  it('countPax schreibt «Personen (Gruppen)» als Text in Ist & Vorjahr (Monat)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 70, monthPax: 3, vjMonth: 45, vjMonthPax: 2,
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(3).value).toBe('45 Pers. (2 Gruppen)'); // Vorjahr = vjMonth (vjMonthPax)
    expect(r.getCell(4).value).toBe('70 Pers. (3 Gruppen)'); // Ist = month (monthPax)
  });

  it('countPax MIT sharePct + Budget: Anteil als Unterzeile, Δ = Ist − Budget (Personen)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 40, monthPax: 2, vjMonth: 45, vjMonthPax: 2, monthBudget: 96,
      sharePct: { month: 1.8, week: null, vj: null, vjMonth: 2.4 },
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe('40 Pers. (2 Gruppen)\n1.8 % Anteil Gäste IN');
    expect(r.getCell(3).value).toBe('45 Pers. (2 Gruppen)\n2.4 %'); // VJ bleibt als Zusatz-Spalte
    // Δ = Ist − Budget in Personen: 40 − 96 = −56; % = −56 ÷ 96 = −58.3 %.
    expect(r.getCell(5).value).toBe('−56\n-58.3 %');
  });

  it('countPax OHNE Budget: Δ weiterhin vs. VJ (nie ÷0, leer statt 0-Basis)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 40, monthPax: 2, vjMonth: 45, vjMonthPax: 2,
      sharePct: { month: 1.8, week: null, vj: null, vjMonth: 2.4 },
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    expect(r.getCell(5).value).toBe('−5\n-11.1 %'); // Ist − VJ (kein Budget)
  });

  it('countPax mit Budget 0/leer: kein Δ% (nie ÷0)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      month: 40, monthPax: 2, vjMonth: null, vjMonthPax: null, monthBudget: 0,
      sharePct: { month: null, week: null, vj: null, vjMonth: null },
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'monat').worksheets[0].getRow(2);
    // Budget 0 ist gesetzt (nicht null) → Basis Budget, aber ÷0 verboten:
    // Δ abs = 40 − 0 = +40, Δ% bleibt leer.
    expect(r.getCell(5).value).toBe('+40');
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
    expect(r.getCell(5).value).toBe('+296\n+14.1 %');
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
    // Δ (abs + %) vs. VJ gibt es weiterhin (unabhängig vom Anteil).
    expect(r.getCell(5).value).toBe('+296\n+14.1 %');
  });

  it('countPax zieht in der Wochensicht week/weekPax (Vorjahr-Woche leer)', () => {
    const gruppen = row({
      label: 'Gruppen ab 20 Pax', fmt: 'countPax',
      week: 22, weekPax: 1, vj: null,
      month: 70, monthPax: 3, vjMonth: 45, vjMonthPax: 2,
    });
    const r = buildMonatsreportWorkbook([gruppen], 7, 'woche').worksheets[0].getRow(2);
    expect(r.getCell(4).value).toBe('22 Pers. (1 Gruppen)'); // Ist = week (weekPax)
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
