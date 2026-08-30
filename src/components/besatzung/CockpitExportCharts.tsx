import { useEffect, useMemo, useState } from 'react';
import type { TenantId } from '@/contexts/TenantContext';
import { loadControlListState, type ControlListTenantState } from '@/lib/control-list-store';
import {
  aggregateProductivityDays,
  aggregateProductivityWeeks,
  lastFiveProductivityWeeks,
  PRODUCTIVITY_BUDGET_CHF_PER_HOUR,
  type ProductivityDay,
  type ProductivityWeek,
} from '@/lib/control-list-productivity';
import { ladeUmsatzTage, nettoUmsatzTag } from '@/lib/umsatz';
import { loadExtraCostPeople } from '@/lib/extra-cost-people-db';
import { loadActualHoursForMonth, loadEmployees } from '@/lib/supabase-db';
import type { ActualHourEntry } from '@/lib/supabase-db';

const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const CHF = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

function mondayFor(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, amount: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-15T12:00:00`);
  const end = to.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('de-CH', { maximumFractionDigits: 1 })} Std`;
}

function dayLabel(date: string): string {
  return `${DAY_NAMES[(new Date(`${date}T12:00:00`).getDay() + 6) % 7]} ${date.slice(8)}`;
}

function DailyDiagram({ days }: { days: ProductivityDay[] }) {
  const width = 1080;
  const height = 310;
  const left = 58;
  const right = 48;
  const top = 36;
  const bottom = 52;
  const plotH = height - top - bottom;
  const plotW = width - left - right;
  const maxRevenue = Math.max(1, ...days.map(day => day.revenue ?? 0));
  const maxProductivity = Math.max(PRODUCTIVITY_BUDGET_CHF_PER_HOUR * 1.15, ...days.map(day => day.productivity ?? 0));
  const x = (index: number) => left + plotW * ((index + 0.5) / 7);
  const revenueY = (value: number) => top + plotH - (value / maxRevenue) * plotH;
  const productivityY = (value: number) => top + plotH - (value / maxProductivity) * plotH;
  const linePoints = days.map((day, index) => day.productivity === undefined
    ? null : `${x(index)},${productivityY(day.productivity)}`)
    .filter((point): point is string => point !== null).join(' ');

  return <section className="border border-slate-300 rounded-lg p-4 bg-white">
    <div className="flex items-baseline justify-between mb-2">
      <div>
        <h2 className="text-base font-bold text-slate-900">Produktivität pro Tag</h2>
        <p className="text-xs text-slate-500">Umsatz netto · Besatzung · Zielwert CHF {PRODUCTIVITY_BUDGET_CHF_PER_HOUR}/Std</p>
      </div>
      <span className="text-xs font-semibold text-slate-600">Montag – Sonntag</span>
    </div>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Produktivität pro Tag">
      {[0, 0.5, 1].map(tick => <line key={tick} x1={left} x2={width - right} y1={top + plotH * (1 - tick)} y2={top + plotH * (1 - tick)} stroke="#e2e8f0" />)}
      <line x1={left} x2={width - right} y1={productivityY(PRODUCTIVITY_BUDGET_CHF_PER_HOUR)} y2={productivityY(PRODUCTIVITY_BUDGET_CHF_PER_HOUR)} stroke="#b7791f" strokeWidth="1.5" strokeDasharray="5 4" />
      <text x={width - right} y={productivityY(PRODUCTIVITY_BUDGET_CHF_PER_HOUR) - 5} textAnchor="end" fontSize="11" fill="#925f10">Budget 100 CHF/Std</text>
      {days.map((day, index) => {
        const barW = Math.min(72, plotW / 10);
        const revenue = day.revenue ?? 0;
        const y = revenueY(revenue);
        return <g key={day.date}>
          {day.revenue !== undefined && <rect x={x(index) - barW / 2} y={y} width={barW} height={top + plotH - y} rx="3" fill="#d4a72c" />}
          {day.revenue !== undefined && <text x={x(index)} y={Math.max(top + 11, y - 5)} textAnchor="middle" fontSize="10" fill="#5f4a0b">{CHF.format(revenue)}</text>}
          <text x={x(index)} y={height - 29} textAnchor="middle" fontSize="12" fontWeight="600" fill="#334155">{dayLabel(day.date)}</text>
          <text x={x(index)} y={height - 13} textAnchor="middle" fontSize="11" fill="#475569">{fmtHours(day.netHours)}</text>
        </g>;
      })}
      {linePoints && <polyline points={linePoints} fill="none" stroke="#0f766e" strokeWidth="2.5" />}
      {days.map((day, index) => day.productivity === undefined ? null : <g key={`${day.date}-point`}>
        <circle cx={x(index)} cy={productivityY(day.productivity)} r="4.5" fill={day.meetsBudget ? '#15803d' : '#c2410c'} stroke="white" strokeWidth="2" />
        <text x={x(index)} y={productivityY(day.productivity) - 9} textAnchor="middle" fontSize="10" fontWeight="600" fill="#0f172a">{CHF.format(day.productivity)}</text>
      </g>)}
    </svg>
  </section>;
}

