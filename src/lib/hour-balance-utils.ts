import { Employee } from '@/types/personnel';

// ─── Konstanten ──────────────────────────────────────────────────────────────

export const WEEKS_PER_MONTH = 4.333;

// Schwellenwerte für Planungshinweise
const MINUS_HIGH_PRIO  = -15;   // < -15h → dringend einplanen
const MINUS_MED_PRIO   = -8;    // < -8h  → bevorzugt einplanen
const PLUS_HIGH_PRIO   = 25;    // > +25h → freier Tag dringend
const PLUS_MED_PRIO    = 15;    // > +15h → freier Tag empfohlen

// ─── Typen ───────────────────────────────────────────────────────────────────

export interface EmployeeHourBalance {
  emp: Employee;
  monthlyTarget: number;       // Vertrags-Sollstunden im Monat
  effectiveHours: number;      // Stunden lt. gewähltem Modus (Plan/Ist/Manuell)
  planHours: number;           // Plan-Stunden (immer verfügbar falls Daten vorhanden)
  actualHours: number;         // Ist-Stunden (Mirus)
  monthDelta: number;          // effectiveHours − monthlyTarget
  cumulativeBalance: number;   // hoursBalance (Vortrag) + monthDelta
  hasTarget: boolean;          // weeklyHours ist hinterlegt
  station: string | null;      // primaryStation (oder positionTitle als Fallback)
  stationPeers: string[];      // Namen anderer MA in selber Abt. + selber Primary Station
  secondaryStationPeers: string[]; // Namen von MA, die diese Station als Zweitfunktion haben
  isUniqueInStation: boolean;  // kein anderer MA mit gleicher Station (primär ODER sekundär)
  hasNoStation: boolean;       // weder primaryStation noch positionTitle hinterlegt
}

export type HintType =
  | 'prefer_high'       // Dringend einplanen (großes Minus)
  | 'prefer_med'        // Bevorzugt einplanen (moderates Minus)
  | 'protect_high'      // Freier Tag dringend (großes Plus)
  | 'protect_med'       // Freier Tag empfohlen (moderates Plus)
  | 'unique_station'    // Einzige Kraft in dieser Station
  | 'budget_opport'     // Restbudget + Mitarbeiter im Minus
  | 'on_track';         // Alles im grünen Bereich

