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
