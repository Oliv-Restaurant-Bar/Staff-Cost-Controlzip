import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, BarChart3, CalendarDays, Check, ChevronDown, Clock3, FileSpreadsheet, Layers3, RefreshCw, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageShell } from '@/components/layout/PageShell';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { parseControlListXls } from '@/lib/control-list-import';
import type { ControlListDay, ControlListDepartment, ControlListDocument } from '@/lib/control-list-import';
import { departmentForEmployee, loadControlListState, saveControlListState } from '@/lib/control-list-store';
import { mergeControlListHistory } from '@/lib/control-list-history';
import { loadDailyHoursDepartmentSeed } from '@/lib/control-list-department-seed';
import type { ControlListTenantState } from '@/lib/control-list-store';
import { aggregateProductivityDays, aggregateProductivityWeeks, isoWeekForDate, lastFiveProductivityWeeks } from '@/lib/control-list-productivity';
import type { ProductivityDay, ProductivityWeek } from '@/lib/control-list-productivity';
import { ladeUmsatzTage, nettoUmsatzTag } from '@/lib/umsatz';
import { loadExtraCostPeople } from '@/lib/extra-cost-people-db';
import type { ExtraCostPerson } from '@/lib/extra-cost-people-db';
import { loadActualHoursForMonth, loadEmployees } from '@/lib/supabase-db';
import type { Employee } from '@/types/personnel';
import { ProductivityChart } from '@/components/besatzung/ProductivityChart';

type DeptFilter = 'all' | ControlListDepartment;
type Mode = 'productivity' | 'schedule';
type ActualEntry = { hours: number; start?: string; end?: string; absenceType?: string; isAdditionalCost?: boolean };
type HelperDay = { date: string; hours: number };
type HelperHours = { helper: ExtraCostPerson; days: HelperDay[] };
type TimelineRow = { name: string; department?: ControlListDepartment; days: ControlListDay[] };
type ProductivityViewProps = { currentWeek: ProductivityWeek; days: ProductivityDay[]; weeks: ProductivityWeek[]; onSelect: (day: ProductivityDay) => void; selectedDay?: ProductivityDay & Partial<ControlListDay>; filtered: { employee: { name: string }; day: ControlListDay }[]; helperHours?: HelperHours[]; state?: ControlListTenantState };
const fmt = (n: number | undefined, digits = 1) => n === undefined ? '—' : n.toLocaleString('de-CH', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const weekDates = (week: string) => {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return [];
  const year = Number(match[1]);
  const raw = Number(match[2]);
  if (!Number.isInteger(year) || raw < 1 || raw > 53) return [];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (raw - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + i);
    return isoDate(date);
  });
};
const timeLabel = (n: number) => `${String(Math.floor(n % 24)).padStart(2, '0')}:${String(Math.round((n % 1) * 60)).padStart(2, '0')}`;

