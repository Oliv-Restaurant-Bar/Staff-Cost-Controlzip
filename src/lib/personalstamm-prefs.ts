/**
 * personalstamm-prefs — Ansichts-Präferenzen der Personalstamm-Seite (REINE LOGIK).
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistenz: NUR localStorage (tenant- UND benutzer-präfixierter Schlüssel,
 * IO im Hook usePersonalstammPrefs) — bewusst KEIN Supabase-KV: reine
 * Anzeige-Präferenz ohne Fachdaten, ein Verlust ist folgenlos (Defaults).
 * Gäste erhalten immer die Defaults und können nichts speichern.
 */

import { isEmployeeSortKey, type EmployeeSortKey } from './personalstamm-list';

export const PERSONALSTAMM_PREFS_KEY = 'personalstamm_prefs_v1';

export type PersonalstammView = 'liste' | 'kacheln';

export interface PersonalstammPrefs {
  /** Ansicht der Mitarbeiterliste — Default Liste. */
  view: PersonalstammView;
  /** Sortierung — Default Name A–Z. */
  sort: EmployeeSortKey;
}

export function defaultPersonalstammPrefs(): PersonalstammPrefs {
  return { view: 'liste', sort: 'name' };
}

function isView(v: unknown): v is PersonalstammView {
  return v === 'liste' || v === 'kacheln';
}

/** Rohdaten defensiv normalisieren: unbekannte Werte ⇒ Defaults. */
export function normalizePersonalstammPrefs(raw: unknown): PersonalstammPrefs {
  const defaults = defaultPersonalstammPrefs();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults;
  const o = raw as Record<string, unknown>;
  return {
    view: isView(o.view) ? o.view : defaults.view,
    sort: isEmployeeSortKey(o.sort) ? o.sort : defaults.sort,
  };
}
