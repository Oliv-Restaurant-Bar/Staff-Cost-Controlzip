/**
 * Foratable Gästeexport — Supabase-Orchestrierung (Vorschau & Commit)
 * ===================================================================
 * Verbindet den reinen Parser/Plan (`foratable-guest-import*.ts`) mit Supabase.
 *
 * STRIKTE MODUL-GRENZEN (Datenwelten getrennt halten):
 *   Importiert AUSSCHLIESSLICH Lese-/Mapper-Helfer für Gäste & CRM —
 *   `fetchGuestProfiles` (read-only Matching), `fetchGuestCrmProfilesByIds`,
 *   `crmProfileToRow`, sowie `supabase`.  KEINE Importe aus Reservations-Import-,
 *   Segment- oder Dashboard-Logik.  Es wird NUR `guest_crm_profiles` geschrieben;
 *   guest_profiles/reservation_records/guest_statistics bleiben unberührt.
 *
 * MANDANTEN-SICHERHEIT: `guest_crm_profiles` hat KEINE `restaurant_id`.  Der
 * gesamte Plan wird bei JEDEM Aufruf frisch aus `fetchGuestProfiles(tenantId)`
 * aufgebaut; geschrieben werden ausschliesslich Gast-IDs, die in genau diesem
 * (mandantengescopten) Set vorkommen.  Der Commit traut KEINEM vorberechneten
 * React-State, sondern plant neu (autoritativ) und mischt gegen den aktuellen
 * CRM-Stand — so kann zwischen Vorschau und Commit manuell Gepflegtes nie
 * überschrieben werden.
 *
 * KEIN stilles Fallback: Schreibfehler werfen (Projektregel Datenintegrität).
 * KEIN Logging von PII.
 */

import { supabase } from '@/integrations/supabase/client';
import { fetchGuestProfilesStrict } from './reservation-crm-db';
import { fetchGuestCrmProfilesByIds } from './guest-crm-profile-db';
import { crmProfileToRow } from './guest-crm-profile';
import {
  buildGuestIndex, matchGuestRow, planGuestImport,
  type MatchableGuest, type GuestImportPlanEntry,
} from './foratable-guest-import';
import type { ForatableGuestParseResult } from './foratable-guest-import-parser';

/** Ergebnis/Projektion einer Anreicherung (nur Zahlen — keine PII). */
export interface ForatableGuestImportOutcome {
  rowsRead: number;       // gelesene Datenzeilen (inkl. fehlerhafter)
  matchedGuests: number;  // eindeutig zugeordnete Gäste
  created: number;        // neu angelegte CRM-Profile
  updated: number;        // ergänzte bestehende CRM-Profile
  conflicts: number;      // beibehaltene Werte (Importwert wich ab)
  unassignable: number;   // nicht (eindeutig) zuordenbare Zeilen
  errorRows: number;      // fehlerhafte Zeilen (Parse-Fehler)
}

/** Schreib-Batchgrösse (gegen zu grosse Anfragen). */
const WRITE_CHUNK = 200;

interface LoadedPlan {
  plan: GuestImportPlanEntry[];
  rowsRead: number;
  matchedGuests: number;
  conflicts: number;
  unassignable: number;
  errorRows: number;
  tenantGuestIds: Set<string>;
}

/**
 * Lädt die mandantengescopten Gäste + deren CRM-Profile und baut den Import-Plan
 * frisch auf.  Wird von Vorschau UND Commit verwendet (Commit ist damit
 * autoritativ).
 */
async function loadAndPlan(tenantId: string, parseResult: ForatableGuestParseResult): Promise<LoadedPlan> {
  const guests = await fetchGuestProfilesStrict(tenantId);
  const matchable: MatchableGuest[] = guests.map((g) => ({
    id: g.id,
    email: g.email ?? null,
    mobile: g.mobile ?? null,
    firstName: g.first_name ?? null,
    lastName: g.last_name ?? null,
  }));
  const tenantGuestIds = new Set(matchable.map((g) => g.id));
  const index = buildGuestIndex(matchable);

  // getroffene Gast-IDs vorab ermitteln → nur deren CRM-Profile laden
  const matchedIds = new Set<string>();
  for (const row of parseResult.rows) {
    const m = matchGuestRow(row, index);
    if (m.guestId) matchedIds.add(m.guestId);
  }
  const existingCrm = await fetchGuestCrmProfilesByIds([...matchedIds]);

  const { plan, stats } = planGuestImport(parseResult.rows, index, existingCrm);

  return {
    plan,
    rowsRead: parseResult.stats.rowCount,
    matchedGuests: stats.matchedGuests,
    conflicts: stats.conflicts,
    unassignable: stats.unassignable,
    errorRows: parseResult.errors.filter((e) => e.rowNumber > 0).length,
    tenantGuestIds,
  };
}

/**
 * Vorschau: berechnet die voraussichtliche Wirkung (created/updated/conflicts/…)
 * OHNE zu schreiben.
 */
export async function previewForatableGuestImport(
  tenantId: string,
  parseResult: ForatableGuestParseResult,
): Promise<ForatableGuestImportOutcome> {
  const loaded = await loadAndPlan(tenantId, parseResult);
  const safePlan = loaded.plan.filter((e) => loaded.tenantGuestIds.has(e.guestId));
  return {
    rowsRead: loaded.rowsRead,
    matchedGuests: loaded.matchedGuests,
    created: safePlan.filter((e) => e.isCreate).length,
    updated: safePlan.filter((e) => !e.isCreate).length,
    conflicts: loaded.conflicts,
    unassignable: loaded.unassignable,
    errorRows: loaded.errorRows,
  };
}

/**
 * Commit: baut den Plan autoritativ neu auf und schreibt die angereicherten
 * CRM-Profile per Bulk-Upsert (`onConflict: 'guest_id'`).  Es werden nur Gäste
 * geschrieben, die im frisch geladenen Mandanten-Set enthalten sind.
 * Wirft bei Schreibfehler (kein stilles Fallback).
 */
export async function commitForatableGuestImport(
  tenantId: string,
  parseResult: ForatableGuestParseResult,
): Promise<ForatableGuestImportOutcome> {
  const loaded = await loadAndPlan(tenantId, parseResult);
  const safePlan = loaded.plan.filter((e) => loaded.tenantGuestIds.has(e.guestId));

  const now = new Date().toISOString();
  const rows = safePlan.map((e) => ({ ...crmProfileToRow(e.profile, e.guestId), updated_at: now }));

  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const { error } = await (supabase as any)
      .from('guest_crm_profiles')
      .upsert(chunk, { onConflict: 'guest_id' });
    if (error) {
      throw new Error(`CRM-Profile konnten nicht gespeichert werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
  }

  return {
    rowsRead: loaded.rowsRead,
    matchedGuests: loaded.matchedGuests,
    created: safePlan.filter((e) => e.isCreate).length,
    updated: safePlan.filter((e) => !e.isCreate).length,
    conflicts: loaded.conflicts,
    unassignable: loaded.unassignable,
    errorRows: loaded.errorRows,
  };
}
