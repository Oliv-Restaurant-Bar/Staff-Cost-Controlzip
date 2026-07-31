/**
 * Positions-/Qualifikations-Matrix — Gesamtübersicht «wer hat welche Position».
 *
 * Zeilen = Mitarbeiter (gruppiert nach Abteilung Küche/Service), Spalten = alle
 * aktiven Positionen. Zelle = Dreizustand: leer (nicht qualifiziert), ✓
 * (qualifiziert = secondaryStations), ★ (Hauptposition = primaryStation).
 *
 * SSOT: exakt dieselbe Zuordnung wie Personalstamm → «Positionen/Qualifikationen»
 * (Employee.primaryStation / secondaryStations, Keys = Position.key).
 * Sicheres Speichern wie im Positions-Pop-up: vor jeder Änderung frisch laden,
 * nur die Stationsfelder des betroffenen MA patchen (updateEmployeeStations,
 * Mandanten-Scope per ID-Präfix erzwungen).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Info, Loader2, Search, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { loadEmployees, updateEmployeeStations } from '@/lib/supabase-db';
import type { Employee, Department, EmploymentType } from '@/types/personnel';
import type { Position } from '@/types/positions';
import type { TenantId } from '@/contexts/TenantContext';

const TYPE_LABEL: Record<EmploymentType, string> = {
  vollzeit: 'Vollzeit', teilzeit: 'Teilzeit', minijob: 'Minijob', aushilfe: 'Aushilfe',
};
const DEPT_LABEL: Record<string, string> = { service: 'Service', 'küche': 'Küche', kueche: 'Küche' };
/** Anzeige-Reihenfolge der Abteilungs-Gruppen. */
const DEPT_ORDER: Department[] = ['küche', 'service'];

function normDept(d: string): Department {
  return d === 'kueche' || d === 'küche' ? 'küche' : 'service';
}

function hasKey(e: Employee, key: string): boolean {
  return e.primaryStation === key || (e.secondaryStations ?? []).includes(key);
}

