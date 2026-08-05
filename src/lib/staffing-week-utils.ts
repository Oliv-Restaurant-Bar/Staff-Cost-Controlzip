/**
 * Wochenübersicht des Personalbedarfs («Ganze Woche»): Matrix Mo–So mit je
 * Mittag/Abend-Zelle pro Position, gruppiert nach Abteilung/Bereich, plus
 * Tages-Summen (Einsätze, Netto-Stunden, Umsatzbudget).
 *
 * Reine Funktionen ohne UI. Effektiver Bedarf pro Wochentag kommt aus
 * buildEffectiveRequirements (inkl. UG-Zuschlag Fr/Sa im Winter/UG-Profil;
 * Tages-Event-Flags gibt es hier nicht — die Übersicht zeigt den Regelbedarf).
 *
 * Klassifikation Mittag/Abend: Schichtbeginn vor 16:00 = Mittag, sonst Abend.
 */

import type { Position } from '@/types/positions';
import type { Department } from '@/types/personnel';
import type { StaffingRequirement, StaffingRequirementDraft, StaffingSeason } from '@/types/staffing';
import type { PositionArea } from '@/lib/position-utils';
import { timeToMinutes, buildRequirementMatrix, splitGroupOfMeta } from '@/lib/staffing-requirements-utils';

/**
 * Normalisiert Teildienst-Gruppen einer Zeilenmenge: `meta.splitGroup` ist nur
 * gültig, wenn die Gruppe aus GENAU zwei Blöcken besteht (einer Mittag, einer
 * Abend) mit gleicher Anzahl. Alle anderen Fälle (verwaiste Hälfte nach
 * Teil-Edit, 3+-Mitglieder, beide Blöcke in derselben Tageshälfte, ungleiche
 * Anzahl) verlieren die Gruppierung und werden als Einzelblöcke gespeichert —
 * so bleibt die Kopfzahl-Logik max(Mittag, Abend) konsistent zur Darstellung.
 */
