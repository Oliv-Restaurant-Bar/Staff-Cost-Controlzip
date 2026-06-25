/**
 * StationMatrixDialog
 * ──────────────────────────────────────────────────────────────────────────────
 * Zeigt alle Mitarbeitenden mit ihren Positions-/Stationszuweisungen.
 * Jede Person kann eine Hauptposition und mehrere Zweitpositionen haben.
 *
 * Quelle der Positionen sind jetzt die konfigurierbaren Positionsstammdaten
 * (usePositions). Gespeichert werden die STABILEN Keys (nicht Anzeigenamen);
 * die Anzeige erfolgt über `positionDisplayName`. Alt-Werte (Anzeigename) werden
 * via `resolvePositionKey` toleriert. Änderungen werden auf Klick gespeichert.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LayoutGrid, Check, Save, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee, Department } from '@/types/personnel';
import type { Position } from '@/types/positions';
import { upsertEmployee } from '@/lib/supabase-db';
import { DEPT_BADGE_CLASS, DEPT_LABEL } from '@/lib/station-config';
import { useTenant } from '@/contexts/TenantContext';
import { usePositions } from '@/hooks/usePositions';
import { positionsForDepartment, positionDisplayName, resolvePositionKey } from '@/lib/position-utils';
import { PositionIcon } from '@/components/PositionIcon';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  onEmployeeUpdated: (emp: Employee) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ChipPosition {
  key: string;
  name: string;
  icon?: string;
  color?: string;
}

function StationChip({
  pos, active, isPrimary, onClick,
}: {
  pos: ChipPosition;
  active: boolean;
  isPrimary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={isPrimary ? 'Hauptposition' : active ? 'Zweitposition aktiv — klicken zum Entfernen' : 'Als Zweitposition hinzufügen'}
      className={cn(
        'px-2 py-0.5 rounded border text-xs font-medium transition-colors leading-none inline-flex items-center gap-1',
        isPrimary
          ? 'bg-primary text-primary-foreground border-primary'
          : active
            ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700 hover:bg-emerald-200'
            : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
      )}
    >
      {isPrimary && <span className="text-[8px]">★</span>}
      <span style={!isPrimary && pos.color ? { color: pos.color } : undefined}>
        <PositionIcon name={pos.icon} className="h-3 w-3" />
      </span>
      {pos.name}
      {active && !isPrimary && <span className="text-[8px] opacity-70">✓</span>}
    </button>
  );
}

// ─── Employee Row ─────────────────────────────────────────────────────────────

function EmployeeStationRow({
  emp, positions, onSave,
}: {
  emp: Employee;
  positions: Position[]; // aktive Positionen der Abteilung des Mitarbeiters
  onSave: (updated: Employee) => Promise<void>;
}) {
  // Basiswerte (aus Props) auf Keys aufgelöst (Toleranz für Alt-Anzeigenamen).
  const basePrimary = useMemo(() => resolvePositionKey(positions, emp.primaryStation) ?? '', [positions, emp.primaryStation]);
  const baseSecondary = useMemo(
    () => (emp.secondaryStations ?? []).map(s => resolvePositionKey(positions, s) ?? s).filter(Boolean),
    [positions, emp.secondaryStations],
  );

  const [primaryStation, setPrimaryStation]       = useState<string>(basePrimary);
  const [secondaryStations, setSecondaryStations] = useState<string[]>(baseSecondary);
  const [saving, setSaving]                       = useState(false);
  const [saved, setSaved]                         = useState(false);

  // Re-sync, wenn Positionen fertig geladen sind oder der Datensatz wechselt.
  useEffect(() => {
    setPrimaryStation(basePrimary);
    setSecondaryStations(baseSecondary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePrimary, JSON.stringify(baseSecondary)]);

  const dirty =
    primaryStation !== basePrimary ||
    JSON.stringify([...secondaryStations].sort()) !== JSON.stringify([...baseSecondary].sort());

  const handleSave = async () => {
    setSaving(true);
    const updated: Employee = {
      ...emp,
      primaryStation: primaryStation || undefined,
      secondaryStations: secondaryStations.length > 0 ? secondaryStations : undefined,
    };
    try {
      await onSave(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  const toggleSecondary = (key: string) => {
    if (key === primaryStation) return; // can't be both
    setSecondaryStations(prev =>
      prev.includes(key) ? prev.filter(s => s !== key) : [...prev, key],
    );
  };

  const selectPrimary = (key: string) => {
    setPrimaryStation(key);
    setSecondaryStations(prev => prev.filter(s => s !== key));
  };

  // Anzeige: konfigurierte Positionen + Alt-Keys, die dieser MA bereits hat.
  const displayPositions = useMemo<ChipPosition[]>(() => {
    const configured: ChipPosition[] = positions.map(p => ({ key: p.key, name: p.name, icon: p.icon, color: p.color }));
    const known = new Set(configured.map(p => p.key));
    const extra: ChipPosition[] = [primaryStation, ...secondaryStations]
      .filter(k => k && !known.has(k))
      .map(k => ({ key: k, name: positionDisplayName(positions, k) }));
    return [...configured, ...extra];
  }, [positions, primaryStation, secondaryStations]);

  return (
    <div className={cn(
      'rounded-lg border bg-card p-3 space-y-2 transition-colors',
      dirty ? 'border-amber-300 dark:border-amber-700' : '',
    )}>
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm">{emp.name}</span>
        <Badge variant="outline" className={cn('text-[10px] border', DEPT_BADGE_CLASS[emp.department])}>
          {DEPT_LABEL[emp.department]}
        </Badge>
        {emp.positionTitle && !primaryStation && (
          <span className="text-[10px] text-muted-foreground italic">
            Funktion bisher: {emp.positionTitle}
          </span>
        )}
        {dirty && (
          <Button
            size="sm"
            className="h-6 px-2 gap-1 text-xs ml-auto"
            onClick={handleSave}
            disabled={saving}
          >
            {saved ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            {saving ? 'Speichert…' : saved ? 'Gespeichert' : 'Speichern'}
          </Button>
        )}
        {!dirty && saved && <Check className="h-4 w-4 text-emerald-500 ml-auto" />}
      </div>

      {/* Position grid */}
      {displayPositions.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic">
          Keine Positionen konfiguriert — unter{' '}
          <Link to="/positionen" className="underline">Positionen</Link> anlegen.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {/* No station option */}
          <button
            onClick={() => selectPrimary('')}
            className={cn(
              'px-2 py-0.5 rounded border text-xs font-medium transition-colors',
              !primaryStation
                ? 'bg-muted text-muted-foreground border-border ring-1 ring-border'
                : 'bg-muted/30 text-muted-foreground/50 border-border/50 hover:bg-muted/60',
            )}
            title="Keine Hauptposition"
          >
            keine
          </button>

          {displayPositions.map(pos => {
            const isPrimary   = primaryStation === pos.key;
            const isSecondary = !isPrimary && secondaryStations.includes(pos.key);
            return (
              <StationChip
                key={pos.key}
                pos={pos}
                active={isSecondary}
                isPrimary={isPrimary}
                onClick={() => {
                  if (isPrimary) {
                    setPrimaryStation('');
                  } else if (isSecondary) {
                    toggleSecondary(pos.key);
                  } else if (!primaryStation) {
                    selectPrimary(pos.key);
                  } else {
                    toggleSecondary(pos.key);
                  }
                }}
              />
            );
          })}
        </div>
      )}

      {/* Legend (only if employee has something assigned) */}
      {(primaryStation || secondaryStations.length > 0) && (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {primaryStation && <><span className="font-semibold">★ Haupt:</span> {positionDisplayName(positions, primaryStation)}</>}
          {primaryStation && secondaryStations.length > 0 && ' · '}
          {secondaryStations.length > 0 && <><span className="font-semibold">✓ Zweit:</span> {secondaryStations.map(k => positionDisplayName(positions, k)).join(', ')}</>}
        </p>
      )}
    </div>
  );
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

