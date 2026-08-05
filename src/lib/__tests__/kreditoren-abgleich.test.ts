// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { KreditorAnalyse, KreditorBuchung } from '@/lib/kreditoren-parser';

const invoicesByMonth: Record<string, InvoiceEntry[]> = {};

vi.mock('@/lib/waren-db', async (orig) => {
  const mod = await orig() as Record<string, unknown>;
  return {
    ...mod,
    loadMonthInvoices: vi.fn(async (_t: string, m: string) => invoicesByMonth[m] ?? []),
    loadSupplierAliases: vi.fn(async () => ({})),
    loadFibuMatchToleranz: vi.fn(async () => 10),
  };
});

import { abgleichKreditoren, supplierMatchesKreditor, buildUebernahmeEntry, zuordnungKey } from '@/lib/kreditoren-abgleich';
import { analysiereKreditor } from '@/lib/kreditoren-parser';

const inv = (p: Partial<InvoiceEntry>): InvoiceEntry => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  date: p.date!, supplierName: p.supplierName!, amountGross: p.amountGross!,
  amountNet: p.amountNet ?? p.amountGross! / 1.026, vatIncluded: true, vatRate: 2.6,
  createdAt: 'x', updatedAt: 'x', ...p,
});

const buchung = (datum: string, betrag: number, gKonto = '4060'): KreditorBuchung =>
  ({ datum, text: 'Lieferant', gKonto, typ: 'haben', betrag });

function analyse(name: string, buchungen: KreditorBuchung[]): KreditorAnalyse {
  return analysiereKreditor({ nr: '1', name, fullName: name, buchungen });
}

beforeEach(() => { for (const k of Object.keys(invoicesByMonth)) delete invoicesByMonth[k]; });

describe('supplierMatchesKreditor', () => {
  it('normalisiert Rechtsform und matcht über signifikantes Wort', () => {
    expect(supplierMatchesKreditor('Metzgerei Spahni', 'Metzgerei Spahni AG', {})).toBe(true);
    expect(supplierMatchesKreditor('Spahni', 'Metzgerei Spahni AG', {})).toBe(true);
    expect(supplierMatchesKreditor('Transgourmet/Prodega', 'Transgourmet Schweiz AG', {})).toBe(true);
    expect(supplierMatchesKreditor('Blaser Café', 'Metzgerei Spahni AG', {})).toBe(false);
  });
  it('nutzt Aliases', () => {
    expect(supplierMatchesKreditor('TG', 'Transgourmet Schweiz AG', { TG: 'Transgourmet' })).toBe(true);
  });
});

describe('abgleichKreditoren', () => {
  it('Einzelrechnungen: Betrag+Datum-Toleranz → erfasst, sonst fehlt; Ampel', async () => {
    invoicesByMonth['2026-02'] = [inv({ supplierName: 'Blaser Café', date: '2026-02-05', amountGross: 595.9 })];
    const a = analyse('Blaser Café AG', [buchung('2026-02-04', 595.9, '4070'), buchung('2026-02-27', 536.6, '4070')]);
    const zu = { [zuordnungKey('Blaser Café AG')]: { waren: true, konto: '4070', modell: 'einzelrechnungen' as const, bestaetigt: 'x' } };
    const erg = await abgleichKreditoren('oliv', [a], zu, '2026-02-01', '2026-02-28');
    expect(erg.zeilen).toHaveLength(1);
    const z = erg.zeilen[0];
    expect(z.anzahlErfasst).toBe(1);
    expect(z.anzahlFehlt).toBe(1);
    expect(z.ampel).toBe('gelb');
    expect(z.differenz).toBeCloseTo(536.6, 2);
  });

  it('nicht getaggte / «kein Waren»-Kreditoren erscheinen nicht', async () => {
    const a = analyse('GastroSocial', [buchung('2026-02-04', 1000, '4060')]);
    const erg = await abgleichKreditoren('beaulieu', [a],
      { [zuordnungKey('GastroSocial')]: { waren: false, bestaetigt: 'x' } }, '2026-02-01', '2026-02-28');
    expect(erg.zeilen).toHaveLength(0);
    const erg2 = await abgleichKreditoren('beaulieu', [a], {}, '2026-02-01', '2026-02-28');
    expect(erg2.zeilen).toHaveLength(0);
  });

  it('Dual: matcht nur finale Monatsrechnung; nur Lieferscheine → provisorisch (kein Vorschlag)', async () => {
    invoicesByMonth['2026-03'] = [
      inv({ supplierName: 'Metzgerei Spahni', date: '2026-03-10', amountGross: 2972.6 }), // Lieferschein (provisorisch)
      inv({ supplierName: 'Metzgerei Spahni', date: '2026-03-31', amountGross: 4843.55, final: true, quelle: 'monatsrechnung' }),
    ];
    const a = analyse('Metzgerei Spahni AG', [
      buchung('2026-03-15', 4843.55), // matcht finale Monatsrechnung
      buchung('2026-03-31', 2972.6),  // nur Lieferschein vorhanden → provisorisch
    ]);
    const zu = { [zuordnungKey('Metzgerei Spahni AG')]: { waren: true, konto: '4060', modell: 'halbmonatlich' as const, bestaetigt: 'x' } };
    const erg = await abgleichKreditoren('beaulieu', [a], zu, '2026-03-01', '2026-03-31');
    const z = erg.zeilen[0];
    expect(z.anzahlErfasst).toBe(1);
    expect(z.anzahlProvisorisch).toBe(1);
    expect(z.anzahlFehlt).toBe(0);
  });

  it('Dublettenwache: gleicher Betrag+Datum bereits erfasst → gesperrt, nie doppelt vorschlagen', async () => {
    // Zwei identische Buchungen, nur EINE Rechnung erfasst → 1 erfasst + 1 gesperrt (nicht «fehlt»)
    invoicesByMonth['2026-04'] = [inv({ supplierName: 'Hiestand', date: '2026-04-10', amountGross: 500 })];
    const a = analyse('Hiestand AG', [buchung('2026-04-10', 500), buchung('2026-04-11', 500)]);
    const zu = { [zuordnungKey('Hiestand AG')]: { waren: true, konto: '4060', modell: 'einzelrechnungen' as const, bestaetigt: 'x' } };
    const erg = await abgleichKreditoren('oliv', [a], zu, '2026-04-01', '2026-04-30');
    const z = erg.zeilen[0];
    expect(z.anzahlErfasst).toBe(1);
    expect(z.anzahlFehlt).toBe(0);
    expect(z.matches.filter(m => m.status === 'gesperrt_dublette')).toHaveLength(1);
  });
});

describe('buildUebernahmeEntry', () => {
  it('provisorisch, brutto unverändert, Netto aus MwSt', () => {
    const e = buildUebernahmeEntry({
      kreditorName: 'Terravigna', buchung: { ...buchung('2026-05-31', 1081, '4020'), referenz: '12345' }, konto: '4020', vatRate: 8.1,
    }, '2026-08-05T00:00:00Z');
    expect(e.amountGross).toBe(1081);
    expect(e.amountNet).toBe(1000);
    expect(e.quelle).toBe('kreditoren_uebernahme');
    expect(e.final).toBe(false);
    expect(e.warenkonto).toBe('4020');
    expect(e.reference).toBe('12345');
  });
});
