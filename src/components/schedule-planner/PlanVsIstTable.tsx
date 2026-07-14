import React, { useState, useMemo, useRef, useEffect } from 'react';
import { format, isWeekend } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { resolveDayBreakHours, useShiftConfig } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';
import {
  ChevronDown, ChevronUp, FileText, FileSpreadsheet,
  ArrowUpDown, ArrowUp, ArrowDown, Search, X, Users, Check,
} from 'lucide-react';
import { exportPlanVsIstPDF, exportPlanVsIstExcel, PlanVsIstExportRow } from '@/lib/plan-ist-export';

interface IstEntry {
  hours: number;
  start?: string;
  end?: string;
  absenceType?: string;
}

interface PlanVsIstTableProps {
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, IstEntry>;
  laborCostThreshold?: number;
  activeDepartment?: 'all' | 'service' | 'küche';
}

type RowFilter = 'all' | 'deviation' | 'over' | 'under';
type SortKey = 'name' | 'date' | 'diffHours' | 'diffCost' | 'planHours' | 'istHours';
type SortDir = 'asc' | 'desc';

const ABSENCE_CODES = new Set(['FE', 'K', 'F']);

const calcSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

const isPlanAbsence = (ds: DaySchedule | undefined) =>
  ds ? ABSENCE_CODES.has(ds.frühAbsence ?? '') || ABSENCE_CODES.has(ds.spätAbsence ?? '') : false;

const isIstAbsence = (e: IstEntry | undefined) =>
  e ? ABSENCE_CODES.has(e.absenceType ?? '') : false;