export function StationMatrixDialog({ open, onClose, employees, onEmployeeUpdated }: Props) {
  const { tenantId } = useTenant();
  const { positions } = usePositions();
  const [filter, setFilter]       = useState<'all' | Department>('all');
  const [search, setSearch]       = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => { if (open) setSearch(''); }, [open]);

  const handleSave = useCallback(async (updated: Employee) => {
    const ok = await upsertEmployee(updated, tenantId);
    if (!ok) throw new Error('Speichern fehlgeschlagen — bitte erneut versuchen.');
    onEmployeeUpdated(updated);
  }, [onEmployeeUpdated, tenantId]);

  const filtered = useMemo(() => {
    return employees
      .filter(e => filter === 'all' || e.department === filter)
      .filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [employees, filter, search]);

  const byDept = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of filtered) {
      if (!map[e.department]) map[e.department] = [];
      map[e.department].push(e);
    }
    return map;
  }, [filtered]);

  const positionsByDept = useMemo(() => ({
    service: positionsForDepartment(positions, 'service', { activeOnly: true }),
    'küche': positionsForDepartment(positions, 'küche', { activeOnly: true }),
  }), [positions]);

  const toggleCollapse = (dept: string) =>
    setCollapsed(prev => ({ ...prev, [dept]: !prev[dept] }));

  const totalAssigned = employees.filter(e => e.primaryStation).length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutGrid className="h-5 w-5 text-violet-500" />
            Positionen &amp; Funktionen
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Haupt- und Zweitpositionen der Mitarbeitenden — {totalAssigned} von {employees.length} mit Hauptposition
          </DialogDescription>
        </DialogHeader>

        {/* Legend */}
        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground shrink-0 items-center">
          <span className="px-1.5 py-0.5 bg-primary text-primary-foreground rounded text-[10px] font-medium">★ Hauptposition</span>
          <span>— erste Wahl beim Einplanen. Ersatz nur aus gleicher Position oder</span>
          <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-300 rounded text-[10px] font-medium">✓ Zweitposition</span>
          <span>— kann einspringen.</span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex gap-1">
            {(['all', 'service', 'küche'] as const).map(d => (
              <button
                key={d}
                onClick={() => setFilter(d)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                  filter === d
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
                )}
              >
                {d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche'}
              </button>
            ))}
          </div>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Name suchen…"
            className="h-7 text-sm flex-1"
          />
        </div>

        {/* Employee list */}
        <div className="overflow-y-auto flex-1 min-h-0 space-y-4 pr-0.5">
          {Object.entries(byDept).map(([dept, emps]) => (
            <div key={dept}>
              <button
                onClick={() => toggleCollapse(dept)}
                className="flex items-center gap-2 mb-2 w-full text-left"
              >
                {collapsed[dept]
                  ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                }
                <span className={cn(
                  'text-[10px] font-bold uppercase tracking-wide',
                  dept === 'service' ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400',
                )}>
                  {dept === 'service' ? 'Service' : 'Küche'} ({emps.length})
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  {emps.filter(e => e.primaryStation).length} mit Hauptposition
                </span>
              </button>

              {!collapsed[dept] && (
                <div className="space-y-2">
                  {emps.map(emp => (
                    <EmployeeStationRow
                      key={emp.id}
                      emp={emp}
                      positions={positionsByDept[emp.department as Department] ?? []}
                      onSave={handleSave}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="text-center py-8">
              <LayoutGrid className="h-8 w-8 text-muted-foreground mx-auto opacity-30 mb-2" />
              <p className="text-sm text-muted-foreground">Keine Mitarbeitenden gefunden</p>
            </div>
          )}

          {/* Instruction box */}
          <div className="rounded-lg border bg-muted/20 p-3 space-y-1 text-[10px] text-muted-foreground">
            <p className="flex items-start gap-1.5">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                <strong>Klick</strong> auf eine Position ohne Zuweisung → wird Hauptposition (wenn noch keine gesetzt) oder Zweitposition.
                Klick auf die <strong>Hauptposition</strong> → deselektieren. Klick auf <strong>✓ Zweitposition</strong> → entfernen.
                Positionen werden unter <Link to="/positionen" className="underline">Positionen</Link> verwaltet.
              </span>
            </p>
          </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Positionen werden in der Planungshilfe für Ersatzvorschläge verwendet
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
