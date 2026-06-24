/**
 * Gäste-Duplikate — Supabase Datenschicht (Scan + sichere Zusammenführung)
 * ========================================================================
 * Liest Gästeprofile für den Duplikat-Scan und führt eine SICHERE, mandanten-
 * gescopte Zusammenführung mehrerer Duplikate in einen Master durch.
 *
 * SICHERHEIT / DATENINTEGRITÄT:
 *  - Jeder Lese-/Schreibzugriff ist mit `.eq('restaurant_id', restaurantId)`
 *    mandantengescopt (die RLS prüft nur „eingeloggt ja/nein", nicht pro Mandant).
 *  - PREFLIGHT: dupIds eindeutig & nicht leer, masterId ∉ dupIds, ALLE betroffenen
 *    Profile gehören zum Mandanten (sonst Abbruch ohne jede Schreiboperation).
 *  - REIHENFOLGE ohne Datenverlust: Reservationen ZUERST auf den Master umhängen
 *    (vor dem Löschen — `ON DELETE SET NULL` kann sie so nie verwaisen lassen),
 *    dann CRM zusammenführen, Master-Identität fill-empty ergänzen, Aggregate aus
 *    `reservation_records` NEU berechnen, prüfen dass keine Reservation mehr an
 *    einem Duplikat hängt, erst dann Duplikat-Profile löschen (CASCADE entfernt
 *    deren `guest_crm_profiles`).  Best-effort Audit-Log zum Schluss.
 *  - NICHT transaktional (wie `saveReservationImport`): Bricht es mittendrin ab,
 *    sind die Reservationen bereits am Master (kein Verlust); ein erneuter Lauf
 *    ist idempotent und repariert den Rest.
 *  - Das Import-Modul (`reservation-import-db.ts`) wird NICHT verändert; die
 *    Aggregat-Neuberechnung ist hier bewusst dupliziert (identische Semantik).
 *  - KEIN Logging von PII: das Audit-Log speichert nur IDs + Zähler.
 *
 * GRENZE (dokumentiert, akzeptiert für v1 = Telefon-Duplikate): fill-empty kann
 * pro Gast nur EINE E-Mail/Telefonnummer am Master halten. Ein späterer Import,
 * der ein gelöschtes Duplikat ausschliesslich über eine andere E-Mail wiederfindet,
 * könnte ein neues Profil anlegen. Eine robuste Langfristlösung wäre eine
 * Identitäts-Alias-Tabelle.
 *
 * `(supabase as any)` wie im übrigen CRM (die generierten Typen kennen diese
 * Tabellen nicht), siehe reservation-crm-db.ts / guest-crm-profile-db.ts.
 */

import { supabase } from '@/integrations/supabase/client';
import {
  groupDuplicatesByPhone,
  fillEmptyIdentity,
  mergeCrmProfiles,
  type DuplicateGuest,
  type DuplicateGroup,
  type GuestIdentityRow,
} from './guest-duplicates';
import {
  rowToCrmProfile, crmProfileToRow, EMPTY_CRM_PROFILE,
  type GuestCrmProfile, type GuestCrmProfileRow,
} from './guest-crm-profile';

// ── Scan ──────────────────────────────────────────────────────────────────────

const SCAN_COLS =
  'id, first_name, last_name, email, mobile, normalized_mobile, ' +
  'total_reservations, last_seen_at, created_at';

/**
 * Lädt alle Gästeprofile eines Mandanten (mandantengescopt) für den Duplikat-Scan.
 * Wirft bei Lesefehlern (kein stilles `[]` — sonst sähe man fälschlich „keine
 * Duplikate"). Paginiert (1000er-Seiten), um das Supabase-Zeilenlimit zu umgehen.
 */
