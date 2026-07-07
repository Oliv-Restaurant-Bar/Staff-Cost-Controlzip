// @vitest-environment node
/**
 * Tests für die reine Tagesabschluss-Logik (tagesabschluss.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  buildTagesabschlussRows,
  deriveAutoValues,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  expensesTotal,
  makeTagesabschlussFieldKey,
  mergeTagesabschlussBlobs,
  monthDates,
  normalizeTagesabschlussBlob,
  removeExpense,
  setExportSettings,
  setTagesabschlussComment,
  setTagesabschlussOverride,
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
});

describe('buildTagesabschlussRows', () => {
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

  it('Status "bestaetigt" kommt aus den Adyen-Tagesbestätigungen', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const { rows } = buildTagesabschlussRows(2026, 7, closings, emptyTagesabschlussBlob(), {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    });
    expect(rows[0].status).toBe('bestaetigt');
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

  it('manuelle Felder erscheinen als "manual"; Kassen-Diff braucht Vortagsbestand', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
    };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, NOW);
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 700, einzahlungBank: 80 }, NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(rows[0].cells.bestandKasse.source).toBe('manual');
    expect(rows[0].kassenDiff).toBeNull(); // kein Vortagsbestand
    // Tag 2: (700−500) − (300 − 0 − 80) = 200 − 220 = −20
    expect(rows[1].kassenDiff).toBe(-20);
    expect(rows[1].kassenDiffStatus).toBe('large');
  });

  it('Kassen-Diff-Ampel: exakte Kasse ist grün', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
    };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, NOW);
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 720, einzahlungBank: 80 }, NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    // (720−500) − (300−0−80) = 220 − 220 = 0
    expect(rows[1].kassenDiff).toBe(0);
    expect(rows[1].kassenDiffStatus).toBe('ok');
  });

  it('Barausgaben senken die erwartete Kassenbewegung; Übersicht zeigt Total', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01'),
      '2026-07-02': makeClosing('2026-07-02'),
    };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, NOW);
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 650 }, NOW);
    const exp: CashExpense = {
      id: 'e1', date: '2026-07-02', amount: 150, konto: '6000', text: 'Blumen', updatedAt: NOW,
    };
    blob = upsertExpense(blob, exp);
    const { rows, totals } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(rows[1].barausgabenTotal).toBe(150);
    expect(rows[1].expenseCount).toBe(1);
    // (650−500) − (300−150−0) = 150 − 150 = 0
    expect(rows[1].kassenDiff).toBe(0);
    expect(totals.barausgaben).toBe(150);
  });

  it('Totale: Bestand Kasse ist letzter Stand, kein Summentotal', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 500 }, NOW);
    blob = upsertManualDay(blob, '2026-07-15', { bestandKasse: 800 }, NOW);
    const { totals } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(totals.values.bestandKasse).toBe(800);
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
    // Kassen-Diff am 03.: (700−500) − (300−0−0) = −100 → large.
    blob = upsertManualDay(blob, '2026-07-02', { bestandKasse: 500 }, NOW);
    blob = upsertManualDay(blob, '2026-07-03', { bestandKasse: 700 }, NOW);
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: {
        '2026-07-01': makeAdyenDay({ mastercard: 400, visa: 150, twint: 100 }), // ok
        '2026-07-02': makeAdyenDay({ mastercard: 380, visa: 150, twint: 100 }), // Diff 20 → large
      },
    };
    const { totals } = buildTagesabschlussRows(2026, 7, closings, blob, {
      '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
    }, adyenBlob);

    expect(totals.daysWithZbericht).toBe(3);
    expect(totals.daysConfirmed).toBe(1);
    expect(totals.daysOpen).toBe(2);          // 02. + 03. offen
    // 02. via Adyen-Diff, 03. via Kassen-Diff — je EINMAL gezählt.
    expect(totals.daysWithDiff).toBe(2);
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
