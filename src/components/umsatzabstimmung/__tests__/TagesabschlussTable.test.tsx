// @vitest-environment happy-dom
/**
 * TagesabschlussTable.test.tsx — Komponententest der Monats-Tabelle.
 * Prüft Spaltenstruktur (Excel "UMSATZ Oliv"), visuelle Marker (manuell /
 * korrigiert / Kommentar), Barausgaben-Total und Status-Badges.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TagesabschlussTable } from '../TagesabschlussTable';
import {
  buildTagesabschlussRows,
  emptyTagesabschlussBlob,
  upsertExpense,
  upsertManualDay,
  setTagesabschlussOverride,
  type GnDayClosing,
} from '@/lib/tagesabschluss';

afterEach(cleanup);

const closing = (date: string): GnDayClosing => ({
  date,
  grossRevenue: 1000,
  netRevenue: 925.07,
  tip: null,
  taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
  payments: [
    { name: 'Bar', amount: 300 },
    { name: 'Mastercard', amount: 500 },
    { name: 'TWINT', amount: 200 },
  ],
  accountingLines: [],
  paymentAccounts: [],
});

function buildMonth() {
  let blob = emptyTagesabschlussBlob();
  const now = '2026-07-05T10:00:00.000Z';
  // Manuell: Bestand Kasse + Bemerkung am 01.07.
  blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 850, bemerkung: 'Wechselgeld aufgestockt' }, now);
  // Korrektur: Umsatz am 02.07. mit Kommentar.
  blob = setTagesabschlussOverride(blob, '2026-07-02', 'umsatz', 1000, 1050, 'Nachtrag Bankett', now);
  // Zwei Barausgaben am 01.07. — Übersicht zeigt nur das Total.
  blob = upsertExpense(blob, { id: 'e1', date: '2026-07-01', amount: 40, konto: '6000', text: 'Blumen', updatedAt: now });
  blob = upsertExpense(blob, { id: 'e2', date: '2026-07-01', amount: 12.5, konto: '6001', text: 'Briefmarken', updatedAt: now });

  const closings = { '2026-07-01': closing('2026-07-01'), '2026-07-02': closing('2026-07-02') };
  const confirmations = {
    '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: now },
  };
  return { ...buildTagesabschlussRows(2026, 7, closings, blob, confirmations), blob };
}

describe('TagesabschlussTable', () => {
  it('zeigt alle Spalten analog Excel "UMSATZ Oliv"', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    for (const h of [
      'Datum', 'Umsatz', 'Netto', 'MWST', 'Bargeld / Barumsatz', 'Bestand Kasse',
      'Kreditkarten / Adyen / SIX', 'TWINT', 'Rechnung / Debitoren',
      'Verkaufte Gutscheine', 'Eingelöste Gutscheine', 'Barausgaben total',
      'Einzahlung Bank', 'Bemerkung', 'Status',
    ]) {
      expect(screen.getByText(h)).toBeTruthy();
    }
    // Alle Kalendertage des Monats (Juli = 31 Zeilen).
    expect(screen.getAllByTestId(/^ta-row-/)).toHaveLength(31);
  });

  it('zeigt Barausgaben nur als Total und markiert manuelle/korrigierte Werte', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

    // Barausgaben-Total 52.50 (40 + 12.50) — Einzelpositionen erscheinen NICHT.
    expect(screen.getAllByText(/52\.50/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Blumen')).toBeNull();
    expect(screen.queryByText('Briefmarken')).toBeNull();
    expect(screen.getByTestId('ta-total-barausgaben').textContent).toContain('52.50');

    // Manuell erfasster Bestand (850) blau/fett — Zelle hat die manuelle Klasse.
    const bestandCell = screen.getByTestId('ta-bestand-2026-07-01');
    expect(bestandCell.textContent).toContain('850.00');
    expect(bestandCell.className).toContain('text-sky-700');

    // Korrigierter Umsatz (1050) gelb hinterlegt.
    const row2 = screen.getByTestId('ta-row-2026-07-02');
    const corrected = row2.querySelector('.bg-amber-100');
    expect(corrected?.textContent).toContain('1’050.00');

    // Bemerkung + Status-Badges.
    expect(screen.getByText('Wechselgeld aufgestockt')).toBeTruthy();
    expect(screen.getByText('Bestätigt')).toBeTruthy();   // 01.07. bestätigt
    expect(screen.getByText('Offen')).toBeTruthy();       // 02.07. Z-Bericht, unbestätigt
    expect(screen.getAllByText('Kein Z-Bericht').length).toBe(29);
  });

  it('meldet Tages-Klicks mit dem Datum', () => {
    const { rows, totals } = buildMonth();
    const onDayClick = vi.fn();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={onDayClick} />);
    (screen.getByTestId('ta-row-2026-07-02') as HTMLElement).click();
    expect(onDayClick).toHaveBeenCalledWith('2026-07-02');
  });
});
