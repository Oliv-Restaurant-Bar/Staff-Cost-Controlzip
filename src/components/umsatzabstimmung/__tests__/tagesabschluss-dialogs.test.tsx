// @vitest-environment happy-dom
/**
 * tagesabschluss-dialogs.test.tsx — Gutschein- und Barausgaben-Dialog.
 * Prüft: Vorbelegung (Betrag/Nummern/Kommentar aus der Zeile), Save-Payload
 * (Betrag geparst, leeres Feld → null; Nummern kommagetrennt → Array),
 * readOnly-Modus sowie den eigenständigen Barausgaben-Dialog (Total,
 * Hinzufügen/Löschen über den gemeinsamen Editor).
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TagesabschlussVoucherDialog } from '../TagesabschlussVoucherDialog';
import { TagesabschlussExpenseDialog } from '../TagesabschlussExpenseDialog';
import {
  buildTagesabschlussRows,
  emptyTagesabschlussBlob,
  setTagesabschlussOverride,
  upsertManualDay,
  type CashExpense,
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
    { name: 'Gutschein', amount: 60 }, // eingelöste Gutscheine laut Z-Bericht
  ],
  accountingLines: [],
  paymentAccounts: [],
});

function buildRow(mutate?: (blob: ReturnType<typeof emptyTagesabschlussBlob>) => ReturnType<typeof emptyTagesabschlussBlob>) {
  let blob = emptyTagesabschlussBlob();
  if (mutate) blob = mutate(blob);
  const { rows } = buildTagesabschlussRows(2026, 7, { '2026-07-01': closing('2026-07-01') }, blob, {});
  return rows.find(r => r.date === '2026-07-01')!;
}

describe('TagesabschlussVoucherDialog', () => {
  it('belegt Betrag/Nummern vor und liefert beim Speichern den geparsten Payload', () => {
    const now = '2026-07-05T10:00:00.000Z';
    const row = buildRow(b => upsertManualDay(b, '2026-07-01', {
      gutscheinNummernEingeloest: ['GS-1', 'GS-2'],
    }, now));
    const onSave = vi.fn();
    render(<TagesabschlussVoucherDialog ctx={{ date: '2026-07-01', kind: 'eingeloest' }}
      row={row} readOnly={false} onClose={() => {}} onSave={onSave} />);

    // Vorbelegung: Z-Bericht-Wert 60 + vorhandene Nummern.
    expect(screen.getByTestId('ta-voucher-original').textContent).toContain('60.00');
    expect((screen.getByTestId('ta-voucher-betrag') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('ta-voucher-nummern') as HTMLInputElement).value).toBe('GS-1, GS-2');

    fireEvent.change(screen.getByTestId('ta-voucher-betrag'), { target: { value: '75.50' } });
    fireEvent.change(screen.getByTestId('ta-voucher-nummern'), { target: { value: 'GS-1, GS-2, GS-3' } });
    fireEvent.change(screen.getByTestId('ta-voucher-kommentar'), { target: { value: 'Nachtrag' } });
    fireEvent.click(screen.getByTestId('ta-voucher-save'));

    expect(onSave).toHaveBeenCalledWith('2026-07-01', 'eingeloest', {
      betrag: 75.5,
      nummern: ['GS-1', 'GS-2', 'GS-3'],
      kommentar: 'Nachtrag',
    });
  });

  it('leeres Betragsfeld → betrag null (Korrektur entfernen); leere Nummern → null', () => {
    const row = buildRow(b =>
      setTagesabschlussOverride(b, '2026-07-01', 'gutscheinVerkauft', 0, 40, undefined, '2026-07-05T10:00:00.000Z'));
    const onSave = vi.fn();
    render(<TagesabschlussVoucherDialog ctx={{ date: '2026-07-01', kind: 'verkauft' }}
      row={row} readOnly={false} onClose={() => {}} onSave={onSave} />);

    // Korrigierter Wert (40) vorbelegt, "korrigiert"-Badge sichtbar.
    expect((screen.getByTestId('ta-voucher-betrag') as HTMLInputElement).value).toBe('40');
    expect(screen.getByText('korrigiert')).toBeTruthy();

    fireEvent.change(screen.getByTestId('ta-voucher-betrag'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ta-voucher-nummern'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('ta-voucher-save'));

    expect(onSave).toHaveBeenCalledWith('2026-07-01', 'verkauft', {
      betrag: null,
      nummern: null,
      kommentar: '',
    });
  });

  it('readOnly: Eingaben deaktiviert, kein Speichern-Button', () => {
    const row = buildRow();
    render(<TagesabschlussVoucherDialog ctx={{ date: '2026-07-01', kind: 'verkauft' }}
      row={row} readOnly onClose={() => {}} onSave={() => {}} />);
    expect((screen.getByTestId('ta-voucher-betrag') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ta-voucher-nummern') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('ta-voucher-save')).toBeNull();
  });
});

describe('TagesabschlussExpenseDialog', () => {
  const expenses: CashExpense[] = [
    { id: 'e1', date: '2026-07-01', amount: 40, konto: '6000', text: 'Blumen', updatedAt: '2026-07-05T10:00:00.000Z' },
    { id: 'e2', date: '2026-07-01', amount: 12.5, konto: '6001', text: 'Briefmarken', updatedAt: '2026-07-05T10:00:00.000Z' },
  ];

  it('zeigt das automatisch berechnete Total und löscht Einträge über den Editor', () => {
    const onRemoveExpense = vi.fn();
    render(<TagesabschlussExpenseDialog date="2026-07-01" expenses={expenses} readOnly={false}
      onClose={() => {}} onUpsertExpense={() => {}} onRemoveExpense={onRemoveExpense} />);

    expect(screen.getByTestId('ta-expdlg-total').textContent).toContain('52.50');
    expect(screen.getByTestId('ta-expense-e1').textContent).toContain('Blumen');
    fireEvent.click(screen.getByTestId('ta-expense-delete-e2'));
    expect(onRemoveExpense).toHaveBeenCalledWith('2026-07-01', 'e2');
  });

  it('erfasst eine neue Barausgabe über das Formular (Pflichtfelder validiert)', () => {
    const onUpsertExpense = vi.fn();
    render(<TagesabschlussExpenseDialog date="2026-07-01" expenses={[]} readOnly={false}
      onClose={() => {}} onUpsertExpense={onUpsertExpense} onRemoveExpense={() => {}} />);

    // Ohne Betrag/Konto/Text → Fehler, kein Save.
    fireEvent.click(screen.getByTestId('ta-exp-add'));
    expect(onUpsertExpense).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('ta-exp-amount'), { target: { value: '25.90' } });
    fireEvent.change(screen.getByTestId('ta-exp-konto'), { target: { value: '6000' } });
    fireEvent.change(screen.getByTestId('ta-exp-text'), { target: { value: 'Taxi' } });
    fireEvent.change(screen.getByTestId('ta-exp-belegnr'), { target: { value: 'B-77' } });
    fireEvent.click(screen.getByTestId('ta-exp-add'));

    expect(onUpsertExpense).toHaveBeenCalledTimes(1);
    expect(onUpsertExpense.mock.calls[0][0]).toMatchObject({
      date: '2026-07-01', amount: 25.9, konto: '6000', text: 'Taxi', belegNr: 'B-77',
    });
  });

  it('geschlossen (date=null) rendert nichts; readOnly ohne Formular', () => {
    const { container } = render(<TagesabschlussExpenseDialog date={null} expenses={[]} readOnly={false}
      onClose={() => {}} onUpsertExpense={() => {}} onRemoveExpense={() => {}} />);
    expect(container.innerHTML).toBe('');
    cleanup();

    render(<TagesabschlussExpenseDialog date="2026-07-01" expenses={expenses} readOnly
      onClose={() => {}} onUpsertExpense={() => {}} onRemoveExpense={() => {}} />);
    expect(screen.queryByTestId('ta-exp-add')).toBeNull();
    expect(screen.queryByTestId('ta-expense-delete-e1')).toBeNull();
  });
});