export interface PlanningHint {
  empId: string;
  empName: string;
  dept: string;
  station: string | null;
  type: HintType;
  priority: 'high' | 'medium' | 'low';
  message: string;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Monatliches Soll aus Vertrags-Wochenstunden.
 * Wenn weeklyHours nicht gesetzt → 0 (kein Soll bekannt).
 */
export function getMonthlyTargetHours(emp: Employee): number {
  const wh = emp.weeklyHours ?? 0;
  if (wh <= 0) return 0;
  return Math.round(wh * WEEKS_PER_MONTH * 10) / 10;
}

/**
 * Normalisiert eine Stations-Bezeichnung für Vergleiche:
 * Leerzeichen trimmen, Kleinschreibung, leere Strings → null.
 */
export function normalizeStation(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/**
 * Gibt die effektive Station zurück:
 * primaryStation (bevorzugt) → positionTitle (Fallback) → null
 */
export function effectiveStation(emp: { primaryStation?: string; positionTitle?: string }): string | null {
  return normalizeStation(emp.primaryStation) ?? normalizeStation(emp.positionTitle);
}

/**
 * Berechnet den Stundensaldo für alle übergebenen Mitarbeiter.
 *
 * @param employees    Alle Mitarbeiter
 * @param planHours    Map empId → Plan-Stunden (aus Dienstplan)
 * @param actualHours  Map empId → Ist-Stunden (aus Mirus)
 * @param getEffective Funktion empId → effektiv verwendete Stunden (je nach Modus)
 */
export function buildHourBalances(
  employees: Employee[],
  planHours: Record<string, number>,
  actualHours: Record<string, number>,
  getEffective: (empId: string) => number,
): EmployeeHourBalance[] {
  return employees.map(emp => {
    const target     = getMonthlyTargetHours(emp);
    const effective  = getEffective(emp.id);
    const plan       = planHours[emp.id]    ?? 0;
    const actual     = actualHours[emp.id]  ?? 0;
    const delta      = target > 0 ? Math.round((effective - target) * 10) / 10 : 0;
    const cumulative = Math.round(((emp.hoursBalance ?? 0) + delta) * 10) / 10;
    const station = effectiveStation(emp);

    return {
      emp,
      monthlyTarget: target,
      effectiveHours: effective,
      planHours: plan,
      actualHours: actual,
      monthDelta: delta,
      cumulativeBalance: cumulative,
      hasTarget: target > 0,
      station,
      // filled in next pass
      stationPeers: [],
      secondaryStationPeers: [],
      isUniqueInStation: false,
      hasNoStation: station === null,
    };
  }).map((row, _, all) => {
    // Second pass: compute station peers (primary + secondary)
    if (row.station !== null) {
      // Primary peers: same dept + same primaryStation/positionTitle
      const primaryPeers = all
        .filter(r =>
          r.emp.id !== row.emp.id &&
          r.emp.department === row.emp.department &&
          r.station === row.station,
        )
        .map(r => r.emp.name);

      // Secondary peers: employees who have this station in their secondaryStations
      const secondaryPeers = all
        .filter(r => {
          if (r.emp.id === row.emp.id) return false;
          if (r.emp.department !== row.emp.department) return false;
          if (primaryPeers.includes(r.emp.name)) return false; // already counted
          const secs = (r.emp.secondaryStations ?? []).map(s => normalizeStation(s));
          return secs.includes(row.station);
        })
        .map(r => r.emp.name);

      return {
        ...row,
        stationPeers: primaryPeers,
        secondaryStationPeers: secondaryPeers,
        isUniqueInStation: primaryPeers.length === 0 && secondaryPeers.length === 0,
      };
    }
    return row;
  });
}

/**
 * Erzeugt priorisierte Planungshinweise aus den berechneten Saldi.
 *
 * @param balances           Ergebnis von buildHourBalances()
 * @param availableVarBudget Restbudget für Variable (CHF); 0 wenn kein Budget hinterlegt
 * @param remainingVarHours  Noch planbare Stunden aus Budget; 0 wenn unbekannt
 */
export function generatePlanningHints(
  balances: EmployeeHourBalance[],
  availableVarBudget: number,
  remainingVarHours: number,
): PlanningHint[] {
  const hints: PlanningHint[] = [];

  for (const b of balances) {
    const { emp, cumulativeBalance, monthDelta, station, stationPeers, isUniqueInStation, hasTarget } = b;
    const dept = emp.department === 'küche' ? 'Küche' : 'Service';

    // ── Stundensaldo-Hinweise (nur wenn Sollstunden bekannt)
    if (hasTarget) {
      const balance = cumulativeBalance;

      if (balance <= MINUS_HIGH_PRIO) {
        hints.push({
          empId: emp.id, empName: emp.name, dept, station,
          type: 'prefer_high', priority: 'high',
          message: `${emp.name} ist ${Math.abs(balance).toFixed(1)} h im Minus — dringend einplanen${
            station ? ` (${emp.positionTitle})` : ''
          }.`,
        });
      } else if (balance < MINUS_MED_PRIO) {
        hints.push({
          empId: emp.id, empName: emp.name, dept, station,
          type: 'prefer_med', priority: 'medium',
          message: `${emp.name} hat ${Math.abs(balance).toFixed(1)} h Minussaldo — bevorzugt einplanen.`,
        });
      } else if (balance >= PLUS_HIGH_PRIO) {
        hints.push({
          empId: emp.id, empName: emp.name, dept, station,
          type: 'protect_high', priority: 'high',
          message: `${emp.name} hat ${balance.toFixed(1)} h Plusstunden${
            station ? ` als ${emp.positionTitle}` : ''
          } — freier Tag wäre sinnvoll${
            isUniqueInStation && station ? `; einzige ${emp.positionTitle}-Kraft → Besetzung prüfen` : ''
          }.`,
        });
      } else if (balance >= PLUS_MED_PRIO) {
        hints.push({
          empId: emp.id, empName: emp.name, dept, station,
          type: 'protect_med', priority: 'medium',
          message: `${emp.name} hat ${balance.toFixed(1)} h Plusstunden — freier Tag empfohlen.`,
        });
      }
    }

    // ── Stations-Hinweis: einzige Kraft (unabhängig vom Saldo)
    if (isUniqueInStation && station) {
      hints.push({
        empId: emp.id, empName: emp.name, dept, station,
        type: 'unique_station', priority: 'medium',
        message: `${emp.name} ist die einzige ${emp.positionTitle} in ${dept} — kein gleichwertiger Ersatz verfügbar.`,
      });
    }

    // ── Budget-Opportunität: Restbudget vorhanden + Mitarbeiter im Minus (nur Variable)
    if (
      availableVarBudget > 0 &&
      remainingVarHours > 0 &&
      hasTarget &&
      cumulativeBalance < MINUS_MED_PRIO &&
      (emp.employmentType === 'aushilfe' || emp.employmentType === 'minijob' || (emp.hourlyWage > 0 && !emp.monthlySalary))
    ) {
      const canPlan = Math.min(remainingVarHours, Math.abs(cumulativeBalance));
      if (canPlan >= 2) {
        hints.push({
          empId: emp.id, empName: emp.name, dept, station,
          type: 'budget_opport', priority: 'medium',
          message: `Noch ${remainingVarHours.toFixed(0)} h Budget und ${emp.name} ist im Minus — bis zu ${canPlan.toFixed(0)} h einplanen sinnvoll${
            station ? ` (${emp.positionTitle})` : ''
          }.`,
        });
      }
    }
  }

  // ── Sortierprioritäten: high → medium → low; prefer/protect/budget vor unique
  const ORDER: Record<HintType, number> = {
    prefer_high:    0,
    protect_high:   1,
    budget_opport:  2,
    prefer_med:     3,
    protect_med:    4,
    unique_station: 5,
    on_track:       6,
  };
  const PRIO: Record<string, number> = { high: 0, medium: 1, low: 2 };

  return hints.sort((a, b) => {
    const pa = PRIO[a.priority] ?? 2;
    const pb = PRIO[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9);
  });
}

// ─── Format-Helper ────────────────────────────────────────────────────────────

/** Formatiert einen Stundensaldo mit Vorzeichen, z.B. "+3.5 h" oder "−12.0 h" */
export function fmtBalanceHours(h: number): string {
  if (h === 0) return '± 0 h';
  const sign = h > 0 ? '+' : '−';
  return `${sign}${Math.abs(h).toFixed(1)} h`;
}
