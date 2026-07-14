// @vitest-environment node
/**
 * Integrationsnahe Tests für die Merge-Datenschicht (guest-duplicates-db.ts).
 * =========================================================================
 * Supabase wird durch einen kleinen In-Memory-Store ersetzt, dessen Builder die
 * tatsächlich genutzte Kette (select/eq/in/order/range/limit/update/delete/
 * upsert/insert) gegen echte Daten ausführt. So lassen sich die heiklen
 * Garantien von `mergeGuests` OHNE echte DB prüfen:
 *  - Reservationen werden ZUERST auf den Master umgehängt (kein Verlust),
 *  - Aggregate werden aus reservation_records NEU berechnet (nie summiert),
 *  - Duplikate werden erst gelöscht, wenn keine Reservation mehr an ihnen hängt,
 *  - Mandantenfremde/fehlende IDs brechen VOR jeder Schreiboperation ab,
 *  - der Audit-Log-Eintrag enthält nur IDs/Zähler (keine PII).
 *
 * Synthetische Daten, KEINE echten personenbezogenen Daten.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-Memory-Store + steuerbarer Zustand ────────────────────────────────────
type Row = Record<string, any>;
let DB: Record<string, Row[]>;
let SESSION_USER: string | null;
let SKIP_MOVE_FOR: string | null; // simuliert eine NICHT umgehängte Reservation (z. B. Concurrency)

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

type Filter = { kind: 'eq'; col: string; val: unknown } | { kind: 'in'; col: string; vals: unknown[] };

function matchRow(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === 'eq' && row[f.col] !== f.val) return false;
    if (f.kind === 'in' && !f.vals.includes(row[f.col])) return false;
  }
  return true;
}

interface Op {
  table: string;
  verb?: 'select' | 'update' | 'delete' | 'upsert' | 'insert';
  filters: Filter[];
  patch: Row | null;
  row: Row | null;
  upsertOpts: Row | null;
  returning: boolean;
  limit: number | null;
}

function execute(op: Op): { data: Row[] | null; error: unknown } {
  const table = DB[op.table] ?? (DB[op.table] = []);
  const matched = table.filter(r => matchRow(r, op.filters));

  if (op.verb === 'select') {
    const rows = op.limit != null ? matched.slice(0, op.limit) : matched;
    return { data: clone(rows), error: null };
  }
  if (op.verb === 'update') {
    let targets = matched;
    if (op.table === 'reservation_records' && SKIP_MOVE_FOR) {
      targets = targets.filter(r => r.guest_id !== SKIP_MOVE_FOR);
    }
    for (const r of targets) Object.assign(r, op.patch);
    return { data: op.returning ? clone(targets) : null, error: null };
  }
  if (op.verb === 'delete') {
    const removed: Row[] = [];
    DB[op.table] = table.filter(r => {
      if (matchRow(r, op.filters)) { removed.push(r); return false; }
      return true;
    });
    return { data: op.returning ? clone(removed) : null, error: null };
  }
  if (op.verb === 'upsert') {
    const key = (op.upsertOpts?.onConflict as string) ?? 'id';
    const idx = table.findIndex(r => r[key] === op.row![key]);
    if (idx >= 0) table[idx] = { ...table[idx], ...op.row }; else table.push({ ...op.row });
    return { data: null, error: null };
  }
  if (op.verb === 'insert') {
    table.push({ ...op.row });
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

function makeBuilder(table: string) {
  const op: Op = { table, filters: [], patch: null, row: null, upsertOpts: null, returning: false, limit: null };
  const builder: any = {
    select() { if (op.verb === undefined) op.verb = 'select'; else op.returning = true; return builder; },
    eq(col: string, val: unknown) { op.filters.push({ kind: 'eq', col, val }); return builder; },
    in(col: string, vals: unknown[]) { op.filters.push({ kind: 'in', col, vals }); return builder; },
    order() { return builder; },
    range() { return builder; },
    limit(n: number) { op.limit = n; return builder; },
    update(patch: Row) { op.verb = 'update'; op.patch = patch; return builder; },
    delete() { op.verb = 'delete'; return builder; },
    upsert(row: Row, opts: Row) { op.verb = 'upsert'; op.row = row; op.upsertOpts = opts; return builder; },
    insert(row: Row) { op.verb = 'insert'; op.row = row; return builder; },
    then(onF: any, onR: any) { return Promise.resolve(execute(op)).then(onF, onR); },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => makeBuilder(t),
    auth: {
      getSession: () => Promise.resolve({
        data: { session: SESSION_USER ? { user: { id: SESSION_USER } } : null },
      }),
    },
  },
}));

import { mergeGuests } from '@/lib/guest-duplicates-db';

// ─── Seed-Helfer ──────────────────────────────────────────────────────────────

function gp(id: string, restaurant_id: string, extra: Row = {}): Row {
  return {
    id, restaurant_id,
    first_name: null, last_name: null, email: null, mobile: null,
    normalized_email: null, normalized_mobile: null, normalized_name: null,
    total_reservations: 0, total_persons: 0, cancelled_reservations: 0,
    completed_reservations: 0, first_seen_at: null, last_seen_at: null,
    ...extra,
  };
}
function rr(id: string, restaurant_id: string, guest_id: string, extra: Row = {}): Row {
  return {
    id, restaurant_id, guest_id,
    party_size: 2, status_normalized: 'completed', reservation_date: '2026-01-01',
    ...extra,
  };
}

beforeEach(() => {
  DB = { guest_profiles: [], reservation_records: [], guest_crm_profiles: [], guest_merge_log: [] };
  SESSION_USER = 'operator-uuid-1234';
  SKIP_MOVE_FOR = null;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('mergeGuests — Happy Path', () => {
  beforeEach(() => {
    DB.guest_profiles = [
      gp('m', 'oliv', { first_name: 'Max', total_reservations: 999 /* bewusst falsch → muss überschrieben werden */ }),
      gp('d1', 'oliv', { email: 'max@example.test', normalized_email: 'max@example.test' }),
      gp('d2', 'oliv'),
      gp('x', 'beaulieu', { first_name: 'Fremd' }), // anderer Mandant — unangetastet
    ];
    DB.reservation_records = [
      rr('r1', 'oliv', 'm', { party_size: 2, status_normalized: 'completed', reservation_date: '2026-03-01' }),
      rr('r2', 'oliv', 'm', { party_size: 3, status_normalized: 'cancelled', reservation_date: '2026-02-01' }),
      rr('r3', 'oliv', 'd1', { party_size: 4, status_normalized: 'completed', reservation_date: '2026-05-01' }),
      rr('r4', 'oliv', 'd2', { party_size: 2, status_normalized: 'completed', reservation_date: '2026-01-15' }),
      rr('r5', 'beaulieu', 'x', {}), // anderer Mandant
    ];
    DB.guest_crm_profiles = [
      { guest_id: 'm', crm_notes: 'Master-Notiz', vip_manual: false },
      { guest_id: 'd1', crm_notes: 'Dup-Notiz', vip_manual: true },
    ];
  });

  it('hängt Reservationen um, vereint CRM, rechnet Aggregate neu und löscht Duplikate', async () => {
    const res = await mergeGuests('oliv', 'm', ['d1', 'd2']);

    expect(res.error).toBeNull();
    expect(res.reservationsMoved).toBe(2);   // d1:1 + d2:1
    expect(res.mergedCount).toBe(2);
    expect(res.crmMerged).toBe(true);

    // Duplikate gelöscht, Master + Fremdgast bleiben.
    const ids = DB.guest_profiles.map(g => g.id).sort();
    expect(ids).toEqual(['m', 'x']);

    // Alle Oliv-Reservationen hängen am Master; Fremdmandant unberührt.
    const olivRes = DB.reservation_records.filter(r => r.restaurant_id === 'oliv');
    expect(olivRes.every(r => r.guest_id === 'm')).toBe(true);
    expect(DB.reservation_records.find(r => r.id === 'r5')!.guest_id).toBe('x');

    // Aggregate NEU berechnet (nicht summiert): 4 Reservationen, 11 Personen.
    const master = DB.guest_profiles.find(g => g.id === 'm')!;
    expect(master.total_reservations).toBe(4);
    expect(master.total_persons).toBe(11);
    expect(master.cancelled_reservations).toBe(1);
    expect(master.completed_reservations).toBe(3);
    expect(master.first_seen_at).toBe('2026-01-15');
    expect(master.last_seen_at).toBe('2026-05-01');
  });

  it('reichert leere Master-Identität fill-empty an (E-Mail aus Duplikat)', async () => {
    await mergeGuests('oliv', 'm', ['d1', 'd2']);
    const master = DB.guest_profiles.find(g => g.id === 'm')!;
    expect(master.email).toBe('max@example.test');
    expect(master.normalized_email).toBe('max@example.test');
    expect(master.first_name).toBe('Max'); // Master-Wert bleibt
  });

  it('vereint die CRM-Notizen und behält das VIP-Flag des Duplikats', async () => {
    await mergeGuests('oliv', 'm', ['d1', 'd2']);
    const crm = DB.guest_crm_profiles.find(p => p.guest_id === 'm')!;
    expect(crm.vip_manual).toBe(true);
    expect(String(crm.crm_notes)).toContain('Master-Notiz');
    expect(String(crm.crm_notes)).toContain('Dup-Notiz');
  });

  it('schreibt einen Audit-Eintrag NUR mit IDs/Zählern (keine PII)', async () => {
    await mergeGuests('oliv', 'm', ['d1', 'd2']);
    expect(DB.guest_merge_log).toHaveLength(1);
    const log = DB.guest_merge_log[0];
    expect(log.restaurant_id).toBe('oliv');
    expect(log.master_guest_id).toBe('m');
    expect(log.merged_count).toBe(2);
    expect(log.reservations_moved).toBe(2);
    expect(log.crm_merged).toBe(true);
    expect(log.created_by).toBe('operator-uuid-1234');
    // Kein Name/E-Mail/Telefon im Log.
    const blob = JSON.stringify(log).toLowerCase();
    expect(blob).not.toContain('max');
    expect(blob).not.toContain('@example.test');
  });
});

