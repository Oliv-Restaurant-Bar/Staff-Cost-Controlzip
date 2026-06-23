// @vitest-environment node
/**
 * Test: Foratable Reservationen — Import-Idempotenz (DB-Schicht)
 * =============================================================
 * Verifiziert, dass `saveReservationImport` keine doppelten Reservationen
 * erzeugt und korrekt zwischen NEU eingefügt / AKTUALISIERT unterscheidet.
 *
 * Statt einer echten Supabase-Verbindung wird ein In-Memory-Mock verwendet,
 * der die für diesen Pfad relevanten Operationen nachbildet:
 *   - insert(...).select(...).single()
 *   - upsert(rows, { onConflict }) (mit Conflict-Merge: existierende Zeile
 *     wird aktualisiert statt dupliziert) + optionalem .select(...)
 *   - select(...).eq(...).in(...)
 *   - update(...).eq(...)
 *
 * Abgedeckte Szenarien (Anforderung „Import muss idempotent sein"):
 *   - dieselbe CSV zweimal → keine Duplikate, beim 2. Mal alles „aktualisiert"
 *   - geänderte Daten gleicher Res.Nr. → Zeile wird aktualisiert (eine Zeile)
 *   - doppelte Res.Nr. innerhalb EINER CSV → kein Crash, genau eine Zeile
 *   - Mandantentrennung: gleiche Res.Nr. bei zwei Mandanten → zwei Zeilen
 *   - übersprungene Zeilen (ohne Res.Nr.) werden gezählt, nicht importiert
 *
 * Synthetisch, keine echten personenbezogenen Daten.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-Memory-Supabase-Mock ──────────────────────────────────────────────────

type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
let idCounter = 0;

function tbl(name: string): Row[] {
  if (!store[name]) store[name] = [];
  return store[name];
}
function resetStore() {
  for (const k of Object.keys(store)) delete store[k];
  idCounter = 0;
}

class Query {
  private op: 'select' | 'insert' | 'upsert' | 'update' | null = null;
  private payload: any = null;
  private onConflict: string | null = null;
  private filters: Array<['eq' | 'in', string, any]> = [];
  private wantSelect = false;
  private wantSingle = false;

  constructor(private name: string) {}

  insert(payload: any) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload: any, opts?: { onConflict?: string }) {
    this.op = 'upsert'; this.payload = payload; this.onConflict = opts?.onConflict ?? null; return this;
  }
  update(payload: any) { this.op = 'update'; this.payload = payload; return this; }
  select(_cols?: string) { if (this.op === null) this.op = 'select'; else this.wantSelect = true; return this; }
  eq(col: string, val: any) { this.filters.push(['eq', col, val]); return this; }
  in(col: string, vals: any[]) { this.filters.push(['in', col, vals]); return this; }
  order() { return this; }
  limit() { return this; }
  single() { this.wantSingle = true; return this; }

  private matches(r: Row): boolean {
    return this.filters.every(([t, c, v]) => (t === 'eq' ? r[c] === v : (v as any[]).includes(r[c])));
  }

  private run(): { data: any; error: any } {
    const rows = tbl(this.name);

    if (this.op === 'insert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload])
        .map((r: Row) => ({ id: `id_${++idCounter}`, ...r }));
      rows.push(...items);
      const data = this.wantSelect ? (this.wantSingle ? items[0] : items) : null;
      return { data, error: null };
    }

    if (this.op === 'upsert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const conflictCols = (this.onConflict ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const affected: Row[] = [];
      for (const r of items) {
        const existing = conflictCols.length > 0
          ? rows.find(e => conflictCols.every(c => e[c] === r[c]))
          : undefined;
        if (existing) { Object.assign(existing, r); affected.push(existing); }
        else { const nr = { id: `id_${++idCounter}`, ...r }; rows.push(nr); affected.push(nr); }
      }
      return { data: this.wantSelect ? affected : null, error: null };
    }

    if (this.op === 'update') {
      for (const r of rows.filter(x => this.matches(x))) Object.assign(r, this.payload);
      return { data: null, error: null };
    }

    // select
    const matched = rows.filter(r => this.matches(r));
    return { data: this.wantSingle ? (matched[0] ?? null) : matched, error: null };
  }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    try { resolve(this.run()); } catch (e) { reject ? reject(e) : resolve({ data: null, error: e }); }
  }
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (name: string) => new Query(name) },
}));

import { saveReservationImport } from '@/lib/reservation-import-db';
import { parseReservationsCsv } from '@/lib/reservation-import-parser';

// ── CSV-Helfer (identische Spaltenfolge wie der Parser-Test) ─────────────────

const HEADER =
  'Restaurant;Res.Nr.;Personen;Zeit;Datum;Firma;Vorname;Nachname;Mobile;E-Mail;Status;"reserviert am";Kommentar;Notiz;Tisch;Auswahl;Gästeinformationen;Raum;Bereich';

function row(parts: Partial<Record<string, string>>): string {
  return [
    parts.restaurant ?? 'Oliv',
    parts.resnr ?? '',
    parts.personen ?? '',
    parts.zeit ?? '',
    parts.datum ?? '',
    parts.firma ?? '',
    parts.vorname ?? '',
    parts.nachname ?? '',
    parts.mobile ?? '',
    parts.email ?? '',
    parts.status ?? '',
    parts.reserviertAm ?? '',
    parts.kommentar ?? '',
    parts.notiz ?? '',
    parts.tisch ?? '',
    parts.auswahl ?? '',
    parts.gaeste ?? '',
    parts.raum ?? '',
    parts.bereich ?? '',
  ].join(';');
}

const records = () => tbl('reservation_records');

beforeEach(resetStore);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('saveReservationImport — Idempotenz', () => {
  it('dieselbe CSV zweimal erzeugt keine Duplikate (2. Lauf = nur Aktualisierungen)', async () => {
    const csv = [
      HEADER,
      row({ resnr: '1001', personen: '4', zeit: '19:00', datum: '05.06.2026', email: 'a@example.com', vorname: 'A', nachname: 'Eins', status: 'Bestätigt' }),
      row({ resnr: '1002', personen: '2', zeit: '20:00', datum: '06.06.2026', email: 'b@example.com', vorname: 'B', nachname: 'Zwei', status: 'Abgeschlossen' }),
      row({ resnr: '1003', personen: '3', zeit: '18:30', datum: '07.06.2026', mobile: '+41 79 000 00 01', vorname: 'C', nachname: 'Drei', status: 'No-Show' }),
    ].join('\n');
    const parsed = parseReservationsCsv('reservierungen.csv', csv);

    const r1 = await saveReservationImport('oliv', parsed);
    expect(r1.error).toBeNull();
    expect(r1.reservationCount).toBe(3);
    expect(r1.inserted).toBe(3);
    expect(r1.updated).toBe(0);
    expect(records().length).toBe(3);

    const r2 = await saveReservationImport('oliv', parsed);
    expect(r2.error).toBeNull();
    expect(r2.reservationCount).toBe(3);
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(3);
    expect(records().length).toBe(3); // immer noch nur drei — keine Duplikate
  });

  it('gleiche Res.Nr. mit geänderten Daten aktualisiert die bestehende Zeile', async () => {
    const csvA = [
      HEADER,
      row({ resnr: '2001', personen: '2', zeit: '19:00', datum: '05.06.2026', email: 'g@example.com', vorname: 'G', nachname: 'Alt', status: 'Bestätigt' }),
    ].join('\n');
    const a = await saveReservationImport('oliv', parseReservationsCsv('a.csv', csvA));
    expect(a.inserted).toBe(1);
    expect(records().length).toBe(1);

    const csvB = [
      HEADER,
      row({ resnr: '2001', personen: '6', zeit: '20:30', datum: '05.06.2026', email: 'g@example.com', vorname: 'G', nachname: 'Neu', status: 'Abgeschlossen' }),
    ].join('\n');
    const b = await saveReservationImport('oliv', parseReservationsCsv('b.csv', csvB));
    expect(b.error).toBeNull();
    expect(b.inserted).toBe(0);
    expect(b.updated).toBe(1);
    expect(records().length).toBe(1); // weiterhin eine Zeile

    const stored = records()[0];
    expect(stored.party_size).toBe(6);
    expect(stored.reservation_time).toBe('20:30');
    expect(stored.status_normalized).toBe('completed');
  });

  it('doppelte Res.Nr. innerhalb EINER CSV → kein Crash, genau eine Zeile (letzte gewinnt)', async () => {
    const csv = [
      HEADER,
      row({ resnr: '3001', personen: '2', zeit: '18:00', datum: '05.06.2026', email: 'd@example.com', status: 'Bestätigt' }),
      row({ resnr: '3001', personen: '5', zeit: '21:00', datum: '05.06.2026', email: 'd@example.com', status: 'Abgeschlossen' }),
      row({ resnr: '3002', personen: '3', zeit: '19:00', datum: '06.06.2026', email: 'e@example.com', status: 'Bestätigt' }),
    ].join('\n');
    const parsed = parseReservationsCsv('dup.csv', csv);

    const r = await saveReservationImport('oliv', parsed);
    expect(r.error).toBeNull();
    expect(r.duplicateKeyMerged).toBe(1);
    expect(r.reservationCount).toBe(2);
    expect(r.inserted).toBe(2);
    expect(records().length).toBe(2);

    const merged = records().find(x => x.external_reservation_id === '3001');
    expect(merged?.party_size).toBe(5);          // letzte Zeile gewinnt
    expect(merged?.status_normalized).toBe('completed');
  });

  it('Mandantentrennung: gleiche Res.Nr. bei zwei Mandanten ergibt zwei Zeilen', async () => {
    const csv = [
      HEADER,
      row({ resnr: '9001', personen: '2', zeit: '19:00', datum: '05.06.2026', email: 't@example.com', status: 'Bestätigt' }),
    ].join('\n');
    const parsed = parseReservationsCsv('tenant.csv', csv);

    await saveReservationImport('oliv', parsed);
    await saveReservationImport('beaulieu', parsed);
    expect(records().length).toBe(2);
    expect(records().map(r => r.restaurant_id).sort()).toEqual(['beaulieu', 'oliv']);

    // Erneuter Oliv-Import aktualisiert NUR die Oliv-Zeile.
    const again = await saveReservationImport('oliv', parsed);
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(1);
    expect(records().length).toBe(2);
  });

  it('Zeilen ohne Res.Nr. werden gezählt (skippedRows) und nicht importiert', async () => {
    const csv = [
      HEADER,
      row({ resnr: '', vorname: 'Ohne', nachname: 'Nummer', email: 'x@example.com' }),
      row({ resnr: '4001', personen: '2', datum: '05.06.2026', email: 's@example.com', status: 'Bestätigt' }),
    ].join('\n');
    const parsed = parseReservationsCsv('skip.csv', csv);

    const r = await saveReservationImport('oliv', parsed);
    expect(r.error).toBeNull();
    expect(r.skippedRows).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.reservationCount).toBe(1);
    expect(records().length).toBe(1);
  });
});
