/**
 * Personaleintritt — DB-Schicht (einziger Supabase-IO-Punkt des Moduls)
 * =====================================================================
 * Tabellen: personaleintritt, lgav_mindestlohn (Migration 20260724).
 *
 * PRE-MIGRATION-TOLERANT: Die Migration wird manuell im SQL-Editor ausgeführt.
 * Solange die Tabellen fehlen (42P01/PGRST205/schema cache), liefern die Reader
 * `preMigration: true` — die UI zeigt dann einen klaren Hinweis statt zu crashen.
 * Echte Fehler bleiben SICHTBAR (error-Feld), nie stiller Fallback.
 *
 * Tenant-Isolation: JEDE Query filtert .eq('restaurant_id', tenantId);
 * Updates prüfen die betroffene Zeilenzahl (0 Zeilen = Fehler, RLS-Muster).
 */

import { supabase } from '@/integrations/supabase/client';
import type { TenantId } from '@/contexts/TenantContext';
import type { MindestlohnEintrag } from './lohn';
import {
  LEGACY_BETRIEB_ID_PREFIX,
  type BetriebRecord,
  type WochenstundenModell,
} from './betriebs-config';
import type {
  Lohnklasse,
  MaDaten,
  PersonaleintrittRecord,
  PersonaleintrittStatus,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

/** Fehlt die Tabelle noch? (Migration 20260724 nicht ausgeführt) */
function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const msg = err.message ?? '';
  return err.code === '42P01' || err.code === 'PGRST205' ||
    /relation .* does not exist|schema cache/i.test(msg);
}

export interface DbResult<T> {
  data: T | null;
  /** true = Tabelle fehlt noch (Migration nicht ausgeführt) — kein echter Fehler. */
  preMigration: boolean;
  /** Sichtbarer Fehlertext (nie stiller Fallback). */
  error: string | null;
}

// ─── Row-Mapping ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: any): PersonaleintrittRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    status: row.status as PersonaleintrittStatus,
    vertragstyp: row.vertragstyp ?? undefined,
    betrieb: row.betrieb ?? undefined,
    // Spalte aus Migration 20260724f — pre-migration-tolerant (select('*')):
    betriebId: row.betrieb_id ?? undefined,
    funktion: row.funktion ?? undefined,
    eintritt: row.eintritt ?? undefined,
    pensumProzent: row.pensum_prozent != null ? Number(row.pensum_prozent) : undefined,
    probezeitTage: row.probezeit_tage != null ? Number(row.probezeit_tage) : undefined,
    vertragsdauer: row.vertragsdauer ?? undefined,
    befristetBis: row.befristet_bis ?? undefined,
    lohnModus: row.lohn_modus ?? undefined,
    lohnklasse: (row.lohnklasse as Lohnklasse) ?? undefined,
    grundlohn: row.grundlohn != null ? Number(row.grundlohn) : undefined,
    // Spalten aus Migration 20260724b — pre-migration-tolerant (select('*')):
    grundlohnInkl13: row.grundlohn_inkl13 ?? undefined,
    bewilligungErforderlich: row.bewilligung_erforderlich ?? undefined,
    // Spalten aus Migration 20260724c (Bewilligungs-Mehrfachauswahl):
    bewilligungAusweisF: row.bewilligung_ausweis_f ?? undefined,
    bewilligungAusweisS: row.bewilligung_ausweis_s ?? undefined,
    bewilligungArbeitsbewilligung: row.bewilligung_arbeitsbewilligung ?? undefined,
    behoerdeMeldungAm: row.behoerde_meldung_am ?? undefined,
    behoerdeMeldungVon: row.behoerde_meldung_von ?? undefined,
    zielTotal: row.ziel_total != null ? Number(row.ziel_total) : undefined,
    lohnBerechnet: row.lohn_berechnet != null ? Number(row.lohn_berechnet) : undefined,
    lohnEinheit: row.lohn_einheit ?? undefined,
    einfuehrungszeit: row.einfuehrungszeit ?? false,
    maDaten: (row.ma_daten ?? {}) as MaDaten,
    inviteExpires: row.invite_expires ?? undefined,
    eingeladenAm: row.eingeladen_am ?? undefined,
    ausgefuelltAm: row.ausgefuellt_am ?? undefined,
    pdfPath: row.pdf_path ?? undefined,
    pdfFlatPath: row.pdf_flat_path ?? undefined,
    mirusExportPath: row.mirus_export_path ?? undefined,
    // Spalte aus Migration 20260724d — pre-migration-tolerant (select('*')):
    semFormularPath: row.sem_formular_path ?? undefined,
    // Spalte aus Migration 20260724e — pre-migration-tolerant (select('*')):
    dossierPath: row.dossier_path ?? undefined,
    skribbleRequestId: row.skribble_request_id ?? undefined,
    signedPdfPath: row.signed_pdf_path ?? undefined,
    personalstammId: row.personalstamm_id ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

