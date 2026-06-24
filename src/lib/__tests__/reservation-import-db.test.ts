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

// ── Gast-Wiedererkennung (Duplikat-Vermeidung) ───────────────────────────────
// Verifiziert, dass beim Import bestehende Gäste WIEDERVERWENDET statt
// dupliziert werden. Matching-Priorität: Telefon → E-Mail → neu (Name matcht NICHT).

const guests = () => tbl('guest_profiles');

/** Seedet ein bestehendes Gästeprofil direkt in den In-Memory-Store. */
function seedGuest(g: {
  id: string;
  restaurant_id: string;
  match_key: string;
  normalized_email?: string | null;
  normalized_mobile?: string | null;
  normalized_name?: string | null;
}) {
  guests().push({
    normalized_email: null,
    normalized_mobile: null,
    normalized_name: null,
    ...g,
  });
}

describe('saveReservationImport — Gast-Wiedererkennung', () => {
  it('gleiche Telefonnummer verwendet den bestehenden Gast wieder (kein neuer Gast)', async () => {
    seedGuest({
      id: 'g-phone',
      restaurant_id: 'oliv',
      match_key: 'mobile:41790000001',
      normalized_mobile: '41790000001',
    });
    const csv = [
      HEADER,
      // andere Schreibweise derselben Nummer, ohne E-Mail
      row({ resnr: '5001', personen: '2', datum: '05.06.2026', mobile: '0041 79 000 00 01', vorname: 'Tel', nachname: 'Gast', status: 'Bestätigt' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('phone.csv', csv));
    expect(r.error).toBeNull();
    expect(r.returningGuests).toBe(1);
    expect(r.newGuests).toBe(0);
    expect(guests().length).toBe(1); // kein zusätzlicher Gast angelegt
    expect(records()[0].guest_id).toBe('g-phone');
  });

  it('gleiche E-Mail (case-insensitiv) verwendet den bestehenden Gast wieder', async () => {
    seedGuest({
      id: 'g-mail',
      restaurant_id: 'oliv',
      match_key: 'email:a@example.com',
      normalized_email: 'a@example.com',
    });
    const csv = [
      HEADER,
      // Grossschreibung muss trotzdem matchen, keine Telefonnummer
      row({ resnr: '6001', personen: '4', datum: '06.06.2026', email: 'A@Example.COM', vorname: 'Mail', nachname: 'Gast', status: 'Abgeschlossen' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('mail.csv', csv));
    expect(r.error).toBeNull();
    expect(r.returningGuests).toBe(1);
    expect(r.newGuests).toBe(0);
    expect(guests().length).toBe(1);
    expect(records()[0].guest_id).toBe('g-mail');
  });

  it('Telefon hat Vorrang vor E-Mail, wenn beide auf VERSCHIEDENE Gäste zeigen', async () => {
    seedGuest({
      id: 'g-by-phone',
      restaurant_id: 'oliv',
      match_key: 'mobile:41790000050',
      normalized_mobile: '41790000050',
      normalized_email: 'phoneowner@example.com',
    });
    seedGuest({
      id: 'g-by-mail',
      restaurant_id: 'oliv',
      match_key: 'email:mailowner@example.com',
      normalized_email: 'mailowner@example.com',
    });
    const csv = [
      HEADER,
      row({ resnr: '6501', personen: '2', datum: '06.06.2026', mobile: '+41 79 000 00 50', email: 'mailowner@example.com', vorname: 'Beide', nachname: 'Gast', status: 'Bestätigt' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('both.csv', csv));
    expect(r.error).toBeNull();
    expect(r.returningGuests).toBe(1);
    expect(r.newGuests).toBe(0);
    expect(records()[0].guest_id).toBe('g-by-phone'); // Telefon gewinnt
    expect(guests().length).toBe(2); // kein neuer Gast
  });

  it('Mandantentrennung: ein Treffer bei einem ANDEREN Mandanten zählt nicht', async () => {
    seedGuest({
      id: 'g-other-tenant',
      restaurant_id: 'beaulieu',
      match_key: 'mobile:41790000099',
      normalized_mobile: '41790000099',
    });
    const csv = [
      HEADER,
      row({ resnr: '7001', personen: '2', datum: '07.06.2026', mobile: '+41 79 000 00 99', vorname: 'Cross', nachname: 'Tenant', status: 'Bestätigt' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('cross.csv', csv));
    expect(r.error).toBeNull();
    expect(r.returningGuests).toBe(0);
    expect(r.newGuests).toBe(1); // neu für oliv, KEIN Match über Mandantengrenze
    expect(guests().length).toBe(2);
    const created = guests().find(g => g.restaurant_id === 'oliv');
    expect(created).toBeTruthy();
    expect(created!.id).not.toBe('g-other-tenant');
    expect(records()[0].guest_id).toBe(created!.id);
  });

  it('ohne Telefon UND ohne E-Mail wird ein neuer Gast angelegt (Name allein matcht NICHT)', async () => {
    // Bestehender, per E-Mail identifizierter Gast mit GLEICHEM Namen: er darf
    // NICHT allein über den Namen wiederverwendet werden (Telefon/E-Mail fehlen).
    seedGuest({
      id: 'g-samename',
      restaurant_id: 'oliv',
      match_key: 'email:someone@example.com',
      normalized_email: 'someone@example.com',
      normalized_name: 'nur name',
    });
    const csv = [
      HEADER,
      row({ resnr: '8001', personen: '2', datum: '08.06.2026', vorname: 'Nur', nachname: 'Name', status: 'Bestätigt' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('noname.csv', csv));
    expect(r.error).toBeNull();
    expect(r.newGuests).toBe(1);
    expect(r.returningGuests).toBe(0);
    expect(guests().length).toBe(2); // neuer Gast trotz Namensgleichheit
    const created = guests().find(g => g.id !== 'g-samename');
    expect(created).toBeTruthy();
    expect(records()[0].guest_id).toBe(created!.id);
  });

  it('ein normaler Import mit gemischten Identitäten läuft weiterhin erfolgreich durch', async () => {
    const csv = [
      HEADER,
      row({ resnr: '9101', personen: '2', zeit: '19:00', datum: '05.06.2026', email: 'neu1@example.com', vorname: 'N', nachname: 'Eins', status: 'Bestätigt' }),
      row({ resnr: '9102', personen: '3', zeit: '20:00', datum: '06.06.2026', mobile: '+41 79 111 22 33', vorname: 'N', nachname: 'Zwei', status: 'Abgeschlossen' }),
    ].join('\n');

    const r = await saveReservationImport('oliv', parseReservationsCsv('mixed.csv', csv));
    expect(r.error).toBeNull();
    expect(r.reservationCount).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.newGuests).toBe(2);
    expect(records().length).toBe(2);
  });
});
