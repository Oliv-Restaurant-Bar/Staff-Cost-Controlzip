// @vitest-environment node
/**
 * Tests für die CRM-Aktionen-Datenschicht (crm-activities-db.ts).
 * ==============================================================
 * In-Memory-Supabase-Mock + gemockter Mandanten-Check (fetchGuestById).
 * Geprüft werden: Mandantentrennung (Preflight vor JEDEM Schreibvorgang),
 * „als kontaktiert markieren", „Notiz hinzufügen", „Folgeaufgabe erstellen"
 * (Fan-out, batch_id), Statuswechsel mit id+restaurant_id+activity_type-Gate,
 * sowie die Anzeige der Gast-Aktivitäten (Lesepfad inkl. Mandanten-Gate).
 *
 * Synthetische Daten, KEINE echten personenbezogenen Daten, kein Logging.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const ACTIVITY_TABLE = 'guest_crm_activities';
const CONTACT_LIST_TABLE = 'guest_crm_contact_lists';
const REST = 'oliv';

// ── steuerbarer Zustand ───────────────────────────────────────────────────────
let _tenantGuestIds: Set<string>;        // Gäste, die zu REST gehören
let _insertError: unknown;
let _selectError: unknown;
let _activitiesData: unknown[];          // Rückgabe des Aktivitäten-SELECT
let _contactListsData: unknown[];        // Rückgabe des Kontaktlisten-SELECT
let _updateData: unknown;                // maybeSingle-Data des UPDATE
let _updateError: unknown;
let _contactInsertData: unknown;         // maybeSingle-Data des Kontaktlisten-INSERT

let _captured: Array<{ table: string; rows: unknown }>;
let _lastUpdate: { patch: unknown; filters: Record<string, unknown> } | null;

function resolveResult(state: BuilderState) {
  const { table, op, filters } = state;
  if (table === 'guest_profiles' && op === 'select') {
    if (filters['restaurant_id'] !== REST) return { data: [], error: null };
    const chunk = (state.inVals ?? []) as string[];
    return { data: chunk.filter(id => _tenantGuestIds.has(id)).map(id => ({ id })), error: null };
  }
  if (table === ACTIVITY_TABLE) {
    if (op === 'insert') return { data: null, error: _insertError };
    if (op === 'update') return { data: _updateData, error: _updateError };
    if (op === 'select') return { data: _selectError ? null : _activitiesData, error: _selectError };
  }
  if (table === CONTACT_LIST_TABLE) {
    if (op === 'insert') return { data: _contactInsertData, error: _insertError };
    if (op === 'select') return { data: _selectError ? null : _contactListsData, error: _selectError };
  }
  return { data: null, error: null };
}

interface BuilderState {
  table: string;
  op: 'select' | 'insert' | 'update';
  filters: Record<string, unknown>;
  inVals: unknown[] | null;
  patch: unknown;
}

function makeBuilder(table: string) {
  const state: BuilderState = { table, op: 'select', filters: {}, inVals: null, patch: null };
  const result = () => Promise.resolve(resolveResult(state));
  const builder = {
    select() { return builder; },
    insert(rows: unknown) { state.op = 'insert'; _captured.push({ table, rows }); return builder; },
    update(patch: unknown) {
      state.op = 'update'; state.patch = patch;
      _lastUpdate = { patch, filters: state.filters };
      return builder;
    },
    eq(col: string, val: unknown) {
      state.filters[col] = val;
      if (_lastUpdate && state.op === 'update') _lastUpdate.filters = { ...state.filters };
      return builder;
    },
    in(_col: string, vals: unknown[]) { state.inVals = vals; return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { return result(); },
    then<T>(onF: (v: { data: unknown; error: unknown }) => T) { return result().then(onF); },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => makeBuilder(t),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'op-1' } } } }) },
  },
}));

// Mandanten-Gate für Lesepfade: Gast existiert nur, wenn er zu REST gehört.
vi.mock('@/lib/reservation-crm-db', () => ({
  fetchGuestById: (_rest: string, id: string) =>
    Promise.resolve(_tenantGuestIds.has(id) ? { id } : null),
}));

import {
  verifyGuestsBelongToTenant, markGuestsContacted, addGuestNote, createFollowUpTask,
  setFollowUpStatus, fetchGuestActivities, createContactList, fetchContactLists,
} from '@/lib/crm-activities-db';
import { splitActivitiesByType } from '@/lib/crm-activities';

function lastInsert() { return _captured[_captured.length - 1]; }
function insertRows(): Array<Record<string, unknown>> {
  const r = lastInsert()?.rows;
  return Array.isArray(r) ? r : (r ? [r as Record<string, unknown>] : []);
}

beforeEach(() => {
  _tenantGuestIds = new Set(['g1', 'g2', 'g3']);
  _insertError = null;
  _selectError = null;
  _activitiesData = [];
  _contactListsData = [];
  _updateData = { id: 'a1' };
  _updateError = null;
  _contactInsertData = null;
  _captured = [];
  _lastUpdate = null;
});

describe('verifyGuestsBelongToTenant', () => {
  it('alle Gäste gehören zum Mandanten → eindeutige IDs', async () => {
    const out = await verifyGuestsBelongToTenant(REST, ['g1', 'g2', 'g1']);
    expect(out).toEqual(['g1', 'g2']);
  });

  it('ein fremder Gast → Exception', async () => {
    await expect(verifyGuestsBelongToTenant(REST, ['g1', 'fremd'])).rejects.toThrow(/nicht zum aktuellen Restaurant/i);
  });

  it('leere Auswahl → Exception', async () => {
    await expect(verifyGuestsBelongToTenant(REST, [])).rejects.toThrow(/Keine Gäste/i);
  });
});

describe('markGuestsContacted', () => {
  it('Fan-out: eine Zeile pro Gast, restaurant_id + contacted_on gesetzt', async () => {
    const n = await markGuestsContacted(REST, ['g1', 'g2'], { segmentKey: 'vip', contactedOn: '2026-06-24' });
    expect(n).toBe(2);
    const rows = insertRows();
    expect(lastInsert().table).toBe(ACTIVITY_TABLE);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.restaurant_id === REST)).toBe(true);
    expect(rows.every(r => r.activity_type === 'contacted')).toBe(true);
    expect(rows.every(r => r.contacted_on === '2026-06-24')).toBe(true);
    // Sammelaktion (>1 Gast) → gemeinsame batch_id
    expect(rows.every(r => r.batch_id === rows[0].batch_id)).toBe(true);
    expect(rows[0].batch_id).toBeTruthy();
  });

  it('einzelner Gast → keine batch_id', async () => {
    await markGuestsContacted(REST, ['g1']);
    expect(insertRows()[0].batch_id).toBeNull();
  });

  it('Mandantentrennung: fremder Gast bricht ab, KEIN Insert', async () => {
    await expect(markGuestsContacted(REST, ['g1', 'fremd'])).rejects.toThrow(/nicht zum aktuellen Restaurant/i);
    expect(_captured).toHaveLength(0);
  });

  it('Schreibfehler → Exception', async () => {
    _insertError = { message: 'boom' };
    await expect(markGuestsContacted(REST, ['g1'])).rejects.toThrow(/boom|gespeichert/i);
  });
});

describe('addGuestNote', () => {
  it('leere Notiz → Exception, kein Insert', async () => {
    await expect(addGuestNote(REST, ['g1'], '   ')).rejects.toThrow(/Notiz darf nicht leer/i);
    expect(_captured).toHaveLength(0);
  });

  it('gültige Notiz → Fan-out mit note', async () => {
    const n = await addGuestNote(REST, ['g1', 'g2'], 'Sommeraktion');
    expect(n).toBe(2);
    const rows = insertRows();
    expect(rows.every(r => r.activity_type === 'note')).toBe(true);
    expect(rows.every(r => r.note === 'Sommeraktion')).toBe(true);
  });
});

describe('createFollowUpTask', () => {
  it('ohne Fälligkeitsdatum → Exception, kein Insert', async () => {
    await expect(createFollowUpTask(REST, ['g1'], '')).rejects.toThrow(/Fälligkeitsdatum/i);
    expect(_captured).toHaveLength(0);
  });

  it('mit Fälligkeitsdatum → Status open, due_date gesetzt', async () => {
    const n = await createFollowUpTask(REST, ['g1'], '2026-07-01', { description: 'anrufen' });
    expect(n).toBe(1);
    const r = insertRows()[0];
    expect(r.activity_type).toBe('follow_up');
    expect(r.due_date).toBe('2026-07-01');
    expect(r.status).toBe('open');
    expect(r.note).toBe('anrufen');
  });
});

describe('setFollowUpStatus', () => {
  it('erfolgreicher Wechsel → Update mit id+restaurant_id+activity_type-Gate', async () => {
    _updateData = { id: 'a1' };
    await setFollowUpStatus(REST, 'a1', 'done');
    expect(_lastUpdate).not.toBeNull();
    expect(_lastUpdate!.filters['restaurant_id']).toBe(REST);
    expect(_lastUpdate!.filters['id']).toBe('a1');
    expect(_lastUpdate!.filters['activity_type']).toBe('follow_up');
    expect((_lastUpdate!.patch as Record<string, unknown>).status).toBe('done');
    expect((_lastUpdate!.patch as Record<string, unknown>).completed_at).toBeTruthy();
  });

  it('done → open setzt completed_at zurück', async () => {
    await setFollowUpStatus(REST, 'a1', 'open');
    expect((_lastUpdate!.patch as Record<string, unknown>).completed_at).toBeNull();
  });

  it('kein Treffer (data null) → Exception', async () => {
    _updateData = null;
    await expect(setFollowUpStatus(REST, 'a1', 'done')).rejects.toThrow(/nicht gefunden|kein Zugriff/i);
  });

  it('Update-Fehler → Exception', async () => {
    _updateError = { message: 'denied' };
    await expect(setFollowUpStatus(REST, 'a1', 'done')).rejects.toThrow(/denied|aktualisiert/i);
  });
});

describe('fetchGuestActivities (Anzeige der Gast-Aktivität)', () => {
  it('fremder Gast (Mandanten-Gate) → leere Liste', async () => {
    const out = await fetchGuestActivities(REST, 'fremd');
    expect(out).toEqual([]);
  });

  it('liefert gemappte Aktivitäten, die nach Typ aufteilbar sind', async () => {
    _activitiesData = [
      { id: 'c1', guest_id: 'g1', activity_type: 'contacted', segment_key: 'vip', note: null,
        due_date: null, status: null, contacted_on: '2026-06-01', batch_id: null,
        created_by: 'op-1', completed_at: null, created_at: '2026-06-01T10:00:00Z' },
      { id: 'n1', guest_id: 'g1', activity_type: 'note', segment_key: null, note: 'Notiz',
        due_date: null, status: null, contacted_on: null, batch_id: null,
        created_by: 'op-1', completed_at: null, created_at: '2026-06-02T10:00:00Z' },
      { id: 'f1', guest_id: 'g1', activity_type: 'follow_up', segment_key: null, note: 'anrufen',
        due_date: '2026-07-01', status: 'open', contacted_on: null, batch_id: null,
        created_by: 'op-1', completed_at: null, created_at: '2026-06-03T10:00:00Z' },
    ];
    const out = await fetchGuestActivities(REST, 'g1');
    expect(out).toHaveLength(3);
    const split = splitActivitiesByType(out);
    expect(split.contacted.map(a => a.id)).toEqual(['c1']);
    expect(split.notes.map(a => a.id)).toEqual(['n1']);
    expect(split.followUps.map(a => a.id)).toEqual(['f1']);
    expect(split.followUps[0].status).toBe('open');
  });
});

describe('createContactList / fetchContactLists', () => {
  it('leerer Name → Exception, kein Insert', async () => {
    await expect(createContactList(REST, '  ', ['g1'])).rejects.toThrow(/Namen/i);
    expect(_captured).toHaveLength(0);
  });

  it('fremder Gast → Exception, kein Insert', async () => {
    await expect(createContactList(REST, 'VIP', ['g1', 'fremd'])).rejects.toThrow(/nicht zum aktuellen Restaurant/i);
    expect(_captured).toHaveLength(0);
  });

  it('gültig → Insert mit guest_ids + member_count + restaurant_id, gemappte Rückgabe', async () => {
    _contactInsertData = {
      id: 'l1', name: 'VIP', segment_key: 'vip', guest_ids: ['g1', 'g2'],
      member_count: 2, created_by: 'op-1', created_at: '2026-06-24T10:00:00Z',
    };
    const out = await createContactList(REST, 'VIP', ['g1', 'g2'], { segmentKey: 'vip' });
    const row = insertRows()[0];
    expect(lastInsert().table).toBe(CONTACT_LIST_TABLE);
    expect(row.restaurant_id).toBe(REST);
    expect(row.member_count).toBe(2);
    expect(row.guest_ids).toEqual(['g1', 'g2']);
    expect(out.id).toBe('l1');
    expect(out.memberCount).toBe(2);
    expect(out.guestIds).toEqual(['g1', 'g2']);
  });

  it('fetchContactLists mappt Zeilen', async () => {
    _contactListsData = [{
      id: 'l1', name: 'VIP', segment_key: 'vip', guest_ids: ['g1'],
      member_count: 1, created_by: 'op-1', created_at: 'x',
    }];
    const out = await fetchContactLists(REST);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('VIP');
  });
});
