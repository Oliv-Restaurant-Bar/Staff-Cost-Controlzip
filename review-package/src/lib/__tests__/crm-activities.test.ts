// @vitest-environment node
/**
 * Reine Logik-Tests für crm-activities.ts (KEIN supabase/DOM).
 * ===========================================================
 * Deckt Mapping (snake↔camel), den Fan-out beim Erzeugen der Insert-Zeilen
 * (eine Zeile pro Gast, typ-fremde Felder null) sowie Sortierung/Aufteilung
 * für die Anzeige ab. Synthetische Daten, KEINE echten personenbezogenen Daten.
 */

import { describe, it, expect } from 'vitest';
import {
  cleanText, uniqueGuestIds, buildActivityInsertRows,
  rowToCrmActivity, rowToContactList, splitActivitiesByType,
  sortFollowUps, ACTIVITY_TYPE_LABEL, FOLLOW_UP_STATUS_LABEL,
  type CrmActivity, type CrmActivityRow, type ContactListRow,
} from '@/lib/crm-activities';

const REST = 'oliv';

describe('cleanText / uniqueGuestIds', () => {
  it('cleanText: leer/whitespace → null, sonst getrimmt', () => {
    expect(cleanText('  ')).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText('  hallo ')).toBe('hallo');
  });

  it('uniqueGuestIds: dedupliziert, ignoriert leere, behält Reihenfolge', () => {
    expect(uniqueGuestIds(['a', 'b', 'a', '', null, undefined, 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('buildActivityInsertRows (Fan-out)', () => {
  it('eine Zeile pro eindeutigem Gast', () => {
    const rows = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1', 'g2', 'g1'], activityType: 'note', note: 'Hi',
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.guest_id)).toEqual(['g1', 'g2']);
    expect(rows.every(r => r.restaurant_id === REST)).toBe(true);
  });

  it('contacted: contacted_on + optionale Notiz, andere Felder null', () => {
    const [r] = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1'], activityType: 'contacted',
      contactedOn: '2026-06-24', note: 'erreicht', segmentKey: 'vip',
    });
    expect(r.activity_type).toBe('contacted');
    expect(r.contacted_on).toBe('2026-06-24');
    expect(r.note).toBe('erreicht');
    expect(r.segment_key).toBe('vip');
    expect(r.due_date).toBeNull();
    expect(r.status).toBeNull();
  });

  it('note: note gesetzt, typ-fremde Felder null', () => {
    const [r] = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1'], activityType: 'note', note: 'Notiz',
    });
    expect(r.note).toBe('Notiz');
    expect(r.due_date).toBeNull();
    expect(r.status).toBeNull();
    expect(r.contacted_on).toBeNull();
  });

  it('follow_up: due_date + Default-Status open, optionale Beschreibung', () => {
    const [r] = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1'], activityType: 'follow_up', dueDate: '2026-07-01', note: 'anrufen',
    });
    expect(r.due_date).toBe('2026-07-01');
    expect(r.status).toBe('open');
    expect(r.note).toBe('anrufen');
    expect(r.contacted_on).toBeNull();
  });

  it('batchId + createdBy werden propagiert', () => {
    const rows = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1', 'g2'], activityType: 'note', note: 'x',
      batchId: 'batch-1', createdBy: 'op-1',
    });
    expect(rows.every(r => r.batch_id === 'batch-1')).toBe(true);
    expect(rows.every(r => r.created_by === 'op-1')).toBe(true);
  });

  it('leere Notiz → null (auch bei note-Typ, Aufrufer muss validieren)', () => {
    const [r] = buildActivityInsertRows({
      restaurantId: REST, guestIds: ['g1'], activityType: 'note', note: '   ',
    });
    expect(r.note).toBeNull();
  });
});

