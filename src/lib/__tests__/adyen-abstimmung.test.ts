// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  ADYEN_DIFF_THRESHOLDS,
  adyenDiffStatus,
  emptyAdyenBlob,
  normalizeAdyenBlob,
  mergeAdyenImport,
  makeFieldKey,
  normalizeGnPaymentName,
  effectiveValue,
  buildDayComparison,
  canConfirmDay,
  setOverride,
  setComment,
  setDayConfirmation,
  adyenDaysFromBlob,
  type AdyenAbstimmungBlob,
  type AdyenStoredDay,
  type GnDayPayment,
} from '../adyen-abstimmung';

const DAY = '2026-06-01';

function storedDay(byMethod: Record<string, number>, overrides: Partial<AdyenStoredDay> = {}): AdyenStoredDay {
  const total = Math.round(Object.values(byMethod).reduce((s, v) => s + v, 0) * 100) / 100;
  return {
    byMethod,
    countByMethod: Object.fromEntries(Object.keys(byMethod).map(k => [k, 1])),
    total,
    transactionCount: Object.keys(byMethod).length,
    fileName: 'test.csv',
    importedAt: '2026-06-02T08:00:00.000Z',
    ...overrides,
  };
}

const GN_PAYMENTS: GnDayPayment[] = [
  { name: 'Mastercard', count: 3, amount: 254.6 },
  { name: 'VISA', count: 2, amount: 244.4 },
  { name: 'AMEX', count: 1, amount: 175.25 },
  { name: 'TWINT', count: 2, amount: 40.0 },
  { name: 'Bar', count: 12, amount: 830.5 },
  { name: 'Gutschein', count: 1, amount: 50.0 },
];

function blobWithDay(byMethod: Record<string, number>): AdyenAbstimmungBlob {
  const blob = emptyAdyenBlob();
  blob.days[DAY] = storedDay(byMethod);
  blob.methodLabels = { mastercard: 'Mastercard', visa: 'Visa', amex: 'American Express', twint: 'TWINT' };
  return blob;
}

describe('adyenDiffStatus', () => {
  it('0.00 und Rundungstoleranz = grün, klein = orange, gross = rot', () => {
    expect(adyenDiffStatus(0)).toBe('ok');
    expect(adyenDiffStatus(ADYEN_DIFF_THRESHOLDS.green)).toBe('ok');
    expect(adyenDiffStatus(-0.05)).toBe('ok');
    expect(adyenDiffStatus(0.06)).toBe('small');
    expect(adyenDiffStatus(-5)).toBe('small');
    expect(adyenDiffStatus(5.01)).toBe('large');
    expect(adyenDiffStatus(-123.45)).toBe('large');
  });
});

describe('normalizeGnPaymentName', () => {
  it('mappt Z-Bericht-Namen auf die Adyen-Keys', () => {
    expect(normalizeGnPaymentName('Mastercard').key).toBe('mastercard');
    expect(normalizeGnPaymentName('VISA').key).toBe('visa');
    expect(normalizeGnPaymentName('AMEX')).toMatchObject({ key: 'amex', isCard: true });
    expect(normalizeGnPaymentName('American Express').key).toBe('amex');
    expect(normalizeGnPaymentName('TWINT')).toMatchObject({ key: 'twint', isCard: true });
    expect(normalizeGnPaymentName('Kartenzahlung')).toMatchObject({ key: 'karte', isCard: true });
  });

  it('lässt Bar/Gutscheine/Rechnung als Nicht-Karten durch', () => {
    expect(normalizeGnPaymentName('Bar').isCard).toBe(false);
    expect(normalizeGnPaymentName('Gutschein').isCard).toBe(false);
    expect(normalizeGnPaymentName('Rechnung / Debitoren').isCard).toBe(false);
    expect(normalizeGnPaymentName('Trinkgeld').isCard).toBe(false);
  });

  it('kartenähnliche Zahlarten ohne Adyen-Abwicklung: isKkCard true, isCard false', () => {
    // KK-Total/Export JA — Adyen-Vergleichsbasis NEIN (laufen nicht über Adyen).
    expect(normalizeGnPaymentName('PostCard')).toMatchObject({ key: 'postcard', isCard: false, isKkCard: true });
    expect(normalizeGnPaymentName('PostFinance Card')).toMatchObject({ key: 'postcard', isKkCard: true });
    expect(normalizeGnPaymentName('Lunch-Check')).toMatchObject({ key: 'lunch_check', isCard: false, isKkCard: true });
    expect(normalizeGnPaymentName('Lunch Check')).toMatchObject({ key: 'lunch_check', isKkCard: true });
    expect(normalizeGnPaymentName('Stripe')).toMatchObject({ key: 'stripe', isCard: false, isKkCard: true });
    // Adyen-Karten sind auch KK-Karten.
    expect(normalizeGnPaymentName('Mastercard')).toMatchObject({ isCard: true, isKkCard: true });
    expect(normalizeGnPaymentName('AMEX')).toMatchObject({ isCard: true, isKkCard: true });
    // Unklassifizierte bleiben komplett draussen.
    expect(normalizeGnPaymentName('KD Tisch 5000')).toMatchObject({ key: 'kd_tisch_5000', isCard: false, isKkCard: false });
    expect(normalizeGnPaymentName('Bar').isKkCard).toBe(false);
  });
});

