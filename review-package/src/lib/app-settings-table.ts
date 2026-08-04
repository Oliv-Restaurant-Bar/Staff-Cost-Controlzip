/**
 * app-settings-table.ts
 * =====================
 * Typisierter Zugriff auf die Supabase-Tabelle `app_settings` (KV-Speicher).
 *
 * HINTERGRUND (Runde 2.8): Die Tabelle existiert in der Live-Datenbank,
 * fehlt aber in den auto-generierten Typen (src/integrations/supabase/types.ts,
 * "Do not edit"). Bisher wurde deshalb an jeder Zugriffsstelle
 * `(supabase as any)` gecastet bzw. der Aufruf erzeugte einen Typfehler.
 * Dieser Wrapper isoliert den technisch nötigen Cast an GENAU EINER Stelle
 * und gibt einen voll typisierten Query-Builder zurück — kein `any` erreicht
 * die Aufrufer.
 *
 * ABGRENZUNG:
 * - Reiner Infrastruktur-Wrapper: KEINE Domain-Validierung, KEINE Merge-,
 *   Tombstone-, Tenant- oder Offline-Logik (die bleibt in den Domänen bzw.
 *   in supabase-kv). Shape-Guards: kv-blob-utils (Supabase-frei).
 * - `value` ist bewusst `unknown` (JSONB kann Objekte, Arrays, Strings,
 *   Zahlen, null enthalten): kein falsches Sicherheitsversprechen, die
 *   fachliche Shape-Prüfung liegt bei den Domain-Guards (z. B. asRecordBlob).
 * - `updated_at` wird im Code nirgends gelesen/geschrieben und ist deshalb
 *   absichtlich NICHT typisiert (keine Annahmen über nicht genutzte Spalten).
 * - Tenant-Isolation läuft wie bisher über Key-Präfixe (`beaulieu:…`,
 *   `vj_daily:beaulieu:…`) — die Tabelle hat keine Tenant-Spalte.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

/** Eine Zeile der Tabelle app_settings. Insert ist identisch (kein Duplikat). */
export type AppSettingsRow = {
  key: string;
  value: unknown;
};

/** Eng begrenztes Schema NUR für app_settings (generierte Typen fehlen). */
type AppSettingsDatabase = {
  public: {
    Tables: {
      app_settings: {
        Row: AppSettingsRow;
        Insert: AppSettingsRow;
        Update: Partial<AppSettingsRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/**
 * Typisierter Query-Builder für app_settings.
 * Einziger erlaubter Ort für den Cast (Doppel-Cast nötig, weil die
 * generierten Database-Typen die Tabelle nicht kennen).
 */
export function appSettingsTable() {
  return (supabase as unknown as SupabaseClient<AppSettingsDatabase>)
    .from('app_settings');
}
