// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildReservationRunStats,
  buildGuestRunStats,
  latestRunByType,
  rowToImportRun,
  coerceImportType,
  coerceStatus,
  runStatChips,
  IMPORT_TYPE_LABEL,
  type ImportRunRow,
} from '../import-runs';

function row(partial: Partial<ImportRunRow>): ImportRunRow {
  return rowToImportRun({
    id: 'x', restaurant_id: 'oliv', import_type: 'reservations',
    status: 'success', ...partial,
  } as Record<string, unknown>);
}

describe('coerceImportType / coerceStatus', () => {
  it('maps known values and falls back safely', () => {
    expect(coerceImportType('guest_export')).toBe('guest_export');
    expect(coerceImportType('reservations')).toBe('reservations');
    expect(coerceImportType('bogus')).toBe('reservations');
    expect(coerceImportType(undefined)).toBe('reservations');
    expect(coerceStatus('failed')).toBe('failed');
    expect(coerceStatus('success')).toBe('success');
    expect(coerceStatus('weird')).toBe('success');
  });
});

describe('buildReservationRunStats', () => {
  it('normalizes the reservation save result', () => {
    const s = buildReservationRunStats({
      reservationCount: 120, inserted: 100, updated: 20,
      duplicateKeyMerged: 3, skippedRows: 5, newGuests: 40, returningGuests: 80,
    });
    expect(s).toEqual({
      recordCount: 120, inserted: 100, updated: 20, skipped: 5,
      dedupedInCsv: 3, newGuests: 40, returningGuests: 80,
    });
  });

  it('coerces missing/invalid numbers to null', () => {
    const s = buildReservationRunStats({});
    expect(s.recordCount).toBeNull();
    expect(s.inserted).toBeNull();
    expect(s.dedupedInCsv).toBeNull();
  });
});

describe('buildGuestRunStats', () => {
  it('maps outcome and sums skipped = unassignable + errorRows', () => {
    const s = buildGuestRunStats({
      rowsRead: 200, matchedGuests: 150, created: 10, updated: 30,
      conflicts: 7, unassignable: 40, errorRows: 2,
    });
    expect(s.recordCount).toBe(200);
    expect(s.inserted).toBe(10);
    expect(s.updated).toBe(30);
    expect(s.skipped).toBe(42);
    expect(s.dedupedInCsv).toBeNull();
    expect(s.matchedGuests).toBe(150);
    expect(s.unassignable).toBe(40);
    expect(s.conflicts).toBe(7);
  });

  it('treats missing unassignable/errorRows as 0 for skipped', () => {
    const s = buildGuestRunStats({ rowsRead: 5, created: 1 });
    expect(s.skipped).toBe(0);
  });
});

describe('latestRunByType', () => {
  it('picks the newest run per type regardless of input order', () => {
    const rows: ImportRunRow[] = [
      row({ id: 'r-old', import_type: 'reservations', finished_at: '2026-06-01T10:00:00Z' }),
      row({ id: 'g-new', import_type: 'guest_export', finished_at: '2026-06-20T10:00:00Z' }),
      row({ id: 'r-new', import_type: 'reservations', finished_at: '2026-06-15T10:00:00Z' }),
      row({ id: 'g-old', import_type: 'guest_export', finished_at: '2026-05-01T10:00:00Z' }),
    ];
    const latest = latestRunByType(rows);
    expect(latest.reservations?.id).toBe('r-new');
    expect(latest.guest_export?.id).toBe('g-new');
  });

  it('returns null for a type with no runs', () => {
    const latest = latestRunByType([
      row({ id: 'r1', import_type: 'reservations', finished_at: '2026-06-01T10:00:00Z' }),
    ]);
    expect(latest.reservations?.id).toBe('r1');
    expect(latest.guest_export).toBeNull();
  });

  it('falls back to created_at when finished_at is missing', () => {
    const latest = latestRunByType([
      row({ id: 'a', import_type: 'reservations', finished_at: null, created_at: '2026-06-02T00:00:00Z' }),
      row({ id: 'b', import_type: 'reservations', finished_at: null, created_at: '2026-06-09T00:00:00Z' }),
    ]);
    expect(latest.reservations?.id).toBe('b');
  });
});

describe('rowToImportRun', () => {
  it('maps and defends against missing fields', () => {
    const r = rowToImportRun({
      id: 'abc', restaurant_id: 'beaulieu', import_type: 'guest_export',
      status: 'failed', record_count: 12, period_from: '2026-01-01', period_to: '2026-01-31',
      error_message: 'boom', stats_json: { inserted: 1 }, created_by: 'user-1',
      started_at: '2026-06-23T08:00:00Z', finished_at: '2026-06-23T08:01:00Z',
    });
    expect(r.import_type).toBe('guest_export');
    expect(r.status).toBe('failed');
    expect(r.record_count).toBe(12);
    expect(r.stats_json).toEqual({ inserted: 1 });
    expect(r.created_by).toBe('user-1');
  });

  it('coerces a non-object stats_json to null and bad numbers to null', () => {
    const r = rowToImportRun({ id: 'x', stats_json: 'nope', record_count: 'NaN' } as Record<string, unknown>);
    expect(r.stats_json).toBeNull();
    expect(r.record_count).toBeNull();
    expect(r.import_type).toBe('reservations');
    expect(r.status).toBe('success');
  });
});

describe('runStatChips', () => {
  it('shows reservation-specific chips, omitting null values', () => {
    const r = row({
      import_type: 'reservations',
      stats_json: { inserted: 10, updated: 2, skipped: null, dedupedInCsv: 1, newGuests: 4, returningGuests: null },
    });
    const chips = runStatChips(r);
    const labels = chips.map(c => c.label);
    expect(labels).toContain('neu');
    expect(labels).toContain('aktualisiert');
    expect(labels).toContain('CSV-Doppel');
    expect(labels).toContain('neue Gäste');
    expect(labels).not.toContain('übersprungen'); // null skipped omitted
    expect(labels).not.toContain('wiederk.');     // null returning omitted
  });

  it('shows guest-export-specific chips', () => {
    const r = row({
      import_type: 'guest_export',
      stats_json: { matchedGuests: 50, inserted: 5, updated: 9, conflicts: 2, unassignable: 3 },
    });
    const labels = runStatChips(r).map(c => c.label);
    expect(labels).toEqual(['gematcht', 'neu', 'ergänzt', 'Konflikte', 'nicht zugeordnet']);
  });

  it('returns empty when there are no stats', () => {
    expect(runStatChips(row({ stats_json: null }))).toEqual([]);
  });
});

describe('labels', () => {
  it('exposes German type labels', () => {
    expect(IMPORT_TYPE_LABEL.reservations).toBe('Reservationen');
    expect(IMPORT_TYPE_LABEL.guest_export).toBe('Gästeexport');
  });
});
