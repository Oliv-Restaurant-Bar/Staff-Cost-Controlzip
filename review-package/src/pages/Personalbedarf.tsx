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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ClipboardList, Plus, Trash2, AlertTriangle, Save, RotateCcw, Clock, Lock, Unlock, Coins,
  ChevronLeft, ChevronRight, Settings2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { usePositions } from '@/hooks/usePositions';
import { useStaffingRequirements } from '@/hooks/useStaffingRequirements';
import { useStaffingProfiles } from '@/hooks/useStaffingProfiles';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  isProfileLocked,
  isValidMonthDay,
  profileKeyFromLabel,
  profileByKey,
  dataSeasonForProfile,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';
import { nettoSegmentMinutes } from '@/lib/staffing-check-utils';
import { loadStaffingProfilesConfig } from '@/lib/staffing-profiles-db';
import { loadStaffingRequirements } from '@/lib/staffing-requirements-db';
import { buildCellSaveDrafts, buildWeekOverview, isEveningShift, explicitDayHeadcount } from '@/lib/staffing-week-utils';
import { StaffingWeekSummary } from '@/components/schedule-planner/StaffingWeekSummary';
import { WeekCompareTiles, WeekCompareMatrix, WeekHoursTable } from '@/components/schedule-planner/StaffingWeekCompare';
import { buildWeekCompare } from '@/lib/staffing-week-compare';
import { useUgEventDays } from '@/hooks/useUgEventDays';
import type { Employee } from '@/types/personnel';
import type { DaySchedule, ActualHourEntry } from '@/lib/supabase-db';
import { PastScheduleSuggestionCard } from '@/components/schedule-planner/PastScheduleSuggestionCard';
import { StaffingWeekMatrix, type WeekHoursStack, type WeekCellMode } from '@/components/schedule-planner/StaffingWeekMatrix';
import { loadEmployees, loadScheduleForMonth, loadActualHoursForMonth } from '@/lib/supabase-db';
import {
  format, startOfWeek, addDays, parseISO, isValid, getISOWeek,
  addMonths, startOfMonth, endOfMonth, eachDayOfInterval,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { UgSurchargeDialog } from '@/components/schedule-planner/UgSurchargeDialog';
import { PositionAssignmentDialog } from '@/components/schedule-planner/PositionAssignmentDialog';
import { WeekCompareCellDialog } from '@/components/schedule-planner/WeekCompareCellDialog';
import { fetchOpenProposals, type SchedulePlanProposal } from '@/lib/schedule-proposal-store';
import { DEPT_LABEL, DEPT_BADGE_CLASS } from '@/lib/station-config';
import { DEPT_DEFAULT_COLOR } from '@/lib/position-utils';
import { PositionIcon } from '@/components/PositionIcon';
import { StaffingScheduleCheckCard } from '@/components/schedule-planner/StaffingScheduleCheckCard';
import type { StaffingSeason, StaffingRequirementDraft, StaffingScope } from '@/types/staffing';
import {
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
/**
 * Hinweistext für Positionen mit dynamischer Besetzungs-Regel (Positions-Pop-up):
 * Die Liste im Pop-up zeigt die grundsätzlich qualifizierten Mitarbeiter —
 * die konkrete Tagesbesetzung wird zusätzlich per Regel bestimmt.
 */
function dynamicRuleHintFor(positionKey: string, config: StaffingProfilesConfig): string | null {
  const k = positionKey.toLowerCase();
  if ((k.includes('kalt') || k.includes('sushi')) && config.kitchenCold) {
    return 'Diese Position hat eine dynamische Regel (Kalte Küche/Sushi): Die konkrete Tagesbesetzung wird zusätzlich über die Stationsregel (Stamm/Vertretung, Herd-Köche-Schwelle) bestimmt. Die Liste hier zeigt die grundsätzlich qualifizierten Mitarbeiter.';
  }
  if (k === 'service' && config.cdsPriority.length > 0) {
    return 'Diese Position hat eine dynamische Regel (Chef de Service): Die konkrete Tagesbesetzung wird zusätzlich über die CdS-Prioritätsliste bestimmt. Die Liste hier zeigt die grundsätzlich qualifizierten Mitarbeiter.';
  }
  return null;
}

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
  const { canAccessModule } = usePermissions();
  const { tenantId } = useTenant();
  const { positions, loading: posLoading, error: posError } = usePositions();
  const { requirements, loading: reqLoading, error: reqError, saveScope } = useStaffingRequirements();
  const { config: profilesConfig, save: saveProfilesConfig } = useStaffingProfiles();

  const [season, setSeason] = useState<StaffingSeason>(DEFAULT_SEASON);
  const [weekday, setWeekday] = useState<number>(currentIsoWeekday());
  /** Ansicht: «Ganze Woche» (Standard, nur Anzeige) oder «Einzelner Tag» (Editor). */
  const [viewMode, setViewMode] = useState<'week' | 'day'>('week');
  const [edits, setEdits] = useState<EditsMap>({});
  const [baselineKey, setBaselineKey] = useState<string>('[]');
  const [busy, setBusy] = useState(false);

  // ── Stunden-Stapel der Wochenübersicht (Dienstplan/Ist einer Kalenderwoche) ─
  // Bedarf ist wochentags-generisch; Dienstplan-Plan und Ist (MIRUS) brauchen
  // eine KONKRETE Kalenderwoche (Default: aktuelle Woche, Montag).
  const [weekAnchor, setWeekAnchor] = useState<string>(() =>
    format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  /** Vergleichszeitraum der Kacheln: Woche (Default) oder ganzer Monat. */
  const [periodMode, setPeriodMode] = useState<'week' | 'month'>('week');
  /** Pop-up «UG konfigurieren». */
  const [ugDialogOpen, setUgDialogOpen] = useState(false);
  /**
   * Mitarbeiterliste für die CdS-Prioritätenliste im Dialog — unabhängig vom
   * (nur in der Wochenansicht geladenen) weekData, damit die Regel auch aus
   * der Tagesansicht heraus konfigurierbar ist.
   */
  const [dialogEmployees, setDialogEmployees] = useState<Employee[]>([]);
  useEffect(() => {
    if (!ugDialogOpen) return;
    let cancelled = false;
    loadEmployees(tenantId)
      .then((emps) => { if (!cancelled) setDialogEmployees(emps ?? []); })
      .catch(() => { /* best-effort: weekData-Rückfall unten */ });
    return () => { cancelled = true; };
  }, [ugDialogOpen, tenantId]);
  /** Positions-Pop-up: Mitarbeiter zuordnen/entfernen (SSOT Personalstamm). */
  const [positionDialog, setPositionDialog] = useState<{ key: string; name: string } | null>(null);
  /** Zell-Detail «Bedarf vs. Planung» (Position × Tag, read-only). */
  const [cellDialog, setCellDialog] = useState<{ positionKey: string; dateStr: string } | null>(null);
  /** Offene Dienstplan-Vorschläge (Marker in der Matrix + Zell-Pop-up-Aktionen). */
  const [openProposals, setOpenProposals] = useState<SchedulePlanProposal[]>([]);
  const [proposalsVersion, setProposalsVersion] = useState(0);
  /** Roh-Daten der gewählten Kalenderwoche (Dienstplan/Ist), read-only geladen. */
  const [weekData, setWeekData] = useState<{
    employees: Employee[];
    scheduleData: Record<string, DaySchedule>;
    actualData: Record<string, ActualHourEntry>;
  } | null>(null);
  /** Einzeltag-Detail (Klick auf eine Tagesspalte der Wochenansichten). */
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const { eventDays } = useUgEventDays();
  /** Zellen-Anzeige der Wochenmatrix: Personen | Stunden (bleibt beim Wechsel
   *  von Wochentag/Woche/Profil erhalten — Page-State). */
  const [cellMode, setCellMode] = useState<WeekCellMode>('persons');
  /** Wochenübersicht des aktiven Profils (effektiver Bedarf inkl. UG-Zuschlag)
   *  für Kacheln + «Personal pro Tag»-Diagramm. */
  const weekOverview = useMemo(
    () => buildWeekOverview({ positions, requirements, config: profilesConfig, season }),
    [positions, requirements, profilesConfig, season],
  );

  /** Mo–So-Daten (yyyy-MM-dd) der gewählten Kalenderwoche. */
  const weekDates = useMemo(() => {
    const anchor = parseISO(weekAnchor);
    if (!isValid(anchor)) return null;
    const monday = startOfWeek(anchor, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => format(addDays(monday, i), 'yyyy-MM-dd'));
  }, [weekAnchor]);

  const weekLabel = useMemo(() => {
    if (!weekDates) return null;
    const monday = parseISO(weekDates[0]);
    const sunday = parseISO(weekDates[6]);
    return `KW ${getISOWeek(monday)} · ${format(monday, 'dd.MM.')}–${format(sunday, 'dd.MM.yyyy')}`;
  }, [weekDates]);

  /** Alle Kalendertage des Anker-Monats (Vergleichsmodus «Monat»). */
  const monthDates = useMemo(() => {
    const anchor = parseISO(weekAnchor);
    if (!isValid(anchor)) return null;
    return eachDayOfInterval({ start: startOfMonth(anchor), end: endOfMonth(anchor) })
      .map((d) => format(d, 'yyyy-MM-dd'));
  }, [weekAnchor]);

  /** Datumsliste des VERGLEICHSZEITRAUMS (Kacheln): Woche oder ganzer Monat. */
  const compareDates = periodMode === 'week' ? weekDates : monthDates;

  /** Anzeige-Label des Vergleichszeitraums. */
  const periodLabel = useMemo(() => {
    if (periodMode === 'week') return weekLabel;
    const anchor = parseISO(weekAnchor);
    return isValid(anchor) ? format(anchor, 'LLLL yyyy', { locale: de }) : null;
  }, [periodMode, weekLabel, weekAnchor]);

  /** Pfeile: eine Periode zurück/vor (Woche ±7 Tage, Monat ±1 Monat). */
  const shiftPeriod = (dir: -1 | 1) => {
    const anchor = parseISO(weekAnchor);
    if (!isValid(anchor)) return;
    const next = periodMode === 'week'
      ? addDays(startOfWeek(anchor, { weekStartsOn: 1 }), dir * 7)
      : startOfMonth(addMonths(anchor, dir));
    setWeekAnchor(format(next, 'yyyy-MM-dd'));
  };

  useEffect(() => {
    if (viewMode !== 'week') return;
    if (!compareDates) { setWeekData(null); return; }
    // Berührte Monate (Woche kann Monatsgrenze überschreiten).
    const months = [...new Set(compareDates.map((d) => d.slice(0, 7)))]
      .map((ym) => parseISO(`${ym}-01`));
    let cancelled = false;
    (async () => {
      try {
        const [emps, schedules, actuals] = await Promise.all([
          loadEmployees(tenantId),
          Promise.all(months.map((m) => loadScheduleForMonth(m, tenantId))),
          Promise.all(months.map((m) => loadActualHoursForMonth(m, tenantId))),
        ]);
        if (cancelled) return;
        setWeekData({
          employees: emps ?? [],
          scheduleData: Object.assign({}, ...schedules.map((s) => s ?? {})),
          actualData: Object.assign({}, ...actuals.map((a) => a ?? {})),
        });
      } catch {
        if (!cancelled) setWeekData(null);
      }
    })();
    return () => { cancelled = true; };
  }, [viewMode, compareDates, tenantId]);

  /**
   * Wochen-Abgleich «Bedarf vs. Planung vs. Ist» — EINE gemeinsame Berechnung
   * (buildWeekCompare → computeDayPlanHints/computeWeekCell) mit Dienstplan-
   * Live-Hinweis und Cockpit, damit sich die Ansichten nie widersprechen.
   */
  // Offene Vorschläge laden (best-effort: Lesefehler → leere Marker, die
  // Analyse selbst bleibt funktionsfähig; Anlegen meldet Fehler explizit).
  useEffect(() => {
    let cancelled = false;
    fetchOpenProposals(tenantId)
      .then((list) => { if (!cancelled) setOpenProposals(list); })
      .catch(() => { if (!cancelled) setOpenProposals([]); });
    return () => { cancelled = true; };
  }, [tenantId, proposalsVersion]);

  const weekCompare = useMemo(() => {
    if (!weekData || !compareDates) return null;
    // Hinweis Monatsmodus: totals summieren korrekt über ALLE Tage; die
    // wochentags-keyed rows/days sind dann nicht eindeutig — deshalb werden
    // Ansicht A/B und der Stunden-Stapel nur im Wochenmodus gerendert.
    return buildWeekCompare({
      positions,
      requirements,
      config: profilesConfig,
      employees: weekData.employees,
      scheduleData: weekData.scheduleData,
      actualHours: weekData.actualData,
      dates: compareDates,
      eventDays,
    });
  }, [weekData, compareDates, positions, requirements, profilesConfig, eventDays]);

  /**
   * Konfliktprüfung fürs Zell-Pop-up: Ist die Person am gewählten Tag bereits
   * geplant (Position + Schichtzeit aus der Analyse) oder als Absenz (FE/K/U)
   * eingetragen? Warnung, keine Sperre.
   */
  const conflictForCellDate = useCallback((employeeId: string): string | null => {
    if (!cellDialog || !weekData) return null;
    const dateStr = cellDialog.dateStr;
    const emp = weekData.employees.find((e) => e.id === employeeId);
    const name = emp?.name ?? employeeId;
    const dayLabel = format(parseISO(dateStr), 'EEEE dd.MM.', { locale: de });
    const entry = weekData.scheduleData[`${employeeId}-${dateStr}`];
    const absence = entry?.frühAbsence || entry?.spätAbsence;
    if (absence) return `${name} ist am ${dayLabel} als ${absence} eingetragen.`;
    // Bereits produktiv geplant? Positionen + Zeiten aus derselben Berechnung
    // wie die Matrix (weekCompare-Drilldown, alle Positionen des Tages).
    const day = weekCompare?.days.find((d) => d.dateStr === dateStr);
    const placements: string[] = [];
    for (const pos of day?.hints.positions ?? []) {
      const a = pos.assigned.find((x) => x.id === employeeId);
      if (a) placements.push(`${pos.positionName}, ${a.slots.map((s) => `${s.start}–${s.end}`).join(', ')}`);
    }
    if (placements.length > 0) return `${name} ist am ${dayLabel} bereits geplant: ${placements.join(' · ')}.`;
    // Fallback: Eintrag ohne Positions-Zuordnung (z.B. Zeiten ohne Matrix-Treffer).
    if (entry?.früh || entry?.spät) {
      const times = [entry.früh, entry.spät].filter(Boolean)
        .map((s) => `${s!.start}–${s!.end}`).join(', ');
      return `${name} ist am ${dayLabel} bereits geplant: ${times}.`;
    }
    return null;
  }, [cellDialog, weekData, weekCompare]);

  /** Stunden-Stapel der Soll-Wochenmatrix (Plan/Ist je Wochentag) — nur im
   *  Wochenmodus (im Monatsmodus ist der Wochentag nicht eindeutig). */
  const hoursStack: WeekHoursStack | null = useMemo(() => {
    if (periodMode !== 'week' || !weekCompare || !weekLabel) return null;
    const plan: Record<number, number | null> = {};
    const ist: Record<number, number | null> = {};
    for (const d of weekCompare.days) {
      plan[d.weekday] = d.planHours;
      ist[d.weekday] = d.istHours;
    }
    return { weekLabel, plan, ist };
  }, [periodMode, weekCompare, weekLabel]);

  const activeProfile = profileByKey(profilesConfig, season);
  const locked = isProfileLocked(profilesConfig, season);
  /** Abgeleitetes Profil (Winter/UG = Standard + UG-Zuschlag): kein eigener Editor. */
  const derived = !!activeProfile?.baseKey;
  /** Saison, deren Zeilen die Matrix zeigt (Winter/UG → Standard-Zeilen). */
  const matrixSeason = dataSeasonForProfile(profilesConfig, season);
  const readOnly = locked || derived;
  const loading = posLoading || reqLoading;

  // ── Profil-Verwaltung ───────────────────────────────────────────────────────

  const updateProfile = async (
    key: StaffingSeason,
    patch: Partial<{ activeFrom: string | null; activeTo: string | null; locked: boolean }>,
  ) => {
    const next = {
      ...profilesConfig,
      profiles: profilesConfig.profiles.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    };
    try {
      await saveProfilesConfig(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Profil konnte nicht gespeichert werden');
    }
  };

  const handleToggleLock = async () => {
    if (!activeProfile) return;
    await updateProfile(season, { locked: !activeProfile.locked });
    toast.success(activeProfile.locked
      ? `Profil «${activeProfile.label}» ist wieder bearbeitbar`
      : `Profil «${activeProfile.label}» festgesetzt`);
  };

  const handleAddProfile = async () => {
    const label = window.prompt('Name des neuen Profils (z.B. «Sommerfest»):')?.trim();
    if (!label) return;
    const key = profileKeyFromLabel(label);
    if (!key) { toast.error('Ungültiger Profilname'); return; }
    if (profilesConfig.profiles.some((p) => p.key === key)) {
      toast.error('Ein Profil mit diesem Namen existiert bereits');
      return;
    }
    try {
      await saveProfilesConfig({
        ...profilesConfig,
        profiles: [...profilesConfig.profiles, { key, label, activeFrom: null, activeTo: null, locked: false, baseKey: null }],
      });
      setSeason(key);
      toast.success(`Profil «${label}» angelegt — Bedarf jetzt erfassen`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Profil konnte nicht angelegt werden');
    }
  };

  const handleRangeChange = async (field: 'activeFrom' | 'activeTo', value: string) => {
    // <input type="date"> liefert yyyy-MM-dd → auf MM-TT reduzieren; leer = null.
    const mmdd = value ? value.slice(5) : '';
    if (mmdd && !isValidMonthDay(mmdd)) return;
    await updateProfile(season, { [field]: mmdd || null });
  };

  // Hierarchie (Abteilung → Bereich → Position) für den aktiven Bereich.
  const matrix = useMemo(
    () => buildRequirementMatrix(positions, requirements, matrixSeason, weekday),
    [positions, requirements, matrixSeason, weekday],
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
    () => shiftsForScope(requirements, matrixSeason, weekday).filter((r) => !visibleKeys.has(r.positionKey)),
    [requirements, matrixSeason, weekday, visibleKeys],
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
    // 0a) Abgeleitete Profile (Winter/UG) haben keine eigenen Zeilen — nie speichern.
    if (derived) {
      toast.error('Winter/UG ist abgeleitet (Standard + UG-Zuschlag) — bitte den Standard bearbeiten.');
      return;
    }
    // 0) Festgesetzte Profile: Schreibsperre auch im Save-Pfad durchsetzen —
    //    frisch aus der DB prüfen, damit UI-Regressionen/parallele Sperren
    //    nicht am veralteten lokalen State vorbeischreiben.
    if (isProfileLocked(profilesConfig, season)) {
      toast.error('Profil ist festgesetzt — zum Bearbeiten zuerst entsperren.');
      return;
    }
    try {
      const fresh = await loadStaffingProfilesConfig(tenantId);
      if (isProfileLocked(fresh, season)) {
        toast.error('Profil wurde zwischenzeitlich festgesetzt — Speichern abgebrochen.');
        return;
      }
    } catch {
      /* Prüfung best-effort; lokale Sperre wurde oben bereits geprüft. */
    }

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

  /**
   * Speichern aus dem Zellen-Editor der Wochenansicht: ersetzt die Schichten
   * EINER Position an EINEM Wochentag im aktiven Profil; alle anderen Zeilen
   * des Scopes (andere Positionen + Orphans inaktiver Positionen) werden
   * unverändert wieder mitgegeben. Gleiche Sperr-/Validierungslogik wie
   * handleSave (Bedarf-Editor).
   */
  const handleSaveCell = async (
    positionKey: string,
    wd: number,
    part: 'mittag' | 'abend' | 'day',
    shifts: ShiftDraft[],
    dayHeadcount?: number | null,
  ) => {
    if (derived) {
      throw new Error('Winter/UG ist abgeleitet (Standard + UG-Zuschlag) — bitte den Standard bearbeiten.');
    }
    if (isProfileLocked(profilesConfig, season)) {
      throw new Error('Profil ist festgesetzt — zum Bearbeiten zuerst entsperren.');
    }
    try {
      const fresh = await loadStaffingProfilesConfig(tenantId);
      if (isProfileLocked(fresh, season)) {
        throw new Error('Profil wurde zwischenzeitlich festgesetzt — Speichern abgebrochen.');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('festgesetzt')) throw e;
      /* Prüfung best-effort; lokale Sperre wurde oben bereits geprüft. */
    }
    for (const s of shifts) {
      const errs = validateShiftDraft(s);
      if (errs.length > 0) throw new Error(errs[0]);
    }

    // FRISCHEN Scope-Stand aus der DB laden — nicht den lokalen Snapshot:
    // parallel geänderte Zeilen (andere Tageshälfte, andere Positionen)
    // dürfen nicht mit veraltetem State überschrieben werden.
    let freshReqs = requirements;
    try {
      freshReqs = await loadStaffingRequirements(tenantId);
    } catch {
      /* Fallback: lokaler Stand (best-effort) */
    }
    const scope: StaffingScope = { scopeType: SCOPE_WEEKLY, season, weekday: wd, scopeRef: null };
    const existing = shiftsForScope(freshReqs, season, wd);
    const drafts: (StaffingRequirementDraft & { id?: string })[] = buildCellSaveDrafts({
      existing, season, weekday: wd, positionKey, part, partDrafts: shifts, dayHeadcount,
    });
    await saveScope(scope, drafts);
    toast.success(`Personalbedarf gespeichert (${seasonLabel(season)} · ${weekdayLabel(wd)})`);
  };

  // ── Tagessumme = KOPFZAHL (rein informativ): je Position zählt eine Person
  // 1× pro Tag. Explizites Soll (meta.dayHeadcount aus den gespeicherten
  // Zeilen) hat Vorrang, sonst Automatik max(Mittag, Abend) — nie Blocksumme.
  const dayTotal = useMemo(() => {
    const scopeRows = shiftsForScope(requirements, matrixSeason, weekday);
    return Object.entries(edits).reduce((sum, [positionKey, shifts]) => {
      const explicit = explicitDayHeadcount(scopeRows.filter((r) => r.positionKey === positionKey));
      if (explicit != null) return sum + explicit;
      let mittag = 0; let abend = 0;
      for (const s of shifts) {
        const c = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
        if (isEveningShift(s.shiftStart)) abend += c; else mittag += c;
      }
      return sum + Math.max(mittag, abend);
    }, 0);
  }, [edits, requirements, matrixSeason, weekday]);

  const error = posError || reqError;
  const hasActivePositions = matrix.length > 0;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-3">
      {/* Kopf */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-violet-600" />
          <h1 className="text-lg font-semibold">Personalbedarf</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => setUgDialogOpen(true)}
            data-testid="button-ug-config"
            title="UG-Zuschlag konfigurieren (Saison, Wochentage, Positionen)"
          >
            <Settings2 className="h-4 w-4" /> UG konfigurieren
          </Button>
          <Button
            size="sm"
            variant={locked ? 'secondary' : 'outline'}
            className="gap-1"
            onClick={handleToggleLock}
            title={locked ? 'Profil wieder bearbeitbar machen' : 'Profil gegen versehentliches Ändern sperren'}
          >
            {locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            {locked ? 'Entsperren' : 'Festsetzen'}
          </Button>
          {!readOnly && (
            <>
              <Button size="sm" variant="ghost" className="gap-1" onClick={handleReset} disabled={!dirty || busy}>
                <RotateCcw className="h-4 w-4" /> Verwerfen
              </Button>
              <Button size="sm" className="gap-1" onClick={handleSave} disabled={!dirty || busy}>
                <Save className="h-4 w-4" /> {busy ? 'Speichert…' : 'Speichern'}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Kompakte Steuerleiste: Profil · Ansicht · Zeitraum · Anzeige (1–2 Zeilen) */}
      <div className="rounded-lg border bg-muted/30 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Profil */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Profil</span>
          {profilesConfig.profiles.map((p) => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={season === p.key ? 'default' : 'outline'}
              onClick={() => setSeason(p.key)}
              className="gap-1 h-7 px-2.5 text-xs"
            >
              {p.locked && <Lock className="h-3 w-3" />}
              {p.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={handleAddProfile}>
            <Plus className="h-3.5 w-3.5" /> Neues Profil
          </Button>
        </div>
        <div className="hidden sm:block h-5 border-l border-border/60" aria-hidden="true" />
        {/* Ansicht */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Ansicht</span>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            variant={viewMode === 'week' ? 'default' : 'outline'}
            onClick={() => setViewMode('week')}
            data-testid="view-week"
          >
            Ganze Woche
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            variant={viewMode === 'day' ? 'default' : 'outline'}
            onClick={() => setViewMode('day')}
            data-testid="view-day"
          >
            Einzelner Tag
          </Button>
        </div>
        {viewMode === 'week' && (
          <>
            <div className="hidden sm:block h-5 border-l border-border/60" aria-hidden="true" />
            {/* Zeitraum-Navigation (Dienstplan/Ist-Vergleich) */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Zeitraum</span>
              <Button type="button" size="icon" variant="outline" className="h-7 w-7"
                onClick={() => shiftPeriod(-1)} data-testid="period-prev"
                title={periodMode === 'week' ? 'Eine Woche zurück' : 'Einen Monat zurück'}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Input
                type="date"
                value={weekAnchor}
                onChange={(e) => e.target.value && setWeekAnchor(e.target.value)}
                className="h-7 w-[9.5rem] text-xs"
                data-testid="input-week-anchor"
              />
              <Button type="button" size="icon" variant="outline" className="h-7 w-7"
                onClick={() => shiftPeriod(1)} data-testid="period-next"
                title={periodMode === 'week' ? 'Eine Woche vor' : 'Einen Monat vor'}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button type="button" size="sm" className="h-7 px-2.5 text-xs"
                variant={periodMode === 'week' ? 'default' : 'outline'}
                onClick={() => setPeriodMode('week')} data-testid="period-week">
                Woche
              </Button>
              <Button type="button" size="sm" className="h-7 px-2.5 text-xs"
                variant={periodMode === 'month' ? 'default' : 'outline'}
                onClick={() => setPeriodMode('month')} data-testid="period-month">
                Monat
              </Button>
              {periodLabel && (
                <span className="text-[11px] text-muted-foreground" data-testid="period-label">
                  {periodLabel}
                </span>
              )}
            </div>
            <div className="hidden sm:block h-5 border-l border-border/60" aria-hidden="true" />
            {/* Anzeige Soll-Matrix */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Soll-Matrix</span>
              <Button type="button" size="sm" className="h-7 px-2.5 text-xs"
                variant={cellMode === 'persons' ? 'default' : 'outline'}
                onClick={() => setCellMode('persons')} data-testid="cellmode-persons">
                Personen
              </Button>
              <Button type="button" size="sm" className="h-7 px-2.5 text-xs"
                variant={cellMode === 'hours' ? 'default' : 'outline'}
                onClick={() => setCellMode('hours')} data-testid="cellmode-hours">
                Stunden
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Profil-Zusatzinfos (nur wenn vorhanden) */}
      <div className="space-y-1.5 empty:hidden">
        {/* Abgeleitetes Profil: Winter/UG = Standard + UG-Zuschlag */}
        {derived && (
          <div className="rounded-md border border-violet-300 bg-violet-50 dark:bg-violet-950/20 px-3 py-2 space-y-2">
            <p className="text-xs font-medium">
              «{activeProfile?.label}» = Standard + UG-Zuschlag (kein eigener Bedarf — Änderungen am Soll bitte im Profil «Standard»).
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">UG-Zuschlag:</span>
              {profilesConfig.ugSurcharge.entries.length === 0 && (
                <span className="italic text-muted-foreground">keiner konfiguriert</span>
              )}
              {profilesConfig.ugSurcharge.entries.map((e) => (
                <Badge key={e.positionKey} variant="secondary" className="text-[11px]">
                  {positions.find((p) => p.key === e.positionKey)?.name ?? e.positionKey} +{e.count}
                </Badge>
              ))}
              {profilesConfig.ugSurcharge.enabled === false ? (
                <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400 text-[11px]">
                  Automatik deaktiviert — Zuschlag nur bei «UG/Event offen»
                </Badge>
              ) : (
                <span className="text-muted-foreground">
                  · Regelbetrieb: {profilesConfig.ugSurcharge.weekdays
                    .map((w) => WEEKDAYS.find((x) => x.value === w)?.label ?? w)
                    .join(' + ')}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Zusätzlich greift der Zuschlag GANZJÄHRIG an jedem Tag mit gesetztem
              «UG/Event offen»-Flag (im Dienstplan-Abgleich bzw. unten in der Prüfkarte setzbar).
            </p>
          </div>
        )}
        {/* Aktivierungs-Datumsbereich des gewählten Profils (ausser Standard = Rückfall) */}
        {activeProfile && activeProfile.key !== 'standard' && (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div className="flex flex-col gap-0.5">
              <Label className="text-[10px] text-muted-foreground">Aktiv ab (jährlich)</Label>
              <Input
                type="date"
                value={activeProfile.activeFrom ? `2026-${activeProfile.activeFrom}` : ''}
                onChange={(e) => handleRangeChange('activeFrom', e.target.value)}
                className="h-8 w-[10.5rem] text-sm"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <Label className="text-[10px] text-muted-foreground">Aktiv bis (jährlich)</Label>
              <Input
                type="date"
                value={activeProfile.activeTo ? `2026-${activeProfile.activeTo}` : ''}
                onChange={(e) => handleRangeChange('activeTo', e.target.value)}
                className="h-8 w-[10.5rem] text-sm"
              />
            </div>
            <span className="text-[11px] text-muted-foreground pb-1.5">
              Jahr wird ignoriert — der Bereich gilt jedes Jahr (z.B. 01.10.–31.03.).
              Ohne Bereich ist das Profil nie automatisch aktiv.
            </span>
          </div>
        )}
      </div>

      {/* Wochentag-Auswahl (nur Tagesansicht) */}
      {viewMode === 'day' && (
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
      )}

      {/* Bereichs-Zusammenfassung (rein informativ, Tagesansicht) */}
      {viewMode === 'day' && (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="h-4 w-4" />
        <span>{activeProfile?.label ?? seasonLabel(season)} · {weekdayLabel(weekday)}</span>
        <Badge variant="secondary" className="ml-1">Personal total: {dayTotal}</Badge>
        {profilesConfig.revenueBudgetByWeekday[weekday] != null && (
          <Badge variant="outline" className="gap-1">
            <Coins className="h-3 w-3" />
            Umsatzbudget: CHF {profilesConfig.revenueBudgetByWeekday[weekday].toLocaleString('de-CH')}
          </Badge>
        )}
        {locked && (
          <Badge variant="outline" className="border-slate-400 gap-1">
            <Lock className="h-3 w-3" /> festgesetzt
          </Badge>
        )}
        {dirty && <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">ungespeichert</Badge>}
      </div>
      )}

      {/* Wochenübersicht (Standard-Ansicht) */}
      {!loading && viewMode === 'week' && hasActivePositions && (
        <>
          {/* Vergleichs-Kacheln des gewählten Zeitraums (Woche oder Monat) */}
          {weekCompare && (
            <WeekCompareTiles compare={weekCompare} weekLabel={periodLabel ?? undefined} />
          )}

          <StaffingWeekMatrix
            positions={positions}
            requirements={requirements}
            config={profilesConfig}
            season={season}
            hoursStack={hoursStack}
            cellMode={cellMode}
            editable={!readOnly}
            editSeason={matrixSeason}
            sourceLabel={`Profil «${activeProfile?.label ?? seasonLabel(season)}»`}
            onSaveCell={handleSaveCell}
            onSelectPosition={(key, name) => setPositionDialog({ key, name })}
            onSelectWeekday={(w) => {
              setWeekday(w);
              setDetailDate(null); // Wochentag wird wieder führend fürs Detail
              setViewMode('day');
            }}
          />

          {/* Wochenansicht A: Bedarf vs. Planung (Kopfzahl je Position) —
              nur im Wochenmodus (im Monatsmodus sind Wochentags-Spalten mehrdeutig) */}
          {periodMode === 'week' && weekCompare && (
            <WeekCompareMatrix
              compare={weekCompare}
              onSelectDate={setDetailDate}
              onSelectCell={(positionKey, dateStr) => setCellDialog({ positionKey, dateStr })}
              openProposals={openProposals}
            />
          )}

          {/* Wochenansicht B: Stunden Bedarf / Plan / Ist (Tagestotale) */}
          {periodMode === 'week' && weekCompare && (
            <WeekHoursTable compare={weekCompare} onSelectDate={setDetailDate} />
          )}

          {/* «Personal pro Tag»-Diagramm unter den Vergleichstabellen */}
          <StaffingWeekSummary
            overview={weekOverview}
            profileLabel={`Profil «${activeProfile?.label ?? seasonLabel(season)}»`}
          />
        </>
      )}

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

      {/* Einzeltag-Detail: nur per Klick auf eine Tagesspalte der Wochenansichten
          (in der Tagesansicht weiterhin immer sichtbar). */}
      {!loading && (viewMode === 'day' || detailDate != null) && (
        <StaffingScheduleCheckCard
          positions={positions}
          requirements={requirements}
          season={season}
          weekday={weekday}
          profilesConfig={profilesConfig}
          dateOverride={detailDate}
        />
      )}

      {/* Pop-up «UG konfigurieren» */}
      <UgSurchargeDialog
        open={ugDialogOpen}
        onOpenChange={setUgDialogOpen}
        config={profilesConfig}
        positions={positions}
        employees={dialogEmployees.length > 0 ? dialogEmployees : (weekData?.employees ?? [])}
        onSave={async (next) => {
          // Frisch laden und NUR die UG-relevanten Teile mergen — parallel
          // geänderte Config-Teile (CdS-Priorität, Locks, Budget …) dürfen
          // nicht mit dem Dialog-Snapshot überschrieben werden.
          let base = profilesConfig;
          try {
            base = await loadStaffingProfilesConfig(tenantId);
          } catch { /* best-effort: lokaler Stand */ }
          const winterNext = next.profiles.find((p) => p.key === 'winter');
          const merged = {
            ...base,
            ugSurcharge: next.ugSurcharge,
            profiles: base.profiles.map((p) =>
              p.key === 'winter' && winterNext
                ? { ...p, activeFrom: winterNext.activeFrom, activeTo: winterNext.activeTo }
                : p,
            ),
            // CdS-/Gastgeber-Regel (im selben Dialog konfiguriert) mitschreiben.
            cdsRuleBySeason: next.cdsRuleBySeason,
            cdsPriority: next.cdsPriority,
            gastgeberWeekdays: next.gastgeberWeekdays,
            gastgeberRequiresFirstPlanned: next.gastgeberRequiresFirstPlanned,
          };
          await saveProfilesConfig(merged);
          toast.success('Konfiguration gespeichert — wirkt sofort auf Bedarf und Regel-Prüfungen.');
        }}
      />

      {/* Zell-Detail «Bedarf vs. Planung» (Position × Tag, read-only) */}
      <WeekCompareCellDialog
        open={cellDialog != null}
        onOpenChange={(o) => { if (!o) setCellDialog(null); }}
        dateStr={cellDialog?.dateStr ?? null}
        hint={
          cellDialog && weekCompare
            ? weekCompare.days.find((d) => d.dateStr === cellDialog.dateStr)
                ?.hints.positions.find((p) => p.positionKey === cellDialog.positionKey) ?? null
            : null
        }
        employees={weekData?.employees ?? []}
        dynamicRuleHint={cellDialog ? dynamicRuleHintFor(cellDialog.positionKey, profilesConfig) : null}
        tenantId={tenantId}
        conflictFor={conflictForCellDate}
        openProposals={openProposals}
        onProposalsChanged={() => setProposalsVersion((v) => v + 1)}
      />

      {/* Positions-Pop-up: Mitarbeiter dieser Position ansehen/zuordnen/entfernen */}
      <PositionAssignmentDialog
        open={positionDialog != null}
        onOpenChange={(o) => { if (!o) setPositionDialog(null); }}
        positionKey={positionDialog?.key ?? null}
        positionName={positionDialog?.name ?? ''}
        tenantId={tenantId}
        dynamicRuleHint={positionDialog ? dynamicRuleHintFor(positionDialog.key, profilesConfig) : null}
      />

      {/* Beaulieu: Ist-Aufstellung aus Juni/Juli als Standard-Vorschlag */}
      {!loading && tenantId === 'beaulieu' && <PastScheduleSuggestionCard />}

      {/* Hierarchie: Abteilung → Bereich → Position → Schichten (Tagesansicht) */}
      {!loading && viewMode === 'day' && hasActivePositions && matrix.map((dep) => (
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
                        <button
                          type="button"
                          className="text-sm font-medium flex-1 truncate text-left cursor-pointer rounded px-1 -mx-1 hover:bg-muted underline-offset-2 hover:underline"
                          onClick={() => setPositionDialog({ key: p.key, name: p.name })}
                          title={`Position «${p.name}»: Mitarbeiter zuordnen/entfernen`}
                          data-testid={`position-name-day-${p.key}`}
                        >
                          {p.name}
                        </button>
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
                              {/* Netto-Stunden-Soll (ArG-Pausenstaffel), rein informativ */}
                              {(() => {
                                const netto = nettoSegmentMinutes(s.shiftStart, s.shiftEnd);
                                const count = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
                                if (netto <= 0) return null;
                                return (
                                  <span className="text-[11px] text-muted-foreground pb-2 tabular-nums whitespace-nowrap">
                                    netto {(netto / 60).toLocaleString('de-CH', { maximumFractionDigits: 1 })} h
                                    {count > 1 && ` · Soll ${((netto * count) / 60).toLocaleString('de-CH', { maximumFractionDigits: 1 })} h`}
                                  </span>
                                );
                              })()}
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