export function normalizeSplitGroups<T extends { shiftStart: string; requiredCount: number; meta?: Record<string, unknown> | null }>(
  rows: T[],
): T[] {
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    const g = splitGroupOfMeta(r.meta ?? undefined);
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), r]);
  }
  const valid = new Set<string>();
  for (const [g, members] of byGroup) {
    if (members.length !== 2) continue;
    const [a, b] = members;
    if (isEveningShift(a.shiftStart) === isEveningShift(b.shiftStart)) continue;
    if (a.requiredCount !== b.requiredCount) continue;
    valid.add(g);
  }
  return rows.map((r) => {
    const g = splitGroupOfMeta(r.meta ?? undefined);
    if (!g || valid.has(g)) return r;
    const { splitGroup: _sg, ...rest } = r.meta ?? {};
    return { ...r, meta: rest };
  });
}
import { nettoSegmentMinutes } from '@/lib/staffing-check-utils';
import {
  buildEffectiveRequirements,
  cdsRuleForSeason,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';

/** Grenze Mittag/Abend (Minuten seit Mitternacht): Beginn < 16:00 = Mittag. */
export const EVENING_START_MINUTES = 16 * 60;

export function isEveningShift(shiftStart: string): boolean {
  const m = timeToMinutes(shiftStart);
  return !Number.isNaN(m) && m >= EVENING_START_MINUTES;
}

export interface WeekCell {
  /** Σ benötigte Personen der Mittag-Blöcke (Beginn < 16:00). */
  mittag: number;
  /** Σ benötigte Personen der Abend-Blöcke. */
  abend: number;
  /**
   * KOPFZAHL des Tages (führende Kennzahl): Anzahl PERSONEN — eine Person
   * zählt genau einmal, egal ob Mittag, Abend oder durchgehend. Explizit über
   * `meta.dayHeadcount` gesetzt, sonst automatisch = max(mittag, abend)
   * (durchgehende Person deckt beide Hälften ab). Blöcke werden NIE summiert.
   */
  headcount: number;
  /** true = Kopfzahl kommt aus dem expliziten Feld (meta.dayHeadcount). */
  headcountExplicit: boolean;
  /** Blöcke für Tooltip/Detail (Zeit + Anzahl; splitGroup = Teildienst-Paar). */
  shifts: { shiftStart: string; shiftEnd: string; requiredCount: number; splitGroup?: string | null }[];
}

/** Explizite Kopfzahl aus den meta-Feldern der Blöcke (erste gültige Zahl). */
export function explicitDayHeadcount(
  shifts: { meta?: Record<string, unknown> }[],
): number | null {
  for (const s of shifts) {
    const v = s.meta?.dayHeadcount;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/**
 * Baut die Tageszelle einer Position aus ihren Soll-Blöcken — die EINZIGE
 * Kopfzahl-Berechnung der App (Wochenmatrix, Cockpit-Stapel und
 * Dienstplan-Live-Hinweis nutzen alle diese Funktion, damit sich die
 * Ansichten nie widersprechen): explizites `meta.dayHeadcount` vor Automatik
 * max(Mittag, Abend); UG-Zuschlag (`meta.ugSurcharge`) wird IMMER addiert.
 */
export function computeWeekCell(
  shifts: { shiftStart: string; shiftEnd: string; requiredCount: number; meta?: Record<string, unknown> | null }[],
): WeekCell {
  const cell: WeekCell = { mittag: 0, abend: 0, headcount: 0, headcountExplicit: false, shifts: [] };
  for (const s of shifts) {
    const count = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
    if (isEveningShift(s.shiftStart)) cell.abend += count;
    else cell.mittag += count;
    cell.shifts.push({
      shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, requiredCount: count,
      splitGroup: splitGroupOfMeta(s.meta ?? undefined),
    });
  }
  const explicit = explicitDayHeadcount(shifts.map((s) => ({ meta: s.meta ?? undefined })));
  const ugExtra = shifts.reduce((a, s) => {
    const v = (s.meta as Record<string, unknown> | null | undefined)?.ugSurcharge;
    return a + (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);
  cell.headcount = explicit != null ? explicit + ugExtra : Math.max(cell.mittag, cell.abend);
  cell.headcountExplicit = explicit != null;
  return cell;
}

/**
 * Positions-Keys mit dynamischer Besetzungs-Regel (CdS-Prioritätenliste bzw.
 * Küchen-Regel). Diese Positionen erscheinen in der Wochenmatrix IMMER
 * (auch ohne hinterlegte Zeilen), damit sie manuell übersteuert werden können;
 * ohne Übersteuerung bleibt die Zelle leer («–», Regel greift).
 */
export const RULE_BASED_POSITION_KEYS: readonly string[] =
  ['chef_de_service', 'gastgeber_gf', 'kalte_kueche', 'sushi'];

/**
 * Indikativer REGELWERT (Kopfzahl) einer regelbasierten Position an einem
 * Wochentag — was die Regel ohne manuelle Übersteuerung ergeben würde.
 * null = Regel nicht konfiguriert. Die konkrete Tagesbesetzung hängt zusätzlich
 * vom Dienstplan ab (z.B. schwacher Küchentag), daher «wäre». Reine Anzeige-
 * Hilfe (Tooltip/Hinweis) — fliesst NIE in Totale/Bedarfsstunden ein.
 */
export function ruleFallbackHeadcount(
  positionKey: string,
  weekday: number,
  config: StaffingProfilesConfig,
  /** Angezeigtes Profil — Regel wird pro Profil aufgelöst (Default 'standard'). */
  season: StaffingSeason | string = 'standard',
): number | null {
  const rule = cdsRuleForSeason(config, season);
  switch (positionKey) {
    case 'chef_de_service':
      return rule.cdsPriority.length > 0 ? 1 : null;
    case 'gastgeber_gf':
      if (rule.cdsPriority.length < 2) return null;
      return rule.gastgeberWeekdays.includes(weekday) ? 1 : 0;
    case 'kalte_kueche':
    case 'sushi':
      return config.kitchenCold ? 1 : null;
    default:
      return null;
  }
}

export interface WeekPositionRow {
  positionKey: string;
  positionName: string;
  /** ISO-Wochentag (1=Mo … 7=So) → Zelle. Tage ohne Bedarf fehlen. */
  cells: Record<number, WeekCell>;
}

export interface WeekAreaGroup {
  area: PositionArea | null;
  positions: WeekPositionRow[];
}

export interface WeekDepartmentGroup {
  department: Department;
  areas: WeekAreaGroup[];
}

export interface WeekDayTotals {
  /** Σ KOPFZAHLEN (Personen, nicht Einsätze) über alle Positionen des Tages. */
  persons: number;
  /** Σ Netto-Stunden (ARG-Pausenabzug) über alle Soll-Blöcke des Tages. */
  nettoHours: number;
  /** Umsatzbudget des Wochentags (CHF) oder null wenn nicht konfiguriert. */
  budget: number | null;
}

export interface WeekOverview {
  groups: WeekDepartmentGroup[];
  /** ISO-Wochentag → Summen. Für alle 7 Tage vorhanden. */
  totals: Record<number, WeekDayTotals>;
  /** True, wenn irgendein Tag Bedarf hat. */
  hasAny: boolean;
}

/**
 * Drafts für das Zellen-Speichern der Wochenmatrix (Position × Wochentag):
 * part 'day' ersetzt ALLE Blöcke der Position an diesem Tag (Standard des
 * Tages-Editors); 'mittag'/'abend' ersetzen nur die jeweilige Tageshälfte und
 * erhalten die andere Hälfte verbatim. Alle übrigen Zeilen des Scopes —
 * andere Positionen und Orphans — werden VERBATIM aus `existing` übernommen.
 * `existing` muss der FRISCHE Scope-Stand (season × weekday) sein, damit
 * parallel geänderte Zeilen nicht mit einem veralteten Snapshot überschrieben
 * werden.
 */
export function buildCellSaveDrafts(args: {
  /** Frische RAW-Zeilen des Scopes (shiftsForScope(fresh, season, weekday)). */
  existing: StaffingRequirement[];
  season: StaffingSeason;
  weekday: number;
  positionKey: string;
  /** 'day' ersetzt ALLE Blöcke der Position an diesem Tag. */
  part: 'mittag' | 'abend' | 'day';
  /** Neue Blöcke der bearbeiteten Tageshälfte (bzw. des ganzen Tages). */
  partDrafts: { id?: string; shiftStart: string; shiftEnd: string; requiredCount: number; splitGroup?: string | null }[];
  /**
   * Explizite KOPFZAHL des Tages (meta.dayHeadcount auf allen Blöcken der
   * Position): number = setzen, null = löschen (Automatik max(M, A)),
   * undefined = unverändert lassen.
   */
  dayHeadcount?: number | null;
}): (StaffingRequirementDraft & { id?: string })[] {
  const { existing, season, weekday, positionKey, part, partDrafts, dayHeadcount } = args;
  // meta der Position ggf. mit expliziter Kopfzahl überschreiben/bereinigen.
  const applyHead = (meta: Record<string, unknown>): Record<string, unknown> => {
    if (dayHeadcount === undefined) return meta;
    const { dayHeadcount: _drop, ...rest } = meta ?? {};
    return dayHeadcount === null ? rest : { ...rest, dayHeadcount };
  };
  const out: (StaffingRequirementDraft & { id?: string })[] = [];
  const isPart = (start: string) => part === 'day' || (part === 'abend') === isEveningShift(start);
  // Andere Positionen + Orphans + andere Tageshälfte: verbatim erhalten.
  for (const o of existing) {
    if (o.positionKey === positionKey && isPart(o.shiftStart)) continue; // wird ersetzt
    out.push({
      id: o.id, scopeType: o.scopeType, season: o.season, weekday: o.weekday,
      scopeRef: o.scopeRef, positionKey: o.positionKey, shiftStart: o.shiftStart,
      shiftEnd: o.shiftEnd, requiredCount: o.requiredCount, sortOrder: o.sortOrder,
      meta: o.positionKey === positionKey ? applyHead(o.meta) : o.meta,
    });
  }
  // Bearbeitete Tageshälfte: neue Blöcke (meta vorhandener Zeilen per id erhalten).
  const metaById = new Map(existing.filter((r) => r.positionKey === positionKey).map((r) => [r.id, r.meta]));
  const baseSort = existing.filter((r) => r.positionKey === positionKey && !isPart(r.shiftStart)).length;
  partDrafts.forEach((s, index) => {
    // Teildienst-Gruppierung (meta.splitGroup) aus dem Draft übernehmen:
    // gesetzt → schreiben, nicht gesetzt → aus bestehendem meta entfernen.
    const baseMeta = (s.id ? metaById.get(s.id) : undefined) ?? {};
    const { splitGroup: _sg, ...restMeta } = baseMeta;
    const meta = s.splitGroup ? { ...restMeta, splitGroup: s.splitGroup } : restMeta;
    out.push({
      id: s.id,
      scopeType: 'weekly',
      season,
      weekday,
      scopeRef: null,
      positionKey,
      shiftStart: s.shiftStart,
      shiftEnd: s.shiftEnd,
      requiredCount: s.requiredCount,
      sortOrder: baseSort + index,
      meta: applyHead(meta),
    });
  });
  // Teildienst-Integrität der BEARBEITETEN Position sichern: verwaiste
  // Hälften (z. B. nach Teil-Edit einer Tageshälfte) und ungültige Gruppen
  // verlieren die splitGroup; andere Positionen/Orphans bleiben verbatim.
  const mine = normalizeSplitGroups(out.filter((r) => r.positionKey === positionKey));
  let i = 0;
  return out.map((r) => (r.positionKey === positionKey ? mine[i++] : r));
}

/**
 * Baut die Wochenübersicht für ein Profil (Saison). Positionszeilen erscheinen,
 * sobald mindestens EIN Wochentag Bedarf für die Position hat.
 */
export function buildWeekOverview(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  season: StaffingSeason;
}): WeekOverview {
  const { positions, requirements, config, season } = args;

  const totals: Record<number, WeekDayTotals> = {};
  // Position → Wochentag → Zelle (aus den Tagesmatrizen eingesammelt).
  const cellsByPosition = new Map<string, Record<number, WeekCell>>();
  // Skelett (Abteilung/Bereich/Reihenfolge) vom ersten Tag mit Struktur.
  let skeleton: ReturnType<typeof buildRequirementMatrix> | null = null;

  for (let weekday = 1; weekday <= 7; weekday++) {
    const effective = buildEffectiveRequirements({
      requirements,
      config,
      season,
      weekday,
      eventOpen: false,
    });
    const matrix = buildRequirementMatrix(positions, effective, season, weekday);
    if (!skeleton) skeleton = matrix;

    let persons = 0;
    let nettoMinutes = 0;
    for (const dept of matrix) {
      for (const area of dept.areas) {
        for (const pr of area.positions) {
          if (pr.shifts.length === 0) continue;
          // Kopfzahl + Blöcke über die zentrale Zell-Berechnung (SSOT).
          const cell = computeWeekCell(pr.shifts);
          for (const s of pr.shifts) {
            const count = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
            nettoMinutes += nettoSegmentMinutes(s.shiftStart, s.shiftEnd) * count;
          }
          persons += cell.headcount;
          const byDay = cellsByPosition.get(pr.position.key) ?? {};
          byDay[weekday] = cell;
          cellsByPosition.set(pr.position.key, byDay);
        }
      }
    }

    const budgetRaw = config.revenueBudgetByWeekday?.[weekday];
    totals[weekday] = {
      persons,
      nettoHours: Math.round((nettoMinutes / 60) * 10) / 10,
      budget: typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : null,
    };
  }

  // Zeilen in kanonischer Reihenfolge des Skeletts; nur Positionen mit Bedarf.
  const groups: WeekDepartmentGroup[] = [];
  for (const dept of skeleton ?? []) {
    const areas: WeekAreaGroup[] = [];
    for (const area of dept.areas) {
      const rows: WeekPositionRow[] = [];
      for (const pr of area.positions) {
        const cells = cellsByPosition.get(pr.position.key);
        // Regelbasierte Positionen erscheinen IMMER (leere Zellen = Regel
        // greift, per Klick übersteuerbar); andere nur mit Bedarf.
        if ((!cells || Object.keys(cells).length === 0)
          && !RULE_BASED_POSITION_KEYS.includes(pr.position.key)) continue;
        rows.push({ positionKey: pr.position.key, positionName: pr.position.name, cells: cells ?? {} });
      }
      if (rows.length > 0) areas.push({ area: area.area, positions: rows });
    }
    if (areas.length > 0) groups.push({ department: dept.department, areas });
  }

  const hasAny = groups.length > 0;
  return { groups, totals, hasAny };
}
