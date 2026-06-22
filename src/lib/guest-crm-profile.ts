/**
 * Gäste-CRM Phase 1 — manuelle CRM-Profile: reine Abbildungs-/Normalisierungslogik
 * ================================================================================
 * Bewusst FREI von Supabase/DOM, damit Mapping, Normalisierung und
 * Dirty-Erkennung als Unit ohne Datenbank getestet werden können (die
 * DB-Anbindung liegt ausschliesslich in `guest-crm-profile-db.ts`).
 *
 * WICHTIG — Trennung der Datenwelten:
 *   Dieses Modul beschreibt NUR die MANUELL gepflegten CRM-Felder
 *   (`guest_crm_profiles`).  Die automatisch berechneten Kennzahlen/Segmente
 *   (reservation-crm.ts / guest_statistics) bleiben strikt getrennt und werden
 *   hier weder gelesen noch verändert.
 */

/** Manuelles CRM-Profil eines Gastes (App-Sicht, camelCase). */
export interface GuestCrmProfile {
  vipManual: boolean;
  stammgastManual: boolean;
  companyCustomer: boolean;
  newsletterOptIn: boolean;
  blockedGuest: boolean;
  birthday: string | null;        // "yyyy-MM-dd"
  company: string | null;
  language: string | null;
  allergies: string | null;
  dietaryNotes: string | null;
  favoriteTable: string | null;
  favoriteArea: string | null;
  favoriteWine: string | null;
  favoriteDish: string | null;
  crmNotes: string | null;
}

/** Zeilenform der Tabelle `guest_crm_profiles` (snake_case wie in der DB). */
export interface GuestCrmProfileRow {
  guest_id: string;
  vip_manual: boolean | null;
  stammgast_manual: boolean | null;
  company_customer: boolean | null;
  newsletter_opt_in: boolean | null;
  blocked_guest: boolean | null;
  birthday: string | null;
  company: string | null;
  language: string | null;
  allergies: string | null;
  dietary_notes: string | null;
  favorite_table: string | null;
  favorite_area: string | null;
  favorite_wine: string | null;
  favorite_dish: string | null;
  crm_notes: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Leeres Profil — defensiver Default, wenn (noch) kein CRM-Profil existiert. */
export const EMPTY_CRM_PROFILE: GuestCrmProfile = {
  vipManual: false,
  stammgastManual: false,
  companyCustomer: false,
  newsletterOptIn: false,
  blockedGuest: false,
  birthday: null,
  company: null,
  language: null,
  allergies: null,
  dietaryNotes: null,
  favoriteTable: null,
  favoriteArea: null,
  favoriteWine: null,
  favoriteDish: null,
  crmNotes: null,
};

/** Boolesche Felder — für Mapping/Vergleich an EINER Stelle gepflegt. */
export const CRM_BOOLEAN_KEYS: ReadonlyArray<keyof GuestCrmProfile> = [
  'vipManual', 'stammgastManual', 'companyCustomer', 'newsletterOptIn', 'blockedGuest',
];

/** Text-/Datumsfelder (string | null) — für Mapping/Vergleich. */
export const CRM_TEXT_KEYS: ReadonlyArray<keyof GuestCrmProfile> = [
  'birthday', 'company', 'language', 'allergies', 'dietaryNotes',
  'favoriteTable', 'favoriteArea', 'favoriteWine', 'favoriteDish', 'crmNotes',
];

// ── Normalisierung ───────────────────────────────────────────────────────────

/** Trimmt Text; leerer/whitespace-only String → null. */
export function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/** Prüft striktes ISO-Datum "yyyy-MM-dd" (inkl. echtem Kalendertag). */
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Normalisiert ein Geburtsdatum auf "yyyy-MM-dd" oder null (ungültig → null). */
export function normalizeBirthday(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).slice(0, 10).trim();
  return s !== '' && isValidIsoDate(s) ? s : null;
}

/**
 * Normalisiert ein gesamtes Profil: Booleans als echte Booleans, Texte getrimmt
 * (leer → null), Geburtstag validiert.  Idempotent.
 */
export function normalizeCrmProfile(profile: GuestCrmProfile): GuestCrmProfile {
  return {
    vipManual: Boolean(profile.vipManual),
    stammgastManual: Boolean(profile.stammgastManual),
    companyCustomer: Boolean(profile.companyCustomer),
    newsletterOptIn: Boolean(profile.newsletterOptIn),
    blockedGuest: Boolean(profile.blockedGuest),
    birthday: normalizeBirthday(profile.birthday),
    company: normalizeText(profile.company),
    language: normalizeText(profile.language),
    allergies: normalizeText(profile.allergies),
    dietaryNotes: normalizeText(profile.dietaryNotes),
    favoriteTable: normalizeText(profile.favoriteTable),
    favoriteArea: normalizeText(profile.favoriteArea),
    favoriteWine: normalizeText(profile.favoriteWine),
    favoriteDish: normalizeText(profile.favoriteDish),
    crmNotes: normalizeText(profile.crmNotes),
  };
}

