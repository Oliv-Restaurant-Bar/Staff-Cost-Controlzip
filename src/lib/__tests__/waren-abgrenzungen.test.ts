// @vitest-environment node
/**
 * Tests waren-abgrenzungen: TP/RB-Abgrenzungen → Vorschlag + Umdatieren auf
 * den Leistungsmonat. Kernszenario = Schenk/Caratello (RB im Juli → Juni).
 */
import { describe, it, expect } from 'vitest';
import {
  istRueckbuchung, vormonat, abgrenzungZielMonat, verschiebeDatumInMonat,
  findeAbgrenzungLieferant, baueAbgrenzungVorschlaege,
} from '../waren-abgrenzungen';
import type { InvoiceEntry } from '../waren-db';
import type { SageJournalEntry } from '@/types/reporting';

function buchung(p: Partial<SageJournalEntry>): SageJournalEntry {
  return { date: '31.07.2026', accountNumber: '4020', ...p } as SageJournalEntry;
}
let seq = 0;
function inv(p: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    id: p.id ?? `e${++seq}`, date: '2026-07-03', supplierName: 'Schenk Suisse SA',
    amountNet: 1344.55, amountGross: 1453.46, vatIncluded: false, vatRate: 8.1,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    ...p,
  } as InvoiceEntry;
}
const ident = (n: string) => n;

describe('Zielmonat & Datum', () => {
  it('RB im Juli → Juni; TP im Juli → Juli; Jahreswechsel korrekt', () => {
    expect(istRueckbuchung('RB TP RE Schenk Suisse')).toBe(true);
    expect(istRueckbuchung('TP RE Schenk Suisse')).toBe(false);
    expect(vormonat('2026-01')).toBe('2025-12');
    expect(abgrenzungZielMonat(buchung({ text: 'RB TP RE Schenk Suisse' }), '2026-07')).toBe('2026-06');
    expect(abgrenzungZielMonat(buchung({ text: 'TP RE Schenk Suisse' }), '2026-07')).toBe('2026-07');
  });
  it('verschiebeDatumInMonat: Tag bleibt, wird geklemmt', () => {
    expect(verschiebeDatumInMonat('2026-07-03', '2026-06')).toBe('2026-06-03');
    expect(verschiebeDatumInMonat('2026-07-31', '2026-06')).toBe('2026-06-30');
    expect(verschiebeDatumInMonat('2026-03-30', '2026-02')).toBe('2026-02-28');
  });
});

describe('findeAbgrenzungLieferant', () => {
  it('längster Namens-Treffer im Text; kein Treffer → null (nie raten)', () => {
    const namen = ['Schenk Suisse SA', 'Caratello Weine', 'Schenk'];
    expect(findeAbgrenzungLieferant('RB TP RE Schenk Suisse', namen)).toBe('Schenk');
    expect(findeAbgrenzungLieferant('RB TP RE Caratello Weine AG', namen)).toBe('Caratello Weine');
    expect(findeAbgrenzungLieferant('RB TP RE Unbekannt GmbH', namen)).toBeNull();
    expect(findeAbgrenzungLieferant('', namen)).toBeNull();
  });
});

describe('baueAbgrenzungVorschlaege (Schenk/Caratello-Szenario)', () => {
  const invoices = [
    inv({ id: 'schenk', supplierName: 'Schenk Suisse', amountNet: 1344.55 }),
    inv({ id: 'caratello', supplierName: 'Caratello Weine', amountNet: 1115.59, date: '2026-07-05' }),
    inv({ id: 'anders', supplierName: 'Schenk Suisse', amountNet: 999 }),
  ];
  const offen = [
    buchung({ text: 'RB TP RE Schenk Suisse', haben: 1344.55 }),   // Soll−Haben = −1344.55
    buchung({ text: 'RB TP RE Caratello Weine', haben: 1115.59 }),
    buchung({ text: 'RB TP RE Nur In Fibu AG', haben: 500 }),
  ];

  it('ordnet je Abgrenzung die passende Rechnung zu; ohne Treffer leer', () => {
    const v = baueAbgrenzungVorschlaege({ offen, journalMonat: '2026-07', invoices, resolve: ident });
    expect(v[0].lieferant).toBe('Schenk Suisse');
    expect(v[0].zielMonat).toBe('2026-06');
    expect(v[0].betragAbs).toBe(1344.55);
    expect(v[0].kandidaten.map(e => e.id)).toEqual(['schenk']); // Betrag exakt, 999 nicht
    expect(v[1].kandidaten.map(e => e.id)).toEqual(['caratello']);
    expect(v[2].lieferant).toBeNull();          // «keine App-Rechnung gefunden»
    expect(v[2].kandidaten).toEqual([]);
  });

  it('Rechnungen, die bereits im Zielmonat liegen, sind keine Kandidaten', () => {
    const schon = [inv({ id: 'juni', supplierName: 'Schenk Suisse', date: '2026-06-03' })];
    const v = baueAbgrenzungVorschlaege({
      offen: [offen[0]], journalMonat: '2026-07', invoices: schon, resolve: ident,
    });
    expect(v[0].kandidaten).toEqual([]);
  });
});
