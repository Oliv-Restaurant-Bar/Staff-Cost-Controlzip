// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseAdyenPaymentsCsv, normalizeAdyenMethod } from '../adyen-csv-parser';

// Synthetische Fixture nach Adyen-Standardformat „Received payment details"
// (kein echtes Beispiel-CSV im Projekt vorhanden — Spalten gemäss Adyen-Doku).
const HEADER =
  'Company Account,Merchant Account,Psp Reference,Merchant Reference,Payment Method,' +
  'Creation Date,TimeZone,Currency,Amount,Type,Shopper Interaction';

function row(psp: string, method: string, date: string, currency: string, amount: string, type = 'Received'): string {
  return `OlivCo,OlivPOS,${psp},ref-${psp},${method},${date},Europe/Zurich,${currency},${amount},${type},POS`;
}

const FIXTURE_0106 = [
  HEADER,
  // 01.06.2026 — Mastercard 3 Zahlungen
  row('1001', 'mc',        '2026-06-01 09:15:02', 'CHF', '120.50'),
  row('1002', 'mc',        '2026-06-01 12:40:11', 'CHF', '89.00'),
  row('1003', 'mc_applepay', '2026-06-01 19:05:44', 'CHF', '45.10'),
  // Visa 2 Zahlungen + 1 Refund (positiver Betrag, Typ Refund → abziehen)
  row('1004', 'visa',      '2026-06-01 11:22:00', 'CHF', '210.00'),
  row('1005', 'visa',      '2026-06-01 20:10:31', 'CHF', '64.40'),
  row('1006', 'visa',      '2026-06-01 21:00:00', 'CHF', '30.00', 'Refund'),
  // AMEX 1 Zahlung
  row('1007', 'amex',      '2026-06-01 13:00:09', 'CHF', '175.25'),
  // TWINT POS 2 Zahlungen, davon 1 negativer Betrag (Storno)
  row('1008', 'twint_pos', '2026-06-01 18:30:00', 'CHF', '52.00'),
  row('1009', 'twint_pos', '2026-06-01 18:45:00', 'CHF', '-12.00'),
  // Dynamische Zahlungsart (Maestro)
  row('1010', 'maestro',   '2026-06-01 14:20:00', 'CHF', '33.90'),
  // EUR-Zeile → muss übersprungen werden
  row('1011', 'visa',      '2026-06-01 15:00:00', 'EUR', '99.99'),
  // Anderer Tag (02.06.)
  row('1012', 'mc',        '2026-06-02 10:00:00', 'CHF', '77.70'),
].join('\n');

// Settlement-/Payout-Report (verbotenes Format) — enthält Payout-Spalten.
const PAYOUT_CSV = [
  'Company Account,Merchant Account,Psp Reference,Payment Method,Creation Date,TimeZone,Type,' +
  'Gross Currency,Gross Debit (GC),Gross Credit (GC),Net Currency,Net Debit (NC),Net Credit (NC),Payable Date,Batch Number',
  'OlivCo,OlivPOS,2001,mc,2026-06-01 09:15:02,Europe/Zurich,Settled,CHF,,120.50,CHF,,118.90,2026-06-04,42',
].join('\n');

describe('normalizeAdyenMethod', () => {
  it('bündelt bekannte Karten/TWINT auf stabile Keys', () => {
    expect(normalizeAdyenMethod('mc')).toEqual({ key: 'mastercard', label: 'Mastercard' });
    expect(normalizeAdyenMethod('mc_applepay').key).toBe('mastercard');
    expect(normalizeAdyenMethod('visa').key).toBe('visa');
    expect(normalizeAdyenMethod('amex')).toEqual({ key: 'amex', label: 'American Express' });
    expect(normalizeAdyenMethod('twint_pos')).toEqual({ key: 'twint', label: 'TWINT' });
    expect(normalizeAdyenMethod('twint').key).toBe('twint');
  });

  it('lässt unbekannte Zahlungsarten dynamisch als Slug durch', () => {
    expect(normalizeAdyenMethod('maestro').key).toBe('maestro');
    expect(normalizeAdyenMethod('Alipay HK')).toEqual({ key: 'alipay_hk', label: 'Alipay HK' });
  });
});

