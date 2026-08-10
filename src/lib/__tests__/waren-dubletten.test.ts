// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { findeDublettenGruppen, lieferantVerwandt } from '@/lib/waren-dubletten';
import { normRef } from '@/lib/waren-ref';
import { findSupplierInText } from '@/lib/waren-pdf-erkennung';
import { findeDublette } from '@/lib/waren-fibu-uebernahme';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { AliasGruppe } from '@/lib/waren-alias-gruppen';

let seq = 0;
function inv(p: Partial<InvoiceEntry> & { supplierName: string; amountNet: number }): InvoiceEntry {
  seq++;
  return {
    id: p.id ?? `e${seq}`,
    date: p.date ?? '2026-07-10',
    supplierName: p.supplierName,
    amountNet: p.amountNet,
    amountGross: p.amountGross ?? p.amountNet,
    account: '4000',
    createdAt: p.createdAt ?? `2026-07-10T00:00:${String(seq).padStart(2, '0')}Z`,
    ...(p.reference !== undefined ? { reference: p.reference } : {}),
    ...(p.quelle !== undefined ? { quelle: p.quelle } : {}),
    ...(p.final !== undefined ? { final: p.final } : {}),
  } as unknown as InvoiceEntry;
}

const gruppen: AliasGruppe[] = [
  { id: 'g1', name: 'Ambro Food', aliases: ['Ambro Food', 'Ambro Food SA'] },
  { id: 'g2', name: 'Terravigna', aliases: ['Terravigna', 'Terravigna AG'] },
];

describe('normRef Basis-Rechnungsnummer', () => {
  it('extrahiert bei «Beleg · Rechnungsnr» die Nummer nach dem Trennpunkt', () => {
    expect(normRef('1132 · 26214454')).toBe('26214454');
    expect(normRef('26214454')).toBe('26214454');
    expect(normRef('  ')).toBeNull();
  });
});

describe('findSupplierInText Tie-Break via Kanonisierung', () => {
  const canon = (n: string) => (n.startsWith('Terravigna') ? 'Terravigna' : n);
  it('löst Gleichstand auf, wenn alle Treffer denselben kanonischen Namen haben', () => {
    const names = ['Terravigna', 'Terravigna AG'];
    expect(findSupplierInText('Terravigna AG, Rechnung Juli', names, {})).toBeNull(); // ohne canonicalize: Tie
    // Welcher der beiden Gruppen-Namen zurückkommt, ist egal — kanonisch identisch.
    expect(canon(findSupplierInText('Terravigna AG, Rechnung Juli', names, {}, canon)!)).toBe('Terravigna');
  });
  it('bleibt null bei echtem Mehrdeutigkeits-Tie (verschiedene kanonische Namen)', () => {
    const names = ['Alpha Beta', 'Beta Alpha'];
    expect(findSupplierInText('Alpha Beta Alpha', names, {}, n => n)).toBeNull();
  });
});

describe('lieferantVerwandt', () => {
  it('erkennt Token-Enthaltensein («La Marra GmbH, 06.2026» ⊇ «La Marra»)', () => {
    expect(lieferantVerwandt('La Marra GmbH, 06.2026', 'La Marra')).toBe(true);
    expect(lieferantVerwandt('La Marra', 'Ambro Food')).toBe(false);
  });
});

