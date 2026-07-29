// @vitest-environment node
/**
 * Tests der Cockpit-Kennzahl «Gäste Take Away» (Produktanalyse).
 * ==============================================================
 * Deckt ab:
 *   - TA-Erkennung: case-SENSITIVE Token «TA» mit Wortgrenzen; 17 echte
 *     TA-Produktnamen als Treffer, Negativliste (Pasta, Tatar, Burrata,
 *     Bruschetta, Torte, Ratatouille, klein «ta») als Nicht-Treffer.
 *   - Tagessumme 28.07. = 101 (Σ Stückzahlen aller TA-Produkte des Tages).
 *   - Wochen-/Monatsaggregation.
 *   - Tag-Merge: erneuter Import ersetzt NUR die enthaltenen Tage.
 *
 * Reine Logik, ohne DB. node-Env (kein jsdom → kein canvas/libuuid-Crash); der
 * Supabase-Client wird gemockt, da das getestete Modul ihn beim Import zieht.
 * Da im echten März-Beispiel keine TA-Produkte vorkommen, werden die
 * TA-Fixtures gemäss Spec synthetisch aufgebaut (17 TA-Namen + Negativliste,
 * Tagessumme 28.07. = 101).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Query-aufzeichnender Supabase-Stub: jede Builder-Methode gibt den Builder
// zurück und protokolliert ihre Argumente, damit wir prüfen können, dass
// loadTakeAwayGuests nach restaurant_id filtert. `select` liefert am Ende die
// gemockten Zeilen (via __setRows) bzw. einen Fehler (via __setError).
const eqCalls: Array<[string, unknown]> = [];
let mockRows: any[] = [];
let mockError: unknown = null;

function makeBuilder() {
  const builder: any = {};
  const chain = (name: string) => (...args: any[]) => {
    if (name === 'eq') eqCalls.push([args[0], args[1]]);
    return builder;
  };
  builder.select = chain('select');
  builder.eq = chain('eq');
  builder.not = chain('not');
  builder.gte = chain('gte');
  builder.lte = chain('lte');
  // .range(...) beendet die Kette und liefert das Ergebnis.
  builder.range = (..._args: any[]) => Promise.resolve({ data: mockError ? null : mockRows, error: mockError });
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => makeBuilder() },
}));

import {
  isTakeAwayProduct, aggregateTakeAwayGuests, mergeTakeAwayDays,
  loadTakeAwayGuests,
  type TakeAwaySalesRow,
} from '@/lib/takeaway-cockpit-metrics';

beforeEach(() => {
  eqCalls.length = 0;
  mockRows = [];
  mockError = null;
});

// 17 echte TA-Produktnamen (Kontroll-Referenz «exakt 17 TA-Produkte»).
const TA_NAMES = [
  'Pizza Prosciutto TA',
  'Pizza Margherita TA',
  'Pizza Quattro Formaggi TA',
  'Pasta Pollo TA',
  'Pasta Bolognese TA',
  'Pasta Carbonara TA',
  'Insalata Mista TA',
  'Risotto Funghi TA',
  'Lasagne TA',
  'Tiramisu TA',
  'Panna Cotta TA',
  'Caprese TA',
  'Gnocchi Gorgonzola TA',
  'Saltimbocca TA',
  'Ossobuco TA',
  'Vitello Tonnato TA',
  'Focaccia TA',
];

// Negativliste — dürfen NICHT als TA zählen (Teilstrings / klein «ta»).
const NON_TA_NAMES = [
  'Pasta Pollo',
  'Tatar vom Rind',
  'Burrata mit Tomaten',
  'Bruschetta Classica',
  'Schokoladen-Torte',
  'Ratatouille',
  'Pizza margherita ta',   // kleingeschrieben
  'Antipasti',
  'Spaghetti Aglio',
];

describe('TA-Erkennung (case-sensitive, Wortgrenzen)', () => {
  it('erkennt alle 17 TA-Produkte als Take-Away', () => {
    expect(TA_NAMES.length).toBe(17);
    for (const name of TA_NAMES) {
      expect(isTakeAwayProduct(name)).toBe(true);
    }
    expect(TA_NAMES.filter(isTakeAwayProduct).length).toBe(17);
  });

  it('erkennt keinen der Negativfälle als Take-Away', () => {
    for (const name of NON_TA_NAMES) {
      expect(isTakeAwayProduct(name)).toBe(false);
    }
    expect(NON_TA_NAMES.filter(isTakeAwayProduct).length).toBe(0);
  });

  it('spezifische Negativkontrollen: Pasta, Tatar, Burrata, klein «ta»', () => {
    expect(isTakeAwayProduct('Pasta')).toBe(false);
    expect(isTakeAwayProduct('Tatar')).toBe(false);
    expect(isTakeAwayProduct('Burrata')).toBe(false);
    expect(isTakeAwayProduct('Bruschetta')).toBe(false);
    expect(isTakeAwayProduct('Torte')).toBe(false);
    expect(isTakeAwayProduct('Ratatouille')).toBe(false);
    expect(isTakeAwayProduct('pasta pollo ta')).toBe(false); // klein
  });

  it('TA am Anfang und in der Mitte (Wortgrenzen) zählt', () => {
    expect(isTakeAwayProduct('TA Pizza')).toBe(true);
    expect(isTakeAwayProduct('Pizza TA Prosciutto')).toBe(true);
  });

  it('leere / null-Namen sind nie TA', () => {
    expect(isTakeAwayProduct('')).toBe(false);
    expect(isTakeAwayProduct(null)).toBe(false);
    expect(isTakeAwayProduct(undefined)).toBe(false);
  });
});

/**
 * Baut synthetische Tageszeilen für den 28.07. mit Σ TA-Stückzahlen = 101.
 * 17 TA-Produkte, deren Mengen zusammen 101 ergeben, plus Nicht-TA-Rauschen.
 */