export async function fetchGuestsForDuplicateScan(restaurantId: string): Promise<DuplicateGuest[]> {
  const out: DuplicateGuest[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from('guest_profiles')
      .select(SCAN_COLS)
      .eq('restaurant_id', restaurantId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`Gästeprofile konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        id: String(r.id),
        firstName: r.first_name ?? null,
        lastName: r.last_name ?? null,
        email: r.email ?? null,
        mobile: r.mobile ?? null,
        normalizedMobile: r.normalized_mobile ?? null,
        reservationCount: typeof r.total_reservations === 'number' ? r.total_reservations : 0,
        lastReservationDate: r.last_seen_at ? String(r.last_seen_at).slice(0, 10) : null,
        createdAt: r.created_at ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/** Lädt die Gäste eines Mandanten und gruppiert sie zu Telefon-Duplikatgruppen. */
export async function fetchDuplicateGroups(restaurantId: string): Promise<DuplicateGroup[]> {
  const guests = await fetchGuestsForDuplicateScan(restaurantId);
  return groupDuplicatesByPhone(guests);
}

// ── Tabellen-Setup prüfen (Audit-Log) ─────────────────────────────────────────

/** Prüft, ob die optionale Audit-Tabelle `guest_merge_log` existiert. */
export async function checkGuestMergeLogTableExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any).from('guest_merge_log').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────────

export interface MergeGuestsResult {
  error: string | null;
  reservationsMoved: number;
  crmMerged: boolean;
  mergedCount: number;
}

const IDENTITY_COLS =
  'id, restaurant_id, first_name, last_name, email, mobile, ' +
  'normalized_email, normalized_mobile, normalized_name';

const CRM_COLS =
  'guest_id, vip_manual, stammgast_manual, company_customer, newsletter_opt_in, ' +
  'blocked_guest, birthday, company, language, allergies, dietary_notes, ' +
  'favorite_table, favorite_area, favorite_wine, favorite_dish, crm_notes';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fail = (msg: string): MergeGuestsResult =>
  ({ error: msg, reservationsMoved: 0, crmMerged: false, mergedCount: 0 });

/**
 * Führt `dupIds` in `masterId` zusammen (mandantengescopt, recoverable).
 * Siehe Modul-Kopf für Reihenfolge & Garantien. Gibt einen Fehlertext zurück
 * (statt zu werfen) — die Seite zeigt ihn an.
 */
export async function mergeGuests(
  restaurantId: string,
  masterId: string,
  dupIdsRaw: string[],
): Promise<MergeGuestsResult> {
  // ── PREFLIGHT ──────────────────────────────────────────────────────────────
  if (!restaurantId) return fail('Kein Mandant gewählt.');
  if (!masterId) return fail('Kein Master-Gast gewählt.');
  const dupIds = [...new Set(dupIdsRaw.filter(Boolean))];
  if (dupIds.length === 0) return fail('Keine Duplikate zum Zusammenführen ausgewählt.');
  if (dupIds.includes(masterId)) return fail('Der Master-Gast darf nicht zugleich Duplikat sein.');

  const allIds = [masterId, ...dupIds];

  // ALLE betroffenen Profile mandantengescopt laden und Vollständigkeit prüfen.
  let rows: GuestIdentityRow[] = [];
  try {
    const { data, error } = await (supabase as any)
      .from('guest_profiles')
      .select(IDENTITY_COLS)
      .eq('restaurant_id', restaurantId)
      .in('id', allIds);
    if (error) return fail(`Gästeprofile konnten nicht geprüft werden: ${error.message ?? error}`);
    rows = (data ?? []) as GuestIdentityRow[];
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const foundIds = new Set(rows.map(r => r.id));
  const missing = allIds.filter(id => !foundIds.has(id));
  if (missing.length > 0) {
    return fail('Mindestens ein Gast gehört nicht zu diesem Mandanten oder existiert nicht — Zusammenführung abgebrochen.');
  }

  const master = rows.find(r => r.id === masterId)!;
  const dups = rows.filter(r => dupIds.includes(r.id));

  try {
    // ── 1. Reservationen ZUERST auf den Master umhängen (kein Verwaisen) ──────
    let reservationsMoved = 0;
    for (const part of chunk(dupIds, 100)) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .update({ guest_id: masterId, updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurantId)
        .in('guest_id', part)
        .select('id');
      if (error) return fail(`Reservationen konnten nicht umgehängt werden: ${error.message ?? error}`);
      reservationsMoved += (data ?? []).length;
    }

    // ── 2. CRM-Profile der Duplikate in den Master verschmelzen ───────────────
    let crmMerged = false;
    {
      const { data: crmData, error: crmErr } = await (supabase as any)
        .from('guest_crm_profiles')
        .select(CRM_COLS)
        .in('guest_id', allIds);
      if (crmErr) return fail(`CRM-Profile konnten nicht geladen werden: ${crmErr.message ?? crmErr}`);

      const crmById = new Map<string, GuestCrmProfile>();
      for (const row of (crmData ?? []) as GuestCrmProfileRow[]) {
        crmById.set(row.guest_id, rowToCrmProfile(row));
      }
      const dupProfiles = dupIds.map(id => crmById.get(id)).filter((p): p is GuestCrmProfile => !!p);

      if (dupProfiles.length > 0) {
        let merged = crmById.get(masterId) ?? { ...EMPTY_CRM_PROFILE };
        for (const dp of dupProfiles) merged = mergeCrmProfiles(merged, dp);
        const { error: upErr } = await (supabase as any)
          .from('guest_crm_profiles')
          .upsert(
            { ...crmProfileToRow(merged, masterId), updated_at: new Date().toISOString() },
            { onConflict: 'guest_id' },
          );
        if (upErr) return fail(`CRM-Profil des Masters konnte nicht gespeichert werden: ${upErr.message ?? upErr}`);
        crmMerged = true;
      }
    }

    // ── 3. Master-Identität fill-empty ergänzen (match_key bleibt unberührt) ──
    const patch = fillEmptyIdentity(master, dups);
    if (Object.keys(patch).length > 0) {
      const { error: idErr } = await (supabase as any)
        .from('guest_profiles')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurantId)
        .eq('id', masterId);
      if (idErr) return fail(`Master-Profil konnte nicht angereichert werden: ${idErr.message ?? idErr}`);
    }

    // ── 4. Master-Aggregate aus reservation_records NEU berechnen (nie summieren)
    const recompErr = await recomputeGuestAggregate(restaurantId, masterId);
    if (recompErr) return fail(`Gäste-Statistik konnte nicht aktualisiert werden: ${recompErr}`);

    // ── 5. Sicherheitscheck: keine Reservation darf mehr an einem Duplikat hängen
    for (const part of chunk(dupIds, 100)) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .in('guest_id', part)
        .limit(1);
      if (error) return fail(`Sicherheitsprüfung fehlgeschlagen: ${error.message ?? error}`);
      if ((data ?? []).length > 0) {
        return fail('Es hängen noch Reservationen an einem Duplikat — Löschen abgebrochen (Reservationen bleiben am Master erhalten).');
      }
    }

    // ── 6. Duplikat-Profile löschen (CASCADE entfernt deren guest_crm_profiles)
    let mergedCount = 0;
    for (const part of chunk(dupIds, 100)) {
      const { data, error } = await (supabase as any)
        .from('guest_profiles')
        .delete()
        .eq('restaurant_id', restaurantId)
        .in('id', part)
        .select('id');
      if (error) return fail(`Duplikate konnten nicht gelöscht werden: ${error.message ?? error}`);
      mergedCount += (data ?? []).length;
    }

    // ── 7. Best-effort Audit-Log (darf den Merge NIE zurückrollen) ────────────
    await logGuestMerge({ restaurantId, masterId, dupIds, reservationsMoved, crmMerged, mergedCount });

    return { error: null, reservationsMoved, crmMerged, mergedCount };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Berechnet total/persons/cancelled/completed sowie first/last_seen für EINEN
 * Gast aus `reservation_records` neu und schreibt sie zurück. Identische Semantik
 * wie `recomputeGuestAggregates` im Import-Modul (dort privat — bewusst dupliziert,
 * um das Import-Modul nicht zu verändern). Rückgabe: Fehlertext | null.
 */
async function recomputeGuestAggregate(restaurantId: string, guestId: string): Promise<string | null> {
  let total = 0, persons = 0, cancelled = 0, completed = 0;
  let first: string | null = null, last: string | null = null;
  const PAGE = 1000;
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('party_size, status_normalized, reservation_date')
        .eq('restaurant_id', restaurantId)
        .eq('guest_id', guestId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return error.message ?? String(error);
      if (!data || data.length === 0) break;
      for (const row of data as Array<{ party_size: number | null; status_normalized: string | null; reservation_date: string | null }>) {
        total++;
        persons += row.party_size ?? 0;
        if (row.status_normalized === 'cancelled') cancelled++;
        if (row.status_normalized === 'completed') completed++;
        if (row.reservation_date) {
          if (!first || row.reservation_date < first) first = row.reservation_date;
          if (!last || row.reservation_date > last) last = row.reservation_date;
        }
      }
      if (data.length < PAGE) break;
    }

    const { error } = await (supabase as any)
      .from('guest_profiles')
      .update({
        total_reservations: total,
        total_persons: persons,
        cancelled_reservations: cancelled,
        completed_reservations: completed,
        first_seen_at: first,
        last_seen_at: last,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', restaurantId)
      .eq('id', guestId);
    if (error) return error.message ?? String(error);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Schreibt einen Audit-Eintrag — BEST-EFFORT: jeder Fehler (Tabelle fehlt, RLS,
 * Netzwerk) wird verschluckt, damit ein Logging-Problem eine erfolgreiche
 * Zusammenführung nie zunichtemacht. Speichert NUR IDs + Zähler (keine PII).
 */
async function logGuestMerge(args: {
  restaurantId: string;
  masterId: string;
  dupIds: string[];
  reservationsMoved: number;
  crmMerged: boolean;
  mergedCount: number;
}): Promise<void> {
  try {
    let createdBy: string | null = null;
    try {
      const { data } = await supabase.auth.getSession();
      createdBy = data?.session?.user?.id ?? null;
    } catch { /* ignorieren — Operator-UUID ist optional */ }

    await (supabase as any).from('guest_merge_log').insert({
      restaurant_id: args.restaurantId,
      master_guest_id: args.masterId,
      merged_guest_ids: args.dupIds,
      merged_count: args.mergedCount,
      reservations_moved: args.reservationsMoved,
      crm_merged: args.crmMerged,
      created_by: createdBy,
    });
  } catch { /* best-effort: bewusst verschluckt */ }
}
