// @vitest-environment happy-dom
/**
 * TagesabschlussTable.test.tsx — Komponententest der Monats-Tabelle.
 * Prüft die FIXE Spaltenreihenfolge (Datum · Umsatz · BAR SOLL · BAR IST ·
 * Kassensaldo Soll · Differenz · KK Adyen · Debitoren · Barausgaben ·
 * EG-Gutscheine · [Detail: Einzahlung Bank · Bargeld Soll (ber.) · KK ·
 * V-Gutscheine] · Status), entfallene Spalten (Netto, MWST, TWINT,
 * Adyen-Differenz, Bemerkung), die Bar-Spalten (Soll aus Z-Bericht, Ist
 * manuell, Differenz mit Ampel), visuelle Marker (manuell / korrigiert /
 * negativ / Zeilen-Tints), Barausgaben-Total und Status-Badges.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TAGESABSCHLUSS_COLUMNS, TagesabschlussTable, visibleTagesabschlussColumns } from '../TagesabschlussTable';
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
  it('zeigt die Spalten in der FIXEN Reihenfolge — entfallene Spalten fehlen', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

    // EINE Header-Zeile — exakte Reihenfolge (10 fixe Spalten, dann
    // Detail-Spalten der Voll-Ansicht, zuletzt Status).
    const colRow = screen.getByTestId('ta-header-cols');
    expect(within(colRow).getAllByRole('columnheader').map(th => th.textContent)).toEqual([
      'Datum', 'Umsatz',
      'BAR SOLL', 'BAR IST', 'Kassensaldo Soll', 'Differenz',
      'KK Adyen', 'Debitoren',
      'Barausgaben',
      'EG-Gutscheine',
      'Einzahlung Bank', 'Bargeld Soll (ber.)', 'KK', 'V-Gutscheine',
      'Status',
    ]);
    // Keine Gruppen-Kopfzeile mehr.
    expect(screen.queryByTestId('ta-header-groups')).toBeNull();

    // Entfallene Spalten erscheinen nirgends mehr.
    for (const gone of ['Netto', 'MWST', 'TWINT', 'Karten/TWINT laut Adyen', 'Adyen-Differenz', 'Bemerkung', 'Bargeld', 'Cash Soll', 'Cash Ist', 'Cash Diff']) {
      expect(screen.queryByText(gone)).toBeNull();
    }

    // Alle Kalendertage des Monats (Juli = 31 Zeilen) — NUR Datumszeilen,
    // nicht die ta-row-check-*-Checkboxen.
    expect(screen.getAllByTestId(/^ta-row-\d{4}-\d{2}-\d{2}$/)).toHaveLength(31);
  });

  it('KK bündelt Karten + TWINT laut Z-Bericht (TWINT ohne eigene Spalte)', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
    // Mastercard 500 + TWINT 200 = 700.
    expect(screen.getByTestId('ta-kk-2026-07-01').textContent).toContain('700.00');
    expect(screen.getByTestId('ta-kk-2026-07-03').textContent).toContain('—');
  });

  it('zeigt Barausgaben nur als Total und markiert manuelle/korrigierte Werte', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

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

    // Status-Badges (kompakt): alles Nicht-Abgeschlossene = amber «Offen» —
    // 01.07. (bestätigt) + 02.07. (korrigiert). Tage ohne Z-Bericht = «—».
    expect(screen.getAllByText('Offen').length).toBe(2);
    expect(screen.queryByText('In Bearbeitung')).toBeNull();
    expect(screen.getAllByTestId(/^ta-status-badge-/).length).toBe(31);
  });

  it('Bargeld Soll (ber.) / Kassensaldo Soll / Differenz: berechnete Spalten, Ampel und Totale', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

    // 01.07.: Bargeld Soll = 300 (Barumsatz) − 52.50 (Barausgaben) = 247.50;
    // Kassensaldo Soll = 0 + 247.50; Ist 247.50 → Diff 0 grün.
    const soll1 = screen.getByTestId('ta-bargeld-soll-2026-07-01');
    expect(soll1.textContent).toContain('247.50');
    expect(soll1.getAttribute('title')).toContain('Bargeld Soll (berechnet) = Umsatz − KK − Rechnung');
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
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
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
    const first = render(<TagesabschlussTable showAllColumns rows={a.rows} totals={a.totals} onDayClick={() => {}}
      onReasonsClick={onReasonsClick} />);
    const begruenden = screen.getByTestId('ta-diff-begruenden-2026-07-01') as HTMLElement;
    begruenden.click();
    expect(onReasonsClick).toHaveBeenCalledWith('2026-07-01');
    first.unmount();

    // Mit Grund + Notiz: teal Badge „Begründet", Gründe im Tooltip.
    blob = setCashDiffReasons(blob, '2026-07-01', ['wechselgeld_angepasst'], 'Beleg folgt', now);
    const b = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    render(<TagesabschlussTable showAllColumns rows={b.rows} totals={b.totals} onDayClick={() => {}}
      onReasonsClick={onReasonsClick} />);
    const badge = screen.getByTestId('ta-diff-begruendet-2026-07-01') as HTMLElement;
    expect(badge.textContent).toContain('Begründet');
    expect(badge.getAttribute('title')).toContain('Notiz: Beleg folgt');
    expect(screen.queryByTestId('ta-diff-begruenden-2026-07-01')).toBeNull();

    // readOnly (Gast): Badge bleibt sichtbar, aber ohne Klick-Ziel „Begründen".
    cleanup();
    render(<TagesabschlussTable showAllColumns rows={b.rows} totals={b.totals} onDayClick={() => {}}
      readOnly onReasonsClick={onReasonsClick} />);
    expect(screen.getByTestId('ta-diff-begruendet-2026-07-01')).toBeTruthy();
  });

  it('Bemerkung erscheint NICHT mehr als Spalte — nur als Icon am Datum', () => {
    const { rows, totals } = buildMonth();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.queryByText('Wechselgeld aufgestockt')).toBeNull();
    const row1 = screen.getByTestId('ta-row-2026-07-01');
    expect(within(row1).getByLabelText('Bemerkung vorhanden')).toBeTruthy();
    expect(screen.queryByTestId('ta-input-bemerkung-2026-07-01')).toBeNull();
  });

  it('Gutscheinnummern werden gespeichert, aber NIE in der Übersicht gerendert', () => {
    const { rows, totals } = buildMonth();
    expect(rows[0].gutscheinNummernVerkauft).toEqual(['GS-4711', 'GS-4712']);
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.queryByText(/GS-4711/)).toBeNull();
    expect(screen.queryByText(/GS-4712/)).toBeNull();
  });

  it('schlichtes Design: KEINE Zustands-Tints auf Zeilen — Status nur via Badge', () => {
    const base = buildMonth();
    // 03.07.: Z-Bericht ohne jeden Arbeitsstand → „offen" (Badge, kein Zeilen-Tint).
    const closings = { ...base.closings, '2026-07-03': closing('2026-07-03') };
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, base.blob, base.confirmations, null, 0);
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.getByTestId('ta-row-2026-07-01').className).not.toContain('bg-green-50');
    expect(screen.getByTestId('ta-row-2026-07-03').className).not.toContain('bg-red-50');
    expect(screen.getAllByText('Offen').length).toBeGreaterThanOrEqual(1);
    cleanup();
    const closed = buildMonthWithClosedDay();
    render(<TagesabschlussTable showAllColumns rows={closed.rows} totals={closed.totals} onDayClick={() => {}} />);
    expect(screen.getByTestId('ta-row-2026-07-01').className).not.toContain('bg-green-50');
    // Abgeschlossen = grünes Badge «Grün» (Details im Status-Popup).
    expect(screen.getByText('Grün')).toBeTruthy();
  });

  it('markiert die heutige Zeile (data-today)', () => {
    const t = new Date();
    const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const { rows, totals } = buildTagesabschlussRows(t.getFullYear(), t.getMonth() + 1, {}, emptyTagesabschlussBlob(), {});
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);
    expect(screen.getByTestId(`ta-row-${iso}`).getAttribute('data-today')).toBe('true');
  });

  it('öffnet das Tagesdetail NUR über die Datum-Zelle', () => {
    const { rows, totals } = buildMonth();
    const onDayClick = vi.fn();
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={onDayClick}
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

  describe('Umsatz-Spalte: Import massgeblich, Abgleich gegen Z-Bericht', () => {
    it('zeigt den Import-Wert; rot + klickbar nur bei |Import − Z| > Schwelle', () => {
      const base = buildMonth(); // Z-Bericht 01.07. = 1000
      const { rows, totals } = buildTagesabschlussRows(2026, 7, base.closings, base.blob, base.confirmations, null, 0);
      const onDiff = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        umsatzImport={{ '2026-07-01': 1025.5 }} umsatzSchwelle={10} onUmsatzDiffClick={onDiff} />);
      // Anzeige = Import (1025.50), NICHT der Z-Wert (1000):
      const cell = screen.getByTestId('ta-umsatz-2026-07-01');
      expect(cell.textContent).toContain('1’025.50');
      expect(cell.className).toContain('bg-red-100');
      fireEvent.click(screen.getByTestId('ta-umsatz-diff-2026-07-01'));
      expect(onDiff).toHaveBeenCalledWith('2026-07-01');
    });

    it('innerhalb der Schwelle: Import-Anzeige ohne rot; fehlende Quelle: nur vorhandener Wert, nie rot', () => {
      const base = buildMonth();
      const { rows, totals } = buildTagesabschlussRows(2026, 7, base.closings, base.blob, base.confirmations, null, 0);
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        umsatzImport={{ '2026-07-01': 1004 }} umsatzSchwelle={10} onUmsatzDiffClick={() => {}} />);
      const cell = screen.getByTestId('ta-umsatz-2026-07-01');
      expect(cell.textContent).toContain('1’004.00');
      expect(cell.className).not.toContain('bg-red-100');
      expect(screen.queryByTestId('ta-umsatz-diff-2026-07-01')).toBeNull();
      // 02.07.: Z-Bericht vorhanden, KEIN Import → Z-Wert anzeigen, nie rot.
      const cell2 = screen.getByTestId('ta-umsatz-2026-07-02');
      expect(cell2.className).not.toContain('bg-red-100');
    });
  });

  describe('Inline-Bearbeitung', () => {
    function renderEditable() {
      const { rows, totals } = buildMonth();
      const onSaveManual = vi.fn();
      const onConfirm = vi.fn();
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
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

    it('Bestätigungs-Checkboxen: unabhängig, Aktivierungs-Gates, Entfernen immer möglich', () => {
      const { onConfirm } = renderEditable();
      // Checkboxen leben im Status-Popup (Klick aufs Status-Badge).
      // Nur 01.07./02.07. haben Z-Bericht → nur dort Checkboxen.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-03'));
      expect(screen.queryByTestId('ta-row-check-cash-2026-07-03')).toBeNull();

      // 02.07.: kein BAR IST erfasst → BEIDE Checkboxen deaktiviert,
      // Sperr-Grund als Tooltip am Label.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-02'));
      const cashBox2 = screen.getByTestId('ta-row-check-cash-2026-07-02') as HTMLButtonElement;
      expect(cashBox2.disabled).toBe(true);
      expect(cashBox2.closest('label')?.getAttribute('title')).toContain('BAR IST muss zuerst erfasst werden.');
      const confirmBox2 = screen.getByTestId('ta-row-check-confirm-2026-07-02') as HTMLButtonElement;
      expect(confirmBox2.disabled).toBe(true);
      expect(confirmBox2.closest('label')?.getAttribute('title')).toContain('Es fehlen noch Pflichtwerte.');

      // 01.07.: beide gesetzt → Entfernen bleibt möglich und lässt das
      // ANDERE Häkchen unangetastet (unabhängige Checkboxen); Payload OHNE
      // Zeitstempel — Audit stempelt zentral applyDayConfirmation.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-01'));
      const cashBox1 = screen.getByTestId('ta-row-check-cash-2026-07-01') as HTMLButtonElement;
      expect(cashBox1.disabled).toBe(false);
      fireEvent.click(cashBox1);
      expect(onConfirm).toHaveBeenCalledWith('2026-07-01', { confirmed: true, cashCounted: false });
      const confirmBox1 = screen.getByTestId('ta-row-check-confirm-2026-07-01') as HTMLButtonElement;
      expect(confirmBox1.disabled).toBe(false);
      fireEvent.click(confirmBox1);
      expect(onConfirm).toHaveBeenCalledWith('2026-07-01', { confirmed: false, cashCounted: true });
    });

    it('rendert im readOnly-Modus (Gast) keinerlei Eingabefelder', () => {
      const { rows, totals } = buildMonth();
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
        readOnly onSaveManual={() => {}} onConfirm={() => {}}
        onCorrectRechnung={() => {}} onVoucherClick={() => {}} onExpensesClick={() => {}} />);
      expect(screen.queryByTestId('ta-input-bestand-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-input-einzahlung-2026-07-01')).toBeNull();
      // Bestätigungs-Checkboxen bleiben im Status-Popup SICHTBAR (Zustand
      // ablesbar), sind aber deaktiviert — read-only versteckt nichts.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-01'));
      const roCash = screen.getByTestId('ta-row-check-cash-2026-07-01') as HTMLButtonElement;
      expect(roCash.disabled).toBe(true);
      const roConfirm = screen.getByTestId('ta-row-check-confirm-2026-07-01') as HTMLButtonElement;
      expect(roConfirm.disabled).toBe(true);
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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={onDayClick}
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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
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
    render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

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
    // Schlichtes Design: kein roter Zeilen-Tint mehr (nur die Zellen-Werte).
    expect(screen.getByTestId('ta-row-2026-07-02').className).not.toContain('bg-red-50');

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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={onDayClick} />);
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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCloseDay={onCloseDay} />);

      // Abschließen-Button lebt im Status-Popup (Klick aufs Badge).
      // 01.07.: bestätigt + Barbestand + Cash Ist + Diff grün → aktiv.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-01'));
      const btn1 = screen.getByTestId('ta-close-day-2026-07-01') as HTMLButtonElement;
      expect(btn1.disabled).toBe(false);
      btn1.click();
      expect(onCloseDay).toHaveBeenCalledWith('2026-07-01');

      // 02.07.: unbestätigt → deaktiviert, Blocker im title.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-02'));
      const btn2 = screen.getByTestId('ta-close-day-2026-07-02') as HTMLButtonElement;
      expect(btn2.disabled).toBe(true);
      expect(btn2.getAttribute('title')).toContain('«Tagesabschluss geprüft» nicht bestätigt.');
      btn2.click();
      expect(onCloseDay).toHaveBeenCalledTimes(1);

      // Tage ohne Z-Bericht haben gar keinen Abschluss-Button.
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-03'));
      expect(screen.queryByTestId('ta-close-day-2026-07-03')).toBeNull();
    });

    it('gesperrter Tag: Lock-Icon, Badge „Abgeschlossen", keine Edit-Flächen, kein Abschluss-Button', () => {
      const { rows, totals } = buildMonthWithClosedDay();
      const onCloseDay = vi.fn();
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCorrectRechnung={() => {}}
        onVoucherClick={() => {}} onExpensesClick={() => {}} onCloseDay={onCloseDay} />);

      // Lock-Icon am Datum + grünes Badge «Grün»; Abschluss-Info im title
      // des Popup-Triggers.
      expect(screen.getByTestId('ta-lock-2026-07-01')).toBeTruthy();
      expect(screen.getByText('Grün')).toBeTruthy();
      const trigger = screen.getByTestId('ta-status-badge-2026-07-01');
      expect(trigger.getAttribute('title')).toContain('admin@oliv.ch');

      // Zeile 01.07.: KEINE Inputs/Checkboxen/Buttons für Edits mehr.
      const row1 = screen.getByTestId('ta-row-2026-07-01');
      expect(row1.querySelectorAll('input').length).toBe(0);
      fireEvent.click(trigger);
      expect(screen.queryByTestId('ta-close-day-2026-07-01')).toBeNull();
      // Checkboxen bleiben im Popup sichtbar (Zustand ablesbar), aber gesperrt.
      const lockedCash = screen.getByTestId('ta-row-check-cash-2026-07-01') as HTMLButtonElement;
      expect(lockedCash.disabled).toBe(true);
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
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} onConfirm={() => {}} onCloseDay={() => {}} />);

      // Wieder geöffnet = amber «Offen» (Details im title/Popup).
      expect(screen.getByTestId('ta-status-badge-2026-07-01').getAttribute('title')).toContain('Wieder geöffnet');
      const row1 = screen.getByTestId('ta-row-2026-07-01');
      // Schlichtes Design: kein oranger Zeilen-Tint mehr — Status via Badge.
      expect(row1.className).not.toContain('bg-orange-50');
      expect(row1.querySelectorAll('input').length).toBeGreaterThan(0);
      fireEvent.click(screen.getByTestId('ta-status-badge-2026-07-01'));
      expect(screen.getByTestId('ta-close-day-2026-07-01')).toBeTruthy();
      expect(screen.queryByTestId('ta-lock-2026-07-01')).toBeNull();
    });

    it('needsReview: Warn-Icon am Saldo, wenn der fixierte Saldo vom neu berechneten abweicht', () => {
      const closedState = buildMonthWithClosedDay();
      // Anfangsbestand nachträglich geändert (0 → 100): berechneter Saldo
      // weicht vom fixierten (247.50) ab → Überprüfungs-Marker.
      const { rows, totals } = buildTagesabschlussRows(
        2026, 7, closedState.closings, closedState.blob, closedState.confirmations, null, 100);
      render(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}} />);

      expect(rows.find(r => r.date === '2026-07-01')?.needsReview).toBe(true);
      expect(screen.getByTestId('ta-review-2026-07-01')).toBeTruthy();
      // Gesperrte Zeile zeigt weiterhin den FIXIERTEN Saldo (247.50), nicht den neuen.
      expect(screen.getByTestId('ta-saldo-2026-07-01').textContent).toContain('247.50');
    });
  });

  describe('Kompakte Standardansicht (ohne showAllColumns)', () => {
    it('blendet die Detail-Spalten Einzahlung Bank, Bargeld Soll (ber.), KK und V-Gutscheine aus', () => {
      const { rows, totals } = buildMonth();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} />);

      // Kompakte Spaltenzeile — genau die 10 fixen Spalten + Status.
      const colRow = screen.getByTestId('ta-header-cols');
      expect(within(colRow).getAllByRole('columnheader').map(th => th.textContent)).toEqual([
        'Datum', 'Umsatz',
        'BAR SOLL', 'BAR IST', 'Kassensaldo Soll', 'Differenz',
        'KK Adyen', 'Debitoren',
        'Barausgaben',
        'EG-Gutscheine',
        'Status',
      ]);

      // Detail-Zellen (Body + Footer) sind nicht im DOM.
      expect(screen.queryByTestId('ta-kk-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-input-einzahlung-2026-07-02')).toBeNull();
      expect(screen.queryByTestId('ta-bargeld-soll-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-total-bargeld-soll')).toBeNull();

      // Kern-Spalten bleiben funktional: BAR SOLL/IST, Differenz, KK Adyen,
      // Saldo, Totals.
      expect(screen.getByTestId('ta-bar-soll-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-bestand-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-cash-diff-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-adyen-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-saldo-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-total-adyen')).toBeTruthy();
      expect(screen.getByTestId('ta-total-saldo')).toBeTruthy();
      expect(screen.getByTestId('ta-total-cash-ist')).toBeTruthy();
      expect(screen.getByTestId('ta-total-cash-diff')).toBeTruthy();

      // Jede Zeile hat exakt so viele Zellen wie kompakte Spalten (11).
      const row1 = screen.getByTestId('ta-row-2026-07-01');
      expect(row1.querySelectorAll('td')).toHaveLength(11);
    });

    it('visibleTagesabschlussColumns filtert detailOnly-Spalten nur in der kompakten Ansicht', () => {
      expect(visibleTagesabschlussColumns(false).map(c => c.key)).toEqual([
        'datum', 'umsatz', 'barSoll', 'barIst', 'kassensaldoSoll', 'differenz',
        'kkAdyen', 'debitoren', 'barausgaben', 'gutscheinEingeloest', 'status',
      ]);
      expect(visibleTagesabschlussColumns(true).map(c => c.key)).toEqual(
        TAGESABSCHLUSS_COLUMNS.map(c => c.key));
      expect(visibleTagesabschlussColumns(true).map(c => c.key)).toEqual([
        'datum', 'umsatz', 'barSoll', 'barIst', 'kassensaldoSoll', 'differenz',
        'kkAdyen', 'debitoren', 'barausgaben', 'gutscheinEingeloest',
        'einzahlungBank', 'bargeldSoll', 'kk', 'gutscheinVerkauft', 'status',
      ]);
    });

    it('Voll-Ansicht zeigt dieselben Daten-Zellen wieder an (Toggle-Verhalten)', () => {
      const { rows, totals } = buildMonth();
      const view = render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} />);
      expect(screen.queryByTestId('ta-kk-2026-07-01')).toBeNull();

      // Wie der Section-Toggle: Prop-Wechsel auf showAllColumns.
      view.rerender(<TagesabschlussTable showAllColumns rows={rows} totals={totals} onDayClick={() => {}}
        onSaveManual={() => {}} />);
      expect(screen.getByTestId('ta-kk-2026-07-01').textContent).toContain('700.00');
      expect(screen.getByTestId('ta-input-einzahlung-2026-07-02')).toBeTruthy();
      expect(screen.getByTestId('ta-bargeld-soll-2026-07-01')).toBeTruthy();
      expect(screen.getByTestId('ta-total-bargeld-soll')).toBeTruthy();
    });
  });

  describe('Override-Popup-Wiring (Edit-Buttons + Effektivwert-Anzeige)', () => {
    it('Edit-Buttons an Umsatz- und KK-Adyen-Zelle rufen onOverrideClick mit dem Feld', () => {
      const { rows, totals } = buildMonth();
      const onOverrideClick = vi.fn();
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onOverrideClick={onOverrideClick} />);

      fireEvent.click(screen.getByTestId('ta-override-umsatz-2026-07-01'));
      expect(onOverrideClick).toHaveBeenLastCalledWith('2026-07-01', 'umsatz');
      fireEvent.click(screen.getByTestId('ta-override-karten-2026-07-01'));
      expect(onOverrideClick).toHaveBeenLastCalledWith('2026-07-01', 'karten');
      // Tage ohne Z-Bericht bekommen KEINE Edit-Buttons.
      expect(screen.queryByTestId('ta-override-umsatz-2026-07-03')).toBeNull();
      expect(screen.queryByTestId('ta-override-karten-2026-07-03')).toBeNull();
    });

    it('ohne Callback / readOnly / gesperrter Tag: keine Edit-Buttons', () => {
      const base = buildMonth();
      const view = render(<TagesabschlussTable rows={base.rows} totals={base.totals} onDayClick={() => {}} />);
      expect(screen.queryByTestId('ta-override-umsatz-2026-07-01')).toBeNull();

      view.rerender(<TagesabschlussTable rows={base.rows} totals={base.totals} onDayClick={() => {}}
        readOnly onOverrideClick={() => {}} />);
      expect(screen.queryByTestId('ta-override-umsatz-2026-07-01')).toBeNull();
      cleanup();

      // Definitiv abgeschlossener Tag: gesperrt — der offene 02.07. behält Buttons.
      const closed = buildMonthWithClosedDay();
      render(<TagesabschlussTable rows={closed.rows} totals={closed.totals} onDayClick={() => {}}
        onOverrideClick={() => {}} />);
      expect(screen.queryByTestId('ta-override-umsatz-2026-07-01')).toBeNull();
      expect(screen.queryByTestId('ta-override-karten-2026-07-01')).toBeNull();
      expect(screen.getByTestId('ta-override-umsatz-2026-07-02')).toBeTruthy();
    });

    it('karten-Override: KK-Adyen-Zelle zeigt den EFFEKTIVEN Z-KK-Wert (karten + TWINT) amber', () => {
      const base = buildMonth();
      const blob = setTagesabschlussOverride(base.blob, '2026-07-01', 'karten', 500, 480, undefined, '2026-07-05T11:00:00.000Z');
      const { rows, totals } = buildTagesabschlussRows(2026, 7, base.closings, blob, base.confirmations, null, 0);
      render(<TagesabschlussTable rows={rows} totals={totals} onDayClick={() => {}}
        onOverrideClick={() => {}} />);

      // Effektiv: karten 480 (korrigiert) + TWINT 200 = 680, gelb markiert.
      expect(screen.getByTestId('ta-adyen-effektiv-2026-07-01').textContent).toContain('680.00');
      expect(screen.getByTestId('ta-adyen-2026-07-01').className).toContain('bg-amber-100');
      // Ohne Override bleibt die Standard-Anzeige (Adyen-Total bzw. „—").
      expect(screen.queryByTestId('ta-adyen-effektiv-2026-07-02')).toBeNull();
    });
  });
});
