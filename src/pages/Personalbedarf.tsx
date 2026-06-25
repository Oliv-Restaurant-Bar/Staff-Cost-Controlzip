/**
 * Personalbedarf — SOLL-Besetzung je Saison × Wochentag.
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin-Seite (Route /personalbedarf, canAccessModule('personalbedarf')).
 *
 * Pro (Saison × Wochentag) wird für jede Position (hierarchisch Abteilung →
 * Bereich → Position, gespeist aus der Positionsverwaltung) EINE oder MEHRERE
 * Schichten definiert: Schichtbeginn, Schichtende, Anzahl benötigte
 * Mitarbeitende. Reihenfolge = Anzeige-/Speicherreihenfolge der Schichten.
 *
 * Die Vorlagen sind VOLLSTÄNDIG GETRENNT von der Dienstplanung gespeichert
 * (Tabelle staffing_requirements). Diese Seite enthält BEWUSST KEINE
 * Besetzungs-Prüfung/Warnungen/Vorschläge/Budget — das ist ein späterer Schritt.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ClipboardList, Plus, Trash2, AlertTriangle, Save, RotateCcw, Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { usePositions } from '@/hooks/usePositions';
import { useStaffingRequirements } from '@/hooks/useStaffingRequirements';
import { usePermissions } from '@/hooks/usePermissions';
import { DEPT_LABEL, DEPT_BADGE_CLASS } from '@/lib/station-config';
import { DEPT_DEFAULT_COLOR } from '@/lib/position-utils';
import { PositionIcon } from '@/components/PositionIcon';
import type { StaffingSeason, StaffingRequirementDraft, StaffingScope } from '@/types/staffing';
import {
  SEASONS,
  DEFAULT_SEASON,
  SCOPE_WEEKLY,
  WEEKDAYS,
  seasonLabel,
  weekdayLabel,
  defaultShiftDraft,
  validateShiftDraft,
  shiftsForScope,
  totalRequired,
  buildRequirementMatrix,
  type ShiftDraft,
} from '@/lib/staffing-requirements-utils';

/** Aktueller ISO-Wochentag (1 = Mo … 7 = So). */
function currentIsoWeekday(): number {
  const d = new Date().getDay(); // 0 = So … 6 = Sa
  return d === 0 ? 7 : d;
}

type EditsMap = Record<string, ShiftDraft[]>;

/** Serialisiert die Edits (ohne id) für den Dirty-Vergleich. */
function serializeEdits(edits: EditsMap): string {
  const keys = Object.keys(edits).sort();
  return JSON.stringify(
    keys.map((k) => [k, edits[k].map((s) => [s.shiftStart, s.shiftEnd, s.requiredCount])]),
  );
}