describe('mergeGuests — Preflight-Schutz (keine Schreiboperation)', () => {
  beforeEach(() => {
    DB.guest_profiles = [gp('m', 'oliv'), gp('d1', 'oliv'), gp('d2', 'beaulieu')];
    DB.reservation_records = [rr('r1', 'oliv', 'd1'), rr('r2', 'beaulieu', 'd2')];
  });

  it('bricht ab, wenn ein Duplikat einem ANDEREN Mandanten gehört — ohne Schreiben', async () => {
    const res = await mergeGuests('oliv', 'm', ['d1', 'd2']);
    expect(res.error).toBeTruthy();
    expect(res.error!).toMatch(/Mandant|abgebrochen/i);
    // Keinerlei Schreiboperation: Reservationen & Profile unverändert, kein Log.
    expect(DB.reservation_records.find(r => r.id === 'r1')!.guest_id).toBe('d1');
    expect(DB.guest_profiles.map(g => g.id).sort()).toEqual(['d1', 'd2', 'm']);
    expect(DB.guest_merge_log).toHaveLength(0);
  });

  it('lehnt den Master als eigenes Duplikat ab', async () => {
    const res = await mergeGuests('oliv', 'm', ['m', 'd1']);
    expect(res.error).toMatch(/Master/i);
    expect(DB.guest_merge_log).toHaveLength(0);
  });

  it('lehnt eine leere Duplikatliste ab', async () => {
    const res = await mergeGuests('oliv', 'm', []);
    expect(res.error).toMatch(/Duplikat/i);
  });
});