export default function BesatzungProduktivitaetPage() {
  const { tenantId, tenant } = useTenant();
  const { canManageOperationalData } = usePermissions();
  const [state, setState] = useState<ControlListTenantState | null>(null);
  const [helpers, setHelpers] = useState<ExtraCostPerson[]>([]);
  const [personnel, setPersonnel] = useState<Employee[]>([]);
  const [actual, setActual] = useState<Record<string, ActualEntry>>({});
  const [revenue, setRevenue] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<Mode>('productivity');
  const [dept, setDept] = useState<DeptFilter>('all');
  const [week, setWeek] = useState('');
  const [selectedDay, setSelectedDay] = useState<ProductivityDay & Partial<ControlListDay>>();
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [personPeriod, setPersonPeriod] = useState<'week' | 'month'>('week');
  const [pending, setPending] = useState<ControlListDocument | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const saveQueue = useRef(Promise.resolve());
  const tenantRef = useRef(tenantId);

  useEffect(() => { let alive = true; tenantRef.current = tenantId; setState(null); setHelpers([]); setPersonnel([]); setRevenue({}); setActual({}); setPending(null); setError(''); setSelectedDay(undefined); setSelectedEmployee(''); setWeek(''); Promise.all([loadControlListState(tenantId), loadExtraCostPeople(tenantId), loadEmployees(tenantId)]).then(([loaded, people, employees]) => { if (!alive) return; setState(loaded); setHelpers(people); setPersonnel(employees ?? []); const dates = loaded.document?.employees.flatMap(e => e.days.map(d => d.date)).sort() ?? []; if (dates.length) setWeek(isoWeekForDate(dates[dates.length - 1])); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Daten konnten nicht geladen werden.'); }); return () => { alive = false; }; }, [tenantId]);
  const document = state?.document;
  const allDays = useMemo(() => document?.employees.flatMap(employee => employee.days.map(day => ({ day, employee }))) ?? [], [document]);
  const filtered = useMemo(() => allDays.filter(({ employee }) => dept === 'all' || departmentForEmployee(state ?? { departments: {} }, employee.name).department === dept), [allDays, dept, state]);
  const dates = useMemo(() => weekDates(week), [week]);
  const documentRange = useMemo(() => { const values = document?.employees.flatMap(e => e.days.map(d => d.date)).sort() ?? []; return { from: values[0], to: values.at(-1) }; }, [document]);
  useEffect(() => { let alive = true; if (!documentRange.from || !documentRange.to) { setRevenue({}); return; } ladeUmsatzTage(tenantId, documentRange.from, documentRange.to).then(map => { if (alive) setRevenue(Object.fromEntries([...map].map(([date, value]) => [date, nettoUmsatzTag(value)]))); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Umsatz konnte nicht geladen werden.'); }); return () => { alive = false; }; }, [tenantId, documentRange.from, documentRange.to]);
  useEffect(() => { let alive = true; if (!documentRange.from || !documentRange.to) { setActual({}); return; } const start = new Date(`${documentRange.from}T12:00:00`); const end = new Date(`${documentRange.to}T12:00:00`); const months: Date[] = []; for (const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) months.push(new Date(cursor)); Promise.all(months.map(month => loadActualHoursForMonth(month, tenantId))).then(parts => { if (!alive) return; setActual(Object.assign({}, ...parts.filter((part): part is Record<string, ActualEntry> => Boolean(part)))); }); return () => { alive = false; }; }, [tenantId, documentRange.from, documentRange.to]);

  const controlNames = useMemo(() => new Set((document?.employees ?? []).map(employee => employee.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH'))), [document]);
  const helperHours = useMemo(() => helpers.filter(helper =>
    helper.isActive
    && !controlNames.has(helper.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH'))
    && (dept === 'all' || helper.department === dept)
  ).map(helper => ({ helper, days: dates.map(date => ({ date, hours: actual[`${helper.id}-${date}`]?.hours ?? 0 })) })), [helpers, controlNames, dates, actual, dept]);
  const importedDates = useMemo(() => { if (!documentRange.from || !documentRange.to) return []; const result: string[] = []; for (const cursor = new Date(`${documentRange.from}T12:00:00`); isoDate(cursor) <= documentRange.to; cursor.setUTCDate(cursor.getUTCDate() + 1)) result.push(isoDate(cursor)); return result; }, [documentRange]);
  const allHelperHours = useMemo(() => helperHours.map(({ helper }) => ({ helper, days: importedDates.map(date => ({ date, hours: actual[`${helper.id}-${date}`]?.hours ?? 0 })) })), [helperHours, importedDates, actual]);
  const selectedHours = useCallback((id: string, date: string) => state?.helperSelections[`${id}|${date}`] ? (actual[`${id}-${date}`]?.hours ?? 0) : 0, [state, actual]);
  // Produktivität/Besatzung verwendet dieselbe kanonische Ist-Dienstplanquelle
  // wie die Tages- und Cockpit-Summen. Die Kontrollliste bleibt Kontroll- und
  // Zeitachsenansicht, ist aber nicht länger ein abweichender Stunden-Nenner.
  const actualPersonnelDays = useMemo(() => personnel.flatMap(employee => {
    const employeeDept: ControlListDepartment = employee.department === 'küche'
      ? 'kueche'
      : employee.department === 'service' ? 'service' : 'geschaeftsleitung';
    if (dept !== 'all' && employeeDept !== dept) return [];
    return importedDates.flatMap(date => {
      const entry = actual[`${employee.id}-${date}`];
      if (!entry || entry.absenceType || !(entry.hours > 0)) return [];
      return [{ date, netHours: entry.hours }];
    });
  }), [actual, dept, importedDates, personnel]);
  const modelDays = useMemo(() => actualPersonnelDays.concat(allHelperHours.flatMap(({ helper, days }) => days.filter(d => selectedHours(helper.id, d.date) > 0).map(d => ({ date: d.date, netHours: d.hours })))), [actualPersonnelDays, allHelperHours, selectedHours]);
  const productivityDays = useMemo(() => aggregateProductivityDays(modelDays, revenue), [modelDays, revenue]);
  const chartDays = useMemo(() => dates.map(date => productivityDays.find(day => day.date === date) ?? ({ date, isoWeek: isoWeekForDate(date), netHours: 0, revenue: revenue[date] })), [dates, productivityDays, revenue]);
  const weeks = useMemo(() => aggregateProductivityWeeks(aggregateProductivityDays(modelDays, revenue)), [modelDays, revenue]);
  const currentWeek = weeks.find(item => item.isoWeek === week) ?? { isoWeek: week, netHours: 0, days: [] };
  const save = (next: ControlListTenantState) => {
    const saveTenant = tenantId;
    setState(next);
    saveQueue.current = saveQueue.current.catch(() => undefined).then(() => saveControlListState(saveTenant, next)).catch(async e => {
      if (tenantRef.current !== saveTenant) return;
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
      const persisted = await loadControlListState(saveTenant).catch(() => null);
      if (persisted && tenantRef.current === saveTenant) setState(persisted);
    });
  };
  const toggleHelper = (id: string, date: string, checked: boolean) => { if (!state) return; save({ ...state, helperSelections: { ...state.helperSelections, [`${id}|${date}`]: checked } }); };
  const toggleHelperWeek = (id: string, days: HelperDay[], checked: boolean) => { if (!state) return; const helperSelections = { ...state.helperSelections }; days.filter(day => day.hours > 0).forEach(day => { helperSelections[`${id}|${day.date}`] = checked; }); save({ ...state, helperSelections }); };
  const shiftWeek = (amount: number) => { if (!dates[0]) return; const d = new Date(`${dates[0]}T12:00:00`); d.setDate(d.getDate() + amount * 7); setWeek(isoWeekForDate(isoDate(d))); };
  const onFile = async (file?: File) => { if (!file) return; const importTenant = tenantId; try { const parsed = parseControlListXls(await file.arrayBuffer()); if (tenantRef.current !== importTenant) throw new Error('Der Mandant wurde während des Imports gewechselt. Bitte Datei erneut auswählen.'); const text = parsed.tenant.toLowerCase(); const valid = importTenant === 'oliv' ? text.includes('3027') || text.includes('oliv') : text.includes('3012') || text.includes('beaulieu'); if (!valid) throw new Error(`Diese Datei gehört nicht zu ${tenant.name}.`); setPending(parsed); } catch (e) { setError(e instanceof Error ? e.message : 'Import konnte nicht gelesen werden.'); } };
  const applyImport = () => { if (!state || !pending) return; const text = pending.tenant.toLowerCase(); const valid = tenantId === 'oliv' ? text.includes('3027') || text.includes('oliv') : text.includes('3012') || text.includes('beaulieu'); if (!valid) { setPending(null); setError('Der aktive Mandant passt nicht mehr zur ausgewählten Datei.'); return; } const merged = mergeControlListHistory(state.document, pending); save({ ...state, document: merged }); setPending(null); setWeek(isoWeekForDate(pending.employees.flatMap(e => e.days).at(-1)?.date ?? isoDate(new Date()))); };

  if (!state) return <PageShell width="wide">{error
    ? <EmptyState icon={AlertTriangle} title="Besatzung konnte nicht geladen werden" description={error} action={<Button onClick={() => window.location.reload()}>Neu laden</Button>} />
    : <LoadingState label="Besatzung und Produktivität wird geladen…" />}</PageShell>;
  return <PageShell width="wide" header={<PageHeader width="wide" icon={<UsersRound />} title="Besatzung & Produktivität" meta={`${tenant.shortName} · Kontrollliste / Umsatz`}>
    <div className="flex w-full flex-wrap gap-1 rounded-lg bg-muted/60 p-1 sm:w-auto">
      <button className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${mode === 'productivity' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`} onClick={() => setMode('productivity')}>Produktivität</button>
      <button className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${mode === 'schedule' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`} onClick={() => setMode('schedule')}>Dienstplan</button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {(['all', 'kueche', 'service'] as DeptFilter[]).map(item => <button key={item} onClick={() => setDept(item)} className={`rounded-md border px-2.5 py-1 text-xs font-medium ${dept === item ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>{item === 'all' ? 'Alle' : item === 'kueche' ? 'Küche' : 'Service'}</button>)}
      <div className="ml-auto flex items-center gap-1 rounded-md border border-border bg-card px-1"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shiftWeek(-1)}><ArrowLeft className="h-3.5 w-3.5" /></Button><span className="min-w-[88px] text-center font-mono text-xs">{week || '—'}</span><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shiftWeek(1)}><ArrowRight className="h-3.5 w-3.5" /></Button></div>
      <input ref={fileRef} type="file" accept=".xls" className="hidden" onChange={event => { void onFile(event.target.files?.[0]); event.target.value = ''; }} />
      <Button size="sm" variant="outline" disabled={!canManageOperationalData} onClick={() => fileRef.current?.click()}><FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Kontrollliste importieren</Button>
    </div>
  </PageHeader>}>
    {error && <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{error}</span><Button variant="ghost" size="sm" onClick={() => setError('')}><RefreshCw className="mr-1 h-3.5 w-3.5" />Schliessen</Button></div>}
    {document && <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{document.period}</span><span className="mx-2">·</span>{document.tenant}<span className="mx-2">·</span>Quelle: MIRUS report_test</div>}
    {!document ? <EmptyState icon={FileSpreadsheet} title="Noch keine Kontrollliste importiert" description={`Importiere den MIRUS report_test-Export für ${tenant.shortName}. Die Datei wird vor dem Ersetzen geprüft.`} action={<Button onClick={() => fileRef.current?.click()}>Datei auswählen</Button>} /> :
      mode === 'productivity' ? <ProductivityMode currentWeek={currentWeek} days={chartDays} weeks={lastFiveProductivityWeeks(weeks)} onSelect={day => setSelectedDay({ ...filtered.find(item => item.day.date === day.date)?.day, ...day })} selectedDay={selectedDay} filtered={filtered} helperHours={helperHours} state={state} /> :
      <ScheduleMode document={document} filtered={filtered} week={week} dates={dates} helperHours={helperHours} state={state} selectedEmployee={selectedEmployee} setSelectedEmployee={setSelectedEmployee} personPeriod={personPeriod} setPersonPeriod={setPersonPeriod} toggleHelper={toggleHelper} toggleHelperWeek={toggleHelperWeek} />}
    {document && <MappingPanel document={document} state={state} personnel={personnel} tenantId={tenantId} save={save} />}
    {pending && <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 p-4"><div className="w-full max-w-2xl rounded-xl border border-border bg-card p-5 shadow-xl">
      <p className="text-xs font-semibold uppercase tracking-widest text-primary">Import-Vorschau</p>
      <h2 className="mt-1 text-lg font-semibold">{pending.tenant}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{pending.employees.length} Mitarbeitende · {pending.employees.flatMap(employee => employee.days).length} Tageszeilen · Zeitraum {pending.period}</p>
      <div className="mt-4 max-h-64 overflow-auto rounded-lg border">
        <table className="w-full min-w-[620px] text-xs">
          <thead className="sticky top-0 bg-muted"><tr><th className="px-3 py-2 text-left">Mitarbeiter</th><th className="px-3 py-2 text-left">Datum</th><th className="px-3 py-2 text-right">Netto</th><th className="px-3 py-2 text-left">Status</th></tr></thead>
          <tbody>{pending.employees.flatMap(employee => employee.days.map(day => ({ employee, day }))).slice(0, 30).map(({ employee, day }) => <tr key={`${employee.name}-${day.date}`} className="border-t">
            <td className="px-3 py-2">{employee.name}<span className="ml-1 text-muted-foreground">{employee.inIst ? 'Ist' : 'nur Kontrollliste'}</span></td>
            <td className="px-3 py-2 font-mono">{day.date}</td>
            <td className="px-3 py-2 text-right font-mono">{fmt(day.netHours)} h</td>
            <td className={`px-3 py-2 ${day.danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{day.status || '—'}{day.danger ? ' · prüfen' : ''}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Statushinweise dienen der Kontrolle und blockieren den Import nicht.</p>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setPending(null)}>Abbrechen</Button><Button onClick={applyImport}><Check className="mr-1.5 h-4 w-4" />Aktuelle Liste ersetzen</Button></div>
    </div></div>}
  </PageShell>;
}

function ProductivityMode({ currentWeek, days, weeks, onSelect, selectedDay, filtered, helperHours, state }: ProductivityViewProps & { helperHours: HelperHours[]; state: ControlListTenantState }) {
  const best = days.filter(d => d.productivity !== undefined).sort((a, b) => (b.productivity ?? 0) - (a.productivity ?? 0))[0];
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-4">
    <Metric label="Besatzungsstunden" value={`${fmt(currentWeek.netHours)} Std`} icon={<Clock3 />} />
    <Metric label="Netto-Umsatz" value={`${currentWeek.revenue === undefined ? '—' : `${Math.round(currentWeek.revenue).toLocaleString('de-CH')} CHF`}`} icon={<BarChart3 />} />
    <Metric label="Produktivität Ø" value={`${fmt(currentWeek.productivity, 0)} CHF/Std`} accent={(currentWeek.productivity ?? 0) >= 100} icon={<Layers3 />} />
    <Metric label="Produktivster Tag" value={best ? `${new Date(`${best.date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short' })} · ${fmt(best.productivity, 0)}` : '—'} icon={<CalendarDays />} />
  </div><section className="rounded-xl border border-border bg-card p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">Umsatz & Produktivität pro Tag</h2><p className="text-xs text-muted-foreground">Balken anklicken für die Schicht-Zeitlinie · Budget 100 CHF/Std</p></div><span className="rounded bg-[#f4e8bd] px-2 py-1 font-mono text-[11px] text-[#765f16]">KW {currentWeek.isoWeek?.split('-W')[1] || '—'}</span></div><div className="overflow-x-auto"><ProductivityChart days={days} onSelect={onSelect} /></div></section><section className="rounded-xl border border-border bg-card p-4 shadow-sm"><h2 className="font-semibold">Wochenverlauf</h2><div className="mt-3 grid gap-2 sm:grid-cols-5">{weeks.map(w => <div key={w.isoWeek} className="rounded-lg bg-muted/50 p-3"><p className="font-mono text-xs text-muted-foreground">{w.isoWeek}</p><p className="mt-2 text-lg font-semibold">{fmt(w.productivity, 0)} <span className="text-xs font-normal text-muted-foreground">CHF/Std</span></p><p className="text-xs text-muted-foreground">{fmt(w.netHours)} Std · {w.revenue === undefined ? 'Umsatz fehlt' : `${Math.round(w.revenue).toLocaleString('de-CH')} CHF`}</p></div>)}</div></section>{selectedDay && <DayDetail day={selectedDay} filtered={filtered} helperHours={helperHours} state={state} />}</div>;
}
function Metric({ label, value, icon, accent }: { label: string; value: string; icon: ReactNode; accent?: boolean }) { return <div className="rounded-xl border border-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between text-muted-foreground"><span className="text-xs font-medium">{label}</span><span className={accent ? 'text-[#1f8a62]' : 'text-primary'}>{icon}</span></div><p className="mt-3 font-mono text-xl font-semibold tracking-tight">{value}</p></div>; }
function Timeline({ rows, dates }: { rows: TimelineRow[]; dates: string[] }) {
  return <div className="overflow-x-auto rounded-lg border border-border"><div className="min-w-[760px]">
    <div className="grid grid-cols-[180px_1fr] border-b bg-muted/40 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span>Name / Netto</span>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` }}>
        {dates.map(date => <div key={date}>
          <div className="text-center font-semibold">{new Date(`${date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit' })}</div>
          <div className="mt-1 flex justify-between font-mono text-[8px]"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
        </div>)}
      </div>
    </div>
    {rows.map(row => <div key={row.name} className="grid grid-cols-[180px_1fr] items-center border-b px-3 py-3 last:border-0">
      <div className="text-xs font-medium">{row.name}<span className={`ml-2 font-mono ${row.days.some(day => day.danger) ? 'text-destructive' : 'text-muted-foreground'}`}>{fmt(row.days.reduce((sum, day) => sum + day.netHours, 0))} h</span></div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` }}>{dates.map(date => {
        const day = row.days.find(item => item.date === date);
        return <div key={date} className="relative h-9 rounded bg-muted/40">
          {day?.effectiveWindows.map((window, index) => <div key={index} className={`absolute top-4 h-3 rounded-sm border ${day.danger ? 'border-destructive bg-destructive/20' : 'border-[#165f58] bg-[#165f58]/20'}`} style={{ left: `${(window.start % 24) / 24 * 100}%`, width: `${Math.max((window.end - window.start) / 24 * 100, 5)}%` }}>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] text-foreground">{timeLabel(window.start)}–{timeLabel(window.end)}</span>
          </div>)}
          {day?.netHours && !day.effectiveWindows.length ? <span className="absolute inset-0 grid place-items-center rounded border border-dashed border-primary/40 text-[10px] text-primary">+ {fmt(day.netHours)} h · Aushilfe</span> : null}
        </div>;
      })}</div>
    </div>)}
  </div></div>;
}
function ScheduleMode({ document, filtered, week, dates, helperHours, state, selectedEmployee, setSelectedEmployee, personPeriod, setPersonPeriod, toggleHelper, toggleHelperWeek }: { document: ControlListDocument; filtered: { employee: { name: string }; day: ControlListDay }[]; week: string; dates: string[]; helperHours: HelperHours[]; state: ControlListTenantState; selectedEmployee: string; setSelectedEmployee: (value: string) => void; personPeriod: 'week' | 'month'; setPersonPeriod: (value: 'week' | 'month') => void; toggleHelper: (id: string, date: string, checked: boolean) => void; toggleHelperWeek: (id: string, days: HelperDay[], checked: boolean) => void }) {
  const rows: TimelineRow[] = filtered.reduce<TimelineRow[]>((result, item) => { if (!dates.includes(item.day.date) || (selectedEmployee && item.employee.name !== selectedEmployee)) return result; let row = result.find(existing => existing.name === item.employee.name); if (!row) { row = { name: item.employee.name, days: [] }; result.push(row); } row.days.push(item.day); return result; }, []);
  const month = dates[0]?.slice(0, 7);
  const visibleNames = new Set(filtered.map(item => item.employee.name));
  const monthDays = document.employees.filter(employee => visibleNames.has(employee.name)).flatMap(employee => employee.days.filter(day => day.date.startsWith(month ?? '') && (!selectedEmployee || employee.name === selectedEmployee)).map(day => ({ employee, day }))).sort((a, b) => a.day.date.localeCompare(b.day.date));
  const periodRows: { name: string; day: ControlListDay }[] = personPeriod === 'week'
    ? rows.flatMap(row => row.days.map(day => ({ name: row.name, day })))
    : monthDays.map(({ employee, day }) => ({ name: employee.name, day }));
  return <div className="space-y-4"><section className="rounded-xl border border-border bg-card p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Schichten · {week}</h2><p className="text-xs text-muted-foreground">Zusammengefasste Von–Bis-Fenster, rote Umrandung = Nacht / ≥ 9 Netto-Stunden.</p></div><select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={selectedEmployee} onChange={e => setSelectedEmployee(e.target.value)}><option value="">Alle Mitarbeitenden</option>{document.employees.map(employee => <option key={employee.name}>{employee.name}</option>)}</select></div><div className="mt-4"><Timeline rows={rows} dates={dates} /></div></section><section className="rounded-xl border border-border bg-card p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between"><h2 className="font-semibold">Mitarbeiter-Zeitraum</h2><div className="flex gap-1 rounded-md bg-muted p-1">{(['week', 'month'] as const).map(period => <button key={period} onClick={() => setPersonPeriod(period)} className={`rounded px-3 py-1 text-xs ${personPeriod === period ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}>{period === 'week' ? 'KW' : 'Monat'}</button>)}</div></div><PersonPeriodRows rows={periodRows} grouped={personPeriod === 'month'} /></section><WeeklyMatrix document={document} dates={dates} filtered={filtered} selectedEmployee={selectedEmployee} state={state} helperHours={helperHours} /><HelperPanel helperHours={helperHours} state={state} toggleHelper={toggleHelper} toggleHelperWeek={toggleHelperWeek} dates={dates} /></div>;
}

function PersonPeriodRows({ rows, grouped }: { rows: { name: string; day: ControlListDay }[]; grouped: boolean }) {
  let lastWeek = '';
  return <div className="mt-3 overflow-x-auto rounded-lg border"><div className="min-w-[680px]">
    <div className="grid grid-cols-[220px_1fr] border-b bg-muted/40 px-3 py-2 text-[9px] uppercase text-muted-foreground"><span>Tag / Netto</span><div className="flex justify-between font-mono"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div>
    {rows.sort((a, b) => a.day.date.localeCompare(b.day.date) || a.name.localeCompare(b.name, 'de-CH')).map(({ name, day }) => {
      const currentWeek = isoWeekForDate(day.date);
      const showGroup = grouped && currentWeek !== lastWeek;
      lastWeek = currentWeek;
      return <Fragment key={`${name}-${day.date}`}>
        {showGroup && <div className="border-b bg-muted/30 px-3 py-1 text-xs font-semibold">{currentWeek}</div>}
        <div className="grid grid-cols-[220px_1fr] items-center border-b px-3 py-3 last:border-0">
          <div className="text-xs"><span className="font-medium">{new Date(`${day.date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span><span className="ml-2 text-muted-foreground">{name}</span><span className={`ml-2 font-mono ${day.danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{fmt(day.netHours)} h</span></div>
          <div className="relative h-9 rounded bg-muted/40">{day.effectiveWindows.map((window, index) => <div key={index} className={`absolute top-4 h-3 rounded-sm border ${day.danger ? 'border-destructive bg-destructive/20' : 'border-[#165f58] bg-[#165f58]/20'}`} style={{ left: `${(window.start % 24) / 24 * 100}%`, width: `${Math.max((window.end - window.start) / 24 * 100, 2)}%` }}>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px]">{timeLabel(window.start)}–{timeLabel(window.end)}</span>
          </div>)}</div>
        </div>
      </Fragment>;
    })}
  </div></div>;
}
function WeeklyMatrix({ document, dates, filtered, selectedEmployee, state, helperHours }: {
  document: ControlListDocument;
  dates: string[];
  filtered: { employee: { name: string }; day: ControlListDay }[];
  selectedEmployee: string;
  state: ControlListTenantState;
  helperHours: HelperHours[];
}) {
  const groups: ControlListDepartment[] = ['kueche', 'service', 'geschaeftsleitung'];
  const visibleNames = new Set(filtered.map(item => item.employee.name));
  const visibleHelpers = helperHours.filter(({ helper }) =>
    (!selectedEmployee || helper.name === selectedEmployee)
    && (helper.department === 'kueche' || helper.department === 'service'));
  const totalForDate = (date: string) =>
    filtered.filter(item => item.day.date === date).reduce((sum, item) => sum + item.day.netHours, 0)
    + visibleHelpers.reduce((sum, { helper, days }) => {
      const day = days.find(item => item.date === date);
      return sum + (state.helperSelections[`${helper.id}|${date}`] ? day?.hours ?? 0 : 0);
    }, 0);

  return <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
    <h2 className="font-semibold">Wochenmatrix · Stunden je Abteilung</h2>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[980px] text-xs">
        <thead><tr className="border-b text-left text-muted-foreground">
          <th className="px-2 py-2">Mitarbeiter</th>
          {dates.map(date => <th key={date} className="px-2 py-2 text-center">{new Date(`${date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit' })}</th>)}
          <th className="px-2 py-2 text-right">Woche</th>
        </tr></thead>
        <tbody>{groups.map(group => {
          const employees = document.employees.filter(employee =>
            visibleNames.has(employee.name)
            && departmentForEmployee(state, employee.name).department === group
            && (!selectedEmployee || employee.name === selectedEmployee));
          const groupHelpers = visibleHelpers.filter(({ helper }) => helper.department === group);
          if (!employees.length && !groupHelpers.length) return null;
          return <Fragment key={group}>
            <tr className="bg-muted/40"><td colSpan={dates.length + 2} className="px-2 py-1 font-semibold">
              {group === 'kueche' ? 'Küche' : group === 'service' ? 'Service' : 'Geschäftsleitung'}
            </td></tr>
            {employees.map(employee => <tr key={employee.name} className="border-b">
              <td className="px-2 py-2 font-medium">{employee.name}<span className="ml-1 text-[10px] font-normal text-muted-foreground">{employee.inIst ? 'Ist' : 'nur Kontrollliste'}</span></td>
              {dates.map(date => {
                const day = filtered.find(item => item.employee.name === employee.name && item.day.date === date)?.day;
                return <td key={date} className="px-2 py-2 text-center">{day ? <>
                  <div>{day.effectiveWindows.map(window => `${timeLabel(window.start)}–${timeLabel(window.end)}`).join(' · ') || '—'}</div>
                  <div className="font-mono text-muted-foreground">{fmt(day.netHours)} h</div>
                </> : '—'}</td>;
              })}
              <td className="px-2 py-2 text-right font-mono">{fmt(employee.days.filter(day => dates.includes(day.date)).reduce((sum, day) => sum + day.netHours, 0))} h</td>
            </tr>)}
            {groupHelpers.map(({ helper, days }) => <tr key={helper.id} className="border-b border-dashed">
              <td className="px-2 py-2 font-medium">{helper.name}<span className="ml-1 text-[10px] font-normal text-primary">Aushilfe</span></td>
              {dates.map(date => {
                const day = days.find(item => item.date === date);
                const hours = state.helperSelections[`${helper.id}|${date}`] ? day?.hours ?? 0 : 0;
                return <td key={date} className="px-2 py-2 text-center font-mono text-primary">{hours > 0 ? `+${fmt(hours)} h` : '—'}</td>;
              })}
              <td className="px-2 py-2 text-right font-mono">{fmt(days.reduce((sum, day) => sum + (state.helperSelections[`${helper.id}|${day.date}`] ? day.hours : 0), 0))} h</td>
            </tr>)}
          </Fragment>;
        })}</tbody>
        <tfoot><tr className="border-t-2 font-semibold">
          <td className="px-2 py-2">Personalstd/Tag</td>
          {dates.map(date => <td key={date} className="px-2 py-2 text-center font-mono">{fmt(totalForDate(date))}</td>)}
          <td />
        </tr></tfoot>
      </table>
    </div>
  </section>;
}
function HelperPanel({ helperHours, state, toggleHelper, toggleHelperWeek, dates }: { helperHours: HelperHours[]; state: ControlListTenantState; toggleHelper: (id: string, date: string, checked: boolean) => void; toggleHelperWeek: (id: string, days: HelperDay[], checked: boolean) => void; dates: string[] }) { return <section className="rounded-xl border border-border bg-card p-4 shadow-sm"><h2 className="font-semibold">Aushilfen · Ist-Stunden ergänzen</h2><p className="mt-1 text-xs text-muted-foreground">Nur Personen ausserhalb der Kontrollliste. Stunden sind schreibgeschützt; Auswahl wird mandantenbezogen gespeichert.</p>{helperHours.length ? <div className="mt-3 divide-y border-y">{helperHours.map(({ helper, days }) => <div key={helper.id} className="flex flex-wrap items-center gap-2 py-3"><label className="flex min-w-[170px] items-center gap-2 text-sm font-medium"><input type="checkbox" checked={dates.filter(date => days.some(day => day.date === date && day.hours > 0)).every(date => state.helperSelections[`${helper.id}|${date}`])} onChange={event => toggleHelperWeek(helper.id, days.filter(day => dates.includes(day.date)), event.target.checked)} />{helper.name}</label><div className="flex gap-1 overflow-x-auto">{days.filter(day => day.hours > 0).map(day => <button key={day.date} onClick={() => toggleHelper(helper.id, day.date, !state.helperSelections[`${helper.id}|${day.date}`])} className={`rounded-full border px-2 py-1 font-mono text-[10px] ${state.helperSelections[`${helper.id}|${day.date}`] ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>{new Date(`${day.date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit' })} · {fmt(day.hours)} h</button>)}</div></div>)}</div> : <p className="mt-4 text-sm text-muted-foreground">Keine aktiven Aushilfen ausserhalb der Kontrollliste gefunden.</p>}</section>; }
function DayDetail({ day, filtered, helperHours, state }: { day: ProductivityDay & Partial<ControlListDay>; filtered: { employee: { name: string }; day: ControlListDay }[]; helperHours: HelperHours[]; state: ControlListTenantState }) {
  const rows: TimelineRow[] = filtered.filter(item => item.day.date === day.date).reduce<TimelineRow[]>((acc, item) => {
    let row = acc.find(existing => existing.name === item.employee.name);
    if (!row) { row = { name: item.employee.name, days: [] }; acc.push(row); }
    row.days.push(item.day);
    return acc;
  }, []);
  helperHours.forEach(({ helper, days }) => {
    const hours = days.find(item => item.date === day.date)?.hours ?? 0;
    if (state.helperSelections[`${helper.id}|${day.date}`] && hours > 0) {
      rows.push({ name: `${helper.name} · Aushilfe`, days: [{
        date: day.date, netHours: hours, rawTimeRecording: 'Ist / manuell',
        timeRecordingGross: 0, timeRecordingTotal: hours, effectiveWindows: [],
        effectiveGross: 0, difference: 0, status: 'Aushilfe', danger: false,
      }] });
    }
  });
  return <section className="rounded-xl border border-primary/30 bg-[#f8f4ea] p-4 shadow-sm">
    <h2 className="font-semibold">Tagesdetail · {day.date}</h2>
    <div className="mt-2 flex flex-wrap gap-5 text-sm">
      <span>Netto-Umsatz <b>{day.revenue === undefined ? '—' : `${Math.round(day.revenue).toLocaleString('de-CH')} CHF`}</b></span>
      <span>Besatzung <b>{fmt(day.netHours)} h</b></span>
      <span>Produktivität <b>{fmt(day.productivity, 0)} CHF/Std</b></span>
    </div>
    <div className="mt-4"><Timeline rows={rows} dates={[day.date]} /></div>
  </section>;
}

function MappingPanel({ document, state, personnel, tenantId, save }: {
  document: ControlListDocument;
  state: ControlListTenantState;
  personnel: Employee[];
  tenantId: 'oliv' | 'beaulieu';
  save: (next: ControlListTenantState) => void;
}) {
  const [open, setOpen] = useState(false);
  const seedDepartments = () => {
    const dailyHours = loadDailyHoursDepartmentSeed(tenantId);
    const dailyByName = new Map(Object.entries(dailyHours).map(([name, department]) => [
      name.trim().normalize('NFKC').toLocaleLowerCase('de-CH'),
      department,
    ]));
    const byName = new Map(personnel.filter(employee => employee.isActive !== false).map(employee => {
      const role = `${employee.positionTitle ?? ''} ${employee.primaryStation ?? ''}`;
      const department: ControlListDepartment = /geschäfts|geschaefts|direktion|betriebsleit|management/i.test(role)
        ? 'geschaeftsleitung'
        : employee.department === 'küche' ? 'kueche' : 'service';
      return [employee.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH'), department] as const;
    }));
    const departments = { ...state.departments };
    for (const employee of document.employees) {
      if (departments[employee.name]) continue;
      const key = employee.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH');
      const match = dailyByName.get(key) ?? byName.get(key);
      if (match) departments[employee.name] = match;
    }
    save({ ...state, departments });
  };
  return <section className="rounded-xl border border-border bg-card shadow-sm">
    <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between p-4 text-left">
      <span><span className="font-semibold">Abteilungszuordnung</span><span className="ml-2 text-xs text-muted-foreground">Unbekannt = Service, sichtbar markiert</span></span>
      <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="border-t">
      <div className="flex justify-end border-b p-3"><Button size="sm" variant="outline" onClick={seedDepartments}>Aus Personalstamm übernehmen</Button></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2">Mitarbeiter</th><th className="px-4 py-2">Kontrollliste</th><th className="px-4 py-2">Aktuelle Abteilung</th><th className="px-4 py-2">Zuordnung</th></tr></thead>
        <tbody>{document.employees.map(employee => {
          const found = departmentForEmployee(state, employee.name);
          return <tr key={employee.name} className="border-t">
            <td className="px-4 py-2 font-medium">{employee.name}</td>
            <td className="px-4 py-2 text-xs text-muted-foreground">{employee.inIst ? 'Ist' : 'nur Kontrollliste'}</td>
            <td className="px-4 py-2 text-xs text-muted-foreground">{found.unknown ? 'Abteilung offen · Service' : found.department}</td>
            <td className="px-4 py-2"><select value={found.department} onChange={event => save({ ...state, departments: { ...state.departments, [employee.name]: event.target.value as ControlListDepartment } })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="kueche">Küche</option><option value="service">Service</option><option value="geschaeftsleitung">Geschäftsleitung</option>
            </select></td>
          </tr>;
        })}</tbody>
      </table></div>
    </div>}
  </section>;
}