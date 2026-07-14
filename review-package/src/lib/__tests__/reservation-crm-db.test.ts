// @vitest-environment node
/**
 * Tests für die Mandanten-Isolation der CRM-Lesepfade (reservation-crm-db.ts).
 *
 * Ziel: jede Abfrage filtert strikt auf `restaurant_id`, sodass ein Mandant
 * niemals Reservationen eines anderen Mandanten sieht.  Es wird ein minimaler
 * In-Memory-Supabase-Mock verwendet (Muster aus reservation-import-db.test.ts),
 * der `.eq()`-Filter und `.range()`-Pagination nachbildet.
 *
 * Ausschliesslich synthetische Daten — KEINE echte PII.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

/** Globaler In-Memory-Datenspeicher, pro Test neu befüllt. */
const store: Record<string, Row[]> = {
  reservation_records: [],
  guest_profiles: [],
};

/**
 * Minimale Query-Nachbildung: unterstützt select/eq/order/range und ist
 * „thenable", sodass `await query` die gefilterten Zeilen liefert.
 */
class Query {
  private eqs: Array<[string, unknown]> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  order() { return this; }
  range(from: number, to: number) { this.rangeFrom = from; this.rangeTo = to; return this; }
  private run() {
    let matched = this.rows.filter(r => this.eqs.every(([c, v]) => r[c] === v));
    if (this.rangeFrom !== null) {
      matched = matched.slice(this.rangeFrom, (this.rangeTo ?? matched.length) + 1);
    }
    return { data: matched, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T) { return resolve(this.run()); }
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => new Query(store[table] ?? []),
  },
}));

import { fetchGuestReservations, fetchCompletedVisitAggregates, fetchGuestProfiles } from '../reservation-crm-db';

function resRow(over: Partial<Row>): Row {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    restaurant_id: 'oliv',
    guest_id: 'g-1',
    external_reservation_id: null,
    reservation_date: '2026-01-10',
    reservation_time: '19:00',
    party_size: 2,
    status: 'Bestätigt',
    status_normalized: 'completed',
    room: null,
    area: null,
    note: null,
    comment: null,
    ...over,
  };
}

function profRow(over: Partial<Row>): Row {
  return {
    id: `g-${Math.random().toString(36).slice(2)}`,
    restaurant_id: 'oliv',
    first_name: 'Test',
    last_name: 'Gast',
    email: null,
    mobile: null,
    first_seen_at: null,
    last_seen_at: '2026-01-10',
    total_reservations: 0,
    total_persons: 0,
    cancelled_reservations: 0,
    completed_reservations: 0,
    ...over,
  };
}

beforeEach(() => {
  store.reservation_records = [];
  store.guest_profiles = [];
});

describe('fetchGuestReservations — Mandanten-Isolation', () => {
  it('liefert nur Reservationen des angefragten Mandanten', async () => {
    store.reservation_records = [
      resRow({ id: 'a1', restaurant_id: 'oliv', guest_id: 'g-1', reservation_date: '2026-01-01' }),
      resRow({ id: 'a2', restaurant_id: 'oliv', guest_id: 'g-1', reservation_date: '2026-02-01' }),
      // Anderer Mandant, gleiche guest_id → muss ausgeschlossen werden:
      resRow({ id: 'b1', restaurant_id: 'b-beaulieu', guest_id: 'g-1', reservation_date: '2026-03-01' }),
    ];
    const rows = await fetchGuestReservations('oliv', 'g-1');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('liefert nichts, wenn nur ein anderer Mandant Daten hat', async () => {
    store.reservation_records = [
      resRow({ id: 'b1', restaurant_id: 'b-beaulieu', guest_id: 'g-1' }),
    ];
    const rows = await fetchGuestReservations('oliv', 'g-1');
    expect(rows).toEqual([]);
  });
});

describe('fetchCompletedVisitAggregates — Mandanten-Isolation', () => {
  it('aggregiert nur abgeschlossene Besuche des angefragten Mandanten', async () => {
    store.reservation_records = [
      resRow({ restaurant_id: 'oliv', guest_id: 'g-1', reservation_date: '2026-01-05', party_size: 2, status_normalized: 'completed' }),
      resRow({ restaurant_id: 'oliv', guest_id: 'g-1', reservation_date: '2026-03-05', party_size: 4, status_normalized: 'completed' }),
      // Anderer Mandant, gleiche guest_id → darf NICHT mitzählen:
      resRow({ restaurant_id: 'b-beaulieu', guest_id: 'g-1', reservation_date: '2026-06-05', party_size: 8, status_normalized: 'completed' }),
      // Gleicher Mandant, aber nicht abgeschlossen → zählt nicht als Besuch:
      resRow({ restaurant_id: 'oliv', guest_id: 'g-1', reservation_date: '2026-04-05', party_size: 6, status_normalized: 'cancelled' }),
    ];
    const agg = await fetchCompletedVisitAggregates('oliv');
    expect(agg.size).toBe(1);
    const g1 = agg.get('g-1');
    expect(g1?.visits).toBe(2);
    expect(g1?.firstVisit).toBe('2026-01-05');
    expect(g1?.lastVisit).toBe('2026-03-05'); // NICHT der 06-05-Besuch des anderen Mandanten
    expect(g1?.avgPartySize).toBe(3);          // (2+4)/2 — ohne den 8er des anderen Mandanten
  });

  it('liefert eine leere Map, wenn nur ein anderer Mandant Daten hat', async () => {
    store.reservation_records = [
      resRow({ restaurant_id: 'b-beaulieu', guest_id: 'g-9', status_normalized: 'completed' }),
    ];
    const agg = await fetchCompletedVisitAggregates('oliv');
    expect(agg.size).toBe(0);
  });
});

// Die Smart-Segmente werden rein über die von `fetchGuestProfiles` gelieferten,
// bereits mandantengefilterten Kennzahlen berechnet (keine eigene DB-Abfrage,
// keine Migration). Damit erbt die Smart-Segment-Funktion die Mandantentrennung
// vollständig von dieser Quelle — der folgende Test sichert genau diese Quelle ab.
describe('fetchGuestProfiles — Mandanten-Isolation (Datenquelle der Smart-Segmente)', () => {
  it('liefert nur Gästeprofile des angefragten Mandanten', async () => {
    store.guest_profiles = [
      profRow({ id: 'g-oliv-1', restaurant_id: 'oliv' }),
      profRow({ id: 'g-oliv-2', restaurant_id: 'oliv' }),
      profRow({ id: 'g-bea-1', restaurant_id: 'b-beaulieu' }),
    ];
    const rows = await fetchGuestProfiles('oliv');
    expect(rows.map(r => r.id).sort()).toEqual(['g-oliv-1', 'g-oliv-2']);
    expect(rows.every(r => r.restaurant_id === 'oliv')).toBe(true);
  });

  it('liefert nichts, wenn nur ein anderer Mandant Daten hat', async () => {
    store.guest_profiles = [profRow({ id: 'g-bea-1', restaurant_id: 'b-beaulieu' })];
    const rows = await fetchGuestProfiles('oliv');
    expect(rows).toEqual([]);
  });
});