describe('parseAdyenPaymentsCsv — Received payment details', () => {
  it('liest das CSV vom 01.06.2026 korrekt ein und summiert pro Zahlungsart', () => {
    const res = parseAdyenPaymentsCsv(FIXTURE_0106, 'received_payment_details_juni.csv');
    expect(res.ok).toBe(true);
    expect(res.failureReason).toBeNull();
    expect(res.days.map(d => d.date)).toEqual(['2026-06-01', '2026-06-02']);

    const day = res.days[0];
    // Mastercard: 120.50 + 89.00 + 45.10 (Apple-Pay-Variante zählt zu Mastercard)
    expect(day.byMethod.mastercard).toBeCloseTo(254.60, 2);
    // Visa: 210.00 + 64.40 − 30.00 (Refund abgezogen); EUR-Zeile NICHT enthalten
    expect(day.byMethod.visa).toBeCloseTo(244.40, 2);
    expect(day.byMethod.amex).toBeCloseTo(175.25, 2);
    // TWINT: 52.00 − 12.00 (negativer Betrag korrekt abgezogen)
    expect(day.byMethod.twint).toBeCloseTo(40.00, 2);
    // Dynamische Zahlungsart bleibt erhalten
    expect(day.byMethod.maestro).toBeCloseTo(33.90, 2);
    // Tages-Total = Summe aller Zahlungsarten
    expect(day.total).toBeCloseTo(254.60 + 244.40 + 175.25 + 40.00 + 33.90, 2);
    expect(day.transactionCount).toBe(10);

    expect(res.days[1].byMethod.mastercard).toBeCloseTo(77.70, 2);
    expect(res.methodLabels.mastercard).toBe('Mastercard');
    expect(res.methodLabels.twint).toBe('TWINT');
  });

  it('überspringt Nicht-CHF-Zeilen mit Warnung und Debug-Zähler', () => {
    const res = parseAdyenPaymentsCsv(FIXTURE_0106);
    expect(res.debug.skippedNonChf).toBe(1);
    expect(res.debug.currencies).toContain('EUR');
    expect(res.warnings.some(w => w.includes('Nicht-CHF'))).toBe(true);
  });

  it('lehnt einen Settlement-/Payout-Report als falsches Format ab', () => {
    const res = parseAdyenPaymentsCsv(PAYOUT_CSV, 'settlement_detail_report.csv');
    expect(res.ok).toBe(false);
    expect(res.days).toEqual([]);
    expect(res.failureReason).toMatch(/Settlement-\/Payout-Report/);
    expect(res.failureReason).toMatch(/Received payment details/);
    expect(res.debug.failureReason).toBe(res.failureReason);
  });

  it('lehnt CSVs ohne Pflichtspalten mit konkretem failureReason ab', () => {
    const res = parseAdyenPaymentsCsv('Foo,Bar,Baz\n1,2,3');
    expect(res.ok).toBe(false);
    expect(res.failureReason).toMatch(/Pflichtspalte/);
    expect(res.failureReason).toMatch(/Gefundene Spalten/);
  });

  it('lehnt leere Dateien und Header-only-Dateien ab', () => {
    expect(parseAdyenPaymentsCsv('').failureReason).toMatch(/leer/);
    expect(parseAdyenPaymentsCsv(HEADER).failureReason).toMatch(/Kopfzeile/);
  });

  it('meldet reine Fremdwährungs-Dateien verständlich', () => {
    const res = parseAdyenPaymentsCsv([HEADER, row('1', 'visa', '2026-06-01 10:00:00', 'EUR', '50.00')].join('\n'));
    expect(res.ok).toBe(false);
    expect(res.failureReason).toMatch(/Keine CHF-Zeilen/);
    expect(res.failureReason).toMatch(/EUR/);
  });

  it('unterstützt Semikolon-Delimiter und Schweizer Zahlenformat', () => {
    const csv = [
      'Payment Method;Creation Date;Currency;Amount;Type',
      "visa;01.06.2026 10:00;CHF;1'234.50;Received",
      'mc;2026-06-01 11:00:00;CHF;120,25;Received',
    ].join('\n');
    const res = parseAdyenPaymentsCsv(csv);
    expect(res.ok).toBe(true);
    expect(res.debug.delimiter).toBe(';');
    expect(res.days[0].date).toBe('2026-06-01');
    expect(res.days[0].byMethod.visa).toBeCloseTo(1234.50, 2);
    expect(res.days[0].byMethod.mastercard).toBeCloseTo(120.25, 2);
  });

  it('liest den Tag als String-Präfix (keine Zeitzonen-Verschiebung um Mitternacht)', () => {
    const csv = [
      'Payment Method,Creation Date,TimeZone,Currency,Amount,Type',
      'visa,2026-06-01 00:00:01,Europe/Zurich,CHF,10.00,Received',
      'visa,2026-06-01 23:59:59,Europe/Zurich,CHF,20.00,Received',
    ].join('\n');
    const res = parseAdyenPaymentsCsv(csv);
    expect(res.days).toHaveLength(1);
    expect(res.days[0].date).toBe('2026-06-01');
    expect(res.days[0].byMethod.visa).toBeCloseTo(30.00, 2);
  });
});
