/**
 * staffing-day-hints — Live-Hinweis «Plan vs. Bedarf» beim Planen im Dienstplan.
 * ──────────────────────────────────────────────────────────────────────────────
 * Reine Logik (keine Supabase-/DOM-Abhängigkeiten) — im Node-Env testbar.
 * NUR Anzeige/Transparenz: sperrt NIE, verändert weder Dienstplan noch Bedarf.
 *
 * ── Kopfzahl-Logik (konsistent mit Wochenmatrix + Cockpit) ────────────────────
 *  - SOLL je Position/Tag = KOPFZAHL der Wochenzelle via `computeWeekCell`
 *    (explizites meta.dayHeadcount vor Automatik max(Mittag, Abend);
 *    UG-Zuschlag immer additiv) — dieselbe Funktion wie buildWeekOverview,
 *    damit sich Dienstplan-Hinweis, Abgleich-Panel und Cockpit nie widersprechen.
 *  - PLAN je Position/Tag = Anzahl PERSONEN (Kopfzahl, keine Einsätze): jeder
 *    Einsatz (Slot) wird via `assignPlannedToShifts` genau EINEM Soll-Block
 *    zugeordnet (Position + grösste Zeitüberlappung; Priorität dynamische
 *    Regel (CdS, Kalte Küche/Sushi) > Haupt > Zweit > Alias); je Position wird
 *    die Person dann DEDUPLIZIERT — Früh+Spät derselben Person auf derselben
 *    Position zählen als 1 Person. Keine Mehrfachzählung.
 *
 * ── Stunden (Kostenwarnung) ───────────────────────────────────────────────────
 *  Netto-Stunden beidseitig mit der ArG/L-GAV-Pausenstaffel
 *  (nettoSegmentMinutes): SOLL = Σ Blockdauer × Anzahl; PLAN = Σ Netto-Minuten
 *  aller produktiv geplanten Personen (auch nicht zugeordnete — Kosten fallen
 *  trotzdem an). Liegt PLAN über SOLL → Kostenwarnung (hoursOver).
 *
 * ── Abdeckungs-Warnungen ──────────────────────────────────────────────────────
 *  Ein Pflicht-Block (requiredCount > 0) ohne eine einzige zugeordnete Person
 *  gilt als unbesetzt. CdS-/Kalte-Küche-Warnungen werden von aussen
 *  hereingereicht (computeCdsCheck / computeKitchenColdCheck).
 */

import type { Department } from '@/types/personnel';
import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import { activePositions, positionDisplayName } from '@/lib/position-utils';
import { shiftsForScope } from '@/lib/staffing-requirements-utils';
import { computeWeekCell } from '@/lib/staffing-week-utils';
import { nettoSegmentMinutes, nettoMinutesForSlots } from '@/lib/staffing-check-utils';
import {
  assignPlannedToShifts,
  comparisonStatus,
  type AssignedPerson,
  type ComparisonStatus,
  type PlannedEmployeeDay,
  type PlannedSlot,
} from '@/lib/staffing-comparison-utils';

/** Kopfzahl-Abgleich einer Position an einem Tag. */
export interface DayPositionHint {
  positionKey: string;
  positionName: string;
  /** Soll-Kopfzahl (Wochenzelle: explizit oder max(M, A) + UG-Zuschlag). */
  soll: number;
  /** Geplante PERSONEN (dedupliziert; jeder Einsatz genau einem Block zugeordnet). */
  planned: number;
  /** planned − soll. */
  diff: number;
  status: ComparisonStatus;
  /** true = Soll-Kopfzahl kommt aus dem expliziten Feld (meta.dayHeadcount). */
  headcountExplicit: boolean;
  /**
   * Die dieser Position an dem Tag zugeordneten PERSONEN (dedupliziert, Basis
   * der `planned`-Kopfzahl) inkl. aller zugeordneten Einsätze — Drill-down für
   * das Zell-Detail «Bedarf vs. Planung». Reihenfolge: Auftrittsreihenfolge.
   */
  assigned: AssignedPersonDetail[];
}

/** Person + alle ihre dieser Position zugeordneten Einsätze eines Tages. */
export interface AssignedPersonDetail {
  id: string;
  /** Alle zugeordneten Slots (Früh/Spät), chronologisch nach Startzeit. */
  slots: PlannedSlot[];
  /** Stärkste Zuordnungsstufe (regel > haupt > zweit > alias). */
  via: AssignedPerson['via'];
}