function WeeklyDiagram({ weeks, latestWeek }: { weeks: ProductivityWeek[]; latestWeek: string }) {
  const width = 1080;
  const height = 300;
  const left = 58;
  const right = 48;
  const top = 36;
  const bottom = 44;
  const plotH = height - top - bottom;
  const plotW = width - left - right;
  const maxHours = Math.max(1, ...weeks.map(week => week.netHours));
  const maxRevenue = Math.max(1, ...weeks.map(week => week.revenue ?? 0));
  const x = (index: number) => left + plotW * ((index + 0.5) / Math.max(weeks.length, 1));
  const hoursY = (value: number) => top + plotH - (value / maxHours) * plotH;
  const revenueY = (value: number) => top + plotH - (value / maxRevenue) * plotH;
  const revenuePoints = weeks.map((week, index) => week.revenue === undefined
    ? null : `${x(index)},${revenueY(week.revenue)}`)
    .filter((point): point is string => point !== null).join(' ');

  return <section className="border border-slate-300 rounded-lg p-4 bg-white">
    <div className="flex items-baseline justify-between mb-2">
      <div>
        <h2 className="text-base font-bold text-slate-900">Wochenverlauf</h2>
        <p className="text-xs text-slate-500">Besatzungsstunden · Umsatz netto · Produktivität</p>
      </div>
      <span className="text-xs text-slate-500">Bis zu fünf Kalenderwochen</span>
    </div>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Produktivität im Wochenverlauf">
      {[0, 0.5, 1].map(tick => <line key={tick} x1={left} x2={width - right} y1={top + plotH * (1 - tick)} y2={top + plotH * (1 - tick)} stroke="#e2e8f0" />)}
      {weeks.map((week, index) => {
        const barW = Math.min(105, plotW / Math.max(weeks.length * 1.8, 1));
        const y = hoursY(week.netHours);
        const laufend = week.isoWeek === latestWeek;
        return <g key={week.isoWeek}>
          {laufend && <rect x={x(index) - plotW / weeks.length / 2 + 4} y={top} width={plotW / weeks.length - 8} height={plotH} rx="5" fill="#fef3c7" opacity="0.65" />}
          <rect x={x(index) - barW / 2} y={y} width={barW} height={top + plotH - y} rx="3" fill="#64748b" />
          <text x={x(index)} y={Math.max(top + 12, y - 5)} textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">{fmtHours(week.netHours)}</text>
          <text x={x(index)} y={height - 23} textAnchor="middle" fontSize="12" fontWeight="600" fill="#334155">{week.isoWeek}</text>
          {laufend && <text x={x(index)} y={height - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill="#a16207">laufend</text>}
          {week.productivity !== undefined && <text x={x(index)} y={top + 13} textAnchor="middle" fontSize="11" fontWeight="700" fill={week.meetsBudget ? '#15803d' : '#c2410c'}>{CHF.format(week.productivity)} CHF/Std</text>}
        </g>;
      })}
      {revenuePoints && <polyline points={revenuePoints} fill="none" stroke="#0f766e" strokeWidth="2.5" />}
      {weeks.map((week, index) => week.revenue === undefined ? null : <g key={`${week.isoWeek}-revenue`}>
        <circle cx={x(index)} cy={revenueY(week.revenue)} r="4.5" fill="#0f766e" stroke="white" strokeWidth="2" />
        <text x={x(index)} y={revenueY(week.revenue) - 9} textAnchor="middle" fontSize="10" fill="#0f766e">{CHF.format(week.revenue)}</text>
      </g>)}
    </svg>
  </section>;
}

/** Export-only charts. All data access is read-only and isolated from Dashboard state. */
export function CockpitExportCharts({ tenantId, onReadyChange }: { tenantId: TenantId; onReadyChange?: (ready: boolean) => void }) {
  const [controlState, setControlState] = useState<ControlListTenantState | null>(null);
  const [helperHours, setHelperHours] = useState<Record<string, number>>({});
  const [revenue, setRevenue] = useState<Record<string, number>>({});
  const [stateLoaded, setStateLoaded] = useState(false);
  const [revenueLoaded, setRevenueLoaded] = useState(false);
  const [helpersLoaded, setHelpersLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onReadyChange?.(false);
    setControlState(null);
    setRevenue({});
    setHelperHours({});
    setStateLoaded(false);
    setRevenueLoaded(false);
    setHelpersLoaded(false);
    loadControlListState(tenantId).then(state => { if (!cancelled) setControlState(state); })
      .catch(() => { if (!cancelled) setControlState(null); })
      .finally(() => { if (!cancelled) setStateLoaded(true); });
    return () => { cancelled = true; };
  }, [tenantId, onReadyChange]);

  const range = useMemo(() => {
    const dates = controlState?.document?.employees.flatMap(employee => employee.days.map(day => day.date)) ?? [];
    const latest = dates.sort().at(-1);
    if (!latest) return null;
    const latestMonday = mondayFor(latest);
    return { latestWeek: latestMonday, from: addDays(latestMonday, -28), to: addDays(latestMonday, 6) };
  }, [controlState]);

  useEffect(() => {
    setRevenueLoaded(false);
    if (!range) { setRevenue({}); setRevenueLoaded(true); return; }
    let cancelled = false;
    ladeUmsatzTage(tenantId, range.from, range.to).then(days => {
      if (!cancelled) setRevenue(Object.fromEntries([...days].map(([date, value]) => [date, nettoUmsatzTag(value)])));
    }).catch(() => { if (!cancelled) setRevenue({}); })
      .finally(() => { if (!cancelled) setRevenueLoaded(true); });
    return () => { cancelled = true; };
  }, [range, tenantId]);

  useEffect(() => {
    setHelpersLoaded(false);
    if (!range || !controlState) { setHelperHours({}); setHelpersLoaded(true); return; }
    let cancelled = false;
    (async () => {
      const [helpers, employees, ...actuals] = await Promise.all([
        loadExtraCostPeople(tenantId),
        loadEmployees(tenantId),
        ...monthsBetween(range.from, range.to).map(month => loadActualHoursForMonth(new Date(`${month}-15T12:00:00`), tenantId)),
      ]);
      if (cancelled) return;
      const selected = controlState.helperSelections;
      const merged = Object.assign({}, ...actuals.filter(Boolean)) as Record<string, ActualHourEntry>;
      const controlNames = new Set((controlState.document?.employees ?? []).map(employee =>
        employee.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH')));
      const hours: Record<string, number> = {};
      const employeeIds = new Set((employees ?? []).map(employee => String(employee.id)));
      for (const [key, entry] of Object.entries(merged)) {
        const date = key.slice(-10);
        const employeeId = key.slice(0, -11);
        if (!employeeIds.has(employeeId) || date < range.from || date > range.to) continue;
        if (!entry || entry.absenceType || !(entry.hours > 0)) continue;
        hours[date] = (hours[date] ?? 0) + entry.hours;
      }
      for (const helper of helpers.filter(person =>
        person.isActive
        && !controlNames.has(person.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH')))) {
        for (const [key, enabled] of Object.entries(selected)) {
          const [id, date] = key.split('|');
          if (enabled && id === helper.id && date >= range.from && date <= range.to) {
            hours[date] = (hours[date] ?? 0) + (merged[`${helper.id}-${date}`]?.hours ?? 0);
          }
        }
      }
      setHelperHours(hours);
    })().catch(() => { if (!cancelled) setHelperHours({}); })
      .finally(() => { if (!cancelled) setHelpersLoaded(true); });
    return () => { cancelled = true; };
  }, [controlState, range, tenantId]);

  useEffect(() => {
    onReadyChange?.(stateLoaded && revenueLoaded && helpersLoaded);
  }, [helpersLoaded, onReadyChange, revenueLoaded, stateLoaded]);

  const days = useMemo(() => {
    if (!range) return [];
    const hours = new Map<string, number>();
    for (let i = 0; i < 35; i++) hours.set(addDays(range.from, i), 0);
    for (const [date, value] of Object.entries(helperHours)) hours.set(date, (hours.get(date) ?? 0) + value);
    return aggregateProductivityDays([...hours].map(([date, netHours]) => ({ date, netHours })), revenue);
  }, [helperHours, range, revenue]);
  const weeks = useMemo(() => lastFiveProductivityWeeks(aggregateProductivityWeeks(days)), [days]);
  const latestDays = useMemo(() => range ? days.filter(day => day.date >= range.latestWeek) : [], [days, range]);

  if (!range) return null;
  return <div className="hidden pdf-only mt-6 space-y-4" style={{ width: 1114 }} data-testid="cockpit-export-charts">
    <DailyDiagram days={latestDays} />
    <WeeklyDiagram weeks={weeks} latestWeek={weeks.at(-1)?.isoWeek ?? ''} />
  </div>;
}