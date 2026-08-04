/**
 * executive-warnings.ts — Warncenter-Ableitung für das Executive Cockpit.
 * =======================================================================
 * REINE Logik (kein React, kein IO): bündelt AUSSCHLIESSLICH BESTEHENDE
 * Status- und Schwellenregeln zu einer rot/orange-Liste — KEINE neuen
 * Schwellenwerte, KEINE neue Berechnung:
 *
 *  - Statuskarten (buildStartOverview): `action` = rot (identisch zur
 *    bestehenden Warnungs-Ableitung), `due_soon` = orange (bestehender
 *    „Bald fällig"-Status).
 *  - Import-Datenstand (summarizeTypeCompletion): `error` = rot,
 *    `open` = orange — dieselben Semantiken wie Datenstand/Checkliste.
 *  - Warenquote: zentrale Ampel `warenPctTone` (reporting-export).
 *  - Personalquote: zentrale Ampel `personalPctTone` (reporting-export) mit
 *    dem Budget-Ziel (personnelRatioTarget). OHNE Ziel entfällt die Regel —
 *    es wird KEIN Default-Ziel erfunden.
 *  - Budget-ABWEICHUNGEN (CHF/%) haben KEINE bestehende Warnschwelle im
 *    System — dafür wird bewusst KEINE Warnung erzeugt (nicht erfinden).
 *
 * Schwellen entscheiden IMMER auf dem Rohwert; gerundet wird nur der
 * Anzeigetext (Rundungsregel §2 replit.md). Fehlende Werte (null) lösen NIE
 * eine Warnung aus (fehlend ≠ 0).
 */

import type { StartCard } from './start-overview-utils';
import type { TypeCompletion } from './import-tasks-priority';
import { warenPctTone, personalPctTone } from './reporting-export';

export type ExecutiveWarnTone = 'critical' | 'warn';

export interface ExecutiveWarning {
  /** Stabile ID (z. B. `card-umsatz`, `import-zbericht`, `kpi-warenquote`). */
  id: string;
  tone: ExecutiveWarnTone;
  text: string;
  /** Zielroute („Öffnen") oder null, wenn keine sinnvolle Arbeitsfläche existiert. */
  route: string | null;
}

export interface ExecutiveWarningsInput {
  /** Heute-Statuskarten (buildStartOverview) — bestehende action/due_soon-Semantik. */
  cards: readonly StartCard[];
  /** Datenstand je Importtyp (summarizeTypeCompletion) — null, wenn Coverage fehlt. */
  typeCompletions: readonly TypeCompletion[] | null;
  /** Sichtbarer Teilfehler beim Laden der Import-Aufgaben (useStartOverview). */
  coverageError: string | null;
  /** Warenkostenquote IST (%) aus der Financial-Metrics-Registry — null = fehlt. */
  cogsRatioActual: number | null;
  /** Personalquote IST (%) aus der Financial-Metrics-Registry — null = fehlt. */
  personnelRatioActual: number | null;
  /** Ziel-Personalquote (%) aus dem Budget (useBudgetMonth) — null = kein Ziel. */
  personnelRatioTarget: number | null;
}

export interface ExecutiveWarningsResult {
  /** Rot zuerst, danach orange; innerhalb der Stufe in Eingangsreihenfolge. */
  warnings: ExecutiveWarning[];
  criticalCount: number;
  warnCount: number;
  /** true = keine einzige Warnung (grüner Zustand des Warncenters). */
  allGood: boolean;
}

const PCT = (v: number): string => `${v.toFixed(1)} %`;

export function buildExecutiveWarnings(input: ExecutiveWarningsInput): ExecutiveWarningsResult {
  const critical: ExecutiveWarning[] = [];
  const warn: ExecutiveWarning[] = [];

  // ── Statuskarten: action = rot (wie bestehende StartWarnings), due_soon = orange ──
  for (const card of input.cards) {
    if (card.status === 'action') {
      critical.push({
        id: `card-${card.id}`,
        tone: 'critical',
        text: `${card.title}: ${card.detail}`,
        route: card.route,
      });
    } else if (card.status === 'due_soon') {
      warn.push({
        id: `card-${card.id}`,
        tone: 'warn',
        text: `${card.title}: ${card.detail}`,
        route: card.route,
      });
    }
  }

  // ── Import-Datenstand: error = rot (→ Cockpit), open = orange (→ Import-Center) ──
  if (input.typeCompletions) {
    for (const tc of input.typeCompletions) {
      if (tc.status === 'error') {
        critical.push({
          id: `import-${tc.type}`,
          tone: 'critical',
          text: `${tc.label}: ${tc.detail ?? 'Fehler bei der Statusermittlung'}`,
          route: '/import-cockpit',
        });
      } else if (tc.status === 'open') {
        warn.push({
          id: `import-${tc.type}`,
          tone: 'warn',
          text: tc.detail ? `${tc.label}: ${tc.detail}` : `${tc.label}: offen`,
          route: '/import',
        });
      }
    }
  } else if (input.coverageError) {
    // Coverage selbst nicht ladbar → sichtbarer Fehler, nie stilles Grün.
    critical.push({
      id: 'coverage-error',
      tone: 'critical',
      text: `Import-Aufgaben: ${input.coverageError}`,
      route: '/import-cockpit',
    });
  }

  // ── Warenquote: zentrale Ampel warenPctTone (Rohwert entscheidet) ──────────
  if (input.cogsRatioActual !== null) {
    const tone = warenPctTone(input.cogsRatioActual);
    if (tone !== 'good') {
      const w: ExecutiveWarning = {
        id: 'kpi-warenquote',
        tone: tone === 'critical' ? 'critical' : 'warn',
        text: `Warenquote ${PCT(input.cogsRatioActual)} ${tone === 'critical' ? '— kritisch' : '— erhöht'}`,
        route: '/erfolgsrechnung',
      };
      (tone === 'critical' ? critical : warn).push(w);
    }
  }

  // ── Personalquote: zentrale Ampel personalPctTone mit Budget-Ziel ──────────
  if (input.personnelRatioActual !== null && input.personnelRatioTarget !== null) {
    const tone = personalPctTone(input.personnelRatioActual, input.personnelRatioTarget);
    if (tone !== 'good') {
      const w: ExecutiveWarning = {
        id: 'kpi-personalquote',
        tone: tone === 'critical' ? 'critical' : 'warn',
        text: `Personalquote ${PCT(input.personnelRatioActual)} (Ziel ${PCT(input.personnelRatioTarget)})`,
        route: '/personal-fix',
      };
      (tone === 'critical' ? critical : warn).push(w);
    }
  }

  const warnings = [...critical, ...warn];
  return {
    warnings,
    criticalCount: critical.length,
    warnCount: warn.length,
    allGood: warnings.length === 0,
  };
}