export interface DayPlanHints {
  /** Gibt es für (Saison × Wochentag) Bedarfs-Blöcke (nach Abteilungsfilter)? */
  hasRequirements: boolean;
  /** Positionen mit Bedarf, in kanonischer Positions-Reihenfolge (Orphans zuletzt). */
  positions: DayPositionHint[];
  totals: {
    /** Σ Soll-Kopfzahlen («Personal total» der Wochenmatrix-Spalte). */
    sollPersons: number;
    /**
     * Σ der Positions-Kopfzahlen (gleiche Einheit wie `sollPersons`): eine
     * Person, die an dem Tag zwei Positionen abdeckt (z.B. Splitschicht auf
     * Service + Bar), erfüllt zwei Positions-Bedarfe und zählt dann 2×.
     * Nicht zugeordnete Personen zählen hier NICHT (siehe unmatchedPlanned).
     */
    plannedPersons: number;
    personsDiff: number;
    personsStatus: ComparisonStatus;
    /** Σ Soll-Netto-Stunden (Blöcke × Anzahl, ArG-Pausenabzug), 0.1 h gerundet. */
    sollHours: number;
    /** Σ geplante Netto-Stunden aller produktiven Einsätze, 0.1 h gerundet. */
    plannedHours: number;
    hoursDiff: number;
    /** Kostenwarnung: geplante Netto-Stunden ÜBER dem Bedarf. */
    hoursOver: boolean;
  };
  /**
   * Abdeckungs-Warnungen (unbesetzte Pflicht-Blöcke + hereingereichte
   * CdS-/Kalte-Küche-Warnungen). NICHT sperrend — reine Transparenz.
   */
  warnings: string[];
  /** Produktiv geplante Personen ohne zugeordneten Bedarfs-Block (Hinweis). */
  unmatchedPlanned: number;
}

/** Kompakter Hinweis-Text je Position: «über Bedarf +X» / «unter Bedarf −X» / «im Bedarf». */
export function positionHintLabel(diff: number): string {
  if (diff === 0) return 'im Bedarf';
  return diff > 0 ? `über Bedarf +${diff}` : `unter Bedarf −${Math.abs(diff)}`;
}

/**
 * Berechnet den Live-Hinweis eines Tages: Kopfzahl je Position (Plan vs. Soll),
 * Tages-Summen (Personen + Netto-Stunden) und Abdeckungs-Warnungen.
 * `requirements` müssen die EFFEKTIVEN Bedarfe des Tages sein
 * (buildEffectiveRequirements — inkl. UG-Zuschlag), identisch zum Abgleich-Panel.
 */
