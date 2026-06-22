/**
 * Gäste-CRM Phase 1 — Supabase Datenschicht für manuelle CRM-Profile
 * ===================================================================
 * Liest/schreibt die Tabelle `guest_crm_profiles` (1:1 zu `guest_profiles`).
 *
 *  - MANDANTEN-CHECK ist PFLICHT (Lesen UND Schreiben): da die RLS nur „eingeloggt
 *    ja/nein" prüft (nicht pro Mandant), wird vor jedem Zugriff über
 *    `fetchGuestById(restaurantId, guestId)` verifiziert, dass der Gast zum
 *    aktuellen Mandanten gehört.  Sonst: kein Zugriff (Lesen → null, Schreiben → Fehler).
 *  - KEIN stilles Fallback: Schreibfehler werfen eine sichtbare Exception
 *    (Projektregel Datenintegrität).
 *  - KEIN Logging von PII.
 *  - Trennung: berührt NUR `guest_crm_profiles`; guest_profiles/Import/
 *    guest_statistics bleiben unverändert.
 *
 * `(supabase as any)` wie im übrigen CRM (die generierten Typen kennen die
 * Tabelle nicht), siehe reservation-crm-db.ts.
 */

import { supabase } from '@/integrations/supabase/client';
import { fetchGuestById } from './reservation-crm-db';
import {
  rowToCrmProfile, crmProfileToRow,
  type GuestCrmProfile, type GuestCrmProfileRow,
} from './guest-crm-profile';

const CRM_COLS =
  'guest_id, vip_manual, stammgast_manual, company_customer, newsletter_opt_in, ' +
  'blocked_guest, birthday, company, language, allergies, dietary_notes, ' +
  'favorite_table, favorite_area, favorite_wine, favorite_dish, crm_notes, ' +
  'created_at, updated_at';

/** Maximale Gast-IDs pro `.in(...)`-Abfrage (gegen zu lange Anfrage-URLs). */
const CRM_BULK_CHUNK = 200;

/**
 * Lädt das manuelle CRM-Profil eines Gastes (mandantengeprüft).
 *  - Gast gehört nicht zum Mandanten / existiert nicht → null.
 *  - Gast existiert, aber (noch) kein CRM-Profil       → null (Aufrufer zeigt leeres Formular).
 *  - Lesefehler der CRM-Tabelle                         → Exception (sichtbar machen).
 */
export async function fetchGuestCrmProfile(
  restaurantId: string,
  guestId: string,
): Promise<GuestCrmProfile | null> {
  const guest = await fetchGuestById(restaurantId, guestId);
  if (!guest) return null; // Datenschutz: fremder/unbekannter Gast → kein Zugriff

  const { data, error } = await (supabase as any)
    .from('guest_crm_profiles')
    .select(CRM_COLS)
    .eq('guest_id', guestId)
    .maybeSingle();

  if (error) throw new Error(`CRM-Profil konnte nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
  if (!data) return null; // noch kein Profil angelegt
  return rowToCrmProfile(data as GuestCrmProfileRow);
}

/**
 * Lädt die manuellen CRM-Profile für eine Liste von Gast-IDs in einem Rutsch
 * (für die Gästeliste/Kampagnen).  Rückgabe als Map `guest_id → GuestCrmProfile`;
 * Gäste ohne Profil fehlen schlicht in der Map (Aufrufer behandelt das als „leer").
 *
 * MANDANTEN-SICHERHEIT: `guest_crm_profiles` hat KEINE `restaurant_id` (Mandant
 * hängt am Eltern-Gast).  Diese Funktion filtert daher NICHT selbst nach Mandant,
 * sondern verlässt sich darauf, dass der Aufrufer ausschliesslich bereits
 * mandantengescopte Gast-IDs übergibt (z. B. aus `fetchGuestProfiles(tenantId)`).
 *
 * KEIN stilles Fallback: Ein Lesefehler wirft — der Aufrufer (Seite) entscheidet,
 * ob er das sichtbar als Warnung anzeigt und die Liste ohne CRM-Daten rendert.
 */
export async function fetchGuestCrmProfilesByIds(
  guestIds: string[],
): Promise<Map<string, GuestCrmProfile>> {
  const result = new Map<string, GuestCrmProfile>();
  const unique = Array.from(new Set(guestIds.filter(Boolean)));
  if (unique.length === 0) return result;

  for (let i = 0; i < unique.length; i += CRM_BULK_CHUNK) {
    const chunk = unique.slice(i, i + CRM_BULK_CHUNK);
    const { data, error } = await (supabase as any)
      .from('guest_crm_profiles')
      .select(CRM_COLS)
      .in('guest_id', chunk);

    if (error) {
      throw new Error(`CRM-Profile konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    for (const row of (data ?? []) as GuestCrmProfileRow[]) {
      result.set(row.guest_id, rowToCrmProfile(row));
    }
  }
  return result;
}

/**
 * Legt das CRM-Profil eines Gastes an oder aktualisiert es (atomarer UPSERT auf
 * `guest_id`), mandantengeprüft.  Setzt `updated_at`.  Wirft bei fehlendem
 * Zugriff oder Schreibfehler — KEIN stilles Fallback.
 */
export async function upsertGuestCrmProfile(
  restaurantId: string,
  guestId: string,
  profile: GuestCrmProfile,
): Promise<GuestCrmProfile> {
  const guest = await fetchGuestById(restaurantId, guestId);
  if (!guest) throw new Error('Gast nicht gefunden oder kein Zugriff für diesen Mandanten.');

  const row = {
    ...crmProfileToRow(profile, guestId),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await (supabase as any)
    .from('guest_crm_profiles')
    .upsert(row, { onConflict: 'guest_id' })
    .select(CRM_COLS)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`CRM-Profil konnte nicht gespeichert werden: ${error?.message ?? 'unbekannter Fehler'}`);
  }
  return rowToCrmProfile(data as GuestCrmProfileRow);
}
