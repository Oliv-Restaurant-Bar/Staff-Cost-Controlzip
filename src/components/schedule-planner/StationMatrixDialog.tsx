/**
 * StationMatrixDialog
 * ──────────────────────────────────────────────────────────────────────────────
 * Zeigt alle Mitarbeiter mit ihren Station-Zuweisungen.
 * Jede Person kann eine Hauptstation und mehrere Zweitstationen haben.
 * Änderungen werden sofort gespeichert.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LayoutGrid, Check, Plus, X, Save, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee, Department } from '@/types/personnel';
import { upsertEmployee } from '@/lib/supabase-db';
import { getStationsForDept, DEPT_BADGE_CLASS, DEPT_LABEL } from '@/lib/station-config';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  onEmployeeUpdated: (emp: Employee) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StationChip({
  label, active, isPrimary, onClick, disabled,
}: {
  label: string;
  active: boolean;
  isPrimary?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={isPrimary ? 'Hauptstation' : active ? 'Zweitstation aktiv — klicken zum Entfernen' : 'Als Zweitstation hinzufügen'}
      className={cn(
        'px-2 py-0.5 rounded border text-xs font-medium transition-colors leading-none',
        disabled ? 'cursor-not-allowed opacity-50' :
        isPrimary
          ? 'bg-primary text-primary-foreground border-primary'
          : active
            ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700 hover:bg-emerald-200'
            : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
      )}
    >
      {isPrimary && <span className="mr-0.5 text-[8px]">★</span>}
      {label}
      {active && !isPrimary && <span className="ml-1 text-[8px] opacity-70">✓</span>}
    </button>
  );
}

// ─── Employee Row ─────────────────────────────────────────────────────────────

function EmployeeStationRow({
  emp, allStations, onSave,
}: {
  emp: Employee;
  allStations: string[];
  onSave: (updated: Employee) => Promise<void>;
}) {
  const [primaryStation, setPrimaryStation]       = useState(emp.primaryStation ?? '');
  const [secondaryStations, setSecondaryStations] = useState<string[]>(emp.secondaryStations ?? []);
  const [customInput, setCustomInput]             = useState('');
  const [showCustom, setShowCustom]               = useState(false);
  const [saving, setSaving]                       = useState(false);
  const [saved, setSaved]                         = useState(false);

  const dirty =
    primaryStation !== (emp.primaryStation ?? '') ||
    JSON.stringify([...secondaryStations].sort()) !== JSON.stringify([...(emp.secondaryStations ?? [])].sort());

  const handleSave = async () => {
    setSaving(true);
    const updated: Employee = {
      ...emp,
      primaryStation: primaryStation.trim() || undefined,
      secondaryStations: secondaryStations.length > 0 ? secondaryStations : undefined,
    };
    await onSave(updated);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const toggleSecondary = (station: string) => {
    if (station === primaryStation) return; // can't be both
    setSecondaryStations(prev =>
      prev.includes(station) ? prev.filter(s => s !== station) : [...prev, station],
    );
  };

  const selectPrimary = (station: string) => {
    setPrimaryStation(station);
    // Remove from secondary if present
    setSecondaryStations(prev => prev.filter(s => s !== station));
  };

  const addCustomStation = () => {
    const s = customInput.trim();
    if (!s || allStations.includes(s)) { setCustomInput(''); setShowCustom(false); return; }
    // Add to secondary by default
    setSecondaryStations(prev => [...prev, s]);
    setCustomInput('');
    setShowCustom(false);
  };

  // All displayed stations = predefined + any custom ones this employee already has
  const displayStations = useMemo(() => {
    const custom = [...secondaryStations, primaryStation]
      .filter(s => s && !allStations.includes(s));
    return [...allStations, ...custom];
  }, [allStations, secondaryStations, primaryStation]);

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
        {emp.positionTitle && !emp.primaryStation && (
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

      {/* Station grid */}
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
          title="Keine Hauptstation"
        >
          keine
        </button>

        {displayStations.map(station => {
          const isPrimary   = primaryStation === station;
          const isSecondary = !isPrimary && secondaryStations.includes(station);
          return (
            <StationChip
              key={station}
              label={station}
              active={isSecondary}
              isPrimary={isPrimary}
              onClick={() => {
                if (isPrimary) {
                  // clicking primary → deselect (make it available as secondary)
                  setPrimaryStation('');
                } else if (isSecondary) {
                  toggleSecondary(station);
                } else {
                  // Not yet assigned — first click → set as primary if none set
                  if (!primaryStation) {
                    selectPrimary(station);
                  } else {
                    toggleSecondary(station);
                  }
                }
              }}
            />
          );
        })}

        {/* Custom station add */}
        {showCustom ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addCustomStation(); if (e.key === 'Escape') setShowCustom(false); }}
              className="h-6 w-28 text-xs px-1.5"
              placeholder="Station…"
            />
            <button onClick={addCustomStation} className="text-emerald-600 hover:text-emerald-700">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setShowCustom(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowCustom(true)}
            className="px-1.5 py-0.5 rounded border border-dashed border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
          >
            <Plus className="h-3 w-3 inline" /> eigene
          </button>
        )}
      </div>

      {/* Legend (only if employee has something assigned) */}
      {(primaryStation || secondaryStations.length > 0) && (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {primaryStation && <><span className="font-semibold">★ Haupt:</span> {primaryStation}</>}
          {primaryStation && secondaryStations.length > 0 && ' · '}
          {secondaryStations.length > 0 && <><span className="font-semibold">✓ Zweit:</span> {secondaryStations.join(', ')}</>}
        </p>
      )}
    </div>
  );
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────

