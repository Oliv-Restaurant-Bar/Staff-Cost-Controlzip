/**
 * Foratable Gästeexport — Matching, Merge & Import-Plan (rein, ohne Supabase/DOM)
 * ==============================================================================
 * Bildet eine geparste Gästezeile auf CRM-Zusatzdaten ab, ordnet sie einem
 * bestehenden Gast zu (E-Mail → Telefon → Name) und plant die Anreicherung der
 * `guest_crm_profiles`.
 *
 * GRUNDSÄTZE (siehe Aufgabenstellung):
 *  - Nur LEERE bestehende CRM-Felder werden gefüllt.  Ein bereits gesetzter Wert
 *    wird NIE überschrieben — weicht der Importwert ab, gilt das als Konflikt
 *    (bestehender Wert bleibt, Konflikt wird gezählt).
 *  - Leere/„keine Info"-Importwerte überschreiben nichts.
 *  - Booleans tragen nur einen positiven Wert (true) bei; „Nein"/leer = keine
 *    Info → ein manuell gesetztes true wird nie überschrieben.
 *  - Unsichere (mehrdeutige) Treffer werden NICHT automatisch übernommen,
 *    sondern als „nicht zuordenbar" gezählt.
 *  - Dieses Modul berührt ausschliesslich CRM-Felder; Reservationen, Besuche
 *    und Segmente bleiben unangetastet.  KEIN Logging von PII.
 */

import type { ParsedGuestRow } from './foratable-guest-import-parser';
import { strictNameKey } from './foratable-guest-import-parser';
import { normalizeEmail, normalizeMobile } from './reservation-import-parser';
import {
  EMPTY_CRM_PROFILE, normalizeCrmProfile, normalizeText,
  CRM_BOOLEAN_KEYS, CRM_TEXT_KEYS,
  type GuestCrmProfile,
} from './guest-crm-profile';

// ── Gast-Index für das Matching ──────────────────────────────────────────────

/** Minimaler Gastdatensatz für das Matching (entkoppelt von DB-Typen). */
export interface MatchableGuest {
  id: string;
  email: string | null;
  mobile: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface GuestMatchIndex {
  email: Map<string, string>;
  mobile: Map<string, string>;
  name: Map<string, string>;
  emailAmbiguous: Set<string>;
  mobileAmbiguous: Set<string>;
  nameAmbiguous: Set<string>;
}

function addKey(map: Map<string, string>, ambiguous: Set<string>, key: string | null, guestId: string): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, guestId);
  } else if (existing !== guestId) {
    ambiguous.add(key); // derselbe Schlüssel zeigt auf verschiedene Gäste → unsicher
  }
}

/** Baut je Identitätsfeld einen eigenen Index inkl. Mehrdeutigkeits-Markierung. */
export function buildGuestIndex(guests: MatchableGuest[]): GuestMatchIndex {
  const idx: GuestMatchIndex = {
    email: new Map(), mobile: new Map(), name: new Map(),
    emailAmbiguous: new Set(), mobileAmbiguous: new Set(), nameAmbiguous: new Set(),
  };
  for (const g of guests) {
    addKey(idx.email, idx.emailAmbiguous, normalizeEmail(g.email ?? undefined), g.id);
    addKey(idx.mobile, idx.mobileAmbiguous, normalizeMobile(g.mobile ?? undefined), g.id);
    addKey(idx.name, idx.nameAmbiguous, strictNameKey(g.firstName, g.lastName), g.id);
  }
  return idx;
}

export type UnmatchReason = 'no-key' | 'not-found' | 'ambiguous';

export interface MatchResult {
  guestId: string | null;
  matchedBy: 'email' | 'mobile' | 'name' | null;
  reason: UnmatchReason | null; // gesetzt, wenn guestId === null
}

/**
 * Ordnet eine Zeile einem Gast zu.  Die Identitäts-Stufe richtet sich nach den
 * vorhandenen Daten der Zeile (E-Mail → Telefon → Name); nur diese eine Stufe
 * wird ausgewertet.  Mehrdeutig → kein automatischer Treffer.
 */
export function matchGuestRow(row: ParsedGuestRow, index: GuestMatchIndex): MatchResult {
  if (row.normEmail) {
    if (index.emailAmbiguous.has(row.normEmail)) return { guestId: null, matchedBy: null, reason: 'ambiguous' };
    const id = index.email.get(row.normEmail);
    return id ? { guestId: id, matchedBy: 'email', reason: null }
              : { guestId: null, matchedBy: null, reason: 'not-found' };
  }
  if (row.normMobile) {
    if (index.mobileAmbiguous.has(row.normMobile)) return { guestId: null, matchedBy: null, reason: 'ambiguous' };
    const id = index.mobile.get(row.normMobile);
    return id ? { guestId: id, matchedBy: 'mobile', reason: null }
              : { guestId: null, matchedBy: null, reason: 'not-found' };
  }
  if (row.normName) {
    if (index.nameAmbiguous.has(row.normName)) return { guestId: null, matchedBy: null, reason: 'ambiguous' };
    const id = index.name.get(row.normName);
    return id ? { guestId: id, matchedBy: 'name', reason: null }
              : { guestId: null, matchedBy: null, reason: 'not-found' };
  }
  return { guestId: null, matchedBy: null, reason: 'no-key' };
}

// ── Zeile → eingehende CRM-Felder ────────────────────────────────────────────

/**
 * Teil-Profil mit ausschliesslich „Information tragenden" Feldern:
 *  - Booleans nur, wenn positiv (true).
 *  - Textfelder nur, wenn nicht leer.
 * Alles andere bleibt undefined und wird beim Merge ignoriert.
 */