function buildDay(date: string): TakeAwaySalesRow[] {
  // 16×6 = 96, +5 beim letzten → Σ = 101 über die 17 TA-Produkte.
  const taQty = TA_NAMES.map((_, i) => (i === TA_NAMES.length - 1 ? 5 : 6));
  const taRows: TakeAwaySalesRow[] = TA_NAMES.map((name, i) => ({
    product_name: name, quantity: taQty[i], sale_date: date,
  }));
  const noise: TakeAwaySalesRow[] = NON_TA_NAMES.map(name => ({
    product_name: name, quantity: 50, sale_date: date,
  }));
  return [...taRows, ...noise];
}

describe('Tagessumme «Gäste Take Away»', () => {
  it('28.07. = 101 (Σ Stückzahlen aller TA-Produkte, Nicht-TA ignoriert)', () => {
    const rows = buildDay('2026-07-28');
    expect(aggregateTakeAwayGuests(rows, true)).toBe(101);
  });

  it('negative / ungültige Mengen zählen als 0', () => {
    const rows: TakeAwaySalesRow[] = [
      { product_name: 'Pizza TA', quantity: 10 },
      { product_name: 'Pasta TA', quantity: -3 },
      { product_name: 'Salat TA', quantity: null },
      { product_name: 'Focaccia TA', quantity: NaN },
    ];
    expect(aggregateTakeAwayGuests(rows, true)).toBe(10);
  });

  it('hasData=false → null («—», nie still 0)', () => {
    expect(aggregateTakeAwayGuests([], false)).toBeNull();
    expect(aggregateTakeAwayGuests(buildDay('2026-07-28'), false)).toBeNull();
  });

  it('leere Datenbasis (keine Zeilen, hasData=false) → null', () => {
    expect(aggregateTakeAwayGuests([], false)).toBeNull();
  });
});