export function StationMatrixDialog({ open, onClose, employees, onEmployeeUpdated }: Props) {
  const [filter, setFilter]       = useState<'all' | Department>('all');
  const [search, setSearch]       = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => { if (open) setSearch(''); }, [open]);

  const handleSave = useCallback(async (updated: Employee) => {
    await upsertEmployee(updated);
    onEmployeeUpdated(updated);
  }, [onEmployeeUpdated]);

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

  // Collect all custom stations currently used (so they appear in every row)
  const allStationsByDept = useMemo(() => {
    const result: Record<Department, string[]> = { service: [], küche: [] };
    for (const dept of ['service', 'küche'] as Department[]) {
      const custom: string[] = [];
      for (const emp of employees.filter(e => e.department === dept)) {
        if (emp.primaryStation) custom.push(emp.primaryStation);
        for (const s of emp.secondaryStations ?? []) custom.push(s);
      }
      result[dept] = getStationsForDept(dept, custom);
    }
    return result;
  }, [employees]);

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
            Stationen & Funktionen
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Haupt- und Zweitstationen der Mitarbeitenden — {totalAssigned} von {employees.length} mit Hauptstation
          </DialogDescription>
        </DialogHeader>

        {/* Legend */}
        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground shrink-0 items-center">
          <span className="px-1.5 py-0.5 bg-primary text-primary-foreground rounded text-[10px] font-medium">★ Hauptstation</span>
          <span>— erste Wahl beim Einplanen. Ersatz nur aus gleicher Station oder</span>
          <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-300 rounded text-[10px] font-medium">✓ Zweitstation</span>
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
                  {emps.filter(e => e.primaryStation).length} mit Hauptstation
                </span>
              </button>

              {!collapsed[dept] && (
                <div className="space-y-2">
                  {emps.map(emp => (
                    <EmployeeStationRow
                      key={emp.id}
                      emp={emp}
                      allStations={allStationsByDept[emp.department as Department] ?? []}
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
                <strong>Klick</strong> auf eine Station ohne Zuweisung → wird Hauptstation (wenn noch keine gesetzt) oder Zweitstation.
                Klick auf die <strong>Hauptstation</strong> → deselektieren. Klick auf <strong>✓ Zweitstation</strong> → entfernen.
                Änderungen werden erst nach Klick auf «Speichern» übernommen.
              </span>
            </p>
          </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Stationen werden in der Planungshilfe für Ersatzvorschläge verwendet
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