export default function Personalbedarf() {
  const { canAccessModule, isGuest } = usePermissions();
  const { positions, loading: posLoading, error: posError } = usePositions();
  const { requirements, loading: reqLoading, error: reqError, saveScope } = useStaffingRequirements();

  const [season, setSeason] = useState<StaffingSeason>(DEFAULT_SEASON);
  const [weekday, setWeekday] = useState<number>(currentIsoWeekday());
  const [edits, setEdits] = useState<EditsMap>({});
  const [baselineKey, setBaselineKey] = useState<string>('[]');
  const [busy, setBusy] = useState(false);

  const readOnly = isGuest;
  const loading = posLoading || reqLoading;

  // Hierarchie (Abteilung → Bereich → Position) für den aktiven Bereich.
  const matrix = useMemo(
    () => buildRequirementMatrix(positions, requirements, season, weekday),
    [positions, requirements, season, weekday],
  );

  // Aktive (= angezeigte) Positions-Keys dieses Bereichs.
  const visibleKeys = useMemo(() => {
    const set = new Set<string>();
    for (const dep of matrix) for (const area of dep.areas) for (const pr of area.positions) set.add(pr.position.key);
    return set;
  }, [matrix]);

  // Schichten von NICHT angezeigten Positionen (inaktiv/gelöscht) dieses
  // Bereichs — werden beim Speichern UNVERÄNDERT erhalten (kein stilles Löschen).
  const orphanShifts = useMemo(
    () => shiftsForScope(requirements, season, weekday).filter((r) => !visibleKeys.has(r.positionKey)),
    [requirements, season, weekday, visibleKeys],
  );

  // Edits aus den geladenen Daten (neu) aufbauen, wenn sich Bereich/Daten ändern.
  const scopeSig = `${season}|${weekday}`;
  const lastSig = useRef<string>('');
  useEffect(() => {
    const next: EditsMap = {};
    for (const dep of matrix) {
      for (const area of dep.areas) {
        for (const pr of area.positions) {
          next[pr.position.key] = pr.shifts.map((s) => ({
            id: s.id,
            shiftStart: s.shiftStart,
            shiftEnd: s.shiftEnd,
            requiredCount: s.requiredCount,
          }));
        }
      }
    }
    setEdits(next);
    setBaselineKey(serializeEdits(next));
    lastSig.current = scopeSig;
    // matrix kapselt positions+requirements+season+weekday bereits.
  }, [matrix, scopeSig]);

  const dirty = serializeEdits(edits) !== baselineKey;

  if (!canAccessModule('personalbedarf')) {
    return <Navigate to="/personal" replace />;
  }

  // ── Edit-Operationen ────────────────────────────────────────────────────────

  const addShift = (key: string) => {
    setEdits((e) => ({ ...e, [key]: [...(e[key] ?? []), defaultShiftDraft()] }));
  };

  const removeShift = (key: string, index: number) => {
    setEdits((e) => ({ ...e, [key]: (e[key] ?? []).filter((_, i) => i !== index) }));
  };

  const updateShift = (key: string, index: number, patch: Partial<ShiftDraft>) => {
    setEdits((e) => ({
      ...e,
      [key]: (e[key] ?? []).map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };

  const handleReset = () => {
    // baselineKey aus den aktuell geladenen Daten neu erzeugen.
    const next: EditsMap = {};
    for (const dep of matrix) {
      for (const area of dep.areas) {
        for (const pr of area.positions) {
          next[pr.position.key] = pr.shifts.map((s) => ({
            id: s.id, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, requiredCount: s.requiredCount,
          }));
        }
      }
    }
    setEdits(next);
    setBaselineKey(serializeEdits(next));
  };

  const handleSave = async () => {
    // 1) Validierung aller bearbeiteten Schichten.
    for (const [key, shifts] of Object.entries(edits)) {
      for (const s of shifts) {
        const errs = validateShiftDraft(s);
        if (errs.length > 0) {
          toast.error(`Ungültige Schicht (${key}): ${errs[0]}`);
          return;
        }
      }
    }

    const scope: StaffingScope = { scopeType: SCOPE_WEEKLY, season, weekday, scopeRef: null };

    // 2) Drafts aus den sichtbaren Positionen + erhaltene Orphan-Schichten.
    const drafts: (StaffingRequirementDraft & { id?: string })[] = [];
    for (const [key, shifts] of Object.entries(edits)) {
      shifts.forEach((s, index) => {
        drafts.push({
          id: s.id,
          scopeType: SCOPE_WEEKLY,
          season,
          weekday,
          scopeRef: null,
          positionKey: key,
          shiftStart: s.shiftStart,
          shiftEnd: s.shiftEnd,
          requiredCount: s.requiredCount,
          sortOrder: index,
          meta: {},
        });
      });
    }
    for (const o of orphanShifts) {
      drafts.push({
        id: o.id,
        scopeType: o.scopeType,
        season: o.season,
        weekday: o.weekday,
        scopeRef: o.scopeRef,
        positionKey: o.positionKey,
        shiftStart: o.shiftStart,
        shiftEnd: o.shiftEnd,
        requiredCount: o.requiredCount,
        sortOrder: o.sortOrder,
        meta: o.meta,
      });
    }

    setBusy(true);
    try {
      await saveScope(scope, drafts);
      toast.success(`Personalbedarf gespeichert (${seasonLabel(season)} · ${weekdayLabel(weekday)})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  // ── Tagessumme (rein informativ, KEINE Besetzungs-Prüfung) ──────────────────
  const dayTotal = useMemo(
    () => Object.values(edits).reduce((sum, shifts) => sum + shifts.reduce((a, s) => a + (Number.isFinite(s.requiredCount) ? s.requiredCount : 0), 0), 0),
    [edits],
  );

  const error = posError || reqError;
  const hasActivePositions = matrix.length > 0;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      {/* Kopf */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-violet-600" />
          <h1 className="text-lg font-semibold">Personalbedarf</h1>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="gap-1" onClick={handleReset} disabled={!dirty || busy}>
              <RotateCcw className="h-4 w-4" /> Verwerfen
            </Button>
            <Button size="sm" className="gap-1" onClick={handleSave} disabled={!dirty || busy}>
              <Save className="h-4 w-4" /> {busy ? 'Speichert…' : 'Speichern'}
            </Button>
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        SOLL-Besetzung je Saison und Wochentag. Pro Position lassen sich mehrere
        Schichten mit Beginn, Ende und benötigter Anzahl festlegen. Diese Vorlagen
        sind unabhängig von der Dienstplanung.
      </p>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Saison-Auswahl */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Saison</Label>
        <div className="flex flex-wrap gap-1.5">
          {SEASONS.map((s) => (
            <Button
              key={s.key}
              type="button"
              size="sm"
              variant={season === s.key ? 'default' : 'outline'}
              disabled={!s.available}
              title={!s.available ? 'Bald verfügbar' : undefined}
              onClick={() => s.available && setSeason(s.key)}
            >
              {s.label}{!s.available && ' (bald)'}
            </Button>
          ))}
        </div>
      </div>

      {/* Wochentag-Auswahl */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Wochentag</Label>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((w) => (
            <Button
              key={w.value}
              type="button"
              size="sm"
              variant={weekday === w.value ? 'default' : 'outline'}
              onClick={() => setWeekday(w.value)}
              className="min-w-[3rem]"
            >
              {w.short}
            </Button>
          ))}
        </div>
      </div>

      {/* Bereichs-Zusammenfassung (rein informativ) */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="h-4 w-4" />
        <span>{seasonLabel(season)} · {weekdayLabel(weekday)}</span>
        <Badge variant="secondary" className="ml-1">Benötigt gesamt: {dayTotal}</Badge>
        {dirty && <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">ungespeichert</Badge>}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Lädt…</p>}

      {!loading && !hasActivePositions && (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <ClipboardList className="h-8 w-8 text-muted-foreground mx-auto opacity-40" />
            <p className="text-sm text-muted-foreground">
              Keine aktiven Positionen vorhanden. Bitte zuerst Positionen anlegen.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/positionen">Zu den Positionen</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Hierarchie: Abteilung → Bereich → Position → Schichten */}
      {!loading && hasActivePositions && matrix.map((dep) => (
        <Card key={dep.department}>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm">
              <Badge variant="outline" className={cn('text-xs border', DEPT_BADGE_CLASS[dep.department])}>
                {DEPT_LABEL[dep.department]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-5">
            {dep.areas.map((area) => (
              <div key={area.area?.key ?? '__none__'} className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {area.area ? area.area.name : 'Ohne Bereich'}
                </h3>

                {area.positions.map((pr) => {
                  const p = pr.position;
                  const shifts = edits[p.key] ?? [];
                  const color = p.color ?? DEPT_DEFAULT_COLOR[p.department];
                  return (
                    <div key={p.key} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="flex items-center justify-center h-7 w-7 rounded-md shrink-0"
                          style={{ backgroundColor: color + '22', color }}
                        >
                          <PositionIcon name={p.icon} className="h-4 w-4" />
                        </span>
                        <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                        {shifts.length > 0 && (
                          <Badge variant="secondary" className="text-[10px]">
                            {shifts.length} {shifts.length === 1 ? 'Schicht' : 'Schichten'} · {shifts.reduce((a, s) => a + (Number.isFinite(s.requiredCount) ? s.requiredCount : 0), 0)} MA
                          </Badge>
                        )}
                      </div>

                      {shifts.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic pl-1">Keine Schicht definiert.</p>
                      ) : (
                        <div className="space-y-2">
                          {shifts.map((s, idx) => (
                            <div key={idx} className="flex flex-wrap items-end gap-2">
                              <div className="flex flex-col gap-0.5">
                                <Label className="text-[10px] text-muted-foreground">Beginn</Label>
                                <Input
                                  type="time"
                                  value={s.shiftStart}
                                  disabled={readOnly}
                                  onChange={(e) => updateShift(p.key, idx, { shiftStart: e.target.value })}
                                  className="h-8 w-[7.5rem] text-sm"
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <Label className="text-[10px] text-muted-foreground">Ende</Label>
                                <Input
                                  type="time"
                                  value={s.shiftEnd}
                                  disabled={readOnly}
                                  onChange={(e) => updateShift(p.key, idx, { shiftEnd: e.target.value })}
                                  className="h-8 w-[7.5rem] text-sm"
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <Label className="text-[10px] text-muted-foreground">Anzahl</Label>
                                <Input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={Number.isFinite(s.requiredCount) ? s.requiredCount : 0}
                                  disabled={readOnly}
                                  onChange={(e) => updateShift(p.key, idx, { requiredCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                                  className="h-8 w-[5rem] text-sm"
                                />
                              </div>
                              {!readOnly && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-600 hover:text-red-700"
                                  onClick={() => removeShift(p.key, idx)}
                                  title="Schicht entfernen"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {!readOnly && (
                        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => addShift(p.key)}>
                          <Plus className="h-3.5 w-3.5" /> Schicht hinzufügen
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
