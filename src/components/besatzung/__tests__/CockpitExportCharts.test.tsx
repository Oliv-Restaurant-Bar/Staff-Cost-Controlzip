// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseControlListXls } from '@/lib/control-list-import';
import type { ControlListTenantState } from '@/lib/control-list-store';
import { CockpitExportCharts } from '@/components/besatzung/CockpitExportCharts';

const mocks = vi.hoisted(() => ({
  loadControlListState: vi.fn(),
  saveControlListState: vi.fn(),
  loadExtraCostPeople: vi.fn(),
  loadActualHoursForMonth: vi.fn(),
  ladeUmsatzTage: vi.fn(),
}));

vi.mock('@/lib/control-list-store', () => ({
  loadControlListState: mocks.loadControlListState,
  saveControlListState: mocks.saveControlListState,
}));
vi.mock('@/lib/extra-cost-people-db', () => ({ loadExtraCostPeople: mocks.loadExtraCostPeople }));
vi.mock('@/lib/supabase-db', () => ({ loadActualHoursForMonth: mocks.loadActualHoursForMonth }));
vi.mock('@/lib/umsatz', () => ({
  ladeUmsatzTage: mocks.ladeUmsatzTage,
  nettoUmsatzTag: (value: number) => value,
}));

const document = parseControlListXls(readFileSync(resolve(
  process.cwd(),
  'src/lib/__tests__/fixtures/control-list-oliv-kw34.xls',
)));

describe('Cockpit Kontrolllisten-Export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadControlListState.mockResolvedValue({
      version: 1,
      document,
      departments: {},
      helperSelections: {},
    } satisfies ControlListTenantState);
    mocks.loadExtraCostPeople.mockResolvedValue([]);
    mocks.loadActualHoursForMonth.mockResolvedValue({});
    mocks.ladeUmsatzTage.mockResolvedValue(new Map());
  });

  it('uses the real OLIV fixture in both export charts without writing production data', async () => {
    const onReadyChange = vi.fn();
    const { getByTestId } = render(<CockpitExportCharts tenantId="oliv" onReadyChange={onReadyChange} />);

    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));

    const charts = getByTestId('cockpit-export-charts');
    expect(charts.textContent).toMatch(/663[,.]3 Std/);
    expect(charts.textContent).toContain('2026-W34');
    expect(charts.querySelectorAll('svg')).toHaveLength(2);
    expect(mocks.saveControlListState).not.toHaveBeenCalled();
  });
});