// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ProductSalesRow } from '../sales-db';
import {
  buildBreakdown,
  filterRows,
  aggregateProducts,
  aggregateProductsByWeekday,
  periodBounds,
  isoWeekInfo,
  isoWeekStart,
  isoWeeksInYear,
  shiftIsoWeek,
  weekRangeLabel,
  daysInMonth,
  filtersToParams,
  filtersFromParams,
  type PeriodSelection,
  type AnalysisFilters,
} from '../product-analytics';

// ─── Test-Fixtures (synthetisch, keine PII) ─────────────────────────────────────

function row(
  product_name: string,
  sale_date: string,
  quantity: number,
  revenue: number,
  source: string | null = 'food_csv_export',
): ProductSalesRow {
  return { product_name, sale_date, quantity, revenue, source, import_batch: 'b1' };
}

// ─── ISO-Kalenderwoche ──────────────────────────────────────────────────────────

describe('ISO week helpers', () => {
  it('Jan 4 is always in week 1', () => {
    expect(isoWeekInfo('2021-01-04')).toEqual({ year: 2021, week: 1 });
    expect(isoWeekInfo('2026-01-04')).toEqual({ year: 2026, week: 1 });
  });

  it('handles year boundaries (W53 / W01 carry-over)', () => {
    // 2021-01-03 (Sunday) belongs to ISO week 53 of 2020
    expect(isoWeekInfo('2021-01-03')).toEqual({ year: 2020, week: 53 });
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2021)).toBe(52);
  });

  it('isoWeekStart returns the Monday and round-trips with isoWeekInfo', () => {
    // ISO week 1 of 2026 starts on Mon 2025-12-29 (cross-year week)
    const monday = isoWeekStart(2026, 1);
    expect(monday.getUTCFullYear()).toBe(2025);
    expect(monday.getUTCMonth() + 1).toBe(12);
    expect(monday.getUTCDate()).toBe(29);
    expect(monday.getUTCDay()).toBe(1); // Monday

    for (const d of ['2024-02-29', '2026-06-15', '2020-12-31', '2026-01-01']) {
      const info = isoWeekInfo(d);
      const start = isoWeekStart(info.year, info.week);
      const startISO = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
      const end = new Date(start.getTime());
      end.setUTCDate(start.getUTCDate() + 6);
      const endISO = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
      expect(startISO <= d && d <= endISO).toBe(true);
    }
  });
});

// ─── periodBounds ───────────────────────────────────────────────────────────────

describe('periodBounds', () => {
  it('day', () => {
    expect(periodBounds({ kind: 'day', date: '2026-06-15' })).toEqual({
      from: '2026-06-15', to: '2026-06-15',
    });
  });
  it('month (June has 30 days, Feb 2024 leap = 29)', () => {
    expect(periodBounds({ kind: 'month', year: 2026, month: 6 })).toEqual({
      from: '2026-06-01', to: '2026-06-30',
    });
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(periodBounds({ kind: 'month', year: 2024, month: 2 })).toEqual({
      from: '2024-02-01', to: '2024-02-29',
    });
  });
  it('year', () => {
    expect(periodBounds({ kind: 'year', year: 2026 })).toEqual({
      from: '2026-01-01', to: '2026-12-31',
    });
  });
  it('week spans Monday..Sunday (cross-year)', () => {
    expect(periodBounds({ kind: 'week', year: 2026, week: 1 })).toEqual({
      from: '2025-12-29', to: '2026-01-04',
    });
  });
});

// ─── filterRows / aggregateProducts ─────────────────────────────────────────────

describe('filterRows + aggregateProducts', () => {
  const rows = [
    row('Cola', '2026-06-10', 2, 10, 'beverage_csv_export'),
    row('Cola', '2026-06-20', 3, 15, 'beverage_csv_export'),
    row('Burger', '2026-06-10', 1, 20, 'food_csv_export'),
    row('Burger', '2026-07-01', 5, 100, 'food_csv_export'), // out of June
  ];

  it('respects period bounds', () => {
    const f = filterRows(rows, { kind: 'month', year: 2026, month: 6 }, 'all');
    expect(f).toHaveLength(3);
    expect(f.every((r) => r.sale_date.startsWith('2026-06'))).toBe(true);
  });

  it('respects category filter', () => {
    const f = filterRows(rows, { kind: 'month', year: 2026, month: 6 }, 'beverage');
    expect(f).toHaveLength(2);
    expect(f.every((r) => r.product_name === 'Cola')).toBe(true);
  });

  it('aggregates per product', () => {
    const f = filterRows(rows, { kind: 'month', year: 2026, month: 6 }, 'all');
    const agg = aggregateProducts(f).sort((a, b) => b.total_revenue - a.total_revenue);
    expect(agg).toEqual([
      { product_name: 'Cola', total_revenue: 25, total_qty: 5 },
      { product_name: 'Burger', total_revenue: 20, total_qty: 1 },
    ]);
  });
});

