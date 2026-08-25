import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from 'react';
import ManagementInsights from '@/components/personal-fix/ManagementInsights';
import HourBalanceSection from '@/components/hour-balance/HourBalanceSection';
import { buildHourBalances, generatePlanningHints } from '@/lib/hour-balance-utils';
import { Navigate, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MONAT_PARAM, parseMonatParam } from '@/lib/monat-param';
import {
  DollarSign, Users, BookOpen, TrendingUp, ChefHat,
  Utensils, Edit2, Check, X, Info, Building2, AlertCircle, Clock,
  ChevronLeft, ChevronRight, ChevronDown, Calendar, BarChart2, Lightbulb, Target,
  Repeat, TrendingDown,
} from 'lucide-react';
import {
  exportVarKostenvergleich,
  exportFlexAuswertungToPDF,
  exportFlexAuswertungToExcel,
} from '@/lib/personalfix-export';
import { exportPersonalkostenSeiteToPDF, type PkAmpel } from '@/lib/personalkosten-seite-pdf';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { loadEmployees, upsertEmployee, loadActualHoursForMonth, loadScheduleForMonth, saveScheduleEntry } from '@/lib/supabase-db';
import {
  loadExtraCostPeople, upsertExtraCostPerson, extraCostPersonToEmployee,
  type ExtraCostPerson,
} from '@/lib/extra-cost-people-db';
import type { ActualHourEntry } from '@/lib/supabase-db';
import { loadAllContractHistory, getMidMonthSwitchInMonth } from '@/lib/contract-history-store';
import { applyEffectiveWagesForMonth, type MonthWageSplit } from '@/lib/wage-history';
import { Employee, grossToNet } from '@/types/personnel';
import { getEffectiveHourlyRate } from '@/components/schedule-planner/ActualHoursGrid';
import { getEmployerCostRate } from '@/lib/employee-rate';
import { loadAgSozOffMap, setAgSozOffFlag } from '@/lib/ag-soz-flags';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { socialCostFactorFromRates, EMPLOYER_COST_LABELS, EMPLOYER_COST_LABELS_SHORT, EMPLOYER_COST_INFO } from '@/lib/social-costs';
import {
  FlexIstOverrides, EMPTY_FLEX_OVERRIDES, loadFlexIstOverrides, saveFlexIstOverrides, effectiveFlexIst,
} from '@/lib/personalfix-flex-overrides';
import { FlexIstOverrideCell } from '@/components/personalfix/FlexIstOverrideCell';
import { EmployerCostInfoTip } from '@/components/ui/employer-cost-info';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { computeOvertimeAnalysis, computeWeeklyOvertimeAnalysis, type OvertimeHoursEntry, type DayDetailEntry } from '@/lib/overtime-analysis';
import { loadOvertimeDisabledIds, saveOvertimeDisabledIds } from '@/lib/supabase-kv';
import { ControllingDrilldownDialog, type DrilldownFocus } from '@/components/personal-fix/ControllingDrilldownDialog';
import { buildFactCells } from '@/lib/personal-controlling-drilldown';
import type {
  DrilldownInput, DrilldownDayValue, DrilldownAbsenceDay, DrilldownShiftTimes,
} from '@/lib/personal-controlling-drilldown';
import {
  buildStaffingRecommendations, type StaffingRecoResult,
} from '@/lib/staffing-recommendations';
import { DEFAULT_SEASON } from '@/lib/staffing-requirements-utils';
import type { StaffingSeason } from '@/types/staffing';
import { useStaffingRequirements } from '@/hooks/useStaffingRequirements';
import { usePositions } from '@/hooks/usePositions';
import { resolvePositionKey } from '@/lib/position-utils';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { personsPerDay, type ReservationAnalyticsRow } from '@/lib/reservation-analytics';
import { Button } from '@/components/ui/button';
import { UnifiedExportButton } from '@/components/UnifiedExportButton';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { useMaison } from '@/contexts/MaisonContext';
import { getMaisonEnabledSync } from '@/lib/maison-store';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import {
  buildFlexWeeklyEvaluation,
  loadDailyIstDetails,
  loadDailyPlanDetails,
  type FlexDayEntry as DayEntry,
} from '@/lib/flex-weekly-ssot';
import { aggregatePlanHours, mirrorPlanMonthToLocalStorage, debugPlanHours } from '@/lib/plan-stunden-sync';
import { SICK_CODES, ACCIDENT_CODES, VACATION_CODES } from '@/lib/absence-utils';
import { loadWeekdayWeights, computeProRataBudget, logBudgetDayDebug } from '@/lib/budget-day';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { InfoTip } from '@/components/ui/info-tip';
import { TONE_TEXT } from '@/components/ui/tones';
import { StatusPill } from '@/components/ui/status-pill';
import { loadMonth } from '@/lib/reporting-store';
import { computePLForMonth } from '@/lib/pl-engine';
import {
  computeFlexScopes,
  buildErfolgsrechnungVergleich,
  buildBudgetVsIst,
  budgetDeltaText,
  appVsErText,
  buildPkqBreakdown,
  type ComparisonTone,
} from '@/lib/personal-fix-reconciliation';
import {
  ladePersonalkostenDaten, personalkosten, personalquote, umsatz,
  fixKosten, flexKostenProTag, letzterVergangenerTag, effektiverIstStichtag, budget, budgetZielQuote,
  type PersonalkostenDaten,
} from '@/lib/personalkosten';
import {
  LineChart, Line as RLine, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import {
  buildPkqBruecke, buildKumulierterVerlauf,
} from '@/lib/personalkosten-darstellung';
import { PkHeadline } from '@/components/personalkosten/PkHeadline';
import { exportPersonalkostenExcel } from '@/lib/personalkosten-excel-export';
import { PkVerlaufChart } from '@/components/personalkosten/PkVerlaufChart';

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

const fmtCHFDec = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getMonthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString('de-CH', { month: 'long', year: 'numeric' });
}

function prevMonth(year: number, month: number): [number, number] {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function nextMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

/** Kurz-Status-Label für den Vergleich Berechnet ↔ Erfolgsrechnung (Ampel-Ton). */
const ER_STATUS_LABEL: Record<ComparisonTone, string> = {
  good: 'im Rahmen',
  warn: 'beobachten',
  critical: 'prüfen',
  neutral: '—',
};

/** „+CHF X" / „−CHF X" / „CHF 0" — Differenz mit sichtbarem Vorzeichen. */
const signCHF = (n: number) =>
  `${n > 0.005 ? '+' : n < -0.005 ? '−' : ''}${fmtCHF(Math.abs(n))}`;
/** „+1.0" / „−1.0" / „0.0" — Prozentpunkt-Differenz mit sichtbarem Vorzeichen. */
const signPp = (pp: number) =>
  `${pp > 0.05 ? '+' : pp < -0.05 ? '−' : ''}${Math.abs(pp).toFixed(1)}`;

/** Einheitliche Quoten-Zelle: „54.2 %" bzw. „—", wenn keine Quote berechenbar. */
const fmtQuote = (p: number | null) => (p !== null ? `${p.toFixed(1)} %` : '—');

/**
 * Kompakter Vergleichsblock des Personalcontrollings: zwei Kennzahl-Zeilen
 * (CHF + Quote) mit linker/rechter Grösse und farbig getönter Differenz.
 * Reine Darstellung — Werte, Wording und Ton kommen fertig von aussen (SSOT),
 * hier findet KEINE Berechnung statt.
 */
function ControllingBlock({
  testid, title, info, pill, footer, colLeft, colRight, colDiff, chf, pct, onClick,
}: {
  testid: string;
  title: string;
  info?: ReactNode;
  pill?: ReactNode;
  footer?: ReactNode;
  colLeft: string;
  colRight: string;
  colDiff: string;
  chf: { left: string; right: string; diff: string; tone: ComparisonTone };
  pct: { left: string; right: string; diff: string; tone: ComparisonTone };
  /** Optional: öffnet den Personalcontrolling-Drilldown (ganze Kachel klickbar). */
  onClick?: () => void;
}) {
  return (
    <div
      data-testid={testid}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        'rounded-md border border-border bg-card p-2.5 space-y-2',
        onClick && 'cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/30',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          {info}
        </div>
        {pill}
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="w-12 py-0.5 pr-2 text-left font-medium" />
            <th className="py-0.5 px-2 text-right font-medium">{colLeft}</th>
            <th className="py-0.5 px-2 text-right font-medium">{colRight}</th>
            <th className="py-0.5 pl-2 text-right font-medium">{colDiff}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border/50">
            <td className="py-1 pr-2 text-left text-muted-foreground">CHF</td>
            <td className="py-1 px-2 text-right font-mono text-foreground">{chf.left}</td>
            <td className="py-1 px-2 text-right font-mono text-foreground">{chf.right}</td>
            <td className={`py-1 pl-2 text-right font-mono font-semibold ${TONE_TEXT[chf.tone]}`}>{chf.diff}</td>
          </tr>
          <tr className="border-t border-border/50">
            <td className="py-1 pr-2 text-left text-muted-foreground">Quote</td>
            <td className="py-1 px-2 text-right font-mono text-foreground">{pct.left}</td>
            <td className="py-1 px-2 text-right font-mono text-foreground">{pct.right}</td>
            <td className={`py-1 pl-2 text-right font-mono ${TONE_TEXT[pct.tone]}`}>{pct.diff}</td>
          </tr>
        </tbody>
      </table>
      {footer && <div className="text-[11px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

/**
 * Einheitlicher, einklappbarer Abschnittskopf (Icon / Titel / optionaler
 * Kurzstatus / Chevron rechts). Rein UX — kapselt Radix Collapsible.
 * Inhalt wird bei geschlossenem Zustand ausgehängt (Radix); der Zustand liegt
 * in dieser Komponente, alle Daten kommen aus der Elternkomponente.
 */
function CollapsibleSection({
  icon,
  title,
  status,
  defaultOpen = false,
  testid,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** Kurzstatus rechts (bleibt sichtbar, auch wenn geschlossen). */
  status?: ReactNode;
  defaultOpen?: boolean;
  testid?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      data-testid={testid}
      className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid={testid ? `${testid}-trigger` : undefined}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
          >
            {icon && (
              <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4 shrink-0" aria-hidden>
                {icon}
              </span>
            )}
            <span className="text-sm font-semibold">{title}</span>
            <span className="ml-auto flex items-center gap-2">
              {status && <span className="text-xs text-muted-foreground">{status}</span>}
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform shrink-0',
                  open && 'rotate-180',
                )}
              />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border">
          <div className="p-4 space-y-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** Basis-Monatslohn eines Mitarbeiters */
function getFixCost(emp: Employee): number {
  if (emp.monthlySalaryWith13th && emp.monthlySalaryWith13th > 0)
    return emp.monthlySalaryWith13th;
  if (emp.monthlySalary && emp.monthlySalary > 0)
    return emp.monthlySalary;
  return 0;
}

/**
 * Split-Monat (Lohnart-Wechsel): FLEX-Pseudo-Zeilen tragen eine EIGENE id
 * (`<empId>::flexsplit`), damit fixe und variable Liste nie dieselbe id führen.
 * Stunden-/Rate-Lookups laufen über die Basis-id.
 */
const FLEX_SPLIT_SUFFIX = '::flexsplit';
const splitBaseId = (id: string): string =>
  id.endsWith(FLEX_SPLIT_SUFFIX) ? id.slice(0, -FLEX_SPLIT_SUFFIX.length) : id;

/** Ob der Mitarbeiter einen fixen Monatslohn hat */
function hasFixedSalary(emp: Employee): boolean {
  return (emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
    && (emp.monthlySalary ?? 0) > 0;
}

/**
 * Pro-rata-Berechnung des Fixlohns für einen Monat.
 *
 * Logik Eintritt (contractStart):
 * - Kein Eintrittsdatum → voller Monatslohn
 * - Eintritt nach diesem Monat → CHF 0, ausgeblendet
 * - Eintritt IM Monat → Lohn × ((Tage im Monat − Eintrittst. + 1) / Tage im Monat)
 * - Eintritt vor oder im Monatsersten → voller Monatslohn
 *
 * Logik Austritt (employmentEndDate):
 * - Kein Austrittsdatum → voller Monatslohn
 * - Austritt vor diesem Monat → CHF 0, ausgeblendet
 * - Austritt IM Monat → Lohn × (Austrittstag / Tage im Monat)
 * - Austritt nach diesem Monat → voller Monatslohn
 *
 * Beide Pro-rata-Faktoren werden multipliziert falls Eintritt und Austritt im selben Monat.
 */
function getProRataFixCost(
  emp: Employee, year: number, month: number
): { cost: number; label: string | null; excluded: boolean } {
  const full = getFixCost(emp);
  if (!full) return { cost: 0, label: null, excluded: false };

  const daysInMonth = new Date(year, month, 0).getDate();
  const labels: string[] = [];
  let entryFactor = 1;
  let exitFactor  = 1;

  // ── Eintrittsdatum ──────────────────────────────────────────────────────
  if (emp.contractStart) {
    const entry = new Date(emp.contractStart + 'T00:00:00');
    const eny = entry.getFullYear();
    const enm = entry.getMonth() + 1;
    const end = entry.getDate();

    if (eny > year || (eny === year && enm > month)) {
      return { cost: 0, label: 'Noch nicht eingetreten', excluded: true };
    }
    if (eny === year && enm === month && end > 1) {
      entryFactor = (daysInMonth - end + 1) / daysInMonth;
      const dd = String(end).padStart(2, '0');
      const mm = String(enm).padStart(2, '0');
      labels.push(`Pro rata ab ${dd}.${mm}.`);
    }
  }

  // ── Austrittsdatum ──────────────────────────────────────────────────────
  if (emp.employmentEndDate) {
    const exit = new Date(emp.employmentEndDate + 'T00:00:00');
    const ey = exit.getFullYear();
    const em = exit.getMonth() + 1;
    const ed = exit.getDate();

    if (ey < year || (ey === year && em < month)) {
      return { cost: 0, label: 'Ausgetreten', excluded: true };
    }
    if (ey === year && em === month) {
      exitFactor = ed / daysInMonth;
      const dd = String(ed).padStart(2, '0');
      const mm = String(em).padStart(2, '0');
      labels.push(`Pro rata bis ${dd}.${mm}.`);
    }
  }

  const factor = entryFactor * exitFactor;
  if (factor >= 1) return { cost: full, label: null, excluded: false };

  const cost = Math.round(full * factor * 100) / 100;
  return { cost, label: labels.join(' / '), excluded: false };
}

/**
 * Jahreskosten-Berechnung für den Fixlohn eines Mitarbeiters.
 *
 * Berücksichtigt sowohl Eintrittsdatum (contractStart) als auch Austrittsdatum (employmentEndDate).
 *
 * Formel: Summe über alle 12 Monate, wobei jeder Monat den pro-rata-Faktor aus
 * getProRataFixCost verwendet.
 */
function getYearlyFixCost(emp: Employee, year: number): number {
  const full = getFixCost(emp);
  if (!full) return 0;

  let total = 0;
  for (let m = 1; m <= 12; m++) {
    const { cost, excluded } = getProRataFixCost(emp, year, m);
    if (!excluded) total += cost;
  }
  return Math.round(total * 100) / 100;
}

// ── Slot-Stunden-Rechner (für schedule-v2 Plan-Stunden) ───────────────────────

function calcSlotHours(slot: { start: string; end: string } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.max(0, h);
}

/**
 * Liest Plan-Stunden aus localStorage (schedule-v2-YYYY-MM).
 * Gibt eine Map empId → Gesamtstunden im Monat zurück.
 */
function loadPlanHoursFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    // SSoT-Aggregation: Monatsfilter + FE-Skip + calculateDayNetHours
    return aggregatePlanHours(data, year, month);
  } catch { return {}; }
}

/**
 * Liest FE-Ferientage aus localStorage (actual-hours-YYYY-MM).
 * Gibt eine Map empId → Anzahl FE-Einträge im Monat zurück.
 * FE-Einträge haben hours=0 und absenceType='FE' — werden hier gezählt.
 */
function loadFerienDaysFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') {
        out[empId] = (out[empId] ?? 0) + 1;
      }
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest FE-Ferientage aus dem PLAN-Dienstplan (schedule-v2-YYYY-MM).
 * Gibt eine Map empId → Anzahl Plan-FE-Tage im Monat zurück.
 * Ein Plan-FE-Tag liegt vor, wenn frühAbsence === 'FE' ODER spätAbsence === 'FE'.
 */
function loadFerienDaysFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const hasFE = ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE';
      if (hasFE) {
        out[empId] = (out[empId] ?? 0) + 1;
        console.log(`[FERIEN] loaded existing entry: plan ${cellKey} absenceType=FE`);
      }
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest K/U-Absenztage aus localStorage (actual-hours-YYYY-MM, IST).
 * Zählt Einträge mit absenceType in SICK_CODES oder ACCIDENT_CODES.
 * Gibt eine Map empId → Anzahl K+U-Tage zurück.
 */
function loadKUDaysFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType && (SICK_CODES.has(absenceType) || ACCIDENT_CODES.has(absenceType))) {
        out[empId] = (out[empId] ?? 0) + 1;
      }
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest K/U-Absenztage aus dem PLAN-Dienstplan (schedule-v2-YYYY-MM).
 * Zählt Einträge wo frühAbsence oder spätAbsence in SICK_CODES|ACCIDENT_CODES liegt.
 * Gibt eine Map empId → Anzahl Plan-K/U-Tage zurück.
 */
function loadKUDaysFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const früh = ds?.frühAbsence as string | null | undefined;
      const spät = ds?.spätAbsence as string | null | undefined;
      const hasKU = (früh && (SICK_CODES.has(früh) || ACCIDENT_CODES.has(früh))) ||
                    (spät && (SICK_CODES.has(spät) || ACCIDENT_CODES.has(spät)));
      if (hasKU) out[empId] = (out[empId] ?? 0) + 1;
    }
    return out;
  } catch { return {}; }
}

/** Detail-Liste: Ist-FE-Tage pro Mitarbeiter (empId → [{date}]) */
function loadFerienDetailFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, { date: string }[]> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, { date: string }[]> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') {
        if (!out[empId]) out[empId] = [];
        out[empId].push({ date });
      }
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch { return {}; }
}

/** Detail-Liste: Plan-FE-Tage pro Mitarbeiter (empId → [{date}]) */
function loadFerienDetailFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, { date: string }[]> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, { date: string }[]> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      if (ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE') {
        if (!out[empId]) out[empId] = [];
        out[empId].push({ date });
      }
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch { return {}; }
}

/** Checkbox: Ferienabbau in Budget-Auswertung einbeziehen */
function loadFerienInBudget(tenantId: string, year: number, month: number): boolean {
  try {
    return localStorage.getItem(`pfix_ferien_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`) === '1';
  } catch { return false; }
}
function saveFerienInBudget(tenantId: string, year: number, month: number, v: boolean): void {
  try {
    const key = `pfix_ferien_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    if (v) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
  } catch { /* quota */ }
}

export type KUBreakdown = { krank: number; unfall: number };

/** Krank / Unfall separat aus Plan-Dienstplan (schedule-v2) */
function loadKUBreakdownFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, KUBreakdown> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, KUBreakdown> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const früh = ds?.frühAbsence as string | null | undefined;
      const spät = ds?.spätAbsence as string | null | undefined;
      const type = (früh && (SICK_CODES.has(früh) || ACCIDENT_CODES.has(früh))) ? früh
                 : (spät && (SICK_CODES.has(spät) || ACCIDENT_CODES.has(spät))) ? spät
                 : null;
      if (!type) continue;
      if (!out[empId]) out[empId] = { krank: 0, unfall: 0 };
      if (SICK_CODES.has(type)) out[empId].krank++;
      else out[empId].unfall++;
    }
    return out;
  } catch { return {}; }
}

/** Krank / Unfall separat aus Ist-Stunden (actual-hours) */
function loadKUBreakdownFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, KUBreakdown> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, KUBreakdown> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const type = typeof val === 'object' ? val?.absenceType as string | undefined : undefined;
      if (!type || (!SICK_CODES.has(type) && !ACCIDENT_CODES.has(type))) continue;
      if (!out[empId]) out[empId] = { krank: 0, unfall: 0 };
      if (SICK_CODES.has(type)) out[empId].krank++;
      else out[empId].unfall++;
    }
    return out;
  } catch { return {}; }
}

export type KUDayEntry = { date: string; type: string };

/** Detail-Liste: Plan-K/U-Tage pro Mitarbeiter (empId → [{date, type}]) */
function loadKUDetailFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, KUDayEntry[]> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, KUDayEntry[]> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const früh = ds?.frühAbsence as string | null | undefined;
      const spät = ds?.spätAbsence as string | null | undefined;
      const type = (früh && (SICK_CODES.has(früh) || ACCIDENT_CODES.has(früh))) ? früh
                 : (spät && (SICK_CODES.has(spät) || ACCIDENT_CODES.has(spät))) ? spät
                 : null;
      if (type) {
        if (!out[empId]) out[empId] = [];
        out[empId].push({ date, type });
      }
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch { return {}; }
}

/** Detail-Liste: Ist-K/U-Tage pro Mitarbeiter (empId → [{date, type}]) */
function loadKUDetailFromIstStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, KUDayEntry[]> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, KUDayEntry[]> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const type = typeof val === 'object' ? val?.absenceType as string | undefined : undefined;
      if (type && (SICK_CODES.has(type) || ACCIDENT_CODES.has(type))) {
        if (!out[empId]) out[empId] = [];
        out[empId].push({ date, type });
      }
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch { return {}; }
}

/** Checkbox: K/U-Kosten in Budget-Auswertung einbeziehen */
function loadKrankInBudget(tenantId: string, year: number, month: number): boolean {
  try {
    // Migrate from old unified key
    const oldKey = `pfix_ku_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    const newKey = `pfix_krank_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    if (localStorage.getItem(newKey) !== null) {
      return localStorage.getItem(newKey) === '1';
    }
    return localStorage.getItem(oldKey) === '1';
  } catch { return false; }
}
function saveKrankInBudget(tenantId: string, year: number, month: number, v: boolean): void {
  try {
    const key = `pfix_krank_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    if (v) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
  } catch { /* quota */ }
}
function loadUnfallInBudget(tenantId: string, year: number, month: number): boolean {
  try {
    // Migrate from old unified key
    const oldKey = `pfix_ku_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    const newKey = `pfix_unfall_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    if (localStorage.getItem(newKey) !== null) {
      return localStorage.getItem(newKey) === '1';
    }
    return localStorage.getItem(oldKey) === '1';
  } catch { return false; }
}
function saveUnfallInBudget(tenantId: string, year: number, month: number, v: boolean): void {
  try {
    const key = `pfix_unfall_budget_${tenantId}_${year}_${String(month).padStart(2, '0')}`;
    if (v) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
  } catch { /* quota */ }
}


/**
 * Liest Ist-Stunden aus localStorage (actual-hours-YYYY-MM = Mirus-Import).
 * Gibt eine Map empId → Gesamtstunden im Monat zurück.
 */
function loadIstHoursFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`[IST] month selected: ${monthPrefix} (key: ${key})`);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      console.log(`[IST] persisted rows: 0 (key not found in localStorage)`);
      return {};
    }
    const data: Record<string, any> = JSON.parse(raw);
    const allRows = Object.keys(data);
    // Filter: only count entries whose date matches this month (guards against old corrupted data)
    const out: Record<string, number> = {};
    const mismatched: string[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      // key format: "{employeeId}-YYYY-MM-DD" → date is last 10 chars
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) {
        mismatched.push(cellKey);
        continue; // skip entries from other months that ended up in this key (old bug)
      }
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      // Skip FE (Ferien/vacation) absences — same as loadDailyIstDetails
      const absenceType = typeof val === 'object' ? (val as any)?.absenceType : undefined;
      if (absenceType === 'FE') continue;
      const h = typeof val === 'number' ? val : (val?.hours ?? 0);
      if (h > 0) out[empId] = (out[empId] ?? 0) + Math.round(h * 100) / 100;
    }
    const totalHours = Object.values(out).reduce((s, h) => s + h, 0);
    console.log(`[IST] persisted rows: ${allRows.length} total, ${mismatched.length} from wrong month (filtered out)`);
    console.log(`[IST] personal-fix rows loaded: ${Object.keys(out).length} Mitarbeiter / ${Math.round(totalHours * 10) / 10} Stunden`);
    if (mismatched.length > 0) {
      console.warn(`[IST] missing employees / cross-month entries filtered:`, mismatched.slice(0, 10));
    }
    return out;
  } catch { return {}; }
}

// ── Bezeichnungen ─────────────────────────────────────────────────────────────

const DEPT_LABEL: Record<string, string> = { service: 'Service', küche: 'Küche' };
const DEPT_ICON: Record<string, React.ReactNode> = {
  service: <Utensils className="h-4 w-4" />,
  küche:   <ChefHat  className="h-4 w-4" />,
};
const EMP_TYPE_LABEL: Record<string, string> = {
  vollzeit: 'Vollzeit', teilzeit: 'Teilzeit',
  minijob: 'Minijob', aushilfe: 'Aushilfe',
};

type VarView = 'plan' | 'ist' | 'manual';

const VAR_HOURS_KEY = 'personal_fix_var_hours_v1';
function loadVarHours(keyFn: (k: string) => string = k => k): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_HOURS_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarHours(data: Record<string, number>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_HOURS_KEY), JSON.stringify(data));
}

// ── Wöchentliches Basismodell (Std/Wo, Tage/Wo) ───────────────────────────────

interface WeeklyBaseline { hours?: number; days?: number; }
const VAR_WEEKLY_KEY = 'personal_fix_weekly_v1';

function loadVarWeekly(keyFn: (k: string) => string = k => k): Record<string, WeeklyBaseline> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_WEEKLY_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarWeekly(data: Record<string, WeeklyBaseline>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_WEEKLY_KEY), JSON.stringify(data));
}

/** Durchschnittliche Wochen pro Monat */
const WEEKS_PER_MONTH = 4.333;

// ── Tagessatz (Tages-Pauschale) ────────────────────────────────────────────────

type PricingMode = 'hourly' | 'daily';

interface DayRateData { ratePerDay: number; daysPerWeek?: number; daysPerMonth?: number; }

const VAR_PRICING_MODE_KEY = 'personal_fix_pricing_mode_v1';
function loadVarPricingMode(keyFn: (k: string) => string = k => k): Record<string, PricingMode> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_PRICING_MODE_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarPricingMode(data: Record<string, PricingMode>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_PRICING_MODE_KEY), JSON.stringify(data));
}

const VAR_DAYRATE_KEY = 'personal_fix_dayrate_v1';
function loadVarDayRate(keyFn: (k: string) => string = k => k): Record<string, DayRateData> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_DAYRATE_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarDayRate(data: Record<string, DayRateData>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_DAYRATE_KEY), JSON.stringify(data));
}

// ── Umsatz-Annahme (manuelle Revenue-Eingabe für PKQ) ─────────────────────────

