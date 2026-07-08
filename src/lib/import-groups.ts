/**
 * import-groups.ts — Reine Gruppierungs-Logik für das Import-Center (/import).
 * ============================================================================
 * UX-Vereinfachung Phase 2: Das Import-Center zeigt oben 4 Gruppen-Karten
 * (Umsatz/Z-Bericht · Reservationen · Arbeitszeiten/AZB · Tagesabschluss/
 * Kennzahlen) mit letztem Import, Status und einer „Import starten"-Aktion.
 *
 * KEIN React / Supabase / DOM hier. Es gibt bewusst KEINE eigenen Frische-
 * Regeln: Der Status jeder Quelle kommt 1:1 aus `computeSourceStatus`
 * (Import-Cockpit, Single Source of Truth), die Abbildung auf die 4 Ampel-
 * Stufen aus `startStatusFromCockpit` (Startseite). Gruppenstatus = schlechtester
 * Mitglieds-Status (action > due_soon > unknown > ok).
 */

import {
  COCKPIT_SOURCES,
  computeSourceStatus,
  formatCockpitDate,
  type CockpitSignal,
  type CockpitSourceDef,
  type CockpitSourceId,
} from './import-cockpit';
import {
  START_STATUS_LABEL,
  startStatusFromCockpit,
  type StartCardStatus,
} from './start-overview-utils';

// ─── Gruppen-Definitionen ────────────────────────────────────────────────────

export type ImportGroupId = 'umsatz' | 'reservationen' | 'arbeitszeiten' | 'tagesabschluss';

export interface ImportGroupDef {
  id: ImportGroupId;
  title: string;
  subtitle: string;
  /** Cockpit-Quellen der Gruppe (erste = Leitquelle für „Letzter Import"). */
  sourceIds: CockpitSourceId[];
  /** Zielroute für „Import starten" (externe Seite) … */
  startRoute?: string;
  /** … ODER Anker einer Inline-Sektion auf /import (z. B. Mirus/Ist-Stunden). */
  startAnchor?: string;
  startLabel: string;
}

/** Die 4 Importarten-Gruppen in Anzeige-Reihenfolge. */
export const IMPORT_GROUPS: ImportGroupDef[] = [
  {
    id: 'umsatz',
    title: 'Umsatz / Z-Bericht',
    subtitle: 'Gastronovi Z-Berichte und Tagesumsätze',
    sourceIds: ['zbericht', 'tagesumsatz'],
    startRoute: '/gastronovi-import',
    startLabel: 'Import starten',
  },
  {
    id: 'reservationen',
    title: 'Reservationen',
    subtitle: 'Foratable Reservationen und Gäste-CRM',
    sourceIds: ['reservationen', 'gaeste_crm'],
    startRoute: '/foratable-import',
    startLabel: 'Import starten',
  },
  {
    id: 'arbeitszeiten',
    title: 'Arbeitszeiten / AZB',
    subtitle: 'Ist-Stunden aus Mirus (Arbeitszeitblatt)',
    sourceIds: ['mirus'],
    startAnchor: 'ist-stunden',
    startLabel: 'Import starten',
  },
  {
    id: 'tagesabschluss',
    title: 'Tagesabschluss / Kennzahlen',
    subtitle: 'Adyen-Abgleich und Umsatzabstimmung',
    sourceIds: ['adyen', 'umsatzabstimmung'],
    startRoute: '/tagesabschluesse',
    startLabel: 'Öffnen',
  },
];

// ─── Ergebnis-Typen ──────────────────────────────────────────────────────────

export interface ImportGroupMember {
  sourceId: CockpitSourceId;
  label: string;
  status: StartCardStatus;
  statusLabel: string;
  /** Menschenlesbare Begründung aus computeSourceStatus. */
  detail: string;
  /** Zielroute der Quelle (Detail-/Importseite) oder null. */
  route: string | null;
}

export interface ImportGroupOverview {
  def: ImportGroupDef;
  /** Schlechtester Mitglieds-Status (action > due_soon > unknown > ok). */
  status: StartCardStatus;
  statusLabel: string;
  /** Begründung des schlechtesten Mitglieds („Quelle: Grund"). */
  detail: string;
  /**
   * Anzeige „Letzter Import": spätester Datenstand über alle Mitglieder
   * (dd.MM.yyyy) oder null, wenn noch nie importiert.
   */
  lastImportText: string | null;
  members: ImportGroupMember[];
}

// ─── Logik ───────────────────────────────────────────────────────────────────

const SEVERITY: Record<StartCardStatus, number> = {
  ok: 0,
  unknown: 1,
  due_soon: 2,
  action: 3,
};

function sourceDef(id: CockpitSourceId): CockpitSourceDef {
  const def = COCKPIT_SOURCES.find((s) => s.id === id);
  if (!def) throw new Error(`Unbekannte Cockpit-Quelle: ${id}`);
  return def;
}

/** Baut die 4 Gruppen-Übersichten aus den rohen Cockpit-Signalen. */
export function buildImportGroupOverviews(
  signals: Partial<Record<CockpitSourceId, CockpitSignal>>,
  now: Date,
): ImportGroupOverview[] {
  return IMPORT_GROUPS.map((group) => {
    const members: ImportGroupMember[] = group.sourceIds.map((sourceId) => {
      const def = sourceDef(sourceId);
      const signal = signals[sourceId] ?? { latestDataDate: null };
      const result = computeSourceStatus(def, signal, now);
      const status = startStatusFromCockpit(result.status);
      return {
        sourceId,
        label: def.label,
        status,
        statusLabel: START_STATUS_LABEL[status],
        detail: result.status === 'never' ? 'Noch nie importiert' : result.reason,
        route: def.route ?? null,
      };
    });

    const worst = members.reduce((a, b) => (SEVERITY[b.status] > SEVERITY[a.status] ? b : a));

    // „Letzter Import": spätester Datenstand über alle Mitglieder.
    const latestDates = group.sourceIds
      .map((id) => {
        const signal = signals[id] ?? { latestDataDate: null };
        return signal.dataUntil ?? signal.latestDataDate;
      })
      .filter((d): d is string => !!d)
      .sort();
    const latest = latestDates.at(-1) ?? null;

    return {
      def: group,
      status: worst.status,
      statusLabel: START_STATUS_LABEL[worst.status],
      detail: `${worst.label}: ${worst.detail}`,
      lastImportText: latest ? formatCockpitDate(latest) : null,
      members,
    };
  });
}