describe('mergeGuests — Sicherheits-Gate vor dem Löschen', () => {
  beforeEach(() => {
    DB.guest_profiles = [gp('m', 'oliv'), gp('d1', 'oliv'), gp('d2', 'oliv')];
    DB.reservation_records = [
      rr('r1', 'oliv', 'd1'),
      rr('r2', 'oliv', 'd2'),
    ];
  });

  it('löscht KEINE Duplikate, wenn noch eine Reservation an einem Duplikat hängt', async () => {
    SKIP_MOVE_FOR = 'd1'; // d1s Reservation wird (simuliert) nicht umgehängt
    const res = await mergeGuests('oliv', 'm', ['d1', 'd2']);
    expect(res.error).toMatch(/Reservation|abgebrochen/i);
    // Duplikate bleiben erhalten (kein verfrühtes Löschen → kein Datenverlust).
    expect(DB.guest_profiles.map(g => g.id).sort()).toEqual(['d1', 'd2', 'm']);
    // d1s Reservation hängt noch an d1, d2s wurde bereits gefahrlos auf m verschoben.
    expect(DB.reservation_records.find(r => r.id === 'r1')!.guest_id).toBe('d1');
    expect(DB.reservation_records.find(r => r.id === 'r2')!.guest_id).toBe('m');
  });
});