export const PlanVsIstTable: React.FC<PlanVsIstTableProps> = ({
  employees,
  days,
  scheduleData,
  actualHoursData,
  laborCostThreshold = 40,
  activeDepartment,
}) => {
  const { shiftMap } = useShiftConfig();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [open, setOpen] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Multi-select employee filter
  const [selectedEmpIds, setSelectedEmpIds] = useState<Set<string>>(new Set());
  const [dropOpen, setDropOpen] = useState(false);
  const [dropSearch, setDropSearch] = useState('');
  const dropRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const getPlanHours = (empId: string, dateStr: string): number => {
    const ds = scheduleData[`${empId}-${dateStr}`];
    if (!ds) return 0;
    if (isPlanAbsence(ds)) return 0;
    const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
    if (gross === 0 && ds.frühAbsence) {
      const key = Object.keys(shiftMap).find(k => shiftMap[k]?.abbrev === ds.frühAbsence);
      if (key && shiftMap[key].countsToTarget) return shiftMap[key].hours;
    }
    return Math.max(0, gross - resolveDayBreakHours(ds, gross));
  };

  const getIstHours = (empId: string, dateStr: string): number => {
    const entry = actualHoursData[`${empId}-${dateStr}`];
    if (!entry || isIstAbsence(entry)) return 0;
    return entry.hours ?? 0;
  };

  const hasRealIst = (empId: string, dateStr: string): boolean => {
    const e = actualHoursData[`${empId}-${dateStr}`];
    return !!e && !isIstAbsence(e);
  };

  // Build flat rows: one row per (employee × day) that has plan or ist hours
  const allRows = useMemo(() => {
    const rows: {
      emp: Employee;
      day: Date;
      dateStr: string;
      planHours: number;
      istHours: number;
      diffHours: number;
      planCost: number;
      istCost: number;
      diffCost: number;
      hasIst: boolean;
    }[] = [];

    employees.forEach(emp => {
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const ds = scheduleData[`${emp.id}-${dateStr}`];
        if (isPlanAbsence(ds)) return;

        const plan = getPlanHours(emp.id, dateStr);
        const hasIst_ = hasRealIst(emp.id, dateStr);
        const ist = hasIst_ ? getIstHours(emp.id, dateStr) : 0;
        if (plan === 0 && !hasIst_) return;

        const wage = emp.hourlyWage || 0;
        const planCost = plan * wage;
        const istCost = ist * wage;

        rows.push({
          emp,
          day,
          dateStr,
          planHours: plan,
          istHours: ist,
          diffHours: ist - plan,
          planCost,
          istCost,
          diffCost: istCost - planCost,
          hasIst: hasIst_,
        });
      });
    });

    return rows;
  }, [employees, days, scheduleData, actualHoursData]);

  // Unique employees that appear in allRows (for the dropdown list)
  const uniqueEmps = useMemo(() => {
    const seen = new Map<string, Employee>();
    allRows.forEach(r => { if (!seen.has(r.emp.id)) seen.set(r.emp.id, r.emp); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [allRows]);

  const dropFilteredEmps = useMemo(() => {
    const s = dropSearch.trim().toLowerCase();
    return s ? uniqueEmps.filter(e => e.name.toLowerCase().includes(s)) : uniqueEmps;
  }, [uniqueEmps, dropSearch]);

  const filteredRows = useMemo(() => {
    const base = allRows.filter(r => {
      // Employee multi-select
      if (selectedEmpIds.size > 0 && !selectedEmpIds.has(r.emp.id)) return false;
      // Row filter
      if (!r.hasIst) return filter === 'all';
      if (filter === 'deviation') return Math.abs(r.diffHours) > 0.05 || Math.abs(r.diffCost) > 5;
      if (filter === 'over')      return r.diffHours > 0.05 || r.diffCost > 5;
      if (filter === 'under')     return r.diffHours < -0.05 || r.diffCost < -5;
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    base.sort((a, b) => {
      switch (sortKey) {
        case 'name':      return dir * a.emp.name.localeCompare(b.emp.name, 'de');
        case 'date':      return dir * (a.day.getTime() - b.day.getTime());
        case 'diffHours': return dir * (a.diffHours - b.diffHours);
        case 'diffCost':  return dir * (a.diffCost  - b.diffCost);
        case 'planHours': return dir * (a.planHours - b.planHours);
        case 'istHours':  return dir * (a.istHours  - b.istHours);
        default:          return 0;
      }
    });

    return base;
  }, [allRows, filter, sortKey, sortDir, selectedEmpIds]);

  // Summary totals — reflect the current filteredRows selection
  const totals = useMemo(() => {
    const withIst = filteredRows.filter(r => r.hasIst);
    return {
      planH: filteredRows.reduce((s, r) => s + r.planHours, 0),
      istH:  withIst.reduce((s, r) => s + r.istHours,  0),
      diffH: withIst.reduce((s, r) => s + r.diffHours, 0),
      planC: filteredRows.reduce((s, r) => s + r.planCost,  0),
      istC:  withIst.reduce((s, r) => s + r.istCost,   0),
      diffC: withIst.reduce((s, r) => s + r.diffCost,  0),
    };
  }, [filteredRows]);

  const fmtC = (n: number) =>
    n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const sign = (n: number, thr = 0.05) => (n > thr ? '+' : '');
  const diffColor = (val: number, thr = 0.05) =>
    val > thr    ? 'text-red-600 dark:text-red-400'
    : val < -thr ? 'text-green-600 dark:text-green-400'
    : 'text-muted-foreground';

  const FILTERS: { key: RowFilter; label: string }[] = [
    { key: 'all',       label: 'Alle' },
    { key: 'deviation', label: 'Abweichungen' },
    { key: 'over',      label: 'Über Plan' },
    { key: 'under',     label: 'Unter Plan' },
  ];

  const FILTER_LABELS: Record<RowFilter, string> = {
    all: 'Alle', deviation: 'Abweichungen', over: 'Über Plan', under: 'Unter Plan',
  };

  const buildExportRows = (sourceRows: typeof filteredRows): PlanVsIstExportRow[] =>
    sourceRows.map(r => ({
      empName: r.emp.name,
      department: r.emp.department === 'küche' ? 'Küche' : 'Service',
      dateLabel: format(r.day, 'dd.MM.yy'),
      planHours: r.planHours,
      istHours: r.istHours,
      diffHours: r.diffHours,
      planCost: r.planCost,
      istCost: r.istCost,
      diffCost: r.diffCost,
    }));

  const exportOpts = (exportRows: PlanVsIstExportRow[]) => ({
    rows: exportRows,
    title: 'Plan vs. IST Personal',
    periodLabel: days.length === 1
      ? format(days[0], 'EEEE, d. MMMM yyyy', { locale: de })
      : `${format(days[0], 'dd.MM.yyyy')} – ${format(days[days.length - 1], 'dd.MM.yyyy')}`,
    filterLabel: FILTER_LABELS[filter],
    departmentLabel: activeDepartment === 'küche' ? 'Küche' : activeDepartment === 'service' ? 'Service' : 'Alle',
    fileBaseName: `plan-ist-personal-${format(days[0], 'yyyy-MM')}`,
  });

  if (allRows.length === 0) {
    return (
      <div className="mt-6 rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground text-center">
        Keine Vergleichsdaten vorhanden. Importiere IST-Stunden um die Tabelle zu befüllen.
      </div>
    );
  }

  const allSelected = selectedEmpIds.size === 0;
  const selCount    = selectedEmpIds.size;

  const toggleEmp = (id: string) => {
    setSelectedEmpIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll  = () => setSelectedEmpIds(new Set());
  const selectOnly = (id: string) => setSelectedEmpIds(new Set([id]));

  return (
    <div className="mt-6 rounded-lg border overflow-hidden">

      {/* Header */}
      <div className="flex items-center border-b bg-muted/30">
        <button
          className="flex-1 flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
          onClick={() => setOpen(v => !v)}
        >
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Plan vs. IST — Controlling-Tabelle
          </span>
          {open
            ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
        <div className="flex items-center gap-1 pr-2 shrink-0">
          <button
            onClick={() => exportPlanVsIstPDF(exportOpts(buildExportRows(filteredRows)))}
            title="Als PDF exportieren"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 transition-colors"
          >
            <FileText className="h-3 w-3" />PDF
          </button>
          <button
            onClick={() => exportPlanVsIstExcel(exportOpts(buildExportRows(filteredRows)))}
            title="Als Excel exportieren"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:bg-green-50 dark:hover:bg-green-900/20 hover:text-green-700 dark:hover:text-green-400 hover:border-green-400 transition-colors"
          >
            <FileSpreadsheet className="h-3 w-3" />Excel
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Summary bar — reflects current selection */}
          <div className="grid grid-cols-6 gap-0 border-b bg-muted/20 text-center divide-x">
            {[
              { label: 'Plan Std.',  val: totals.planH.toFixed(1), cls: '' },
              { label: 'IST Std.',   val: totals.istH.toFixed(1),  cls: '' },
              { label: 'Diff Std.',  val: `${sign(totals.diffH)}${totals.diffH.toFixed(1)}`, cls: diffColor(totals.diffH) },
              { label: 'Plan CHF',   val: fmtC(totals.planC),       cls: '' },
              { label: 'IST CHF',    val: fmtC(totals.istC),        cls: '' },
              { label: 'Diff CHF',   val: `${sign(totals.diffC, 5)}${fmtC(totals.diffC)}`, cls: diffColor(totals.diffC, 5) },
            ].map(({ label, val, cls }) => (
              <div key={label} className="py-2 px-1">
                <div className="text-[9px] text-muted-foreground uppercase tracking-wide leading-none mb-0.5">{label}</div>
                <div className={cn('text-xs font-bold', cls)}>{val}</div>
              </div>
            ))}
          </div>

          {/* Filter + Employee-picker bar */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-background flex-wrap">
            {/* Row-filter pills */}
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full border transition-colors shrink-0',
                  filter === key
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'text-muted-foreground border-border hover:bg-muted',
                )}
              >
                {label}
              </button>
            ))}

            {/* Multi-select employee picker */}
            <div className="relative ml-2" ref={dropRef}>
              <button
                onClick={() => setDropOpen(v => !v)}
                className={cn(
                  'flex items-center gap-1 h-6 pl-2 pr-1.5 text-[10px] rounded border transition-colors',
                  selCount > 0
                    ? 'bg-primary/10 border-primary text-primary font-semibold'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Users className="h-3 w-3 shrink-0" />
                {selCount === 0
                  ? 'Alle Mitarbeiter'
                  : selCount === 1
                    ? uniqueEmps.find(e => selectedEmpIds.has(e.id))?.name ?? '1 Person'
                    : `${selCount} Mitarbeiter`}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>

              {dropOpen && (
                <div className="absolute left-0 top-7 z-50 w-56 rounded-md border border-border bg-background shadow-lg">
                  {/* Search within dropdown */}
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b">
                    <Search className="h-3 w-3 text-muted-foreground shrink-0" />
                    <input
                      autoFocus
                      type="text"
                      placeholder="Suchen…"
                      value={dropSearch}
                      onChange={e => setDropSearch(e.target.value)}
                      className="flex-1 text-[11px] bg-transparent outline-none placeholder:text-muted-foreground"
                    />
                    {dropSearch && (
                      <button onClick={() => setDropSearch('')}>
                        <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                      </button>
                    )}
                  </div>

                  {/* "Alle" option */}
                  <button
                    onClick={() => { selectAll(); setDropOpen(false); }}
                    className={cn(
                      'w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] hover:bg-muted transition-colors',
                      allSelected ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                      allSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-border',
                    )}>
                      {allSelected && <Check className="h-2.5 w-2.5" />}
                    </span>
                    Alle Mitarbeiter
                  </button>

                  <div className="max-h-48 overflow-y-auto border-t">
                    {dropFilteredEmps.map(emp => {
                      const checked = selectedEmpIds.has(emp.id);
                      return (
                        <div
                          key={emp.id}
                          className="flex items-center gap-2 px-2.5 py-1 hover:bg-muted transition-colors group"
                        >
                          {/* Checkbox */}
                          <button
                            onClick={() => toggleEmp(emp.id)}
                            className={cn(
                              'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors',
                              checked ? 'bg-primary border-primary text-primary-foreground' : 'border-border',
                            )}
                          >
                            {checked && <Check className="h-2.5 w-2.5" />}
                          </button>

                          {/* Name — click selects only this person */}
                          <button
                            onClick={() => { selectOnly(emp.id); setDropOpen(false); }}
                            className="flex-1 text-left text-[11px] truncate"
                            title={`Nur ${emp.name} anzeigen`}
                          >
                            {emp.name}
                          </button>

                          {/* Dept badge */}
                          <span className={cn(
                            'text-[9px] px-1 py-0.5 rounded-full font-semibold shrink-0',
                            emp.department === 'küche'
                              ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                              : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
                          )}>
                            {emp.department === 'küche' ? 'K' : 'S'}
                          </span>
                        </div>
                      );
                    })}
                    {dropFilteredEmps.length === 0 && (
                      <p className="py-3 text-center text-[11px] text-muted-foreground">Kein Treffer</p>
                    )}
                  </div>

                  {/* Footer: apply / clear */}
                  {selCount > 0 && (
                    <div className="border-t px-2 py-1.5 flex items-center justify-between">
                      <span className="text-[10px] text-muted-foreground">{selCount} ausgewählt</span>
                      <button
                        onClick={() => { selectAll(); setDropOpen(false); }}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Auswahl zurücksetzen
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
              {filteredRows.length} Einträge
            </span>
          </div>

          {/* Table */}
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-xs min-w-[580px]">
              <thead className="sticky top-0 z-10 bg-background border-b">
                <tr className="text-muted-foreground select-none">
                  {([
                    { key: 'name' as SortKey,      label: 'Mitarbeiter', align: 'left',  cls: 'pl-3 pr-2' },
                    { key: null,                   label: 'Abt.',        align: 'left',  cls: 'px-1' },
                    { key: 'date' as SortKey,      label: 'Datum',       align: 'left',  cls: 'px-1' },
                    { key: 'planHours' as SortKey, label: 'Plan Std.',   align: 'right', cls: 'px-1' },
                    { key: 'istHours' as SortKey,  label: 'IST Std.',    align: 'right', cls: 'px-1' },
                    { key: 'diffHours' as SortKey, label: 'Diff Std.',   align: 'right', cls: 'px-1' },
                    { key: null,                   label: 'Plan CHF',    align: 'right', cls: 'px-1' },
                    { key: null,                   label: 'IST CHF',     align: 'right', cls: 'px-1' },
                    { key: 'diffCost' as SortKey,  label: 'Diff CHF',    align: 'right', cls: 'pr-3 px-1' },
                  ] as { key: SortKey | null; label: string; align: string; cls: string }[]).map(col => (
                    <th
                      key={col.label}
                      className={cn(
                        'py-2 font-semibold',
                        col.cls,
                        col.align === 'right' ? 'text-right' : 'text-left',
                        col.key ? 'cursor-pointer hover:text-foreground hover:bg-muted/40 transition-colors' : '',
                        col.key && sortKey === col.key ? 'text-foreground' : '',
                      )}
                      onClick={() => col.key && toggleSort(col.key)}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {col.label}
                        {col.key && (
                          sortKey === col.key
                            ? sortDir === 'asc'
                              ? <ArrowUp className="h-3 w-3 text-primary" />
                              : <ArrowDown className="h-3 w-3 text-primary" />
                            : <ArrowUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-6 text-center text-muted-foreground text-xs">
                      Keine Einträge für diesen Filter.
                    </td>
                  </tr>
                ) : filteredRows.map((r, idx) => {
                  const isKüche = r.emp.department === 'küche';
                  const weekendDay = isWeekend(r.day);
                  return (
                    <tr
                      key={`${r.emp.id}-${r.dateStr}`}
                      className={cn(
                        'border-b last:border-0 transition-colors',
                        idx % 2 === 0 ? 'bg-background' : 'bg-muted/20',
                        weekendDay && 'bg-amber-50/40 dark:bg-amber-900/10',
                      )}
                    >
                      <td className="py-1.5 pl-3 pr-2 font-medium whitespace-nowrap">{r.emp.name}</td>
                      <td className="py-1.5 px-1">
                        <span className={cn(
                          'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                          isKüche
                            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                            : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
                        )}>
                          {isKüche ? 'Küche' : 'Service'}
                        </span>
                      </td>
                      <td className="py-1.5 px-1 text-muted-foreground whitespace-nowrap">
                        {format(r.day, 'EE dd.MM.', { locale: de })}
                      </td>
                      <td className="py-1.5 px-1 text-right tabular-nums">{r.planHours.toFixed(1)}</td>
                      <td className="py-1.5 px-1 text-right tabular-nums">
                        {r.hasIst ? r.istHours.toFixed(1) : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className={cn(
                        'py-1.5 px-1 text-right font-semibold tabular-nums',
                        r.hasIst ? diffColor(r.diffHours) : 'text-muted-foreground',
                      )}>
                        {r.hasIst ? `${sign(r.diffHours)}${r.diffHours.toFixed(1)}` : '–'}
                      </td>
                      <td className="py-1.5 px-1 text-right tabular-nums">{fmtC(r.planCost)}</td>
                      <td className="py-1.5 px-1 text-right tabular-nums">
                        {r.hasIst ? fmtC(r.istCost) : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className={cn(
                        'py-1.5 pr-3 text-right font-semibold tabular-nums',
                        r.hasIst ? diffColor(r.diffCost, 5) : 'text-muted-foreground',
                      )}>
                        {r.hasIst ? `${sign(r.diffCost, 5)}${fmtC(r.diffCost)}` : '–'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Total row for visible rows */}
              {filteredRows.length > 1 && (
                <tfoot className="border-t-2 bg-muted/40 sticky bottom-0">
                  <tr className="font-bold">
                    <td className="py-2 pl-3 pr-2 text-xs">
                      Total
                      {selCount > 0 && (
                        <span className="ml-1 font-normal text-muted-foreground text-[10px]">
                          ({selCount} {selCount === 1 ? 'Person' : 'Personen'})
                        </span>
                      )}
                    </td>
                    <td colSpan={2} className="py-2 px-1" />
                    <td className="py-2 px-1 text-right tabular-nums">
                      {filteredRows.reduce((s, r) => s + r.planHours, 0).toFixed(1)}
                    </td>
                    <td className="py-2 px-1 text-right tabular-nums">
                      {filteredRows.filter(r => r.hasIst).reduce((s, r) => s + r.istHours, 0).toFixed(1)}
                    </td>
                    {(() => {
                      const d = filteredRows.filter(r => r.hasIst).reduce((s, r) => s + r.diffHours, 0);
                      return (
                        <td className={cn('py-2 px-1 text-right tabular-nums', diffColor(d))}>
                          {sign(d)}{d.toFixed(1)}
                        </td>
                      );
                    })()}
                    <td className="py-2 px-1 text-right tabular-nums">
                      {fmtC(filteredRows.reduce((s, r) => s + r.planCost, 0))}
                    </td>
                    <td className="py-2 px-1 text-right tabular-nums">
                      {fmtC(filteredRows.filter(r => r.hasIst).reduce((s, r) => s + r.istCost, 0))}
                    </td>
                    {(() => {
                      const d = filteredRows.filter(r => r.hasIst).reduce((s, r) => s + r.diffCost, 0);
                      return (
                        <td className={cn('py-2 pr-3 text-right tabular-nums', diffColor(d, 5))}>
                          {sign(d, 5)}{fmtC(d)}
                        </td>
                      );
                    })()}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
};