// ── Mapping DB ⇄ App ─────────────────────────────────────────────────────────

/** DB-Zeile → App-Profil (NULL-Booleans werden zu false). */
export function rowToCrmProfile(row: GuestCrmProfileRow): GuestCrmProfile {
  return {
    vipManual: row.vip_manual === true,
    stammgastManual: row.stammgast_manual === true,
    companyCustomer: row.company_customer === true,
    newsletterOptIn: row.newsletter_opt_in === true,
    blockedGuest: row.blocked_guest === true,
    birthday: row.birthday ? String(row.birthday).slice(0, 10) : null,
    company: row.company ?? null,
    language: row.language ?? null,
    allergies: row.allergies ?? null,
    dietaryNotes: row.dietary_notes ?? null,
    favoriteTable: row.favorite_table ?? null,
    favoriteArea: row.favorite_area ?? null,
    favoriteWine: row.favorite_wine ?? null,
    favoriteDish: row.favorite_dish ?? null,
    crmNotes: row.crm_notes ?? null,
  };
}

/**
 * App-Profil → DB-Zeile (für Upsert).  Normalisiert zuvor; `created_at`/
 * `updated_at` werden NICHT gesetzt (created_at via DEFAULT, updated_at setzt die
 * DB-Schicht beim Schreiben).
 */
export function crmProfileToRow(
  profile: GuestCrmProfile,
  guestId: string,
): Omit<GuestCrmProfileRow, 'created_at' | 'updated_at'> {
  const n = normalizeCrmProfile(profile);
  return {
    guest_id: guestId,
    vip_manual: n.vipManual,
    stammgast_manual: n.stammgastManual,
    company_customer: n.companyCustomer,
    newsletter_opt_in: n.newsletterOptIn,
    blocked_guest: n.blockedGuest,
    birthday: n.birthday,
    company: n.company,
    language: n.language,
    allergies: n.allergies,
    dietary_notes: n.dietaryNotes,
    favorite_table: n.favoriteTable,
    favorite_area: n.favoriteArea,
    favorite_wine: n.favoriteWine,
    favorite_dish: n.favoriteDish,
    crm_notes: n.crmNotes,
  };
}

// ── Dirty-Erkennung (für „Speichern"/„Zurücksetzen") ─────────────────────────

/** Wertgleichheit zweier Profile (nach Normalisierung). */
export function crmProfileEquals(a: GuestCrmProfile, b: GuestCrmProfile): boolean {
  const na = normalizeCrmProfile(a);
  const nb = normalizeCrmProfile(b);
  for (const k of CRM_BOOLEAN_KEYS) if (na[k] !== nb[k]) return false;
  for (const k of CRM_TEXT_KEYS) if (na[k] !== nb[k]) return false;
  return true;
}

/** true, wenn `current` vom `saved`-Stand abweicht (lokale, ungespeicherte Änderungen). */
export function isCrmProfileDirty(current: GuestCrmProfile, saved: GuestCrmProfile): boolean {
  return !crmProfileEquals(current, saved);
}

// ── Manuelle Badges (VIP / Stammgast) ────────────────────────────────────────

/** Art eines manuell gesetzten CRM-Badges. */
export type ManualBadgeKind = 'vip' | 'stammgast';

/** Anzuzeigendes manuelles Badge (rein darstellungsbezogen). */
export interface ManualBadge {
  kind: ManualBadgeKind;
  label: string;
}

/**
 * Ermittelt die MANUELL gesetzten Badges (VIP / Stammgast) eines Profils.
 *
 * Diese hängen AUSSCHLIESSLICH an den manuellen Flags `vipManual` /
 * `stammgastManual` und sind völlig unabhängig vom automatisch berechneten
 * Segment.  Sie werden NIE in die Segment-/Score-/Kampagnenlogik zurückgeführt.
 */
export function manualCrmBadges(profile: GuestCrmProfile | null | undefined): ManualBadge[] {
  if (!profile) return [];
  const badges: ManualBadge[] = [];
  if (profile.vipManual) badges.push({ kind: 'vip', label: 'VIP (manuell)' });
  if (profile.stammgastManual) badges.push({ kind: 'stammgast', label: 'Stammgast (manuell)' });
  return badges;
}