describe('mergeAdyenImport', () => {
  it('ersetzt nur importierte Tage und erhält Overrides/Kommentare/Bestätigungen', () => {
    let blob = blobWithDay({ mastercard: 100 });
    blob = setOverride(blob, makeFieldKey(DAY, 'adyen', 'mastercard'), 100, 95, 'Korrektur', '2026-06-02T09:00:00Z');
    blob = setComment(blob, makeFieldKey(DAY, 'zbericht', 'bar'), 'Kasse neu gezählt', '2026-06-02T09:01:00Z');
    blob = setDayConfirmation(blob, DAY, { confirmed: true, cashCounted: true, confirmedAt: '2026-06-02T09:02:00Z' });

    const merged = mergeAdyenImport(
      blob,
      {
        days: [{ date: DAY, byMethod: { mastercard: 254.6 }, countByMethod: { mastercard: 3 }, total: 254.6, transactionCount: 3 }],
        methodLabels: { mastercard: 'Mastercard' },
      },
      'neu.csv',
      '2026-06-03T10:00:00Z',
    );

    expect(merged.days[DAY].byMethod.mastercard).toBe(254.6);
    expect(merged.days[DAY].fileName).toBe('neu.csv');
    // Overrides/Kommentare/Bestätigungen bleiben erhalten:
    expect(merged.overrides[makeFieldKey(DAY, 'adyen', 'mastercard')].correctedValue).toBe(95);
    expect(merged.comments[makeFieldKey(DAY, 'zbericht', 'bar')].text).toBe('Kasse neu gezählt');
    expect(merged.confirmations[DAY].confirmed).toBe(true);
    // Ursprüngliches Blob unverändert (immutabel):
    expect(blob.days[DAY].fileName).toBe('test.csv');
  });
});

