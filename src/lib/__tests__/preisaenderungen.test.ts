// @vitest-environment node
/**
 * Preisänderungs-Ansicht (persistente Preishistorie): Zeilen-Anreicherung,
 * Mengen-/Mehraufwand-Berechnung, Filter + Sortierung.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('../supabase-kv', () => ({
  kvGet: vi.fn(async (k: string) => kv.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
  kvGetStrict: vi.fn(async (k: string) => kv.get(k) ?? null),
  kvSetStrict: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
}));

import { ladePreisAenderungen, filtereUndSortiere, lieferantAusKey } from '../preisaenderungen';
import type { PreisAenderung } from '../waren-positionen';

const OLIV = 'oliv' as never;

const aenderung = (o: Partial<PreisAenderung> = {}): PreisAenderung => ({
  key: 'transgourmet|nr:100', artikel: 'Coppenrath Torte', artNr: '100',
  alt: 10, neu: 13.26, diffAbs: 3.26, diffPct: 32.6, stark: true, erhoehung: true,
  seit: '2026-07-02', ...o,
});

beforeEach(() => { kv.clear(); });

function seedMonat(monat: string, opts: {
  hinweise?: Record<string, PreisAenderung[]>;
  invoices?: Array<{ id: string; date: string; supplierName: string }>;
  positionen?: Record<string, Array<Partial<{ artNr: string; bezeichnung: string; warengruppe: string; menge: number; preis: number; positionspreis: number; konto: string | null; status: string; einheit: string; mwstBetrag: number; mwstCode: number }>>>;
}) {
  kv.set(`waren_preishinweise_${monat}_v1`, opts.hinweise ?? {});
  kv.set(`supplier_invoices_${monat}`, (opts.invoices ?? []).map(i => ({
    ...i, amountGross: 100, amountNet: 92.5, vatIncluded: true, vatRate: 8.1,
  })));
  const pos: Record<string, unknown[]> = {};
  for (const [id, liste] of Object.entries(opts.positionen ?? {})) {
    pos[id] = liste.map(p => ({
      artNr: '', bezeichnung: 'X', warengruppe: '', menge: 1, einheit: 'ST',
      preis: 1, positionspreis: 1, mwstBetrag: 0, mwstCode: 1, konto: '4020', status: 'auto', ...p,
    }));
  }
  kv.set(`waren_positionen_${monat}_v1`, pos);
}

describe('ladePreisAenderungen', () => {
  it('reichert Hinweise mit Datum, Lieferant, Konto/Warengruppe und Mehraufwand an', async () => {
    seedMonat('2026-08', {
      hinweise: { inv1: [aenderung()] },
      invoices: [
        { id: 'inv1', date: '2026-08-05', supplierName: 'Transgourmet' },
        { id: 'inv2', date: '2026-08-12', supplierName: 'Transgourmet' },
      ],
      positionen: {
        inv1: [{ artNr: '100', bezeichnung: 'Coppenrath Torte', warengruppe: 'Tiefkühl', menge: 4, konto: '4030' }],
        inv2: [{ artNr: '100', bezeichnung: 'Coppenrath Torte', warengruppe: 'Tiefkühl', menge: 6, konto: '4030' }],
      },
    });
    const rows = await ladePreisAenderungen(OLIV, ['2026-08']);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.datum).toBe('2026-08-05');
    expect(r.lieferant).toBe('Transgourmet');
    expect(r.konto).toBe('4030');
    expect(r.warengruppe).toBe('Tiefkühl');
    // Menge seit Änderung: 4 (Änderungs-Rechnung) + 6 (spätere) = 10
    expect(r.mengeSeit).toBe(10);
    expect(r.mehraufwand).toBeCloseTo(32.6, 2);
  });

  it('leer statt 0: ohne Positionsdaten bleiben Menge/Mehraufwand null', async () => {
    seedMonat('2026-08', {
      hinweise: { inv1: [aenderung()] },
      invoices: [{ id: 'inv1', date: '2026-08-05', supplierName: 'Transgourmet' }],
    });
    const rows = await ladePreisAenderungen(OLIV, ['2026-08']);
    expect(rows[0].mengeSeit).toBeNull();
    expect(rows[0].mehraufwand).toBeNull();
  });

  it('Bezüge VOR der Änderung zählen nicht zum Mehraufwand', async () => {
    seedMonat('2026-08', {
      hinweise: { inv2: [aenderung()] },
      invoices: [
        { id: 'inv1', date: '2026-08-01', supplierName: 'Transgourmet' },
        { id: 'inv2', date: '2026-08-15', supplierName: 'Transgourmet' },
      ],
      positionen: {
        inv1: [{ artNr: '100', menge: 99 }],
        inv2: [{ artNr: '100', menge: 3 }],
      },
    });
    const rows = await ladePreisAenderungen(OLIV, ['2026-08']);
    expect(rows[0].mengeSeit).toBe(3);
    expect(rows[0].mehraufwand).toBeCloseTo(9.78, 2);
  });

  it('fehlende Rechnung: Lieferant aus dem artikelKey, Monat als Zeitanker', async () => {
    seedMonat('2026-08', { hinweise: { weg: [aenderung()] } });
    const rows = await ladePreisAenderungen(OLIV, ['2026-08']);
    expect(rows[0].datum).toBe('');
    expect(rows[0].monat).toBe('2026-08');
    expect(rows[0].lieferant).toBe('transgourmet');
  });

  it('mandantengetrennt: Beaulieu liest beaulieu:-Keys', async () => {
    kv.set('beaulieu:waren_preishinweise_2026-08_v1', { i1: [aenderung()] });
    kv.set('beaulieu:supplier_invoices_2026-08', [{ id: 'i1', date: '2026-08-03', supplierName: 'Casualfood', amountGross: 1, amountNet: 1, vatIncluded: true, vatRate: 8.1 }]);
    const rows = await ladePreisAenderungen('beaulieu' as never, ['2026-08']);
    expect(rows).toHaveLength(1);
    expect(rows[0].lieferant).toBe('Casualfood');
    // Oliv sieht davon nichts
    expect(await ladePreisAenderungen(OLIV, ['2026-08'])).toHaveLength(0);
  });

  it('Woche über Monatsgrenze: Mengen-Basis strikt auf von/bis begrenzt', async () => {
    // Woche 27.07.–02.08.2026; Änderung am 29.07. Bezüge davor, in der Woche
    // und weit im August — nur die Wochen-Bezüge ab Änderung zählen.
    seedMonat('2026-07', {
      hinweise: { c2: [aenderung()] },
      invoices: [
        { id: 'c1', date: '2026-07-20', supplierName: 'Transgourmet' },
        { id: 'c2', date: '2026-07-29', supplierName: 'Transgourmet' },
      ],
      positionen: { c1: [{ artNr: '100', menge: 50 }], c2: [{ artNr: '100', menge: 2 }] },
    });
    seedMonat('2026-08', {
      invoices: [
        { id: 'c3', date: '2026-08-01', supplierName: 'Transgourmet' },
        { id: 'c4', date: '2026-08-15', supplierName: 'Transgourmet' },
      ],
      positionen: { c3: [{ artNr: '100', menge: 3 }], c4: [{ artNr: '100', menge: 40 }] },
    });
    const rows = await ladePreisAenderungen(OLIV, ['2026-07', '2026-08'],
      { von: '2026-07-27', bis: '2026-08-02' });
    expect(rows[0].mengeSeit).toBe(5); // 2 (29.07.) + 3 (01.08.)
    expect(rows[0].mehraufwand).toBeCloseTo(16.3, 2);
  });

  it('mehrere Monate: Mengen-Basis wirkt monatsübergreifend', async () => {
    seedMonat('2026-07', {
      hinweise: { a1: [aenderung()] },
      invoices: [{ id: 'a1', date: '2026-07-20', supplierName: 'Transgourmet' }],
      positionen: { a1: [{ artNr: '100', menge: 2 }] },
    });
    seedMonat('2026-08', {
      invoices: [{ id: 'b1', date: '2026-08-04', supplierName: 'Transgourmet' }],
      positionen: { b1: [{ artNr: '100', menge: 5 }] },
    });
    const rows = await ladePreisAenderungen(OLIV, ['2026-07', '2026-08']);
    expect(rows).toHaveLength(1);
    expect(rows[0].mengeSeit).toBe(7);
  });
});

describe('filtereUndSortiere', () => {
  const basis = async () => {
    seedMonat('2026-08', {
      hinweise: {
        i1: [
          aenderung(),
          aenderung({ key: 'transgourmet|nr:200', artikel: 'Zwiebeln rot', artNr: '200', alt: 2, neu: 2.58, diffAbs: 0.58, diffPct: 29.1 }),
          aenderung({ key: 'transgourmet|nr:300', artikel: 'Rahm', artNr: '300', alt: 5, neu: 4.6, diffAbs: -0.4, diffPct: -8.0, stark: false, erhoehung: false }),
          aenderung({ key: 'transgourmet|nr:400', artikel: 'Öl', artNr: '400', alt: 8, neu: 8.4, diffAbs: 0.4, diffPct: 5.0, stark: false }),
        ],
        i2: [aenderung({ key: 'egli ag|nr:9', artikel: 'Egli', artNr: '9', alt: 30, neu: 34.83, diffAbs: 4.83, diffPct: 16.1 })],
      },
      invoices: [
        { id: 'i1', date: '2026-08-05', supplierName: 'Transgourmet' },
        { id: 'i2', date: '2026-08-20', supplierName: 'Egli AG' },
      ],
      positionen: {
        i1: [{ artNr: '200', warengruppe: 'Gemüse', menge: 1 }],
      },
    });
    return ladePreisAenderungen(OLIV, ['2026-08']);
  };
  const f = { von: '2026-08-01', bis: '2026-08-31', lieferant: '', warengruppe: '', nurStark: false, richtung: 'alle' as const };

  it('Standard-Sortierung: grösste Erhöhung (Δ%) zuerst, Senkungen zuletzt', async () => {
    const out = filtereUndSortiere(await basis(), f);
    expect(out.map(r => r.artikel)).toEqual(['Coppenrath Torte', 'Zwiebeln rot', 'Egli', 'Öl', 'Rahm']);
  });

  it('Filter Richtung/Schwelle/Lieferant/Warengruppe/Zeitraum', async () => {
    const rows = await basis();
    expect(filtereUndSortiere(rows, { ...f, richtung: 'senkung' }).map(r => r.artikel)).toEqual(['Rahm']);
    expect(filtereUndSortiere(rows, { ...f, nurStark: true })).toHaveLength(3);
    expect(filtereUndSortiere(rows, { ...f, lieferant: 'Egli AG' }).map(r => r.artikel)).toEqual(['Egli']);
    expect(filtereUndSortiere(rows, { ...f, warengruppe: 'Gemüse' }).map(r => r.artikel)).toEqual(['Zwiebeln rot']);
    expect(filtereUndSortiere(rows, { ...f, von: '2026-08-10', bis: '2026-08-31' }).map(r => r.artikel)).toEqual(['Egli']);
  });
});

it('lieferantAusKey', () => {
  expect(lieferantAusKey('transgourmet|nr:100')).toBe('transgourmet');
  expect(lieferantAusKey('ohnepipe')).toBe('ohnepipe');
});