// ─── Monthly drill-down ─────────────────────────────────────────────────────────

describe('buildBreakdown — monthly (row per day)', () => {
  const sel: PeriodSelection = { kind: 'month', year: 2026, month: 6 };
  const rows = [
    row('Cola', '2026-06-01', 2, 10),
    row('Cola', '2026-06-15', 4, 30),
    row('Cola', '2026-06-30', 1, 10),
    row('Cola', '2026-07-01', 9, 999), // outside June → ignored
    row('Pizza', '2026-06-15', 8, 80), // other product → ignored
  ];

  it('produces one row per day incl. zero days', () => {
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'revenue');
    expect(b.rows).toHaveLength(30);
    expect(b.totalRevenue).toBe(50);
    expect(b.totalQty).toBe(7);
    expect(b.salesCount).toBe(3);
    expect(b.avgRevenuePerSale).toBeCloseTo(50 / 3);
  });

  it('places values on the correct day and computes share + avgPrice', () => {
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'revenue');
    const d15 = b.rows.find((r) => r.date === '2026-06-15')!;
    expect(d15.revenue).toBe(30);
    expect(d15.quantity).toBe(4);
    expect(d15.share).toBeCloseTo(30 / 50);
    expect(d15.avgPrice).toBeCloseTo(30 / 4);
    const d02 = b.rows.find((r) => r.date === '2026-06-02')!;
    expect(d02.revenue).toBe(0);
    expect(d02.avgPrice).toBeNull();
    // shares of non-zero days sum to ~1
    const sum = b.rows.reduce((s, r) => s + r.share, 0);
    expect(sum).toBeCloseTo(1);
  });

  it('quantity metric drives the share column', () => {
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'qty');
    const d15 = b.rows.find((r) => r.date === '2026-06-15')!;
    expect(d15.share).toBeCloseTo(4 / 7);
  });
});

// ─── Weekly drill-down ──────────────────────────────────────────────────────────

describe('buildBreakdown — weekly (row per weekday)', () => {
  // ISO week 2 of 2026 = Mon 2026-01-05 .. Sun 2026-01-11
  const sel: PeriodSelection = { kind: 'week', year: 2026, week: 2 };

  it('produces 7 weekday rows Mon..Sun with correct placement', () => {
    const rows = [
      row('Cola', '2026-01-05', 1, 5), // Monday
      row('Cola', '2026-01-07', 2, 12), // Wednesday
      row('Cola', '2026-01-11', 3, 9), // Sunday
      row('Cola', '2026-01-12', 9, 99), // next week → ignored
    ];
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'revenue');
    expect(b.rows).toHaveLength(7);
    expect(b.rows[0].label).toBe('Montag');
    expect(b.rows[6].label).toBe('Sonntag');
    expect(b.rows[0].revenue).toBe(5);   // Mon
    expect(b.rows[2].revenue).toBe(12);  // Wed
    expect(b.rows[6].revenue).toBe(9);   // Sun
    expect(b.rows[1].revenue).toBe(0);   // Tue (empty)
    expect(b.totalRevenue).toBe(26);
    expect(b.totalQty).toBe(6);
  });
});

// ─── Yearly drill-down ──────────────────────────────────────────────────────────

