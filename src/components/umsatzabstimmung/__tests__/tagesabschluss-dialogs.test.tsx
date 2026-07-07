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
import { TagesabschlussDayDialog } from '../TagesabschlussDayDialog';
import {
  buildTagesabschlussRows,
  closeDay,
  emptyTagesabschlussBlob,
  reopenDay,
  setTagesabschlussOverride,
  upsertManualDay,
  type CashExpense,
  type GnDayClosing,
  type TagesabschlussBlob,
} from '@/lib/tagesabschluss';

afterEach(cleanup);

const closing = (date: string): GnDayClosing => ({
  date,
  grossRevenue: 1000,
  netRevenue: 925.07,
  tip: null,
  taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
  payments: [
    { name: 'Bar', amount: 300, count: 1 },
    { name: 'Mastercard', amount: 500, count: 1 },
    { name: 'Gutschein', amount: 60, count: 1 }, // eingelöste Gutscheine laut Z-Bericht
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

describe('TagesabschlussDayDialog — Zahlungsarten-Sektion', () => {
  function rowWithRarePayments() {
    const c: GnDayClosing = {
      ...closing('2026-07-01'),
      payments: [
        { name: 'Bar', amount: 300, count: 1 },
        { name: 'Mastercard', amount: 400, count: 1 },
        { name: 'PostCard', amount: 50, count: 1 },
        { name: 'KD Tisch 5000', amount: 40, count: 1 },
      ],
    };
    const { rows } = buildTagesabschlussRows(2026, 7, { '2026-07-01': c }, emptyTagesabschlussBlob(), {});
    return rows.find(r => r.date === '2026-07-01')!;
  }

  function renderDay(row: ReturnType<typeof rowWithRarePayments>) {
    render(<TagesabschlussDayDialog row={row} expenses={[]} readOnly={false} canReopen={false}
      onClose={() => {}} onSaveManual={() => {}} onOverride={() => {}} onConfirm={() => {}}
      onUpsertExpense={() => {}} onRemoveExpense={() => {}}
      onCloseDay={() => {}} onReopenDay={() => {}} />);
  }

  it('„Weitere Zahlungsarten" standardmässig ZUgeklappt; Klick zeigt Liste mit KK-Kennzeichnung', () => {
    renderDay(rowWithRarePayments());

    const toggle = screen.getByTestId('ta-weitere-zahlungsarten-toggle');
    expect(toggle.textContent).toContain('Weitere Zahlungsarten (2)');
    expect(screen.queryByTestId('ta-weitere-zahlungsarten-list')).toBeNull();

    fireEvent.click(toggle);
    const list = screen.getByTestId('ta-weitere-zahlungsarten-list');
    expect(screen.getByTestId('ta-weitere-zahlungsart-postcard').textContent).toContain('50.00');
    expect(screen.getByTestId('ta-weitere-zahlungsart-kd_tisch_5000').textContent).toContain('40.00');
    expect(list.textContent).toContain('im KK-Total enthalten');
    expect(list.textContent).toContain('in keiner Berechnung enthalten');

    // Erneuter Klick klappt wieder zu.
    fireEvent.click(toggle);
    expect(screen.queryByTestId('ta-weitere-zahlungsarten-list')).toBeNull();
  });

  it('Sektion erscheint NICHT ohne seltene/unklassifizierte Zahlarten', () => {
    const { rows } = buildTagesabschlussRows(2026, 7, { '2026-07-01': closing('2026-07-01') }, emptyTagesabschlussBlob(), {});
    renderDay(rows.find(r => r.date === '2026-07-01')!);
    expect(screen.queryByTestId('ta-dialog-zahlungsarten')).toBeNull();
  });
});

describe('TagesabschlussDayDialog — Abschluss-Sektion', () => {
  const NOW = '2026-07-05T10:00:00.000Z';

  /** Blob + Bestätigungen, die canCloseDay am 01.07. erfüllen:
   *  Bargeld Soll = 1000 − 500 (KK) − 60 (eingelöste Gutscheine) = 440;
   *  Kassensaldo Soll = 0 + 440; Cash Ist 440 → Diff 0 grün. */
  function closableSetup() {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 440 }, NOW);
    const confirmations = {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    };
    return { blob, confirmations };
  }

  function rowFor(blob: TagesabschlussBlob, confirmations: Parameters<typeof buildTagesabschlussRows>[4]) {
    const { rows } = buildTagesabschlussRows(2026, 7, { '2026-07-01': closing('2026-07-01') }, blob, confirmations, null, 0);
    return rows.find(r => r.date === '2026-07-01')!;
  }

  function renderDialog(row: ReturnType<typeof rowFor>, opts?: {
    readOnly?: boolean; canReopen?: boolean;
    onCloseDay?: (d: string) => void; onReopenDay?: (d: string, r: string) => void;
  }) {
    render(<TagesabschlussDayDialog row={row} expenses={[]}
      readOnly={opts?.readOnly ?? false} canReopen={opts?.canReopen ?? true}
      onClose={() => {}} onSaveManual={() => {}} onOverride={() => {}} onConfirm={() => {}}
      onUpsertExpense={() => {}} onRemoveExpense={() => {}}
      onCloseDay={opts?.onCloseDay ?? (() => {})} onReopenDay={opts?.onReopenDay ?? (() => {})} />);
  }

  it('Abschluss-Button: aktiv bei erfüllten Vorbedingungen, sonst deaktiviert mit Blocker-Liste', () => {
    const { blob, confirmations } = closableSetup();
    const onCloseDay = vi.fn();
    renderDialog(rowFor(blob, confirmations), { onCloseDay });

    const btn = screen.getByTestId('ta-dialog-close-day') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId('ta-dialog-close-blockers')).toBeNull();
    fireEvent.click(btn);
    expect(onCloseDay).toHaveBeenCalledWith('2026-07-01');
    cleanup();

    // Unbestätigter Tag → deaktiviert + Blocker gelistet.
    renderDialog(rowFor(emptyTagesabschlussBlob(), {}), { onCloseDay });
    const btn2 = screen.getByTestId('ta-dialog-close-day') as HTMLButtonElement;
    expect(btn2.disabled).toBe(true);
    expect(screen.getByTestId('ta-dialog-close-blockers').textContent).toContain('Tagesbestätigung fehlt');
    expect(onCloseDay).toHaveBeenCalledTimes(1);
  });

  it('gesperrter Tag: Locked-Info, Felder deaktiviert, Reopen NUR mit Grund und nur für Admins', () => {
    const { blob, confirmations } = closableSetup();
    const closedBlob = closeDay(blob, rowFor(blob, confirmations), 'admin@oliv.ch', '2026-07-05T12:00:00.000Z');
    const lockedRow = rowFor(closedBlob, confirmations);
    const onReopenDay = vi.fn();
    renderDialog(lockedRow, { canReopen: true, onReopenDay });

    // Locked-Info mit Wer/Wann + fixiertem Saldo; kein Abschluss-Button mehr.
    expect(screen.getByTestId('ta-dialog-locked-info').textContent).toContain('admin@oliv.ch');
    expect(screen.getByTestId('ta-dialog-locked-info').textContent).toContain('440.00');
    expect(screen.queryByTestId('ta-dialog-close-day')).toBeNull();

    // Manuelle Felder + Bestätigungs-Checkboxen gesperrt.
    expect((screen.getByTestId('ta-input-bestand') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ta-input-einzahlung') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ta-input-bemerkung') as HTMLTextAreaElement).disabled).toBe(true);

    // Reopen: Button erst nach Pflicht-Grund aktiv.
    const reopenBtn = screen.getByTestId('ta-reopen-day') as HTMLButtonElement;
    expect(reopenBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ta-reopen-reason'), { target: { value: 'Beleg nachtragen' } });
    expect((screen.getByTestId('ta-reopen-day') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('ta-reopen-day'));
    expect(onReopenDay).toHaveBeenCalledWith('2026-07-01', 'Beleg nachtragen');
    cleanup();

    // Ohne canReopen (kein Admin) gibt es KEINE Reopen-Fläche.
    renderDialog(lockedRow, { canReopen: false });
    expect(screen.queryByTestId('ta-dialog-reopen')).toBeNull();
    expect(screen.queryByTestId('ta-reopen-day')).toBeNull();
  });

  it('wieder geöffneter Tag: Info mit Grund, Felder editierbar, Historie mit beiden Einträgen', () => {
    const { blob, confirmations } = closableSetup();
    let b = closeDay(blob, rowFor(blob, confirmations), 'admin@oliv.ch', '2026-07-05T12:00:00.000Z');
    b = reopenDay(b, '2026-07-01', 'admin@oliv.ch', 'Beleg nachtragen', '2026-07-06T08:00:00.000Z');
    renderDialog(rowFor(b, confirmations));

    const info = screen.getByTestId('ta-dialog-reopened-info');
    expect(info.textContent).toContain('Beleg nachtragen');
    expect(screen.queryByTestId('ta-dialog-locked-info')).toBeNull();
    expect((screen.getByTestId('ta-input-bestand') as HTMLInputElement).disabled).toBe(false);
    // Erneuter Abschluss möglich.
    expect(screen.getByTestId('ta-dialog-close-day')).toBeTruthy();

    const history = screen.getByTestId('ta-dialog-closure-history');
    expect(history.querySelectorAll('li').length).toBe(2);
    expect(history.textContent).toContain('abgeschlossen');
    expect(history.textContent).toContain('wieder geöffnet');
  });
});