export interface PersonaleintrittPatch {
  status?: PersonaleintrittStatus;
  vertragstyp?: string;
  betrieb?: string;
  /** Migration 20260724f — nur setzen, wenn die Tabelle betriebe existiert (42703-tolerant). */
  betriebId?: string | null;
  funktion?: string;
  eintritt?: string | null;
  pensumProzent?: number | null;
  probezeitTage?: number;
  vertragsdauer?: string;
  befristetBis?: string | null;
  lohnModus?: string;
  lohnklasse?: string | null;
  grundlohn?: number | null;
  /** Migration 20260724b — nur setzen, wenn fachlich relevant (42703-tolerant). */
  grundlohnInkl13?: boolean;
  bewilligungErforderlich?: boolean;
  /** Migration 20260724c — nur setzen, wenn fachlich relevant (42703-tolerant). */
  bewilligungAusweisF?: boolean;
  bewilligungAusweisS?: boolean;
  bewilligungArbeitsbewilligung?: boolean;
  behoerdeMeldungAm?: string | null;
  behoerdeMeldungVon?: string | null;
  zielTotal?: number | null;
  lohnBerechnet?: number | null;
  lohnEinheit?: string | null;
  einfuehrungszeit?: boolean;
  maDaten?: MaDaten;
  inviteTokenHash?: string | null;
  inviteExpires?: string | null;
  eingeladenAm?: string | null;
  ausgefuelltAm?: string | null;
  pdfPath?: string | null;
  pdfFlatPath?: string | null;
  mirusExportPath?: string | null;
  /** Migration 20260724d — nur setzen, wenn fachlich relevant (42703-tolerant). */
  semFormularPath?: string | null;
  /** Migration 20260724e — nur setzen, wenn fachlich relevant (42703-tolerant). */
  dossierPath?: string | null;
  skribbleRequestId?: string | null;
  personalstammId?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchToRow(patch: PersonaleintrittPatch): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = {};
  const map: [keyof PersonaleintrittPatch, string][] = [
    ['status', 'status'], ['vertragstyp', 'vertragstyp'], ['betrieb', 'betrieb'],
    ['betriebId', 'betrieb_id'],
    ['funktion', 'funktion'], ['eintritt', 'eintritt'], ['pensumProzent', 'pensum_prozent'],
    ['probezeitTage', 'probezeit_tage'], ['vertragsdauer', 'vertragsdauer'],
    ['befristetBis', 'befristet_bis'], ['lohnModus', 'lohn_modus'], ['lohnklasse', 'lohnklasse'],
    ['grundlohn', 'grundlohn'], ['grundlohnInkl13', 'grundlohn_inkl13'],
    ['bewilligungErforderlich', 'bewilligung_erforderlich'],
    ['bewilligungAusweisF', 'bewilligung_ausweis_f'],
    ['bewilligungAusweisS', 'bewilligung_ausweis_s'],
    ['bewilligungArbeitsbewilligung', 'bewilligung_arbeitsbewilligung'],
    ['behoerdeMeldungAm', 'behoerde_meldung_am'], ['behoerdeMeldungVon', 'behoerde_meldung_von'],
    ['zielTotal', 'ziel_total'], ['lohnBerechnet', 'lohn_berechnet'],
    ['lohnEinheit', 'lohn_einheit'], ['einfuehrungszeit', 'einfuehrungszeit'],
    ['maDaten', 'ma_daten'], ['inviteTokenHash', 'invite_token_hash'],
    ['inviteExpires', 'invite_expires'], ['eingeladenAm', 'eingeladen_am'],
    ['ausgefuelltAm', 'ausgefuellt_am'], ['pdfPath', 'pdf_path'], ['pdfFlatPath', 'pdf_flat_path'],
    ['mirusExportPath', 'mirus_export_path'], ['semFormularPath', 'sem_formular_path'],
    ['dossierPath', 'dossier_path'],
    ['skribbleRequestId', 'skribble_request_id'],
    ['personalstammId', 'personalstamm_id'],
  ];
  for (const [key, col] of map) {
    if (key in patch) row[col] = patch[key];
  }
  return row;
}