describe('buildDayComparison', () => {
  it('vergleicht Z-Bericht und Adyen je Zahlungsart mit Differenz-Status', () => {
    const blob = blobWithDay({ mastercard: 254.6, visa: 244.4, amex: 175.25, twint: 40.0 });
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);

    expect(cmp.hasZbericht).toBe(true);
    expect(cmp.hasAdyen).toBe(true);
    // Feste Reihenfolge: Mastercard, Visa, AMEX, TWINT
    expect(cmp.rows.map(r => r.methodKey)).toEqual(['mastercard', 'visa', 'amex', 'twint']);
    for (const r of cmp.rows) {
      expect(r.diff).toBe(0);
      expect(r.diffStatus).toBe('ok');
    }
    expect(cmp.cardTotalZ?.value).toBeCloseTo(714.25, 2);
    expect(cmp.cardTotalAdyen?.value).toBeCloseTo(714.25, 2);
    expect(cmp.totalDiff).toBe(0);
    expect(cmp.totalStatus).toBe('ok');
    // Nicht-Karten aus dem Z-Bericht (Bar, Gutschein) mit Kommentar-FieldKeys:
    expect(cmp.nonCardRows.map(r => r.label)).toEqual(['Bar', 'Gutschein']);
    expect(cmp.nonCardRows[0].value.value).toBeCloseTo(830.5, 2);
  });

  it('färbt kleine Differenzen orange und grosse rot', () => {
    const blob = blobWithDay({ mastercard: 252.1, visa: 150.0, amex: 175.25, twint: 40.0 });
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);
    const mc = cmp.rows.find(r => r.methodKey === 'mastercard')!;
    expect(mc.diff).toBeCloseTo(2.5, 2);
    expect(mc.diffStatus).toBe('small');
    const visa = cmp.rows.find(r => r.methodKey === 'visa')!;
    expect(visa.diff).toBeCloseTo(94.4, 2);
    expect(visa.diffStatus).toBe('large');
  });

  it('Override ersetzt den Wert in der Berechnung, Original bleibt sichtbar', () => {
    let blob = blobWithDay({ mastercard: 252.1, visa: 244.4, amex: 175.25, twint: 40.0 });
    const key = makeFieldKey(DAY, 'adyen', 'mastercard');
    blob = setOverride(blob, key, 252.1, 254.6, 'Beleg nachträglich gefunden', '2026-06-02T09:00:00Z');
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);

    const mc = cmp.rows.find(r => r.methodKey === 'mastercard')!;
    expect(mc.adyen?.value).toBe(254.6);          // Berechnung nutzt correctedValue
    expect(mc.adyen?.original).toBe(252.1);       // Original bleibt sichtbar
    expect(mc.adyen?.overridden).toBe(true);
    expect(mc.adyen?.override?.comment).toBe('Beleg nachträglich gefunden');
    expect(mc.diff).toBe(0);
    expect(mc.diffStatus).toBe('ok');
    // Total rechnet mit dem korrigierten Zeilenwert weiter:
    expect(cmp.cardTotalAdyen?.value).toBeCloseTo(714.25, 2);
    expect(cmp.totalStatus).toBe('ok');
    expect(cmp.hasOverrides).toBe(true);
  });

  it('Total-Override ersetzt das automatische Total', () => {
    let blob = blobWithDay({ mastercard: 254.6, visa: 244.4, amex: 175.25, twint: 40.0 });
    blob = setOverride(blob, makeFieldKey(DAY, 'adyen', 'total'), 714.25, 700, undefined, '2026-06-02T09:00:00Z');
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);
    expect(cmp.cardTotalAdyen?.value).toBe(700);
    expect(cmp.cardTotalAdyen?.original).toBeCloseTo(714.25, 2);
    expect(cmp.totalDiff).toBeCloseTo(14.25, 2);
    expect(cmp.totalStatus).toBe('large');
  });

  it('Kommentare hängen am FieldKey und markieren den Tag', () => {
    let blob = blobWithDay({ mastercard: 254.6, visa: 244.4, amex: 175.25, twint: 40.0 });
    const key = makeFieldKey(DAY, 'zbericht', 'bar');
    blob = setComment(blob, key, 'Wechselgeld-Differenz 2.00 geklärt', '2026-06-02T09:00:00Z');
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);
    expect(cmp.nonCardRows.find(r => r.methodKey === 'bar')?.comment?.text)
      .toBe('Wechselgeld-Differenz 2.00 geklärt');
    expect(cmp.hasComments).toBe(true);
  });

  it('fehlende Seiten: nur Adyen ohne Z-Bericht bzw. umgekehrt', () => {
    const blob = blobWithDay({ mastercard: 100 });
    const nurAdyen = buildDayComparison(DAY, null, blob.days[DAY], blob);
    expect(nurAdyen.hasZbericht).toBe(false);
    expect(nurAdyen.cardTotalZ).toBeNull();
    expect(nurAdyen.totalDiff).toBeNull();
    expect(nurAdyen.rows[0].diff).toBeCloseTo(-100, 2); // fehlende Seite zählt als 0

    const nurZ = buildDayComparison(DAY, GN_PAYMENTS, null, emptyAdyenBlob());
    expect(nurZ.hasAdyen).toBe(false);
    expect(nurZ.cardTotalAdyen).toBeNull();
    expect(nurZ.rows.length).toBe(4);
  });
});

