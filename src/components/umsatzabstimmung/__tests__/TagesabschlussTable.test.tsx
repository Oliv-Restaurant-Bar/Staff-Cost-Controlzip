// @vitest-environment happy-dom
/**
 * TagesabschlussTable.test.tsx — Komponententest der Monats-Tabelle.
 * Prüft die gruppierte Spaltenstruktur (Umsatz · Kartenzahlungen · Kasse ·
 * Weitere Zahlungsarten · Ausgaben · Status), entfallene Spalten (Netto,
 * MWST, TWINT, Adyen-Differenz, Bemerkung), die Cash-Spalten (Soll berechnet,
 * Ist manuell, Diff mit Ampel), visuelle Marker (manuell / korrigiert /
 * negativ / Zeilen-Tints), Barausgaben-Total und Status-Badges.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TagesabschlussTable } from '../TagesabschlussTable';
import {
  buildTagesabschlussRows,
  closeDay,
  emptyTagesabschlussBlob,
  reopenDay,
  setCashDiffReasons,
  upsertExpense,
  upsertManualDay,
  setTagesabschlussOverride,
  type GnDayClosing,
} from '@/lib/tagesabschluss';
import { emptyAdyenBlob, type AdyenStoredDay } from '@/lib/adyen-abstimmung';

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
    { name: 'TWINT', amount: 200, count: 1 },
  ],
  accountingLines: [],
  paymentAccounts: [],
});

function buildMonth() {
  let blob = emptyTagesabschlussBlob();
  const now = '2026-07-05T10:00:00.000Z';
  // Manuell: Cash Ist (Bestand Kasse) + Bemerkung + Gutscheinnummern am 01.07.
  // Anker 0: Bargeld Soll 01.07. = 300 (Barumsatz) − 52.50 (Barausgaben) = 247.50
  // → Kassensaldo Soll 247.50 → Ist exakt (Diff 0 grün).
  blob = upsertManualDay(blob, '2026-07-01', {
    bestandKasse: 247.5,
    bemerkung: 'Wechselgeld aufgestockt',
    gutscheinNummernVerkauft: ['GS-4711', 'GS-4712'],
  }, now);
  // Korrektur: Umsatz am 02.07. mit Kommentar (Barumsatz 02.07. dadurch 350).
  blob = setTagesabschlussOverride(blob, '2026-07-02', 'umsatz', 1000, 1050, 'Nachtrag Bankett', now);
  // Zwei Barausgaben am 01.07. — Übersicht zeigt nur das Total.
  blob = upsertExpense(blob, { id: 'e1', date: '2026-07-01', amount: 40, konto: '6000', text: 'Blumen', updatedAt: now });
  blob = upsertExpense(blob, { id: 'e2', date: '2026-07-01', amount: 12.5, konto: '6001', text: 'Briefmarken', updatedAt: now });

  const closings = { '2026-07-01': closing('2026-07-01'), '2026-07-02': closing('2026-07-02') };
  const confirmations = {
    '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: now },
  };
  return { ...buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0), blob, closings, confirmations };
}

/** Wie buildMonth, aber der 01.07. ist definitiv abgeschlossen (gesperrt). */
function buildMonthWithClosedDay() {
  const base = buildMonth();
  const row1 = base.rows.find(r => r.date === '2026-07-01')!;
  const blob = closeDay(base.blob, row1, 'admin@oliv.ch', '2026-07-05T12:00:00.000Z');
  return {
    ...buildTagesabschlussRows(2026, 7, base.closings, blob, base.confirmations, null, 0),
    blob,
    closings: base.closings,
    confirmations: base.confirmations,
  };
}