export function computeDayPlanHints(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  plannedEmployees: PlannedEmployeeDay[];
  season: StaffingSeason;
  weekday: number;
  /** Rollen-Scoping: nur diese Abteilungen ausweisen (Orphans dann verborgen). */
  departments?: Department[];
  /** Dynamische Regel-Zuweisungen (Person-ID → bevorzugte Positions-Keys). */
  preferredKeysById?: Record<string, string[]>;
  /** Bereits berechnete Regel-Warnungen (CdS / Kalte Küche), werden angehängt. */
  ruleWarnings?: (string | null | undefined)[];
}): DayPlanHints {
  const { positions, requirements, plannedEmployees, season, weekday } = args;
  const deptFilter =
    args.departments && args.departments.length ? args.departments : undefined;

  const scope = shiftsForScope(requirements, season, weekday);
  const assignment = assignPlannedToShifts(scope, plannedEmployees, args.preferredKeysById);

  const active = activePositions(positions);
  const activeByKey = new Map(active.map((p) => [p.key, p]));

  // Blöcke + Scope-Indizes je Position einsammeln.
  const byKey = new Map<string, { blocks: StaffingRequirement[]; idx: number[] }>();
  scope.forEach((s, i) => {
    const e = byKey.get(s.positionKey);
    if (e) {
      e.blocks.push(s);
      e.idx.push(i);
    } else byKey.set(s.positionKey, { blocks: [s], idx: [i] });
  });

  // Abteilungsfilter: Position muss aktiv UND in den erlaubten Abteilungen sein;
  // Orphan-Slugs (keine aktive Position) nur ohne Filter (wie Abgleich-Panel).
  const includedKeys: string[] = [];
  for (const p of active) {
    if (!byKey.has(p.key)) continue;
    if (deptFilter && !deptFilter.includes(p.department)) continue;
    includedKeys.push(p.key);
  }
  if (!deptFilter) {
    for (const key of byKey.keys()) {
      if (!activeByKey.has(key)) includedKeys.push(key);
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;

  const rows: DayPositionHint[] = [];
  const warnings: string[] = [];
  const matchedIds = new Set<string>();
  let sollPersons = 0;
  let sollMinutes = 0;

  for (const key of includedKeys) {
    const entry = byKey.get(key)!;
    const cell = computeWeekCell(entry.blocks);
    const ids = new Set<string>();
    // Drill-down: Person → alle ihr zugeordneten Einsätze dieser Position.
    const VIA_RANK: Record<AssignedPerson['via'], number> = { regel: 0, haupt: 1, zweit: 2, alias: 3 };
    const detailById = new Map<string, AssignedPersonDetail>();
    for (const i of entry.idx) {
      for (const a of assignment.get(i) ?? []) {
        ids.add(a.id);
        matchedIds.add(a.id);
        const d = detailById.get(a.id);
        if (d) {
          d.slots.push(...a.slots);
          if (VIA_RANK[a.via] < VIA_RANK[d.via]) d.via = a.via;
        } else {
          detailById.set(a.id, { id: a.id, slots: [...a.slots], via: a.via });
        }
      }
    }
    const assigned = [...detailById.values()].map((d) => ({
      ...d,
      slots: [...d.slots].sort((x, y) => x.start.localeCompare(y.start)),
    }));
    const soll = cell.headcount;
    const planned = ids.size;
    const name = activeByKey.get(key)?.name ?? positionDisplayName(positions, key) ?? key;
    rows.push({
      positionKey: key,
      positionName: name,
      soll,
      planned,
      diff: planned - soll,
      status: comparisonStatus(soll, planned),
      headcountExplicit: cell.headcountExplicit,
      assigned,
    });
    sollPersons += soll;
    for (let j = 0; j < entry.blocks.length; j++) {
      const b = entry.blocks[j];
      sollMinutes += nettoSegmentMinutes(b.shiftStart, b.shiftEnd) * b.requiredCount;
      // Unbesetzter Pflicht-Block → Abdeckungs-Warnung (Schichtabdeckung).
      if (b.requiredCount > 0 && (assignment.get(entry.idx[j]) ?? []).length === 0) {
        warnings.push(`${name} ${b.shiftStart}–${b.shiftEnd} unbesetzt`);
      }
    }
  }

  for (const w of args.ruleWarnings ?? []) {
    if (w) warnings.push(w);
  }

  // Personen-Total in DERSELBEN Einheit wie das Soll (Σ Positions-Kopfzahlen):
  // sonst meldete die Pille Unterbesetzung, obwohl jede Positionszeile «im
  // Bedarf» ist (Person deckt zwei Positionen ab). Nicht zugeordnete Personen
  // erscheinen als unmatchedPlanned-Hinweis. STUNDEN zählen dagegen ALLE
  // produktiven Einsätze — Kosten fallen auch ohne Bedarfs-Match an.
  const plannedPersons = rows.reduce((sum, r) => sum + r.planned, 0);
  const plannedMinutes = plannedEmployees.reduce(
    (sum, e) => sum + nettoMinutesForSlots(e.slots),
    0,
  );
  const sollHours = round1(sollMinutes / 60);
  const plannedHours = round1(plannedMinutes / 60);
  const hoursDiff = round1(plannedHours - sollHours);
  const unmatchedPlanned = plannedEmployees.filter((e) => !matchedIds.has(e.id)).length;

  return {
    hasRequirements: rows.length > 0,
    positions: rows,
    totals: {
      sollPersons,
      plannedPersons,
      personsDiff: plannedPersons - sollPersons,
      personsStatus: comparisonStatus(sollPersons, plannedPersons),
      sollHours,
      plannedHours,
      hoursDiff,
      hoursOver: hoursDiff > 0,
    },
    warnings,
    unmatchedPlanned,
  };
}