describe('findeDublette (FIBU-Übernahme-Wache, quellenübergreifend)', () => {
  it('sperrt bei gleicher Basis-Referenz trotz anderem Datum/Betrag, wenn Bestand eine Übernahme ist', () => {
    const bestand = [inv({ supplierName: 'Ambro Food', amountNet: 8568.37, date: '2026-07-31', reference: '26214454', quelle: 'kreditoren_uebernahme' })];
    const hit = findeDublette({ date: '2026-07-15', supplierName: 'Ambro Food SA', betrag: 8351.26, reference: '1132 · 26214454' }, bestand);
    expect(hit).not.toBeNull();
  });
  it('sperrt NICHT bei Nummern-Wiederverwendung (Detail-Beleg, anderes Datum, anderer Betrag)', () => {
    const bestand = [inv({ supplierName: 'Transgourmet', amountNet: 500, date: '2026-07-03', reference: '58', quelle: 'monatsrechnung' })];
    expect(findeDublette({ date: '2026-07-17', supplierName: 'Transgourmet', betrag: 700, reference: '58' }, bestand)).toBeNull();
  });
  it('sperrt Detail-Beleg mit gleicher Referenz am gleichen Datum', () => {
    const bestand = [inv({ supplierName: 'Transgourmet', amountNet: 500, date: '2026-07-03', reference: '58', quelle: 'monatsrechnung' })];
    expect(findeDublette({ date: '2026-07-03', supplierName: 'Transgourmet', betrag: 700, reference: '58' }, bestand)).not.toBeNull();
  });
});