describe('Wochen-/Monatsaggregation', () => {
  it('Woche = Σ über die enthaltenen Tage', () => {
    const week = [
      ...buildDay('2026-07-27'), // 101
      ...buildDay('2026-07-28'), // 101
      ...buildDay('2026-07-29'), // 101
    ];
    expect(aggregateTakeAwayGuests(week, true)).toBe(303);
  });

  it('Monat = Σ über alle importierten Tage des Monats', () => {
    const days = ['2026-07-01', '2026-07-15', '2026-07-28', '2026-07-31'];
    const month = days.flatMap(buildDay);
    expect(aggregateTakeAwayGuests(month, true)).toBe(101 * days.length);
  });
});

describe('Tag-Merge: erneuter Import ersetzt NUR enthaltene Tage', () => {
  it('ersetzt den re-importierten Tag, lässt andere Tage unberührt', () => {
    const existing: TakeAwaySalesRow[] = [
      { product_name: 'Pizza TA', quantity: 6, sale_date: '2026-07-27' },
      { product_name: 'Pizza TA', quantity: 6, sale_date: '2026-07-28' }, // wird ersetzt
      { product_name: 'Pizza TA', quantity: 6, sale_date: '2026-07-29' },
    ];
    // Re-Import nur für 28.07. mit anderem Wert.
    const incoming: TakeAwaySalesRow[] = [
      { product_name: 'Pizza TA', quantity: 40, sale_date: '2026-07-28' },
    ];
    const merged = mergeTakeAwayDays(existing, incoming);

    // 27. + 29. bleiben (je 6), 28. jetzt 40 → Σ = 52.
    expect(aggregateTakeAwayGuests(merged, true)).toBe(52);
    // 28.07. kommt genau einmal vor (ersetzt, nicht dupliziert).
    expect(merged.filter(r => r.sale_date === '2026-07-28').length).toBe(1);
    // 27. + 29. unverändert erhalten.
    expect(merged.some(r => r.sale_date === '2026-07-27')).toBe(true);
    expect(merged.some(r => r.sale_date === '2026-07-29')).toBe(true);
  });

  it('fügt neue Tage hinzu, ohne bestehende zu entfernen', () => {
    const existing: TakeAwaySalesRow[] = [
      { product_name: 'Pizza TA', quantity: 6, sale_date: '2026-07-27' },
    ];
    const incoming: TakeAwaySalesRow[] = [
      { product_name: 'Pizza TA', quantity: 10, sale_date: '2026-07-28' },
    ];
    const merged = mergeTakeAwayDays(existing, incoming);
    expect(merged.length).toBe(2);
    expect(aggregateTakeAwayGuests(merged, true)).toBe(16);
  });
});

describe('loadTakeAwayGuests — Mandanten-Filter in der Query', () => {
  it('filtert nach restaurant_id = aktivem Tenant', async () => {
    mockRows = [{ product_name: 'Pizza TA', quantity: 7 }];
    const result = await loadTakeAwayGuests('beaulieu', '2026-07-01', '2026-07-31');
    expect(result).toBe(7);
    // .eq('restaurant_id', 'beaulieu') MUSS aufgerufen worden sein.
    expect(eqCalls).toContainEqual(['restaurant_id', 'beaulieu']);
  });

  it('übergibt den korrekten Tenant (oliv) an den Filter', async () => {
    mockRows = [{ product_name: 'Pasta TA', quantity: 3 }];
    await loadTakeAwayGuests('oliv', '2026-07-01', '2026-07-31');
    expect(eqCalls).toContainEqual(['restaurant_id', 'oliv']);
  });

  it('leerer/ungültiger Zeitraum → null, keine Query', async () => {
    expect(await loadTakeAwayGuests('oliv', null, '2026-07-31')).toBeNull();
    expect(await loadTakeAwayGuests('oliv', '2026-07-31', '2026-07-01')).toBeNull();
    expect(eqCalls.length).toBe(0);
  });

  it('DB-Fehler → null', async () => {
    mockError = { message: 'boom' };
    expect(await loadTakeAwayGuests('oliv', '2026-07-01', '2026-07-31')).toBeNull();
  });
});