export function PositionMatrix({
  positions, tenantId, readOnly, dynamicHintFor,
}: {
  /** Aktive Positionen des Mandanten (usePositions). */
  positions: Position[];
  tenantId: TenantId;
  /** Gäste dürfen nur ansehen. */
  readOnly?: boolean;
  /** Liefert den dynamischen Regel-Hinweis für eine Position (oder null). */
  dynamicHintFor?: (positionKey: string) => string | null;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCell, setBusyCell] = useState<string | null>(null); // `${empId}:${posKey}`
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<'all' | Department>('all');
  const [onlyQualified, setOnlyQualified] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await loadEmployees(tenantId);
      if (fresh) setEmployees(fresh.filter((e) => e.isActive !== false));
      else toast.error('Mitarbeiter konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  const activePositions = useMemo(
    () => positions.filter((p) => p.active).slice().sort((a, b) =>
      normDept(a.department).localeCompare(normDept(b.department), 'de') || a.sortOrder - b.sortOrder),
    [positions],
  );

  const q = search.trim().toLowerCase();
  const visibleColumns = useMemo(() => {
    // Positions-Suche filtert Spalten; wenn die Suche einen MA trifft, bleiben alle Spalten.
    if (!q) return activePositions;
    const matching = activePositions.filter((p) => p.name.toLowerCase().includes(q));
    return matching.length > 0 && !employees.some((e) => e.name.toLowerCase().includes(q))
      ? matching
      : activePositions;
  }, [activePositions, employees, q]);

  const visibleRows = useMemo(() => {
    let rows = employees;
    if (deptFilter !== 'all') rows = rows.filter((e) => normDept(e.department) === deptFilter);
    if (q && employees.some((e) => e.name.toLowerCase().includes(q))) {
      rows = rows.filter((e) => e.name.toLowerCase().includes(q));
    }
    if (onlyQualified) {
      rows = rows.filter((e) => visibleColumns.some((p) => hasKey(e, p.key)));
    }
    return rows.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [employees, deptFilter, q, onlyQualified, visibleColumns]);

  const rowGroups = useMemo(
    () => DEPT_ORDER
      .map((dept) => ({ dept, rows: visibleRows.filter((e) => normDept(e.department) === dept) }))
      .filter((g) => g.rows.length > 0),
    [visibleRows],
  );

  const qualifiedCount = useCallback(
    (posKey: string) => employees.filter((e) => hasKey(e, posKey)).length,
    [employees],
  );

  /**
   * Sicheres Patchen eines MA: frisch laden, Patch aus dem frischen Stand
   * ableiten (buildPatch), nur Stationsfelder schreiben, lokal nachziehen.
   */
  const applyStationPatch = async (
    empId: string,
    posKey: string,
    buildPatch: (fresh: Employee) => { primaryStation?: string; secondaryStations?: string[] } | null,
    successMsg: (fresh: Employee) => string,
  ) => {
    setBusyCell(`${empId}:${posKey}`);
    try {
      const fresh = await loadEmployees(tenantId);
      const emp = fresh?.find((e) => e.id === empId);
      if (!emp) { toast.error('Mitarbeiter nicht gefunden.'); return; }
      const patch = buildPatch(emp);
      if (!patch || Object.keys(patch).length === 0) {
        if (fresh) setEmployees(fresh.filter((e) => e.isActive !== false));
        return;
      }
      const res = await updateEmployeeStations(empId, patch, tenantId);
      if (!res.ok) { toast.error(`Speichern fehlgeschlagen: ${res.error}`); return; }
      toast.success(successMsg(emp));
      if (fresh) {
        setEmployees(fresh
          .filter((e) => e.isActive !== false)
          .map((e) => (e.id === empId ? { ...e, ...patch } : e)));
      }
    } finally {
      setBusyCell(null);
    }
  };

  /** Klick auf die Zelle: ✓ setzen bzw. Qualifikation komplett entfernen. */
  const toggleQualified = (emp: Employee, pos: Position) => {
    const posName = pos.name;
    void applyStationPatch(emp.id, pos.key, (freshEmp) => {
      const sec = freshEmp.secondaryStations ?? [];
      if (hasKey(freshEmp, pos.key)) {
        // Entfernen (auch wenn Hauptposition — bewusst, wie im Pop-up).
        const patch: { primaryStation?: string; secondaryStations?: string[] } = {};
        if (freshEmp.primaryStation === pos.key) patch.primaryStation = '';
        if (sec.includes(pos.key)) patch.secondaryStations = sec.filter((k) => k !== pos.key);
        return patch;
      }
      return { secondaryStations: [...sec, pos.key] };
    }, (fresh) => `${fresh.name}: «${posName}» ${hasKey(fresh, pos.key) ? 'entfernt' : 'zugeordnet'}.`);
  };

  /**
   * Stern-Klick: genau EINE Hauptposition pro MA. Die bisherige Hauptposition
   * wird automatisch zur normalen Qualifikation (✓) zurückgestuft. Erneuter
   * Stern-Klick auf die Hauptposition stuft sie selbst auf ✓ zurück.
   */
  const toggledPrimary = (emp: Employee, pos: Position) => {
    const posName = pos.name;
    void applyStationPatch(emp.id, pos.key, (freshEmp) => {
      const sec = freshEmp.secondaryStations ?? [];
      if (freshEmp.primaryStation === pos.key) {
        // Haupt → normale Qualifikation
        return { primaryStation: '', secondaryStations: sec.includes(pos.key) ? sec : [...sec, pos.key] };
      }
      const prevPrimary = freshEmp.primaryStation ?? '';
      let nextSec = sec.filter((k) => k !== pos.key);
      if (prevPrimary && !nextSec.includes(prevPrimary)) nextSec = [...nextSec, prevPrimary];
      return { primaryStation: pos.key, secondaryStations: nextSec };
    }, (fresh) => `${fresh.name}: Hauptposition ${fresh.primaryStation === pos.key ? 'zurückgesetzt' : `«${posName}» gesetzt`}.`);
  };

  const dynamicCols = dynamicHintFor
    ? visibleColumns.filter((p) => dynamicHintFor(p.key) != null)
    : [];

  return (
    <div className="space-y-3" data-testid="position-matrix">
      {/* Filter/Suche */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mitarbeiter oder Position suchen…"
            className="h-8 w-60 pl-7 text-sm"
            data-testid="matrix-search"
          />
        </div>
        <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v as 'all' | Department)}>
          <SelectTrigger className="h-8 w-36 text-sm" data-testid="matrix-dept-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Abteilungen</SelectItem>
            <SelectItem value="küche">Küche</SelectItem>
            <SelectItem value="service">Service</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Switch checked={onlyQualified} onCheckedChange={setOnlyQualified} data-testid="matrix-only-qualified" />
          <span className="text-sm text-muted-foreground">nur qualifizierte anzeigen</span>
        </label>
      </div>

      {/* Legende */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Check className="h-3.5 w-3.5 text-emerald-600" /> qualifiziert
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" /> Hauptposition (genau eine pro Mitarbeiter)
        </span>
        {dynamicCols.length > 0 && (
          <span className="flex items-center gap-1">
            <Info className="h-3.5 w-3.5 text-sky-600" />
            Bei dynamischen Positionen ({dynamicCols.map((p) => p.name).join(', ')}) wird die
            konkrete Tagesbesetzung zusätzlich per Regel bestimmt.
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Lädt…
        </div>
      ) : rowGroups.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground italic">
          Keine Mitarbeiter für die aktuellen Filter.
        </p>
      ) : (
        <div className="overflow-auto rounded-md border max-h-[70vh]">
          <table className="border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 bg-background border-b border-r px-2 py-1.5 text-left font-medium min-w-[190px]">
                  Mitarbeiter
                </th>
                {visibleColumns.map((p) => (
                  <th
                    key={p.key}
                    className="sticky top-0 z-20 bg-background border-b border-r px-1 py-1.5 text-center font-medium min-w-[72px] max-w-[100px] align-bottom"
                    title={dynamicHintFor?.(p.key) ?? p.name}
                  >
                    <div className="text-xs leading-tight break-words">
                      {p.name}
                      {dynamicHintFor?.(p.key) && <Info className="inline-block ml-0.5 h-3 w-3 text-sky-600 align-text-top" />}
                    </div>
                    <div className="text-[10px] font-normal text-muted-foreground" data-testid={`matrix-count-${p.key}`}>
                      {qualifiedCount(p.key)} MA
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowGroups.map((g) => (
                <Fragment key={g.dept}>
                  {/* Zwischenüberschrift Abteilung */}
                  <tr>
                    <td
                      className="sticky left-0 z-10 bg-muted/60 border-b border-r px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      data-testid={`matrix-dept-${g.dept}`}
                    >
                      {DEPT_LABEL[g.dept]}
                    </td>
                    <td colSpan={visibleColumns.length} className="bg-muted/60 border-b px-2 py-1" />
                  </tr>
                  {g.rows.map((emp) => (
                    <tr key={emp.id} className="hover:bg-muted/30">
                      <td className="sticky left-0 z-10 bg-background border-b border-r px-2 py-1 whitespace-nowrap">
                        <span className="font-medium">{emp.name}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {TYPE_LABEL[emp.employmentType] ?? emp.employmentType}
                        </span>
                        {emp.primaryStation && (
                          <Badge variant="secondary" className="ml-1.5 gap-0.5 px-1 py-0 text-[10px] align-middle" title="Hauptposition">
                            <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-500" />
                            {activePositions.find((p) => p.key === emp.primaryStation)?.name ?? emp.primaryStation}
                          </Badge>
                        )}
                      </td>
                      {visibleColumns.map((pos) => {
                        const isPrimary = emp.primaryStation === pos.key;
                        const qualified = hasKey(emp, pos.key);
                        const busy = busyCell === `${emp.id}:${pos.key}`;
                        return (
                          <td
                            key={pos.key}
                            className={cn(
                              'border-b border-r p-0 text-center',
                              isPrimary && 'bg-amber-50 dark:bg-amber-950/20',
                              !isPrimary && qualified && 'bg-emerald-50/60 dark:bg-emerald-950/20',
                            )}
                          >
                            <div className="flex items-center justify-center gap-0.5 h-8 group">
                              {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={readOnly || busyCell != null}
                                    onClick={() => toggleQualified(emp, pos)}
                                    className={cn(
                                      'flex h-6 w-6 items-center justify-center rounded',
                                      !readOnly && 'hover:bg-muted',
                                    )}
                                    title={qualified
                                      ? `«${pos.name}» bei ${emp.name} entfernen`
                                      : `${emp.name} für «${pos.name}» qualifizieren`}
                                    data-testid={`matrix-cell-${emp.id}-${pos.key}`}
                                  >
                                    {qualified
                                      ? <Check className="h-4 w-4 text-emerald-600" />
                                      : <span className="text-muted-foreground/30">·</span>}
                                  </button>
                                  {(qualified || !readOnly) && (
                                    <button
                                      type="button"
                                      disabled={readOnly || busyCell != null || (!qualified && true)}
                                      onClick={() => toggledPrimary(emp, pos)}
                                      className={cn(
                                        'flex h-6 w-5 items-center justify-center rounded',
                                        !qualified && 'invisible',
                                        !readOnly && qualified && 'hover:bg-muted',
                                      )}
                                      title={isPrimary
                                        ? 'Hauptposition zurücksetzen (wird zu ✓)'
                                        : `«${pos.name}» als Hauptposition von ${emp.name} setzen`}
                                      data-testid={`matrix-star-${emp.id}-${pos.key}`}
                                    >
                                      <Star className={cn(
                                        'h-3.5 w-3.5',
                                        isPrimary
                                          ? 'fill-amber-400 text-amber-500'
                                          : 'text-muted-foreground/40 group-hover:text-muted-foreground',
                                      )} />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
