/**
 * Z-Bericht E-Mail-Eingang («zbericht-inbox») — DB-/Storage-Schicht
 * ==================================================================
 *
 * Per E-Mail eingegangene Z-Bericht-PDFs (Edge Function `gastronovi-inbound`)
 * liegen im privaten Bucket `zbericht-inbox` plus einer Zeile in
 * `zbericht_inbox` (status 'pending'). Diese Schicht liest die ausstehenden
 * Einträge, lädt das PDF per signierter URL und schreibt die Status-Übergänge
 * pending → imported | ignored.
 *
 * Der eigentliche Import läuft UNVERÄNDERT über den bestehenden Browser-Weg
 * (parseGnZBerichtPdf → saveGnImport) — hier gibt es keine zweite Import-Logik.
 *
 * Pre-Migration-Toleranz: Solange die Migration 20260723_zbericht_inbox noch
 * nicht eingespielt ist (42P01/PGRST205), liefert der Leser eine leere Liste
 * mit `missingSchema: true` — die Import-Seite blendet den Abschnitt dann aus.
 */

import { supabase } from '@/integrations/supabase/client';

export interface ZberichtInboxRow {
  id: string;
  restaurant_id: string;
  file_name: string;
  storage_path: string;
  file_hash: string;
  status: 'pending' | 'imported' | 'ignored';
  gn_import_id: string | null;
  received_at: string;
  imported_at: string | null;
}

const BUCKET = 'zbericht-inbox';

function isMissingSchema(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return ['42P01', 'PGRST205'].includes(err.code ?? '')
    && /zbericht_inbox/i.test(err.message ?? '');
}

/** Ausstehende E-Mail-Eingänge des Tenants (neueste zuerst). */
export async function loadPendingZberichtInbox(
  restaurantId: string,
): Promise<{ rows: ZberichtInboxRow[]; error: string | null; missingSchema: boolean }> {
  const { data, error } = await (supabase as any)
    .from('zbericht_inbox')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'pending')
    .order('received_at', { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingSchema(error)) return { rows: [], error: null, missingSchema: true };
    return { rows: [], error: error.message, missingSchema: false };
  }
  return { rows: (data ?? []) as ZberichtInboxRow[], error: null, missingSchema: false };
}

/** PDF eines Eingangs per signierter URL aus dem privaten Bucket laden. */
export async function downloadZberichtInboxPdf(
  storagePath: string,
): Promise<{ blob: Blob | null; error: string | null }> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) {
    return { blob: null, error: error?.message ?? 'Signierte URL konnte nicht erstellt werden' };
  }
  try {
    const res = await fetch(data.signedUrl);
    if (!res.ok) return { blob: null, error: `PDF-Download fehlgeschlagen (HTTP ${res.status})` };
    return { blob: await res.blob(), error: null };
  } catch (e) {
    return { blob: null, error: 'PDF-Download fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Eingang nach erfolgreichem Import abschliessen:
 * status 'imported', imported_at = jetzt, Verweis auf den gn_imports-Eintrag.
 * Nur aus 'pending' heraus (kein Doppel-Übergang).
 */
export async function markZberichtInboxImported(
  id: string,
  gnImportId: string,
): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({
      status: 'imported',
      imported_at: new Date().toISOString(),
      gn_import_id: gnImportId,
    })
    .eq('id', id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}

/** Eingang ignorieren (kein Import). Nur aus 'pending' heraus. */
export async function markZberichtInboxIgnored(
  id: string,
): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({ status: 'ignored' })
    .eq('id', id)
    .eq('status', 'pending');
  return { error: error?.message ?? null };
}