describe('findeDublettenGruppen', () => {
  it('Referenz-Duplikat: FIBU-Splits behalten, Kreditoren-Übernahme löschen', () => {
    const invs = [
      inv({ supplierName: 'Ambro Food', amountNet: 8568.37, reference: '26214454', quelle: 'kreditoren_uebernahme' }),
      inv({ supplierName: 'Ambro Food SA', amountNet: 8351.26, reference: '1132 · 26214454', quelle: 'fibu_uebernahme' }),
      inv({ supplierName: 'Ambro Food SA', amountNet: 217.13, reference: '1133 · 26214454', quelle: 'fibu_uebernahme' }),
    ];
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g).toHaveLength(1);
    expect(g[0].grund).toBe('referenz');
    expect(g[0].behalten.map(e => e.amountNet).sort()).toEqual([217.13, 8351.26]);
    expect(g[0].loeschen).toHaveLength(1);
    expect(g[0].loeschen[0].quelle).toBe('kreditoren_uebernahme');
  });

  it('Detail-Beleg schlägt beide Übernahmen', () => {
    const invs = [
      inv({ supplierName: 'Caporaso', amountNet: 1598.78, reference: '2143523', quelle: 'monatsrechnung' }),
      inv({ supplierName: 'Caporaso', amountNet: 1674.66, reference: '2143523', quelle: 'kreditoren_uebernahme' }),
    ];
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g).toHaveLength(1);
    expect(g[0].behalten[0].quelle).toBe('monatsrechnung');
    expect(g[0].loeschen[0].quelle).toBe('kreditoren_uebernahme');
  });

  it('gleiche Rechnungs-Nr. an VERSCHIEDENEN Daten (Detail) ist KEIN Duplikat', () => {
    const invs = [
      inv({ supplierName: 'Transgourmet', amountNet: 500, reference: '58', date: '2026-07-03' }),
      inv({ supplierName: 'Transgourmet', amountNet: 700, reference: '58', date: '2026-07-17' }),
    ];
    expect(findeDublettenGruppen(invs, gruppen)).toHaveLength(0);
  });

  it('final=true wird NIE gelöscht', () => {
    const invs = [
      inv({ supplierName: 'Caporaso', amountNet: 100, reference: '9', quelle: 'kreditoren_uebernahme', final: true }),
      inv({ supplierName: 'Caporaso', amountNet: 100, reference: '9', quelle: 'fibu_uebernahme' }),
    ];
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g.flatMap(x => x.loeschen).every(e => e.final !== true)).toBe(true);
  });

  it('Betrag+Datum: referenzlose Kreditoren-Übernahme gegen FIBU-Eintrag (±0.05)', () => {
    const invs = [
      inv({ supplierName: 'La Marra', amountNet: 966.23, date: '2026-07-01', quelle: 'kreditoren_uebernahme' }),
      inv({ supplierName: 'La Marra GmbH, 06.2026', amountNet: 966.25, date: '2026-07-01', reference: '1059', quelle: 'fibu_uebernahme' }),
    ];
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g).toHaveLength(1);
    expect(g[0].grund).toBe('betrag_datum');
    expect(g[0].loeschen[0].quelle).toBe('kreditoren_uebernahme');
  });

  it('Sammelrechnung: Übernahme ≈ Summe von ≥3 Einzelrechnungen wird vorgeschlagen', () => {
    const invs = [
      inv({ supplierName: 'Terravigna AG', amountNet: 7013.37, reference: '211363', quelle: 'kreditoren_uebernahme' }),
      inv({ supplierName: 'Terravigna', amountNet: 1799.30, reference: '287001', quelle: 'monatsrechnung' }),
      inv({ supplierName: 'Terravigna', amountNet: 3000.00, reference: '287002', quelle: 'monatsrechnung' }),
      inv({ supplierName: 'Terravigna', amountNet: 2200.00, reference: '287003', quelle: 'monatsrechnung' }),
    ];
    // Summe 6999.30, Diff 14.07 ≤ 0.5% (35.07) → Duplikat
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g).toHaveLength(1);
    expect(g[0].grund).toBe('sammelrechnung');
    expect(g[0].loeschen[0].reference).toBe('211363');
    expect(g[0].behalten).toHaveLength(3);
  });

  it('Sammelrechnung: finalisierte Einzelrechnungen (final=true) zählen als Gegenseite', () => {
    const invs = [
      inv({ supplierName: 'Metzgerei Spahni', amountNet: 2859.7, reference: '8648049', quelle: 'kreditoren_uebernahme' }),
      inv({ supplierName: 'Metzgerei Spahni', amountNet: 1000, reference: '5204536', quelle: 'monatsrechnung', final: true }),
      inv({ supplierName: 'Metzgerei Spahni', amountNet: 1000, reference: '5205299', quelle: 'monatsrechnung', final: true }),
      inv({ supplierName: 'Metzgerei Spahni', amountNet: 859.7, reference: '5206233', quelle: 'monatsrechnung', final: true }),
    ];
    const g = findeDublettenGruppen(invs, gruppen);
    expect(g).toHaveLength(1);
    expect(g[0].grund).toBe('sammelrechnung');
    expect(g[0].loeschen[0].reference).toBe('8648049');
  });

  it('Sammelrechnungs-Wachen: kleine Beträge, Nicht-Übernahmen und <3 Belege bleiben unangetastet', () => {
    const klein = [
      inv({ supplierName: 'Migros', amountNet: 150, quelle: 'kreditoren_uebernahme', reference: 'm1' }),
      inv({ supplierName: 'Migros', amountNet: 50, reference: 'm2' }),
      inv({ supplierName: 'Migros', amountNet: 50, reference: 'm3' }),
      inv({ supplierName: 'Migros', amountNet: 49, reference: 'm4' }),
    ];
    expect(findeDublettenGruppen(klein, gruppen)).toHaveLength(0); // < 500
    const manuell = [
      inv({ supplierName: 'Terravigna', amountNet: 6000, reference: 'x' }), // kein *_uebernahme
      inv({ supplierName: 'Terravigna', amountNet: 2000, reference: 'a' }),
      inv({ supplierName: 'Terravigna', amountNet: 2000, reference: 'b' }),
      inv({ supplierName: 'Terravigna', amountNet: 2000, reference: 'c' }),
    ];
    expect(findeDublettenGruppen(manuell, gruppen)).toHaveLength(0);
  });
});

// ── wkqFarbklasse (Cockpit-Ampel, fixe Schwellen) ────────────────────────────
import { wkqFarbklasse } from '@/lib/warenkosten-quote';
import { describe as d2, it as it2, expect as ex2 } from 'vitest';

d2('wkqFarbklasse', () => {
  it2('≤30 grün · 30–35 gelb · >35 rot (Grenzwerte inklusive)', () => {
    ex2(wkqFarbklasse(0)).toBe('green');
    ex2(wkqFarbklasse(30)).toBe('green');
    ex2(wkqFarbklasse(30.01)).toBe('yellow');
    ex2(wkqFarbklasse(35)).toBe('yellow');
    ex2(wkqFarbklasse(35.01)).toBe('red');
    ex2(wkqFarbklasse(80)).toBe('red');
  });
});