describe('TagesabschlussTable', () => {
  it('zeigt die neuen Spalten in gruppierter Reihenfolge — entfallene Spalten fehlen', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

    // Gruppenzeile.
    const groupRow = screen.getByTestId('ta-header-groups');
    expect(within(groupRow).getAllByRole('columnheader').map(th => th.textContent)).toEqual([
      'Umsatz', 'Kartenzahlungen', 'Kasse', 'Weitere Zahlungsarten', 'Ausgaben', 'Status',
    ]);

    // Spaltenzeile — exakte Reihenfolge (Kasse-Gruppe zusammenhängend).
    const colRow = screen.getByTestId('ta-header-cols');
    expect(within(colRow).getAllByRole('columnheader').map(th => th.textContent)).toEqual([
      'Datum', 'Umsatz',
      'KK', 'KK Adyen',
      'Bargeld Soll', 'Einzahlung Bank', 'Kassensaldo Soll', 'Cash Ist', 'Cash Diff',
      'Debitoren', 'Verkaufte Gutscheine', 'Eingelöste Gutscheine',
      'Barausgaben',
      'Status',
    ]);

    // Entfallene Spalten erscheinen nirgends mehr.
    for (const gone of ['Netto', 'MWST', 'TWINT', 'Karten/TWINT laut Adyen', 'Adyen-Differenz', 'Bemerkung', 'Bargeld', 'Cash Soll']) {
      expect(screen.queryByText(gone)).toBeNull();
    }

    // Alle Kalendertage des Monats (Juli = 31 Zeilen).
    expect(screen.getAllByTestId(/^ta-row-/)).toHaveLength(31);
  });

  it('KK bündelt Karten + TWINT laut Z-Bericht (TWINT ohne eigene Spalte)', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    // Mastercard 500 + TWINT 200 = 700.
    expect(screen.getByTestId('ta-kk-2026-07-01').textContent).toContain('700.00');
    expect(screen.getByTestId('ta-kk-2026-07-03').textContent).toContain('—');
  });

  it('zeigt Barausgaben nur als Total und markiert manuelle/korrigierte Werte', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

    // Barausgaben-Total 52.50 (40 + 12.50) — Einzelpositionen erscheinen NICHT.
    expect(screen.getAllByText(/52\.50/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Blumen')).toBeNull();
    expect(screen.queryByText('Briefmarken')).toBeNull();
    expect(screen.getByTestId('ta-total-barausgaben').textContent).toContain('52.50');

    // Manuell erfasstes Cash Ist (247.50) blau — Zelle hat die manuelle Klasse.
    const bestandCell = screen.getByTestId('ta-bestand-2026-07-01');
    expect(bestandCell.textContent).toContain('247.50');
    expect(bestandCell.className).toContain('text-sky-700');

    // Korrigierter Umsatz (1050) gelb hinterlegt.
    const row2 = screen.getByTestId('ta-row-2026-07-02');
    const corrected = row2.querySelector('.bg-amber-100');
    expect(corrected?.textContent).toContain('1’050.00');

    // Status-Badges: Arbeitsstand (Bestätigung ODER Korrektur) = „In Bearbeitung".
    // 01.07. bestätigt + 02.07. korrigiert → beide in Bearbeitung, kein „Offen".
    expect(screen.getAllByText('In Bearbeitung').length).toBe(2);
    expect(screen.queryByText('Offen')).toBeNull();
    expect(screen.getAllByText('Kein Z-Bericht').length).toBe(29);
  });

  it('Bargeld Soll / Kassensaldo Soll / Cash Diff: berechnete Spalten, Ampel und Totale', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

    // 01.07.: Bargeld Soll = 300 (Barumsatz) − 52.50 (Barausgaben) = 247.50;
    // Kassensaldo Soll = 0 + 247.50; Ist 247.50 → Diff 0 grün.
    const soll1 = screen.getByTestId('ta-bargeld-soll-2026-07-01');
    expect(soll1.textContent).toContain('247.50');
    expect(soll1.getAttribute('title')).toContain('Bargeld Soll = Umsatz − KK − Rechnung');
    const saldo1 = screen.getByTestId('ta-saldo-2026-07-01');
    expect(saldo1.textContent).toContain('247.50');
    expect(saldo1.getAttribute('title')).toContain('Saldo Vortag + Bargeld Soll − Einzahlung Bank');
    const diff1 = screen.getByTestId('ta-cash-diff-2026-07-01');
    expect(diff1.textContent).toContain('0.00');
    expect(diff1.className).toContain('text-emerald-600');

    // 02.07.: korrigierter Umsatz 1050 → Barumsatz 350; Saldo 247.50 + 350 = 597.50;
    // ohne Cash Ist keine Differenz („—").
    expect(screen.getByTestId('ta-bargeld-soll-2026-07-02').textContent).toContain('350.00');
    expect(screen.getByTestId('ta-saldo-2026-07-02').textContent).toContain('597.50');
    expect(screen.getByTestId('ta-cash-diff-2026-07-02').textContent).toContain('—');

    // Tag ohne Z-Bericht: kein Bargeld Soll, Saldo läuft weiter, keine Differenz.
    expect(screen.getByTestId('ta-bargeld-soll-2026-07-03').textContent).toContain('—');
    expect(screen.getByTestId('ta-saldo-2026-07-03').textContent).toContain('597.50');
    expect(screen.getByTestId('ta-cash-diff-2026-07-03').textContent).toContain('—');

    // Totale: Bargeld Soll 247.50 + 350 = 597.50; Saldo Monatsende 597.50;
    // Ist nur 01.07.; letzte Differenz = 0 (01.07.).
    expect(screen.getByTestId('ta-total-bargeld-soll').textContent).toContain('597.50');
    expect(screen.getByTestId('ta-total-saldo').textContent).toContain('597.50');
    expect(screen.getByTestId('ta-total-cash-ist').textContent).toContain('247.50');
    expect(screen.getByTestId('ta-total-cash-diff').textContent).toContain('0.00');
  });

  it('ohne Anfangsbestand: Saldo/Diff zeigen „—" mit Hinweis-Tooltip', () => {
    let blob = emptyTagesabschlussBlob();
    const now = '2026-07-05T10:00:00.000Z';
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, now);
    const closings = { '2026-07-01': closing('2026-07-01') };
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    // Bargeld Soll ist trotzdem berechenbar; Saldo/Diff nicht (KEINE stille 0).
    expect(screen.getByTestId('ta-bargeld-soll-2026-07-01').textContent).toContain('300.00');
    const saldo = screen.getByTestId('ta-saldo-2026-07-01');
    expect(saldo.textContent).toContain('—');
    expect(saldo.getAttribute('title')).toContain('Anfangsbestand erfassen');
    expect(screen.getByTestId('ta-cash-diff-2026-07-01').textContent).toContain('—');
    expect(screen.getByTestId('ta-total-saldo').textContent).toContain('—');
    expect(screen.getByTestId('ta-total-cash-diff').textContent).toContain('—');
  });

  it('nicht-grüne Differenz: „Begründen"-Button bzw. „Begründet"-Badge (Tooltip = Gründe)', () => {
    let blob = emptyTagesabschlussBlob();
    const now = '2026-07-05T10:00:00.000Z';
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 320 }, now); // Saldo 300 → +20 large
    const closings = { '2026-07-01': closing('2026-07-01') };
    const onReasonsClick = vi.fn();

    // Ohne Begründung: Button „Begründen" öffnet den Grund-Dialog.
    const a = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    const first = render(<TagesabschlussTable rows={a.rows} totals={a.totals} onDayClick={() => {}}
      onReasonsClick={onReasonsClick} />);
    const begruenden = screen.getByTestId('ta-diff-begruenden-2026-07-01') as HTMLElement;
    begruenden.click();
    expect(onReasonsClick).toHaveBeenCalledWith('2026-07-01');
    first.unmount();

    // Mit Grund + Notiz: teal Badge „Begründet", Gründe im Tooltip.
    blob = setCashDiffReasons(blob, '2026-07-01', ['wechselgeld_angepasst'], 'Beleg folgt', now);
    const b = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    render(<TagesabschlussTable rows={b.rows} totals={b.totals} onDayClick={() => {}}
      onReasonsClick={onReasonsClick} />);
    const badge = screen.getByTestId('ta-diff-begruendet-2026-07-01') as HTMLElement;
    expect(badge.textContent).toContain('Begründet');
    expect(badge.getAttribute('title')).toContain('Notiz: Beleg folgt');
    expect(screen.queryByTestId('ta-diff-begruenden-2026-07-01')).toBeNull();

    // readOnly (Gast): Badge bleibt sichtbar, aber ohne Klick-Ziel „Begründen".
    cleanup();
    render(<TagesabschlussTable rows={b.rows} totals={b.totals} onDayClick={() => {}}
      readOnly onReasonsClick={onReasonsClick} />);
    expect(screen.getByTestId('ta-diff-begruendet-2026-07-01')).toBeTruthy();
  });

  it('Bemerkung erscheint NICHT mehr als Spalte — nur als Icon am Datum', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.queryByText('Wechselgeld aufgestockt')).toBeNull();
    const row1 = screen.getByTestId('ta-row-2026-07-01');
    expect(within(row1).getByLabelText('Bemerkung vorhanden')).toBeTruthy();
    expect(screen.queryByTestId('ta-input-bemerkung-2026-07-01')).toBeNull();
  });

  it('Gutscheinnummern werden gespeichert, aber NIE in der Übersicht gerendert', () => {
    const { rows, totals } = buildMonth();
    expect(rows[0].gutscheinNummernVerkauft).toEqual(['GS-4711', 'GS-4712']);
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.queryByText(/GS-4711/)).toBeNull();
    expect(screen.queryByText(/GS-4712/)).toBeNull();
  });

  it('färbt Zeilen nach Zustand: abgeschlossen grün, offen rot — bestätigt allein ist NICHT grün', () => {
    const base = buildMonth();
    // 03.07.: Z-Bericht ohne jeden Arbeitsstand → „offen" (rot).
    const closings = { ...base.closings, '2026-07-03': closing('2026-07-03') };
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, base.blob, base.confirmations, null, 0);
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    // 01.07. nur bestätigt (in Bearbeitung) → KEIN grüner Tint mehr.
    expect(screen.getByTestId('ta-row-2026-07-01').className).not.toContain('bg-green-50');
    expect(screen.getByTestId('ta-row-2026-07-03').className).toContain('bg-red-50');
    cleanup();
    const closed = buildMonthWithClosedDay();
    render(<TagesabschlussTable rows={closed.rows} totals={closed.totals} onDayClick={() => {}} />);
    expect(screen.getByTestId('ta-row-2026-07-01').className).toContain('bg-green-50');
  });

  it('markiert die heutige Zeile (data-today)', () => {
    const t = new Date();
    const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const { rows, totals } = buildTagesabschlussRows(t.getFullYear(), t.getMonth() + 1, {}, emptyTagesabschlussBlob(), {});
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.getByTestId(`ta-row-${iso}`).getAttribute('data-today')).toBe('true');
  });

  it('öffnet das Tagesdetail NUR über die Datum-Zelle', () => {
    const { rows, totals } = buildMonth();
    const onDayClick = vi.fn();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={onDayClick}
      onSaveManual={() => {}} onConfirm={() => {}} />);

    // Klick auf andere Zellen/die Zeile selbst öffnet NICHT.
    (screen.getByTestId('ta-row-2026-07-02') as HTMLElement).click();
    (screen.getByTestId('ta-bestand-2026-07-02') as HTMLElement).click();
    (screen.getByTestId('ta-adyen-2026-07-02') as HTMLElement).click();
    (screen.getByTestId('ta-kk-2026-07-02') as HTMLElement).click();
    expect(onDayClick).not.toHaveBeenCalled();

    // Klick auf das Datum (als Link gestaltet) öffnet.
    const dateBtn = screen.getByTestId('ta-date-2026-07-02') as HTMLElement;
    expect(dateBtn.className).toContain('underline');
    dateBtn.click();
    expect(onDayClick).toHaveBeenCalledTimes(1);
    expect(onDayClick).toHaveBeenCalledWith('2026-07-02');
  });

  describe('Inline-Bearbeitung', () => {
    function renderEditable() {
      const { rows, totals } = buildMonth();
      const onSaveManual = vi.fn();
      const onConfirm = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={onSaveManual} onConfirm={onConfirm} />);
      return { onSaveManual, onConfirm };
    }

    it('speichert Einzahlung Bank bei Blur als Einzel-Feld-Patch', () => {
      const { onSaveManual } = renderEditable();
      const input = screen.getByTestId('ta-input-einzahlung-2026-07-02') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '80' } });
      fireEvent.blur(input);
      expect(onSaveManual).toHaveBeenCalledWith('2026-07-02', { einzahlungBank: 80 });
    });

    it('speichert Cash Ist (Bestand Kasse) bei Enter und leert per Leereingabe (null)', () => {
      const { onSaveManual } = renderEditable();
      const input = screen.getByTestId('ta-input-bestand-2026-07-01') as HTMLInputElement;
      expect(input.value).toBe('247.5'); // vorhandener manueller Wert
      fireEvent.change(input, { target: { value: '900' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
      expect(onSaveManual).toHaveBeenCalledWith('2026-07-01', { bestandKasse: 900 });

      onSaveManual.mockClear();
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(onSaveManual).toHaveBeenCalledWith('2026-07-01', { bestandKasse: null });
    });

    it('verwirft Änderungen mit Escape und speichert nichts bei unverändertem Wert', () => {
      const { onSaveManual } = renderEditable();
      const input = screen.getByTestId('ta-input-einzahlung-2026-07-02') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '999' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
      expect(onSaveManual).not.toHaveBeenCalled();
      expect(input.value).toBe(''); // zurückgesetzt auf den Zellenwert

      // Blur ohne Änderung speichert ebenfalls nicht.
      fireEvent.blur(input);
      expect(onSaveManual).not.toHaveBeenCalled();
    });

    it('markiert manuell erfasste Inline-Werte visuell (blau)', () => {
      renderEditable();
      const manuell = screen.getByTestId('ta-input-bestand-2026-07-01');
      expect(manuell.className).toContain('text-sky-700');
      const leer = screen.getByTestId('ta-input-bestand-2026-07-03');
      expect(leer.className).not.toContain('text-sky-700');
    });

    it('bestätigt Tage über die Checkboxen (nur Tage mit Z-Bericht, gleiche Semantik wie Dialog)', () => {
      const { onConfirm } = renderEditable();
      // Nur 01.07./02.07. haben Z-Bericht → nur dort Checkboxen.
      expect(screen.queryByTestId('ta-row-check-cash-2026-07-03')).toBeNull();

      // 02.07.: unbestätigt → "Tag" erst nach Barbestand möglich.
      const confirmBox = screen.getByTestId('ta-row-check-confirm-2026-07-02') as HTMLButtonElement;
      expect(confirmBox.disabled).toBe(true);
      const cashBox = screen.getByTestId('ta-row-check-cash-2026-07-02') as HTMLButtonElement;
      fireEvent.click(cashBox);
      expect(onConfirm).toHaveBeenCalledWith('2026-07-02',
        expect.objectContaining({ cashCounted: true, confirmed: false }));
    });

    it('rendert im readOnly-Modus (Gast) keinerlei Eingabefelder', () => {
      const { rows, totals } = buildMonth();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        readOnly onSaveManual={() => {}} onConfirm={() => {}}
        onCorrectRechnung={() => {}} onVoucherClick={() => {}} onExpensesClick={() => {}} />);
      expect(screen.queryByTestId('ta-input-bestand-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-input-einzahlung-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-row-check-cash-2026-07-01')).toBeNull();
      // Neue Editier-Flächen ebenfalls NICHT vorhanden.
      expect(screen.queryByTestId('ta-input-rechnung-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-gutschein-verkauft-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-gutschein-eingeloest-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-expenses-2026-07-01')).toBeNull();
      // Werte bleiben als Text sichtbar.
      expect(screen.getByTestId('ta-bestand-2026-07-01').textContent).toContain('247.50');
    });
  });

  describe('Inline-Debitoren, Gutschein- und Barausgaben-Zellen', () => {
    function renderFull() {
      const { rows, totals } = buildMonth();
      const onDayClick = vi.fn();
      const onCorrectRechnung = vi.fn();
      const onVoucherClick = vi.fn();
      const onExpensesClick = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={onDayClick}
        onSaveManual={() => {}} onConfirm={() => {}}
        onCorrectRechnung={onCorrectRechnung}
        onVoucherClick={onVoucherClick}
        onExpensesClick={onExpensesClick} />);
      return { onDayClick, onCorrectRechnung, onVoucherClick, onExpensesClick };
    }

    it('Debitoren inline: Commit ruft onCorrectRechnung mit Original aus dem Z-Bericht', () => {
      const { onCorrectRechnung } = renderFull();
      const input = screen.getByTestId('ta-input-rechnung-2026-07-01') as HTMLInputElement;
      expect(input.value).toBe(''); // Z-Bericht ohne Rechnung-Zahlart → auto null → leer
      fireEvent.change(input, { target: { value: '120' } });
      fireEvent.blur(input);
      expect(onCorrectRechnung).toHaveBeenCalledWith('2026-07-01', 0, 120, undefined);
    });

    it('Debitoren-Korrektur: Input gelb markiert, Leereingabe entfernt (null) mit verankertem Original', () => {
      let blob = emptyTagesabschlussBlob();
      const now = '2026-07-05T10:00:00.000Z';
      blob = setTagesabschlussOverride(blob, '2026-07-01', 'rechnung', 0, 50, 'Bankett auf Rechnung', now);
      const closings = { '2026-07-01': closing('2026-07-01') };
      const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {});
      const onCorrectRechnung = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onCorrectRechnung={onCorrectRechnung} />);

      const input = screen.getByTestId('ta-input-rechnung-2026-07-01') as HTMLInputElement;
      expect(input.value).toBe('50');
      expect(input.className).toContain('bg-amber-50'); // Korrektur = gelb
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      // Original (0) + bestehender Override-Kommentar werden durchgereicht.
      expect(onCorrectRechnung).toHaveBeenCalledWith('2026-07-01', 0, null, 'Bankett auf Rechnung');
    });

    it('Gutschein-Zellen öffnen den Gutschein-Dialog — NICHT das Tagesdetail', () => {
      const { onDayClick, onVoucherClick } = renderFull();
      (screen.getByTestId('ta-gutschein-verkauft-2026-07-01') as HTMLElement).click();
      expect(onVoucherClick).toHaveBeenCalledWith('2026-07-01', 'verkauft');
      (screen.getByTestId('ta-gutschein-eingeloest-2026-07-02') as HTMLElement).click();
      expect(onVoucherClick).toHaveBeenCalledWith('2026-07-02', 'eingeloest');
      expect(onDayClick).not.toHaveBeenCalled();
    });

    it('Barausgaben-Zelle öffnet NUR den Barausgaben-Dialog und zeigt weiterhin das Total', () => {
      const { onDayClick, onExpensesClick } = renderFull();
      const btn = screen.getByTestId('ta-expenses-2026-07-01') as HTMLElement;
      expect(btn.textContent).toContain('52.50'); // Total bleibt in der Zelle
      btn.click();
      expect(onExpensesClick).toHaveBeenCalledWith('2026-07-01');
      expect(onDayClick).not.toHaveBeenCalled();
    });
  });

  it('zeigt KK Adyen farbig nach Differenz-Status (Diff in Klammern, Zeile getönt)', () => {
    const adyenDay = (byMethod: Record<string, number>): AdyenStoredDay => ({
      byMethod,
      countByMethod: {},
      total: Object.values(byMethod).reduce((s, v) => s + v, 0),
      transactionCount: 1,
      fileName: 'adyen.csv',
      importedAt: '2026-07-05T10:00:00.000Z',
    });
    const adyenBlob = {
      ...emptyAdyenBlob(),
      days: {
        // Z-Bericht: Mastercard 500 + TWINT 200 = 700.
        '2026-07-01': adyenDay({ mastercard: 500, twint: 200 }),          // Diff 0 → grün
        '2026-07-02': adyenDay({ mastercard: 490, twint: 200 }),          // Diff 10 → rot
      },
    };
    const blob = emptyTagesabschlussBlob();
    const closings = {
      '2026-07-01': closing('2026-07-01'),
      '2026-07-02': closing('2026-07-02'),
      '2026-07-03': closing('2026-07-03'), // kein Adyen-Import
    };
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {}, adyenBlob);
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

    // Diff 0 → grün, KEIN Klammer-Diff.
    const okCell = screen.getByTestId('ta-adyen-2026-07-01');
    expect(okCell.textContent).toContain('700.00');
    expect(okCell.className).toContain('text-emerald-600');
    expect(okCell.textContent).not.toContain('(');

    // Diff 10 → rot, Diff in Klammern, Zeile rot getönt.
    const badCell = screen.getByTestId('ta-adyen-2026-07-02');
    expect(badCell.textContent).toContain('690.00');
    expect(badCell.textContent).toContain('10.00');
    expect(badCell.className).toContain('text-red-600');
    expect(screen.getByTestId('ta-row-2026-07-02').className).toContain('bg-red-50');

    // Tag ohne Adyen-Import: Zelle leer ("—").
    expect(screen.getByTestId('ta-adyen-2026-07-03').textContent).toContain('—');

    // Totale: Adyen-Summe + Summe der Tages-Differenzen (im selben Total-Feld).
    expect(screen.getByTestId('ta-total-adyen').textContent).toContain('1’390.00');
    expect(screen.getByTestId('ta-total-adyen-diff').textContent).toContain('10.00');
  });

  describe('KK-/KK-Adyen-Popover (Zusammensetzung)', () => {
    const closingMitRaren = (date: string): GnDayClosing => ({
      ...closing(date),
      payments: [
        { name: 'Bar', amount: 300, count: 1 },
        { name: 'Mastercard', amount: 500, count: 1 },
        { name: 'Visa', amount: 100, count: 1 },
        { name: 'TWINT', amount: 200, count: 1 },
        { name: 'PostFinance Card', amount: 50, count: 1 },
        { name: 'Lunch-Check', amount: 25, count: 1 },
      ],
    });
    const adyenDay = (byMethod: Record<string, number>): AdyenStoredDay => ({
      byMethod,
      countByMethod: {},
      total: Object.values(byMethod).reduce((s, v) => s + v, 0),
      transactionCount: 1,
      fileName: 'adyen.csv',
      importedAt: '2026-07-05T10:00:00.000Z',
    });

    function renderPopoverMonth() {
      const adyenBlob = {
        ...emptyAdyenBlob(),
        days: { '2026-07-01': adyenDay({ mastercard: 500, visa: 100, twint: 200 }) },
      };
      const closings = { '2026-07-01': closingMitRaren('2026-07-01') };
      const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {}, adyenBlob);
      const onDayClick = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={onDayClick} />);
      return { onDayClick };
    }

    it('KK-Zelle öffnet Popover mit Zusammensetzung (inkl. TWINT + PostCard/Lunch-Check) und fettem Total — ohne Tagesdetail', () => {
      const { onDayClick } = renderPopoverMonth();
      // KK = 500 + 100 + 200 + 50 + 25 = 875.
      const btn = screen.getByTestId('ta-kk-btn-2026-07-01') as HTMLElement;
      expect(btn.textContent).toContain('875.00');
      fireEvent.click(btn);

      const pop = screen.getByTestId('ta-kk-popover-2026-07-01');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-mastercard').textContent).toContain('500.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-visa').textContent).toContain('100.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-twint').textContent).toContain('200.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-postcard').textContent).toContain('50.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-lunch_check').textContent).toContain('25.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-total').textContent).toContain('875.00');
      // Reihenfolge: Mastercard, Visa, TWINT, dann seltene Karten.
      expect(pop.textContent!.indexOf('Mastercard')).toBeLessThan(pop.textContent!.indexOf('Visa'));
      expect(pop.textContent!.indexOf('Visa')).toBeLessThan(pop.textContent!.indexOf('TWINT'));
      // KEIN Adyen-Hinweis im KK-Popover, kein Tagesdetail geöffnet.
      expect(within(pop).queryByTestId('ta-kk-breakdown-2026-07-01-hinweis')).toBeNull();
      expect(onDayClick).not.toHaveBeenCalled();
    });

    it('KK-Adyen-Popover zeigt NUR Adyen-Arten, Hinweistext und die Sektion „Nicht über Adyen"', () => {
      const { onDayClick } = renderPopoverMonth();
      const btn = screen.getByTestId('ta-adyen-btn-2026-07-01') as HTMLElement;
      fireEvent.click(btn);

      const pop = screen.getByTestId('ta-adyen-popover-2026-07-01');
      // Nur über Adyen abgewickelte Arten (Mastercard/Visa/TWINT), Total 800.
      expect(within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-mastercard').textContent).toContain('500.00');
      expect(within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-visa').textContent).toContain('100.00');
      expect(within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-twint').textContent).toContain('200.00');
      expect(within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-total').textContent).toContain('800.00');
      // Hinweistext.
      expect(within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-hinweis').textContent)
        .toContain('KK Adyen enthält nur Zahlungsarten, die über Adyen verarbeitet werden');
      // Nicht über Adyen: PostCard + Lunch-Check mit Beträgen (Diff 875−800 = 75 → Sektion sichtbar).
      const nicht = within(pop).getByTestId('ta-adyen-breakdown-2026-07-01-nicht-adyen');
      expect(nicht.textContent).toContain('Nicht über Adyen');
      expect(within(nicht).getByTestId('ta-adyen-breakdown-2026-07-01-nicht-adyen-postcard').textContent).toContain('50.00');
      expect(within(nicht).getByTestId('ta-adyen-breakdown-2026-07-01-nicht-adyen-lunch_check').textContent).toContain('25.00');
      expect(onDayClick).not.toHaveBeenCalled();
    });

    it('KK-Popover zeigt Posten „Korrektur (manuell)" bei Karten-Override (Total = effektiver Zellwert)', () => {
      // Karten-Auto = 675 (MC 500 + Visa 100 + PostCard 50 + Lunch-Check 25),
      // Override auf 700 → KK-Zelle = 700 + 200 (TWINT) = 900; Breakdown-Summe
      // bleibt 875 (auto) → Korrektur-Posten +25.
      let blob = emptyTagesabschlussBlob();
      blob = setTagesabschlussOverride(blob, '2026-07-01', 'karten', 675, 700, 'Nachtrag', '2026-07-05T10:00:00.000Z');
      const closings = { '2026-07-01': closingMitRaren('2026-07-01') };
      const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {});
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

      const btn = screen.getByTestId('ta-kk-btn-2026-07-01') as HTMLElement;
      expect(btn.textContent).toContain('900.00');
      fireEvent.click(btn);

      const pop = screen.getByTestId('ta-kk-popover-2026-07-01');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-korrektur').textContent).toContain('25.00');
      expect(within(pop).getByTestId('ta-kk-breakdown-2026-07-01-total').textContent).toContain('900.00');
    });
  });

  describe('Abschluss & Sperrung', () => {
    it('Abschluss-Button: aktiv nur bei erfüllten Vorbedingungen, klick meldet das Datum', () => {
      const { rows, totals } = buildMonth();
      const onCloseDay = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCloseDay={onCloseDay} />);

      // 01.07.: bestätigt + Barbestand + Cash Ist + Diff grün → aktiv.
      const btn1 = screen.getByTestId('ta-close-day-2026-07-01') as HTMLButtonElement;
      expect(btn1.disabled).toBe(false);
      btn1.click();
      expect(onCloseDay).toHaveBeenCalledWith('2026-07-01');

      // 02.07.: unbestätigt → deaktiviert, Blocker im title.
      const btn2 = screen.getByTestId('ta-close-day-2026-07-02') as HTMLButtonElement;
      expect(btn2.disabled).toBe(true);
      expect(btn2.getAttribute('title')).toContain('Tagesbestätigung fehlt');
      btn2.click();
      expect(onCloseDay).toHaveBeenCalledTimes(1);

      // Tage ohne Z-Bericht haben gar keinen Abschluss-Button.
      expect(screen.queryByTestId('ta-close-day-2026-07-03')).toBeNull();
    });

    it('gesperrter Tag: Lock-Icon, Badge „Abgeschlossen", keine Edit-Flächen, kein Abschluss-Button', () => {
      const { rows, totals } = buildMonthWithClosedDay();
      const onCloseDay = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCorrectRechnung={() => {}}
        onVoucherClick={() => {}} onExpensesClick={() => {}} onCloseDay={onCloseDay} />);

      // Lock-Icon am Datum + grüner Badge mit Abschluss-Info im title.
      expect(screen.getByTestId('ta-lock-2026-07-01')).toBeTruthy();
      const badge = screen.getByText('Abgeschlossen');
      expect(badge.closest('span')?.getAttribute('title')).toContain('admin@oliv.ch');

      // Zeile 01.07.: KEINE Inputs/Checkboxen/Buttons für Edits mehr.
      const row1 = screen.getByTestId('ta-row-2026-07-01');
      expect(row1.querySelectorAll('input').length).toBe(0);
      expect(screen.queryByTestId('ta-close-day-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-row-check-cash-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-gutschein-verkauft-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-expenses-2026-07-01')).toBeNull();

      // Unbeteiligte Zeile 02.07. bleibt editierbar (Inline-Inputs vorhanden).
      const row2 = screen.getByTestId('ta-row-2026-07-02');
      expect(row2.querySelectorAll('input').length).toBeGreaterThan(0);
    });

    it('wieder geöffneter Tag: orange Badge, Edit-Flächen und Abschluss-Button wieder da', () => {
      const closedState = buildMonthWithClosedDay();
      const blob = reopenDay(closedState.blob, '2026-07-01', 'admin@oliv.ch', 'Beleg nachtragen', '2026-07-06T08:00:00.000Z');
      const { rows, totals } = buildTagesabschlussRows(2026, 7, closedState.closings, blob, closedState.confirmations, null, 0);
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCloseDay={() => {}} />);

      expect(screen.getByText('Wieder geöffnet')).toBeTruthy();
      const row1 = screen.getByTestId('ta-row-2026-07-01');
      expect(row1.className).toContain('bg-orange-50');
      expect(row1.querySelectorAll('input').length).toBeGreaterThan(0);
      expect(screen.getByTestId('ta-close-day-2026-07-01')).toBeTruthy();
      expect(screen.queryByTestId('ta-lock-2026-07-01')).toBeNull();
    });

    it('needsReview: Warn-Icon am Saldo, wenn der fixierte Saldo vom neu berechneten abweicht', () => {
      const closedState = buildMonthWithClosedDay();
      // Anfangsbestand nachträglich geändert (0 → 100): berechneter Saldo
      // weicht vom fixierten (247.50) ab → Überprüfungs-Marker.
      const { rows, totals } = buildTagesabschlussRows(
        2026, 7, closedState.closings, closedState.blob, closedState.confirmations, null, 100);
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);

      expect(rows.find(r => r.date === '2026-07-01')?.needsReview).toBe(true);
      expect(screen.getByTestId('ta-review-2026-07-01')).toBeTruthy();
      // Gesperrte Zeile zeigt weiterhin den FIXIERTEN Saldo (247.50), nicht den neuen.
      expect(screen.getByTestId('ta-saldo-2026-07-01').textContent).toContain('247.50');
    });
  });
});
