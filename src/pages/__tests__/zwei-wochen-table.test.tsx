// @vitest-environment happy-dom
/**
 * Render-Tests der kompakten 2-Wochen-Tabelle (Wochenübersicht):
 * Zeilen-Zuordnung per ID, fehlende Vorwochen-Zeile = leer, Δ-Basen
 * (Budget / Vorjahr / Prozentpunkte) wie in der 1-Wochen-Report-Tabelle.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ZweiWochenTable, WochenTable } from '@/pages/MonatsreportPage';
import type { MrRow } from '@/lib/monatsreport';

const row = (over: Partial<MrRow>): MrRow => ({
  type: 'data', id: 'x', label: 'X', fmt: 'chf',
  month: null, week: null, vj: null, vjMonth: null,
  monthBudget: null, weekBudget: null, budget: null,
  ...over,
} as MrRow);

const B = [
  row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 60_000, budget: 56_452, weekBudget: 56_452, bold: true }),
  row({ id: 'personalquote', label: 'Personalquote (PKQ)', fmt: 'pct', week: 42, budget: 40, weekBudget: 40, deltaPp: true }),
  row({ id: 'take_away_umsatz', label: 'TA Umsatz', week: 8000, vj: 7000, deltaVsVj: true }),
  row({ id: 'nur_neu', label: 'Nur in Woche B', week: 5 }),
];
const A = [
  row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 50_000, budget: 56_452, weekBudget: 56_452 }),
  row({ id: 'personalquote', label: 'Personalquote (PKQ)', fmt: 'pct', week: 39, budget: 40, weekBudget: 40, deltaPp: true }),
];

describe('ZweiWochenTable', () => {
  it('ordnet Vorwochen-Werte per Zeilen-ID zu; fehlende Zeile bleibt leer', () => {
    render(<ZweiWochenTable rowsA={A} rowsB={B} headerA="KW 31" headerB="KW 32" testid="t2w" />);
    expect(screen.getByTestId('wa-ist-netto_umsatz').textContent).toContain('50');
    expect(screen.getByTestId('wb-ist-netto_umsatz').textContent).toContain('60');
    // «nur_neu» existiert in der Vorwoche nicht → Zellen leer (leer statt 0)
    const tr = screen.getByTestId('row2w-nur_neu');
    const tds = within(tr).getAllByRole('cell');
    expect(tds[1].textContent).toBe(''); // Vorwoche Ist leer
    expect(tds[4].textContent?.trim()).toBe('5.00'); // Woche B Ist (fmt chf)
  });

  it('Δ-Basen: Budget-Δ, PP-Δ (PKQ) und Δ vs. VJ je Woche korrekt', () => {
    render(<ZweiWochenTable rowsA={A} rowsB={B} headerA="KW 31" headerB="KW 32" testid="t2w" />);
    // Budget-Δ Woche B: 60'000 − 56'452 = +3'548
    expect(screen.getByTestId('wb-delta-netto_umsatz').textContent).toContain('+3’548.00'.replace('’', '\u2019'));
    // PKQ: Δ in Prozentpunkten je Woche (A: 39−40 = −1 PP, B: 42−40 = +2 PP)
    expect(screen.getByTestId('wa-delta-personalquote').textContent).toContain('-1.0 PP');
    expect(screen.getByTestId('wb-delta-personalquote').textContent).toContain('+2.0 PP');
    // TA Umsatz ohne Budget: Δ gegen VJ («vs. VJ»)
    expect(screen.getByTestId('wb-delta-take_away_umsatz').textContent).toContain('vs. VJ');
  });
});

describe('WochenTable (4 Spalten, PDF-Export «letzte 4 Wochen»)', () => {
  it('rendert 4 Wochen-Spalten; Skeleton = neueste Spalte, leere Spalte bleibt leer', () => {
    const w1 = [row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 40_000, budget: 50_000, weekBudget: 50_000 })];
    const w3 = [row({ id: 'netto_umsatz', label: 'Netto Umsatz', week: 55_000, budget: 50_000, weekBudget: 50_000 })];
    const w4 = B;
    render(<WochenTable
      cols={[
        { rows: w1, header: 'KW 29', keyPrefix: 'w1' },
        { rows: null, header: 'KW 30', keyPrefix: 'w2' }, // Woche nicht ladbar
        { rows: w3, header: 'KW 31', keyPrefix: 'w3' },
        { rows: w4, header: 'KW 32', keyPrefix: 'w4' },
      ]}
      testid="t4w"
    />);
    expect(screen.getByTestId('w1-ist-netto_umsatz').textContent).toContain('40');
    expect(screen.getByTestId('w3-ist-netto_umsatz').textContent).toContain('55');
    expect(screen.getByTestId('w4-ist-netto_umsatz').textContent).toContain('60');
    // Leere Spalte: keine Zellen-Inhalte, aber Zeile existiert (Skeleton = w4)
    expect(screen.queryByTestId('w2-ist-netto_umsatz')).toBeNull();
    // Skeleton-Zeile «nur_neu» aus der neuesten Woche vorhanden
    expect(screen.getByTestId('row2w-nur_neu')).toBeTruthy();
    // Kopf: 4 Wochen-Header
    for (const kw of ['KW 29', 'KW 30', 'KW 31', 'KW 32']) {
      expect(screen.getByText(kw)).toBeTruthy();
    }
    // Budget-Δ in w4: +3'548 gegen Budget
    expect(screen.getByTestId('w4-delta-netto_umsatz').textContent).toContain('+3’548.00');
  });
});
