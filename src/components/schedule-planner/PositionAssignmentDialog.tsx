/**
 * Positions-Pop-up «Position: <Name>» — zeigt und bearbeitet, welche
 * Mitarbeiter eine Position/Qualifikation innehaben.
 *
 * SSOT: Dieselbe Zuordnung wie Personalstamm → «Positionen/Qualifikationen»
 * (Employee.primaryStation / secondaryStations, Keys = Position.key).
 * Es wird KEINE parallele Zweitliste geführt.
 *
 * Merge-Verhalten: Beim Öffnen und vor jeder Änderung frisch aus der DB lesen;
 * geschrieben werden NUR die Stationsfelder des betroffenen Mitarbeiters
 * (updateEmployeeStations) — parallele Änderungen an anderen Feldern/MA bleiben
 * unberührt. Mandantentrennung via loadEmployees(tenantId) (ID-Präfix).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Info, Loader2, Plus, Star, X } from 'lucide-react';
import { toast } from 'sonner';
import { loadEmployees, updateEmployeeStations } from '@/lib/supabase-db';
import type { Employee, EmploymentType } from '@/types/personnel';
import type { TenantId } from '@/contexts/TenantContext';

const TYPE_LABEL: Record<EmploymentType, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob:  'Minijob',
  aushilfe: 'Aushilfe',
};

const DEPT_LABEL: Record<string, string> = {
  service: 'Service',
  küche:   'Küche',
  kueche:  'Küche',
};

export function PositionAssignmentDialog({
  open, onOpenChange, positionKey, positionName, tenantId, readOnly, dynamicRuleHint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionKey: string | null;
  positionName: string;
  tenantId: TenantId;
  /** Gäste dürfen nur ansehen. */
  readOnly?: boolean;
  /** Hinweistext bei Positionen mit dynamischer Regel (CdS, Kalt/Sushi). */
  dynamicRuleHint?: string | null;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Zweistufiges Entfernen: erste × klickt an, zweiter Klick bestätigt. */
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [addId, setAddId] = useState<string>('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await loadEmployees(tenantId);
      if (fresh) setEmployees(fresh);
      else toast.error('Mitarbeiter konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (open && positionKey) {
      setConfirmRemoveId(null);
      setAddId('');
      void reload();
    }
  }, [open, positionKey, reload]);

  const hasKey = useCallback((e: Employee): boolean => {
    if (!positionKey) return false;
    return e.primaryStation === positionKey || (e.secondaryStations ?? []).includes(positionKey);
  }, [positionKey]);

  const assigned = useMemo(
    () => employees.filter(hasKey).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees, hasKey],
  );
  const available = useMemo(
    () => employees.filter((e) => !hasKey(e)).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees, hasKey],
  );

  /** Entfernen: Position aus primary/secondary des MA löschen (frisch gemergt). */
  const handleRemove = async (empId: string) => {
    if (!positionKey) return;
    setBusyId(empId);
    try {
      // Frisch lesen → parallele Änderungen nicht überschreiben.
      const fresh = await loadEmployees(tenantId);
      const emp = fresh?.find((e) => e.id === empId);
      if (!emp) { toast.error('Mitarbeiter nicht gefunden.'); return; }
      const patch: { primaryStation?: string; secondaryStations?: string[] } = {};
      if (emp.primaryStation === positionKey) patch.primaryStation = '';
      const sec = emp.secondaryStations ?? [];
      if (sec.includes(positionKey)) patch.secondaryStations = sec.filter((k) => k !== positionKey);
      if (Object.keys(patch).length === 0) { await reload(); return; }
      const res = await updateEmployeeStations(empId, patch, tenantId);
      if (!res.ok) { toast.error(`Entfernen fehlgeschlagen: ${res.error}`); return; }
      toast.success(`${emp.name}: Position «${positionName}» entfernt.`);
      if (fresh) setEmployees(fresh.map((e) => (e.id === empId ? { ...e, ...patch } : e)));
    } finally {
      setBusyId(null);
      setConfirmRemoveId(null);
    }
  };

  /** Zuordnen: Position als zusätzliche Qualifikation (secondaryStations) eintragen. */
  const handleAdd = async () => {
    if (!positionKey || !addId) return;
    setBusyId(addId);
    try {
      const fresh = await loadEmployees(tenantId);
      const emp = fresh?.find((e) => e.id === addId);
      if (!emp) { toast.error('Mitarbeiter nicht gefunden.'); return; }
      if (emp.primaryStation === positionKey || (emp.secondaryStations ?? []).includes(positionKey)) {
        toast.info(`${emp.name} hat diese Position bereits.`);
        if (fresh) setEmployees(fresh);
        return;
      }
      const nextSec = [...(emp.secondaryStations ?? []), positionKey];
      const res = await updateEmployeeStations(addId, { secondaryStations: nextSec }, tenantId);
      if (!res.ok) { toast.error(`Zuordnen fehlgeschlagen: ${res.error}`); return; }
      toast.success(`${emp.name}: Position «${positionName}» zugeordnet.`);
      if (fresh) setEmployees(fresh.map((e) => (e.id === addId ? { ...e, secondaryStations: nextSec } : e)));
      setAddId('');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="position-assignment-dialog">
        <DialogHeader>
          <DialogTitle>Position: {positionName}</DialogTitle>
          <DialogDescription>
            Zuordnung wie im Personalstamm unter «Positionen/Qualifikationen» —
            Änderungen wirken sofort überall (Personalstamm, Dienstplan-Vorschläge).
          </DialogDescription>
        </DialogHeader>

        {dynamicRuleHint && (
          <div className="flex items-start gap-2 rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/20 px-3 py-2 text-xs">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-sky-600" />
            <span>{dynamicRuleHint}</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lädt…
          </div>
        ) : (
          <>
            <div className="space-y-1 max-h-[45vh] overflow-y-auto pr-1" data-testid="position-assigned-list">
              {assigned.length === 0 && (
                <p className="text-sm text-muted-foreground italic py-2">
                  Kein Mitarbeiter hat diese Position hinterlegt.
                </p>
              )}
              {assigned.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                  data-testid={`position-emp-${e.id}`}
                >
                  <span className="font-medium truncate">{e.name}</span>
                  {e.primaryStation === positionKey && (
                    <Badge variant="secondary" className="gap-0.5 text-[10px] shrink-0" title="Hauptposition">
                      <Star className="h-2.5 w-2.5" /> Haupt
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground truncate">
                    {DEPT_LABEL[e.department] ?? e.department} · {TYPE_LABEL[e.employmentType] ?? e.employmentType}
                  </span>
                  {!readOnly && (
                    confirmRemoveId === e.id ? (
                      <span className="ml-auto flex items-center gap-1 shrink-0">
                        <Button size="sm" variant="destructive" className="h-6 px-2 text-xs"
                          disabled={busyId === e.id}
                          onClick={() => handleRemove(e.id)}
                          data-testid={`confirm-remove-${e.id}`}>
                          {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Entfernen?'}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                          onClick={() => setConfirmRemoveId(null)}>
                          Abbrechen
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="icon" variant="ghost"
                        className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                        title={`«${positionName}» bei ${e.name} entfernen`}
                        onClick={() => setConfirmRemoveId(e.id)}
                        data-testid={`remove-emp-${e.id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )
                  )}
                </div>
              ))}
            </div>

            {!readOnly && (
              <div className="flex items-center gap-2 pt-1 border-t mt-1">
                <Select value={addId} onValueChange={setAddId}>
                  <SelectTrigger className="h-8 text-sm flex-1" data-testid="add-emp-select">
                    <SelectValue placeholder="Mitarbeiter zuordnen…" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground italic">
                        Alle Mitarbeiter haben diese Position bereits.
                      </div>
                    )}
                    {available.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name} · {DEPT_LABEL[e.department] ?? e.department}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-8 gap-1" disabled={!addId || busyId != null}
                  onClick={handleAdd} data-testid="add-emp-button">
                  {busyId === addId && addId !== '' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Hinzufügen
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
