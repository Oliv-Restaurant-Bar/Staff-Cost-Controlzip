// @vitest-environment node
/**
 * waren-klassen — Kontoklassen (Warenkosten 4000–Grenze / Betriebskosten darüber),
 * Mehr-Konten-Split-Anteile, Lieferanten-Gesamt-Auswertung, nurWarenAnteil-Filter.
 */
import { describe, it, expect } from 'vitest';
import {
  kontoKlasse, klassenAnteile, sumWarenNet, sumBetriebNet,
  aggregateBySupplierKlassen, nurWarenAnteil, DEFAULT_WARENKOSTEN_GRENZE,
} from '../waren-klassen';
import type { InvoiceEntry } from '../waren-db';

function inv(p: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    id: p.id ?? 'x', date: p.date ?? '2026-07-01', supplierName: p.supplierName ?? 'Lieferant A',
    amountGross: p.amountGross ?? 108.1, amountNet: p.amountNet ?? 100,
    vatIncluded: true, vatRate: 8.1, createdAt: '', updatedAt: '',
    ...p,
  };
}

describe('kontoKlasse', () => {
  it('4000–4090 = warenkosten, 4091+ (47xx/48xx) und <4000 = betriebskosten (Standardgrenze)', () => {
    expect(kontoKlasse('4000')).toBe('warenkosten');
    expect(kontoKlasse('4070')).toBe('warenkosten'); // Kaffee/Tee Warenaufwand
    expect(kontoKlasse('4090')).toBe('warenkosten'); // Übriger Handelswaren Aufwand
    expect(kontoKlasse('4091')).toBe('betriebskosten');
    expect(kontoKlasse('4701')).toBe('betriebskosten'); // Betriebsmaterial
    expect(kontoKlasse('4800')).toBe('neutral'); // Pfand/Depot/Gebinde — NIE Waren- oder Betriebskosten
    expect(kontoKlasse('6040')).toBe('betriebskosten');
    expect(kontoKlasse('3000')).toBe('betriebskosten');
  });
  it('Grenze konfigurierbar', () => {
    expect(kontoKlasse('4080', 4085)).toBe('warenkosten');
    expect(kontoKlasse('4071', 4075)).toBe('warenkosten');
    expect(kontoKlasse('4076', 4075)).toBe('betriebskosten');
  });
  it('ohne/nicht-numerisches Konto → warenkosten (Legacy: Altbestand bleibt in WKQ)', () => {
    expect(kontoKlasse(undefined)).toBe('warenkosten');
    expect(kontoKlasse('abc')).toBe('warenkosten');
  });
});

describe('Pseudo-Konten (CSV-Positionsimport)', () => {
  it('«Depot» (Pfand) ist neutral, «offen» zählt bewusst als Warenkosten', () => {
    expect(kontoKlasse('Depot')).toBe('neutral');
    expect(kontoKlasse('48001')).toBe('neutral'); // 5-stellig normalisiert → 4800
    expect(kontoKlasse('offen')).toBe('warenkosten');
    const e = inv({
      amountNet: 100,
      kontoSplits: [
        { warenkonto: '4060', amountNet: 90, amountGross: 97.3 },
        { warenkonto: 'Depot', amountNet: 6.4, amountGross: 6.4 },
        { warenkonto: 'offen', amountNet: 3.6, amountGross: 3.9 },
      ],
    });
    expect(klassenAnteile(e)).toEqual({ warenNet: 93.6, betriebNet: 0 }); // Depot fehlt bewusst
  });
});

describe('klassenAnteile / Summen', () => {
  it('Einzelkonto: ganzer Betrag in der Klasse des Kontos', () => {
    expect(klassenAnteile(inv({ warenkonto: '4000' }))).toEqual({ warenNet: 100, betriebNet: 0 });
    expect(klassenAnteile(inv({ warenkonto: '4701' }))).toEqual({ warenNet: 0, betriebNet: 100 });
  });
  it('Split: je Zeile klassiert, Summe = Rechnungsnetto (keine Doppelzählung)', () => {
    const e = inv({
      amountNet: 100,
      kontoSplits: [
        { warenkonto: '4000', amountNet: 60, amountGross: 64.86 },
        { warenkonto: '4701', amountNet: 30, amountGross: 32.43 },
        { warenkonto: '6040', amountNet: 10, amountGross: 10.81 },
      ],
    });
    const a = klassenAnteile(e);
    expect(a.warenNet).toBe(60);
    expect(a.betriebNet).toBe(40);
    expect(a.warenNet + a.betriebNet).toBe(e.amountNet);
  });
  it('sumWarenNet/sumBetriebNet über Listen', () => {
    const list = [inv({ warenkonto: '4000', amountNet: 50 }), inv({ warenkonto: '4701', amountNet: 20 })];
    expect(sumWarenNet(list)).toBe(50);
    expect(sumBetriebNet(list)).toBe(20);
  });
});

describe('aggregateBySupplierKlassen', () => {
  it('Gesamt-Total über alle Konten + Aufschlüsselung, sortiert nach Gesamt', () => {
    const rows = aggregateBySupplierKlassen([
      inv({ supplierName: 'A', warenkonto: '4000', amountNet: 100 }),
      inv({ supplierName: 'A', warenkonto: '4701', amountNet: 50 }),
      inv({ supplierName: 'B', warenkonto: '4020', amountNet: 120 }),
    ]);
    expect(rows[0]).toMatchObject({ supplierName: 'A', totalNet: 150, warenNet: 100, betriebNet: 50, count: 2 });
    expect(rows[1]).toMatchObject({ supplierName: 'B', totalNet: 120, warenNet: 120, betriebNet: 0, count: 1 });
  });
});

describe('nurWarenAnteil', () => {
  it('reine Betriebskosten-Rechnung fällt weg; gemischter Split wird anteilig reduziert', () => {
    const list = [
      inv({ id: 'a', warenkonto: '6040', amountNet: 40 }),
      inv({
        id: 'b', amountNet: 100, amountGross: 108.1,
        kontoSplits: [
          { warenkonto: '4000', amountNet: 70, amountGross: 75.67 },
          { warenkonto: '4701', amountNet: 30, amountGross: 32.43 },
        ],
      }),
      inv({ id: 'c', warenkonto: '4020', amountNet: 55 }),
    ];
    const out = nurWarenAnteil(list, DEFAULT_WARENKOSTEN_GRENZE);
    expect(out.map(e => e.id)).toEqual(['b', 'c']);
    const b = out[0];
    expect(b.amountNet).toBe(70);
    expect(b.kontoSplits).toHaveLength(1);
    expect(b.kontoSplits![0].warenkonto).toBe('4000');
    // Original bleibt unangetastet (kein Mutieren der Eingabe).
    expect(list[1].amountNet).toBe(100);
    expect(list[1].kontoSplits).toHaveLength(2);
  });
  it('Rechnung ohne Konto bleibt drin (Legacy-Regel)', () => {
    expect(nurWarenAnteil([inv({ warenkonto: undefined })])).toHaveLength(1);
  });
});
