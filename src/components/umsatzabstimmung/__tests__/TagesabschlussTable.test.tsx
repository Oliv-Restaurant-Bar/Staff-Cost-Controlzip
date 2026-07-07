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
  emptyTagesabschlussBlob,
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
  return { ...buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0), blob };
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

    // Status-Badges.
    expect(screen.getByText('Bestätigt')).toBeTruthy();   // 01.07. bestätigt
    expect(screen.getByText('Offen')).toBeTruthy();       // 02.07. Z-Bericht, unbestätigt
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

  it('färbt Zeilen nach Zustand: bestätigt grün, offen rot', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.getByTestId('ta-row-2026-07-01').className).toContain('bg-green-50');
    expect(screen.getByTestId('ta-row-2026-07-02').className).toContain('bg-red-50');
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
});
