/**
 * Gäste-Duplikate — reine Erkennungs-/Zusammenführungslogik (ohne Supabase/DOM)
 * ============================================================================
 * Erkennt potenzielle Dubletten anhand der NORMALISIERTEN Telefonnummer und
 * stellt die reinen Bausteine für eine sichere Zusammenführung bereit. Bewusst
 * frei von Datenbank/DOM, damit Gruppierung und Merge-Semantik als Unit ohne
 * Supabase getestet werden können (DB-Anbindung: `guest-duplicates-db.ts`).
 *
 * Normalisierung: identisch zur Import-Erkennung — `normalizeMobile` entfernt
 * Leerzeichen, Satz-/Formatierungszeichen, führende `00`/`+` und verlangt ≥7
 * Ziffern. So matchen z. B. "+41 79 123 45 67" und "0041791234567".
 *
 * Merge-Semantik (verlustfrei + idempotent):
 *  - Boolesche CRM-Flags: ODER (true gewinnt) → VIP/Sperrliste etc. bleiben erhalten.
 *  - Freitext (Allergien/Unverträglichkeiten/Notizen): zeilenweise Vereinigung,
 *    dedupliziert → ein erneuter Merge ändert nichts mehr.
 *  - übrige Text-/Datumsfelder & Identitätsfelder: fill-empty-only (Master behält
 *    seinen Wert; leere Felder werden aus den Duplikaten ergänzt).
 *  - `match_key` wird NIE verändert (UNIQUE(restaurant_id, match_key) bleibt gültig).
 */

import { normalizeMobile } from './reservation-import-parser';
import {
  normalizeCrmProfile,
  CRM_BOOLEAN_KEYS, CRM_TEXT_KEYS,
  type GuestCrmProfile,
} from './guest-crm-profile';

// ── Typen ────────────────────────────────────────────────────────────────────

/** Ein Gast in der Duplikat-Ansicht (Anzeige + Entscheidungshilfe). */
export interface DuplicateGuest {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  mobile: string | null;
  normalizedMobile: string | null;
  reservationCount: number;
  lastReservationDate: string | null; // "yyyy-MM-dd" (aus last_seen_at)
  createdAt: string | null;           // ISO-Zeitstempel der Profil-Anlage
}

/** Eine Gruppe von ≥2 Gästen, die sich dieselbe normalisierte Telefonnummer teilen. */
export interface DuplicateGroup {
  phoneKey: string;            // normalisierte Telefonnummer (Gruppenschlüssel)
  displayPhone: string;        // erste lesbare Rohnummer der Gruppe (für die Anzeige)
  guests: DuplicateGuest[];    // sortiert: meiste Reservationen zuerst (Master-Vorschlag)
  suggestedMasterId: string;   // = guests[0].id
}

// ── Normalisierung / Anzeige ─────────────────────────────────────────────────

/**
 * Normalisierter Telefon-Schlüssel: bevorzugt die Live-Normalisierung der
 * Rohnummer, fällt auf den gespeicherten `normalized_mobile` zurück.
 * null, wenn keine verwertbare Nummer vorliegt (solche Gäste bilden keine Gruppe).
 */
export function normalizePhoneKey(
  rawMobile: string | null | undefined,
  storedNormalized?: string | null,
): string | null {
  const live = rawMobile ? normalizeMobile(rawMobile) : null;
  if (live) return live;
  const stored = (storedNormalized ?? '').trim();
  return stored !== '' ? stored : null;
}

/** Anzeigename: Vor-/Nachname, sonst E-Mail, sonst Mobile, sonst "—". */
export function guestDisplayName(g: {
  firstName: string | null; lastName: string | null;
  email: string | null; mobile: string | null;
}): string {
  const name = [g.firstName, g.lastName].map(s => (s ?? '').trim()).filter(Boolean).join(' ').trim();
  if (name) return name;
  if (g.email && g.email.trim()) return g.email.trim();
  if (g.mobile && g.mobile.trim()) return g.mobile.trim();
  return '—';
}

/** Sortierung innerhalb einer Gruppe: meiste Reservationen → jüngster Besuch → älteres Konto → id. */
function sortGuestsForMaster(a: DuplicateGuest, b: DuplicateGuest): number {
  if (b.reservationCount !== a.reservationCount) return b.reservationCount - a.reservationCount;
  const al = a.lastReservationDate ?? '';
  const bl = b.lastReservationDate ?? '';
  if (al !== bl) return bl.localeCompare(al); // jüngerer letzter Besuch zuerst
  const ac = a.createdAt ?? '';
  const bc = b.createdAt ?? '';
  if (ac !== bc) return ac.localeCompare(bc); // älteres (etablierteres) Konto zuerst
  return a.id.localeCompare(b.id);
}