// ─── lgav_mindestlohn ─────────────────────────────────────────────────────────

export async function loadLgavMindestloehne(): Promise<DbResult<MindestlohnEintrag[]>> {
  // select('*') statt Spaltenliste: die Stunden-Spalten (Migration 20260724c)
  // fehlen pre-migration — explizite Listen würden mit 42703 scheitern
  // (Muster «Pre-Migration-tolerante Queries»). Fehlende Spalten ⇒ undefined.
  const { data, error } = await sb
    .from('lgav_mindestlohn')
    .select('*')
    .order('jahr', { ascending: false });
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: MindestlohnEintrag[] = (data ?? []).map((r: any) => ({
    jahr: Number(r.jahr),
    klasse: r.klasse as Lohnklasse,
    monatX13: Number(r.monat_x13),
    stunde42: r.stunde_42 != null ? Number(r.stunde_42) : null,
    stunde435: r.stunde_43_5 != null ? Number(r.stunde_43_5) : null,
    stunde45: r.stunde_45 != null ? Number(r.stunde_45) : null,
  }));
  return { data: rows, preMigration: false, error: null };
}

export async function upsertLgavMindestlohn(eintrag: MindestlohnEintrag): Promise<DbResult<true>> {
  const { error } = await sb
    .from('lgav_mindestlohn')
    .upsert({
      jahr: eintrag.jahr,
      klasse: eintrag.klasse,
      monat_x13: eintrag.monatX13,
      // Stunden-Spalten nur mitschicken, wenn gesetzt (pre-20260724c-tolerant):
      ...(eintrag.stunde42 != null ? { stunde_42: eintrag.stunde42 } : {}),
      ...(eintrag.stunde435 != null ? { stunde_43_5: eintrag.stunde435 } : {}),
      ...(eintrag.stunde45 != null ? { stunde_45: eintrag.stunde45 } : {}),
    });
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  return { data: true, preMigration: false, error: null };
}

// ─── betriebe (Migration 20260724f) ──────────────────────────────────────────

