/**
 * start-prefs.ts — Personalisierung der Startseite (REINE LOGIK).
 * ===============================================================
 * Benutzer-Einstellungen des Executive Cockpits:
 *  - kpiCards:     welche (max. 4) KPI-Karten oben erscheinen (Rest bleibt in
 *                  der Tabelle «Alle Management-KPIs» — KPIs nie löschen).
 *  - heuteWidgets: welche Widgets der Bereich «Heute» zeigt (Reihenfolge = Anzeige).
 *
 * Persistenz: NUR localStorage (tenant- UND benutzer-präfixierter Schlüssel,
 * IO im Hook useStartPrefs) — bewusst KEIN Supabase-KV: reine Anzeige-Präferenz
 * ohne Fachdaten, ein Verlust ist folgenlos (Defaults). Gäste erhalten immer
 * die Defaults und können nichts speichern.
 */

import { KPI_CATALOG, type KpiId } from './kpi-catalog';
import {
  DEFAULT_HEUTE_WIDGET_IDS,
  isHeuteWidgetId,
  type HeuteWidgetId,
} from './start-widgets';

export const START_PREFS_KEY = 'start_prefs_v1';
export const MAX_KPI_CARDS = 4;

export interface StartPrefs {
  kpiCards: KpiId[];
  heuteWidgets: HeuteWidgetId[];
}

/** Default-Karten = die istKarte-KPIs des Katalogs (bisheriges Verhalten). */
export function defaultKpiCards(): KpiId[] {
  return KPI_CATALOG.filter((d) => d.istKarte).map((d) => d.id);
}

export function defaultStartPrefs(): StartPrefs {
  return { kpiCards: defaultKpiCards(), heuteWidgets: [...DEFAULT_HEUTE_WIDGET_IDS] };
}

function isKpiId(v: unknown): v is KpiId {
  return typeof v === 'string' && KPI_CATALOG.some((d) => d.id === v);
}

/**
 * Rohdaten defensiv normalisieren: unbekannte IDs verwerfen, Duplikate
 * entfernen, Karten auf MAX_KPI_CARDS kappen; leere Auswahl ⇒ Defaults
 * (eine Startseite ganz ohne Karten/Widgets ist nie gewollt).
 */
export function normalizeStartPrefs(raw: unknown): StartPrefs {
  const defaults = defaultStartPrefs();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults;
  const o = raw as Record<string, unknown>;

  const kpiCards = Array.isArray(o.kpiCards)
    ? [...new Set(o.kpiCards.filter(isKpiId))].slice(0, MAX_KPI_CARDS)
    : [];
  const heuteWidgets = Array.isArray(o.heuteWidgets)
    ? [...new Set(o.heuteWidgets.filter(isHeuteWidgetId))]
    : [];

  return {
    kpiCards: kpiCards.length > 0 ? kpiCards : defaults.kpiCards,
    heuteWidgets: heuteWidgets.length > 0 ? heuteWidgets : defaults.heuteWidgets,
  };
}

/** Element in einer Liste um delta Positionen verschieben (immutable, Grenzen geklemmt). */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}
