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
  /**
   * 'processing' = von einem Auto-Lauf geclaimt (Cross-Tab-Schutz; verwaiste
   * Claims sind nach 10 Min. wieder claimbar).
   * 'error' = Auto-Import fehlgeschlagen → manuelle Prüfung (nie Auto-Retry).
   */
  status: 'pending' | 'processing' | 'imported' | 'ignored' | 'error';
  claimed_at?: string | null;
  gn_import_id: string | null;
  received_at: string;
  imported_at: string | null;
  /** Fehlergrund bei status 'error' (Spalte kann pre-Migration fehlen). */
  error_message?: string | null;
}

const BUCKET = 'zbericht-inbox';

function isMissingSchema(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return ['42P01', 'PGRST205'].includes(err.code ?? '')
    && /zbericht_inbox/i.test(err.message ?? '');
}

/**
 * Offene E-Mail-Eingänge des Tenants (neueste zuerst):
 * 'pending' (Auto-Import verarbeitet sie) und 'error' (manuelle Prüfung).
 */
export async function loadPendingZberichtInbox(
  restaurantId: string,
): Promise<{ rows: ZberichtInboxRow[]; error: string | null; missingSchema: boolean }> {
  const { data, error } = await (supabase as any)
    .from('zbericht_inbox')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .in('status', ['pending', 'processing', 'error'])
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
 * Nur aus 'pending'/'error' heraus (kein Doppel-Übergang).
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
      error_message: null,
    })
    .eq('id', id)
    .in('status', ['pending', 'processing', 'error']);
  return { error: error?.message ?? null };
}

/** Eingang ignorieren (kein Import). Nur aus 'pending'/'processing'/'error' heraus. */
export async function markZberichtInboxIgnored(
  id: string,
): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({ status: 'ignored' })
    .eq('id', id)
    .in('status', ['pending', 'processing', 'error']);
  return { error: error?.message ?? null };
}

/**
 * Eingang als fehlgeschlagen markieren (status 'error' + Grund).
 * Aus 'pending'/'processing' heraus — 'error'-Zeilen werden NIE automatisch
 * erneut versucht, sondern manuell geprüft (Importieren/Ignorieren).
 */
export async function markZberichtInboxError(
  id: string,
  message: string,
): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({ status: 'error', error_message: message.slice(0, 500) })
    .eq('id', id)
    .in('status', ['pending', 'processing']);
  return { error: error?.message ?? null };
}

/** Zeitpunkt des letzten erfolgreichen Imports aus dem E-Mail-Eingang (oder null). */
export async function loadZberichtInboxLastImported(
  restaurantId: string,
): Promise<{ lastImportedAt: string | null; missingSchema: boolean }> {
  const { data, error } = await (supabase as any)
    .from('zbericht_inbox')
    .select('imported_at')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'imported')
    .not('imported_at', 'is', null)
    .order('imported_at', { ascending: false })
    .limit(1);
  if (error) return { lastImportedAt: null, missingSchema: isMissingSchema(error) };
  return { lastImportedAt: (data?.[0]?.imported_at as string | undefined) ?? null, missingSchema: false };
}

/** Nach so vielen Minuten gilt ein 'processing'-Claim als verwaist (Tab zu). */
export const ZBERICHT_CLAIM_STALE_MINUTES = 10;

/**
 * Atomarer Claim für den Auto-Import (Cross-Tab-Schutz): stellt die Zeile
 * bedingt auf 'processing' um. NUR wer die Zeile wirklich umstellt
 * (rows affected = 1), darf sie verarbeiten — der zweite Tab bekommt 0 Zeilen.
 * Claimbar: 'pending' sowie verwaiste 'processing' (claimed_at älter 10 Min.).
 */
export async function claimZberichtInboxRow(
  id: string,
): Promise<{ claimed: boolean; error: string | null }> {
  const staleBefore = new Date(Date.now() - ZBERICHT_CLAIM_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({ status: 'processing', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .or(`status.eq.pending,and(status.eq.processing,claimed_at.lt.${staleBefore})`)
    .select('id');
  if (error) return { claimed: false, error: error.message };
  return { claimed: (data ?? []).length === 1, error: null };
}

/**
 * Claim zurückgeben (transienter Fehler, z.B. Download): 'processing' → 'pending',
 * damit der nächste Lauf es erneut versucht.
 */
export async function releaseZberichtInboxClaim(
  id: string,
): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('zbericht_inbox')
    .update({ status: 'pending', claimed_at: null })
    .eq('id', id)
    .eq('status', 'processing');
  return { error: error?.message ?? null };
}
