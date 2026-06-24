// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  IMPORT_CATEGORIES,
  visibleCategories,
  getCategory,
  deriveStatusFromRun,
  deriveStatusFromTimestamp,
  pickLatestRun,
  EMPTY_STATUS,
  UNKNOWN_STATUS,
  STATUS_LABEL,
  STATUS_BADGE_CLASS,
  type ImportAccessContext,
  type RunLike,
} from '../import-center';

// Real app routes the route-cards may point at (from src/App.tsx).
const KNOWN_ROUTES = new Set([
  '/foratable-import',
  '/gastronovi-import',
  '/sales-upload',
  '/warenrechnungen',
  '/wes-analyse',
  '/csv-import',
  '/budget',
]);

const admin: ImportAccessContext = { isAdmin: true, isGuest: false, isBeaulieuManager: false, isBeaulieuViewer: false };
// Guest sessions report isAdmin=true at the hook level but must see NO import launcher.
const guest: ImportAccessContext = { isAdmin: true, isGuest: true, isBeaulieuManager: false, isBeaulieuViewer: false };
const beaulieuMgr: ImportAccessContext = { isAdmin: false, isGuest: false, isBeaulieuManager: true, isBeaulieuViewer: false };
const beaulieuViewer: ImportAccessContext = { isAdmin: false, isGuest: false, isBeaulieuManager: false, isBeaulieuViewer: true };
const noneCtx: ImportAccessContext = { isAdmin: false, isGuest: false, isBeaulieuManager: false, isBeaulieuViewer: false };

describe('IMPORT_CATEGORIES descriptors', () => {
  it('has exactly the 9 expected categories in order', () => {
    expect(IMPORT_CATEGORIES.map((c) => c.id)).toEqual([
      'foratable',
      'gastronovi',
      'produktumsaetze',
      'warenrechnungen',
      'wes',
      'erfolgsrechnung',
      'budget',
      'mitarbeitende',
      'vorjahreswerte',
    ]);
  });

  it('every category has a non-empty label and description', () => {
    for (const c of IMPORT_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('route categories carry a known existing route; inline categories carry an anchor', () => {
    for (const c of IMPORT_CATEGORIES) {
      if (c.kind === 'route') {
        expect(c.route).toBeTruthy();
        expect(KNOWN_ROUTES.has(c.route!)).toBe(true);
        expect(c.anchor).toBeUndefined();
      } else {
        expect(c.anchor).toBeTruthy();
        expect(c.route).toBeUndefined();
      }
    }
  });

  it('maps the two inline imports to the existing ImportHub anchors', () => {
    expect(getCategory('mitarbeitende')?.anchor).toBe('ist-stunden');
    expect(getCategory('vorjahreswerte')?.anchor).toBe('umsatz-vorjahr');
  });
});

describe('visibleCategories — permission filtering mirrors real guards', () => {
  it('guest sessions see NOTHING (isAdmin=true but isGuest) — no import launcher for guests', () => {
    expect(visibleCategories(guest)).toHaveLength(0);
  });

  it('admin sees all 9', () => {
    expect(visibleCategories(admin)).toHaveLength(9);
  });

  it('beaulieu_manager sees only its 3 route imports (no admin-only routes, no inline admin sections)', () => {
    const ids = visibleCategories(beaulieuMgr).map((c) => c.id);
    expect(ids).toEqual(['produktumsaetze', 'warenrechnungen', 'wes']);
    expect(ids).not.toContain('foratable');
    expect(ids).not.toContain('gastronovi');
    expect(ids).not.toContain('erfolgsrechnung');
    expect(ids).not.toContain('budget');
    // The two inline imports live in admin-only sections of the page → hidden for Beaulieu.
    expect(ids).not.toContain('mitarbeitende');
    expect(ids).not.toContain('vorjahreswerte');
  });

  it('beaulieu_viewer sees only Warenrechnungen', () => {
    expect(visibleCategories(beaulieuViewer).map((c) => c.id)).toEqual(['warenrechnungen']);
  });

  it('a role with no import rights (kitchen/service manager) sees none', () => {
    expect(visibleCategories(noneCtx)).toHaveLength(0);
  });
});

describe('status derivation — never invents timestamps', () => {
  it('null run → "none" with null timestamp', () => {
    const s = deriveStatusFromRun(null);
    expect(s.state).toBe('none');
    expect(s.lastImportedAt).toBeNull();
    expect(s.lastImportedBy).toBeNull();
  });

  it('successful run → "imported" with timestamp + operator', () => {
    const run: RunLike = { status: 'success', finished_at: '2026-06-01T10:00:00Z', created_by: 'user-1', record_count: 12 };
    const s = deriveStatusFromRun(run);
    expect(s.state).toBe('imported');
    expect(s.lastImportedAt).toBe('2026-06-01T10:00:00Z');
    expect(s.lastImportedBy).toBe('user-1');
  });

  it('failed run → "attention"', () => {
    const run: RunLike = { status: 'failed', finished_at: '2026-06-02T10:00:00Z', created_by: 'user-1' };
    const s = deriveStatusFromRun(run);
    expect(s.state).toBe('attention');
    expect(s.detail).toBeTruthy();
  });

  it('falls back to created_at when finished_at is missing', () => {
    const run: RunLike = { status: 'success', finished_at: null, created_at: '2026-05-09T08:00:00Z', created_by: null };
    expect(deriveStatusFromRun(run).lastImportedAt).toBe('2026-05-09T08:00:00Z');
  });

  it('deriveStatusFromTimestamp: null → none; value → imported (no operator)', () => {
    expect(deriveStatusFromTimestamp(null).state).toBe('none');
    expect(deriveStatusFromTimestamp(null).lastImportedAt).toBeNull();
    const s = deriveStatusFromTimestamp('2026-06-03T12:00:00Z');
    expect(s.state).toBe('imported');
    expect(s.lastImportedAt).toBe('2026-06-03T12:00:00Z');
    expect(s.lastImportedBy).toBeNull();
  });

  it('EMPTY_STATUS / UNKNOWN_STATUS carry null timestamps', () => {
    expect(EMPTY_STATUS.lastImportedAt).toBeNull();
    expect(UNKNOWN_STATUS.lastImportedAt).toBeNull();
    expect(UNKNOWN_STATUS.state).toBe('unknown');
  });
});

describe('pickLatestRun', () => {
  it('returns null when all inputs are null', () => {
    expect(pickLatestRun([null, null])).toBeNull();
  });

  it('picks the run with the latest finished_at', () => {
    const a: RunLike = { status: 'success', finished_at: '2026-06-01T10:00:00Z', created_by: 'a' };
    const b: RunLike = { status: 'success', finished_at: '2026-06-05T10:00:00Z', created_by: 'b' };
    expect(pickLatestRun([a, null, b])?.created_by).toBe('b');
    expect(pickLatestRun([b, a])?.created_by).toBe('b');
  });
});

describe('label/badge maps cover every state', () => {
  it('STATUS_LABEL and STATUS_BADGE_CLASS have all four states', () => {
    for (const state of ['none', 'imported', 'attention', 'unknown'] as const) {
      expect(STATUS_LABEL[state]).toBeTruthy();
      expect(STATUS_BADGE_CLASS[state]).toBeTruthy();
    }
  });
});
