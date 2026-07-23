// @vitest-environment node
/**
 * kpi-comments — Monatskommentare (Union-Merge newer-wins, Tombstones,
 * Dirty-Check-No-op, defensives Normalisieren).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeKpiComments,
  mergeKpiComments,
  applyKpiComment,
  getVisibleKpiComment,
  type KpiCommentsBlob,
} from '../kpi-comments';

const T1 = '2026-07-01T10:00:00.000Z';
const T2 = '2026-07-02T10:00:00.000Z';

describe('applyKpiComment', () => {
  it('setzt neuen Kommentar (trim) mit updatedAt/updatedBy', () => {
    const r = applyKpiComment({}, '2026-07', 'umsatz', '  Ferien KW 29  ', T1, 'chef@oliv.ch');
    expect(r.changed).toBe(true);
    expect(r.blob['2026-07'].umsatz).toEqual({
      text: 'Ferien KW 29',
      updatedAt: T1,
      updatedBy: 'chef@oliv.ch',
    });
  });

  it('Dirty-Check: identischer sichtbarer Text ⇒ No-op ohne updatedAt-Bump', () => {
    const blob: KpiCommentsBlob = { '2026-07': { umsatz: { text: 'A', updatedAt: T1 } } };
    const r = applyKpiComment(blob, '2026-07', 'umsatz', ' A ', T2);
    expect(r.changed).toBe(false);
    expect(r.blob).toBe(blob); // Referenz unverändert — nichts schreiben
  });

  it('leerer Text ⇒ Tombstone (deleted + updatedAt-Bump), NIE Hard-Delete', () => {
    const blob: KpiCommentsBlob = { '2026-07': { umsatz: { text: 'A', updatedAt: T1 } } };
    const r = applyKpiComment(blob, '2026-07', 'umsatz', '', T2);
    expect(r.changed).toBe(true);
    expect(r.blob['2026-07'].umsatz.deleted).toBe(true);
    expect(r.blob['2026-07'].umsatz.updatedAt).toBe(T2);
  });

  it('leerer Text ohne sichtbaren Eintrag ⇒ No-op (kein sinnloser Tombstone)', () => {
    expect(applyKpiComment({}, '2026-07', 'umsatz', '', T1).changed).toBe(false);
    const tomb: KpiCommentsBlob = {
      '2026-07': { umsatz: { text: '', updatedAt: T1, deleted: true } },
    };
    expect(applyKpiComment(tomb, '2026-07', 'umsatz', '  ', T2).changed).toBe(false);
  });

  it('Wieder-Setzen nach Tombstone ist eine echte Änderung', () => {
    const tomb: KpiCommentsBlob = {
      '2026-07': { umsatz: { text: '', updatedAt: T1, deleted: true } },
    };
    const r = applyKpiComment(tomb, '2026-07', 'umsatz', 'Neu', T2);
    expect(r.changed).toBe(true);
    expect(r.blob['2026-07'].umsatz).toMatchObject({ text: 'Neu', updatedAt: T2 });
    expect(r.blob['2026-07'].umsatz.deleted).toBeUndefined();
  });
});

describe('mergeKpiComments (Union-Merge newer-wins)', () => {
  it('neuerer Eintrag gewinnt je Monat×KPI; Tombstones nehmen normal teil', () => {
    const local: KpiCommentsBlob = {
      '2026-07': {
        umsatz: { text: 'lokal', updatedAt: T2 },
        gaeste: { text: '', updatedAt: T1, deleted: true },
      },
    };
    const remote: KpiCommentsBlob = {
      '2026-07': {
        umsatz: { text: 'remote-alt', updatedAt: T1 },
        gaeste: { text: 'remote-neu', updatedAt: T2 },
      },
      '2026-06': { ebit: { text: 'nur remote', updatedAt: T1 } },
    };
    const m = mergeKpiComments(local, remote);
    expect(m['2026-07'].umsatz.text).toBe('lokal'); // T2 > T1
    expect(m['2026-07'].gaeste.text).toBe('remote-neu'); // Remote neuer als Tombstone
    expect(m['2026-06'].ebit.text).toBe('nur remote'); // Union: Remote-only bleibt
  });

  it('Tombstone gewinnt, wenn er neuer ist (keine Wiederauferstehung)', () => {
    const local: KpiCommentsBlob = {
      '2026-07': { umsatz: { text: '', updatedAt: T2, deleted: true } },
    };
    const remote: KpiCommentsBlob = {
      '2026-07': { umsatz: { text: 'alt', updatedAt: T1 } },
    };
    const m = mergeKpiComments(local, remote);
    expect(m['2026-07'].umsatz.deleted).toBe(true);
    expect(getVisibleKpiComment(m, '2026-07', 'umsatz')).toBeNull();
  });
});

describe('getVisibleKpiComment', () => {
  it('filtert Tombstones; fehlend ⇒ null', () => {
    const blob: KpiCommentsBlob = {
      '2026-07': {
        umsatz: { text: 'sichtbar', updatedAt: T1 },
        gaeste: { text: '', updatedAt: T1, deleted: true },
      },
    };
    expect(getVisibleKpiComment(blob, '2026-07', 'umsatz')?.text).toBe('sichtbar');
    expect(getVisibleKpiComment(blob, '2026-07', 'gaeste')).toBeNull();
    expect(getVisibleKpiComment(blob, '2026-08', 'umsatz')).toBeNull();
  });
});

describe('normalizeKpiComments (defensiv gegen kaputte Remote-Blobs)', () => {
  it('verwirft Nicht-Objekte, unvollständige Einträge und leere Monate', () => {
    const raw = {
      '2026-07': {
        umsatz: { text: 'ok', updatedAt: T1, updatedBy: 'x@y.z', deleted: false },
        kaputt1: { text: 42, updatedAt: T1 },
        kaputt2: 'string',
      },
      '2026-06': 'kein Objekt',
      '2026-05': { nix: { foo: 'bar' } },
    };
    const n = normalizeKpiComments(raw);
    expect(Object.keys(n)).toEqual(['2026-07']);
    expect(n['2026-07'].umsatz).toEqual({ text: 'ok', updatedAt: T1, updatedBy: 'x@y.z' });
  });

  it('null/Array/String ⇒ leeres Blob', () => {
    expect(normalizeKpiComments(null)).toEqual({});
    expect(normalizeKpiComments([1, 2])).toEqual({});
    expect(normalizeKpiComments('x')).toEqual({});
  });
});