describe('rowToCrmActivity', () => {
  it('mappt snake → camel, normalisiert Typ/Status', () => {
    const row: CrmActivityRow = {
      id: 'a1', guest_id: 'g1', activity_type: 'follow_up', segment_key: 'vip',
      note: 'n', due_date: '2026-07-01', status: 'open', contacted_on: null,
      batch_id: 'b1', created_by: 'op', completed_at: null, created_at: '2026-06-24T10:00:00Z',
    };
    const a = rowToCrmActivity(row);
    expect(a.activityType).toBe('follow_up');
    expect(a.segmentKey).toBe('vip');
    expect(a.dueDate).toBe('2026-07-01');
    expect(a.status).toBe('open');
    expect(a.batchId).toBe('b1');
    expect(a.createdAt).toBe('2026-06-24T10:00:00Z');
  });

  it('unbekannter Typ → note, unbekannter Status → null', () => {
    const row: CrmActivityRow = {
      id: 'a1', guest_id: 'g1', activity_type: 'weird', segment_key: null,
      note: null, due_date: null, status: 'bogus', contacted_on: null,
      batch_id: null, created_by: null, completed_at: null, created_at: 'x',
    };
    const a = rowToCrmActivity(row);
    expect(a.activityType).toBe('note');
    expect(a.status).toBeNull();
  });
});

describe('rowToContactList', () => {
  it('filtert guest_ids auf Strings, member_count Fallback', () => {
    const row: ContactListRow = {
      id: 'l1', name: 'VIP', segment_key: 'vip',
      guest_ids: ['g1', 2, null, 'g2'], member_count: null,
      created_by: 'op', created_at: 'x',
    };
    const l = rowToContactList(row);
    expect(l.guestIds).toEqual(['g1', 'g2']);
    expect(l.memberCount).toBe(2);
  });

  it('guest_ids kein Array → leer', () => {
    const row: ContactListRow = {
      id: 'l1', name: 'X', segment_key: null, guest_ids: 'nope',
      member_count: 5, created_by: null, created_at: 'x',
    };
    const l = rowToContactList(row);
    expect(l.guestIds).toEqual([]);
    expect(l.memberCount).toBe(5);
  });
});

describe('splitActivitiesByType / Sortierung', () => {
  function act(partial: Partial<CrmActivity>): CrmActivity {
    return {
      id: 'x', guestId: 'g1', activityType: 'note', segmentKey: null, note: null,
      dueDate: null, status: null, contactedOn: null, batchId: null, createdBy: null,
      completedAt: null, createdAt: '2026-01-01T00:00:00Z', ...partial,
    };
  }

  it('teilt nach Typ auf', () => {
    const split = splitActivitiesByType([
      act({ id: 'c', activityType: 'contacted', contactedOn: '2026-06-01' }),
      act({ id: 'n', activityType: 'note' }),
      act({ id: 'f', activityType: 'follow_up', dueDate: '2026-07-01', status: 'open' }),
    ]);
    expect(split.contacted.map(a => a.id)).toEqual(['c']);
    expect(split.notes.map(a => a.id)).toEqual(['n']);
    expect(split.followUps.map(a => a.id)).toEqual(['f']);
  });

  it('follow_up-Sortierung: offene zuerst, dann nach Fälligkeit', () => {
    const a = act({ id: 'done', activityType: 'follow_up', status: 'done', dueDate: '2026-06-01' });
    const b = act({ id: 'open-late', activityType: 'follow_up', status: 'open', dueDate: '2026-08-01' });
    const c = act({ id: 'open-early', activityType: 'follow_up', status: 'open', dueDate: '2026-07-01' });
    const sorted = [a, b, c].sort(sortFollowUps);
    expect(sorted.map(x => x.id)).toEqual(['open-early', 'open-late', 'done']);
  });
});

describe('Beschriftungen', () => {
  it('Labels vollständig', () => {
    expect(ACTIVITY_TYPE_LABEL.contacted).toBeTruthy();
    expect(ACTIVITY_TYPE_LABEL.note).toBeTruthy();
    expect(ACTIVITY_TYPE_LABEL.follow_up).toBeTruthy();
    expect(FOLLOW_UP_STATUS_LABEL.open).toBeTruthy();
    expect(FOLLOW_UP_STATUS_LABEL.done).toBeTruthy();
  });
});
