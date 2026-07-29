// @vitest-environment node
/**
 * Excel-Export der Cockpit-Report-Tabelle — je Granularität die richtigen
 * Felder (Monat vs. Woche), korrekte Δ%-Berechnung und Färbung, Schwellen-Rot.
 * Node-Umgebung: jsdom lädt sonst `canvas` (libuuid) eager → Crash im Container.
 */
import { describe, it, expect } from 'vitest';
import { buildMonatsreportWorkbook } from './monatsreport-export';
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
});