describe('buildBreakdown — yearly (row per month)', () => {
  const sel: PeriodSelection = { kind: 'year', year: 2026 };

  it('produces 12 month rows with correct placement', () => {
    const rows = [
      row('Cola', '2026-01-10', 1, 100),
      row('Cola', '2026-06-20', 2, 200),
      row('Cola', '2026-12-05', 3, 300),
      row('Cola', '2025-12-31', 9, 999), // other year → ignored
    ];
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'revenue');
    expect(b.rows).toHaveLength(12);
    expect(b.rows[0].label).toBe('Januar');
    expect(b.rows[11].label).toBe('Dezember');
    expect(b.rows[0].revenue).toBe(100);  // Jan
    expect(b.rows[5].revenue).toBe(200);  // Jun
    expect(b.rows[11].revenue).toBe(300); // Dez
    expect(b.rows[1].revenue).toBe(0);    // Feb empty
    expect(b.totalRevenue).toBe(600);
  });
});

// ─── Day drill-down ─────────────────────────────────────────────────────────────

describe('buildBreakdown — day (entries / grouped per source)', () => {
  const sel: PeriodSelection = { kind: 'day', date: '2026-06-15' };
  const rows = [
    row('Combo', '2026-06-15', 4, 40, 'food_csv_export'),
    row('Combo', '2026-06-15', 6, 30, 'beverage_csv_export'),
    row('Combo', '2026-06-16', 9, 99, 'food_csv_export'), // other day → ignored
  ];

  it('lists one row per source entry, sorted by metric', () => {
    const b = buildBreakdown(rows, 'Combo', sel, 'all', 'revenue');
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0].source).toBe('food_csv_export'); // higher revenue first
    expect(b.rows[0].revenue).toBe(40);
    expect(b.totalRevenue).toBe(70);
    expect(b.totalQty).toBe(10);
  });

  it('respects category filter on the day', () => {
    const b = buildBreakdown(rows, 'Combo', sel, 'beverage', 'revenue');
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].source).toBe('beverage_csv_export');
    expect(b.totalRevenue).toBe(30);
  });
});

// ─── Tenant / scope isolation ───────────────────────────────────────────────────

describe('tenant / scope isolation (boundary-faithful)', () => {
  // The pure layer never reaches global state. Whoever passes a tenant-scoped row set
  // gets a tenant-scoped result — identical contract to loadProductSalesRows().
  const sel: PeriodSelection = { kind: 'month', year: 2026, month: 6 };

  it('computing on one tenant never includes another tenant', () => {
    const tenantA: ProductSalesRow[] = [
      row('Cola', '2026-06-10', 1, 10),
      row('Cola', '2026-06-11', 1, 10),
    ];
    const tenantB: ProductSalesRow[] = [
      row('Cola', '2026-06-10', 99, 9999), // same product name, different tenant data
    ];

    const a = buildBreakdown(tenantA, 'Cola', sel, 'all', 'revenue');
    expect(a.totalRevenue).toBe(20);
    expect(a.totalQty).toBe(2);
    // tenant B's huge numbers must not leak into A's result
    expect(a.totalRevenue).not.toBe(9999 + 20);

    const b = buildBreakdown(tenantB, 'Cola', sel, 'all', 'revenue');
    expect(b.totalRevenue).toBe(9999);
  });

  it('does not bleed across products', () => {
    const rows = [
      row('Cola', '2026-06-10', 1, 10),
      row('Pizza', '2026-06-10', 1, 500),
    ];
    const b = buildBreakdown(rows, 'Cola', sel, 'all', 'revenue');
    expect(b.totalRevenue).toBe(10);
  });
});

// ─── Empty data ─────────────────────────────────────────────────────────────────

describe('buildBreakdown — empty data', () => {
  it('monthly: zero-filled rows, zero totals', () => {
    const b = buildBreakdown([], 'Ghost', { kind: 'month', year: 2026, month: 2 }, 'all', 'revenue');
    expect(b.rows).toHaveLength(28); // Feb 2026
    expect(b.totalRevenue).toBe(0);
    expect(b.totalQty).toBe(0);
    expect(b.salesCount).toBe(0);
    expect(b.avgRevenuePerSale).toBe(0);
    expect(b.rows.every((r) => r.revenue === 0 && r.quantity === 0 && r.share === 0 && r.avgPrice === null)).toBe(true);
  });

  it('weekly empty → 7 zero rows', () => {
    const b = buildBreakdown([], 'Ghost', { kind: 'week', year: 2026, week: 2 }, 'all', 'revenue');
    expect(b.rows).toHaveLength(7);
    expect(b.totalRevenue).toBe(0);
  });

  it('yearly empty → 12 zero rows', () => {
    const b = buildBreakdown([], 'Ghost', { kind: 'year', year: 2026 }, 'all', 'revenue');
    expect(b.rows).toHaveLength(12);
  });

  it('day empty → no rows', () => {
    const b = buildBreakdown([], 'Ghost', { kind: 'day', date: '2026-06-15' }, 'all', 'revenue');
    expect(b.rows).toHaveLength(0);
    expect(b.totalRevenue).toBe(0);
  });
});