/**
 * Gruppiert Gäste nach normalisierter Telefonnummer; liefert nur Gruppen mit
 * ≥2 Mitgliedern (echte Dubletten). Gäste ohne verwertbare Nummer werden
 * ignoriert. Innerhalb jeder Gruppe wird ein Master vorgeschlagen (meiste
 * Reservationen). Gruppen: grösste zuerst, dann stabil nach phoneKey.
 */
export function groupDuplicatesByPhone(guests: DuplicateGuest[]): DuplicateGroup[] {
  const byKey = new Map<string, DuplicateGuest[]>();
  for (const g of guests) {
    const key = normalizePhoneKey(g.mobile, g.normalizedMobile);
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(g);
    byKey.set(key, arr);
  }

  const groups: DuplicateGroup[] = [];
  for (const [phoneKey, members] of byKey) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(sortGuestsForMaster);
    const displayPhone = sorted.map(m => (m.mobile ?? '').trim()).find(Boolean) ?? phoneKey;
    groups.push({ phoneKey, displayPhone, guests: sorted, suggestedMasterId: sorted[0].id });
  }
  groups.sort((a, b) => (b.guests.length - a.guests.length) || a.phoneKey.localeCompare(b.phoneKey));
  return groups;
}

// ── CRM-Merge (verlustfrei, idempotent) ──────────────────────────────────────

/**
 * Vereint mehrzeiligen Freitext idempotent: alle Zeilen aus Master und Duplikat,
 * getrimmt, leer-Zeilen verworfen, case-insensitiv dedupliziert (Reihenfolge
 * Master → Duplikat). Ein erneuter Aufruf mit denselben Quellen liefert dasselbe
 * Ergebnis (kein Aufschaukeln bei Wiederholung).
 */
function unionLines(master: string | null, dup: string | null): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const block of [master, dup]) {
    if (!block) continue;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Freitextfelder, die zeilenweise vereint statt nur fill-empty übernommen werden. */
const CONCAT_KEYS: ReadonlyArray<keyof GuestCrmProfile> = ['allergies', 'dietaryNotes', 'crmNotes'];

/**
 * Verschmilzt das CRM-Profil eines Duplikats in das Master-Profil:
 *  - boolesche Flags: ODER (true gewinnt),
 *  - Allergien/Unverträglichkeiten/Notizen: zeilenweise Vereinigung (dedupliziert),
 *  - übrige Text-/Datumsfelder: fill-empty-only (Master behält vorhandene Werte).
 * Idempotent: wiederholtes Mergen desselben Duplikats verändert nichts mehr.
 */
export function mergeCrmProfiles(master: GuestCrmProfile, dup: GuestCrmProfile): GuestCrmProfile {
  const m = normalizeCrmProfile(master);
  const d = normalizeCrmProfile(dup);
  const out: GuestCrmProfile = { ...m };

  for (const k of CRM_BOOLEAN_KEYS) {
    (out[k] as boolean) = (m[k] as boolean) || (d[k] as boolean);
  }
  for (const k of CRM_TEXT_KEYS) {
    if (CONCAT_KEYS.includes(k)) {
      (out[k] as string | null) = unionLines(m[k] as string | null, d[k] as string | null);
    } else {
      (out[k] as string | null) = (m[k] as string | null) ?? (d[k] as string | null);
    }
  }
  return normalizeCrmProfile(out);
}

// ── Identitäts-Anreicherung des Masters (fill-empty-only) ─────────────────────

/** Identitätsfelder eines Gästeprofils (Rohzeile), die beim Merge ergänzt werden dürfen. */
export interface GuestIdentityRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mobile: string | null;
  normalized_email: string | null;
  normalized_mobile: string | null;
  normalized_name: string | null;
}

/** Anreicherbare Felder — `match_key` ist BEWUSST nicht enthalten. */
const IDENTITY_FIELDS: ReadonlyArray<keyof GuestIdentityRow> = [
  'first_name', 'last_name', 'email', 'mobile',
  'normalized_email', 'normalized_mobile', 'normalized_name',
];

/**
 * Liefert NUR die Felder, die am Master leer sind und bei einem Duplikat
 * vorliegen (erstes Duplikat mit Wert gewinnt). So findet ein späterer Import
 * den Master über die zusätzlich gelernten Identitäten wieder, ohne den
 * `match_key` oder bereits gepflegte Master-Werte zu verändern. Leeres Objekt,
 * wenn nichts zu ergänzen ist (idempotent).
 */
export function fillEmptyIdentity(
  master: GuestIdentityRow,
  dups: GuestIdentityRow[],
): Partial<Omit<GuestIdentityRow, 'id'>> {
  const out: Partial<Omit<GuestIdentityRow, 'id'>> = {};
  for (const f of IDENTITY_FIELDS) {
    const cur = (master[f] ?? '').toString().trim();
    if (cur !== '') continue; // Master hat den Wert schon → nicht überschreiben
    for (const d of dups) {
      const v = (d[f] ?? '').toString().trim();
      if (v !== '') { (out[f] as string) = v; break; }
    }
  }
  return out;
}
