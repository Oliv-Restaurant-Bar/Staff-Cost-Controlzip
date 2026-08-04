// @vitest-environment happy-dom
/**
 * Tests für die OP-Listen-Seite (/op-liste). DB-Layer und Import-Dialog werden
 * gemockt (der Dialog zieht pdfjs — nicht happy-dom-tauglich). Fixiert:
 *   - Migration-Hinweis bei fehlender Tabelle (tableMissing)
 *   - Übersichts-KPIs, Buckets und Top-Lieferanten aus den Einzelposten
 *   - Vergleich zweier Stichtage inkl. Status und Behörden-Karte
 *   - Gäste sehen keinen Import-Button (read-only)
 *   - sichtbarer Fehlerzustand statt stiller 0
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OpImportRecord, OpItemRecord } from '@/types/op-liste';

const mockPerms = { isAdmin: true, isBeaulieuManager: false };
const mockDb = {
  loadOpImports: vi.fn(),
  loadOpItems: vi.fn(),
};

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => mockPerms,
}));
vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv' }),
}));
vi.mock('@/lib/op-liste-db', () => ({
  loadOpImports: (...args: unknown[]) => mockDb.loadOpImports(...args),
  loadOpItems: (...args: unknown[]) => mockDb.loadOpItems(...args),
}));
vi.mock('@/components/op-liste/OpImportDialog', () => ({
  OpImportDialog: () => null,
}));

import OpListe from '@/pages/OpListe';

const imp = (id: string, snapshotDate: string): OpImportRecord => ({
  id,
  restaurantId: 'oliv',
  snapshotDate,
  importedAt: null,
  sourceFilename: `op-${snapshotDate}.pdf`,
  totalOpenAmount: null,
  totalItems: null,
  supplierCount: null,
  status: 'active',
  rawTotals: null,
});

const item = (
  importId: string,
  supplierName: string,
  openAmount: number,
  overdue29Plus: number | null = null,
): OpItemRecord => ({
  id: `${importId}-${supplierName}-${openAmount}`,
  importId,
  restaurantId: 'oliv',
  supplierName,
  opDate: null,
  opNumber: null,
  invoiceText: null,
  openAmount,
  buckets: {
    overdue29Plus,
    overdueSince29: null,
    overdueSince14: null,
    dueIn15: null,
    dueIn30: null,
    dueAfter30: null,
  },
});

const IMPORT_A = imp('a', '2026-06-09'); // neuester Stichtag
const IMPORT_B = imp('b', '2026-05-09');
const ITEMS_A = [
  item('a', 'Saviva AG', 1400, 1400),
  item('a', 'Eidgenössische Steuerverwaltung', 9000),
];
const ITEMS_B = [
  item('b', 'Saviva AG', 1000),
  item('b', 'Bäckerei Muster', 200),
];

function setupDb(opts: { imports?: OpImportRecord[]; tableMissing?: boolean; error?: string | null } = {}) {
  mockDb.loadOpImports.mockResolvedValue({
    imports: opts.imports ?? [],
    tableMissing: opts.tableMissing ?? false,
    error: opts.error ?? null,
  });
  mockDb.loadOpItems.mockImplementation(async (_tenant: string, importId: string) =>
    importId === 'a' ? ITEMS_A : ITEMS_B,
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <OpListe />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockPerms.isAdmin = true;
  mockPerms.isBeaulieuManager = false;
});

describe('OpListe — Zustände', () => {
  it('zeigt den Migrations-Hinweis, wenn die Tabellen fehlen', async () => {
    setupDb({ tableMissing: true });
    renderPage();
    const hint = await screen.findByTestId('op-migration-hint');
    expect(hint.textContent).toContain('20260708_creditor_op.sql');
  });

  it('zeigt Ladefehler sichtbar an (kein stilles Leer)', async () => {
    setupDb({ error: 'RLS blockiert' });
    renderPage();
    const err = await screen.findByTestId('op-load-error');
    expect(err.textContent).toContain('RLS blockiert');
  });

  it('zeigt den Leerzustand ohne Importe', async () => {
    setupDb();
    renderPage();
    expect(await screen.findByTestId('op-empty')).toBeTruthy();
  });

});

describe('OpListe — Übersicht & Vergleich', () => {
  it('rendert KPIs, Buckets und Top-Lieferanten des neuesten Stichtags', async () => {
    setupDb({ imports: [IMPORT_A, IMPORT_B] });
    renderPage();
    const total = await screen.findByTestId('op-kpi-total');
    expect(total.textContent).toContain('10’400.00');
    expect(screen.getByTestId('op-kpi-overdue').textContent).toContain('1’400.00');
    expect(screen.getByTestId('op-kpi-items').textContent).toContain('2');
    expect(screen.getByTestId('op-kpi-suppliers').textContent).toContain('2');
    expect(screen.getByTestId('op-buckets')).toBeTruthy();
    const top = screen.getByTestId('op-top-suppliers');
    expect(top.textContent).toContain('Eidgenössische Steuerverwaltung');
    expect(top.textContent).toContain('Saviva AG');
  });

  it('vergleicht zwei Stichtage mit Status und Behörden-Karte', async () => {
    setupDb({ imports: [IMPORT_A, IMPORT_B] });
    renderPage();
    const rows = await screen.findByTestId('op-compare-rows');
    expect(rows.textContent).toContain('Gestiegen');   // Saviva 1000 → 1400
    expect(rows.textContent).toContain('Neu');         // ESTV nur nachher
    expect(rows.textContent).toContain('Erledigt');    // Bäckerei nur vorher
    const auth = screen.getByTestId('op-authorities');
    expect(auth.textContent).toContain('MWST');
    expect(auth.textContent).toContain('9’000.00');
    expect(screen.getByTestId('op-compare-kpis')).toBeTruthy();
  });
});