// ─── URL serialize / parse round-trip ───────────────────────────────────────────

describe('filtersToParams / filtersFromParams round-trip', () => {
  const cases: AnalysisFilters[] = [
    { period: { kind: 'day', date: '2026-06-15' }, category: 'food', metric: 'qty' },
    { period: { kind: 'week', year: 2026, week: 23 }, category: 'beverage', metric: 'revenue' },
    { period: { kind: 'month', year: 2025, month: 11 }, category: 'all', metric: 'qty' },
    { period: { kind: 'year', year: 2024 }, category: 'all', metric: 'revenue' },
  ];

  it('round-trips every period kind', () => {
    for (const f of cases) {
      const params = filtersToParams(f);
      const back = filtersFromParams((k) => params[k] ?? null);
      expect(back).toEqual(f);
    }
  });

  it('falls back to month/all/revenue on garbage input', () => {
    const back = filtersFromParams((k) => (k === 'period' ? 'bogus' : null), new Date('2026-06-15T12:00:00Z'));
    expect(back.period.kind).toBe('month');
    expect(back.category).toBe('all');
    expect(back.metric).toBe('revenue');
  });
});

// ─── Wochen-Navigation: weekRangeLabel ──────────────────────────────────────────

describe('weekRangeLabel', () => {
  it('shows the exact Mon–Sun range within a single year (year only on the end date)', () => {
    // KW 26 2026 = Mon 22.06.2026 – Sun 28.06.2026
    expect(weekRangeLabel(2026, 26)).toBe('KW 26 · 22.06.–28.06.2026');
  });

  it('shows the start year on cross-year weeks (KW 1 spanning Dec→Jan)', () => {
    // KW 1 2026 starts Mon 29.12.2025 and ends Sun 04.01.2026
    expect(weekRangeLabel(2026, 1)).toBe('KW 1 · 29.12.2025–04.01.2026');
  });
});

// ─── Wochen-Navigation: shiftIsoWeek ────────────────────────────────────────────

describe('shiftIsoWeek', () => {
  it('steps forward and backward within a year', () => {
    expect(shiftIsoWeek(2026, 26, 1)).toEqual({ year: 2026, week: 27 });
    expect(shiftIsoWeek(2026, 26, -1)).toEqual({ year: 2026, week: 25 });
    expect(shiftIsoWeek(2026, 26, 0)).toEqual({ year: 2026, week: 26 });
  });

  it('rolls across the year boundary (KW1 ↔ previous year)', () => {
    // One week before KW1 2026 is the last week of ISO-year 2025 (KW52)
    expect(shiftIsoWeek(2026, 1, -1)).toEqual({ year: 2025, week: 52 });
    // Forward from the last week of 2025 lands in KW1 2026
    expect(shiftIsoWeek(2025, 52, 1)).toEqual({ year: 2026, week: 1 });
  });

  it('handles 53-week ISO years (2020 has KW53)', () => {
    expect(isoWeeksInYear(2020)).toBe(53);
    // Forward from KW52 2020 → KW53 2020, then → KW1 2021
    expect(shiftIsoWeek(2020, 52, 1)).toEqual({ year: 2020, week: 53 });
    expect(shiftIsoWeek(2020, 53, 1)).toEqual({ year: 2021, week: 1 });
    // Backward from KW1 2021 → KW53 2020
    expect(shiftIsoWeek(2021, 1, -1)).toEqual({ year: 2020, week: 53 });
  });

  it('multi-week jumps stay consistent with single steps', () => {
    expect(shiftIsoWeek(2026, 10, 5)).toEqual({ year: 2026, week: 15 });
    // KW3 2026 −5 weeks: KW2 → KW1 2026 → KW52 → KW51 → KW50 2025
    expect(shiftIsoWeek(2026, 3, -5)).toEqual({ year: 2025, week: 50 });
    // equivalent to stepping back one at a time
    let cur = { year: 2026, week: 3 };
    for (let i = 0; i < 5; i++) cur = shiftIsoWeek(cur.year, cur.week, -1);
    expect(cur).toEqual({ year: 2025, week: 50 });
  });
});

