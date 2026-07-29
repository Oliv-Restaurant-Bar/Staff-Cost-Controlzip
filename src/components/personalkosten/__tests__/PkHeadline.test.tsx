// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PkHeadline } from '../PkHeadline';
import { TooltipProvider } from '@/components/ui/tooltip';

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

function renderHeadline(overrides: Partial<Parameters<typeof PkHeadline>[0]> = {}) {
  return render(
    <TooltipProvider>
      <PkHeadline
        monthLabel="Juli 2026"
        hrTotalCHF={118_531}
        hrFixCHF={90_000}
        hrFlexCHF={28_531}
        budgetCHF={88_750}
        umsatzBudgetCHF={250_000}
        zielQuote={0.355}
        pkqHochrechnung={0.4685}
        umsatzHochrechnungCHF={253_000}
        istTotalCHF={45_000}
        umsatzIstCHF={96_000}
        pkqIst={0.4688}
        istTage={12}
        daysInMonth={31}
        stichtag={12}
        year={2026}
        month={7}
        fmtCHF={fmtCHF}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

describe('PkHeadline — Schlagzeile aus Kernwerten (reine Darstellung)', () => {
  it('zeigt die grosse Kernaussage = Hochrechnung', () => {
    renderHeadline();
    expect(screen.getByTestId('pk-headline-value').textContent).toContain('118');
  });

  it('Abweichungs-Chip ist rot/über Budget, wenn HR > Budget', () => {
    renderHeadline();
    const chip = screen.getByTestId('pk-headline-chip-abw');
    // 118'531 − 88'750 = +29'781 über Budget
    expect(chip.textContent).toContain('+');
    expect(chip.textContent).toContain('zum Budget');
  });

  it('PKQ-Chip zeigt die Hochrechnungs-Quote', () => {
    renderHeadline();
    expect(screen.getByTestId('pk-headline-chip-pkq').textContent).toContain('46.9 %');
  });

  it('Zusatzzeile: Stand = abgeschlossene Tage (Stichtag) von Monatstagen', () => {
    // stichtag 12, istTage 12 → «12 von 31 Tagen abgeschlossen», kein Zusatz.
    renderHeadline();
    const t = screen.getByTestId('pk-headline-isttage').textContent ?? '';
    expect(t).toContain('12 von 31');
    expect(t).toContain('abgeschlossen');
    expect(t).not.toContain('mit Ist-Umsatz');
  });

  it('Zusatzzeile: bei fehlendem Ist-Umsatz zeigt sie «, davon X mit Ist-Umsatz»', () => {
    // stichtag 28 (bis 28.07.), aber nur 27 Tage mit Ist-Umsatz → konsistent.
    renderHeadline({ stichtag: 28, istTage: 27, pkqIst: 0.53 });
    const t = screen.getByTestId('pk-headline-isttage').textContent ?? '';
    expect(t).toContain('28 von 31 Tagen abgeschlossen');
    expect(t).toContain('davon 27 mit Ist-Umsatz');
    // «bis <Datum>» der Ist-Zeile nutzt denselben Stichtag → 28.07.
    expect(screen.getByTestId('pk-ist-row').textContent).toContain('Ist bis 28.07');
  });

  it('Ist-Zeile zeigt PKQ Ist und «bis <Datum>»', () => {
    renderHeadline();
    const row = screen.getByTestId('pk-ist-row');
    expect(row.textContent).toContain('Ist bis 12.07');
    expect(row.textContent).toContain('46.9 %'); // pkqIst
  });

  it('ohne Budget: Abweichungs-Chip fehlt, Budget zeigt «—»', () => {
    renderHeadline({ budgetCHF: null });
    expect(screen.queryByTestId('pk-headline-chip-abw')).toBeNull();
  });

  it('ohne Ist-Umsatz: PKQ Ist zeigt «—»', () => {
    renderHeadline({ pkqIst: null });
    expect(screen.getByTestId('pk-ist-row').textContent).toContain('—');
  });
});