export type IncomingCrm = Partial<GuestCrmProfile>;

/** Kombiniert Gästeinfo/Speisen/Labels zu einem CRM-Notiztext (oder null). */
export function combineNotes(row: ParsedGuestRow): string | null {
  const parts = [row.guestInfo, row.dishes, row.labels]
    .map((p) => normalizeText(p))
    .filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Bildet eine Zeile auf die zu übernehmenden CRM-Zusatzfelder ab. */
export function rowToIncomingCrm(row: ParsedGuestRow): IncomingCrm {
  const inc: IncomingCrm = {};
  if (row.vip) inc.vipManual = true;
  if (row.newsletter) inc.newsletterOptIn = true;
  if (row.blacklist) inc.blockedGuest = true;
  if (row.birthday) inc.birthday = row.birthday;

  const company = normalizeText(row.company);
  if (company) inc.company = company;

  const favTable = normalizeText(row.favoriteTable);
  if (favTable) inc.favoriteTable = favTable;

  const notes = combineNotes(row);
  if (notes) inc.crmNotes = notes;

  return inc;
}

// ── Merge: nur leere Felder füllen, nie überschreiben ────────────────────────

export interface MergeResult {
  merged: GuestCrmProfile;
  changedFields: string[];
  conflictFields: string[];
}

/**
 * Mischt eingehende CRM-Felder in ein bestehendes Profil:
 *  - Boolean: nur `true` aus `incoming` kann ein `false` auf `true` heben.
 *  - Text: leeres Zielfeld wird gefüllt; gefülltes Zielfeld bleibt — weicht der
 *    Importwert ab, wird es als Konflikt gezählt (bestehender Wert bleibt).
 */
export function mergeCrmProfile(existing: GuestCrmProfile, incoming: IncomingCrm): MergeResult {
  const merged = normalizeCrmProfile(existing);
  const changedFields: string[] = [];
  const conflictFields: string[] = [];

  for (const key of CRM_BOOLEAN_KEYS) {
    if (incoming[key] === true && merged[key] !== true) {
      (merged[key] as boolean) = true;
      changedFields.push(key);
    }
  }

  for (const key of CRM_TEXT_KEYS) {
    const incRaw = incoming[key];
    const inc = normalizeText(incRaw == null ? null : String(incRaw));
    if (inc == null) continue;                 // keine Info → nichts tun
    const cur = merged[key] as string | null;
    if (cur == null) {
      (merged[key] as string | null) = inc;    // leeres Feld füllen
      changedFields.push(key);
    } else if (cur !== inc) {
      conflictFields.push(key);                // bestehender Wert bleibt
    }
    // cur === inc → identisch, nichts tun
  }

  return { merged, changedFields, conflictFields };
}

// ── Import-Plan ──────────────────────────────────────────────────────────────

export interface GuestImportStats {
  rowsParsed: number;     // verarbeitete (geparste) Zeilen
  matchedRows: number;    // Zeilen mit eindeutigem Gast-Treffer
  matchedGuests: number;  // verschiedene getroffene Gäste
  unassignable: number;   // Zeilen ohne (eindeutigen) Treffer
  created: number;        // neu anzulegende CRM-Profile (mind. 1 Feld)
  updated: number;        // bestehende CRM-Profile mit ≥1 neuem Feld
  conflicts: number;      // Anzahl Konfliktfelder (bestehender Wert behalten)
}

export interface GuestImportPlanEntry {
  guestId: string;
  profile: GuestCrmProfile;
  isCreate: boolean;
}

export interface GuestImportPlanResult {
  plan: GuestImportPlanEntry[];
  stats: GuestImportStats;
}

/**
 * Erstellt den Import-Plan: matcht jede Zeile, gruppiert mehrere Zeilen je Gast
 * und mischt sie in das bestehende CRM-Profil.  Es entstehen nur Plan-Einträge
 * für Gäste mit mindestens einem zu schreibenden Feld (Dedupliziert je `guestId`,
 * sodass jeder Gast höchstens einmal geschrieben wird).
 */
export function planGuestImport(
  rows: ParsedGuestRow[],
  index: GuestMatchIndex,
  existingCrm: Map<string, GuestCrmProfile>,
): GuestImportPlanResult {
  // Eingehende Felder je Gast sammeln (Reihenfolge der Zeilen bleibt erhalten).
  const perGuest = new Map<string, IncomingCrm[]>();
  let matchedRows = 0;
  let unassignable = 0;

  for (const row of rows) {
    const m = matchGuestRow(row, index);
    if (!m.guestId) { unassignable++; continue; }
    matchedRows++;
    const list = perGuest.get(m.guestId) ?? [];
    list.push(rowToIncomingCrm(row));
    perGuest.set(m.guestId, list);
  }

  const plan: GuestImportPlanEntry[] = [];
  let created = 0;
  let updated = 0;
  let conflicts = 0;

  for (const [guestId, incomings] of perGuest) {
    const isCreate = !existingCrm.has(guestId);
    let merged = existingCrm.get(guestId) ?? EMPTY_CRM_PROFILE;
    const changed = new Set<string>();
    for (const inc of incomings) {
      const res = mergeCrmProfile(merged, inc);
      merged = res.merged;
      res.changedFields.forEach((f) => changed.add(f));
      conflicts += res.conflictFields.length;
    }
    if (changed.size > 0) {
      plan.push({ guestId, profile: merged, isCreate });
      if (isCreate) created++; else updated++;
    }
  }

  return {
    plan,
    stats: {
      rowsParsed: rows.length,
      matchedRows,
      matchedGuests: perGuest.size,
      unassignable,
      created,
      updated,
      conflicts,
    },
  };
}