const REVENUE_ASSUMPTION_KEY = 'personal_fix_revenue_assumption_v1';
function loadRevenueAssumption(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${REVENUE_ASSUMPTION_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveRevenueAssumption(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${REVENUE_ASSUMPTION_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

// ── Budget-Umsatz (manuelle Revenue-Eingabe für PKQ-Budget-Ableitung) ──────────

const BUDGET_REVENUE_KEY = 'personal_fix_budget_revenue_v1';
function loadBudgetRevenue(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${BUDGET_REVENUE_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveBudgetRevenue(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${BUDGET_REVENUE_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

const WEEK_IST_KEY = 'personal_fix_week_ist_v1';
function loadWeekIstSet(year: number, month: number, keyFn: (k: string) => string = k => k): string[] {
  try {
    const raw = localStorage.getItem(keyFn(`${WEEK_IST_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveWeekIstSet(year: number, month: number, weeks: string[], keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${WEEK_IST_KEY}_${year}_${String(month).padStart(2, '0')}`);
  try { localStorage.setItem(key, JSON.stringify(weeks)); } catch { /* ignore */ }
}

const WEEK_REV_OVERRIDE_KEY = 'personal_fix_week_rev_overrides_v1';
function loadWeekRevOverrides(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  try {
    const raw = localStorage.getItem(keyFn(`${WEEK_REV_OVERRIDE_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}
function saveWeekRevOverrides(year: number, month: number, data: Record<string, number>, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${WEEK_REV_OVERRIDE_KEY}_${year}_${String(month).padStart(2, '0')}`);
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
}

const SCENARIO_PK_KEY = 'personal_fix_scenario_pk_v1';
function loadScenarioPkCost(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${SCENARIO_PK_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveScenarioPkCost(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${SCENARIO_PK_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

// ── Tagesumsätze aus localStorage (dailyBudgets) ──────────────────────────────

function readDailyBudgetsLocal(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, { actualRevenue?: number; takeawayRevenue?: number }> {
  try {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const all: Record<string, { actualRevenue?: number; takeawayRevenue?: number }> =
      JSON.parse(localStorage.getItem(keyFn('dailyBudgets')) || '{}');
    const out: Record<string, { actualRevenue?: number; takeawayRevenue?: number }> = {};
    for (const [date, val] of Object.entries(all)) {
      if (date.startsWith(prefix)) out[date] = val;
    }
    return out;
  } catch { return {}; }
}

// ── KPI-Card ──────────────────────────────────────────────────────────────────

interface KpiProps {
  title: string; value: string; sub?: string; icon: React.ReactNode;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'orange' | 'default';
  delta?: number | null; deltaLabel?: string;
  sourceBadge?: string;
}

const KpiCard = ({ title, value, sub, icon, color = 'default', delta, deltaLabel, sourceBadge }: KpiProps) => {
  const border = {
    blue: 'border-blue-200 dark:border-blue-800', green: 'border-emerald-200 dark:border-emerald-800',
    red: 'border-red-200 dark:border-red-800', yellow: 'border-yellow-200 dark:border-yellow-800',
    orange: 'border-orange-200 dark:border-orange-800', default: 'border-border',
  }[color];
  const iconBg = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40', green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40',
    red: 'bg-red-50 text-red-600 dark:bg-red-950/40', yellow: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-950/40',
    orange: 'bg-orange-50 text-orange-600 dark:bg-orange-950/40', default: 'bg-muted text-muted-foreground',
  }[color];
  return (
    <div className={cn('rounded-xl border bg-card p-4 flex flex-col gap-2 shadow-sm', border)}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
        <div className={cn('p-1.5 rounded-lg', iconBg)}>{icon}</div>
      </div>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {sourceBadge && (
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 w-fit">
          {sourceBadge}
        </span>
      )}
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      {delta !== undefined && delta !== null && (
        <p className={cn('text-xs font-medium flex items-center gap-1', delta >= 0 ? 'text-red-600' : 'text-emerald-600')}>
          {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingUp className="h-3 w-3 rotate-180" />}
          {delta >= 0 ? '+' : ''}{fmtCHF(delta)} {deltaLabel}
        </p>
      )}
    </div>
  );
};

// ── Inline-Editors ─────────────────────────────────────────────────────────────

interface InlineSalaryEditorProps {
  empId: string; field: 'monthlySalary' | 'monthlySalaryWith13th';
  value: number | undefined;
  onSaved: (empId: string, field: 'monthlySalary' | 'monthlySalaryWith13th', val: number) => void;
}

const InlineSalaryEditor = ({ empId, field, value, onSaved }: InlineSalaryEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onSaved(empId, field, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1">
      <Input autoFocus className="h-7 w-28 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }} />
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center gap-1.5 text-right tabular-nums hover:text-primary transition-colors" onClick={start}>
      <span className="font-mono text-sm">{value ? fmtCHFDec(value) : <span className="text-muted-foreground italic text-xs">–</span>}</span>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

interface InlineHourlyWageEditorProps {
  empId: string; value: number | undefined;
  onSaved: (empId: string, val: number) => void;
}

const InlineHourlyWageEditor = ({ empId, value, onSaved }: InlineHourlyWageEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onSaved(empId, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1 justify-end">
      <Input autoFocus className="h-7 w-20 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="0.00" />
      <span className="text-xs text-muted-foreground">/h</span>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1.5 hover:text-primary transition-colors w-full" onClick={start}>
      <span className="font-mono text-sm text-muted-foreground">
        {value ? `${fmtCHFDec(value)}/h` : <span className="italic text-xs">–</span>}
      </span>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

interface InlineHoursEditorProps {
  empId: string; value: number;
  onChange: (empId: string, val: number) => void;
}

const InlineHoursEditor = ({ empId, value, onChange }: InlineHoursEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value > 0 ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onChange(empId, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1 justify-end">
      <Input autoFocus className="h-7 w-20 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="0" />
      <span className="text-xs text-muted-foreground">h</span>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1.5 hover:text-primary transition-colors w-full" onClick={start}>
      {value > 0
        ? <span className="font-mono text-sm">{value} h</span>
        : <span className="text-muted-foreground italic text-xs">Eingabe</span>}
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

// ── Kleiner Inline-Editor für Wochenwerte (Std/Wo, Tage/Wo) ──────────────────

interface InlineWeeklyEditorProps {
  value: number | undefined;
  unit: string;
  max: number;
  onSave: (val: number | undefined) => void;
}

const InlineWeeklyEditor = ({ value, unit, max, onSave }: InlineWeeklyEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start  = () => { setInput(value != null ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save   = () => {
    const trimmed = input.trim();
    if (trimmed === '' || trimmed === '0') { onSave(undefined); setEditing(false); return; }
    const num = parseFloat(trimmed.replace(',', '.'));
    if (!isNaN(num) && num >= 0 && num <= max) onSave(num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-0.5 justify-end">
      <Input autoFocus className="h-6 w-14 text-right font-mono text-xs py-0 px-1" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="–" />
      <span className="text-[10px] text-muted-foreground">{unit}</span>
      <Button size="icon" variant="ghost" className="h-5 w-5 text-emerald-600" onClick={save}><Check className="h-3 w-3" /></Button>
      <Button size="icon" variant="ghost" className="h-5 w-5 text-muted-foreground" onClick={cancel}><X className="h-3 w-3" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1 hover:text-primary transition-colors w-full" onClick={start}>
      {value != null
        ? <span className="font-mono text-xs text-violet-700 dark:text-violet-400">{value}{unit}</span>
        : <span className="text-muted-foreground italic text-[10px]">–</span>}
      <Edit2 className="h-2.5 w-2.5 opacity-0 group-hover:opacity-40 transition-opacity shrink-0" />
    </button>
  );
};

// ── Flex-Breakdown: Typen ──────────────────────────────────────────────────────

type BreakdownField =
  | 'planWork' | 'istWork'
  | 'planHoliday' | 'istHoliday'
  | 'planTotalVar' | 'istTotalVar';

interface BreakdownTarget {
  empId:       string;
  empName:     string;
  field:       BreakdownField;
  hourlyWage:  number;
  weeklyHours: number;
  year:        number;
  month:       number;
  cutoffDay:   number | null;
  factor:      number;
  /** true = CHF-Werte OHNE AG-Sozialkosten (nur Bruttolohn) */
  agOff?:      boolean;
}

interface FerienDay { date: string; dailyH: number; cost: number; }

/** Zusatzkosten plan-tagged days for a fixed-salary employee (isAdditionalCostPlan) */
function loadZusatzPlanDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: DayEntry[] = [];
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      if (typeof ds !== 'object' || !ds?.isAdditionalCostPlan) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      // Netto via SSoT (Pause pro Einsatz abgezogen)
      const net = calculateDayNetHours(ds);
      if (net > 0) entries.push({ date, hours: Math.round(net * 100) / 100, cost: Math.round(net * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/**
 * Liest Zusatzkosten-IST-Einträge für einen Mitarbeiter (isAdditionalCost: true).
 * Identisch zu loadDailyIstDetails, aber nur Einträge mit isAdditionalCost = true.
 */
function loadZusatzIstDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: DayEntry[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      if (typeof val !== 'object' || !val?.isAdditionalCost) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const h = val?.hours ?? 0;
      if (h > 0) entries.push({ date, hours: Math.round(h * 100) / 100, cost: Math.round(h * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** FE vacation days from actual-hours-YYYY-MM (Ist) */
function loadFerienIstDayDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, dailyH: number, wage: number,
  keyFn: (k: string) => string = k => k,
): FerienDay[] {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: FerienDay[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') entries.push({ date, dailyH: Math.round(dailyH * 100) / 100, cost: Math.round(dailyH * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** FE vacation days from schedule-v2-YYYY-MM (Plan) */
function loadFerienPlanDayDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, dailyH: number, wage: number,
  keyFn: (k: string) => string = k => k,
): FerienDay[] {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: FerienDay[] = [];
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const hasFE = ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE';
      if (hasFE) entries.push({ date, dailyH: Math.round(dailyH * 100) / 100, cost: Math.round(dailyH * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ── Abweichungsanalyse helpers ─────────────────────────────────────────────────

interface AbwDay {
  date:        string;
  planWork:    number;
  istWork:     number;
  planFerien:  number;
  istFerien:   number;
  planTotal:   number;
  istTotal:    number;
  diff:        number;
  diffPct:     number | null;
}

interface AbwRow {
  period:    string;
  planTotal: number;
  istTotal:  number;
  diff:      number;
  diffPct:   number | null;
  dates:     string[];
  /** true = Zeitraum liegt (ganz) nach dem Ist-Stichtag — «noch offen / kein Ist»:
   *  nicht als Abweichung werten, nicht in Total/Kumulation zählen. */
  offen?:    boolean;
  /** true = Woche läuft über den Ist-Stichtag hinaus — Plan+Ist nur bis Stichtag gezählt. */
  teilweise?: boolean;
}

type AbwMode = 'day' | 'week' | 'month' | 'year';

interface FlexPeriodTarget {
  label:     string;
  dates:     string[];
  planTotal: number;
  istTotal:  number;
  year:      number;
  month:     number;
}

/** '2026-08-11' → '11.08.' (für das Teilwochen-Badge) */
function fmtStichtagKurz(iso: string): string {
  return iso.length === 10 ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : iso;
}

// ── Ampel-Logik ────────────────────────────────────────────────────────────────

type AmpelStatus = 'green' | 'yellow' | 'red' | 'neutral';

/** Einheitliche Ampel-Logik: Grün ≤0%, Gelb 0–5%, Rot >5% über Plan. Neutral wenn kein Plan. */
function ampelStatus(diff: number, plan: number): AmpelStatus {
  if (plan <= 0) return 'neutral';
  const pct = diff / plan;
  if (diff <= 0.005) return 'green';
  if (pct <= 0.05)   return 'yellow';
  return 'red';
}

const AMPEL: Record<AmpelStatus, {
  dot:    string;
  border: string;
  bg:     string;
  label:  string;
  text:   string;
}> = {
  green:   { dot: 'bg-emerald-500',                   border: 'border-emerald-400 dark:border-emerald-600', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', label: 'Im Plan',          text: 'text-emerald-700 dark:text-emerald-400' },
  yellow:  { dot: 'bg-amber-400',                     border: 'border-amber-400 dark:border-amber-600',     bg: 'bg-amber-50/60 dark:bg-amber-950/20',     label: 'Leicht über Plan', text: 'text-amber-700 dark:text-amber-400'    },
  red:     { dot: 'bg-red-500',                       border: 'border-red-400 dark:border-red-600',         bg: 'bg-red-50/60 dark:bg-red-950/20',         label: 'Über Plan',        text: 'text-red-700 dark:text-red-400'        },
  neutral: { dot: 'bg-gray-300 dark:bg-gray-600',     border: 'border-border',                              bg: '',                                        label: 'Kein Vergleich',   text: 'text-muted-foreground'                 },
};

// ── FlexPeriodPopup ────────────────────────────────────────────────────────────

function FlexPeriodPopup({
  target,
  employees,
  onClose,
}: {
  target:    FlexPeriodTarget | null;
  employees: Array<{ id: string; name: string; hourlyWage: number; weeklyHours: number }>;
  onClose:   () => void;
}) {
  const { tenantKey } = useTenant();
  if (!target) return null;
  const { label, dates, planTotal, istTotal, year, month } = target;
  const diff    = istTotal - planTotal;
  const diffPct = planTotal > 0 ? (diff / planTotal) * 100 : null;
  const st = ampelStatus(diff, planTotal);
  const A  = AMPEL[st];

  type EmpRow = {
    id: string; name: string;
    planH: number; istH: number;
    planWork: number; istWork: number;
    diff: number;
  };

  // Only Flex Arbeit (work) — same logic as pfixAbw (no ferien)
  const rows: EmpRow[] = employees.map(emp => {
    const wage  = emp.hourlyWage;
    const planW = loadDailyPlanDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const istW  = loadDailyIstDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const planWork = planW.reduce((s, r) => s + r.cost, 0);
    const istWork  = istW.reduce((s, r)  => s + r.cost, 0);
    const planH    = planW.reduce((s, r) => s + r.hours, 0);
    const istH     = istW.reduce((s, r)  => s + r.hours, 0);

    // FLEX-SYNC log — these values must match pfixPerEmp row for the same employee & period
    console.log(`[FLEX-SYNC] popup ist hours: ${istH.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup ist chf:   ${istWork.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup plan hours: ${planH.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup plan chf:   ${planWork.toFixed(2)} (${emp.name})`);

    return { id: emp.id, name: emp.name, planH, istH, planWork, istWork, diff: istWork - planWork };
  }).filter(r => r.planWork > 0 || r.istWork > 0)
    .sort((a, b) => {
      // 1) positive deviations first (Ist > Plan), largest first
      // 2) then negative deviations (Ist < Plan), largest absolute first
      // 3) zeros last
      const aPos = a.diff > 0.005;
      const bPos = b.diff > 0.005;
      const aNeg = a.diff < -0.005;
      const bNeg = b.diff < -0.005;
      if (aPos && !bPos) return -1;
      if (!aPos && bPos) return  1;
      if (aNeg && !bNeg) return -1;
      if (!aNeg && bNeg) return  1;
      return Math.abs(b.diff) - Math.abs(a.diff);
    });

  // Top-3 rows by absolute deviation for visual highlight
  const top3Ids = new Set(
    [...rows].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 3).map(r => r.id)
  );

  const sumPlan = rows.reduce((s, r) => s + r.planWork, 0);
  const sumIst  = rows.reduce((s, r) => s + r.istWork,  0);
  const sumDiff = sumIst - sumPlan;

  console.log(`[FLEX] day popup total plan: ${planTotal.toFixed(2)}`);
  console.log(`[FLEX] day popup total ist: ${istTotal.toFixed(2)}`);
  console.log(`[FLEX] day popup diff: ${diff.toFixed(2)}`);
  if (Math.abs(sumPlan - planTotal) > 0.02) console.error(`[FLEX] popup plan mismatch: empTable=${sumPlan.toFixed(2)} header=${planTotal.toFixed(2)} Δ=${(sumPlan-planTotal).toFixed(2)}`);
  if (Math.abs(sumIst  - istTotal)  > 0.02) console.error(`[FLEX] popup ist  mismatch: empTable=${sumIst.toFixed(2)} header=${istTotal.toFixed(2)} Δ=${(sumIst-istTotal).toFixed(2)}`);

  const fmtD = (v: number) => {
    const s = fmtCHF(Math.abs(v));
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const diffCls = (v: number) =>
    v > 0.005  ? 'text-red-600 dark:text-red-400' :
    v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                 'text-muted-foreground';
  const thCls = 'sticky top-0 z-10 bg-muted/80 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border';

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(960px,95vw)] flex flex-col max-h-[88vh] overflow-hidden">
        {/* Sticky Header */}
        <div className={cn('shrink-0 px-6 py-4 border-b', A.border, A.bg || 'bg-muted/20')}>
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold leading-tight">Flex-Auswertung — {label}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Scope: nur Flex-Arbeit (variable MA) — ohne Zusatzkosten Fixlohn-MA und ohne Ferien.
              </p>
              <div className="flex flex-wrap gap-3 mt-2">
                <span className="text-xs text-muted-foreground">Flex-Arbeit Plan <span className="text-blue-700 dark:text-blue-400 font-mono font-semibold">{fmtCHF(planTotal)}</span></span>
                <span className="text-xs text-muted-foreground">Flex-Arbeit Ist <span className="text-orange-700 dark:text-orange-400 font-mono font-semibold">{fmtCHF(istTotal)}</span></span>
                <span className={cn('text-xs font-bold font-mono', diffCls(diff))}>{fmtD(diff)}</span>
                {diffPct !== null && <span className={cn('text-xs font-mono', diffCls(diff))}>({diffPct > 0.005 ? '+' : ''}{diffPct.toFixed(1)} %)</span>}
              </div>
            </div>
            <div className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shrink-0', A.border, A.text)}>
              <span className={cn('w-2.5 h-2.5 rounded-full inline-block', A.dot)} />
              {A.label}
            </div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              Keine Flex-Daten für diesen Zeitraum.
            </div>
          ) : (
            <div className="rounded-md border border-border">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    <th className={cn(thCls, 'text-left')}>Mitarbeiter</th>
                    <th className={cn(thCls, 'text-right text-muted-foreground')}>Plan Std</th>
                    <th className={cn(thCls, 'text-right text-muted-foreground')}>Ist Std</th>
                    <th className={cn(thCls, 'text-right text-blue-600')} title="Nur Flex-Arbeit (variable MA), ohne Zusatzkosten Fixlohn-MA / Ferien">Flex-Arbeit Plan CHF</th>
                    <th className={cn(thCls, 'text-right text-orange-600')} title="Nur Flex-Arbeit (variable MA), ohne Zusatzkosten Fixlohn-MA / Ferien">Flex-Arbeit Ist CHF</th>
                    <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isTop = top3Ids.has(r.id) && Math.abs(r.diff) > 0.005;
                    return (
                    <tr key={r.id} className={cn(
                      i % 2 === 0 ? 'bg-background' : 'bg-muted/15',
                      isTop && 'outline outline-1 outline-amber-300 dark:outline-amber-600 bg-amber-50/50 dark:bg-amber-950/20',
                    )}>
                      <td className={cn('px-3 py-1.5', isTop ? 'font-bold' : 'font-medium')}>
                        {r.name}
                        {isTop && <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Top</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{r.planH > 0 ? `${r.planH.toFixed(1)} h` : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{r.istH > 0 ? `${r.istH.toFixed(1)} h` : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-blue-700 dark:text-blue-400">{r.planWork > 0 ? fmtCHF(r.planWork) : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-orange-700 dark:text-orange-400">{r.istWork > 0 ? fmtCHF(r.istWork) : '–'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-bold', diffCls(r.diff))}>{fmtD(r.diff)}</td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className={cn('border-t-2 border-border font-bold text-xs', A.bg)}>
                    <td className="px-3 py-2">Total ({rows.length} MA)</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{rows.reduce((s,r)=>s+r.planH,0).toFixed(1)} h</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{rows.reduce((s,r)=>s+r.istH,0).toFixed(1)} h</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(sumPlan)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{fmtCHF(sumIst)}</td>
                    <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(sumDiff))}>{fmtD(sumDiff)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* ── Haupttreiber-Zusammenfassung ────────────────────────────────── */}
        {(() => {
          const drivers = [...rows]
            .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
            .slice(0, 3)
            .filter(r => Math.abs(r.diff) > 0.005);
          console.log('[FLEX POPUP] drivers:', drivers.map(r => ({ name: r.name, diffCHF: r.diff })));
          return (
            <div className="shrink-0 border-t border-border bg-muted/25 px-6 py-3">
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
                <span className="font-semibold text-muted-foreground shrink-0">Haupttreiber:</span>
                {drivers.length === 0 ? (
                  <span className="text-muted-foreground italic">Keine relevanten Abweichungen</span>
                ) : drivers.map((r, i) => (
                  <span key={r.id} className="flex items-baseline gap-x-1">
                    {i > 0 && <span className="text-muted-foreground">·</span>}
                    <span className="font-medium text-foreground">{r.name}</span>
                    <span className={cn('font-mono font-semibold', r.diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                      {r.diff > 0 ? '+' : '−'}CHF {fmtCHF(Math.abs(r.diff)).replace('CHF\u00a0', '')}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Sticky Footer */}
        <div className={cn('shrink-0 border-t px-6 py-3 flex items-center justify-between gap-4', A.border, A.bg || 'bg-muted/40')}>
          <span className="text-xs text-muted-foreground">bezieht sich auf: <strong>{label}</strong></span>
          <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
            <span className="text-muted-foreground">Plan <span className="text-blue-700 dark:text-blue-400 font-bold">{fmtCHF(planTotal)}</span></span>
            <span className="text-muted-foreground">Ist <span className="text-orange-700 dark:text-orange-400 font-bold">{fmtCHF(istTotal)}</span></span>
            <span className={cn('font-bold text-sm', A.text)}>{fmtD(diff)}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── WeekDetailPopup ────────────────────────────────────────────────────────────

interface WeekDetailData {
  weekLabel: string;
  dateRange: string;
  dates: string[];
  daysInWeek: number;
  daysInMonth: number;
  fixEmps: Array<{ name: string; dept: string; monthlyCost: number; weeklyCost: number }>;
  flexEmps: Array<{ id: string; name: string; hourlyWage: number }>;
  year: number;
  month: number;
}

function WeekDetailPopup({ data, onClose }: { data: WeekDetailData | null; onClose: () => void }) {
  const { tenantKey } = useTenant();
  if (!data) return null;
  const { weekLabel, dateRange, dates, daysInWeek, daysInMonth, fixEmps, flexEmps, year, month } = data;

  // Flex per employee for this week
  const flexRows = flexEmps.map(emp => {
    const wage = emp.hourlyWage ?? 0;
    if (!wage) return null;
    const planW = loadDailyPlanDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const istW  = loadDailyIstDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const planH = planW.reduce((s, r) => s + r.hours, 0);
    const istH  = istW.reduce((s, r) => s + r.hours, 0);
    const planCost = planW.reduce((s, r) => s + r.cost, 0);
    const istCost  = istW.reduce((s, r) => s + r.cost, 0);
    if (planH === 0 && istH === 0) return null;
    return { name: emp.name, planH, istH, planCost, istCost, diff: istCost - planCost };
  }).filter(Boolean) as Array<{ name: string; planH: number; istH: number; planCost: number; istCost: number; diff: number }>;

  const totalFixWeek  = fixEmps.reduce((s, e) => s + e.weeklyCost, 0);
  const totalFlexPlan = flexRows.reduce((s, r) => s + r.planCost, 0);
  const totalFlexIst  = flexRows.reduce((s, r) => s + r.istCost, 0);
  const totalPlan = totalFixWeek + totalFlexPlan;
  const totalIst  = totalFixWeek + totalFlexIst;

  const diffCls = (v: number) => v > 0.005 ? 'text-red-600 dark:text-red-400' : v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
  const fmtD = (v: number) => `${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${fmtCHF(Math.abs(v))}`;

  return (
    <Dialog open={!!data} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(780px,95vw)] flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-5 py-4 border-b border-border bg-violet-50/40 dark:bg-violet-950/20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">{weekLabel} — Kostendetail</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{dateRange} · {daysInWeek} von {daysInMonth} Tagen</p>
            </div>
            <div className="flex gap-4 text-xs font-mono">
              <span className="text-muted-foreground">Plan Total <span className="text-foreground font-bold">{fmtCHF(totalPlan)}</span></span>
              <span className="text-muted-foreground">Ist Total <span className="text-foreground font-bold">{fmtCHF(totalIst)}</span></span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* FIX Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                Personal FIX (pro-rata {daysInWeek}/{daysInMonth} Tage)
              </p>
              <span className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</span>
            </div>
            {fixEmps.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Keine Fix-Mitarbeiter</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Monat</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Woche ({daysInWeek}T)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fixEmps.map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-medium">{e.name} <span className="text-muted-foreground font-normal">({e.dept})</span></td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtCHF(e.monthlyCost)}</td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmtCHF(e.weeklyCost)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-muted/40 font-bold">
                      <td className="px-3 py-1.5">Total FIX</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* FLEX Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400" title="Nur Flex-Arbeit (variable MA), ohne Zusatzkosten Fixlohn-MA und ohne Ferien">Personal FLEX (nur Flex-Arbeit)</p>
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-blue-600 dark:text-blue-400">Plan {fmtCHF(totalFlexPlan)}</span>
                <span className="text-orange-600 dark:text-orange-400" title="Nur Flex-Arbeit, ohne Zusatzkosten Fixlohn-MA / Ferien">Ist {fmtCHF(totalFlexIst)}</span>
                <span className={cn('font-semibold', diffCls(totalFlexIst - totalFlexPlan))}>{fmtD(totalFlexIst - totalFlexPlan)}</span>
              </div>
            </div>
            {flexRows.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Kein Flex-Einsatz in dieser Woche</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-blue-600 dark:text-blue-400">Plan Std</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-blue-600 dark:text-blue-400">Plan CHF</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-orange-600 dark:text-orange-400">Ist Std</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-orange-600 dark:text-orange-400">Ist CHF</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Δ CHF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flexRows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-medium">{r.name}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{r.planH.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(r.planCost)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{r.istH.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(r.istCost)}</td>
                        <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', diffCls(r.diff))}>{fmtD(r.diff)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-muted/40 font-bold">
                      <td className="px-3 py-1.5">Total FLEX</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-600 dark:text-blue-400">{fmtCHF(totalFlexPlan)}</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-orange-600 dark:text-orange-400">{fmtCHF(totalFlexIst)}</td>
                      <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', diffCls(totalFlexIst - totalFlexPlan))}>{fmtD(totalFlexIst - totalFlexPlan)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Total row */}
          <div className="rounded-lg border-2 border-violet-200 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/20 px-4 py-3">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">FIX (Woche)</p>
                <p className="font-mono font-bold text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">Total Plan</p>
                <p className="font-mono font-bold">{fmtCHF(totalPlan)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">Total Ist</p>
                <p className={cn('font-mono font-bold', diffCls(totalIst - totalPlan))}>{fmtCHF(totalIst)}</p>
                {Math.abs(totalIst - totalPlan) > 0.5 && (
                  <p className={cn('text-[10px] font-semibold font-mono', diffCls(totalIst - totalPlan))}>
                    {fmtD(totalIst - totalPlan)} vs. Plan
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── FlexBreakdownModal ─────────────────────────────────────────────────────────

function FlexBreakdownModal({ target, onClose, onToggleAgSoz }: {
  target: BreakdownTarget | null;
  onClose: () => void;
  onToggleAgSoz?: (empId: string) => void;
}) {
  const { tenantKey } = useTenant();
  if (!target) return null;

  const { empId, empName, field, hourlyWage, weeklyHours, year, month, cutoffDay, factor, agOff } = target;
  const dailyH      = weeklyHours ? weeklyHours / 5 : 8.4;
  const monthLabel  = new Date(year, month - 1, 1).toLocaleString('de-CH', { month: 'long', year: 'numeric' });
  const cutoffLabel = cutoffDay !== null
    ? `${cutoffDay}.${String(month).padStart(2, '0')}.${year}`
    : null;

  // ── Always load all 4 data sources ─────────────────────────────────────────
  const planWorkDays = loadDailyPlanDetails(empId, year, month, cutoffDay, hourlyWage, tenantKey);
  const istWorkDays  = loadDailyIstDetails(empId, year, month, cutoffDay, hourlyWage, tenantKey);
  const ferPlanDays  = loadFerienPlanDayDetails(empId, year, month, cutoffDay, dailyH, hourlyWage, tenantKey);
  const ferIstDays   = loadFerienIstDayDetails(empId, year, month, cutoffDay, dailyH, hourlyWage, tenantKey);

  // ── Unified work day map ────────────────────────────────────────────────────
  type WorkRow = { date: string; planH: number; planCHF: number; istH: number; istCHF: number };
  const workMap = new Map<string, WorkRow>();
  for (const r of planWorkDays) {
    const e = workMap.get(r.date) ?? { date: r.date, planH: 0, planCHF: 0, istH: 0, istCHF: 0 };
    e.planH += r.hours; e.planCHF += r.cost; workMap.set(r.date, e);
  }
  for (const r of istWorkDays) {
    const e = workMap.get(r.date) ?? { date: r.date, planH: 0, planCHF: 0, istH: 0, istCHF: 0 };
    e.istH += r.hours; e.istCHF += r.cost; workMap.set(r.date, e);
  }
  const workRows = Array.from(workMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ── Unified ferien day map ──────────────────────────────────────────────────
  type FerRow = { date: string; planCHF: number; istCHF: number };
  const ferMap = new Map<string, FerRow>();
  for (const r of ferPlanDays) {
    const e = ferMap.get(r.date) ?? { date: r.date, planCHF: 0, istCHF: 0 };
    e.planCHF += r.cost; ferMap.set(r.date, e);
  }
  for (const r of ferIstDays) {
    const e = ferMap.get(r.date) ?? { date: r.date, planCHF: 0, istCHF: 0 };
    e.istCHF += r.cost; ferMap.set(r.date, e);
  }
  const ferRows = Array.from(ferMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totalPlanWork = workRows.reduce((s, r) => s + r.planCHF, 0);
  const totalIstWork  = workRows.reduce((s, r) => s + r.istCHF,  0);
  const totalPlanH    = workRows.reduce((s, r) => s + r.planH,   0);
  const totalIstH     = workRows.reduce((s, r) => s + r.istH,    0);
  const totalPlanFer  = ferRows.reduce((s, r) => s + r.planCHF, 0);
  const totalIstFer   = ferRows.reduce((s, r) => s + r.istCHF,  0);
  const totalPlan     = totalPlanWork + totalPlanFer;
  const totalIst      = totalIstWork  + totalIstFer;
  const diffWork      = totalIstWork  - totalPlanWork;
  const diffFer       = totalIstFer   - totalPlanFer;
  const diffTotal     = totalIst - totalPlan;
  const diffWorkPct   = totalPlanWork > 0 ? (diffWork / totalPlanWork) * 100 : 0;
  const diffTotalPct  = totalPlan > 0 ? (diffTotal / totalPlan) * 100 : 0;
  const noData        = totalPlan === 0 && totalIst === 0;

  // ── Kumulierte Abweichung über workRows ────────────────────────────────────
  let _cumPopup = 0;
  const workRowsWithCum = workRows.map(r => {
    const dCHF = r.istCHF - r.planCHF;
    _cumPopup += dCHF;
    console.log(`[POPUP-CUM] employee: ${empName}`);
    console.log(`[POPUP-CUM] row diff: ${dCHF.toFixed(2)} (${r.date})`);
    console.log(`[POPUP-CUM] running diff total: ${_cumPopup.toFixed(2)}`);
    return { ...r, dCHF, cumDiff: _cumPopup };
  });
  const cumDiffTotal = _cumPopup;

  // ── Ampel ──────────────────────────────────────────────────────────────────
  const overallSt = ampelStatus(diffTotal, totalPlan);
  const overallA  = AMPEL[overallSt];

  // ── Debug logs ─────────────────────────────────────────────────────────────
  const popupMode = cutoffDay !== null ? `cutoff:${cutoffDay}` : 'month';
  console.log(`[POPUP] employee: ${empName}`);
  console.log(`[POPUP] mode: ${popupMode}`);
  console.log(`[POPUP] plan work total: ${totalPlanWork.toFixed(2)}`);
  console.log(`[POPUP] ist work total: ${totalIstWork.toFixed(2)}`);
  console.log(`[POPUP] diff total chf: ${diffTotal.toFixed(2)}`);
  console.log(`[POPUP] daily rows count: ${workRows.length}`);

  // ── Inline helpers ─────────────────────────────────────────────────────────
  const fmtD = (v: number) => {
    const s = fmtCHF(Math.abs(v));
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const fmtDH = (v: number) => {
    const s = `${Math.abs(v).toFixed(2)} h`;
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const diffCls = (v: number) =>
    v > 0.005  ? 'text-red-600 dark:text-red-400' :
    v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                 'text-muted-foreground';
  const thCls = 'sticky top-0 z-10 bg-muted/80 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border';

  const fieldLabels: Record<BreakdownField, string> = {
    planWork: 'Flex Arbeit Plan', istWork: 'Flex Arbeit Ist',
    planHoliday: 'Ferien Plan',   istHoliday: 'Ferien Ist',
    planTotalVar: 'Total Flex Plan', istTotalVar: 'Total Flex Ist',
  };

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(1000px,95vw)] flex flex-col max-h-[88vh] overflow-hidden">

        {/* ── Sticky Header ─────────────────────────────────────────────── */}
        <div className={cn('shrink-0 px-6 py-4 border-b', overallA.border,
          overallA.bg || 'bg-indigo-50/60 dark:bg-indigo-950/20')}>
          {/* Row 1: Name + meta + Ampel badge */}
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold leading-tight truncate">{empName}</h2>
              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                <span className="text-sm text-muted-foreground">{monthLabel}</span>
                {cutoffLabel && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 text-[11px] font-semibold px-2.5 py-0.5 border border-violet-300 dark:border-violet-700">
                    Stichtag {cutoffLabel} · {Math.round(factor * 100)} %
                  </span>
                )}
                {hourlyWage > 0 && (
                  <span
                    className="rounded-full bg-muted border border-border px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
                    title={agOff ? 'Bruttolohn ohne AG-Sozialkosten' : undefined}
                  >
                    {fmtCHFDec(hourlyWage)}/h {agOff ? '(Brutto, ohne AG)' : '(Total AG)'}
                  </span>
                )}
                {agOff && (
                  <span className="rounded-full bg-slate-200 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 text-[10px] font-semibold px-2 py-0.5">
                    ohne AG-Kosten
                  </span>
                )}
                {onToggleAgSoz && (
                  <label
                    className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer select-none border border-border rounded-full px-2 py-0.5"
                    title="AG-Sozialkosten in den CHF-Werten einrechnen (Stunden bleiben unverändert)"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-primary cursor-pointer"
                      checked={!agOff}
                      onChange={() => onToggleAgSoz(empId)}
                      data-testid="checkbox-ag-soz-popup"
                    />
                    AG-Sozialkosten einrechnen
                  </label>
                )}
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                  ← {fieldLabels[field]}
                </span>
              </div>
            </div>
            <div className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shrink-0', overallA.border, overallA.text)}>
              <span className={cn('inline-block w-2.5 h-2.5 rounded-full', overallA.dot)} />
              {overallA.label}
            </div>
          </div>

          {/* Row 2: KPI comparison chips */}
          {!noData && (
            <div className="flex flex-wrap gap-2 mt-3">
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground font-medium">Flex Arbeit:</span>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(totalPlanWork)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono font-semibold text-orange-700 dark:text-orange-400">{fmtCHF(totalIstWork)}</span>
                <span className={cn('font-mono font-bold ml-0.5', diffCls(diffWork))}>{fmtD(diffWork)}</span>
                {totalPlanWork > 0 && <span className={cn('text-[10px]', diffCls(diffWork))}>({diffWorkPct > 0.005 ? '+' : ''}{diffWorkPct.toFixed(1)} %)</span>}
              </div>
              {(totalPlanFer > 0 || totalIstFer > 0) && (
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground font-medium">Ferien:</span>
                  <span className="font-mono font-semibold text-blue-500 dark:text-blue-300">{fmtCHF(totalPlanFer)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono font-semibold text-orange-500 dark:text-orange-300">{fmtCHF(totalIstFer)}</span>
                  <span className={cn('font-mono font-bold ml-0.5', diffCls(diffFer))}>{fmtD(diffFer)}</span>
                </div>
              )}
              <div className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold', overallA.border, overallA.bg)}>
                <span className="text-muted-foreground font-medium">Total Flex:</span>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(totalPlan)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono font-semibold text-orange-700 dark:text-orange-400">{fmtCHF(totalIst)}</span>
                <span className={cn('font-mono font-bold ml-0.5', overallA.text)}>{fmtD(diffTotal)}</span>
                {totalPlan > 0 && <span className={cn('text-[10px]', overallA.text)}>({diffTotalPct > 0.005 ? '+' : ''}{diffTotalPct.toFixed(1)} %)</span>}
              </div>
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground font-medium">Kum. Abw.:</span>
                <span className={cn('font-mono font-bold', diffCls(cumDiffTotal))}>
                  {cumDiffTotal > 0.005 ? '+' : cumDiffTotal < -0.005 ? '−' : ''}{fmtCHF(Math.abs(cumDiffTotal))}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Scrollable Body ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">

          {noData ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              Keine Plan- oder Ist-Daten für diesen Mitarbeiter im gewählten Zeitraum.
            </div>
          ) : (
            <>
              {/* ── Flex Arbeit Plan vs. Ist ──────────────────────────── */}
              {workRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Flex Arbeit — Plan vs. Ist
                  </p>
                  <div className="rounded-md border border-border">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr>
                          <th className={cn(thCls, 'text-center w-7')}>●</th>
                          <th className={cn(thCls, 'text-left')}>Datum</th>
                          <th className={cn(thCls, 'text-right text-blue-600')}>Plan Std.</th>
                          <th className={cn(thCls, 'text-right text-orange-600')}>Ist Std.</th>
                          <th className={cn(thCls, 'text-right')}>Diff Std.</th>
                          <th className={cn(thCls, 'text-right text-blue-600')}>Plan CHF</th>
                          <th className={cn(thCls, 'text-right text-orange-600')}>Ist CHF</th>
                          <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                          <th className={cn(thCls, 'text-right')}>Kum. Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workRowsWithCum.map((r, i) => {
                          const dH   = r.istH   - r.planH;
                          const rSt  = (r.planCHF === 0 && r.istCHF === 0) ? 'neutral' as AmpelStatus : ampelStatus(r.dCHF, r.planCHF);
                          const rA   = AMPEL[rSt];
                          const cumCls = r.cumDiff > 0.005 ? 'text-red-600 dark:text-red-400'
                            : r.cumDiff < -0.005 ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground';
                          return (
                            <tr key={i} className={cn(i % 2 === 0 ? 'bg-background' : 'bg-muted/15', rA.bg)}>
                              <td className="px-2 py-1.5 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', rA.dot)} /></td>
                              <td className="px-3 py-1.5 font-mono">{fmtDate(r.date)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-600">{r.planH > 0 ? `${r.planH.toFixed(2)} h` : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-600">{r.istH > 0 ? `${r.istH.toFixed(2)} h` : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums', diffCls(dH))}>{(r.planH === 0 && r.istH === 0) ? '–' : fmtDH(dH)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{r.planCHF > 0 ? fmtCHFDec(r.planCHF) : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{r.istCHF > 0 ? fmtCHFDec(r.istCHF) : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold', diffCls(r.dCHF))}>{(r.planCHF === 0 && r.istCHF === 0) ? '–' : fmtD(r.dCHF)}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-[11px]', cumCls)}>
                                {r.cumDiff > 0.005 ? '+' : r.cumDiff < -0.005 ? '−' : ''}{fmtCHF(Math.abs(r.cumDiff))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className={cn('border-t-2 border-border font-bold text-xs', overallA.bg)}>
                          <td className="px-2 py-2 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', overallA.dot)} /></td>
                          <td className="px-3 py-2">Total ({workRows.length} T.)</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-600">{totalPlanH > 0 ? `${(Math.round(totalPlanH * 10) / 10).toFixed(1)} h` : '–'}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-600">{totalIstH > 0 ? `${(Math.round(totalIstH * 10) / 10).toFixed(1)} h` : '–'}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(totalIstH - totalPlanH))}>{fmtDH(totalIstH - totalPlanH)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(totalPlanWork)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{fmtCHF(totalIstWork)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(diffWork))}>{fmtD(diffWork)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(cumDiffTotal))}>
                            {cumDiffTotal > 0.005 ? '+' : cumDiffTotal < -0.005 ? '−' : ''}{fmtCHF(Math.abs(cumDiffTotal))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Ferien Plan vs. Ist ─────────────────────────────── */}
              {ferRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Ferienabbau (FE) — Plan vs. Ist
                  </p>
                  <div className="rounded-md border border-border">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr>
                          <th className={cn(thCls, 'text-center w-7')}>●</th>
                          <th className={cn(thCls, 'text-left')}>Datum</th>
                          <th className={cn(thCls, 'text-right text-blue-500')}>Plan Ferien CHF</th>
                          <th className={cn(thCls, 'text-right text-orange-500')}>Ist Ferien CHF</th>
                          <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ferRows.map((r, i) => {
                          const dCHF = r.istCHF - r.planCHF;
                          const rSt  = (r.planCHF === 0 && r.istCHF === 0) ? 'neutral' as AmpelStatus : ampelStatus(dCHF, r.planCHF);
                          const rA   = AMPEL[rSt];
                          return (
                            <tr key={i} className={cn(i % 2 === 0 ? 'bg-background' : 'bg-muted/15', rA.bg)}>
                              <td className="px-2 py-1.5 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', rA.dot)} /></td>
                              <td className="px-3 py-1.5 font-mono">{fmtDate(r.date)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-500 dark:text-blue-300">{r.planCHF > 0 ? fmtCHFDec(r.planCHF) : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-500 dark:text-orange-300">{r.istCHF > 0 ? fmtCHFDec(r.istCHF) : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold', diffCls(dCHF))}>{fmtD(dCHF)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/40 font-bold text-xs">
                          <td className="px-2 py-2" />
                          <td className="px-3 py-2 text-muted-foreground">Total ({ferRows.length} Tag{ferRows.length !== 1 ? 'e' : ''})</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-500 dark:text-blue-300">{fmtCHF(totalPlanFer)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-500 dark:text-orange-300">{fmtCHF(totalIstFer)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(diffFer))}>{fmtD(diffFer)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">
                    Basis: {fmtCHFDec(hourlyWage)}/h (Total Arbeitgeberkosten) × {dailyH.toFixed(2)} h/Tag = {fmtCHFDec(dailyH * hourlyWage)}/Ferientag
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Sticky Footer — Grand Total ───────────────────────────────── */}
        {(totalPlan > 0 || totalIst > 0) && (
          <div className={cn('shrink-0 border-t px-6 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1',
            overallA.bg || 'bg-muted/50', overallA.border)}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Grand Total</span>
              <span className={cn('inline-flex items-center gap-1 rounded-full text-[10px] font-semibold px-2 py-0.5 border', overallA.border, overallA.text)}>
                <span className={cn('w-1.5 h-1.5 rounded-full inline-block', overallA.dot)} />
                {overallA.label}
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
              {(totalPlanH > 0 || totalIstH > 0) && (
                <span className="text-muted-foreground text-[11px]">
                  {(Math.round(totalPlanH * 10)/10).toFixed(1)} h Plan / {(Math.round(totalIstH * 10)/10).toFixed(1)} h Ist
                </span>
              )}
              <span className="text-muted-foreground">Plan <span className="text-blue-700 dark:text-blue-400 font-semibold">{fmtCHF(totalPlan)}</span></span>
              <span className="text-muted-foreground">Ist <span className="text-orange-700 dark:text-orange-400 font-semibold">{fmtCHF(totalIst)}</span></span>
              <span className={cn('font-bold text-sm', overallA.text)}>{fmtD(diffTotal)}</span>
            </div>
          </div>
        )}

      </DialogContent>
    </Dialog>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function PersonalFixPage() {
  const { isAdmin, isBeaulieuManager, canEditEmployees, canSeeHourlyWages, canSeePersonnelCostTotals } = usePermissions();
  const { tenantId, tenantKey } = useTenant();
  const { maisonExclude } = useMaison();
  const { rates: socialCostRates } = useSocialCostRates();
  const navigate = useNavigate();
  const maisonOn = getMaisonEnabledSync(tenantKey);
  if (!isAdmin && !isBeaulieuManager) return <Navigate to="/personal" replace />;

  const today = new Date();
  // Monats-Kontext aus dem Management-KPI-Dashboard (?monat=YYYY-MM, nur Initialwert)
  const [searchParams] = useSearchParams();
  const monatParam = parseMonatParam(searchParams.get(MONAT_PARAM));
  const [selectedYear, setSelectedYear] = useState(monatParam?.year ?? today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(monatParam?.month ?? today.getMonth() + 1);
  // Überstundenkosten in Total/PKQ einbeziehen (Toggle der Überstunden-Karte)
  const [includeOvertime, setIncludeOvertime] = useState(false);
  // Pro Mitarbeiter dauerhaft deaktivierte Überstundenberechnung (Supabase KV, mandanten-prefixed)
  const [overtimeDisabledIds, setOvertimeDisabledIds] = useState<Set<string>>(new Set());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [extraCostPeople, setExtraCostPeople] = useState<ExtraCostPerson[]>([]);
  // ── Zentrale Berechnungsquelle (src/lib/personalkosten.ts) ─────────────────
  // Einzige Quelle für Schlagzeile/KPI/Budget/PKQ. Detailtabellen behalten ihre
  // bestehende Logik; hier werden nur die Kopf-Kennzahlen daraus gespeist.
  const [pkDaten, setPkDaten] = useState<PersonalkostenDaten | null>(null);
  // Vollständige Supabase IST-Einträge (inkl. isAdditionalCost-Flag) für persistente Zusatzkosten-Berechnung
  const [supabaseActualHours, setSupabaseActualHours] = useState<Record<string, ActualHourEntry>>({});
  const [supabaseActualHoursLoaded, setSupabaseActualHoursLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [varHours, setVarHours] = useState<Record<string, number>>(() => loadVarHours(tenantKey));
  const [varWeekly, setVarWeekly] = useState<Record<string, WeeklyBaseline>>(() => loadVarWeekly(tenantKey));
  const [varPricingMode, setVarPricingMode] = useState<Record<string, PricingMode>>(() => loadVarPricingMode(tenantKey));
  const [varDayRate, setVarDayRate] = useState<Record<string, DayRateData>>(() => loadVarDayRate(tenantKey));
  const [varView, setVarView] = useState<VarView>('plan');
  const [planHours, setPlanHours] = useState<Record<string, number>>({});
  const [istHours, setIstHours] = useState<Record<string, number>>({});
  /** Lohnart-Wechsel MITTEN im Anzeigemonat (empId → Split mit Tage-Anteilen). */
  const [wageSplits, setWageSplits] = useState<Record<string, MonthWageSplit>>({});
  /** Unangereicherte employees-Stammsätze (Quelle für alle upsertEmployee-Saves). */
  const rawEmployeesRef = useRef<Map<string, Employee>>(new Map());
  // empId → Anzahl FE-Tage im Ist (absenceType='FE' in actual-hours-* localStorage)
  const [ferienIstDays, setFerienIstDays] = useState<Record<string, number>>({});
  // empId → Anzahl FE-Tage im PLAN (frühAbsence/spätAbsence='FE' in schedule-v2-* localStorage)
  const [ferienPlanDays, setFerienPlanDays] = useState<Record<string, number>>({});
  // empId → Anzahl K+U-Tage im Plan (frühAbsence/spätAbsence in schedule-v2-*)
  const [kuPlanDays, setKuPlanDays] = useState<Record<string, number>>({});
  // empId → Anzahl K+U-Tage im Ist (absenceType in SICK_CODES|ACCIDENT_CODES in actual-hours-*)
  const [kuIstDays, setKuIstDays] = useState<Record<string, number>>({});
  // Ferienabbau Drill-down aufgeklappt
  const [showFerienDetail, setShowFerienDetail] = useState(false);
  // Kranken-/Unfallkosten-Detail (Side-Info, default zu)
  const [showKuSection, setShowKuSection] = useState(false);
  // Ferien Detail-Daten (welche Tage genau)
  const [ferienPlanDetail, setFerienPlanDetail] = useState<Record<string, { date: string }[]>>({});
  const [ferienIstDetail, setFerienIstDetail]   = useState<Record<string, { date: string }[]>>({});
  // Popup: Detail-Tage für einen Mitarbeiter anzeigen
  const [showFerienDayDetail, setShowFerienDayDetail] = useState<{empId: string; source: 'plan'|'ist'; empName: string} | null>(null);
  // Checkbox: Ferienabbau in Budget-Auswertung einbeziehen
  const [ferienInBudget, setFerienInBudget] = useState(false);
  // Manuelle Flex-Ist-Overrides (pro MA + Total, pro Mandant/Jahr/Monat, KV-Upsert)
  const [flexOverrides, setFlexOverrides] = useState<FlexIstOverrides>({ ...EMPTY_FLEX_OVERRIDES });
  // Tagesumsätze für den gewählten Monat (für Stichtag Controlling)
  const [monthlyRevenues, setMonthlyRevenues] = useState<Record<string, { actualRevenue?: number; takeawayRevenue?: number }>>({});
  // Manuelle Umsatz-Annahme für PKQ-Berechnung (gespeichert per Monat/Tenant)
  const [revenueAssumption, setRevenueAssumption] = useState<number | null>(() =>
    loadRevenueAssumption(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [revenueAssumptionInput, setRevenueAssumptionInput] = useState(() => {
    const v = loadRevenueAssumption(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [budgetRevenue, setBudgetRevenue] = useState<number | null>(() =>
    loadBudgetRevenue(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [budgetRevenueInput, setBudgetRevenueInput] = useState(() => {
    const v = loadBudgetRevenue(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [weekIstSet, setWeekIstSet] = useState<Set<string>>(() =>
    new Set(loadWeekIstSet(today.getFullYear(), today.getMonth() + 1, tenantKey)),
  );
  const [weekRevOverrides, setWeekRevOverrides] = useState<Record<string, number>>(() =>
    loadWeekRevOverrides(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [weekRevEditKey, setWeekRevEditKey] = useState<string | null>(null);
  const [weekRevEditVal, setWeekRevEditVal] = useState('');
  // K/U Detail-Daten (welche Tage genau)
  const [kuPlanDetail, setKuPlanDetail] = useState<Record<string, KUDayEntry[]>>({});
  const [kuIstDetail, setKuIstDetail]   = useState<Record<string, KUDayEntry[]>>({});
  // Popup: Detail-Tage für einen Mitarbeiter anzeigen
  const [showKuDetail, setShowKuDetail] = useState<{empId: string; empName: string; typeFilter?: 'krank'|'unfall'} | null>(null);
  // Checkbox: K/U-Kosten in Budget-Auswertung einbeziehen
  const [krankInBudget, setKrankInBudget] = useState(false);
  const [unfallInBudget, setUnfallInBudget] = useState(false);
  // Krank / Unfall separat (Plan + Ist)
  const [kuPlanBreakdown, setKuPlanBreakdown] = useState<Record<string, KUBreakdown>>({});
  const [kuIstBreakdown, setKuIstBreakdown]   = useState<Record<string, KUBreakdown>>({});
  const [scenarioPkCost, setScenarioPkCost] = useState<number | null>(() =>
    loadScenarioPkCost(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [scenarioPkCostInput, setScenarioPkCostInput] = useState(() => {
    const v = loadScenarioPkCost(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [scenarioPkqInput, setScenarioPkqInput] = useState('');
  const [weekDetailTarget, setWeekDetailTarget] = useState<string | null>(null);
  const [showWeekSummary, setShowWeekSummary] = useState(false);

  // ── Pro-Rata-Abgrenzung ────────────────────────────────────────────────────
  // null = aus; Zahl = Stichtag (1–letzter Tag des Monats)
  const [proRataDay, setProRataDay] = useState<number | null>(null);

  // ── Flex-Breakdown-Popup ──────────────────────────────────────────────────
  const [breakdown, setBreakdown] = useState<BreakdownTarget | null>(null);
  // ── AG-Sozialkosten pro Flex-MA aus (true = ohne AG) — per Mandant persistiert ──
  const [agSozOff, setAgSozOff] = useState<Record<string, boolean>>({});
  // Personalcontrolling-Drilldown (Ursachenanalyse) — null = geschlossen
  const [drilldownFocus, setDrilldownFocus] = useState<DrilldownFocus | null>(null);
  const [abwMode,   setAbwMode]   = useState<AbwMode>('week');
  const [forecastViewMode, setForecastViewMode] = useState<'actual' | 'forecast'>('actual');
  const [dayDetailModal, setDayDetailModal] = useState<AbwDay | null>(null);
  const [forecastIstDay,   setForecastIstDay]   = useState<number | null>(null);
  const [flexPeriodPopup,  setFlexPeriodPopup]  = useState<FlexPeriodTarget | null>(null);
  const [expandedFixDepts, setExpandedFixDepts] = useState<Set<string>>(new Set());
  /** Abteilungs-Filter der gemeinsamen FIX-Tabelle: alle / nur Küche / nur Service. */
  const [fixDeptFilter, setFixDeptFilter] = useState<'alle' | 'service' | 'küche'>('alle');
  // Incremented whenever schedule-v2-* localStorage changes (schedule-updated event)
  // so that pfixPerEmp and planHours re-read the latest data without a page reload.
  const [scheduleRefreshTick, setScheduleRefreshTick] = useState(0);
  // ── Planungsempfehlungen (read-only, lazy) ─────────────────────────────────
  const [planungOpen, setPlanungOpen] = useState(false);
  const [recoSeason, setRecoSeason] = useState<StaffingSeason>(DEFAULT_SEASON);
  // Personen pro Tag aus Reservationen: null = nicht verfügbar/Fehler.
  const [recoPersons, setRecoPersons] = useState<Record<string, number> | null>(null);
  const [recoPersonsLoaded, setRecoPersonsLoaded] = useState(false);
  const { requirements: staffingRequirements } = useStaffingRequirements();
  const { positions } = usePositions();

  // Monat/Tenant-Wechsel → Reservations-Personen neu laden (lazy, nur wenn offen).
  useEffect(() => {
    setRecoPersons(null);
    setRecoPersonsLoaded(false);
  }, [selectedYear, selectedMonth, tenantId]);

  // Reservationen NUR lesen (Personen pro Tag), PII wird sofort abgestreift.
  // Fehler/fehlende Tabellen → null (die Empfehlungen kennzeichnen das als
  // fehlende Datenbasis, es wird nichts geschätzt).
  useEffect(() => {
    if (!planungOpen || recoPersonsLoaded) return;
    let alive = true;
    const prefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
    void fetchReservationsInRange(tenantId, `${prefix}-01`, `${prefix}-${String(lastDay).padStart(2, '0')}`)
      .then((detailRows) => {
        if (!alive) return;
        const rows: ReservationAnalyticsRow[] = detailRows.map((r) => ({
          reservationDate: r.date,
          reservationTime: r.time ?? null,
          partySize: r.partySize,
          statusNormalized: r.status as ReservationAnalyticsRow['statusNormalized'],
          reservedAt: null,
          guestKey: null,
        }));
        const map: Record<string, number> = {};
        for (const p of personsPerDay(rows, { excludeCancelled: true })) map[p.date] = p.persons;
        setRecoPersons(map);
        setRecoPersonsLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setRecoPersons(null);
        setRecoPersonsLoaded(true);
      });
    return () => { alive = false; };
  }, [planungOpen, recoPersonsLoaded, tenantId, selectedYear, selectedMonth]);

  useEffect(() => {
    const handler = () => setScheduleRefreshTick(t => t + 1);
    window.addEventListener('schedule-updated', handler);
    return () => window.removeEventListener('schedule-updated', handler);
  }, []);

  // Contract history for mid-month switch detection
  const contractHistoryMap = useMemo(
    () => loadAllContractHistory(tenantKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId],
  );

  useEffect(() => {
    setLoading(true);
    console.log(`[EMPLOYEE LOAD] tenant: ${tenantId}`);
    Promise.all([
      loadEmployees(tenantId),
      loadExtraCostPeople(tenantId),
    ]).then(async ([emps, extraPeople]) => {
      setExtraCostPeople(extraPeople.filter(p => p.isActive));
      if (emps) {
        // SSOT Lohnart: im ANZEIGEMONAT aktive Vertragsphase (Monatslohn = FIX,
        // Stundenlohn = FLEX); employees-Stammsatz nur als Fallback ohne Historie.
        const { employees: enriched, splits } =
          await applyEffectiveWagesForMonth(emps, selectedYear, selectedMonth, tenantId);
        // Unangereicherte Stammsätze für Save-Pfade aufbewahren: die Anreicherung
        // (verdrängter Monatslohn, has13thSalary der Historie-Phase) darf beim
        // Editieren NIE in die employees-Tabelle zurückgeschrieben werden.
        rawEmployeesRef.current = new Map(emps.map(e => [String(e.id), e]));
        setEmployees(enriched);
        setWageSplits(splits);
        console.log(`[EMPLOYEE LOAD] count: ${enriched.length} + ${extraPeople.length} ExtraCost`);
        // ─── [CONSISTENCY] Standardformat-Logs ───────────────────────────
        console.log(`[CONSISTENCY] tenant: ${tenantId}`);
        console.log(`[CONSISTENCY] personal_fix employees: ${emps.length}`);
        console.log(`[CONSISTENCY] employee names personal_fix: ${emps.map(e => e.name).join(', ')}`);
        if (tenantId === 'beaulieu') {
          const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi', 'eduard', 'nahuel', 'nina'];
          const leak = emps.filter(e => olivNames.some(o => e.name.toLowerCase().includes(o)));
          console.log(`[CONSISTENCY] mismatch: ${leak.length > 0 ? 'yes – Oliv-Leak: ' + leak.map(e => e.name).join(', ') : 'no'}`);
          const küche   = emps.filter(e => e.department === 'küche');
          const service = emps.filter(e => e.department === 'service');
          console.log(`[CONSISTENCY] personal_fix breakdown: Küche=${küche.length}, Service=${service.length}`);
          // ─── [BEAULIEU-WAGE] Lohnvollständigkeit ─────────────────────────
          const missingWage = emps.filter(e => (e.hourlyWage ?? 0) === 0 && (e.monthlySalary ?? 0) === 0);
          console.log(`[BEAULIEU-WAGE] Mitarbeiter ohne Lohn: ${missingWage.length}/${emps.length}`);
          if (missingWage.length > 0) {
            console.log(`[BEAULIEU-WAGE] Fehlende Löhne bei: ${missingWage.map(e => e.name).join(', ')}`);
          } else {
            console.log(`[BEAULIEU-WAGE] Alle Löhne hinterlegt – OK`);
          }
        } else {
          const beaulieuLeak = emps.filter(e => String(e.id).startsWith('b-'));
          console.log(`[CONSISTENCY] mismatch: ${beaulieuLeak.length > 0 ? 'yes – Beaulieu-Leak in Oliv' : 'no'}`);
        }
      } else {
        setEmployees([]);
        setWageSplits({});
        console.log(`[CONSISTENCY] personal_fix employees: 0 (keine Daten von Supabase)`);
      }
      setLoading(false);
    });
  // WICHTIG: selectedYear/selectedMonth als Deps — die FIX/FLEX-Einordnung folgt
  // der im ANZEIGEMONAT aktiven Vertragsphase (vorher blieb sie am Lade-Monat kleben).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, selectedYear, selectedMonth]);


  // Tagesumsätze bei Monatswechsel neu laden
  useEffect(() => {
    setMonthlyRevenues(readDailyBudgetsLocal(selectedYear, selectedMonth, tenantKey));
    const onSync = () => setMonthlyRevenues(readDailyBudgetsLocal(selectedYear, selectedMonth, tenantKey));
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId]);

  // Reload Plan/Ist hours whenever month changes OR schedule-updated fires.
  // Plan-Stunden: read localStorage first (fast), then enrich with Supabase schedule data.
  // Ist-Stunden: read localStorage first (fast), then enrich with Supabase data.
  // Supabase is the canonical source when both planners write there; localStorage
  // is the fallback/cache for entries that haven't round-tripped through Supabase.
  // scheduleRefreshTick: incremented by schedule-updated listener → triggers re-read
  // without full Supabase round-trip (skip the async enrichment on tick-only changes).
  useEffect(() => {
    // Fast local read first (instant, no flicker) — runs on every refresh (tick or month change)
    setPlanHours(loadPlanHoursFromStorage(selectedYear, selectedMonth, tenantKey));
    // FE-Ferientage immer aus localStorage (Supabase speichert kein absenceType)
    const istFE = loadFerienDaysFromStorage(selectedYear, selectedMonth, tenantKey);
    setFerienIstDays(istFE);
    const planFE = loadFerienDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey);
    setFerienPlanDays(planFE);
    console.log(`[FERIEN] preserved on reload: ist=${Object.values(istFE).reduce((s, v) => s + v, 0)} plan=${Object.values(planFE).reduce((s, v) => s + v, 0)} FE-Tage gesamt`);
    setFerienPlanDetail(loadFerienDetailFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setFerienIstDetail(loadFerienDetailFromStorage(selectedYear, selectedMonth, tenantKey));
    setFerienInBudget(loadFerienInBudget(tenantId, selectedYear, selectedMonth));
    // K/U-Tage aus localStorage (Krank/Unfall 80%) — Plan + Ist + Detail
    const planKU = loadKUDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey);
    setKuPlanDays(planKU);
    const istKU = loadKUDaysFromStorage(selectedYear, selectedMonth, tenantKey);
    setKuIstDays(istKU);
    setKuPlanDetail(loadKUDetailFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setKuIstDetail(loadKUDetailFromIstStorage(selectedYear, selectedMonth, tenantKey));
    setKrankInBudget(loadKrankInBudget(tenantId, selectedYear, selectedMonth));
    setUnfallInBudget(loadUnfallInBudget(tenantId, selectedYear, selectedMonth));
    setAgSozOff(loadAgSozOffMap(tenantId));
    setKuPlanBreakdown(loadKUBreakdownFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setKuIstBreakdown(loadKUBreakdownFromStorage(selectedYear, selectedMonth, tenantKey));

    // SSoT: Supabase (schedule_entries) ist die kanonische Quelle für Plan-Stunden.
    // Der Monat wird bei JEDEM Refresh (Mount, Monats-/Tenant-Wechsel UND
    // schedule-updated-Tick nach Import/Dienstplan-Änderung) frisch gespiegelt —
    // localStorage ist ein reiner Cache und wird VOLLSTÄNDIG ersetzt (kein Merge).
    // Einziger Guard: echter Supabase-Fehler (null) → lokales Ergebnis behalten.
    // Stale-Guard: bei Monats-/Tenant-Wechsel oder neuem Tick werden ältere,
    // noch laufende Requests verworfen (sonst könnte ein out-of-order Response
    // den frischeren Spiegel/State wieder mit alten Daten überschreiben).
    let stale = false;
    setSupabaseActualHours({});
    setSupabaseActualHoursLoaded(false);
    const scheduleMonthDate = new Date(selectedYear, selectedMonth - 1, 1);
    loadScheduleForMonth(scheduleMonthDate, tenantId).then(supabaseSchedule => {
      if (stale) return; // veralteter Request – verwerfen
      if (!supabaseSchedule) return; // Supabase error – keep local result
      const totalEntries = Object.keys(supabaseSchedule).length;
      console.log(`[PLAN] personal-fix schedule loaded from Supabase: ${totalEntries} Einträge für ${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      const scheduleKey = tenantKey(`schedule-v2-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      // Vollersatz: localStorage = exakt die Supabase-Einträge des Monats.
      // isAdditionalCostPlan kommt aus Supabase (SchedulePlanner schreibt es dorthin);
      // alte lokale Flags/Geister-Einträge werden bewusst NICHT übernommen.
      const written = mirrorPlanMonthToLocalStorage(supabaseSchedule, scheduleKey);
      if (!written) console.warn('[PLAN] personal-fix: localStorage-Spiegel fehlgeschlagen (Quota?) – verwende Supabase-Daten direkt');
      // Debug + INVARIANTE: pro Mitarbeiter gezählte Einträge, Monats-Präfixe,
      // Brutto/Netto. Netto («Plan Std») darf NIE über der Brutto-Summe der
      // Monats-Zeitspannen liegen; Fremdmonats-Einträge dürfen nicht zählen.
      if (import.meta.env.DEV) {
      const debugSource = written
        ? (() => { try { return JSON.parse(localStorage.getItem(scheduleKey) || '{}') as Record<string, unknown>; } catch { return supabaseSchedule as Record<string, unknown>; } })()
        : supabaseSchedule as Record<string, unknown>;
      for (const d of debugPlanHours(debugSource, selectedYear, selectedMonth)) {
        console.log(`[PLAN-STD] ${d.empId}: ${d.entries} Einträge, brutto ${d.grossHours.toFixed(1)} h, netto ${d.netHours.toFixed(2)} h, Monats-Präfixe [${d.monthPrefixes.join(', ')}]${d.skippedForeignMonth > 0 ? ` — ${d.skippedForeignMonth} Fremdmonats-Einträge übersprungen` : ''}`);
        if (d.netHours > d.grossHours + 0.01) {
          console.error(`[PLAN-STD] INVARIANTE VERLETZT für ${d.empId}: netto ${d.netHours} > brutto ${d.grossHours} — Fremdmonats-/Doppelzählung prüfen!`);
        }
      }
      }
      // Re-read plan hours and ferien plan — bei Schreibfehler direkt aus Supabase-Daten
      setPlanHours(written
        ? loadPlanHoursFromStorage(selectedYear, selectedMonth, tenantKey)
        : aggregatePlanHours(supabaseSchedule as Record<string, unknown>, selectedYear, selectedMonth));
      setFerienPlanDays(loadFerienDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    });

    // Fast local read first
    const localIst = loadIstHoursFromStorage(selectedYear, selectedMonth, tenantKey);
    setIstHours(localIst);

    // Then enrich with Supabase (async)
    const monthDate = new Date(selectedYear, selectedMonth - 1, 1);
    loadActualHoursForMonth(monthDate, tenantId).then(supabaseRaw => {
      if (stale) return; // veralteter Request – verwerfen
      if (!supabaseRaw) return; // Supabase error – keep local result
      // Vollständige Einträge speichern (inkl. isAdditionalCost für Zusatzkosten-Berechnung)
      setSupabaseActualHours(supabaseRaw);
      setSupabaseActualHoursLoaded(true);

      // Read localStorage now — needed for FE absence check and write-back
      const monthKey = tenantKey(`actual-hours-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      const existingLocal: Record<string, unknown> = (() => {
        try { return JSON.parse(localStorage.getItem(monthKey) || '{}'); } catch { return {}; }
      })();

      // Aggregate by empId — skip days where localStorage has FE absence.
      // Admin FE marking is authoritative over Mirus import data.
      const supabaseAgg: Record<string, number> = {};
      for (const [cellKey, entry] of Object.entries(supabaseRaw)) {
        const empId = cellKey.slice(0, cellKey.length - 11);
        if (!empId) continue;
        const localEntry = existingLocal[cellKey] as Record<string, unknown> | undefined;
        if ((localEntry as any)?.absenceType === 'FE') continue; // FE override wins
        const h = entry?.hours ?? 0;
        if (h > 0) supabaseAgg[empId] = (supabaseAgg[empId] ?? 0) + Math.round(h * 100) / 100;
      }
      // Merge: Supabase (FE-filtered) wins over localStorage aggregation on conflict
      const merged = { ...localIst, ...supabaseAgg };
      const totalH = Object.values(merged).reduce((s, h) => s + h, 0);
      console.log(
        `[IST] personal-fix rows loaded (merged): ${Object.keys(merged).length} Mitarbeiter / ${Math.round(totalH * 10) / 10} h`,
        { localStorage: Object.keys(localIst).length, supabase: Object.keys(supabaseAgg).length },
      );
      setIstHours(merged);

      // Write merged back to localStorage — FE/K/F absenceType entries must NEVER be
      // overwritten by Supabase data (Supabase has no absenceType column; FE are localStorage-only).
      if (Object.keys(supabaseRaw).length > 0) {
        // Start from local (preserves absenceType metadata), let Supabase win only for real hours
        const mergedRaw: Record<string, unknown> = { ...existingLocal };
        let fePreserved = 0;
        for (const [key, val] of Object.entries(supabaseRaw)) {
          const localEntry = mergedRaw[key] as Record<string, unknown> | undefined;
          if (localEntry?.absenceType) {
            // Local FE/K/F entry protected — admin override wins over Mirus data
            fePreserved++;
            console.log(`[FERIEN] preserved on navigation: ${key} absenceType=${localEntry?.absenceType}`);
          } else {
            // No local absence — Supabase wins, preserve localStorage-only flags
            mergedRaw[key] = localEntry?.isAdditionalCost
              ? { ...(val as object), isAdditionalCost: true }
              : val;
          }
        }
        if (fePreserved > 0) {
          console.log(`[FERIEN] PersonalFix load: preserved ${fePreserved} FE/K/F entries`);
        }
        localStorage.setItem(monthKey, JSON.stringify(mergedRaw));
        console.log(`[FERIEN] saved persistently: source=supabase+local merged=${Object.keys(mergedRaw).length}`);
      }
    }).catch(err => console.error('[IST] Supabase load failed in PersonalFix:', err));

    // Cleanup: markiert laufende Requests dieses Laufs als veraltet.
    return () => { stale = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId, scheduleRefreshTick]);

  // ── Zentrale Personalkosten-Daten laden (SSOT für Kopf-Kennzahlen) ─────────
  // Analog zu PersonalkostenNeu.tsx: bei Monats-/Tenant-Wechsel und bei
  // scheduleRefreshTick (Dienstplan-/Ist-/Umsatz-Sync) neu laden.
  useEffect(() => {
    if (!socialCostRates) return;
    let alive = true;
    setPkDaten(null);
    ladePersonalkostenDaten(selectedYear, selectedMonth, tenantId, tenantKey, socialCostRates)
      .then(d => { if (alive) setPkDaten(d); })
      .catch(err => { if (alive) { setPkDaten(null); console.error('[PK-SSOT] Laden fehlgeschlagen:', err); } });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId, scheduleRefreshTick, socialCostRates, agSozOff]);

  // Kanonische Kennzahlen (Hochrechnung/Ist/PKQ/Umsatz/Stichtag) aus der SSOT.
  const pkZentral = useMemo(() => {
    if (!pkDaten) return null;
    // Effektiver Ist-Stichtag: letzter Tag mit importierten Ist-Stunden/-Umsatz
    // (gemeinsamer früherer Tag → PK-Ist und Umsatz-Ist messen denselben
    // Zeitraum, PKQ Ist bleibt kongruent) — nie ein leerer Folgetag.
    const stichtag = effektiverIstStichtag(pkDaten);
    const kHr = personalkosten(pkDaten, 'hochrechnung', { stichtag });
    const kIst = personalkosten(pkDaten, 'istBisHeute', { stichtag });
    const pkq = personalquote(pkDaten, { stichtag });
    const ums = umsatz(pkDaten, { stichtag });
    // Budget LIVE aus dem Budget-Modul (SSoT); null = kein PK-Budget hinterlegt.
    const pkBudget = budget(selectedYear, selectedMonth, pkDaten.gewichte, pkDaten.pkBudgetMonat);
    const zielQuote = budgetZielQuote(pkDaten);
    return { stichtag, kHr, kIst, pkq, ums, pkBudget, zielQuote };
  }, [pkDaten, selectedYear, selectedMonth]);

  // ── PKQ-Verlauf (kumuliert) — ausschliesslich aus der zentralen Quelle ─────
  // Pro Tag d (1..stichtag): kumulierte PKQ % = (Fix anteilig d/daysInMonth +
  // Σ Flex-effektivKosten der Tage ≤ d) ÷ (Σ Ist-Netto-Umsatz der Tage ≤ d) × 100.
  // Fix wird linear anteilig gerechnet (identisch zu fixKosten.kostenBisStichtag);
  // flexKostenProTag wird EINMAL berechnet und kumuliert (keine 31 Lib-Aufrufe).
  const pkqVerlauf = useMemo(() => {
    if (!pkDaten) return null;
    const stichtag = effektiverIstStichtag(pkDaten); // konsistent mit pkZentral
    if (stichtag <= 0) return null;
    const fixMonat = fixKosten(pkDaten).totalMonat; // voller Monat, einmalig
    const tage = flexKostenProTag(pkDaten, { stichtag }); // einmalig
    const mm = String(selectedMonth).padStart(2, '0');
    let flexKum = 0;
    let umsatzKum = 0;
    const rows: { label: string; pkq: number | null }[] = [];
    for (let d = 1; d <= stichtag; d++) {
      const date = `${selectedYear}-${mm}-${String(d).padStart(2, '0')}`;
      const tag = tage.find(t => t.date === date);
      // Nur vergangene Ist-Tage tragen Ist-Flex bei; sonst Plan (Lib-Tag-Regel).
      flexKum += tag ? tag.effektivKosten : 0;
      umsatzKum += pkDaten.umsatzIstProTag[date] ?? 0;
      const fixKum = fixMonat * (d / pkDaten.daysInMonth);
      const kostenKum = fixKum + flexKum;
      rows.push({
        label: `${String(d).padStart(2, '0')}.${mm}.`,
        pkq: umsatzKum > 0 ? Math.round((kostenKum / umsatzKum) * 1000) / 10 : null,
      });
    }
    // Sinnvolle Y-Domain-Obergrenze: mind. 45, sonst höchster Punkt + Puffer.
    const maxPkq = rows.reduce((m, r) => (r.pkq != null && r.pkq > m ? r.pkq : m), 0);
    const yMax = Math.max(45, Math.ceil((maxPkq + 5) / 5) * 5);
    return { rows, yMax };
  }, [pkDaten, selectedYear, selectedMonth]);

  // ── NEUE Darstellung (Etappe 4): reine Ableitungen aus dem Kern ───────────
  // PKQ-Brücke (Wasserfall) — Ziel → Umsatz-Effekt → Zwischen → Personal-Effekt
  // → PKQ-Hochrechnung. Alle Eingaben aus pkZentral (SSOT), keine neue Rechnung.
  const pkBruecke = useMemo(() => {
    if (!pkZentral) return null;
    return buildPkqBruecke({
      zielQuotePct: pkZentral.zielQuote * 100,
      pkBudgetCHF: pkZentral.pkBudget?.total ?? null,
      personalHochrechnungCHF: pkZentral.kHr.total,
      umsatzHochrechnungCHF: pkZentral.ums.hochrechnung,
    });
  }, [pkZentral]);

  // Kumulierter Kostenverlauf (Ist bis heute / Plan ab morgen / Budget-Linie).
  const pkVerlauf = useMemo(() => {
    if (!pkDaten || !pkZentral) return null;
    return buildKumulierterVerlauf({
      year: selectedYear,
      month: selectedMonth,
      daysInMonth: pkDaten.daysInMonth,
      stichtag: pkZentral.stichtag,
      fixMonatCHF: fixKosten(pkDaten).totalMonat,
      flexTage: flexKostenProTag(pkDaten, { stichtag: pkZentral.stichtag }),
      budgetProTag: pkZentral.pkBudget?.proTag ?? [],
    });
  }, [pkDaten, pkZentral, selectedYear, selectedMonth]);

  // ── K/U-Plan-Eintrag direkt bearbeiten ────────────────────────────────────
  const handleKuPlanEdit = useCallback((empId: string, date: string, action: 'delete' | 'frei') => {
    const mk          = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    const scheduleKey = tenantKey(`schedule-v2-${mk}`);
    const actualKey   = tenantKey(`actual-hours-${mk}`);
    const cellKey     = `${empId}-${date}`;
    try {
      const schedule = JSON.parse(localStorage.getItem(scheduleKey) || '{}') as Record<string, {
        früh?: unknown; spät?: unknown; frühAbsence?: string | null; spätAbsence?: string | null;
      }>;
      const entry = schedule[cellKey];
      if (entry) {
        if (action === 'delete') {
          entry.frühAbsence = null;
          entry.spätAbsence = null;
          if (!entry.früh && !entry.spät) { delete schedule[cellKey]; }
          else { schedule[cellKey] = entry; }
        } else {
          if (entry.frühAbsence) entry.frühAbsence = 'F';
          if (entry.spätAbsence) entry.spätAbsence = 'F';
          schedule[cellKey] = entry;
        }
        localStorage.setItem(scheduleKey, JSON.stringify(schedule));
      }
      const actual = JSON.parse(localStorage.getItem(actualKey) || '{}') as Record<string, { hours: number; absenceType?: string }>;
      if (actual[cellKey]?.absenceType) {
        if (action === 'delete') { delete actual[cellKey]; }
        else { actual[cellKey] = { hours: 0, absenceType: 'F' }; }
        localStorage.setItem(actualKey, JSON.stringify(actual));
      }
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('schedule-updated'));
    setKuPlanDays(loadKUDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setKuIstDays(loadKUDaysFromStorage(selectedYear, selectedMonth, tenantKey));
    setKuPlanDetail(loadKUDetailFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setKuIstDetail(loadKUDetailFromIstStorage(selectedYear, selectedMonth, tenantKey));
    setKuPlanBreakdown(loadKUBreakdownFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    setKuIstBreakdown(loadKUBreakdownFromStorage(selectedYear, selectedMonth, tenantKey));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId]);

  // ── Zusatzkosten-Plan-Flags für einen MA bereinigen ──────────────────────
  // Entfernt isAdditionalCostPlan aus allen Einträgen des MA für den aktuellen Monat
  // in localStorage UND Supabase (saveScheduleEntry). Danach schedule-updated dispatchen.
  const clearZusatzkostenPlan = useCallback(async (empId: string, empName: string) => {
    const mk          = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    const scheduleKey = tenantKey(`schedule-v2-${mk}`);
    try {
      const raw = localStorage.getItem(scheduleKey);
      if (!raw) return;
      const data: Record<string, any> = JSON.parse(raw);
      const toSave: Array<{ date: string; entry: Record<string, unknown> }> = [];
      for (const [cellKey, entry] of Object.entries(data)) {
        const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
        if (empIdFromKey !== empId) continue;
        if (!entry?.isAdditionalCostPlan) continue;
        const date = cellKey.slice(-10);
        const updated = { ...entry };
        delete updated.isAdditionalCostPlan;
        data[cellKey] = updated;
        toSave.push({ date, entry: updated });
      }
      if (toSave.length === 0) return;
      localStorage.setItem(scheduleKey, JSON.stringify(data));
      // Sync removals to Supabase
      await Promise.all(toSave.map(({ date, entry }) => saveScheduleEntry(empId, date, entry)));
      console.log(`[ZK-CLEAR] ${empName}: ${toSave.length} Einträge bereinigt`);
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      toast.success(`Zusatzkosten für ${empName} entfernt (${toSave.length} ${toSave.length === 1 ? 'Tag' : 'Tage'})`);
    } catch (e) {
      console.error('[ZK-CLEAR] Fehler beim Bereinigen:', e);
      toast.error('Fehler beim Entfernen der Zusatzkosten');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantKey]);

  // Mandantenwechsel: varHours/varWeekly/etc. neu laden
  useEffect(() => {
    console.log(`[TENANT] PersonalFix: Mandant gewechselt → "${tenantId}", Var-Daten neu laden`);
    setVarHours(loadVarHours(tenantKey));
    setVarWeekly(loadVarWeekly(tenantKey));
    setVarPricingMode(loadVarPricingMode(tenantKey));
    setVarDayRate(loadVarDayRate(tenantKey));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Umsatz-Annahme & Budget-Umsatz bei Monat- oder Mandantenwechsel neu laden
  useEffect(() => {
    const saved = loadRevenueAssumption(selectedYear, selectedMonth, tenantKey);
    setRevenueAssumption(saved);
    setRevenueAssumptionInput(saved != null ? String(saved) : '');
    const savedBudgetRev = loadBudgetRevenue(selectedYear, selectedMonth, tenantKey);
    setBudgetRevenue(savedBudgetRev);
    setBudgetRevenueInput(savedBudgetRev != null ? String(savedBudgetRev) : '');
    setWeekIstSet(new Set(loadWeekIstSet(selectedYear, selectedMonth, tenantKey)));
    setWeekRevOverrides(loadWeekRevOverrides(selectedYear, selectedMonth, tenantKey));
    setWeekRevEditKey(null);
    const savedScPk = loadScenarioPkCost(selectedYear, selectedMonth, tenantKey);
    setScenarioPkCost(savedScPk);
    setScenarioPkCostInput(savedScPk != null ? String(savedScPk) : '');
    setScenarioPkqInput('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId]);

  const budgetData = useBudgetMonth(selectedYear, selectedMonth);
  const personnelBudget = budgetData.personnelBudget;

  const handleVarHoursChange = useCallback((empId: string, hours: number) => {
    setVarHours(prev => {
      const next = { ...prev, [empId]: hours };
      saveVarHours(next, tenantKey);
      return next;
    });
  }, []);

  const handleVarWeeklyChange = useCallback((empId: string, field: 'hours' | 'days', val: number | undefined) => {
    setVarWeekly(prev => {
      const existing = prev[empId] ?? {};
      const updated = val != null
        ? { ...existing, [field]: val }
        : { ...existing, [field]: undefined };
      const next = { ...prev, [empId]: updated };
      saveVarWeekly(next, tenantKey);
      return next;
    });
  }, []);

  const handlePricingModeToggle = useCallback((empId: string) => {
    setVarPricingMode(prev => {
      const current = prev[empId] ?? 'hourly';
      const next = { ...prev, [empId]: current === 'hourly' ? 'daily' : 'hourly' as PricingMode };
      saveVarPricingMode(next, tenantKey);
      return next;
    });
  }, []);

  const handleDayRateChange = useCallback((empId: string, field: keyof DayRateData, val: number | undefined) => {
    setVarDayRate(prev => {
      const existing = prev[empId] ?? { ratePerDay: 0 };
      const next = { ...prev, [empId]: { ...existing, [field]: val ?? 0 } };
      saveVarDayRate(next, tenantKey);
      return next;
    });
  }, []);

  const handleHourlyWageSaved = useCallback(async (empId: string, val: number) => {
    setSaving(empId);
    if (String(empId).includes('aush_')) {
      const person = extraCostPeople.find(p => p.id === empId);
      if (person) {
        const saved = await upsertExtraCostPerson({ ...person, hourlyWage: val }, tenantId);
        if (saved) setExtraCostPeople(prev => prev.map(p => p.id === empId ? saved : p));
      }
      setSaving(null);
      return;
    }
    const emp = employees.find(e => e.id === empId);
    if (!emp) { setSaving(null); return; }
    // Persistenz IMMER auf dem unangereicherten Stammsatz: nur das editierte
    // Feld ändern, keine abgeleiteten Monats-Felder (has13thSalary etc.) schreiben.
    const raw = rawEmployeesRef.current.get(String(empId)) ?? emp;
    const persisted: Employee = { ...raw, hourlyWage: val };
    await upsertEmployee(persisted, tenantId);
    rawEmployeesRef.current.set(String(empId), persisted);
    setEmployees(prev => prev.map(e => e.id === empId ? { ...e, hourlyWage: val } : e));
    setSaving(null);
  }, [employees, extraCostPeople, tenantId]);

  const handleSaved = async (empId: string, field: 'monthlySalary' | 'monthlySalaryWith13th', val: number) => {
    setSaving(empId);
    const emp = employees.find(e => e.id === empId);
    if (!emp) { setSaving(null); return; }
    // Persistenz auf dem Stammsatz (nicht dem monats-angereicherten Objekt),
    // damit has13thSalary/verdrängte Löhne der Historie-Phase nie zurückfliessen.
    const raw = rawEmployeesRef.current.get(String(empId)) ?? emp;
    let persisted: Employee;
    let patch: Partial<Employee>;
    if (field === 'monthlySalary') {
      const with13 = raw.has13thSalary ? (val * 13) / 12 : undefined;
      patch = { monthlySalary: val, monthlySalaryWith13th: with13 ?? raw.monthlySalaryWith13th };
      persisted = { ...raw, ...patch };
    } else {
      patch = { monthlySalaryWith13th: val };
      persisted = { ...raw, ...patch };
    }
    await upsertEmployee(persisted, tenantId);
    rawEmployeesRef.current.set(String(empId), persisted);
    setEmployees(prev => prev.map(e => e.id === empId ? { ...e, ...patch } : e));
    setSaving(null);
  };

  // ── Sortierte Listen ───────────────────────────────────────────────────────

  const fixedEmployees = useMemo(() =>
    employees
      .filter(e => hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees, selectedYear, selectedMonth],
  );

  const variableEmployees = useMemo(() => {
    const fromEmployees = employees
      .filter(e => !hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth));
    // Lohnart-Wechsel mitten im Monat: Stundenlohn-Anteil erscheint zusätzlich
    // in FLEX (pro rata, Stunden × hourlyFraction) — der Fix-Anteil bleibt in FIX.
    const splitFlex = employees
      .filter(e => wageSplits[e.id] && hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth))
      .map(e => {
        const s = wageSplits[e.id];
        const dd = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
        return {
          ...e,
          id: `${e.id}${FLEX_SPLIT_SUFFIX}`,
          name: `${e.name} (${dd(s.hourlyFrom)}–${dd(s.hourlyTo)})`,
          contractType: 'hourly' as const,
          hourlyWage: s.hourly.hourlyWage,
          monthlySalary: 0,
          monthlySalaryWith13th: 0,
          // 13. der Stundenlohn-Phase (nicht das Monatslohn-Flag der FIX-Seite)
          has13thSalary: s.hourly.salary13,
        };
      });
    const existingIds = new Set([...fromEmployees, ...splitFlex].map(e => e.id));
    const fromExtraCost = extraCostPeople
      .map(extraCostPersonToEmployee)
      .filter(e => !existingIds.has(e.id));
    return [...fromEmployees, ...splitFlex, ...fromExtraCost]
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [employees, extraCostPeople, selectedYear, selectedMonth, wageSplits]);

  // Beaulieu: Mitarbeiter ohne hinterlegten Lohn (weder Stunden- noch Monatslohn)
  const missingWageEmployees = useMemo(() =>
    employees.filter(e =>
      isEmployeeActiveInMonth(e, selectedYear, selectedMonth) &&
      (e.hourlyWage ?? 0) === 0 && (e.monthlySalary ?? 0) === 0,
    ),
    [employees, selectedYear, selectedMonth],
  );

  // ── Hilfsfunktion: Stunden je nach Ansicht ─────────────────────────────────

  const getVarHoursFor = useCallback((rawEmpId: string): number => {
    // Split-Pseudo-Zeilen: Stunden über die Basis-id, skaliert mit dem
    // Stundenlohn-Tage-Anteil (Lohnart-Wechsel im Monat).
    const empId = splitBaseId(rawEmpId);
    const splitFactor = wageSplits[empId]?.hourlyFraction ?? 1;
    if (varView === 'plan') return (planHours[empId] ?? 0) * splitFactor;
    if (varView === 'ist')  return (istHours[empId] ?? 0) * splitFactor;
    // Manuell: manual monthly entry takes priority; weekly baseline as fallback
    const manual  = varHours[empId];
    const weekly  = varWeekly[empId];
    if (manual != null && manual > 0) return manual * splitFactor;
    if (weekly?.hours)  return Math.round(weekly.hours * WEEKS_PER_MONTH * 10) / 10 * splitFactor;
    return 0;
  }, [varView, planHours, istHours, varHours, varWeekly, wageSplits]);

  /** Returns monthly cost regardless of pricing mode. */
  const getVarMonthlyCostFor = useCallback((empId: string, emp?: Employee): number => {
    const mode = varPricingMode[empId] ?? 'hourly';
    if (varView !== 'manual' || mode === 'hourly') {
      const foundEmp = emp ?? variableEmployees.find(e => e.id === empId);
      // Kosten = Total Arbeitgeberkosten/h (SL-Brutto inkl. Zuschläge × AG-Faktor), nie roher hourlyWage.
      const rate = foundEmp ? (getEffectiveHourlyRate(foundEmp, socialCostRates) ?? 0) : 0;
      return getVarHoursFor(empId) * rate;
    }
    // Tagessatz
    const dr = varDayRate[empId];
    if (!dr?.ratePerDay) return 0;
    const days = (dr.daysPerMonth ?? 0) > 0
      ? dr.daysPerMonth!
      : (dr.daysPerWeek ?? 0) > 0
        ? Math.round(dr.daysPerWeek! * WEEKS_PER_MONTH * 10) / 10
        : 0;
    return days * dr.ratePerDay;
  }, [varView, varPricingMode, varDayRate, variableEmployees, getVarHoursFor, socialCostRates, agSozOff]);

  // ── Fix-Kosten mit Pro-rata je ausgewähltem Monat ─────────────────────────
  // Kosten = Total Arbeitgeberkosten: Bruttolohn (inkl. 13.) × AG-Sozialkosten-Faktor.
  // Brutto-Basen (getFixCost/getProRataFixCost/getYearlyFixCost) bleiben pure Brutto-
  // Funktionen; der Faktor wird NUR hier an der Memo-Grenze angewendet (linear).

  const fixedWithCost = useMemo(() => {
    const agFactor = socialCostFactorFromRates(socialCostRates);
    return fixedEmployees.map(emp => {
      // Lohnart-Wechsel LAUT LOHNHISTORIE (SSOT) mitten im Monat → Fix-Anteil pro rata
      const wageSplit = wageSplits[emp.id];
      if (wageSplit) {
        const dd = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
        const full = getFixCost(emp);
        return {
          emp,
          cost: Math.round(full * wageSplit.monthlyFraction * agFactor * 100) / 100,
          label: `Pro rata ${dd(wageSplit.monthlyFrom)}–${dd(wageSplit.monthlyTo)} (Lohnart-Wechsel)`,
          excluded: false,
          yearlyCost: Math.round(getYearlyFixCost(emp, selectedYear) * agFactor * 100) / 100,
          hasMidMonthSwitch: true,
        };
      }

      const phases     = contractHistoryMap[emp.id] ?? [];
      const midSwitch  = getMidMonthSwitchInMonth(phases, selectedYear, selectedMonth);

      // Employee switched TO monthly mid-month → pro-rata from switch day
      if (midSwitch && midSwitch.contractType === 'monthly') {
        const switchDay   = parseInt(midSwitch.effectiveFrom.slice(8, 10), 10);
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
        const daysAsFixed = daysInMonth - switchDay + 1;
        const full        = getFixCost(emp);
        const cost        = Math.round(full * (daysAsFixed / daysInMonth) * agFactor * 100) / 100;
        return {
          emp,
          cost,
          label: `Pro rata ab ${String(switchDay).padStart(2, '0')}.${String(selectedMonth).padStart(2, '0')}. (Vertragswechsel)`,
          excluded: false,
          yearlyCost: Math.round(getYearlyFixCost(emp, selectedYear) * agFactor * 100) / 100,
          hasMidMonthSwitch: true,
        };
      }

      const base = getProRataFixCost(emp, selectedYear, selectedMonth);
      return {
        ...base,
        cost: Math.round(base.cost * agFactor * 100) / 100,
        emp,
        yearlyCost: Math.round(getYearlyFixCost(emp, selectedYear) * agFactor * 100) / 100,
        hasMidMonthSwitch: false,
      };
    });
  }, [fixedEmployees, selectedYear, selectedMonth, contractHistoryMap, socialCostRates, wageSplits]);

  const activeFixedEmployees = useMemo(() =>
    fixedWithCost.filter(r => !r.excluded),
    [fixedWithCost],
  );

  const byDept = useMemo(() => {
    const map: Record<string, typeof fixedWithCost> = {};
    for (const r of activeFixedEmployees) {
      const d = r.emp.department;
      if (!map[d]) map[d] = [];
      map[d].push(r);
    }
    return map;
  }, [activeFixedEmployees]);

  const varByDept = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of variableEmployees) {
      const d = e.department;
      if (!map[d]) map[d] = [];
      map[d].push(e);
    }
    return map;
  }, [variableEmployees]);

  // ── Gesamtberechnungen ─────────────────────────────────────────────────────

  const totalFixCost = useMemo(() => activeFixedEmployees.reduce((s, r) => s + r.cost, 0), [activeFixedEmployees]);
  const totalFixBase = useMemo(() => activeFixedEmployees.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0), [activeFixedEmployees]);
  const totalFixAnnual = useMemo(() =>
    activeFixedEmployees.reduce((s, r) => s + r.yearlyCost, 0),
    [activeFixedEmployees],
  );

  const totalVarCost = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getVarMonthlyCostFor(e.id, e), 0),
    [variableEmployees, getVarMonthlyCostFor],
  );
  // totalVarHours counts only hourly-mode employees (Tagessatz has no hours)
  const totalVarHours = useMemo(() =>
    variableEmployees.reduce((s, e) => {
      if (varView === 'manual' && (varPricingMode[e.id] ?? 'hourly') === 'daily') return s;
      return s + getVarHoursFor(e.id);
    }, 0),
    [variableEmployees, varView, varPricingMode, getVarHoursFor],
  );
  const totalCombined = totalFixCost + totalVarCost;

  // ── Stichtag-Controlling: Plan + Ist getrennt (varView-unabhängig) ─────────
  // Variable Kosten immer aus Plan-Stunden (Dienstplan) bzw. Ist-Stunden (Mirus)
  const varPlanTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => {
      const base = splitBaseId(e.id);
      return s + (planHours[base] ?? 0) * (wageSplits[base]?.hourlyFraction ?? 1) * (getEffectiveHourlyRate(e, socialCostRates) ?? 0);
    }, 0),
    [variableEmployees, planHours, socialCostRates, wageSplits, agSozOff],
  );
  const varIstTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => {
      const base = splitBaseId(e.id);
      return s + (istHours[base] ?? 0) * (wageSplits[base]?.hourlyFraction ?? 1) * (getEffectiveHourlyRate(e, socialCostRates) ?? 0);
    }, 0),
    [variableEmployees, istHours, socialCostRates, wageSplits, agSozOff],
  );

  // Zusatzkosten-IST: Fixlohn-MA Tage mit isAdditionalCost=true → fliessen als variable Flex-Kosten ein
  // Liest direkt aus supabaseActualHours (persistent nach Reload, keine localStorage-Abhängigkeit)
  const zusatzIstCHF = useMemo(() => {
    const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    let total = 0;
    for (const emp of fixedEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates);
      if (!wage) continue;
      let cost = 0;
      let dayCount = 0;
      for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
        const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
        const date = cellKey.slice(-10);
        if (empIdFromKey !== emp.id) continue;
        if (!date.startsWith(yearMonthPrefix)) continue;
        if (!entry.isAdditionalCost) continue;
        const h = entry.hours ?? 0;
        if (h <= 0) continue;
        cost += Math.round(h * wage * 100) / 100;
        dayCount++;
      }
      if (cost > 0) console.log(`[ZUSATZ-IST] ${emp.name}: ${dayCount} Tage / ${cost.toFixed(2)} CHF`);
      total += cost;
    }
    return total;
  }, [fixedEmployees, selectedYear, selectedMonth, supabaseActualHours, socialCostRates, agSozOff]);

  // ── Überstunden-Auswertung (nur Festangestellte) ───────────────────────────
  // Baut Ist-Stunden-Einträge des gewählten Monats aus den Supabase-Ist-Daten und
  // delegiert die gesamte Überstunden-Logik an die pure Lib. Stündliche MA werden
  // dort gefiltert. Abteilungsfilter 'all' (PersonalFix = admin/beaulieu_manager).
  const { overtimeAnalysis, weeklyOvertimeAnalysis, dayDetailEntries } = useMemo(() => {
    const prefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    const entries: OvertimeHoursEntry[] = [];
    // Tagesdetail (Ebene 3, reine Anzeige): enthält im Gegensatz zu `entries` AUCH
    // Abwesenheitstage + Schichtzeiten — verändert aber KEINE Berechnung (separater Pfad).
    const detail: DayDetailEntry[] = [];
    for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      const employeeId = cellKey.slice(0, cellKey.length - 11);
      const h = entry.hours ?? 0;
      const hasContent = h > 0 || !!entry.absenceType;
      if (hasContent) {
        detail.push({
          employeeId,
          date,
          hours: h,
          absenceType: entry.absenceType ?? null,
          isAdditionalCost: entry.isAdditionalCost === true,
          start: entry.start ?? null,
          end: entry.end ?? null,
          start2: entry.start2 ?? null,
          end2: entry.end2 ?? null,
        });
      }
      if (h <= 0) continue;
      // Abwesenheiten (FE/K/U/…) sind keine produktive Arbeitszeit → keine Überstunden
      if (entry.absenceType) continue;
      // Manuelle Zusatzkosten-Tage werden geflaggt (nicht übersprungen): die Lib zählt
      // sie nicht als produktive Überstunden, weist sie aber separat als Zusatzkosten aus.
      entries.push({
        employeeId,
        date,
        hours: h,
        isAdditionalCost: entry.isAdditionalCost === true,
      });
    }
    // Nur echte Festangestellte (vollzeit/teilzeit MIT fixem Monatslohn) — keine
    // flexiblen/stündlichen MA. Zweite Sicherheitsschicht: compute*OvertimeAnalysis
    // filtert intern erneut über isFixedSalaryEmployee.
    const candidates = employees.filter(
      e => hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth),
    );
    // Kalendertage des gewählten Monats (für das Monatssoll). new Date(y, m, 0) → letzter
    // Tag des Monats m (selectedMonth ist 1-basiert).
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const monthly = computeOvertimeAnalysis({
      employees: candidates,
      entries,
      daysInMonth,
      socialCostRates,
      departmentFilter: 'all',
      disabledEmployeeIds: overtimeDisabledIds,
    });
    // Wochenauswertung (ISO-Wochen anteilig im Monat) — gleiche Einträge/Kandidaten.
    const weekly = computeWeeklyOvertimeAnalysis({
      employees: candidates,
      entries,
      year: selectedYear,
      month: selectedMonth,
      socialCostRates,
      departmentFilter: 'all',
      disabledEmployeeIds: overtimeDisabledIds,
    });
    return { overtimeAnalysis: monthly, weeklyOvertimeAnalysis: weekly, dayDetailEntries: detail };
  }, [supabaseActualHours, employees, selectedYear, selectedMonth, overtimeDisabledIds, socialCostRates, agSozOff]);

  // Persistierte „Überstunden deaktiviert"-Liste pro Mandant laden
  useEffect(() => {
    let cancelled = false;
    // Beim Mandantenwechsel sofort leeren, damit nicht kurz die deaktivierten IDs
    // des vorherigen Mandanten greifen, bis der asynchrone Load aufgelöst ist.
    setOvertimeDisabledIds(new Set());
    loadOvertimeDisabledIds(tenantId).then(ids => {
      if (!cancelled) setOvertimeDisabledIds(new Set(ids));
    });
    return () => { cancelled = true; };
  }, [tenantId]);

  // Flex-Ist-Overrides laden (mandantengetrennt, pro Jahr/Monat). Beim Wechsel
  // sofort leeren, damit nie Overrides des vorherigen Mandanten/Monats greifen.
  useEffect(() => {
    let cancelled = false;
    setFlexOverrides({ ...EMPTY_FLEX_OVERRIDES });
    flexOverridesRef.current = { ...EMPTY_FLEX_OVERRIDES };
    loadFlexIstOverrides(tenantKey, selectedYear, selectedMonth).then(ov => {
      if (!cancelled) { setFlexOverrides(ov); flexOverridesRef.current = ov; }
    });
    return () => { cancelled = true; };
  }, [tenantId, selectedYear, selectedMonth]);

  // Synchroner Spiegel (nie stale) + serialisierte Save-Queue mit latest-wins
  // pro Scope: schnelle Folge-Änderungen können sich so nie gegenseitig
  // überschreiben, und ein Monats-/Mandantenwechsel schliesst den alten Scope
  // sauber ab (Closure hält tenantKey/Jahr/Monat des Aufrufzeitpunkts).
  const flexOverridesRef = useRef<FlexIstOverrides>(flexOverrides);
  const flexSaveQueue = useRef<{ chain: Promise<void>; latest: Map<string, FlexIstOverrides> }>({
    chain: Promise.resolve(), latest: new Map(),
  });

  // Optimistisch lokal, Persistenz als KV-Upsert (dublettensicher, ein Blob je Monat).
  const updateFlexOverrides = useCallback((updater: (prev: FlexIstOverrides) => FlexIstOverrides) => {
    const next = updater(flexOverridesRef.current);
    flexOverridesRef.current = next;
    setFlexOverrides(next);
    const scope = `${selectedYear}-${selectedMonth}`;
    const tk = tenantKey; const y = selectedYear; const m = selectedMonth;
    const q = flexSaveQueue.current;
    q.latest.set(tk(scope), next);
    q.chain = q.chain.then(async () => {
      const data = q.latest.get(tk(scope));
      if (!data) return; // bereits von neuerem Save dieses Scopes abgedeckt
      q.latest.delete(tk(scope));
      try {
        await saveFlexIstOverrides(tk, y, m, data);
      } catch {
        toast.error('Flex-Ist-Override konnte nicht gespeichert werden');
      }
    });
  }, [tenantKey, selectedYear, selectedMonth]);

  // Überstundenberechnung für einen Mitarbeiter (de)aktivieren — optimistisch lokal,
  // Persistenz best-effort (saveOvertimeDisabledIds zeigt bei Fehler einen Toast).
  const handleToggleOvertimeDisabled = useCallback((employeeId: string, disabled: boolean) => {
    setOvertimeDisabledIds(prev => {
      const next = new Set(prev);
      if (disabled) next.add(employeeId); else next.delete(employeeId);
      void saveOvertimeDisabledIds(tenantId, Array.from(next));
      return next;
    });
  }, [tenantId]);

  // ── Ferienabbau-Berechnungen ───────────────────────────────────────────────
  // FE-Tage × (weeklyHours/5 oder 8.4h) × Total Arbeitgeberkosten/h
  // IST: aus actual-hours-* (localStorage), PLAN: aus schedule-v2-* (localStorage)
  // Supabase hat kein absenceType-Feld → Ferien immer aus localStorage
  // IST-Ferienabbau pro Mitarbeiter
  const getEmpFerienCHF = useCallback((emp: Employee): number => {
    const days = ferienIstDays[emp.id] ?? 0;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0);
  }, [ferienIstDays, socialCostRates, agSozOff]);

  // PLAN-Ferienabbau pro Mitarbeiter
  const getEmpFerienPlanCHF = useCallback((emp: Employee): number => {
    const days = ferienPlanDays[emp.id] ?? 0;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0);
  }, [ferienPlanDays, socialCostRates, agSozOff]);

  // ── K/U 80%-Kosten (info-only, immer anzeigen wenn K/U-Tage vorhanden) ───────
  // K/U-Tage × (weeklyHours/5 oder 8.4h) × Total Arbeitgeberkosten/h × 80 %
  const getEmpKuCHF = useCallback((emp: Employee): number => {
    // Basis: Plan-Tage (wie Ferienabbau); fallback auf Ist wenn kein Plan vorhanden
    const days = (kuPlanDays[emp.id] ?? 0) > 0
      ? (kuPlanDays[emp.id] ?? 0)
      : (kuIstDays[emp.id] ?? 0);
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0) * 0.8;
  }, [kuPlanDays, kuIstDays, socialCostRates, agSozOff]);

  const getEmpKrankCHF = useCallback((emp: Employee): number => {
    const planK = kuPlanBreakdown[emp.id]?.krank ?? 0;
    const istK  = kuIstBreakdown[emp.id]?.krank  ?? 0;
    const days  = planK > 0 ? planK : istK;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0) * 0.8;
  }, [kuPlanBreakdown, kuIstBreakdown, socialCostRates, agSozOff]);

  const getEmpUnfallCHF = useCallback((emp: Employee): number => {
    const planU = kuPlanBreakdown[emp.id]?.unfall ?? 0;
    const istU  = kuIstBreakdown[emp.id]?.unfall  ?? 0;
    const days  = planU > 0 ? planU : istU;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0) * 0.8;
  }, [kuPlanBreakdown, kuIstBreakdown, socialCostRates, agSozOff]);

  // Alle Mitarbeitenden (Fix + Variable) für K/U-Kosten
  const allKUEmployees = useMemo(() =>
    [...fixedEmployees, ...variableEmployees],
    [fixedEmployees, variableEmployees],
  );

  const totalKuCHF = useMemo(() =>
    allKUEmployees.reduce((s, e) => s + getEmpKuCHF(e), 0),
    [allKUEmployees, getEmpKuCHF],
  );

  const totalKrankCHF = useMemo(() =>
    allKUEmployees.reduce((s, e) => s + getEmpKrankCHF(e), 0),
    [allKUEmployees, getEmpKrankCHF],
  );

  const totalUnfallCHF = useMemo(() =>
    allKUEmployees.reduce((s, e) => s + getEmpUnfallCHF(e), 0),
    [allKUEmployees, getEmpUnfallCHF],
  );

  // Ferienabbau Plan + Ist gesamt (für Stichtag-Controlling)
  const ferienIstTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getEmpFerienCHF(e), 0),
    [variableEmployees, getEmpFerienCHF],
  );
  const ferienPlanTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0),
    [variableEmployees, getEmpFerienPlanCHF],
  );

  // Ferienabbau nach Abteilung: IST-Basis
  const ferienabbauByDept = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const [dept, emps] of Object.entries(varByDept)) {
      const chf = emps.reduce((s, e) => s + getEmpFerienCHF(e), 0);
      map[dept] = chf;
      if (chf > 0) console.log(`[FERIEN] ferienabbau IST ${dept} chf: ${chf.toFixed(2)}`);
    }
    return map;
  }, [varByDept, getEmpFerienCHF]);

  // Ferienabbau nach Abteilung: PLAN-Basis
  const ferienabbauPlanByDept = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const [dept, emps] of Object.entries(varByDept)) {
      const chf = emps.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0);
      map[dept] = chf;
      if (chf > 0) console.log(`[FERIEN] ferienabbau PLAN ${dept} chf: ${chf.toFixed(2)}`);
    }
    return map;
  }, [varByDept, getEmpFerienPlanCHF]);

  // Ferienabbau gesamt: IST im Ist-Modus, PLAN im Plan/Manuell-Modus
  const totalFerienabbauCHF = useMemo(() => {
    const total = varView === 'ist'
      ? variableEmployees.reduce((s, e) => s + getEmpFerienCHF(e), 0)
      : variableEmployees.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0);
    if (total > 0) {
      console.log(`[FERIEN] ferienabbau (${varView}): ${total.toFixed(2)} CHF`);
      console.log(`[FERIEN] variable arbeit chf: ${totalVarCost.toFixed(2)}`);
      console.log(`[FERIEN] total variabel chf: ${(totalVarCost + total).toFixed(2)}`);
    }
    return total;
  }, [variableEmployees, getEmpFerienCHF, getEmpFerienPlanCHF, varView, totalVarCost]);

  // ── Kanonische 3-Ebenen-Definitionen (view-mode-unabhängig) ──────────────
  // Ebene 1: Variable Arbeit  = echte Arbeitsstunden × Total Arbeitgeberkosten/h (FE = 0 h)
  // Ebene 2: Ferienabbau       = FE-Tage × Tagessatz (separat)
  // Ebene 3: Total Variabel    = Variable Arbeit + Ferienabbau  (Addition!)
  //
  // «View-mode»-abhängige Aggregate (Plan / Ist / Manuell Schalter oben):
  const totalVarArbeitCHF = totalVarCost;                           // Ebene 1
  // Ebene 3 (view-mode): Variable Arbeit + Ferienabbau
  const totalVariabelCHF  = totalVarCost + totalFerienabbauCHF;

  // Stichtag-unabhängige Plan- und Ist-Totale (für Stichtag-Controlling):
  // Variable Arbeit Plan (immer Dienstplan-Plan-Stunden)
  const varArbeitPlanMonat  = varPlanTotalCHF;
  // Variable Arbeit Ist = variable MA-Stunden + Zusatzkosten von Fixlohn-MA (isAdditionalCost-Tage)
  const varArbeitIstMonat   = varIstTotalCHF + zusatzIstCHF;
  // Total Variabel Plan = Variable Arbeit Plan + Ferienabbau Plan
  const totalVarPlanMonat   = varArbeitPlanMonat + ferienPlanTotalCHF;
  // Total Variabel Ist  = Variable Arbeit Ist  + Ferienabbau Ist
  const totalVarIstMonat    = varArbeitIstMonat  + ferienIstTotalCHF;



  // ── Pro-Rata-Berechnungen ──────────────────────────────────────────────────
  const daysInSelectedMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const proRataFactor = proRataDay !== null
    ? Math.min(proRataDay, daysInSelectedMonth) / daysInSelectedMonth
    : 1;
  // Wochentagsgewichte aus Einstellungen (einmalig geladen, überall verwendet)
  const weekdayWeights = loadWeekdayWeights();
  const proRataFixCost      = totalFixCost          * proRataFactor;
  const proRataVarCost      = totalVariabelCHF      * proRataFactor;
  const proRataTotal        = (totalFixCost + totalVariabelCHF) * proRataFactor;
  // Weekday-gewichtetes Pro-Rata-Budget (ersetzt lineare Verteilung)
  const proRataBudget       = personnelBudget > 0
    ? computeProRataBudget(personnelBudget, selectedYear, selectedMonth, proRataDay, weekdayWeights)
    : 0;
  const proRataAvailableVar = personnelBudget > 0
    ? Math.max(0, proRataBudget - proRataFixCost) : 0;
  const proRataVarArbeit    = totalVarArbeitCHF     * proRataFactor;
  const proRataFerienabbau  = totalFerienabbauCHF   * proRataFactor;
  const proRataVarDelta     = personnelBudget > 0
    ? proRataAvailableVar - proRataVarArbeit : 0;
  const proRataVarOverrun   = proRataVarDelta < 0;

  // ── PFIX Master Compute Object ─────────────────────────────────────────────
  // Single source of truth for all KPIs, tables, budget block, and export.
  // .month  = full-month values (always proportional, no cutoff)
  // .cutoff = cutoff values using ACTUAL day filtering for work (same method as
  //           FlexPeriodPopup + pfixAbw), proportional scaling for FIX + holiday
  // .active = cutoff ?? month  (always use .active in the UI)
  //
  // KEY: In cutoff mode, work costs are computed by filtering actual calendar
  // days ≤ proRataDay, NOT by multiplying the full-month total by proRataFactor.
  // This is the only method that produces consistent values across table, popup
  // and pfixAbw (because employee hours are NOT uniformly distributed).
  const pfix = useMemo(() => {
    // Helper: build a cost slice from components
    const buildSlice = (
      fix: number, planWork: number, istWork: number,
      planHol: number, istHol: number,
    ) => {
      const planTotalVar = planWork + planHol;
      const istTotalVar  = istWork  + istHol;
      return {
        fix,
        planWork,     istWork,
        planHoliday:  planHol,   istHoliday: istHol,
        planTotalVar, istTotalVar,
        planTotal:    fix + planTotalVar,
        istTotal:     fix + istTotalVar,
        diffWork:     istWork     - planWork,
        diffHoliday:  istHol      - planHol,
        diffTotalVar: istTotalVar  - planTotalVar,
        diffTotal:    (fix + istTotalVar) - (fix + planTotalVar),
      };
    };

    // Month slice — always full-month, no cutoff
    const month = buildSlice(
      totalFixCost, varArbeitPlanMonat, varArbeitIstMonat,
      ferienPlanTotalCHF, ferienIstTotalCHF,
    );

    // Cutoff slice — actual day filtering for work, proportional for rest
    let active = month;
    let cutoff: typeof month | null = null;
    if (proRataDay !== null) {
      // Work costs: sum actual hours up to proRataDay for each employee
      // (identical method to FlexPeriodPopup rows + pfixAbw dayMap)
      let cutoffPlanWork = 0;
      let cutoffIstWork  = 0;
      for (const emp of variableEmployees) {
        const wage = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
        if (!wage) continue;
        const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        const istW  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        cutoffPlanWork += planW.reduce((s, r) => s + r.cost, 0);
        cutoffIstWork  += istW.reduce((s, r)  => s + r.cost, 0);
      }
      // Zusatzkosten von Fixlohn-MA bis Stichtag ebenfalls einrechnen (direkt aus Supabase-Daten)
      const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
      for (const emp of fixedEmployees) {
        const wage = getEffectiveHourlyRate(emp, socialCostRates);
        if (!wage) continue;
        for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
          const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
          const date = cellKey.slice(-10);
          if (empIdFromKey !== emp.id) continue;
          if (!date.startsWith(yearMonthPrefix)) continue;
          if (!entry.isAdditionalCost) continue;
          const day = parseInt(date.slice(-2), 10);
          if (proRataDay !== null && day > proRataDay) continue;
          const h = entry.hours ?? 0;
          if (h > 0) cutoffIstWork += Math.round(h * wage * 100) / 100;
        }
      }
      // Holiday + FIX: proportional (calendar-uniform costs)
      const f = proRataFactor;
      cutoff = buildSlice(
        totalFixCost       * f,
        cutoffPlanWork,
        cutoffIstWork,
        ferienPlanTotalCHF * f,
        ferienIstTotalCHF  * f,
      );
      active = cutoff;
    }

    const modeStr = proRataDay !== null
      ? `cutoff day=${proRataDay} factor=${proRataFactor.toFixed(4)}`
      : 'month';
    console.log(`[PFIX] mode: ${modeStr}`);
    console.log(`[PFIX] fix:           ${active.fix.toFixed(2)}`);
    console.log(`[PFIX] plan work:     ${active.planWork.toFixed(2)}`);
    console.log(`[PFIX] ist work:      ${active.istWork.toFixed(2)}`);
    console.log(`[PFIX] plan holiday:  ${active.planHoliday.toFixed(2)}`);
    console.log(`[PFIX] ist holiday:   ${active.istHoliday.toFixed(2)}`);
    console.log(`[PFIX] plan totalVar: ${active.planTotalVar.toFixed(2)}`);
    console.log(`[PFIX] ist totalVar:  ${active.istTotalVar.toFixed(2)}`);
    console.log(`[PFIX] plan total:    ${active.planTotal.toFixed(2)}`);
    console.log(`[PFIX] ist total:     ${active.istTotal.toFixed(2)}`);
    console.log(`[PFIX] diff total:    ${active.diffTotal.toFixed(2)}`);

    return { month, cutoff, active };
  }, [variableEmployees, fixedEmployees, selectedYear, selectedMonth,
      varArbeitPlanMonat, varArbeitIstMonat, ferienPlanTotalCHF, ferienIstTotalCHF,
      totalFixCost, proRataDay, proRataFactor, tenantKey, scheduleRefreshTick,
      supabaseActualHours, socialCostRates, agSozOff]);

  // ── Monatsumsatz für PKQ-Berechnung ──────────────────────────────────────
  // Summiert Netto-Umsatz (actualRevenue – MWST 8.1%) für PKQ-Berechnung.
  // Takeaway-Anteil (val.takeawayRevenue) wird mit 2.6% MWST konvertiert.
  // Marketing (maisonExclude) wird berücksichtigt.
  // Bei Stichtag nur bis proRataDay.
  const monthRevenue = useMemo(() => {
    let total = 0;
    const prefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-`;
    for (const [date, val] of Object.entries(monthlyRevenues)) {
      if (!date.startsWith(prefix)) continue;
      if (proRataDay !== null) {
        const day = parseInt(date.slice(-2), 10);
        if (day > proRataDay) continue;
      }
      const gross    = val.actualRevenue   ?? 0;
      const takeaway = maisonExclude ? 0 : (val.takeawayRevenue ?? 0);
      // Nettoumsatz: takeaway@2.6%, Rest@8.1%
      total += grossToNet(gross, takeaway);
    }
    return total;
  }, [monthlyRevenues, proRataDay, maisonExclude, selectedYear, selectedMonth]);

  // Effektiver Umsatz für PKQ: manuelle Annahme überschreibt Ist-Wert wenn kein Ist vorhanden,
  // oder wird als Override genutzt wenn explizit gesetzt
  const effectiveRevenue = (revenueAssumption !== null && revenueAssumption > 0)
    ? revenueAssumption
    : monthRevenue;
  const revenueIsAssumed = revenueAssumption !== null && revenueAssumption > 0;

  // ── PKQ — AUSSCHLIESSLICH zeitkonsistent aus dem Kern (personalkosten.ts) ──
  // Es gibt nur EINE PKQ-Definition (personalquote()): Zähler und Nenner immer
  // auf gleicher Zeitbasis. KEINE Quote «volle Monatskosten ÷ Teilumsatz» mehr.
  //  • pkqIst  = Hochrechnung ÷ Hochrechnungs-Umsatz  (pkq.pkqHochrechnung)
  //  • pkqPlan = Ziel-Personalquote (zentrale Einstellung, konstant)
  const pkqIst  = pkZentral?.pkq.pkqHochrechnung != null ? pkZentral.pkq.pkqHochrechnung * 100 : null;
  const pkqPlan = pkZentral?.zielQuote != null ? pkZentral.zielQuote * 100 : null;
  const revenueLabel = revenueIsAssumed
    ? 'Annahme'
    : maisonOn
      ? (maisonExclude ? 'exkl. Marketing' : 'inkl. Marketing')
      : 'Ist-Umsatz';

  // ── Erfolgsrechnung (FIBU-5xxx) für „App vs. Erfolgsrechnung" (Ist-Kontrolle) ──
  // Read-only: reporting_v1-Blob (mandantengeprefixt) direkt aus localStorage
  // (gleiches Muster wie Import-Cockpit/Reporting — app-weiter Sync ist Wahrheit).
  // computePLForMonth ist EXAKT die Quelle der Reporting-Seite → Single Source of Truth.
  const erfolgsrechnung = useMemo(() => {
    const rec = loadMonth(selectedYear, selectedMonth, tenantKey('reporting_v1'));
    // EXAKT dieselbe Berechnung wie die Erfolgsrechnung (PLView) — kein „clean"-Sonderweg.
    // FIBU-Personalaufwand = „Löhne (Total)" (personnel_wages) + „Sozialleistungen"
    // (personnel_social); „Übriger Personalaufwand" (personnel_other) bleibt BEWUSST
    // aussen vor (die App-Kalkulation modelliert ihn nicht). Single Source of Truth.
    // Nur die Ist-Seite (actual) wird gebraucht (Kontrolle App ↔ ER-Ist) — daher keine
    // ER-Budget-Overrides mehr (die frühere Planung↔ER-Budget-Zeile ist entfallen).
    const plFull = computePLForMonth(rec);
    const findRow = (id: string) => plFull.rows.find(r => r.def.id === id);
    const wages = findRow('personnel_wages');
    const social = findRow('personnel_social');
    const fullRevenue = findRow('net_revenue');
    // Summe zweier PL-Zellen; null nur, wenn BEIDE Werte fehlen (nie 0 erfinden).
    const sumCells = (
      a: number | undefined, b: number | undefined,
    ): number | null => (a === undefined && b === undefined ? null : (a ?? 0) + (b ?? 0));
    const plPersonnelActual = sumCells(wages?.values.actual, social?.values.actual);
    const plNetRevenue = fullRevenue?.values.actual ?? null;
    return {
      plPersonnelActual,
      plNetRevenue,
    };
    // scheduleRefreshTick: neu lesen, wenn app-weiter Sync neue Reporting-Daten bringt
  }, [selectedYear, selectedMonth, tenantKey, scheduleRefreshTick]);

  // Ist vs. Erfolgsrechnung Ist: berechneter Personalaufwand (Ist) ↔ Erfolgsrechnung
  // (Löhne + Sozialleistungen), EXAKT wie in der Erfolgsrechnung dargestellt.
  // App-Ist = Hochrechnung aus dem Kern (zeitkonsistent), Quoten-Nenner =
  // Hochrechnungs-Umsatz aus dem Kern — KEIN Teilumsatz mehr.
  const erVergleich = useMemo(() => buildErfolgsrechnungVergleich({
    berechnetCHF: pkZentral?.kHr.total ?? 0,
    fibuCHF: erfolgsrechnung.plPersonnelActual,
    plNetRevenue: erfolgsrechnung.plNetRevenue,
    effectiveRevenue: pkZentral?.ums.hochrechnung ?? 0,
  }), [erfolgsrechnung, pkZentral]);

  // Budget vs. Ist (Block A des Personalcontrollings): dieselbe SSOT wie die
  // Kopf-Boxen — Budget = Ziel-Personalquote × Umsatz-Budget (pkZentral.pkBudget),
  // Ist = Hochrechnung (pkZentral.kHr, zeitkonsistent), Quoten aus dem Kern
  // (pkqPlan = Ziel-Quote, pkqIst = Hochrechnungs-PKQ). KEINE Parallelberechnung
  // und KEIN «volle Kosten ÷ Teilumsatz» mehr.
  const budgetVsIst = useMemo(() => buildBudgetVsIst({
    budgetCHF: pkZentral?.pkBudget?.total ?? 0,
    istCHF: pkZentral?.kHr.total ?? 0,
    budgetPct: pkqPlan,
    istPct: pkqIst,
  }), [pkZentral, pkqPlan, pkqIst]);
  const hasCoreBudget = pkZentral?.pkBudget?.total != null;

  // PKQ-Herleitung für InfoTip (echte Werte + Quelle, nichts hartcodiert)
  const pkqBreakdown = useMemo(() => buildPkqBreakdown({
    personalIst: pkZentral?.kHr.total ?? 0,
    revenue: pkZentral?.ums.hochrechnung ?? 0,
    revenueIsAssumed,
    revenueLabel,
    monthLabel: getMonthLabel(selectedYear, selectedMonth),
    cutoffDay: proRataDay,
  }), [pkZentral, revenueIsAssumed, revenueLabel, selectedYear, selectedMonth, proRataDay]);

  // ── Drilldown-Daten (Ursachenanalyse) ─────────────────────────────────────
  // Nur bei geöffnetem Dialog aufgebaut (gated memo). Nutzt dieselben Loader
  // wie pfix/FlexBreakdownModal (localStorage + bereits geladene Supabase-
  // Daten) — KEINE neuen DB-Abfragen, reine Ableitung aus geladenen Daten.
  const drilldownInput = useMemo<DrilldownInput | null>(() => {
    if (!drilldownFocus && !planungOpen) return null;
    void scheduleRefreshTick; // localStorage-Reread bei Dienstplan-Änderung
    const prefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    const planDays: DrilldownDayValue[] = [];
    const istDays: DrilldownDayValue[] = [];
    const zusatzPlanDays: DrilldownDayValue[] = [];
    const zusatzIstDays: DrilldownDayValue[] = [];
    for (const emp of variableEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
      if (!wage) continue;
      for (const r of loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey))
        planDays.push({ empId: emp.id, date: r.date, hours: r.hours, cost: r.cost });
      for (const r of loadDailyIstDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey))
        istDays.push({ empId: emp.id, date: r.date, hours: r.hours, cost: r.cost });
    }
    for (const emp of fixedEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates);
      if (!wage) continue;
      for (const r of loadZusatzPlanDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey))
        zusatzPlanDays.push({ empId: emp.id, date: r.date, hours: r.hours, cost: r.cost });
      for (const r of loadZusatzIstDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey))
        zusatzIstDays.push({ empId: emp.id, date: r.date, hours: r.hours, cost: r.cost });
    }
    const absences: DrilldownAbsenceDay[] = [];
    for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (!entry.absenceType) continue;
      absences.push({ empId: cellKey.slice(0, cellKey.length - 11), date, type: entry.absenceType });
    }
    const dailyRevenue: Record<string, number> = {};
    for (const [date, val] of Object.entries(monthlyRevenues)) {
      if (!date.startsWith(prefix)) continue;
      const net = grossToNet(val.actualRevenue ?? 0, maisonExclude ? 0 : (val.takeawayRevenue ?? 0));
      if (net > 0) dailyRevenue[date] = net;
    }
    // Schichtzeiten für die Detailstufe — NUR aus bereits geladenen Quellen:
    // Plan aus schedule-v2 (localStorage), Ist aus supabaseActualHours (State).
    // Fehlende Zeiten bleiben leer → UI zeigt "—", es wird nichts geschätzt.
    const shiftTimes: Record<string, DrilldownShiftTimes> = {};
    const shiftTimesAt = (empId: string, date: string): DrilldownShiftTimes => {
      const k = `${empId}|${date}`;
      return shiftTimes[k] ?? (shiftTimes[k] = { planSlots: [], istSlots: [], planBreakH: null });
    };
    const knownEmpIds = new Set([...variableEmployees, ...fixedEmployees].map(e => e.id));
    try {
      const raw = localStorage.getItem(tenantKey(`schedule-v2-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`));
      if (raw) {
        const data: Record<string, any> = JSON.parse(raw);
        for (const [cellKey, ds] of Object.entries(data)) {
          const date = cellKey.slice(-10);
          if (!date.startsWith(prefix)) continue;
          const empId = cellKey.slice(0, cellKey.length - 11);
          if (!knownEmpIds.has(empId)) continue;
          // FE-markierte Einträge überspringen — konsistent mit loadDailyPlanDetails
          if (ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE') continue;
          const slots: { start: string; end: string }[] = [];
          if (ds?.früh?.start && ds?.früh?.end) slots.push({ start: ds.früh.start, end: ds.früh.end });
          if (ds?.spät?.start && ds?.spät?.end) slots.push({ start: ds.spät.start, end: ds.spät.end });
          if (slots.length === 0) continue;
          const gross = calcSlotHours(ds?.früh) + calcSlotHours(ds?.spät);
          const st = shiftTimesAt(empId, date);
          st.planSlots = slots;
          // Effektive Pause = Brutto − Netto (SSoT, konsistent zu den Stunden)
          st.planBreakH = Math.max(0, Math.round((gross - calculateDayNetHours(ds)) * 100) / 100);
        }
      }
    } catch { /* defekter Blob → keine Zeiten, nie raten */ }
    for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!knownEmpIds.has(empId)) continue;
      const slots: { start: string; end: string }[] = [];
      if (entry.start && entry.end) slots.push({ start: entry.start, end: entry.end });
      if (entry.start2 && entry.end2) slots.push({ start: entry.start2, end: entry.end2 });
      if (slots.length === 0) continue;
      shiftTimesAt(empId, date).istSlots = slots;
    }
    // Letzter Tag mit erwartbar vollständigen Ist-Daten: Vergangenheits-Monat =
    // Monatslänge, laufender Monat = gestern, Zukunftsmonat = 0.
    const dim = new Date(selectedYear, selectedMonth, 0).getDate();
    const now = new Date();
    const cy = now.getFullYear();
    const cm = now.getMonth() + 1;
    const lastCompletedDay =
      selectedYear < cy || (selectedYear === cy && selectedMonth < cm) ? dim
      : selectedYear === cy && selectedMonth === cm ? Math.max(0, now.getDate() - 1)
      : 0;
    const employees: DrilldownInput['employees'] = [
      ...variableEmployees.map(e => ({
        id: e.id, name: e.name, department: e.department ?? '',
        position: e.primaryStation ?? null, isFixed: false,
      })),
      ...fixedEmployees.map(e => ({
        id: e.id, name: e.name, department: e.department ?? '',
        position: e.primaryStation ?? null, isFixed: true,
      })),
    ];
    return {
      year: selectedYear, month: selectedMonth, cutoffDay: proRataDay, lastCompletedDay,
      employees, planDays, istDays, zusatzPlanDays, zusatzIstDays, absences,
      // Überstunden liegen nur monatlich pro MA vor (keine Tageszuordnung) —
      // der Dialog zeigt sie als Monats-Hinweiszeile statt als Tages-Ursache.
      overtimeDayKeys: [],
      // Absenz-Codes aus der SSOT (absence-utils) — nie hier hartcodieren
      vacationCodes: [...VACATION_CODES],
      sickCodes: [...SICK_CODES],
      accidentCodes: [...ACCIDENT_CODES],
      dailyRevenue, fixMonthCHF: pfix.active.fix,
      shiftTimes,
    };
  }, [drilldownFocus, planungOpen, variableEmployees, fixedEmployees, selectedYear, selectedMonth,
      proRataDay, tenantKey, socialCostRates, supabaseActualHours, monthlyRevenues,
      maisonExclude, pfix.active.fix, scheduleRefreshTick]);

  // ── Planungsempfehlungen (rein abgeleitet, kein Schreibpfad) ──────────────
  // Nutzt DIESELBE Faktentabelle wie der Controlling-Drilldown (buildFactCells
  // auf drilldownInput — SSOT) plus Personalbedarf (SOLL) und optionale
  // Reservations-Personen. Nur bei geöffneter Sektion berechnet.
  const recoResult = useMemo<StaffingRecoResult | null>(() => {
    if (!planungOpen || !drilldownInput || !recoPersonsLoaded) return null;
    const positionLabels: Record<string, string> = {};
    for (const p of positions) positionLabels[p.key] = p.name;
    return buildStaffingRecommendations({
      year: selectedYear,
      month: selectedMonth,
      lastCompletedDay: drilldownInput.lastCompletedDay,
      cells: buildFactCells(drilldownInput),
      employees: drilldownInput.employees.map((e) => ({
        id: e.id,
        position: resolvePositionKey(positions, e.position) ?? null,
      })),
      shiftTimes: drilldownInput.shiftTimes,
      requirements: staffingRequirements
        .filter((r) => r.scopeType === 'weekly')
        .map((r) => ({
          season: r.season,
          weekday: r.weekday,
          positionKey: r.positionKey,
          shiftStart: r.shiftStart,
          shiftEnd: r.shiftEnd,
          requiredCount: r.requiredCount,
        })),
      season: recoSeason,
      positionLabels,
      dailyRevenue: drilldownInput.dailyRevenue,
      personsByDate: recoPersons,
    });
  }, [planungOpen, drilldownInput, recoPersonsLoaded, recoPersons, positions,
      staffingRequirements, recoSeason, selectedYear, selectedMonth]);

  // Die drei fachlich unterschiedlichen „Flex Ist"-Grössen aus denselben Bausteinen
  // (Single Source of Truth für die Abstimmung; nur ganzer Monat, s. Reconciliation-Block).
  const flexScopes = useMemo(() => computeFlexScopes({
    varArbeitIst: varIstTotalCHF,
    zusatzIst: zusatzIstCHF,
    ferienIst: ferienIstTotalCHF,
  }), [varIstTotalCHF, zusatzIstCHF, ferienIstTotalCHF]);

  // ── pfix-derived budget comparison (always uses Ist actuals as "spend") ────
  // When a cutoff (Stichtag) is active, scale the budget pro rata to that day
  // so that "Ist bis Stichtag" is compared against "Budget bis Stichtag".
  // ── Helper: format cutoff date label ──────────────────────────────────────
  const cutoffLabel = proRataDay !== null
    ? `${String(proRataDay).padStart(2, '0')}.${String(selectedMonth).padStart(2, '0')}.${selectedYear}`
    : null;
  const budgetLabel = cutoffLabel ? `bis ${cutoffLabel}` : 'gesamt';

  // pfixBudget = proRataBudget (weekday-gewichtet, Stichtag = proRataDay)
  const pfixBudget = proRataBudget;

  const pfixAvailableVar  = pfixBudget > 0 ? Math.max(0, pfixBudget - pfix.active.fix) : 0;
  // Budget comparison uses only Flex Arbeit Ist — Ferienabbau is NOT budget-relevant
  const pfixIstVarDelta   = pfixBudget > 0 ? pfixAvailableVar - pfix.active.istWork : 0;
  const pfixIstVarOverrun = pfixIstVarDelta < 0;

  // ── ISO-Wochennummer ──────────────────────────────────────────────────────
  function getISOWeek(d: Date): number {
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  // ── Flex-Aufstellung pro Woche (für Budget-Auswertung) ───────────────────
  const flexByWeek = useMemo((): Array<{ weekKey: string; label: string; planFlex: number; istFlex: number; dateRange: string; dates: string[]; daysInWeek: number }> => {
    const weekMap = new Map<string, { planFlex: number; istFlex: number; minDay: number; maxDay: number; days: number }>();
    const weekOrder: string[] = [];
    const mm = String(selectedMonth).padStart(2, '0');
    for (let day = 1; day <= daysInSelectedMonth; day++) {
      const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, day))}`;
      if (!weekMap.has(wk)) { weekMap.set(wk, { planFlex: 0, istFlex: 0, minDay: day, maxDay: day, days: 1 }); weekOrder.push(wk); }
      else { const e = weekMap.get(wk)!; e.maxDay = day; e.days++; }
    }
    for (const emp of variableEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
      if (!wage) continue;
      const planDays = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      const istDays  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      for (const d of planDays) {
        const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, parseInt(d.date.slice(-2), 10)))}`;
        const e = weekMap.get(wk); if (e) e.planFlex += d.cost;
      }
      for (const d of istDays) {
        const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, parseInt(d.date.slice(-2), 10)))}`;
        const e = weekMap.get(wk); if (e) e.istFlex += d.cost;
      }
    }
    return weekOrder.map(wk => {
      const e = weekMap.get(wk)!;
      const dateRange = `${String(e.minDay).padStart(2,'0')}.${mm}–${String(e.maxDay).padStart(2,'0')}.${mm}`;
      const dates: string[] = [];
      for (let d = e.minDay; d <= e.maxDay; d++) dates.push(`${selectedYear}-${mm}-${String(d).padStart(2,'0')}`);
      return { weekKey: wk, label: `KW ${wk.slice(2)}`, planFlex: e.planFlex, istFlex: e.istFlex, dateRange, dates, daysInWeek: e.days };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableEmployees, selectedYear, selectedMonth, daysInSelectedMonth, tenantKey, socialCostRates, agSozOff]);

  // ── Fix-Kosten pro Woche (pro-rata nach Tagen) ────────────────────────────
  const fixByWeek = useMemo(() =>
    flexByWeek.map(w => ({
      weekKey: w.weekKey,
      fixCost: daysInSelectedMonth > 0 ? totalFixCost * (w.daysInWeek / daysInSelectedMonth) : 0,
      empCosts: activeFixedEmployees.map(r => ({
        name: r.emp.name,
        dept: r.emp.department,
        monthlyCost: r.cost,
        weeklyCost: daysInSelectedMonth > 0 ? r.cost * (w.daysInWeek / daysInSelectedMonth) : 0,
      })),
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [flexByWeek, totalFixCost, daysInSelectedMonth, activeFixedEmployees]);

  // ── Wochenweise Ist-Umsatz netto aus dailyBudgets (MwSt-Split: TA 2.6 %,
  // übriger Umsatz 8.1 % — via grossToNet; ohne TA-Daten = 8.1 % pauschal) ──
  // Fallback: Wenn keine Ist-Daten vorhanden, Budget-Umsatz pro rata verwenden.
  const weekActualNetRevenue = useMemo((): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const w of flexByWeek) {
      let gross = 0, net = 0;
      for (const d of w.dates) {
        const g = monthlyRevenues[d]?.actualRevenue ?? 0;
        if (!(g > 0)) continue;
        gross += g;
        net += grossToNet(g, monthlyRevenues[d]?.takeawayRevenue ?? 0);
      }
      if (gross > 0) {
        result[w.weekKey] = net;
      } else if (weekRevOverrides[w.weekKey] != null) {
        result[w.weekKey] = weekRevOverrides[w.weekKey];
      } else {
        const budgetRev = budgetRevenue ?? budgetData.revenueBudget;
        if (budgetRev > 0 && daysInSelectedMonth > 0) {
          result[w.weekKey] = budgetRev * (w.daysInWeek / daysInSelectedMonth);
        }
      }
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, monthlyRevenues, weekRevOverrides, budgetRevenue, budgetData.revenueBudget, daysInSelectedMonth]);

  // Welche Wochen haben keinen Ist-Umsatz (Fallback oder manuell)?
  const weekRevenueIsEstimate = useMemo((): Record<string, boolean> => {
    const result: Record<string, boolean> = {};
    for (const w of flexByWeek) {
      const gross = w.dates.reduce(
        (sum, d) => sum + (monthlyRevenues[d]?.actualRevenue ?? 0), 0,
      );
      result[w.weekKey] = gross <= 0;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, monthlyRevenues]);

  // Welche Wochen haben einen manuellen Umsatz-Override?
  const weekRevenueIsManual = useMemo((): Record<string, boolean> => {
    const result: Record<string, boolean> = {};
    for (const w of flexByWeek) {
      result[w.weekKey] = weekRevOverrides[w.weekKey] != null;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, weekRevOverrides]);

  const hasAnyWeekRevenue = Object.keys(weekActualNetRevenue).length > 0;

  // Manuellen Umsatz-Override speichern / löschen
  const commitWeekRevEdit = (weekKey: string, rawVal: string) => {
    const num = parseFloat(rawVal.replace(/[^0-9.,]/g, '').replace(',', '.'));
    setWeekRevOverrides(prev => {
      const next = { ...prev };
      if (!isNaN(num) && num > 0) { next[weekKey] = num; }
      else { delete next[weekKey]; }
      saveWeekRevOverrides(selectedYear, selectedMonth, next, tenantKey);
      return next;
    });
    setWeekRevEditKey(null);
    setWeekRevEditVal('');
  };

  // ── Budget-Umsatz abgeleitete Werte ───────────────────────────────────────
  // basePkqPct: PKQ% aus der Budget-Planung (Basis für Szenario-Berechnungen)
  const basePkqPct = personnelBudget > 0 && budgetData.revenueBudget > 0
    ? (personnelBudget / budgetData.revenueBudget) * 100 : null;
  // effectiveBudgetRevenue: Szenario-Umsatz überschreibt Budget-Planung
  const effectiveBudgetRevenue = budgetRevenue ?? budgetData.revenueBudget;
  // adjustedPersonnelBudget (= Szenario-PK):
  //   1. Manuell gesetzter PK-Betrag (scenarioPkCost)
  //   2. Umsatz-Szenario × Basis-PKQ% (wenn nur Umsatz angepasst)
  //   3. Budget-Plan PK (kein Szenario)
  const adjustedPersonnelBudget =
    scenarioPkCost != null && scenarioPkCost > 0 ? scenarioPkCost
    : budgetRevenue != null && budgetRevenue > 0 && basePkqPct != null ? budgetRevenue * (basePkqPct / 100)
    : personnelBudget;
  // effectiveScenarioPkqPct: PKQ% des Szenarios (für Anzeige)
  const effectiveScenarioPkqPct = effectiveBudgetRevenue > 0 && adjustedPersonnelBudget > 0
    ? (adjustedPersonnelBudget / effectiveBudgetRevenue) * 100 : basePkqPct;
  const totalFlexForBudget = flexByWeek.reduce(
    (sum, w) => sum + (weekIstSet.has(w.weekKey) ? w.istFlex : w.planFlex), 0,
  );
  const verfügbarFlexBudget = adjustedPersonnelBudget > 0 ? adjustedPersonnelBudget - pfix.active.fix : 0;
  const budgetResultat       = verfügbarFlexBudget - totalFlexForBudget - (ferienInBudget ? totalFerienabbauCHF : 0) + (krankInBudget ? totalKrankCHF : 0) + (unfallInBudget ? totalUnfallCHF : 0);
  // Szenario aktiv wenn Umsatz oder PK überschrieben
  const scenarioActive = budgetRevenue != null || scenarioPkCost != null;

  // Operative Status-Logik:
  //   on_track  → Flex Arbeit Ist ≤ verfügbares Flex-Budget (delta ≥ 0)
  //   warning   → leicht darüber: 0 – 5 % von pfixAvailableVar
  //   off_track → deutlich darüber: > 5 % von pfixAvailableVar
  const flexBudgetStatus: 'on_track' | 'warning' | 'off_track' =
    pfixIstVarDelta >= 0
      ? 'on_track'
      : Math.abs(pfixIstVarDelta) <= pfixAvailableVar * 0.05
        ? 'warning'
        : 'off_track';

  // ── Effective cutoff for forecast ────────────────────────────────────────────
  // Priority: Stichtag > forecastIstDay (manual) > today (current month) > last day (past) > 0 (future)
  const isCurrentMonthForForecast = selectedYear === today.getFullYear() && selectedMonth === today.getMonth() + 1;
  const isPastMonth = selectedYear < today.getFullYear()
    || (selectedYear === today.getFullYear() && selectedMonth < today.getMonth() + 1);
  const effectiveForecastCutoff: number = proRataDay !== null
    ? proRataDay
    : isCurrentMonthForForecast
      ? (forecastIstDay !== null ? forecastIstDay : today.getDate())
      : isPastMonth
        ? daysInSelectedMonth  // past month: all days elapsed, no remaining plan
        : 0;                   // future month: no days elapsed, full plan is remaining

  const forecastIstLabel = proRataDay !== null
    ? `bis ${cutoffLabel}`
    : forecastIstDay !== null && isCurrentMonthForForecast
      ? `bis ${forecastIstDay}.`
      : `bis ${effectiveForecastCutoff}.`;

  // ── Forecast Monatsende: geplante Restkosten ab Tag nach Stichtag/heute ─────
  const forecastRemainingPlanFlex = useMemo(() => {
    const cutoffStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(effectiveForecastCutoff).padStart(2, '0')}`;
    let remaining = 0;
    for (const emp of variableEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
      if (!wage) continue;
      // Full month plan (no cutoff), dann filtern auf Tage NACH dem Stichtag/heute
      const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      remaining += planW.filter(r => r.date > cutoffStr).reduce((s, r) => s + r.cost, 0);
    }
    console.log(`[FLEX-FORECAST] mode: ${proRataDay !== null ? 'stichtag' : forecastIstDay !== null ? 'manual-ist-day' : 'today-as-cutoff'}`);
    console.log(`[FLEX-FORECAST] cutoff date: ${cutoffStr}`);
    console.log(`[FLEX-FORECAST] ist until cutoff: ${pfix.active.istWork.toFixed(2)}`);
    console.log(`[FLEX-FORECAST] remaining planned flex: ${remaining.toFixed(2)}`);
    return remaining;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableEmployees, selectedYear, selectedMonth, effectiveForecastCutoff, forecastIstDay, pfix.active.istWork, socialCostRates, agSozOff]);

  // Forecast Monatsende derived values
  // Gesamter Monat: Budget gesamt minus FIX gesamt (= pfix.month.fix)
  const forecastAvailableVar  = personnelBudget > 0 ? Math.max(0, personnelBudget - pfix.month.fix) : 0;
  const forecastFlexTotal     = pfix.active.istWork + forecastRemainingPlanFlex;
  const forecastDelta         = forecastAvailableVar > 0 ? forecastAvailableVar - forecastFlexTotal : 0;
  const forecastStatus: 'on_track' | 'warning' | 'off_track' =
    forecastDelta >= 0
      ? 'on_track'
      : Math.abs(forecastDelta) <= forecastAvailableVar * 0.05
        ? 'warning'
        : 'off_track';

  if (personnelBudget > 0 && proRataDay !== null) {
    console.log(`[FLEX-FORECAST] forecast month total: ${forecastFlexTotal.toFixed(2)}`);
    console.log(`[FLEX-FORECAST] budget remaining / status: ${forecastDelta.toFixed(2)} / ${forecastStatus}`);
  }

  // [FLEX-BUDGET] + [BUDGET-DAY] debug logs
  if (personnelBudget > 0) {
    const cd = cutoffLabel ?? 'full month';
    logBudgetDayDebug(personnelBudget, selectedYear, selectedMonth, weekdayWeights, proRataDay);
    console.log(`[FLEX-BUDGET] cutoff date: ${cd}`);
    console.log(`[FLEX-BUDGET] budget until cutoff (weekday-weighted): ${pfixBudget.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] fix ist until cutoff: ${pfix.active.fix.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] flex work ist until cutoff: ${pfix.active.istWork.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] remaining flex budget: ${pfixIstVarDelta >= 0 ? '+' : ''}${pfixIstVarDelta.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] status: ${flexBudgetStatus}`);
  }

  // Per-employee Plan vs Ist table — synchronized to pfix and FlexPeriodPopup
  // KEY FIX: In cutoff mode, hours are computed with ACTUAL day filtering
  // (same loadDailyPlanDetails/loadDailyIstDetails as the popup), NOT by scaling
  // full-month hours by proRataFactor. This eliminates the table ≠ popup discrepancy.
  const pfixPerEmp = useMemo(() => {
    const modeStr  = proRataDay !== null ? 'cutoff' : 'month';
    const factor   = proRataDay !== null ? proRataFactor : 1;

    const rows = variableEmployees.map(emp => {
      // AG-Sozialkosten pro MA abschaltbar — zentral in getEmployerCostRate
      // aufgelöst (totalHourly = grossHourly bei «ohne AG»). Stunden unverändert.
      const br    = getEmployerCostRate(emp, socialCostRates);
      const agOff = br?.agOff === true;
      const wage  = br?.totalHourly ?? 0;
      // Split-Pseudo-Zeilen: Stunden über Basis-id, skaliert mit Stundenlohn-Anteil
      const baseId = splitBaseId(emp.id);
      const splitF = wageSplits[baseId]?.hourlyFraction ?? 1;
      let planH: number, istH: number, planWork: number, istWork: number;

      if (proRataDay !== null) {
        // ── Cutoff mode: actual day filtering (identical to FlexPeriodPopup) ──
        const planW = loadDailyPlanDetails(baseId, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        const istW  = loadDailyIstDetails(baseId, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        planH    = planW.reduce((s, r) => s + r.hours, 0) * splitF;
        istH     = istW.reduce((s, r) => s + r.hours, 0) * splitF;
        planWork = planW.reduce((s, r) => s + r.cost,  0) * splitF;
        istWork  = istW.reduce((s, r) => s + r.cost,   0) * splitF;
      } else {
        // ── Full-month mode: pre-aggregated totals ─────────────────────────
        planH    = (planHours[baseId] ?? 0) * splitF;
        istH     = (istHours[baseId]  ?? 0) * splitF;
        planWork = planH * wage;
        istWork  = istH  * wage;
      }

      // Holiday: proportional scaling in both modes (calendar-uniform).
      // getEmpFerien*CHF nutzt getEffectiveHourlyRate → Flag bereits eingerechnet.
      const planHoliday  = getEmpFerienPlanCHF(emp) * factor;
      const istHoliday   = getEmpFerienCHF(emp)     * factor;
      const planTotalVar = planWork + planHoliday;
      const istTotalVar  = istWork  + istHoliday;

      // FLEX-SYNC log (matches what FlexPeriodPopup shows per employee)
      console.log(`[FLEX-SYNC] employee: ${emp.name}`);
      console.log(`[FLEX-SYNC] mode: ${modeStr}`);
      if (proRataDay !== null) {
        console.log(`[FLEX-SYNC] cutoff date: ${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${proRataDay}`);
      }
      console.log(`[FLEX-SYNC] row plan hours: ${planH.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row ist hours: ${istH.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row plan chf: ${planWork.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row ist chf: ${istWork.toFixed(2)}`);

      return {
        id:           emp.id,
        name:         emp.name,
        dept:         emp.department ?? '–',
        hourlyWage:   wage,
        weeklyHours:  emp.weeklyHours ?? 42,
        planH, istH,
        planWork, istWork,
        planHoliday, istHoliday,
        planTotalVar, istTotalVar,
        diffWork:     istWork     - planWork,
        diffHoliday:  istHoliday  - planHoliday,
        diffTotalVar: istTotalVar - planTotalVar,
        agOff,
      };
    });

    // ── Zusatzkosten-Zeilen für Fixlohn-MA ─────────────────────────────────
    // Fixlohn-MA mit isAdditionalCost=true Einträgen erscheinen als eigene Zeile
    // im Flex-Kosten-Block (Plan = 0, Ist = berechnete Zusatzkosten)
    for (const emp of fixedEmployees) {
      const wage = getEffectiveHourlyRate(emp, socialCostRates);
      if (!wage) continue;
      const cutoff = proRataDay;
      // Zusatzkosten IST: direkt aus Supabase-Daten (persistent, nicht localStorage)
      const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
      const zusatzW: DayEntry[] = Object.entries(supabaseActualHours)
        .flatMap(([cellKey, entry]) => {
          const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
          const date = cellKey.slice(-10);
          if (empIdFromKey !== emp.id) return [];
          if (!date.startsWith(yearMonthPrefix)) return [];
          if (!entry.isAdditionalCost) return [];
          const day = parseInt(date.slice(-2), 10);
          if (cutoff !== null && day > cutoff) return [];
          const h = entry.hours ?? 0;
          if (h <= 0) return [];
          return [{ date, hours: Math.round(h * 100) / 100, cost: Math.round(h * wage * 100) / 100 }];
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      const zusatzPlanW = loadZusatzPlanDetails(emp.id, selectedYear, selectedMonth, cutoff, wage, tenantKey);
      if (zusatzW.length === 0 && zusatzPlanW.length === 0) continue;
      const istH    = zusatzW.reduce((s, r) => s + r.hours, 0);
      const istWork = zusatzW.reduce((s, r) => s + r.cost, 0);
      const planH   = zusatzPlanW.reduce((s, r) => s + r.hours, 0);
      const planWork = zusatzPlanW.reduce((s, r) => s + r.cost, 0);
      console.log(`[ZUSATZ-ROW] ${emp.name}: IST ${zusatzW.length}T/${istH.toFixed(1)}h/${istWork.toFixed(2)} CHF | PLAN ${zusatzPlanW.length}T/${planH.toFixed(1)}h/${planWork.toFixed(2)} CHF`);
      rows.push({
        id:           emp.id,
        name:         emp.name,
        dept:         emp.department ?? '–',
        hourlyWage:   wage,
        weeklyHours:  emp.weeklyHours ?? 42,
        planH,   istH,
        planWork, istWork,
        planHoliday: 0, istHoliday: 0,
        planTotalVar: planWork, istTotalVar: istWork,
        diffWork:     istWork - planWork,
        diffHoliday:  0,
        diffTotalVar: istWork - planWork,
        agOff: false,
        isFixedAdditional: true,
      });
    }

    // ── [PERSONAL FIX] Debug ────────────────────────────────────────────────
    console.log(`[PERSONAL FIX] employees total: ${rows.length}`);
    console.log(`[PERSONAL FIX] flex employees: ${rows.length}`);
    console.log(`[CHECK] flex employees visible: ${rows.length > 0 ? 'OK' : 'none'}`);

    // ── Cross-check: table sums must match pfix master ──────────────────────
    const ref         = proRataDay !== null ? pfix.cutoff! : pfix.month;
    const sumPlanWork = rows.reduce((s, r) => s + r.planWork,    0);
    const sumIstWork  = rows.reduce((s, r) => s + r.istWork,     0);
    const sumPlanHol  = rows.reduce((s, r) => s + r.planHoliday, 0);
    const sumIstHol   = rows.reduce((s, r) => s + r.istHoliday,  0);
    const sumPlanVar  = rows.reduce((s, r) => s + r.planTotalVar, 0);
    const sumIstVar   = rows.reduce((s, r) => s + r.istTotalVar,  0);

    console.log(`[FLEX-SYNC] === TABLE SUMMARY mode=${modeStr} ===`);
    console.log(`[FLEX-SYNC] table sum planWork: ${sumPlanWork.toFixed(2)} | pfix: ${ref.planWork.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istWork:  ${sumIstWork.toFixed(2)} | pfix: ${ref.istWork.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum planHol:  ${sumPlanHol.toFixed(2)} | pfix: ${ref.planHoliday.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istHol:   ${sumIstHol.toFixed(2)} | pfix: ${ref.istHoliday.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum planVar:  ${sumPlanVar.toFixed(2)} | pfix: ${ref.planTotalVar.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istVar:   ${sumIstVar.toFixed(2)} | pfix: ${ref.istTotalVar.toFixed(2)}`);

    // «ohne AG»-Flags gelten GLOBAL (auch pfix-Master/Headline) → Summen müssen
    // weiterhin übereinstimmen.
    const agOffCount = rows.filter(r => r.agOff).length;
    if (agOffCount > 0)
      console.log(`[FLEX-SYNC] ${agOffCount} MA ohne AG-Sozialkosten gerechnet (global)`);
    if (Math.abs(sumPlanWork - ref.planWork) > 0.10)
      console.error(`[FLEX-SYNC] MISMATCH planWork: table=${sumPlanWork.toFixed(2)} vs pfix=${ref.planWork.toFixed(2)} diff=${(sumPlanWork - ref.planWork).toFixed(2)}`);
    if (Math.abs(sumIstWork - ref.istWork) > 0.10)
      console.error(`[FLEX-SYNC] MISMATCH istWork: table=${sumIstWork.toFixed(2)} vs pfix=${ref.istWork.toFixed(2)} diff=${(sumIstWork - ref.istWork).toFixed(2)}`);

    return rows;
  }, [variableEmployees, fixedEmployees, selectedYear, selectedMonth, planHours, istHours,
      getEmpFerienPlanCHF, getEmpFerienCHF, proRataDay, proRataFactor, pfix, tenantKey,
      scheduleRefreshTick, supabaseActualHours, socialCostRates, agSozOff]);

  // ── AG-Sozialkosten-Toggle pro Flex-MA (global wirksam) ────────────────────
  const toggleAgSoz = useCallback((empId: string) => {
    const baseId = splitBaseId(empId);
    const nextOff = !agSozOff[baseId];
    // 1) Zentral persistieren — getEmployerCostRate liest ab sofort den neuen Satz
    setAgSozOffFlag(tenantId, baseId, nextOff);
    // 2) Lokaler State für Re-Render/Memos
    setAgSozOff(loadAgSozOffMap(tenantId));
    // 3) Offenes Breakdown-Popup sofort auf den neuen Satz umstellen
    setBreakdown(b => {
      if (!b || splitBaseId(b.empId) !== baseId) return b;
      const emp = variableEmployees.find(e => splitBaseId(e.id) === baseId);
      const br  = emp ? getEmployerCostRate(emp, socialCostRates) : null;
      return { ...b, agOff: nextOff, hourlyWage: br?.totalHourly ?? b.hourlyWage };
    });
  }, [tenantId, agSozOff, variableEmployees, socialCostRates, agSozOff]);
  const agOffFlexCount = useMemo(
    () => variableEmployees.filter(e => agSozOff[splitBaseId(e.id)]).length,
    [variableEmployees, agSozOff],
  );

  // ── Flex-Ist-Overrides: wirksame Werte für Tabelle + Export ────────────────
  const flexAgFactor = useMemo(() => socialCostFactorFromRates(socialCostRates), [socialCostRates]);
  const flexManualCount = useMemo(
    () => pfixPerEmp.filter(r => flexOverrides.employees[r.id]).length,
    [pfixPerEmp, flexOverrides],
  );
  /** Summe der Zeilen: berechnete + manuell überschriebene (ohne Total-Override). */
  const flexIstEffectiveSum = useMemo(
    () => pfixPerEmp.reduce((s, r) => {
      const ov = flexOverrides.employees[r.id];
      return s + (ov ? effectiveFlexIst(ov, flexAgFactor) : r.istWork);
    }, 0),
    [pfixPerEmp, flexOverrides, flexAgFactor],
  );
  /** Anzeigewert der Total-Zeile: Total-Override vor Zeilensumme. */
  const flexIstTotalDisplay = flexOverrides.total
    ? effectiveFlexIst(flexOverrides.total, flexAgFactor)
    : flexIstEffectiveSum;

  // ── Abweichungsanalyse: tägliche Aggregation aller Flex-Mitarbeiter ──────────
  const pfixAbw = useMemo((): {
    days:      AbwDay[];
    weeks:     AbwRow[];
    monthPlan: number;
    monthIst:  number;
    monthDiff: number;
    /** Totals NUR über den Zeitraum bis zum letzten Ist-Tag (Zukunft zählt nicht). */
    bisIst:    { plan: number; ist: number; diff: number; lastIstDate: string };
  } => {
    const evaluation = buildFlexWeeklyEvaluation({
      year: selectedYear,
      month: selectedMonth,
      keyFn: tenantKey,
      todayIso: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      actualHours: supabaseActualHoursLoaded ? supabaseActualHours : undefined,
      employees: variableEmployees.map(emp => {
        const id = String(emp.id);
        const baseId = splitBaseId(id);
        const split = wageSplits[baseId];
        const isSplit = id.endsWith(FLEX_SPLIT_SUFFIX) && split != null;
        return {
          id,
          sourceId: isSplit ? baseId : id,
          name: emp.name,
          wage: getEffectiveHourlyRate(emp, socialCostRates) ?? 0,
          agOff: getEmployerCostRate(emp, socialCostRates)?.agOff === true,
          activeFrom: isSplit ? split.hourlyFrom : undefined,
          activeTo: isSplit ? split.hourlyTo : undefined,
        };
      }),
    });
    const lastIstDate = evaluation.lastIstDate;
    const days: AbwDay[] = evaluation.days.map(day => {
        const planTotal = day.planCost;
        const istTotal = day.istCost;
        const diff      = istTotal - planTotal;
        return {
          date: day.date,
          planWork:   planTotal,
          istWork:    istTotal,
          planFerien: 0,
          istFerien:  0,
          planTotal,
          istTotal,
          diff,
          diffPct: planTotal > 0 ? (diff / planTotal) * 100 : null,
        };
      });
    const weeks: AbwRow[] = evaluation.weeks.filter(week => !week.offen).map(week => {
        const plan = week.planCost;
        const ist = week.istCost;
        return {
          period:    week.teilweise ? `${week.label} (teilweise, bis ${fmtStichtagKurz(lastIstDate)})` : week.label,
          planTotal: plan,
          istTotal:  ist,
          diff:      ist - plan,
          diffPct:   plan > 0 ? ((ist - plan) / plan) * 100 : null,
          dates:     week.dates,
          offen:     week.offen,
          teilweise: week.teilweise,
        };
      });

    const monthPlan = days.reduce((s, d) => s + d.planTotal, 0);
    const monthIst  = days.reduce((s, d) => s + d.istTotal,  0);
    const monthDiff = monthIst - monthPlan;

    // «Total (abgerechnete Wochen)» exakt über dieselbe abgeschlossene
    // Kalenderwochen-Liste wie das Cockpit und der Cockpit-PDF.
    const bisIstPlan = weeks.reduce((sum, week) => sum + week.planTotal, 0);
    const bisIstIst  = weeks.reduce((sum, week) => sum + week.istTotal, 0);
    const bisIst = { plan: bisIstPlan, ist: bisIstIst, diff: bisIstIst - bisIstPlan, lastIstDate };

    const monthStatus = ampelStatus(monthDiff, monthPlan);
    const monthPctVal = monthPlan > 0 ? (monthDiff / monthPlan) * 100 : 0;

    console.log(`[FLEX] mode: ${abwMode}`);
    console.log(`[FLEX] plan total: ${monthPlan.toFixed(2)}`);
    console.log(`[FLEX] ist total: ${monthIst.toFixed(2)}`);
    console.log(`[FLEX] diff: ${monthDiff.toFixed(2)}`);
    console.log(`[FLEX] daily rows: ${days.length}, week rows: ${weeks.length}`);
    for (const w of weeks) {
      console.log(`[FLEX] ${w.period}: planKappe=${w.planTotal.toFixed(0)} ist=${w.istTotal.toFixed(0)} diffPct=${w.diffPct == null ? '-' : w.diffPct.toFixed(1)} offen=${w.offen} teilweise=${!!w.teilweise} stichtag=${lastIstDate || '-'}`);
    }
    console.log(`[AMPEL] status: ${monthStatus} | plan: ${monthPlan.toFixed(2)} | pct: ${monthPctVal.toFixed(2)}`);

    return { days, weeks, monthPlan, monthIst, monthDiff, bisIst };
  }, [variableEmployees, selectedYear, selectedMonth, planHours, istHours, abwMode, socialCostRates, agSozOff, tenantKey, wageSplits, supabaseActualHours, supabaseActualHoursLoaded]);

  // Pro-Rata pro variablen Mitarbeiter (für UI-Tabelle + Export)
  // ferienCHF: IST-Basis im Ist-Modus, PLAN-Basis im Plan/Manuell-Modus
  const proRataVarByEmp = useMemo(() => {
    return variableEmployees.map(emp => {
      const varArbeit = getVarMonthlyCostFor(emp.id, emp);
      const ferienCHF = varView === 'ist' ? getEmpFerienCHF(emp) : getEmpFerienPlanCHF(emp);
      // Total Variabel = Variable Arbeit + Ferienabbau (Addition!)
      const totalCost = varArbeit + ferienCHF;
      return {
        name:        emp.name,
        dept:        emp.department ?? '–',
        hours:       getVarHoursFor(emp.id),
        varArbeit,
        ferienCHF,
        monthlyCost: totalCost,
        proRataCost: totalCost * proRataFactor,
      };
    }).filter(r => r.monthlyCost > 0 || r.proRataCost > 0);
  }, [variableEmployees, getVarMonthlyCostFor, getEmpFerienCHF, getEmpFerienPlanCHF, getVarHoursFor, proRataFactor, varView]);

  // ── Departement-Zusammenfassung ────────────────────────────────────────────

  const deptSummary = useMemo(() => {
    const depts = Array.from(new Set([...Object.keys(byDept), ...Object.keys(varByDept)]));
    return depts.map(dept => {
      const fix = (byDept[dept] ?? []).reduce((s, r) => s + r.cost, 0);
      const varEmpList = varByDept[dept] ?? [];
      const varArbeit   = varEmpList.reduce((s, e) => s + getVarMonthlyCostFor(e.id, e), 0);
      // Ferienabbau: IST-Basis im Ist-Modus, PLAN-Basis im Plan/Manuell-Modus
      const ferienabbau = varView === 'ist'
        ? (ferienabbauByDept[dept] ?? 0)
        : (ferienabbauPlanByDept[dept] ?? 0);
      // Total Variabel = Variable Arbeit + Ferienabbau (Addition!)
      const variabel    = varArbeit + ferienabbau;
      return { dept, fix, varArbeit, ferienabbau, variabel, total: fix + variabel };
    });
  }, [byDept, varByDept, getVarMonthlyCostFor, ferienabbauByDept, ferienabbauPlanByDept, varView]);

  // ── Budget für variable Mitarbeiter ───────────────────────────────────────

  const availableVarBudget = personnelBudget > 0 ? Math.max(0, personnelBudget - totalFixCost) : 0;
  const varBudgetDelta     = personnelBudget > 0 ? availableVarBudget - totalVarCost : 0;
  const varBudgetOverrun   = varBudgetDelta < 0;

  // Ø Total Arbeitgeberkosten/h aller variablen Mitarbeiter mit Lohn hinterlegt
  // (gleiche AG-Basis wie availableVarBudget, sonst stimmen die "verfügbaren Stunden" nicht).
  const avgHourlyWage = useMemo(() => {
    const ratesPerEmp = variableEmployees
      .map(e => getEffectiveHourlyRate(e, socialCostRates) ?? 0)
      .filter(r => r > 0);
    if (!ratesPerEmp.length) return 0;
    return ratesPerEmp.reduce((s, r) => s + r, 0) / ratesPerEmp.length;
  }, [variableEmployees, socialCostRates, agSozOff]);

  // Maximal mögliche Stunden mit verfügbarem Variabel-Budget
  const maxVarHours = availableVarBudget > 0 && avgHourlyWage > 0
    ? Math.round(availableVarBudget / avgHourlyWage)
    : 0;
  // Pro-rata version for the budget block (uses pfixAvailableVar which is already scaled)
  const pfixMaxVarHours = pfixAvailableVar > 0 && avgHourlyWage > 0
    ? Math.floor(pfixAvailableVar / avgHourlyWage) : 0;

  // ── Stundensaldo aller Mitarbeiter ────────────────────────────────────────

  // Stundensaldo: reale Personen genau EINMAL — Split-Pseudo-Zeilen ausschliessen
  // (der Mitarbeiter ist im Split-Monat bereits über fixedEmployees vertreten).
  const allEmployees = useMemo(
    () => [...fixedEmployees, ...variableEmployees.filter(e => splitBaseId(e.id) === e.id)],
    [fixedEmployees, variableEmployees],
  );

  const hourBalances = useMemo(() =>
    buildHourBalances(
      allEmployees,
      planHours,
      istHours,
      (empId) => {
        // Für FIX-MA: nutze Plan-Stunden als Effektiv-Wert (oder Ist wenn verfügbar)
        const isFix = fixedEmployees.some(e => e.id === empId);
        if (isFix) {
          if (varView === 'ist' && istHours[empId]) return istHours[empId];
          return planHours[empId] ?? 0;
        }
        return getVarHoursFor(empId);
      },
    ),
    [allEmployees, planHours, istHours, fixedEmployees, varView, getVarHoursFor],
  );

  const planningHints = useMemo(() => {
    const remainingVarHours = maxVarHours > 0
      ? Math.max(0, maxVarHours - Math.round(totalVarHours))
      : 0;
    return generatePlanningHints(hourBalances, availableVarBudget, remainingVarHours);
  }, [hourBalances, availableVarBudget, maxVarHours, totalVarHours]);

  const varModeLabelShort = varView === 'plan' ? 'Plan' : varView === 'ist' ? 'Ist' : 'Manuell';

  // ── Quellen-Labels ────────────────────────────────────────────────────────

  const planHasDaten = Object.keys(planHours).length > 0;
  const istHasDaten  = Object.keys(istHours).length > 0;

  const varViewLabel: Record<VarView, string> = {
    plan:   'Quelle: Dienstplan Plan',
    ist:    'Quelle: Dienstplan Ist (Mirus-Import)',
    manual: 'Quelle: Manuelle Eingabe (lokal gespeichert)',
  };

  // ── PDF-Export ────────────────────────────────────────────────────────────

  // ── Excel-Export (einfach): Übersicht + Fix- + Flex-Lohnkosten ───────────
  // Nur Darstellung: alle Zahlen kommen aus den bestehenden Tabellen (byDept,
  // pfixPerEmp) bzw. der SSOT (pkZentral) — keine neue Berechnung.
  const handleExportExcel = async () => {
    try {
      const fixRows = Object.entries(byDept).flatMap(([dept, rows]) =>
        rows.map(({ emp, cost, yearlyCost }) => ({
          department: DEPT_LABEL[dept] ?? dept,
          name: emp.name,
          anstellung: EMP_TYPE_LABEL[emp.employmentType] ?? emp.employmentType,
          basisMt: emp.monthlySalary ?? 0,
          inkl13Mt: emp.monthlySalaryWith13th ?? 0,
          agMt: cost,
          agJahr: yearlyCost,
        })));
      const flexRows = pfixPerEmp.map((r) => {
        const ov = flexOverrides.employees[r.id];
        const effIst = ov ? effectiveFlexIst(ov, flexAgFactor) : r.istWork;
        return {
          name: ov ? `${r.name} (Flex Ist manuell)` : r.name,
          department: DEPT_LABEL[r.dept] ?? r.dept,
          agProStunde: r.hourlyWage,
          planStd: r.planH,
          istStd: r.istH,
          flexPlan: r.planWork,
          flexIst: effIst,
          diff: effIst - r.planWork,
        };
      });
      const tenantLabel = tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv';
      await exportPersonalkostenExcel({
        tenantLabel,
        monthKey: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`,
        monthLabel: getMonthLabel(selectedYear, selectedMonth),
        totalFix: pkZentral?.kHr.fix ?? totalFixCost,
        // Bei manuellen Flex-Ist-Overrides übernimmt der Export die Tabellenwerte —
        // konsistent in Übersicht UND Abschnitts-Total (totalPersonalkosten = FIX + FLEX).
        totalFlex: (flexOverrides.total || flexManualCount > 0) ? flexIstTotalDisplay : (pkZentral?.kHr.flex ?? 0),
        totalPersonalkosten: (flexOverrides.total || flexManualCount > 0)
          ? (pkZentral?.kHr.fix ?? totalFixCost) + flexIstTotalDisplay
          : (pkZentral?.kHr.total ?? totalFixCost),
        flexIstTotalOverride: flexOverrides.total ? flexIstTotalDisplay : null,
        flexManualNote: flexOverrides.total
          ? 'Flex-Ist-Total manuell aus der Lohnabrechnung übersteuert'
          : flexManualCount > 0
            ? `${flexManualCount} Zeile${flexManualCount === 1 ? '' : 'n'} mit manuell überschriebenem Flex Ist`
            : null,
        pkqProzent: pkZentral?.pkq.pkqHochrechnung != null ? pkZentral.pkq.pkqHochrechnung * 100 : null,
        fixRows,
        flexRows,
      });
      toast.success('Excel-Export erstellt.');
    } catch (e) {
      console.error('[PFIX] Excel-Export fehlgeschlagen:', e);
      toast.error('Excel-Export fehlgeschlagen.');
    }
  };

  // PDF-Export = 1:1-Abbild der Seite (gleiche Memos wie das Rendering, ohne
  // Verlaufs-/PKQ-Diagramme). Nur Darstellung — keine neue Berechnung.
  const handleExportPDF = (showWageDetail: boolean) => {
    try {
      if (!pkZentral || !pkDaten) { toast.error('Personalkosten noch nicht geladen.'); return; }

      // 2) Fix-Lohnkosten — exakt wie gerendert (Sortierung + aktiver Filter)
      const deptOrder = ['service', 'küche'];
      const allFixRows = Object.entries(byDept)
        .flatMap(([dept, rows]) => rows.map(r => ({ ...r, dept })))
        .sort((a, b) => {
          const da = deptOrder.indexOf(a.dept); const db = deptOrder.indexOf(b.dept);
          if (da !== db) return (da === -1 ? 99 : da) - (db === -1 ? 99 : db);
          return a.emp.name.localeCompare(b.emp.name, 'de');
        });
      const fixFiltered = fixDeptFilter === 'alle' ? allFixRows : allFixRows.filter(r => r.dept === fixDeptFilter);
      const fixTotals = {
        basis:  fixFiltered.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0),
        inkl13: fixFiltered.reduce((s, r) => s + (r.emp.monthlySalaryWith13th ?? 0), 0),
        agMt:   fixFiltered.reduce((s, r) => s + r.cost, 0),
      };

      // 3) Flex pro Mitarbeiter — inkl. manueller Ist-Overrides (wie Tabelle)
      const flexRows = pfixPerEmp.map(r => {
        const ov = flexOverrides.employees[r.id] ?? null;
        const effIst = ov ? effectiveFlexIst(ov, flexAgFactor) : r.istWork;
        return {
          name: r.name,
          dept: r.dept,
          hourly: r.hourlyWage,
          planH: r.planH,
          istH: r.istH,
          planCHF: r.planWork,
          istCHF: effIst,
          diff: effIst - r.planWork,
          zusatz: (r as any).isFixedAdditional === true,
          lohnFehlt: (r as any).isFixedAdditional !== true && r.hourlyWage === 0,
          agOff: (r as any).agOff === true,
          manuell: ov !== null,
        };
      });
      const flexIstTotal = flexOverrides.total
        ? effectiveFlexIst(flexOverrides.total, flexAgFactor)
        : flexIstEffectiveSum;

      // 4) Flex-Auswertung — aktuelle Aggregation der Seite (Ampel identisch);
      //    Woche: «offen»-Zeiträume neutral, Total/Kum. nur über Wochen mit Ist.
      const { days, weeks, monthPlan, monthIst, monthDiff, bisIst } = pfixAbw;
      const monthLabelStr = getMonthLabel(selectedYear, selectedMonth);
      const abwBase =
        abwMode === 'week' ? weeks.map(w => ({ period: w.period, plan: w.planTotal, ist: w.istTotal, diff: w.diff, diffPct: w.diffPct, offen: w.offen === true })) :
        abwMode === 'day'  ? days.map(d => ({ period: fmtDate(d.date), plan: d.planTotal, ist: d.istTotal, diff: d.diff, diffPct: d.diffPct, offen: false })) :
        [{ period: monthLabelStr, plan: monthPlan, ist: monthIst, diff: monthDiff, diffPct: monthPlan > 0 ? (monthDiff / monthPlan) * 100 : null, offen: false }];
      let cum = 0;
      const abwRows = abwBase.map(r => {
        if (!r.offen) cum += r.diff;
        return { ...r, cum, status: (r.offen ? 'neutral' : ampelStatus(r.diff, r.plan)) as PkAmpel };
      });
      const abwTotPlan = abwMode === 'week' ? bisIst.plan : monthPlan;
      const abwTotIst  = abwMode === 'week' ? bisIst.ist  : monthIst;
      const abwTotDiff = abwMode === 'week' ? bisIst.diff : monthDiff;
      const abwTotPct  = abwTotPlan > 0 ? (abwTotDiff / abwTotPlan) * 100 : null;

      exportPersonalkostenSeiteToPDF({
        tenantLabel: tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv',
        monthLabel: monthLabelStr,
        year: selectedYear,
        month: selectedMonth,
        // 1) Kopf — identisch zu den PkHeadline-Props (SSOT pkZentral/pkDaten)
        hrTotalCHF: pkZentral.kHr.total,
        hrFixCHF: pkZentral.kHr.fix,
        hrFlexCHF: pkZentral.kHr.flex,
        budgetCHF: pkZentral.pkBudget?.total ?? null,
        umsatzBudgetCHF: pkDaten.umsatzBudgetMonat ?? 0,
        zielQuote: pkZentral.zielQuote,
        pkqHochrechnung: pkZentral.pkq.pkqHochrechnung,
        umsatzHochrechnungCHF: pkZentral.ums.hochrechnung,
        istTotalCHF: pkZentral.kIst.total,
        umsatzIstCHF: pkZentral.ums.istBisHeute,
        pkqIst: pkZentral.pkq.pkqIst,
        istTage: pkZentral.ums.istTage,
        daysInMonth: pkDaten.daysInMonth,
        stichtag: pkZentral.stichtag,
        agOffFlexCount,
        showWageDetail,
        // 2) Fix — Anonymisierung («Ramadani Mejdi») greift zentral in der
        //    PDF-Lib für ALLE Tabellen (Fix UND Flex); on-screen bleibt der Name.
        fixFilterLabel: fixDeptFilter === 'alle' ? null : fixDeptFilter === 'küche' ? 'nur Küche' : 'nur Service',
        fixRows: fixFiltered.map(({ emp, cost, label, dept }) => ({
          name: emp.name,
          label,
          dept: DEPT_LABEL[dept] ?? dept,
          basis: emp.monthlySalary ?? null,
          inkl13: emp.monthlySalaryWith13th ?? null,
          agMt: cost,
          pensumPct: emp.weeklyHours != null && emp.weeklyHours > 0 ? (emp.weeklyHours / 42) * 100 : null,
        })),
        fixTotals,
        // 3) Flex
        flexProRataDay: proRataDay,
        flexRows,
        flexTotals: {
          planH: pfixPerEmp.reduce((s, r) => s + r.planH, 0),
          istH:  pfixPerEmp.reduce((s, r) => s + r.istH, 0),
          planCHF: pfixPerEmp.reduce((s, r) => s + r.planWork, 0),
          istCHF: flexIstTotal,
        },
        flexManualNote: flexOverrides.total
          ? 'Flex-Ist-Total manuell aus der Lohnabrechnung übersteuert'
          : flexManualCount > 0
            ? `${flexManualCount} Zeile${flexManualCount === 1 ? '' : 'n'} mit manuell überschriebenem Flex Ist`
            : null,
        // 4) Flex-Auswertung
        abwModeLabel: abwMode === 'day' ? 'Tag' : abwMode === 'week' ? 'Woche' : abwMode === 'month' ? 'Monat' : 'Jahr',
        abwStatus: ampelStatus(abwTotDiff, abwTotPlan) as PkAmpel,
        abwRows,
        abwTotal: abwRows.length > 1
          ? { plan: abwTotPlan, ist: abwTotIst, diff: abwTotDiff, diffPct: abwTotPct }
          : null,
      });
      toast.success('PDF erfolgreich exportiert');
    } catch (err) {
      console.error('[PersonalFix] PDF-Export Fehler:', err);
      toast.error('Fehler beim PDF-Export');
    }
  };

  const handleVarExport = (source: 'plan' | 'ist') => {
    try {
      const varRowsByDept: Record<string, Array<{ emp: Employee; hours: number; monthlyCost: number; hourlyWage: number }>> = {};
      for (const [dept, emps] of Object.entries(varByDept)) {
        varRowsByDept[dept] = emps.map(emp => {
          const hrs = source === 'plan' ? (planHours[emp.id] ?? 0) : (istHours[emp.id] ?? 0);
          return {
            emp,
            hours: hrs,
            monthlyCost: hrs * (getEffectiveHourlyRate(emp, socialCostRates) ?? 0),
            hourlyWage: getEffectiveHourlyRate(emp, socialCostRates) ?? 0,
          };
        });
      }
      const allRows = Object.values(varRowsByDept).flat();
      exportVarKostenvergleich({
        selectedYear,
        selectedMonth,
        varByDept: varRowsByDept,
        totalVarHours: allRows.reduce((s, r) => s + r.hours, 0),
        totalVarCost:  allRows.reduce((s, r) => s + r.monthlyCost, 0),
        source,
      });
      toast.success(`${source === 'plan' ? 'Plan' : 'Ist'}-Kostenvergleich exportiert`);
    } catch (err) {
      console.error('[PersonalFix] Var-Export Fehler:', err);
      toast.error('Fehler beim Export');
    }
  };

  // ── Flex-Auswertung Export ─────────────────────────────────────────────────

  function buildFlexExportData() {
    const periodRows = abwMode === 'day'
      ? pfixAbw.days.map(d => ({
          period:    d.date,
          planTotal: d.planTotal,
          istTotal:  d.istTotal,
          diff:      d.diff,
          diffPct:   d.diffPct,
        }))
      : abwMode === 'week'
      ? pfixAbw.weeks.map(w => ({
          // Offene Zukunftswochen im Export kennzeichnen (UI zeigt «noch offen»)
          period:    w.offen ? `${w.period} (noch offen · kein Ist)` : w.period,
          planTotal: w.planTotal,
          istTotal:  w.istTotal,
          diff:      w.diff,
          diffPct:   w.diffPct,
        }))
      : [{
          period:    `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`,
          planTotal: pfixAbw.monthPlan,
          istTotal:  pfixAbw.monthIst,
          diff:      pfixAbw.monthDiff,
          diffPct:   pfixAbw.monthPlan > 0 ? (pfixAbw.monthDiff / pfixAbw.monthPlan) * 100 : null,
        }];

    const empRows = pfixPerEmp.map(r => ({
      // «ohne AG»-Zeilen im Export markieren (CHF-Werte sind bereits ohne AG gerechnet)
      name:        (r as any).agOff === true ? `${r.name} (ohne AG-Kosten)` : r.name,
      dept:        r.dept,
      planWork:    r.planWork,
      istWork:     r.istWork,
      planHoliday: r.planHoliday,
      istHoliday:  r.istHoliday,
      planTotal:   r.planTotalVar,
      istTotal:    r.istTotalVar,
      diffTotal:   r.diffTotalVar,
    }));

    return {
      selectedYear,
      selectedMonth,
      abwMode,
      periodRows,
      empRows,
      // Wochenmodus: Kopf/KPI/Total wie die Seite «bis Ist-Stichtag» (Teilwochen
      // gekappt, Zukunft zählt nicht) — sonst widersprechen sich Zeilen und Total.
      monthPlan:     abwMode === 'week' ? pfixAbw.bisIst.plan : pfixAbw.monthPlan,
      monthIst:      abwMode === 'week' ? pfixAbw.bisIst.ist  : pfixAbw.monthIst,
      monthDiff:     abwMode === 'week' ? pfixAbw.bisIst.diff : pfixAbw.monthDiff,
      proRataDay,
      proRataFactor,
      daysInMonth:   daysInSelectedMonth,
    };
  }

  const handleFlexExportPDF = () => {
    try {
      exportFlexAuswertungToPDF(buildFlexExportData());
      toast.success('Flex-Auswertung PDF exportiert');
    } catch (err) {
      console.error('[PersonalFix] Flex-PDF-Export Fehler:', err);
      toast.error('Fehler beim PDF-Export');
    }
  };

  const handleFlexExportExcel = async () => {
    try {
      await exportFlexAuswertungToExcel(buildFlexExportData());
      toast.success('Flex-Auswertung Excel exportiert');
    } catch (err) {
      console.error('[PersonalFix] Flex-Excel-Export Fehler:', err);
      toast.error('Fehler beim Excel-Export');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <DollarSign className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-tight">Personal FIX + VARIABEL</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Lohnkosten-Übersicht & Hochrechnung</p>
            </div>
          </div>

          {/* Monatsnavigation */}
          <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-2 py-1 order-last sm:order-none">
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7"
              onClick={() => { const [y, m] = prevMonth(selectedYear, selectedMonth); setSelectedYear(y); setSelectedMonth(m); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 min-w-[120px] justify-center">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold tabular-nums">{getMonthLabel(selectedYear, selectedMonth)}</span>
            </div>
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7"
              onClick={() => { const [y, m] = nextMonth(selectedYear, selectedMonth); setSelectedYear(y); setSelectedMonth(m); }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <UnifiedExportButton
            data-testid="pfix-export"
            actions={[
              { key: 'excel', label: 'Excel-Export (Personalkosten)', kind: 'excel', onSelect: handleExportExcel },
              { key: 'pdf', label: 'Personalkosten-Seite (PDF) — mit Detaillöhnen', kind: 'pdf', onSelect: () => handleExportPDF(true) },
              { key: 'pdf-anon', label: 'Personalkosten-Seite (PDF) — ohne Detaillöhne', kind: 'pdf', onSelect: () => handleExportPDF(false) },
            ]}
          />
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── [BEAULIEU-WAGE] Fehlende-Lohn-Banner ─────────────────────────── */}
        {tenantId === 'beaulieu' && missingWageEmployees.length > 0 && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-start gap-3">
            <span className="text-amber-600 dark:text-amber-400 text-lg leading-none mt-0.5">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Lohn fehlt bei {missingWageEmployees.length} Mitarbeiter{missingWageEmployees.length !== 1 ? 'n' : ''}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                {missingWageEmployees.map(e => e.name).join(', ')} — bitte im Personalstamm hinterlegen, damit Personal FIX korrekt rechnet.
              </p>
            </div>
          </div>
        )}

        {/* ── B: Total Personal FIX + VARIABEL Ist — Kopf-KPIs ─────────────── */}
        <section
          data-testid="pfix-total-summary"
          className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3"
        >
          {/* ── Etappe 4: Schlagzeile + 4 Kacheln + Ist-Zeile (SSOT: personalkosten.ts) ── */}
          {pkZentral && pkDaten ? (
            <PkHeadline
              monthLabel={getMonthLabel(selectedYear, selectedMonth)}
              hrTotalCHF={pkZentral.kHr.total}
              hrFixCHF={pkZentral.kHr.fix}
              hrFlexCHF={pkZentral.kHr.flex}
              budgetCHF={pkZentral.pkBudget?.total ?? null}
              umsatzBudgetCHF={pkDaten.umsatzBudgetMonat ?? 0}
              zielQuote={pkZentral.zielQuote}
              pkqHochrechnung={pkZentral.pkq.pkqHochrechnung}
              umsatzHochrechnungCHF={pkZentral.ums.hochrechnung}
              istTotalCHF={pkZentral.kIst.total}
              umsatzIstCHF={pkZentral.ums.istBisHeute}
              pkqIst={pkZentral.pkq.pkqIst}
              istTage={pkZentral.ums.istTage}
              daysInMonth={pkDaten.daysInMonth}
              stichtag={pkZentral.stichtag}
              year={selectedYear}
              month={selectedMonth}
              fmtCHF={fmtCHF}
              onFocus={(f) => setDrilldownFocus(f)}
            />
          ) : (
            <p className="text-sm text-muted-foreground py-4">Lade Personalkosten …</p>
          )}
          {agOffFlexCount > 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="text-ag-soz-hint">
              {agOffFlexCount} Mitarbeiter ohne AG-Sozialkosten gerechnet
            </p>
          )}





        </section>

        {/* ── FIX-Lohnkosten: EINE gemeinsame Tabelle mit Abteilungs-Spalte + Filter ──
            Spalten Anstellung und Total AG/Jahr bewusst entfernt; Total im Fuss
            synchronisiert sich mit dem Abteilungs-Filter (Alle/Küche/Service). */}
        {Object.keys(byDept).length > 0 && (() => {
          const deptOrder = ['service', 'küche'];
          const allRows = Object.entries(byDept)
            .flatMap(([dept, rows]) => rows.map(r => ({ ...r, dept })))
            .sort((a, b) => {
              const da = deptOrder.indexOf(a.dept); const db = deptOrder.indexOf(b.dept);
              if (da !== db) return (da === -1 ? 99 : da) - (db === -1 ? 99 : db);
              return a.emp.name.localeCompare(b.emp.name, 'de');
            });
          const filtered = fixDeptFilter === 'alle' ? allRows : allRows.filter(r => r.dept === fixDeptFilter);
          const tBase = filtered.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);
          const t13   = filtered.reduce((s, r) => s + (r.emp.monthlySalaryWith13th ?? 0), 0);
          const tMt   = filtered.reduce((s, r) => s + r.cost, 0);
          const FILTERS: { key: 'alle' | 'küche' | 'service'; label: string }[] = [
            { key: 'alle', label: 'Alle' },
            { key: 'küche', label: 'nur Küche' },
            { key: 'service', label: 'nur Service' },
          ];
          return (
            <section data-testid="pfix-fix-table" className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-muted/30 border-b border-border">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <DollarSign className="h-4 w-4 text-blue-600" />
                  Fix-Lohnkosten
                  <Badge variant="secondary" className="text-xs">{filtered.length}</Badge>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {EMPLOYER_COST_LABELS_SHORT.total}/Mt <strong className="text-blue-700 dark:text-blue-300 font-mono">{fmtCHF(tMt)}</strong>
                </span>
              </div>
              <div className="overflow-x-auto">
                {/* Kompakt: kleine Schrift/enge Zeilen — alle Fix-MA ohne Scrollen sichtbar. */}
                <table className="w-full text-xs min-w-[520px]">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground border-b border-border bg-muted/10">
                      <th className="text-left px-3 py-1 font-medium">Name</th>
                      <th className="text-left px-3 py-1 font-medium">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          Abteilung
                          <span className="inline-flex rounded-md border border-border overflow-hidden" data-testid="pfix-fix-dept-filter">
                            {FILTERS.map(f => (
                              <button
                                key={f.key}
                                onClick={() => setFixDeptFilter(f.key)}
                                data-testid={`pfix-fix-filter-${f.key}`}
                                className={cn(
                                  'px-1.5 py-0.5 text-[10px] font-normal transition-colors',
                                  fixDeptFilter === f.key
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-background hover:bg-muted text-muted-foreground',
                                )}
                              >
                                {f.label}
                              </button>
                            ))}
                          </span>
                        </span>
                      </th>
                      <th className="text-right px-3 py-1 font-medium">Basis-Lohn/Mt</th>
                      <th className="text-right px-3 py-1 font-medium">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help underline decoration-dotted">inkl. 13. /Mt</span>
                          </TooltipTrigger>
                          <TooltipContent>Monatslohn amortisiert inkl. 13. Monatslohn</TooltipContent>
                        </Tooltip>
                      </th>
                      <th className="text-right px-3 py-1 font-medium">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help underline decoration-dotted">{EMPLOYER_COST_LABELS_SHORT.total}/Mt</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">{EMPLOYER_COST_INFO.total}</TooltipContent>
                        </Tooltip>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map(({ emp, cost, label, dept }, i) => {
                      const isProRata = label !== null;
                      // Kleine visuelle Trennung beim Abteilungswechsel (statt grosser Blöcke)
                      const deptBreak = fixDeptFilter === 'alle' && i > 0 && filtered[i - 1].dept !== dept;
                      return (
                        <tr key={emp.id} className={cn('hover:bg-muted/30 transition-colors', deptBreak && 'border-t-2 border-border')}>
                          <td className="px-3 py-1 font-medium whitespace-nowrap">
                            {emp.name}
                            {isProRata && (
                              <span className="ml-1.5 text-[10px] font-normal px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                                {label}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1 text-muted-foreground whitespace-nowrap">{DEPT_LABEL[dept] ?? dept}</td>
                          <td className="px-3 py-1 text-right font-mono">{emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–'}</td>
                          <td className="px-3 py-1 text-right font-mono">{emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–'}</td>
                          <td className="px-3 py-1 text-right font-semibold font-mono text-blue-700 dark:text-blue-400">
                            {cost > 0
                              ? <span>{fmtCHF(cost)}{isProRata && <span className="text-[10px] font-normal text-amber-600 ml-1">*</span>}</span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/20 font-semibold border-t-2 border-border" data-testid="pfix-fix-total">
                      <td className="px-3 py-1.5" colSpan={2}>
                        Total FIX{fixDeptFilter !== 'alle' ? ` — ${DEPT_LABEL[fixDeptFilter]}` : ''}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(tBase)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(t13)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-700 dark:text-blue-400">{fmtCHF(tMt)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          );
        })()}

        {/* ── C: Flex Kosten pro Mitarbeiter ─────────────────────────────── */}
        {pfixPerEmp.length > 0 && (
          <section data-testid="pfix-flex-per-employee" className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/20 border-b border-border">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Flex Kosten pro Mitarbeiter
                      {proRataDay !== null && ` — bis ${proRataDay}.`}
                    </span>
                    {agOffFlexCount > 0 && (
                      <span className="text-[11px] text-muted-foreground ml-2">
                        {agOffFlexCount} Mitarbeiter ohne AG-Sozialkosten gerechnet
                      </span>
                    )}
                    <Badge variant="secondary" className="text-xs ml-auto">{pfixPerEmp.length} MA</Badge>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[580px]">
                      <thead>
                        <tr className="bg-muted/30 border-b border-border text-muted-foreground">
                          <th className="px-3 py-2 text-left font-medium">Name</th>
                          <th className="px-3 py-2 text-center font-medium">Abt.</th>
                          <th className="px-3 py-2 text-right font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">{EMPLOYER_COST_LABELS_SHORT.total}/h</span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">{EMPLOYER_COST_INFO.total}</TooltipContent>
                            </Tooltip>
                          </th>
                          <th className="px-3 py-2 text-right font-medium text-blue-500">Plan Std</th>
                          <th className="px-3 py-2 text-right font-medium text-orange-500">Ist Std</th>
                          <th className="px-3 py-2 text-right font-medium text-blue-700">Flex Plan</th>
                          <th className="px-3 py-2 text-right font-medium text-orange-700">Flex Ist</th>
                          <th className="px-3 py-2 text-right font-medium">Diff.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pfixPerEmp.map((row, i) => {
                          const dc = (v: number) => v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
                          const openBreakdown = (field: BreakdownField) => setBreakdown({
                            empId:       row.id,
                            empName:     row.name,
                            field,
                            hourlyWage:  row.hourlyWage,
                            weeklyHours: row.weeklyHours,
                            year:        selectedYear,
                            month:       selectedMonth,
                            cutoffDay:   proRataDay,
                            factor:      proRataDay !== null ? proRataFactor : 1,
                            agOff:       (row as any).agOff === true,
                          });
                          const clickCell = (field: BreakdownField, amount: number, colorClass: string) => (
                            <td className="px-3 py-1.5 text-right">
                              {amount > 0
                                ? <button onClick={() => openBreakdown(field)}
                                    className={cn('font-mono font-semibold underline underline-offset-2 decoration-dotted hover:opacity-80 transition-opacity cursor-pointer', colorClass)}
                                    title="Tagesdetails anzeigen">
                                    {fmtCHF(amount)}
                                  </button>
                                : <span className="text-muted-foreground font-mono">–</span>}
                            </td>
                          );
                          const isZusatz = (row as any).isFixedAdditional === true;
                          return (
                            <tr key={row.id + (isZusatz ? '-zusatz' : '')} className={
                              isZusatz
                                ? 'bg-orange-50/60 dark:bg-orange-900/10 hover:bg-orange-100/50 dark:hover:bg-orange-900/20 border-l-2 border-orange-400'
                                : i % 2 === 0 ? 'bg-background hover:bg-muted/20' : 'bg-muted/10 hover:bg-muted/20'
                            }>
                              <td className="px-3 py-1.5 font-medium">
                                <div className="flex items-center gap-2">
                                  {row.name}
                                  {isZusatz && (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 whitespace-nowrap">
                                      Zusatzkosten
                                      <button
                                        onClick={e => { e.stopPropagation(); clearZusatzkostenPlan(row.id, row.name); }}
                                        className="ml-0.5 leading-none text-orange-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                                        title="Zusatzkosten-Markierung entfernen"
                                      >×</button>
                                    </span>
                                  )}
                                  {!isZusatz && row.hourlyWage === 0 && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                                      Lohn fehlt
                                    </span>
                                  )}
                                  {!isZusatz && (row as any).agOff === true && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 whitespace-nowrap">
                                      ohne AG-Kosten
                                    </span>
                                  )}
                                  {!isZusatz && (
                                    <label
                                      className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap cursor-pointer select-none"
                                      title="AG-Sozialkosten in den CHF-Werten dieses Mitarbeiters einrechnen (Stunden bleiben unverändert)"
                                      onClick={e => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        className="h-3 w-3 accent-primary cursor-pointer"
                                        checked={(row as any).agOff !== true}
                                        onChange={() => toggleAgSoz(row.id)}
                                        data-testid={`checkbox-ag-soz-${row.id}`}
                                      />
                                      AG-Soz.
                                    </label>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-center text-muted-foreground capitalize">{row.dept}</td>
                              <td
                                className="px-3 py-1.5 text-right font-mono text-muted-foreground"
                                title={(row as any).agOff === true ? 'Bruttolohn ohne AG-Sozialkosten' : undefined}
                              >
                                {row.hourlyWage > 0 ? `${row.hourlyWage.toFixed(2)}` : '–'}
                                {(row as any).agOff === true && row.hourlyWage > 0 && <span className="ml-0.5 text-[9px] align-super">*</span>}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-blue-500 dark:text-blue-400">{row.planH > 0 ? `${row.planH.toFixed(1)} h` : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-orange-500 dark:text-orange-400">{row.istH > 0 ? `${row.istH.toFixed(1)} h` : '–'}</td>
                              {clickCell('planWork', row.planWork, 'text-blue-700 dark:text-blue-400')}
                              {(() => {
                                const ov = flexOverrides.employees[row.id] ?? null;
                                const effIst = ov ? effectiveFlexIst(ov, flexAgFactor) : row.istWork;
                                const effDiff = effIst - row.planWork;
                                return (
                                  <>
                                    <td className="px-3 py-1.5 text-right">
                                      <FlexIstOverrideCell
                                        computed={row.istWork}
                                        override={ov}
                                        agFactor={flexAgFactor}
                                        fmtCHF={fmtCHF}
                                        testId={`flex-ist-override-${row.id}`}
                                        onSave={o => updateFlexOverrides(prev => ({
                                          ...prev, employees: { ...prev.employees, [row.id]: o },
                                        }))}
                                        onReset={() => updateFlexOverrides(prev => {
                                          const employees = { ...prev.employees };
                                          delete employees[row.id];
                                          return { ...prev, employees };
                                        })}
                                      >
                                        {row.istWork > 0
                                          ? <button onClick={() => openBreakdown('istWork')}
                                              className="font-mono font-semibold underline underline-offset-2 decoration-dotted hover:opacity-80 transition-opacity cursor-pointer text-orange-700 dark:text-orange-400"
                                              title="Tagesdetails anzeigen">
                                              {fmtCHF(row.istWork)}
                                            </button>
                                          : <span className="text-muted-foreground font-mono">–</span>}
                                      </FlexIstOverrideCell>
                                    </td>
                                    <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', dc(effDiff))}>{effDiff === 0 ? '–' : `${effDiff > 0 ? '+' : ''}${fmtCHF(effDiff)}`}</td>
                                  </>
                                );
                              })()}
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/30 font-bold text-xs">
                          <td className="px-3 py-2" colSpan={3}>Total</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-500 dark:text-blue-400">{pfixPerEmp.reduce((s,r)=>s+r.planH,0).toFixed(1)} h</td>
                          <td className="px-3 py-2 text-right font-mono text-orange-500 dark:text-orange-400">{pfixPerEmp.reduce((s,r)=>s+r.istH,0).toFixed(1)} h</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700 dark:text-blue-400">{fmtCHF(pfixPerEmp.reduce((s, r) => s + r.planWork, 0))}</td>
                          <td className="px-3 py-2 text-right text-orange-700 dark:text-orange-400">
                            <div className="flex flex-col items-end gap-0.5">
                              <FlexIstOverrideCell
                                computed={flexIstEffectiveSum}
                                override={flexOverrides.total}
                                agFactor={flexAgFactor}
                                fmtCHF={fmtCHF}
                                bold
                                testId="flex-ist-override-total"
                                onSave={o => updateFlexOverrides(prev => ({ ...prev, total: o }))}
                                onReset={() => updateFlexOverrides(prev => ({ ...prev, total: null }))}
                              />
                              {flexManualCount > 0 && !flexOverrides.total && (
                                <span className="text-[9px] font-normal text-muted-foreground">
                                  davon {flexManualCount} Zeile{flexManualCount === 1 ? '' : 'n'} manuell
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
          </section>
        )}



        {/* ── Einheitliche Flex-Auswertung ───────────────────────────────────── */}
        {(pfixAbw.days.length > 0 || pfixPerEmp.length > 0) && (() => {
          const { days, weeks, monthPlan, monthIst, monthDiff, bisIst } = pfixAbw;
          // Bewertung/Total NUR über den Zeitraum bis zum letzten Ist-Tag —
          // Zukunftswochen ohne Ist sind «noch offen», keine Abweichung.
          const istWeeks    = weeks.filter(w => !w.offen);
          const totalPlan   = abwMode === 'week' ? bisIst.plan : monthPlan;
          const totalIst    = abwMode === 'week' ? bisIst.ist  : monthIst;
          const totalDiff   = abwMode === 'week' ? bisIst.diff : monthDiff;
          const monthPct    = totalPlan > 0 ? (totalDiff / totalPlan) * 100 : null;
          const avgWeekDiff = istWeeks.length > 0 ? bisIst.diff / istWeeks.length : 0;
          const avgDayDiff  = days.length  > 0 ? monthDiff / days.length  : 0;
          const monthStatus = ampelStatus(totalDiff, totalPlan);
          const mA          = AMPEL[monthStatus];

          const fmtDiff = (v: number) => {
            const s = fmtCHF(Math.abs(v));
            return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
          };
          const fmtPct = (v: number | null) => {
            if (v === null) return '–';
            const s = `${Math.abs(v).toFixed(1)} %`;
            return v > 0.05 ? `+${s}` : v < -0.05 ? `−${s}` : s;
          };

          const allDates = days.map(d => d.date);
          const monthLabel = getMonthLabel(selectedYear, selectedMonth);

          type PeriodRow = { period: string; plan: number; ist: number; diff: number; diffPct: number | null; dates: string[]; offen?: boolean };
          const tableRows: PeriodRow[] =
            abwMode === 'year'  ? [{ period: monthLabel, plan: monthPlan, ist: monthIst, diff: monthDiff, diffPct: monthPct, dates: allDates }] :
            abwMode === 'month' ? [{ period: monthLabel, plan: monthPlan, ist: monthIst, diff: monthDiff, diffPct: monthPct, dates: allDates }] :
            abwMode === 'week'  ? weeks.map(w => ({ period: w.period, plan: w.planTotal, ist: w.istTotal, diff: w.diff, diffPct: w.diffPct, dates: w.dates, offen: w.offen })) :
            days.map(d => ({ period: fmtDate(d.date), plan: d.planTotal, ist: d.istTotal, diff: d.diff, diffPct: d.diffPct, dates: [d.date] }));

          const kpiChips = [
            { label: 'Abweichung Monat', val: totalDiff,   plan: totalPlan,                                          pct: monthPct },
            { label: 'Ø Abw./Woche',     val: avgWeekDiff, plan: istWeeks.length > 0 ? bisIst.plan / istWeeks.length : 0, pct: istWeeks.length > 0 && bisIst.plan > 0 ? (avgWeekDiff / (bisIst.plan / istWeeks.length)) * 100 : null },
            { label: 'Ø Abw./Tag',        val: avgDayDiff,  plan: days.length  > 0 ? monthPlan / days.length  : 0,  pct: days.length  > 0 ? (avgDayDiff  / (monthPlan / days.length))  * 100 : null },
          ];

          return (
            <section className={cn('rounded-xl border-2 bg-card shadow-sm overflow-hidden', mA.border)}>
              {/* ── Header ────────────────────────────────────────────────────── */}
              <div className={cn('flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border', mA.bg || 'bg-amber-50/60 dark:bg-amber-950/20')}>
                <TrendingDown className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  Flex-Auswertung — Plan vs. Ist
                </span>
                <div className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ml-1', mA.border, mA.bg, mA.text)}>
                  <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', mA.dot)} />
                  {mA.label}
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  <UnifiedExportButton
                    className="h-7 px-2 text-xs gap-1"
                    data-testid="pfix-flex-export"
                    actions={[
                      { key: 'pdf', label: 'Flex-Auswertung (PDF)', kind: 'pdf', onSelect: handleFlexExportPDF },
                      { key: 'excel', label: 'Flex-Auswertung (Excel)', kind: 'excel', onSelect: () => { void handleFlexExportExcel(); } },
                    ]}
                  />
                </div>
                {proRataDay !== null && (
                  <Badge variant="secondary" className="text-xs">bis {proRataDay}. · {Math.round(proRataFactor * 100)} %</Badge>
                )}
              </div>



              {/* ── Toggle + Legende ──────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-border bg-muted/5">
                <span className="text-xs text-muted-foreground font-medium">Aggregation:</span>
                <div className="flex gap-1 rounded-lg bg-muted p-0.5">
                  {(['week', 'day', 'month', 'year'] as AbwMode[]).map(m => (
                    <button key={m} onClick={() => setAbwMode(m)}
                      className={cn('rounded px-3 py-1 text-xs font-medium transition-colors',
                        abwMode === m ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                      {m === 'day' ? 'Tag' : m === 'week' ? 'Woche' : m === 'month' ? 'Monat' : 'Jahr'}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3 ml-auto text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Im Plan</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> Leicht über Plan (&le;5 %)</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Über Plan (&gt;5 %)</span>
                  <span className="text-[10px] italic text-muted-foreground/60 ml-2">Zeile anklicken → Details</span>
                </div>
              </div>

              {/* ── Periodenübersicht (clickable rows → FlexPeriodPopup) ──────── */}
              {tableRows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                        <th className="text-center px-3 py-2 font-medium w-8">●</th>
                        <th className="text-left px-4 py-2 font-medium">Zeitraum</th>
                        <th className="text-right px-4 py-2 font-medium text-blue-600">Flex Arbeit Plan</th>
                        <th className="text-right px-4 py-2 font-medium text-orange-600">Flex Arbeit Ist</th>
                        <th className="text-right px-4 py-2 font-medium">Diff. CHF</th>
                        <th className="text-right px-4 py-2 font-medium">Diff. %</th>
                        <th className="text-right px-4 py-2 font-medium">Kum. Abw. CHF</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(() => {
                        let cumDiff = 0;
                        return tableRows.map((row, i) => {
                          // «noch offen»: kein Ist im Zeitraum → keine Abweichung,
                          // zählt nicht in die Kumulation (neutral markiert).
                          if (!row.offen) cumDiff += row.diff;
                          const st = row.offen ? 'neutral' as const : ampelStatus(row.diff, row.plan);
                          const a  = AMPEL[st];
                          const cumCls = cumDiff > 0.005 ? 'text-red-600 dark:text-red-400'
                            : cumDiff < -0.005 ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground';
                          return (
                            <tr
                              key={i}
                              className={cn('hover:bg-muted/30 cursor-pointer transition-colors', a.bg, row.offen && 'opacity-60 italic')}
                              onClick={() => setFlexPeriodPopup({
                                label:     row.period,
                                dates:     row.dates,
                                planTotal: row.plan,
                                istTotal:  row.ist,
                                year:      selectedYear,
                                month:     selectedMonth,
                              })}
                              title="Klicken für MA-Aufschlüsselung"
                            >
                              <td className="px-3 py-2 text-center">
                                <span className={cn('inline-block w-2.5 h-2.5 rounded-full', a.dot)} />
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{row.period}</td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(row.plan)}</td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{row.offen ? '–' : fmtCHF(row.ist)}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold', a.text)}>{row.offen ? 'noch offen' : fmtDiff(row.diff)}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums text-xs', a.text)}>{row.offen ? 'kein Ist' : fmtPct(row.diffPct)}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold text-xs', row.offen ? 'text-muted-foreground/50' : cumCls)}>
                                {row.offen ? '–' : `${cumDiff > 0.005 ? '+' : cumDiff < -0.005 ? '−' : ''}${fmtCHF(Math.abs(cumDiff))}`}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                    {tableRows.length > 1 && (
                      <tfoot>
                        <tr className={cn('border-t-2 border-border', mA.bg || 'bg-muted/20')}>
                          <td className="px-3 py-2.5 text-center"><span className={cn('inline-block w-2.5 h-2.5 rounded-full', mA.dot)} /></td>
                          <td className="px-4 py-2.5 font-bold text-xs">Total{abwMode === 'week' && weeks.some(w => w.offen || w.teilweise) ? ' (bis Ist)' : ''}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold text-blue-700 dark:text-blue-400">{fmtCHF(totalPlan)}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold text-orange-700 dark:text-orange-400">{fmtCHF(totalIst)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-bold', mA.text)}>{fmtDiff(totalDiff)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono text-xs', mA.text)}>{fmtPct(monthPct)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-bold text-xs', mA.text)}>
                            {totalDiff > 0.005 ? '+' : totalDiff < -0.005 ? '−' : ''}{fmtCHF(Math.abs(totalDiff))}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </section>
          );
        })()}



        {/* ── Verlaufs-Diagramme (ganz unten, standardmässig eingeklappt) ── */}
        <CollapsibleSection
          testid="pfix-section-verlauf"
          icon={<TrendingUp />}
          title="Verlauf — kumulierte Personalkosten & PKQ"
          status="Diagramme"
        >
          {/* ── Etappe 4: Verlaufsgrafik — kumulierte Personalkosten ─────────── */}
          {pkVerlauf && pkVerlauf.length > 0 && (
            <PkVerlaufChart punkte={pkVerlauf} fmtCHF={fmtCHF} />
          )}

          {/* ── PKQ-Verlauf (kumuliert) — nur bis Stichtag, ausschliesslich SSOT ── */}
          {pkDaten && pkqVerlauf && pkqVerlauf.rows.length > 0 && (
            <div
              data-testid="pfix-pkq-verlauf"
              className="rounded-lg border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  PKQ-Verlauf (kumuliert)
                </h3>
                <span className="text-[11px] text-muted-foreground">
                  Kumulierte Personalkosten ÷ kumulierter Netto-Umsatz
                </span>
              </div>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={pkqVerlauf.rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis
                      domain={[0, pkqVerlauf.yMax]}
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) => `${v} %`}
                      width={40}
                    />
                    <RTooltip
                      formatter={(v: number | null) => [v == null ? '—' : `${v.toFixed(1)} %`, 'PKQ']}
                      labelFormatter={(l: string) => `Datum: ${l}`}
                    />
                    {pkZentral?.zielQuote != null && (
                      <ReferenceLine
                        y={pkZentral.zielQuote * 100}
                        stroke="hsl(142, 76%, 36%)"
                        strokeDasharray="5 4"
                        label={{ value: `Ziel ${(pkZentral.zielQuote * 100).toFixed(1)} %`, position: 'insideBottomLeft', fill: 'hsl(142, 76%, 36%)', fontSize: 10 }}
                      />
                    )}
                    <ReferenceLine
                      y={40}
                      stroke="hsl(0, 72%, 51%)"
                      strokeDasharray="5 4"
                      label={{ value: 'Obergrenze 40 %', position: 'insideTopLeft', fill: 'hsl(0, 72%, 51%)', fontSize: 10 }}
                    />
                    <RLine
                      type="monotone"
                      dataKey="pkq"
                      name="PKQ"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </CollapsibleSection>

      </main>

      <FlexPeriodPopup
        target={flexPeriodPopup}
        employees={variableEmployees.map(e => ({ id: e.id, name: e.name, hourlyWage: getEffectiveHourlyRate(e, socialCostRates) ?? 0, weeklyHours: e.weeklyHours ?? 42 }))}
        onClose={() => setFlexPeriodPopup(null)}
      />
      <FlexBreakdownModal target={breakdown} onClose={() => setBreakdown(null)} onToggleAgSoz={toggleAgSoz} />

      {/* ── Personalcontrolling-Drilldown (Ursachenanalyse) ───────────────── */}
      {drilldownFocus && drilldownInput && (
        <ControllingDrilldownDialog
          focus={drilldownFocus}
          onClose={() => setDrilldownFocus(null)}
          monthLabel={getMonthLabel(selectedYear, selectedMonth)}
          cutoffDay={proRataDay}
          input={drilldownInput}
          bridge={{
            fixCHF: pfix.active.fix,
            varArbeitPlanCHF: pfix.active.planWork,
            varArbeitIstCHF: pfix.active.istWork,
            ferienPlanCHF: pfix.active.planHoliday,
            ferienIstCHF: pfix.active.istHoliday,
            planTotalCHF: pfix.active.planTotal,
            istTotalCHF: pfix.active.istTotal,
          }}
          pkqIst={pkqIst}
          pkqBudget={pkqPlan}
          effectiveRevenue={effectiveRevenue}
          revenueIsAssumed={revenueIsAssumed}
          manualVarHours={varView === 'manual'}
          overtimeCostCHF={overtimeAnalysis.totalOvertimeCost}
          er={erVergleich}
          coreFixCHF={pkZentral?.kHr.fix ?? 0}
          coreFlexCHF={pkZentral?.kHr.flex ?? 0}
          onOpenSchedule={() => navigate('/personal')}
        />
      )}

      {/* ── KW-Detail-Popup (Fix + Flex pro Woche) ───────────────────────── */}
      {weekDetailTarget && (() => {
        const idx = flexByWeek.findIndex(w => w.weekKey === weekDetailTarget);
        const w   = flexByWeek[idx];
        const fix = fixByWeek[idx];
        if (!w || !fix) return null;
        const detailData: WeekDetailData = {
          weekLabel:   w.label,
          dateRange:   w.dateRange,
          dates:       w.dates,
          daysInWeek:  w.daysInWeek,
          daysInMonth: daysInSelectedMonth,
          fixEmps:     fix.empCosts,
          flexEmps:    variableEmployees.map(e => ({ id: e.id, name: e.name, hourlyWage: getEffectiveHourlyRate(e, socialCostRates) ?? 0 })),
          year:        selectedYear,
          month:       selectedMonth,
        };
        return <WeekDetailPopup data={detailData} onClose={() => setWeekDetailTarget(null)} />;
      })()}

      {/* ── Tag-Detail-Modal ──────────────────────────────────────────────── */}
      <Dialog open={dayDetailModal !== null} onOpenChange={open => { if (!open) setDayDetailModal(null); }}>
        <DialogContent className="max-w-sm">
          {dayDetailModal && (() => {
            const d             = dayDetailModal;
            const [, mm, dd]    = d.date.split('-');
            const dateLabel     = `${dd}.${mm}.${selectedYear}`;
            const pct           = d.diffPct ?? 0;
            const isRed         = pct > 20;
            const isOrange      = pct > 8 && pct <= 20;
            const isYellow      = d.diff > 0.01 && pct <= 8;

            // Per-day derived values
            const fixPerDay     = daysInSelectedMonth > 0 ? totalFixCost / daysInSelectedMonth : 0;
            const flexPlanAnteil = d.planWork;
            const gesamtPlanTag = fixPerDay + flexPlanAnteil;
            const budgetPerDay  = daysInSelectedMonth > 0 ? pfixBudget / daysInSelectedMonth : 0;
            const personalquote = budgetPerDay > 0 ? (gesamtPlanTag / budgetPerDay) * 100 : null;
            const planHours     = avgHourlyWage > 0 ? d.planWork / avgHourlyWage : null;
            const istHours      = avgHourlyWage > 0 ? d.istWork / avgHourlyWage : null;

            const verdictBg    = isRed
              ? 'bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800'
              : isOrange
                ? 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                : isYellow
                  ? 'bg-yellow-50/60 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800'
                  : 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800';
            const verdictColor = isRed ? 'text-red-700 dark:text-red-400'
              : isOrange ? 'text-amber-700 dark:text-amber-400'
              : isYellow ? 'text-yellow-700 dark:text-yellow-600'
              : 'text-emerald-700 dark:text-emerald-400';
            const verdictTitle = isRed
              ? '⛔ Kritisch — deutlich über Plan'
              : isOrange
                ? '⚠ Erhöht — über Planwert'
                : isYellow
                  ? '⚠ Leicht erhöht — im vertretbaren Bereich'
                  : '✓ Im Zielbereich';
            const verdictText = isRed
              ? 'Die Flex-Ist-Kosten überschreiten den Plan deutlich (> 20 %). Schichtlängen und Einsätze prüfen.'
              : isOrange
                ? 'Die Flex-Ist-Kosten liegen 8–20 % über Plan. Einsparpotenzial vorhanden.'
                : isYellow
                  ? 'Die Flex-Ist-Kosten liegen knapp über Plan (bis 8 %) — noch vertretbar.'
                  : 'Dieser Tag liegt im Zielbereich. Die Flex-Kosten entsprechen dem Plan oder sind darunter.';
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base">Tagesdetail — {dateLabel}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 pt-1">

                  {/* Planungsstruktur des Tages */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Planung</p>
                    <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Personalbudget (anteilig)</span>
                        <span className="font-mono font-semibold">{fmtCHF(budgetPerDay)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">FIX Anteil (Tagesmittel)</span>
                        <span className="font-mono text-blue-700 dark:text-blue-400">{fmtCHF(fixPerDay)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Plan Anteil</span>
                        <span className="font-mono">{fmtCHF(flexPlanAnteil)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2 font-semibold">
                        <span className="text-muted-foreground">Geplante Personalkosten</span>
                        <span className="font-mono">{fmtCHF(gesamtPlanTag)}</span>
                      </div>
                      {personalquote !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Personalquote (Plan)</span>
                          <span className={cn('font-mono font-semibold',
                            personalquote > 105 ? 'text-red-600 dark:text-red-400'
                              : personalquote > 95 ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400')}>
                            {personalquote.toFixed(1)} %
                          </span>
                        </div>
                      )}
                      {planHours !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Geplante Flex-Stunden</span>
                          <span className="font-mono">{planHours.toFixed(1)} h</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Plan vs. Ist Abweichung */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Plan vs. Ist (Flex)</p>
                    <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Plan</span>
                        <span className="font-mono">{fmtCHF(d.planWork)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Ist</span>
                        <span className="font-mono text-orange-700 dark:text-orange-400">{fmtCHF(d.istWork)}</span>
                      </div>
                      {istHours !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Flex-Stunden Ist</span>
                          <span className="font-mono">{istHours.toFixed(1)} h</span>
                        </div>
                      )}
                      <div className="flex justify-between px-3 py-2 font-bold">
                        <span className="text-muted-foreground">Budgetabweichung</span>
                        <span className={cn('font-mono', verdictColor)}>
                          {d.diff > 0.01 ? '+' : d.diff < -0.01 ? '−' : '±'}
                          {fmtCHF(Math.abs(d.diff))}
                          {d.diffPct !== null && ` (${d.diffPct > 0 ? '+' : ''}${d.diffPct.toFixed(1)} %)`}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Bewertung */}
                  <div className={cn('rounded-lg border px-3 py-2.5', verdictBg)}>
                    <p className={cn('text-sm font-bold', verdictColor)}>{verdictTitle}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{verdictText}</p>
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Ferienabbau-Detail-Popup: welche Tage genau ─────────────────── */}
      {showFerienDayDetail && (() => {
        const { empId, source, empName } = showFerienDayDetail;
        const entries = source === 'plan' ? (ferienPlanDetail[empId] ?? []) : (ferienIstDetail[empId] ?? []);
        const label   = source === 'plan' ? 'Plan-Dienstplan' : 'Mirus Ist';
        return (
          <Dialog open onOpenChange={open => { if (!open) setShowFerienDayDetail(null); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-sm">
                  Ferientage — {empName}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">({label})</span>
                </DialogTitle>
              </DialogHeader>
              {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">Keine Detail-Daten verfügbar.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {entries.map(({ date }) => {
                    const d = new Date(date + 'T00:00:00');
                    return (
                      <li key={date} className="flex items-center justify-between py-1.5 px-1">
                        <span className="font-mono text-xs text-muted-foreground">
                          {d.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                        </span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                          Ferien
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* ── K/U-Detail-Popup: welche Tage genau ──────────────────────────── */}
      {showKuDetail && (() => {
        const { empId, empName, typeFilter } = showKuDetail;
        const planAll = kuPlanDetail[empId] ?? [];
        const istAll  = kuIstDetail[empId]  ?? [];
        const filter = (arr: KUDayEntry[]) =>
          typeFilter === 'krank'  ? arr.filter(e => SICK_CODES.has(e.type))
          : typeFilter === 'unfall' ? arr.filter(e => ACCIDENT_CODES.has(e.type))
          : arr;
        const planEntries = filter(planAll);
        const istEntries  = filter(istAll);
        const allDates = [...new Set([...planEntries.map(e => e.date), ...istEntries.map(e => e.date)])].sort();
        const planMap  = Object.fromEntries(planEntries.map(e => [e.date, e]));
        const istMap   = Object.fromEntries(istEntries.map(e => [e.date, e]));
        const typeLabel = typeFilter === 'krank' ? 'Krank' : typeFilter === 'unfall' ? 'Unfall' : 'K/U';
        const Badge = ({ entry }: { entry: KUDayEntry | undefined }) => {
          if (!entry) return <span className="text-muted-foreground/30 text-xs">–</span>;
          const isK = SICK_CODES.has(entry.type);
          return (
            <span className={cn('text-xs font-semibold px-1.5 py-0.5 rounded-full',
              isK ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300')}>
              {isK ? 'K' : 'U'}
            </span>
          );
        };
        return (
          <Dialog open onOpenChange={open => { if (!open) setShowKuDetail(null); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-sm">{typeLabel}-Tage — {empName}</DialogTitle>
              </DialogHeader>
              {allDates.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">Keine Detail-Daten verfügbar.</p>
              ) : (
                <div className="overflow-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border/60">
                        <th className="text-left py-1.5 font-medium">Datum</th>
                        <th className="text-center py-1.5 px-3 font-medium">Plan</th>
                        <th className="text-center py-1.5 px-3 font-medium">Ist</th>
                        <th className="py-1.5 w-16" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {allDates.map(date => {
                        const pe = planMap[date];
                        const ie = istMap[date];
                        const d  = new Date(date + 'T00:00:00');
                        const hasDiff = Boolean(pe) !== Boolean(ie) || (pe?.type !== ie?.type);
                        return (
                          <tr key={date} className={cn('group', hasDiff && 'bg-amber-50/70 dark:bg-amber-950/15')}>
                            <td className="py-2 font-mono text-muted-foreground">
                              {d.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                            </td>
                            <td className="py-2 px-3 text-center"><Badge entry={pe} /></td>
                            <td className="py-2 px-3 text-center"><Badge entry={ie} /></td>
                            <td className="py-2 text-right">
                              {pe && (
                                <span className="inline-flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => handleKuPlanEdit(empId, date, 'frei')}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors"
                                    title="In Frei (F) ändern"
                                  >→ F</button>
                                  <button
                                    onClick={() => handleKuPlanEdit(empId, date, 'delete')}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 hover:bg-red-200 dark:bg-red-950/30 dark:hover:bg-red-950/60 text-red-600 dark:text-red-400 transition-colors"
                                    title="Plan-Eintrag löschen"
                                  >×</button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/50 pt-1">
                Aktionen (→F, ×) ändern nur den Plan-Dienstplan. Hover über Zeile zum Anzeigen.
              </p>
            </DialogContent>
          </Dialog>
        );
      })()}
    </div>
  );
}