describe('canConfirmDay', () => {
  const matchingBlob = () => blobWithDay({ mastercard: 254.6, visa: 244.4, amex: 175.25, twint: 40.0 });

  it('bestätigbar wenn Z-Bericht da, alle Diffs grün und Barbestand bestätigt', () => {
    const blob = matchingBlob();
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);
    expect(canConfirmDay(cmp, true)).toEqual({ ok: true, missing: [] });
    expect(canConfirmDay(cmp, false).missing).toEqual(['Barbestand nicht bestätigt']);
  });

  it('blockiert ohne Z-Bericht bzw. ohne Adyen-Import', () => {
    const blob = matchingBlob();
    const ohneZ = buildDayComparison(DAY, null, blob.days[DAY], blob);
    expect(canConfirmDay(ohneZ, true).missing).toContain('Z-Bericht fehlt');
    const ohneAdyen = buildDayComparison(DAY, GN_PAYMENTS, null, emptyAdyenBlob());
    expect(canConfirmDay(ohneAdyen, true).missing).toContain('Adyen-Import fehlt');
  });

  it('blockiert ungeklärte Differenzen — Override ODER Kommentar klärt sie', () => {
    const blob = blobWithDay({ mastercard: 200, visa: 244.4, amex: 175.25, twint: 40.0 });
    const cmp = buildDayComparison(DAY, GN_PAYMENTS, blob.days[DAY], blob);
    const check = canConfirmDay(cmp, true);
    expect(check.ok).toBe(false);
    expect(check.missing[0]).toMatch(/Mastercard/);

    // Kommentar an der Adyen-Zeile klärt die Differenz:
    let blob2 = blobWithDay({ mastercard: 200, visa: 244.4, amex: 175.25, twint: 40.0 });
    blob2 = setComment(blob2, makeFieldKey(DAY, 'adyen', 'mastercard'), 'Terminal-Ausfall, Beleg fehlt', '2026-06-02T09:00:00Z');
    const cmp2 = buildDayComparison(DAY, GN_PAYMENTS, blob2.days[DAY], blob2);
    // Zeile geklärt, aber Total-Differenz bleibt → über Total-Kommentar klären
    let blob3 = setComment(blob2, makeFieldKey(DAY, 'adyen', 'total'), 'siehe Mastercard', '2026-06-02T09:05:00Z');
    const cmp3 = buildDayComparison(DAY, GN_PAYMENTS, blob3.days[DAY], blob3);
    expect(canConfirmDay(cmp3, true).ok).toBe(true);

    // Override klärt ebenfalls (Diff wird grün gerechnet):
    let blob4 = blobWithDay({ mastercard: 200, visa: 244.4, amex: 175.25, twint: 40.0 });
    blob4 = setOverride(blob4, makeFieldKey(DAY, 'adyen', 'mastercard'), 200, 254.6, 'Nachbuchung', '2026-06-02T09:00:00Z');
    const cmp4 = buildDayComparison(DAY, GN_PAYMENTS, blob4.days[DAY], blob4);
    expect(canConfirmDay(cmp4, true).ok).toBe(true);
    void cmp2;
  });
});

describe('setOverride / setComment / setDayConfirmation', () => {
  it('behält beim zweiten Override das ERSTE Original', () => {
    let blob = emptyAdyenBlob();
    const key = makeFieldKey(DAY, 'adyen', 'visa');
    blob = setOverride(blob, key, 100, 110, undefined, '2026-06-02T09:00:00Z');
    blob = setOverride(blob, key, 110, 120, undefined, '2026-06-02T10:00:00Z');
    expect(blob.overrides[key].originalValue).toBe(100);
    expect(blob.overrides[key].correctedValue).toBe(120);
  });

  it('entfernt Override bei correctedValue null und Kommentar bei Leertext', () => {
    let blob = emptyAdyenBlob();
    const key = makeFieldKey(DAY, 'adyen', 'visa');
    blob = setOverride(blob, key, 100, 110, undefined, '2026-06-02T09:00:00Z');
    blob = setOverride(blob, key, 100, null, undefined, '2026-06-02T10:00:00Z');
    expect(blob.overrides[key]).toBeUndefined();

    blob = setComment(blob, key, 'Hinweis', '2026-06-02T09:00:00Z');
    blob = setComment(blob, key, '   ', '2026-06-02T10:00:00Z');
    expect(blob.comments[key]).toBeUndefined();
  });

  it('effectiveValue nutzt correctedValue nur bei gesetztem Override', () => {
    let blob = emptyAdyenBlob();
    const key = makeFieldKey(DAY, 'zbericht', 'twint');
    expect(effectiveValue(blob.overrides, key, 40).value).toBe(40);
    blob = setOverride(blob, key, 40, 42.5, undefined, '2026-06-02T09:00:00Z');
    const ev = effectiveValue(blob.overrides, key, 40);
    expect(ev.value).toBe(42.5);
    expect(ev.original).toBe(40);
    expect(ev.overridden).toBe(true);
  });
});

describe('normalizeAdyenBlob / adyenDaysFromBlob', () => {
  it('normalisiert beschädigte Blobs defensiv', () => {
    expect(normalizeAdyenBlob(null)).toEqual(emptyAdyenBlob());
    expect(normalizeAdyenBlob([1, 2])).toEqual(emptyAdyenBlob());
    expect(normalizeAdyenBlob({ days: { [DAY]: storedDay({ visa: 1 }) }, overrides: 'kaputt' }).days[DAY]).toBeDefined();
  });

  it('liefert nur Tage ≤ heute, sortiert (Cockpit-Signal)', () => {
    const blob = emptyAdyenBlob();
    blob.days['2026-06-02'] = storedDay({ visa: 1 });
    blob.days['2026-06-01'] = storedDay({ visa: 1 });
    blob.days['2026-07-15'] = storedDay({ visa: 1 }); // Zukunft → ignoriert
    blob.days['unsinn'] = storedDay({ visa: 1 });     // kein ISO-Tag → ignoriert
    expect(adyenDaysFromBlob(blob, '2026-07-06')).toEqual(['2026-06-01', '2026-06-02']);
  });
});