/** CHECK-Constraint garantiert 42/43.5/45 — Anomalie fällt sichtbar auf 42 zurück. */
function toWochenstundenModell(v: unknown): WochenstundenModell {
  const n = Number(v);
  return n === 45 ? 45 : n === 43.5 ? 43.5 : 42;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function betriebRowToRecord(row: any): BetriebRecord {
  return {
    id: row.id,
    name: row.name,
    anzeigename: row.anzeigename ?? undefined,
    strasse: row.strasse ?? undefined,
    plzOrt: row.plz_ort ?? undefined,
    uid: row.uid ?? undefined,
    land: row.land ?? 'CH',
    wochenstundenModell: toWochenstundenModell(row.wochenstunden_modell),
    kontaktpersonName: row.kontaktperson_name ?? undefined,
    kontaktpersonTel: row.kontaktperson_tel ?? undefined,
    kontaktpersonEmail: row.kontaktperson_email ?? undefined,
    behoerdeEmail: row.behoerde_email ?? undefined,
    sccIntegration: row.scc_integration ?? false,
    sccTenant: row.scc_tenant === 'oliv' || row.scc_tenant === 'beaulieu' ? row.scc_tenant : undefined,
    logo: row.logo ?? undefined,
    aktiv: row.aktiv ?? true,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

export interface BetriebPatch {
  name?: string;
  anzeigename?: string | null;
  strasse?: string | null;
  plzOrt?: string | null;
  uid?: string | null;
  land?: string;
  wochenstundenModell?: WochenstundenModell;
  kontaktpersonName?: string | null;
  kontaktpersonTel?: string | null;
  kontaktpersonEmail?: string | null;
  behoerdeEmail?: string | null;
  sccIntegration?: boolean;
  sccTenant?: TenantId | null;
  logo?: string | null;
  /** Kein Hard-Delete (FK-Ziel): Deaktivieren statt löschen. */
  aktiv?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function betriebPatchToRow(patch: BetriebPatch): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = {};
  const map: [keyof BetriebPatch, string][] = [
    ['name', 'name'], ['anzeigename', 'anzeigename'], ['strasse', 'strasse'],
    ['plzOrt', 'plz_ort'], ['uid', 'uid'], ['land', 'land'],
    ['wochenstundenModell', 'wochenstunden_modell'],
    ['kontaktpersonName', 'kontaktperson_name'], ['kontaktpersonTel', 'kontaktperson_tel'],
    ['kontaktpersonEmail', 'kontaktperson_email'], ['behoerdeEmail', 'behoerde_email'],
    ['sccIntegration', 'scc_integration'], ['sccTenant', 'scc_tenant'],
    ['logo', 'logo'], ['aktiv', 'aktiv'],
  ];
  for (const [key, col] of map) {
    if (key in patch) row[col] = patch[key];
  }
  return row;
}

/**
 * Lädt ALLE Betriebe (aktive und deaktivierte; Filterung ist Sache der UI —
 * Detailseiten müssen auch deaktivierte Betriebe eines Alt-Datensatzes noch
 * auflösen können). preMigration=true, solange die Tabelle fehlt — der
 * Aufrufer fällt dann auf betriebFromLegacyConfig zurück.
 */
export async function loadBetriebe(): Promise<DbResult<BetriebRecord[]>> {
  const { data, error } = await sb
    .from('betriebe')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  return { data: (data ?? []).map(betriebRowToRecord), preMigration: false, error: null };
}

export async function createBetrieb(patch: BetriebPatch): Promise<DbResult<BetriebRecord>> {
  if (!patch.name?.trim()) {
    return { data: null, preMigration: false, error: 'Firmenname ist erforderlich.' };
  }
  const { data, error } = await sb
    .from('betriebe')
    .insert(betriebPatchToRow(patch))
    .select()
    .single();
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  return { data: betriebRowToRecord(data), preMigration: false, error: null };
}

export async function updateBetrieb(id: string, patch: BetriebPatch): Promise<DbResult<BetriebRecord>> {
  // Synthetische Fallback-IDs (pre-migration) dürfen NIE in die DB gelangen:
  if (id.startsWith(LEGACY_BETRIEB_ID_PREFIX)) {
    return {
      data: null, preMigration: false,
      error: 'Dieser Betrieb stammt aus dem Übergangs-Fallback und kann erst nach der Migration 20260724f bearbeitet werden.',
    };
  }
  if ('name' in patch && !patch.name?.trim()) {
    return { data: null, preMigration: false, error: 'Firmenname darf nicht leer sein.' };
  }
  const { data, error } = await sb
    .from('betriebe')
    .update({ ...betriebPatchToRow(patch), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select();
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  if (!data || data.length === 0) {
    return { data: null, preMigration: false, error: 'Betrieb nicht gefunden — keine Zeile aktualisiert.' };
  }
  return { data: betriebRowToRecord(data[0]), preMigration: false, error: null };
}

// ─── personaleintritt ─────────────────────────────────────────────────────────

export async function loadPersonaleintritte(tenantId: TenantId): Promise<DbResult<PersonaleintrittRecord[]>> {
  const { data, error } = await sb
    .from('personaleintritt')
    .select('*')
    .eq('restaurant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  return { data: (data ?? []).map(rowToRecord), preMigration: false, error: null };
}

export async function loadPersonaleintritt(id: string, tenantId: TenantId): Promise<DbResult<PersonaleintrittRecord>> {
  const { data, error } = await sb
    .from('personaleintritt')
    .select('*')
    .eq('id', id)
    .eq('restaurant_id', tenantId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  if (!data) return { data: null, preMigration: false, error: 'Datensatz nicht gefunden.' };
  return { data: rowToRecord(data), preMigration: false, error: null };
}

export async function createPersonaleintritt(
  tenantId: TenantId,
  patch: PersonaleintrittPatch,
  createdBy?: string,
): Promise<DbResult<PersonaleintrittRecord>> {
  const row = { ...patchToRow(patch), restaurant_id: tenantId, created_by: createdBy ?? null };
  const { data, error } = await sb
    .from('personaleintritt')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  return { data: rowToRecord(data), preMigration: false, error: null };
}

/**
 * Update mit Tenant-Scope: .eq(id) UND .eq(restaurant_id); 0 betroffene Zeilen
 * = Fehler (RLS-Muster — nie still nichts schreiben).
 * `expectedStatus` erlaubt Status-Übergänge nur aus einem definierten Zustand.
 */
export async function updatePersonaleintritt(
  id: string,
  tenantId: TenantId,
  patch: PersonaleintrittPatch,
  expectedStatus?: PersonaleintrittStatus | PersonaleintrittStatus[],
): Promise<DbResult<PersonaleintrittRecord>> {
  let query = sb
    .from('personaleintritt')
    .update({ ...patchToRow(patch), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('restaurant_id', tenantId);
  if (expectedStatus) {
    query = Array.isArray(expectedStatus)
      ? query.in('status', expectedStatus)
      : query.eq('status', expectedStatus);
  }
  const { data, error } = await query.select('*');
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  if (!data || data.length === 0) {
    return {
      data: null, preMigration: false,
      error: expectedStatus
        ? 'Statuswechsel nicht möglich — der Datensatz wurde zwischenzeitlich geändert.'
        : 'Datensatz nicht gefunden (0 Zeilen aktualisiert).',
    };
  }
  return { data: rowToRecord(data[0]), preMigration: false, error: null };
}

/** Entwurf endgültig löschen (nur Status entwurf/abgebrochen — sonst Status setzen). */
export async function deletePersonaleintritt(id: string, tenantId: TenantId): Promise<DbResult<true>> {
  const { data, error } = await sb
    .from('personaleintritt')
    .delete()
    .eq('id', id)
    .eq('restaurant_id', tenantId)
    .in('status', ['entwurf', 'abgebrochen'])
    .select('id');
  if (error) {
    if (isMissingTableError(error)) return { data: null, preMigration: true, error: null };
    return { data: null, preMigration: false, error: error.message ?? 'Unbekannter Fehler' };
  }
  if (!data || data.length === 0) {
    return { data: null, preMigration: false, error: 'Nur Entwürfe oder abgebrochene Einträge können gelöscht werden.' };
  }
  return { data: true, preMigration: false, error: null };
}

// ─── Storage (Bucket mitarbeiter-dokumente) ──────────────────────────────────

export const DOKUMENTE_BUCKET = 'mitarbeiter-dokumente';

/** Signierte URL für ein Dokument (1 h gültig). */
export async function getDokumentUrl(path: string): Promise<string | null> {
  const { data, error } = await sb.storage.from(DOKUMENTE_BUCKET).createSignedUrl(path, 3600);
  if (error) { console.error('[personaleintritt-db] getDokumentUrl:', error); return null; }
  return data?.signedUrl ?? null;
}

/** Datei aus dem Bucket laden (z. B. PDF-Vorlage fürs client-seitige Ausfüllen). */
export async function downloadDokument(path: string): Promise<Blob | null> {
  const { data, error } = await sb.storage.from(DOKUMENTE_BUCKET).download(path);
  if (error) { console.error('[personaleintritt-db] downloadDokument:', error); return null; }
  return data ?? null;
}

/** Datei in den Bucket laden (Backoffice: Vertrag/Vorlagen; upsert=überschreiben). */
export async function uploadDokument(path: string, file: Blob, contentType: string): Promise<string | null> {
  const { error } = await sb.storage.from(DOKUMENTE_BUCKET).upload(path, file, { contentType, upsert: true });
  if (error) {
    console.error('[personaleintritt-db] uploadDokument:', error);
    return null;
  }
  return path;
}
