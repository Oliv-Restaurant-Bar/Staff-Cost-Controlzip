// @vitest-environment node
/**
 * Tests für die reine Tagesabschluss-Logik (tagesabschluss.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  buildMonthClosureSnapshot,
  buildTagesabschlussRows,
  canCloseDay,
  canCloseMonth,
  closeDay,
  closeMonth,
  collectKkBreakdown,
  collectNichtAdyenKk,
  collectWeitereZahlungsarten,
  computeMonthEndSaldo,
  deriveAutoValues,
  isMonthClosed,
  readyForBuchhaltung,
  reopenDay,
  reopenMonth,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  expensesTotal,
  KASSENSALDO_MAX_CHAIN_MONTHS,
  makeTagesabschlussFieldKey,
  mergeTagesabschlussBlobs,
  monthDates,
  normalizeTagesabschlussBlob,
  removeExpense,
  resolveKassensaldoStart,
  setAnfangsbestand,
  setCashDiffReasons,
  setExportSettings,
  setTagesabschlussComment,
  setTagesabschlussOverride,
  tagesabschlussMonthKey,
  upsertExpense,
  upsertManualDay,
  type CashExpense,
  type GnDayClosing,
  type TagesabschlussBlob,
} from './tagesabschluss';
import {
  emptyAdyenBlob,
  type AdyenAbstimmungBlob,
  type AdyenStoredDay,
} from './adyen-abstimmung';

const NOW = '2026-07-06T10:00:00.000Z';

function makeClosing(date: string, over: Partial<GnDayClosing> = {}): GnDayClosing {
  return {
    date,
    grossRevenue: 1000,
    netRevenue: 925.07,
    tip: null,
    taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
    payments: [
      { name: 'Bar', count: 10, amount: 300 },
      { name: 'Mastercard', count: 8, amount: 400 },
      { name: 'VISA', count: 3, amount: 150 },
      { name: 'TWINT', count: 4, amount: 100 },
      { name: 'Rechnung', count: 1, amount: 30 },
      { name: 'Gutschein', count: 1, amount: 20 },
    ],
    accountingLines: [],
    paymentAccounts: [],
    ...over,
  };
}

describe('monthDates', () => {
  it('liefert alle Kalendertage inkl. Schaltjahr-Februar', () => {
    expect(monthDates(2026, 2)).toHaveLength(28);
    expect(monthDates(2028, 2)).toHaveLength(29);
    const june = monthDates(2026, 6);
    expect(june[0]).toBe('2026-06-01');
    expect(june[29]).toBe('2026-06-30');
  });
});

describe('deriveAutoValues', () => {
  it('ordnet Zahlungsarten den Spalten zu', () => {
    const v = deriveAutoValues(makeClosing('2026-07-01'));
    expect(v.umsatz).toBe(1000);
    expect(v.netto).toBe(925.07);
    expect(v.mwst).toBe(74.93);
    expect(v.bar).toBe(300);
    expect(v.karten).toBe(550); // Mastercard + VISA
    expect(v.twint).toBe(100);
    expect(v.rechnung).toBe(30);
    expect(v.gutscheinEingeloest).toBe(20);
    expect(v.gutscheinVerkauft).toBeNull();
    expect(v.trinkgeld).toBeNull();
  });

  it('erkennt verkaufte Gutscheine aus Buchungskonten-Zeilen', () => {
    const v = deriveAutoValues(makeClosing('2026-07-01', {
      accountingLines: [
        { name: 'Gutschein Verkauf', account: '2003', taxRate: null, grossAmount: 150 },
        { name: 'Speisen', account: '3000', taxRate: '8.1%', grossAmount: 800 },
      ],
    }));
    expect(v.gutscheinVerkauft).toBe(150);
  });

  it('nimmt Trinkgeld aus revenue-summary-Differenz oder Zahlungsart', () => {
    expect(deriveAutoValues(makeClosing('2026-07-01', { tip: 12.5 })).trinkgeld).toBe(12.5);
    const v = deriveAutoValues(makeClosing('2026-07-01', {
      payments: [{ name: 'Trinkgeld', count: 2, amount: 8 }],
    }));
    expect(v.trinkgeld).toBe(8);
  });

  it('fehlende Zahlungsarten bleiben null (nicht 0)', () => {
    const v = deriveAutoValues(makeClosing('2026-07-01', { payments: [] }));
    expect(v.bar).toBeNull();
    expect(v.karten).toBeNull();
    expect(v.twint).toBeNull();
  });

  it('zählt kartenähnliche Zahlarten (Amex/PostCard/Lunch-Check/Stripe) ins KK-Total', () => {
    const v = deriveAutoValues(makeClosing('2026-07-01', {
      payments: [
        { name: 'Bar', count: 5, amount: 200 },
        { name: 'Mastercard', count: 4, amount: 100 },
        { name: 'American Express', count: 1, amount: 30 },
        { name: 'PostCard', count: 1, amount: 20 },
        { name: 'Lunch-Check', count: 1, amount: 10 },
        { name: 'Stripe', count: 1, amount: 5 },
        { name: 'TWINT', count: 2, amount: 50 },
      ],
    }));
    expect(v.karten).toBe(165); // MC + Amex + PostCard + Lunch-Check + Stripe
    expect(v.twint).toBe(50);
    expect(v.bar).toBe(200);
  });

  it('lässt unklassifizierte Zahlarten (KD Tisch 5000) in KEINER Spalte mitzählen', () => {
    const v = deriveAutoValues(makeClosing('2026-07-01', {
      payments: [
        { name: 'Bar', count: 5, amount: 200 },
        { name: 'Mastercard', count: 4, amount: 100 },
        { name: 'KD Tisch 5000', count: 1, amount: 40 },
      ],
    }));
    expect(v.bar).toBe(200);
    expect(v.karten).toBe(100);
    expect(v.twint).toBeNull();
    expect(v.rechnung).toBeNull();
  });
});

describe('collectWeitereZahlungsarten', () => {
  it('liefert nur seltene Karten + unklassifizierte Zahlarten (aggregiert, sortiert)', () => {
    const list = collectWeitereZahlungsarten(makeClosing('2026-07-01', {
      payments: [
        { name: 'Bar', count: 5, amount: 200 },
        { name: 'Mastercard', count: 4, amount: 100 },
        { name: 'VISA', count: 2, amount: 80 },
        { name: 'TWINT', count: 2, amount: 50 },
        { name: 'Rechnung', count: 1, amount: 30 },
        { name: 'Gutschein', count: 1, amount: 20 },
        { name: 'American Express', count: 1, amount: 30 },
        { name: 'PostCard', count: 1, amount: 20.5 },
        { name: 'PostCard', count: 1, amount: 9.5 }, // gleiche Art doppelt → aggregiert
        { name: 'Lunch-Check', count: 1, amount: 10 },
        { name: 'Stripe', count: 1, amount: 5 },
        { name: 'KD Tisch 5000', count: 1, amount: 40 },
      ],
    }));
    expect(list.map(z => z.key)).toEqual(['amex', 'kd_tisch_5000', 'lunch_check', 'postcard', 'stripe']);
    const byKey = Object.fromEntries(list.map(z => [z.key, z]));
    expect(byKey.amex).toMatchObject({ label: 'American Express', amount: 30, inKk: true });
    expect(byKey.postcard).toMatchObject({ label: 'PostCard', amount: 30, inKk: true });
    expect(byKey.lunch_check).toMatchObject({ amount: 10, inKk: true });
    expect(byKey.stripe).toMatchObject({ amount: 5, inKk: true });
    expect(byKey.kd_tisch_5000).toMatchObject({ label: 'KD Tisch 5000', amount: 40, inKk: false });
  });

  it('ist leer ohne Z-Bericht oder ohne seltene Zahlarten', () => {
    expect(collectWeitereZahlungsarten(undefined)).toEqual([]);
    expect(collectWeitereZahlungsarten(makeClosing('2026-07-01'))).toEqual([]);
  });
});

describe('collectKkBreakdown / collectNichtAdyenKk (Popover-Zusammensetzung)', () => {
  const payments = [
    { name: 'Bar', count: 5, amount: 200 },
    { name: 'Stripe', count: 1, amount: 5 },
    { name: 'Mastercard', count: 4, amount: 100 },
    { name: 'Mastercard', count: 1, amount: 50.5 }, // doppelt → aggregiert
    { name: 'VISA', count: 2, amount: 80 },
    { name: 'TWINT', count: 2, amount: 50 },
    { name: 'American Express', count: 1, amount: 30 },
    { name: 'PostCard', count: 1, amount: 20 },
    { name: 'Lunch-Check', count: 1, amount: 10 },
    { name: 'Rechnung', count: 1, amount: 30 },
    { name: 'KD Tisch 5000', count: 1, amount: 40 },
  ];

  it('KK-Zusammensetzung: alle isKkCard-Arten inkl. TWINT, feste Reihenfolge, aggregiert', () => {
    const list = collectKkBreakdown(makeClosing('2026-07-01', { payments }));
    // Feste Reihenfolge: Mastercard, Visa, TWINT, Amex, PostCard, Lunch-Check, Stripe.
    expect(list.map(z => z.key)).toEqual(['mastercard', 'visa', 'twint', 'amex', 'postcard', 'lunch_check', 'stripe']);
    const byKey = Object.fromEntries(list.map(z => [z.key, z.amount]));
    expect(byKey.mastercard).toBe(150.5); // aggregiert
    expect(byKey.twint).toBe(50);
    // Summe = karten.auto + twint.auto (KK-Spalte der Übersicht).
    const v = deriveAutoValues(makeClosing('2026-07-01', { payments }));
    const sum = Math.round(list.reduce((s, z) => s + z.amount, 0) * 100) / 100;
    expect(sum).toBe(Math.round(((v.karten ?? 0) + (v.twint ?? 0)) * 100) / 100);
    // Bar/Rechnung/unklassifizierte Arten erscheinen NICHT.
    expect(list.find(z => z.key === 'bar' || z.key === 'kd_tisch_5000')).toBeUndefined();
  });

  it('Nicht-Adyen-KK: nur isKkCard && !isCard (PostCard/Lunch-Check/Stripe), NICHT Amex', () => {
    const list = collectNichtAdyenKk(makeClosing('2026-07-01', { payments }));
    expect(list.map(z => z.key)).toEqual(['postcard', 'lunch_check', 'stripe']);
    expect(list.map(z => z.amount)).toEqual([20, 10, 5]);
  });

  it('leer ohne Z-Bericht', () => {
    expect(collectKkBreakdown(undefined)).toEqual([]);
    expect(collectNichtAdyenKk(undefined)).toEqual([]);
  });
});

describe('buildTagesabschlussRows', () => {
  it('befüllt weitereZahlungsarten und rechnet kartenähnliche Zahlarten aus dem Barumsatz heraus', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 245 },
          { name: 'Mastercard', count: 8, amount: 500 },
          { name: 'TWINT', count: 4, amount: 100 },
          { name: 'Rechnung', count: 1, amount: 30 },
          { name: 'Gutschein', count: 1, amount: 20 },
          { name: 'PostCard', count: 1, amount: 65 },
          { name: 'KD Tisch 5000', count: 1, amount: 40 },
        ],
      }),
    };
    const { rows } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {}, null, 0);
    const row = rows.find(r => r.date === '2026-07-01')!;
    expect(row.weitereZahlungsarten.map(z => z.key)).toEqual(['kd_tisch_5000', 'postcard']);
    // KK inkl. PostCard: 500 + 65 = 565.
    expect(row.cells.karten.value).toBe(565);
    // Barumsatz = 1000 − 565 − 100 − 30 − 20 = 285 (KD Tisch bleibt implizit drin).
    expect(row.barumsatz).toBe(285);
    expect(row.bargeldSoll).toBe(285);
    // Tage ohne seltene Zahlarten haben eine leere Liste.
    expect(rows.find(r => r.date === '2026-07-02')!.weitereZahlungsarten).toEqual([]);
  });

  it('baut Zeilen für alle Kalendertage; ohne Z-Bericht Status "fehlt"', () => {
    const { rows } = buildTagesabschlussRows(2026, 7, {}, emptyTagesabschlussBlob(), {});
    expect(rows).toHaveLength(31);
    expect(rows.every(r => r.status === 'fehlt')).toBe(true);
    expect(rows.every(r => r.cells.umsatz.source === 'missing')).toBe(true);
  });

  it('übernimmt Auto-Werte, berechnet Barumsatz und markiert Status "offen"', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const { rows } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {});
    const r = rows[0];
    expect(r.hasZbericht).toBe(true);
    expect(r.status).toBe('offen');
    expect(r.cells.umsatz.value).toBe(1000);
    expect(r.cells.umsatz.source).toBe('auto');
    // Barumsatz = 1000 − 550 − 100 − 30 − 20 = 300
    expect(r.barumsatz).toBe(300);
  });

  it('erfüllte Vorbedingungen ⇒ "in_bearbeitung"; erst closeDay ⇒ "abgeschlossen" + gesperrt', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    // Anker 0 → Kassensaldo Soll = 0 + 300 (Bargeld Soll) = 300 → Ist 300 = grün.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 300 }, NOW);
    const confirmations = {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    };
    const before = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0);
    // Keine Auto-Bestätigung mehr: ohne expliziten Abschluss nur "in_bearbeitung".
    expect(before.rows[0].status).toBe('in_bearbeitung');
    expect(before.rows[0].locked).toBe(false);
    expect(canCloseDay(before.rows[0]).ok).toBe(true);

    blob = closeDay(blob, before.rows[0], 'chef@oliv.ch', NOW);
    const after = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0);
    expect(after.rows[0].status).toBe('abgeschlossen');
    expect(after.rows[0].locked).toBe(true);
    expect(after.rows[0].closure?.closedBy).toBe('chef@oliv.ch');
    expect(after.rows[0].closure?.fixedKassensaldo).toBe(300);
    expect(after.totals.daysConfirmed).toBe(1);
  });

  it('Override gewinnt und markiert Zelle als "corrected"', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'umsatz', 1000, 990, 'Storno', NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const cell = rows[0].cells.umsatz;
    expect(cell.value).toBe(990);
    expect(cell.source).toBe('corrected');
    expect(cell.auto).toBe(1000);
    expect(cell.override?.comment).toBe('Storno');
    // Barumsatz nutzt den korrigierten Umsatz: 990 − 700 = 290
    expect(rows[0].barumsatz).toBe(290);
  });

  it('Bargeld Soll = Barumsatz + VerkG − Barausgaben; ohne Anker bleiben Saldi/Diffs null', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const month = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {});
    // Barumsatz 300 (EingG bereits abgezogen) + 0 VerkG − 0 Barausgaben.
    expect(month.rows[0].bargeldSoll).toBe(300);
    expect(month.rows[0].cashIst).toBeNull();
    // KEIN Anker (kein 7. Arg): Kassensaldo und Cash Diff bleiben null — keine stille 0.
    expect(month.rows[0].kassensaldoSoll).toBeNull();
    expect(month.rows[0].cashDiff).toBeNull();
    expect(month.rows[0].cashDiffStatus).toBeNull();
    // Tag ohne Z-Bericht und ohne Barausgaben: kein Bargeld Soll.
    expect(month.rows[1].bargeldSoll).toBeNull();
    expect(month.startSaldo).toBeNull();
    expect(month.endSaldo).toBeNull();
    expect(month.totals.kassensaldoEnde).toBeNull();
    expect(month.totals.letzteCashDiff).toBeNull();
  });

  it('Einzahlung Bank senkt den Kassensaldo, NICHT das Bargeld Soll', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 80 }, NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    expect(rows[0].bargeldSoll).toBe(300);
    expect(rows[0].kassensaldoSoll).toBe(220); // 0 + 300 − 80
  });

  it('Kassensaldo läuft über Tage ohne Z-Bericht weiter (Einzahlung am Ruhetag)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-02', { einzahlungBank: 100 }, NOW);
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 50);
    expect(month.rows[0].kassensaldoSoll).toBe(350); // 50 + 300
    expect(month.rows[1].bargeldSoll).toBeNull();
    expect(month.rows[1].kassensaldoSoll).toBe(250); // 350 − 100
    expect(month.rows[2].kassensaldoSoll).toBe(250); // unverändert
    expect(month.endSaldo).toBe(250);
    expect(month.totals.kassensaldoEnde).toBe(250);
    expect(month.startSaldo).toBe(50);
  });

  it('Barausgaben senken Bargeld Soll; ohne Z-Bericht wird das Soll negativ', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-07-01', amount: 150, konto: '6000', text: 'Blumen', updatedAt: NOW,
    });
    blob = upsertExpense(blob, {
      id: 'e2', date: '2026-07-02', amount: 40, konto: '6000', text: 'Post', updatedAt: NOW,
    });
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    expect(rows[0].barausgabenTotal).toBe(150);
    expect(rows[0].expenseCount).toBe(1);
    expect(rows[0].bargeldSoll).toBe(150); // 300 − 150
    // Ruhetag mit Barausgabe: Bargeld Soll = −40, Saldo sinkt entsprechend.
    expect(rows[1].bargeldSoll).toBe(-40);
    expect(rows[1].kassensaldoSoll).toBe(110); // 150 − 40
    expect(totals.barausgaben).toBe(190);
    expect(totals.bargeldSoll).toBe(110); // 150 + (−40)
  });

  it('Gutschein-Änderungen aktualisieren Bargeld Soll (verkauft +, eingelöst −)', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        accountingLines: [
          { name: 'Gutschein Verkauf', account: '2003', taxRate: null, grossAmount: 150 },
        ],
      }),
    };
    let blob = emptyTagesabschlussBlob();
    const base = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(base.rows[0].bargeldSoll).toBe(450); // 300 + 150
    // Korrektur eingelöste Gutscheine 20 → 50 senkt Barumsatz und damit das Soll.
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'gutscheinEingeloest', 20, 50, '', NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(rows[0].bargeldSoll).toBe(420); // 270 + 150
  });

  it('Cash Ist bleibt manuell ("manual"); Cash Differenz = Ist − Kassensaldo Soll mit Ampel', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
      '2026-07-03': makeClosing('2026-07-03'),
    };
    let blob = emptyTagesabschlussBlob();
    // Saldi mit Anker 0: 300 / 600 / 900.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 300 }, NOW);  // exakt
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 603 }, NOW);  // +3
    blob = upsertManualDay(blob, '2026-07-03', { bestandKasse: 1120 }, NOW); // +220
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    expect(rows[0].cells.bestandKasse.source).toBe('manual');
    expect(rows[0].cashIst).toBe(300);
    expect(rows[0].cashDiff).toBe(0);
    expect(rows[0].cashDiffStatus).toBe('ok');
    expect(rows[1].cashDiff).toBe(3);
    expect(rows[1].cashDiffStatus).toBe('small');
    expect(rows[2].cashDiff).toBe(220);
    expect(rows[2].cashDiffStatus).toBe('large');
    // Die Zählung korrigiert den Soll-Saldo NICHT — der Fehler läuft sichtbar mit.
    expect(rows[2].kassensaldoSoll).toBe(900);
  });

  it('Cash Ist fehlt: Bestätigung zählt als Fortschritt ("in_bearbeitung"), Abschluss blockiert', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const { rows } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    }, null, 0);
    expect(rows[0].cashIst).toBeNull();
    expect(rows[0].status).toBe('in_bearbeitung');
    const check = canCloseDay(rows[0]);
    expect(check.ok).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/Cash Ist/);
  });

  it('nicht-grüne UND unbegründete Cash-Differenz blockiert den Abschluss', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 320 }, NOW); // Soll 300 → +20 large
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    }, null, 0);
    expect(rows[0].cashDiffStatus).toBe('large');
    expect(rows[0].cashDiffBegruendet).toBe(false);
    expect(rows[0].status).toBe('in_bearbeitung');
    const check = canCloseDay(rows[0]);
    expect(check.ok).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/weder grün noch begründet/);
    expect(() => closeDay(blob, rows[0], 'chef@oliv.ch', NOW)).toThrow(/nicht möglich/);
  });

  it('begründete nicht-grüne Differenz: closeDay ⇒ "abgeschlossen_mit_differenz"', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 320 }, NOW); // +20 large
    blob = setCashDiffReasons(blob, '2026-07-01', ['wechselgeld_angepasst'], undefined, NOW);
    const confirmations = {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    };
    const withReason = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0);
    expect(withReason.rows[0].cashDiffBegruendet).toBe(true);
    expect(withReason.rows[0].cashDiffReasons).toEqual(['wechselgeld_angepasst']);
    expect(withReason.rows[0].status).toBe('in_bearbeitung');
    expect(withReason.totals.daysBegruendet).toBe(1);
    expect(withReason.totals.daysUnbegruendet).toBe(0);
    expect(canCloseDay(withReason.rows[0]).ok).toBe(true);

    blob = closeDay(blob, withReason.rows[0], 'chef@oliv.ch', NOW);
    const closed = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, null, 0);
    expect(closed.rows[0].status).toBe('abgeschlossen_mit_differenz');
    expect(closed.rows[0].locked).toBe(true);
    expect(closed.totals.daysConfirmed).toBe(1); // zählt als abgeschlossen
    expect(closed.totals.daysAbgeschlossenMitDifferenz).toBe(1);

    // NUR eine Notiz (ohne Katalog-Grund) zählt ebenfalls als begründet.
    let blobNote = emptyTagesabschlussBlob();
    blobNote = upsertManualDay(blobNote, '2026-07-01', { bestandKasse: 320 }, NOW);
    blobNote = setCashDiffReasons(blobNote, '2026-07-01', [], 'Einzahlung folgt morgen', NOW);
    const withNote = buildTagesabschlussRows(2026, 7, closings, blobNote, confirmations, null, 0);
    expect(withNote.rows[0].cashDiffNote).toBe('Einzahlung folgt morgen');
    expect(canCloseDay(withNote.rows[0]).ok).toBe(true);

    // Ohne Tagesbestätigung: Fortschritt vorhanden ⇒ "in_bearbeitung", Abschluss blockiert.
    const unconfirmed = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    expect(unconfirmed.rows[0].status === 'in_bearbeitung' || unconfirmed.rows[0].locked).toBe(true);
  });

  it('Totale: Bargeld Soll summiert, Kassensaldo Ende + letzte Cash-Differenz', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 283 }, NOW);  // Saldo 300 → −17 large
    blob = upsertManualDay(blob, '2026-07-15', { bestandKasse: 800 }, NOW);  // Saldo 300 → +500 large
    const { totals } = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 0);
    expect(totals.bargeldSoll).toBe(300);
    expect(totals.kassensaldoEnde).toBe(300); // Saldo läuft unverändert bis Monatsende
    expect(totals.cashIst).toBe(1083); // 283 + 800
    expect(totals.values.bestandKasse).toBe(1083);
    // Aktuellster Zählstand: 15. ist die LETZTE erfasste Differenz.
    expect(totals.letzteCashDiff).toBe(500);
    expect(totals.letzteCashDiffStatus).toBe('large');
    expect(totals.daysWithCashDiff).toBe(2);
    expect(totals.daysUnbegruendet).toBe(2);
    expect(totals.values.umsatz).toBe(1000);
    expect(totals.daysWithZbericht).toBe(1);
  });
});

describe('buildTagesabschlussRows — Adyen-Integration & KPIs', () => {
  // Z-Bericht-Karten aus makeClosing: Mastercard 400 + VISA 150 + TWINT 100 = 650.
  function makeAdyenDay(byMethod: Record<string, number>): AdyenStoredDay {
    return {
      byMethod,
      countByMethod: {},
      total: Object.values(byMethod).reduce((s, v) => s + v, 0),
      transactionCount: 5,
      fileName: 'adyen.csv',
      importedAt: NOW,
    };
  }

  it('ohne Adyen-Blob (5-Arg-Aufruf) bleiben alle Adyen-Felder null — rückwärtskompatibel', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {});
    expect(rows[0].hasAdyen).toBe(false);
    expect(rows[0].adyenTotal).toBeNull();
    expect(rows[0].adyenZTotal).toBeNull();
    expect(rows[0].adyenDiff).toBeNull();
    expect(rows[0].adyenDiffStatus).toBeNull();
    expect(totals.adyenTotal).toBe(0);
    expect(totals.adyenDiff).toBe(0);
  });

  it('berechnet Adyen-Vergleich mit denselben effektiven Werten wie der Adyen-Abgleich', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
      '2026-07-03': makeClosing('2026-07-03'),
    };
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: {
        '2026-07-01': makeAdyenDay({ mastercard: 400, visa: 150, twint: 100 }), // exakt → ok
        '2026-07-02': makeAdyenDay({ mastercard: 400, visa: 150, twint: 98 }),  // Diff 2 → small
      },
    };
    const { rows, totals } = buildTagesabschlussRows(
      2026, 7, closings, emptyTagesabschlussBlob(), {}, adyenBlob,
    );
    expect(rows[0].hasAdyen).toBe(true);
    expect(rows[0].adyenZTotal).toBe(650);
    expect(rows[0].adyenTotal).toBe(650);
    expect(rows[0].adyenDiff).toBe(0);
    expect(rows[0].adyenDiffStatus).toBe('ok');

    expect(rows[1].adyenTotal).toBe(648);
    expect(rows[1].adyenDiff).toBe(2);
    expect(rows[1].adyenDiffStatus).toBe('small');

    // Tag mit Z-Bericht, aber ohne Adyen-Import: kein Vergleich, keine Differenz.
    expect(rows[2].hasAdyen).toBe(false);
    expect(rows[2].adyenTotal).toBeNull();
    expect(rows[2].adyenZTotal).toBe(650); // Z-Seite ist trotzdem berechenbar
    expect(rows[2].adyenDiff).toBeNull();
    expect(rows[2].adyenDiffStatus).toBeNull();

    expect(totals.adyenTotal).toBe(1298);
    expect(totals.adyenDiff).toBe(2);
  });

  it('respektiert Overrides aus dem Adyen-Abgleich (effektive Werte)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: { '2026-07-01': makeAdyenDay({ mastercard: 400, visa: 150, twint: 90 }) },
      overrides: {
        ['2026-07-01:adyen:twint']: {
          originalValue: 90, correctedValue: 100,
          correctedByManualOverride: true, updatedAt: NOW,
        },
      },
    };
    const { rows } = buildTagesabschlussRows(
      2026, 7, closings, emptyTagesabschlussBlob(), {}, adyenBlob,
    );
    expect(rows[0].adyenTotal).toBe(650); // 640 + Override auf 100 statt 90
    expect(rows[0].adyenDiff).toBe(0);
    expect(rows[0].adyenDiffStatus).toBe('ok');
  });

  it('Adyen-Import ohne Z-Bericht: Total sichtbar, aber keine Differenz', () => {
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: { '2026-07-05': makeAdyenDay({ mastercard: 200 }) },
    };
    const { rows } = buildTagesabschlussRows(
      2026, 7, {}, emptyTagesabschlussBlob(), {}, adyenBlob,
    );
    const r = rows.find(x => x.date === '2026-07-05')!;
    expect(r.hasAdyen).toBe(true);
    expect(r.hasZbericht).toBe(false);
    expect(r.adyenTotal).toBe(200);
    expect(r.adyenZTotal).toBeNull();
    expect(r.adyenDiff).toBeNull();
    expect(r.adyenDiffStatus).toBeNull();
  });

  it('KPI-Zähler: daysOpen, daysConfirmed und daysWithDiff (Adyen ODER Kasse)', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
      '2026-07-03': makeClosing('2026-07-03'),
    };
    let blob = emptyTagesabschlussBlob();
    // Kassensaldi mit Anker 0: 300 / 600 / 900. 01. Ist 300 → ok (bestätigbar);
    // 02. Ist 820 → +220 large; 03. Ist 1320 → +420 large.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 300 }, NOW);
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 820 }, NOW);
    blob = upsertManualDay(blob, '2026-07-03', { bestandKasse: 1320 }, NOW);
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: {
        '2026-07-01': makeAdyenDay({ mastercard: 400, visa: 150, twint: 100 }), // ok
        '2026-07-02': makeAdyenDay({ mastercard: 380, visa: 150, twint: 100 }), // Diff 20 → large
      },
    };
    const confirmations = {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    };
    const before = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, adyenBlob, 0);
    // 01. abschließen (Vorbedingungen erfüllt), dann neu bauen.
    blob = closeDay(blob, before.rows[0], 'chef@oliv.ch', NOW);
    const { totals } = buildTagesabschlussRows(2026, 7, closings, blob, confirmations, adyenBlob, 0);

    expect(totals.daysWithZbericht).toBe(3);
    expect(totals.daysConfirmed).toBe(1);     // 01. abgeschlossen
    expect(totals.daysAbgeschlossen).toBe(1);
    // 02. + 03. haben Cash-Ist erfasst ⇒ Fortschritt ⇒ "in_bearbeitung".
    expect(totals.daysInBearbeitung).toBe(2);
    expect(totals.daysOpen).toBe(0);
    // 02. via Adyen-Diff, 03. via Kassen-Diff — je EINMAL gezählt.
    expect(totals.daysWithDiff).toBe(2);
  });
});

describe('Tages-/Monatsabschluss (closeDay/reopenDay/closeMonth)', () => {
  const CONF = { '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW } };

  function closableBlob(): TagesabschlussBlob {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 300 }, NOW);
    return blob;
  }
  const CLOSINGS = { '2026-07-01': makeClosing('2026-07-01') };

  it('reopenDay: Grund ist PFLICHT, Status wieder_geoeffnet, Historie = Union', () => {
    let blob = closableBlob();
    const { rows } = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    blob = closeDay(blob, rows[0], 'chef@oliv.ch', NOW);

    expect(() => reopenDay(blob, '2026-07-01', 'admin@oliv.ch', '   ', NOW))
      .toThrow(/grund ist Pflicht/);
    expect(() => reopenDay(blob, '2026-07-02', 'admin@oliv.ch', 'x', NOW))
      .toThrow(/nicht abgeschlossen/);

    const later = '2026-07-06T12:00:00.000Z';
    blob = reopenDay(blob, '2026-07-01', 'admin@oliv.ch', 'Beleg vergessen', later);
    const c = blob.abschluesse['2026-07-01'];
    expect(c.status).toBe('wieder_geoeffnet');
    expect(c.reopenedBy).toBe('admin@oliv.ch');
    expect(c.reopenReason).toBe('Beleg vergessen');
    // Historie wächst: Abschluss + Wiederöffnung, chronologisch.
    expect(c.history.map(h => h.action)).toEqual(['abschluss', 'wiederoeffnung']);

    // Wieder geöffnet ⇒ nicht mehr gesperrt, Status wieder_geoeffnet.
    const after = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    expect(after.rows[0].locked).toBe(false);
    expect(after.rows[0].status).toBe('wieder_geoeffnet');
    expect(after.totals.daysWiederGeoeffnet).toBe(1);
    expect(after.totals.daysConfirmed).toBe(0);

    // Erneuter Abschluss möglich; Historie behält alle drei Einträge.
    const later2 = '2026-07-06T13:00:00.000Z';
    blob = closeDay(blob, after.rows[0], 'chef@oliv.ch', later2);
    expect(blob.abschluesse['2026-07-01'].history).toHaveLength(3);
    expect(blob.abschluesse['2026-07-01'].status).toBe('abgeschlossen');
  });

  it('needsReview: Alt-Tag-Änderung nach Abschluss — fixierter Saldo weicht vom berechneten ab', () => {
    let blob = closableBlob();
    const { rows } = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    blob = closeDay(blob, rows[0], 'chef@oliv.ch', NOW); // fixiert Saldo 300

    // Nachträglich geänderter Anfangsbestand (Alt-Änderung) → berechneter Saldo 400.
    const changed = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 100);
    const r = changed.rows[0];
    expect(r.fixedKassensaldo).toBe(300);
    expect(r.kassensaldoSoll).toBe(400); // Kette rechnet IMMER mit berechnetem Wert
    expect(r.needsReview).toBe(true);
    expect(changed.totals.daysNeedsReview).toBe(1);
    // Cash-Diff des gesperrten Tags bleibt am FIXIERTEN Saldo verankert.
    expect(r.cashDiff).toBe(0);

    // Ohne Änderung: kein Review-Marker.
    const same = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    expect(same.rows[0].needsReview).toBe(false);
  });

  it('Monatsabschluss: canCloseMonth blockiert offene Tage; closeMonth friert Snapshot ein; reopenMonth', () => {
    let blob = closableBlob();
    const open = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    const openCheck = canCloseMonth(open, false);
    expect(openCheck.ok).toBe(false);
    expect(openCheck.blockers.join(' ')).toMatch(/nicht abgeschlossen/);
    expect(() => closeMonth(blob, '2026-07', open, 'admin@oliv.ch', NOW)).toThrow(/nicht möglich/);

    blob = closeDay(blob, open.rows[0], 'chef@oliv.ch', NOW);
    const closedMonth = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    expect(canCloseMonth(closedMonth, false).ok).toBe(true);
    expect(readyForBuchhaltung(closedMonth)).toBe(true);

    blob = closeMonth(blob, '2026-07', closedMonth, 'admin@oliv.ch', NOW);
    expect(isMonthClosed(blob, '2026-07')).toBe(true);
    const mc = blob.monatsabschluesse['2026-07'];
    expect(mc.closedBy).toBe('admin@oliv.ch');
    expect(mc.snapshot).toEqual(buildMonthClosureSnapshot(closedMonth));
    expect(mc.snapshot.umsatzTotal).toBe(1000);
    expect(mc.snapshot.bargeldTotal).toBe(300);

    // Doppelt schließen blockiert; Wiederöffnung setzt Status-Flag (kein Key-Delete).
    expect(() => closeMonth(blob, '2026-07', closedMonth, 'admin@oliv.ch', NOW)).toThrow(/bereits/);
    blob = reopenMonth(blob, '2026-07', 'admin@oliv.ch', NOW);
    expect(isMonthClosed(blob, '2026-07')).toBe(false);
    expect(blob.monatsabschluesse['2026-07'].status).toBe('wieder_geoeffnet');
    expect(blob.monatsabschluesse['2026-07'].snapshot).toEqual(mc.snapshot);
  });

  it('readyForBuchhaltung: false bei offenen/in Bearbeitung/wieder geöffneten Tagen', () => {
    const blob = closableBlob();
    const month = buildTagesabschlussRows(2026, 7, CLOSINGS, blob, CONF, null, 0);
    expect(readyForBuchhaltung(month)).toBe(false); // in_bearbeitung
  });

  it('merge: abschluesse jüngster updatedAt gewinnt, Historie = Union (keine Wiederbelebung nötig)', () => {
    let a = closableBlob();
    const rowsA = buildTagesabschlussRows(2026, 7, CLOSINGS, a, CONF, null, 0);
    a = closeDay(a, rowsA.rows[0], 'chef@oliv.ch', NOW);

    // Gerät B hat denselben Tag später wieder geöffnet (jüngerer updatedAt).
    const later = '2026-07-06T12:00:00.000Z';
    const b = reopenDay(a, '2026-07-01', 'admin@oliv.ch', 'Korrektur', later);

    const merged = mergeTagesabschlussBlobs(a, b);
    expect(merged.abschluesse['2026-07-01'].status).toBe('wieder_geoeffnet');
    // Historie ist die UNION beider Seiten, chronologisch sortiert.
    expect(merged.abschluesse['2026-07-01'].history.map(h => h.action))
      .toEqual(['abschluss', 'wiederoeffnung']);

    // Monatsabschluss überlebt den Merge mit leerer Gegenseite.
    let c = closeDay(b, buildTagesabschlussRows(2026, 7, CLOSINGS, b, CONF, null, 0).rows[0], 'chef@oliv.ch', later);
    const monthC = buildTagesabschlussRows(2026, 7, CLOSINGS, c, CONF, null, 0);
    c = closeMonth(c, '2026-07', monthC, 'admin@oliv.ch', later);
    const merged2 = mergeTagesabschlussBlobs(emptyTagesabschlussBlob(), c);
    expect(merged2.monatsabschluesse['2026-07']?.status).toBe('abgeschlossen');
  });
});

describe('setCashDiffReasons / setAnfangsbestand', () => {
  it('setCashDiffReasons trimmt, dedupliziert und entfernt bei leer/leer', () => {
    let blob = emptyTagesabschlussBlob();
    blob = setCashDiffReasons(blob, '2026-07-01', [' kassenfehler ', 'kassenfehler', ''], '  Notiz  ', NOW);
    expect(blob.cashDiffReasons['2026-07-01'].reasons).toEqual(['kassenfehler']);
    expect(blob.cashDiffReasons['2026-07-01'].note).toBe('Notiz');
    // Nur Notiz leeren: Gründe bleiben, note-Feld verschwindet.
    blob = setCashDiffReasons(blob, '2026-07-01', ['kassenfehler'], '   ', NOW);
    expect(blob.cashDiffReasons['2026-07-01'].note).toBeUndefined();
    // Beides leer → Eintrag weg.
    blob = setCashDiffReasons(blob, '2026-07-01', [], '', NOW);
    expect(blob.cashDiffReasons['2026-07-01']).toBeUndefined();
  });

  it('setAnfangsbestand rundet, setzt und entfernt (null)', () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, tagesabschlussMonthKey(2026, 7), 500.005, NOW);
    expect(blob.anfangsbestand['2026-07'].value).toBe(500.01);
    blob = setAnfangsbestand(blob, '2026-07', null, NOW);
    expect(blob.anfangsbestand['2026-07']).toBeUndefined();
    blob = setAnfangsbestand(blob, '2026-07', Number.NaN, NOW);
    expect(blob.anfangsbestand['2026-07']).toBeUndefined();
  });
});

describe('resolveKassensaldoStart', () => {
  it('expliziter Anfangsbestand DIESES Monats gewinnt sofort (kein Load)', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2026-07', 500, NOW);
    const calls: string[] = [];
    const res = await resolveKassensaldoStart(2026, 7, blob, async (y, m) => {
      calls.push(`${y}-${m}`);
      return {};
    });
    expect(res).toEqual({ startSaldo: 500, anchorMonth: '2026-07' });
    expect(calls).toEqual([]);
  });

  it('verankert im Vormonat und rechnet die Kette vorwärts (identische Rechenbasis)', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2026-05', 100, NOW);
    const byMonth: Record<string, Record<string, GnDayClosing>> = {
      '2026-6': { '2026-06-10': makeClosing('2026-06-10') }, // Bargeld Soll 300
      '2026-5': { '2026-05-05': makeClosing('2026-05-05') }, // Bargeld Soll 300
    };
    const res = await resolveKassensaldoStart(2026, 7, blob, async (y, m) => byMonth[`${y}-${m}`] ?? {});
    // Mai: 100 + 300 = 400 → Juni: 400 + 300 = 700 → Start Juli.
    expect(res.startSaldo).toBe(700);
    expect(res.anchorMonth).toBe('2026-05');
    // Gegenprobe: computeMonthEndSaldo einzeln.
    expect(computeMonthEndSaldo(2026, 5, byMonth['2026-5'], blob, 100)).toBe(400);
  });

  it('ohne früheren Anfangsbestand → null OHNE Loads (KEINE stille 0)', async () => {
    const calls: string[] = [];
    const res = await resolveKassensaldoStart(2026, 7, emptyTagesabschlussBlob(), async (y, m) => {
      calls.push(`${y}-${m}`);
      return {};
    });
    expect(res).toEqual({ startSaldo: null, anchorMonth: null });
    // Anker-Suche ist synchron über die Blob-Schlüssel — kein einziger Load.
    expect(calls).toEqual([]);
  });

  it('läuft lückenlos über Jahreswechsel UND Leermonate (kein Reset)', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2025-11', 100, NOW);
    const calls: string[] = [];
    const byMonth: Record<string, Record<string, GnDayClosing>> = {
      '2025-11': { '2025-11-10': makeClosing('2025-11-10') }, // Bargeld Soll 300
      // Dezember 2025 bewusst KOMPLETT leer (geschlossener Monat).
      '2026-1': { '2026-01-05': makeClosing('2026-01-05') },  // Bargeld Soll 300
    };
    const res = await resolveKassensaldoStart(2026, 2, blob, async (y, m) => {
      calls.push(`${y}-${m}`);
      return byMonth[`${y}-${m}`] ?? {};
    });
    // Nov: 100+300=400 → Dez (leer): 400 → Jan: 400+300=700 → Start Februar.
    expect(res).toEqual({ startSaldo: 700, anchorMonth: '2025-11' });
    expect(calls).toEqual(['2025-11', '2025-12', '2026-1']);
  });

  it('Änderung eines alten Tages (z. B. Bankeinzahlung) verschiebt den Folgemonats-Start', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2026-06', 500, NOW);
    const byMonth: Record<string, Record<string, GnDayClosing>> = {
      '2026-6': { '2026-06-10': makeClosing('2026-06-10') }, // Bargeld Soll 300
    };
    const load = async (y: number, m: number) => byMonth[`${y}-${m}`] ?? {};
    const before = await resolveKassensaldoStart(2026, 7, blob, load);
    expect(before.startSaldo).toBe(800);
    // Nachträgliche Bankeinzahlung am 10.06. reduziert den fortlaufenden Saldo.
    blob = upsertManualDay(blob, '2026-06-10', { einzahlungBank: 50 }, NOW);
    const after = await resolveKassensaldoStart(2026, 7, blob, load);
    expect(after.startSaldo).toBe(750);
  });

  it('expliziter Anker eines späteren Monats gewinnt (jüngster Anker vor dem Zielmonat)', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2026-01', 100, NOW);
    blob = setAnfangsbestand(blob, '2026-06', 900, NOW); // manuell korrigierter Anker
    const res = await resolveKassensaldoStart(2026, 7, blob, async () => ({}));
    expect(res).toEqual({ startSaldo: 900, anchorMonth: '2026-06' });
  });

  it('Monat VOR dem ältesten Anker → null (Kette läuft nur vorwärts)', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2026-06', 500, NOW);
    const res = await resolveKassensaldoStart(2026, 3, blob, async () => ({}));
    expect(res).toEqual({ startSaldo: null, anchorMonth: null });
  });

  it('Schutzkappe: unrealistisch weit entfernter Anker → null statt Endlos-Kette', async () => {
    let blob = emptyTagesabschlussBlob();
    blob = setAnfangsbestand(blob, '2010-01', 500, NOW);
    const calls: string[] = [];
    const res = await resolveKassensaldoStart(2026, 7, blob, async (y, m) => {
      calls.push(`${y}-${m}`);
      return {};
    });
    expect(res).toEqual({ startSaldo: null, anchorMonth: null });
    expect(calls).toHaveLength(KASSENSALDO_MAX_CHAIN_MONTHS);
  });
});

describe('Mutationen', () => {
  it('upsertManualDay entfernt geleerte Felder und leere Tage', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500, bemerkung: 'Test' }, NOW);
    expect(blob.days['2026-07-01'].bestandKasse).toBe(500);
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: null as unknown as undefined, bemerkung: '' }, NOW);
    expect(blob.days['2026-07-01']).toBeUndefined();
  });

  it('upsertManualDay speichert Gutscheinnummern (trimmt, verwirft Leereinträge, leer löscht)', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', {
      gutscheinNummernVerkauft: [' GS-101 ', 'GS-102', '  '],
      gutscheinNummernEingeloest: ['GS-088'],
    }, NOW);
    expect(blob.days['2026-07-01'].gutscheinNummernVerkauft).toEqual(['GS-101', 'GS-102']);
    expect(blob.days['2026-07-01'].gutscheinNummernEingeloest).toEqual(['GS-088']);

    // Einzel-Feld-Patch (z. B. Inline-Edit) erhält die Gutscheinnummern.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, NOW);
    expect(blob.days['2026-07-01'].gutscheinNummernVerkauft).toEqual(['GS-101', 'GS-102']);

    // Leeres Array / null löscht nur das jeweilige Feld.
    blob = upsertManualDay(blob, '2026-07-01', { gutscheinNummernVerkauft: [] }, NOW);
    expect(blob.days['2026-07-01'].gutscheinNummernVerkauft).toBeUndefined();
    expect(blob.days['2026-07-01'].gutscheinNummernEingeloest).toEqual(['GS-088']);
    expect(blob.days['2026-07-01'].bestandKasse).toBe(500);

    // Nur Gutscheinnummern halten den Tag am Leben; alles weg → Tag weg.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: null, gutscheinNummernEingeloest: null }, NOW);
    expect(blob.days['2026-07-01']).toBeUndefined();
  });

  it('buildTagesabschlussRows reicht Gutscheinnummern an die Zeile durch (nur Tagesdetail)', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { gutscheinNummernVerkauft: ['GS-1'] }, NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, {}, blob, {});
    expect(rows[0].gutscheinNummernVerkauft).toEqual(['GS-1']);
    expect(rows[0].gutscheinNummernEingeloest).toBeUndefined();
    expect(rows[1].gutscheinNummernVerkauft).toBeUndefined();
  });

  it('setTagesabschlussOverride verankert das ERSTE Original; null entfernt', () => {
    let blob = emptyTagesabschlussBlob();
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'umsatz', 1000, 990, undefined, NOW);
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'umsatz', 990, 980, undefined, NOW);
    const key = makeTagesabschlussFieldKey('2026-07-01', 'umsatz');
    expect(blob.overrides[key].originalValue).toBe(1000);
    expect(blob.overrides[key].correctedValue).toBe(980);
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'umsatz', 1000, null, undefined, NOW);
    expect(blob.overrides[key]).toBeUndefined();
  });

  it('setTagesabschlussComment setzt und entfernt Kommentare', () => {
    let blob = emptyTagesabschlussBlob();
    blob = setTagesabschlussComment(blob, '2026-07-01', 'bar', ' Kassensturz ok ', NOW);
    const key = makeTagesabschlussFieldKey('2026-07-01', 'bar');
    expect(blob.comments[key].text).toBe('Kassensturz ok');
    blob = setTagesabschlussComment(blob, '2026-07-01', 'bar', '  ', NOW);
    expect(blob.comments[key]).toBeUndefined();
  });

  it('upsertExpense aktualisiert per id und behandelt Datumswechsel', () => {
    let blob = emptyTagesabschlussBlob();
    const e: CashExpense = { id: 'e1', date: '2026-07-01', amount: 50, konto: '6000', text: 'Post', updatedAt: NOW };
    blob = upsertExpense(blob, e);
    blob = upsertExpense(blob, { ...e, amount: 60 });
    expect(blob.expenses['2026-07-01']).toHaveLength(1);
    expect(blob.expenses['2026-07-01'][0].amount).toBe(60);
    blob = upsertExpense(blob, { ...e, date: '2026-07-02' });
    expect(blob.expenses['2026-07-01']).toBeUndefined();
    expect(blob.expenses['2026-07-02']).toHaveLength(1);
    blob = removeExpense(blob, '2026-07-02', 'e1');
    expect(blob.expenses['2026-07-02']).toBeUndefined();
  });

  it('expensesTotal ignoriert kaputte Beträge', () => {
    expect(expensesTotal([
      { id: 'a', date: 'x', amount: 10.55, konto: '1', text: '', updatedAt: NOW },
      { id: 'b', date: 'x', amount: Number.NaN, konto: '1', text: '', updatedAt: NOW },
    ])).toBe(10.55);
    expect(expensesTotal(undefined)).toBe(0);
  });
});

describe('normalizeTagesabschlussBlob', () => {
  it('liefert bei Müll einen leeren Blob', () => {
    expect(normalizeTagesabschlussBlob(null)).toEqual(emptyTagesabschlussBlob());
    expect(normalizeTagesabschlussBlob('kaputt')).toEqual(emptyTagesabschlussBlob());
    expect(normalizeTagesabschlussBlob([1, 2])).toEqual(emptyTagesabschlussBlob());
  });

  it('filtert kaputte Expense-Listen defensiv', () => {
    const raw = { expenses: { '2026-07-01': [null, { id: 'e1' }], bad: 'x' } };
    const blob = normalizeTagesabschlussBlob(raw);
    expect(blob.expenses['2026-07-01']).toHaveLength(1);
    expect((blob.expenses as Record<string, unknown>)['bad']).toBeUndefined();
  });
});

describe('defaultExportSettings', () => {
  it('nutzt die echten Kontoplan-Oliv-Konten und ist NICHT reviewed', () => {
    const s = defaultExportSettings(NOW);
    expect(s.konten.kasse).toBe('1000');
    expect(s.konten.bank).toBe('1020');
    expect(s.konten.umsatzTransit).toBe('1098');
    expect(s.kontoJeZahlungsart.twint).toBe('1119');
    expect(s.reviewed).toBe(false);
  });
});

describe('mergeTagesabschlussBlobs', () => {
  const OLD = '2026-07-01T00:00:00.000Z';
  const NEW = '2026-07-05T00:00:00.000Z';

  function blobWith(over: Partial<TagesabschlussBlob>): TagesabschlussBlob {
    return { ...emptyTagesabschlussBlob(), ...over };
  }

  it('jüngerer updatedAt gewinnt je Tag', () => {
    const local = blobWith({ days: { '2026-07-01': { bestandKasse: 100, updatedAt: OLD } } });
    const remote = blobWith({ days: { '2026-07-01': { bestandKasse: 200, updatedAt: NEW } } });
    expect(mergeTagesabschlussBlobs(local, remote).days['2026-07-01'].bestandKasse).toBe(200);
    expect(mergeTagesabschlussBlobs(remote, local).days['2026-07-01'].bestandKasse).toBe(200);
  });

  it('fremde Tage bleiben erhalten (kein naiver Blob-Write)', () => {
    const local = blobWith({ days: { '2026-07-01': { bestandKasse: 100, updatedAt: NEW } } });
    const remote = blobWith({ days: { '2026-07-02': { bestandKasse: 300, updatedAt: OLD } } });
    const merged = mergeTagesabschlussBlobs(local, remote);
    expect(merged.days['2026-07-01'].bestandKasse).toBe(100);
    expect(merged.days['2026-07-02'].bestandKasse).toBe(300);
  });

  it('Barausgaben werden über die id vereinigt; Datumswechsel folgt dem Jüngeren', () => {
    const local = blobWith({
      expenses: { '2026-07-01': [{ id: 'e1', date: '2026-07-01', amount: 10, konto: '6000', text: 'A', updatedAt: NEW }] },
    });
    const remote = blobWith({
      expenses: {
        '2026-07-02': [
          { id: 'e1', date: '2026-07-02', amount: 20, konto: '6000', text: 'A alt', updatedAt: OLD },
          { id: 'e2', date: '2026-07-02', amount: 30, konto: '6100', text: 'B', updatedAt: OLD },
        ],
      },
    });
    const merged = mergeTagesabschlussBlobs(local, remote);
    expect(merged.expenses['2026-07-01']).toHaveLength(1);
    expect(merged.expenses['2026-07-01'][0].amount).toBe(10);
    expect(merged.expenses['2026-07-02']).toHaveLength(1);
    expect(merged.expenses['2026-07-02'][0].id).toBe('e2');
  });

  it('cashDiffReasons und anfangsbestand mergen je Schlüssel nach updatedAt', () => {
    const local = blobWith({
      cashDiffReasons: { '2026-07-01': { reasons: ['kassenfehler'], updatedAt: OLD } },
      anfangsbestand: { '2026-07': { value: 100, updatedAt: NEW } },
    });
    const remote = blobWith({
      cashDiffReasons: {
        '2026-07-01': { reasons: ['trinkgeld_differenz'], updatedAt: NEW },
        '2026-07-02': { reasons: [], note: 'x', updatedAt: OLD },
      },
      anfangsbestand: { '2026-07': { value: 900, updatedAt: OLD } },
    });
    const merged = mergeTagesabschlussBlobs(local, remote);
    expect(merged.cashDiffReasons['2026-07-01'].reasons).toEqual(['trinkgeld_differenz']);
    expect(merged.cashDiffReasons['2026-07-02'].note).toBe('x');
    expect(merged.anfangsbestand['2026-07'].value).toBe(100);
  });

  it('exportSettings: jüngere Version gewinnt, einseitige bleibt', () => {
    const sOld = { ...defaultExportSettings(OLD), reviewed: true };
    const sNew = defaultExportSettings(NEW);
    expect(mergeTagesabschlussBlobs(blobWith({ exportSettings: sOld }), blobWith({ exportSettings: sNew }))
      .exportSettings?.updatedAt).toBe(NEW);
    expect(mergeTagesabschlussBlobs(blobWith({ exportSettings: sOld }), blobWith({}))
      .exportSettings?.reviewed).toBe(true);
    expect(mergeTagesabschlussBlobs(blobWith({}), blobWith({})).exportSettings).toBeNull();
  });

  it('setExportSettings ersetzt die Einstellungen im Blob', () => {
    const blob = setExportSettings(emptyTagesabschlussBlob(), defaultExportSettings(NOW));
    expect(blob.exportSettings?.konten.kasse).toBe('1000');
  });
});

describe('Inline-Edit-Semantik (Einzel-Feld-Patches)', () => {
  it('Einzel-Feld-Patch erhält die übrigen manuellen Werte des Tages', () => {
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500, bemerkung: 'Notiz' }, NOW);
    // Inline-Edit: NUR Einzahlung Bank patchen.
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 80 }, NOW);
    expect(blob.days['2026-07-01'].bestandKasse).toBe(500);
    expect(blob.days['2026-07-01'].bemerkung).toBe('Notiz');
    expect(blob.days['2026-07-01'].einzahlungBank).toBe(80);
    // null löscht NUR das gepatchte Feld.
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: null }, NOW);
    expect(blob.days['2026-07-01'].bestandKasse).toBeUndefined();
    expect(blob.days['2026-07-01'].einzahlungBank).toBe(80);
  });

  it('Monats-Totale/KPIs aktualisieren sich nach einem Inline-Patch', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    const before = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(before.totals.values.einzahlungBank).toBe(0);

    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 120 }, NOW);
    const after = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(after.totals.values.einzahlungBank).toBe(120);
    const row = after.rows.find(r => r.date === '2026-07-01');
    expect(row?.cells.einzahlungBank.value).toBe(120);
    expect(row?.cells.einzahlungBank.source).toBe('manual');
  });
});