// ─── Wochen-Rangliste: aggregateProductsByWeekday ───────────────────────────────

describe('aggregateProductsByWeekday', () => {
  // KW 26 2026 = Mon 22.06. … Sun 28.06.2026
  const YEAR = 2026;
  const WEEK = 26;

  it('places each sale into the correct Mon→Sun bucket and totals it', () => {
    const rows: ProductSalesRow[] = [
      row('Pizza', '2026-06-22', 3, 60),  // Mo
      row('Pizza', '2026-06-24', 2, 40),  // Mi
      row('Pizza', '2026-06-28', 5, 100), // So
    ];
    const [agg] = aggregateProductsByWeekday(rows, YEAR, WEEK);
    expect(agg.product_name).toBe('Pizza');
    expect(agg.days).toHaveLength(7);
    // Mo (idx 0), Mi (idx 2), So (idx 6)
    expect(agg.days[0]).toMatchObject({ weekdayIndex: 0, date: '2026-06-22', quantity: 3, revenue: 60 });
    expect(agg.days[2]).toMatchObject({ weekdayIndex: 2, date: '2026-06-24', quantity: 2, revenue: 40 });
    expect(agg.days[6]).toMatchObject({ weekdayIndex: 6, date: '2026-06-28', quantity: 5, revenue: 100 });
    // empty days stay zeroed
    expect(agg.days[1]).toMatchObject({ quantity: 0, revenue: 0 });
    // totals = sum of all days
    expect(agg.total_qty).toBe(10);
    expect(agg.total_revenue).toBe(200);
  });

  it('sums multiple sales on the same weekday', () => {
    const rows: ProductSalesRow[] = [
      row('Cola', '2026-06-23', 1, 5),
      row('Cola', '2026-06-23', 4, 20),
    ];
    const [agg] = aggregateProductsByWeekday(rows, YEAR, WEEK);
    expect(agg.days[1]).toMatchObject({ weekdayIndex: 1, date: '2026-06-23', quantity: 5, revenue: 25 });
    expect(agg.total_qty).toBe(5);
    expect(agg.total_revenue).toBe(25);
  });

  it('ignores rows outside the ISO week (same weekday, different week)', () => {
    const rows: ProductSalesRow[] = [
      row('Pizza', '2026-06-22', 3, 60),  // Mo of KW26 (in)
      row('Pizza', '2026-06-15', 9, 180), // Mo of KW25 (out)
      row('Pizza', '2026-06-29', 7, 140), // Mo of KW27 (out)
    ];
    const [agg] = aggregateProductsByWeekday(rows, YEAR, WEEK);
    expect(agg.days[0]).toMatchObject({ quantity: 3, revenue: 60 });
    expect(agg.total_qty).toBe(3);
    expect(agg.total_revenue).toBe(60);
  });

  it('keeps products separate and only emits products with in-week sales', () => {
    const rows: ProductSalesRow[] = [
      row('Pizza', '2026-06-22', 1, 20),
      row('Salat', '2026-06-25', 2, 30),
      row('Suppe', '2026-06-15', 9, 90), // outside KW26 → no aggregate
    ];
    const aggs = aggregateProductsByWeekday(rows, YEAR, WEEK);
    const names = aggs.map((a) => a.product_name).sort();
    expect(names).toEqual(['Pizza', 'Salat']);
  });

  it('returns an empty array for no in-week data', () => {
    expect(aggregateProductsByWeekday([], YEAR, WEEK)).toEqual([]);
    expect(aggregateProductsByWeekday([row('X', '2026-06-15', 1, 1)], YEAR, WEEK)).toEqual([]);
  });

  it('day dates align with periodBounds for the same week', () => {
    const { from, to } = periodBounds({ kind: 'week', year: YEAR, week: WEEK });
    const [agg] = aggregateProductsByWeekday([row('P', from, 1, 1)], YEAR, WEEK);
    expect(agg.days[0].date).toBe(from); // Monday
    expect(agg.days[6].date).toBe(to);   // Sunday
  });
});
