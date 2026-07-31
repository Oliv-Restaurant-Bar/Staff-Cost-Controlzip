/**
 * staffing-profiles-utils — reine Logik der Personalbedarf-PROFILE.
 * ──────────────────────────────────────────────────────────────────────────────
 * Ein «Profil» ist fachlich eine Saison der staffing_requirements
 * (season-Spalte): 'standard', 'winter' (Anzeige «Winter/UG») sowie beliebige
 * weitere Schlüssel. Zusätzlich zur Saison trägt ein Profil:
 *   - einen DATUMSBEREICH (MM-TT), in dem es automatisch aktiv ist
 *     (z.B. Winter/UG ab 01.10. bis 31.03.),
 *   - ein «festgesetzt»-Flag (locked): sperrt den Bedarf-Editor gegen
 *     versehentliches Ändern.
 *
 * Ausserdem hält die Konfiguration je Mandant:
 *   - die Chef-de-Service-Prioritätsliste (Mitarbeiter-IDs, höchste zuerst),
 *   - das Umsatzbudget je Wochentag (Kontext im Bedarf-Editor).
 *
 * KEINE Supabase-/DOM-Abhängigkeiten — isoliert testbar (node-Umgebung).
 * Persistenz: staffing-profiles-db.ts (app_settings, Key je Mandant).
 */
import type { StaffingSeason } from '@/types/staffing';

// ─── Modell ───────────────────────────────────────────────────────────────────

export interface StaffingProfile {
  /** Saison-Schlüssel in staffing_requirements (z.B. 'standard' | 'winter'). */
  key: StaffingSeason;
  /** Anzeigename (z.B. «Winter/UG»). */
  label: string;
  /** Aktiv ab (einschliesslich), Format 'MM-TT'; null = kein Automatik-Bereich. */
  activeFrom: string | null;
  /** Aktiv bis (einschliesslich), Format 'MM-TT'; null = offen. */
  activeTo: string | null;
  /** «festgesetzt»: Bedarf-Editor dieses Profils ist gesperrt. */
  locked: boolean;
  /**
   * ABGELEITETES Profil: liest die Bedarfszeilen einer anderen Saison statt
   * eigener Zeilen (Winter/UG = 'standard' + UG-Zuschlag). null = eigenständig.
   */
  baseKey: StaffingSeason | null;
}

/** Ein additiver Zuschlags-Posten: +count Personen auf einer Position. */
export interface UgSurchargeEntry {
  positionKey: string;
  count: number;
}

/**
 * UG-Zuschlag — separater, ADDITIVER Baustein auf 'Standard':
 * greift (a) im Profil Winter/UG an den `weekdays` (Default Fr+Sa, UG regulär
 * offen) und (b) GANZJÄHRIG an jedem Tag mit gesetztem «UG/Event offen»-Flag,
 * unabhängig vom Saisonprofil.
 */
export interface UgSurcharge {
  /**
   * Automatik EIN/AUS: bei false greift der SAISONALE Zuschlag (Winter/UG ×
   * weekdays) nicht; das Tages-Flag «UG/Event offen» wirkt WEITERHIN
   * (einmalige Events bleiben unabhängig möglich). Default true.
   */
  enabled: boolean;
  entries: UgSurchargeEntry[];
  /** ISO-Wochentage (1=Mo…7=So), an denen der Zuschlag im Winter/UG-Profil greift. */
  weekdays: number[];
}

/**
 * Dynamische Küchen-Stationsregel «Kalte Küche / Sushi» (analog CdS-Regel):
 *  - Ist `soloId` (Miro) geplant → er übernimmt Kalte Küche UND Sushi.
 *  - Sonst, wenn ≥ `minHotCooks` Köche aus `hotCookIds` am Herd geplant sind →
 *    die erste geplante Person aus `fallbackIds` (Michele, dann Mejdi)
 *    übernimmt Kalte Küche/Sushi.
 *  - Sind weniger Köche geplant (schwacher Tag, z.B. Sonntag) → keine eigene
 *    Kalte-Station; die Köche decken alles ab (kein Fehler).
 */
export interface KitchenColdRule {
  /** Stamm-Besetzung der Kalten Küche (Oliv: Miro). */
  soloId: string;
  /** Vertretungs-Reihenfolge, wenn soloId fehlt (Oliv: Michele > Mejdi). */
  fallbackIds: string[];
  /** «Küche heiss»-Köche (Oliv: Mejdi, Micky, Karel, Michele, Party). */
  hotCookIds: string[];
  /** Mindestzahl geplanter Herd-Köche, ab der die Kalte-Station besetzt wird. */
  minHotCooks: number;
}

export interface StaffingProfilesConfig {
  profiles: StaffingProfile[];
  /**
   * Chef-de-Service-Prioritätsliste: Mitarbeiter-IDs, höchste Priorität zuerst.
   * Default Oliv: Artin > Mendim > Ibrahim.
   */
  cdsPriority: string[];
  /** Umsatzbudget je ISO-Wochentag (1=Mo … 7=So), CHF. Kontextanzeige. */
  revenueBudgetByWeekday: Record<number, number>;
  /** UG-Zuschlag (additiv auf Standard). */
  ugSurcharge: UgSurcharge;
  /** Küchen-Stationsregel Kalte Küche/Sushi (null = nicht konfiguriert). */
  kitchenCold: KitchenColdRule | null;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** Default-Profile: Standard (immer Rückfall) + Winter/UG ab 01.10. bis 31.03. */
export function defaultProfiles(): StaffingProfile[] {
  return [
    { key: 'standard', label: 'Standard', activeFrom: null, activeTo: null, locked: false, baseKey: null },
    // Winter/UG ist ABGELEITET: = Standard + UG-Zuschlag (kein eigener Datensatz).
    { key: 'winter', label: 'Winter/UG', activeFrom: '10-01', activeTo: '03-31', locked: false, baseKey: 'standard' },
  ];
}

/** Oliv-Default der CdS-Priorität: Artin (2) > Mendim (103) > Ibrahim (105). */
const OLIV_CDS_PRIORITY = ['2', '103', '105'];

/**
 * Beaulieu-Default der CdS-Priorität:
 * Krebs Marcel (b-200) > Redzepi Nehat (b-161) > Joana Bolsinger (b-220, Vertretung).
 */
const BEAULIEU_CDS_PRIORITY = ['b-200', 'b-161', 'b-220'];

/** UG-Zuschlag Oliv: Bar unten +1, Service +2; Winter-Regelbetrieb Fr+Sa. */
const OLIV_UG_SURCHARGE: UgSurcharge = {
  enabled: true,
  entries: [
    { positionKey: 'bar_unten', count: 1 },
    { positionKey: 'service', count: 2 },
  ],
  weekdays: [5, 6],
};

/**
 * Küchen-Stationsregel Oliv: Miro (15) übernimmt Kalte Küche+Sushi; fehlt er
 * und sind ≥3 Herd-Köche (Mejdi 14, Micky 18, Karel 17, Michele 106, Party)
 * geplant, übernimmt Michele (106), sonst Mejdi (14).
 */
const OLIV_KITCHEN_COLD: KitchenColdRule = {
  soloId: '15',
  fallbackIds: ['106', '14'],
  hotCookIds: ['14', '18', '17', '106', 'party'],
  minHotCooks: 3,
};

/** Umsatzbudget Oliv je Wochentag (Mo 5000, Di/Mi 6000, Do 8000, Fr/Sa 12000, So 7000). */
const OLIV_REVENUE_BUDGET: Record<number, number> = {
  1: 5000, 2: 6000, 3: 6000, 4: 8000, 5: 12000, 6: 12000, 7: 7000,
};

export function defaultStaffingProfilesConfig(tenantId: string): StaffingProfilesConfig {
  const isOliv = tenantId === 'oliv';
  return {
    profiles: defaultProfiles(),
    cdsPriority: isOliv
      ? [...OLIV_CDS_PRIORITY]
      : tenantId === 'beaulieu' ? [...BEAULIEU_CDS_PRIORITY] : [],
    revenueBudgetByWeekday: isOliv ? { ...OLIV_REVENUE_BUDGET } : {},
    ugSurcharge: isOliv
      ? { enabled: true, entries: OLIV_UG_SURCHARGE.entries.map((e) => ({ ...e })), weekdays: [...OLIV_UG_SURCHARGE.weekdays] }
      : { enabled: true, entries: [], weekdays: [5, 6] },
    kitchenCold: isOliv
      ? { ...OLIV_KITCHEN_COLD, fallbackIds: [...OLIV_KITCHEN_COLD.fallbackIds], hotCookIds: [...OLIV_KITCHEN_COLD.hotCookIds] }
      : null,
  };
}

// ─── Normalisierung (Laden aus unknown-JSON) ──────────────────────────────────

const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isValidMonthDay(v: string | null | undefined): boolean {
  return typeof v === 'string' && MMDD_RE.test(v);
}

function normProfile(raw: unknown): StaffingProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key) return null;
  return {
    key,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : key,
    activeFrom: isValidMonthDay(r.activeFrom as string) ? (r.activeFrom as string) : null,
    activeTo: isValidMonthDay(r.activeTo as string) ? (r.activeTo as string) : null,
    locked: r.locked === true,
    // Winter/UG ist IMMER abgeleitet (auch bei alten gespeicherten Blobs ohne Feld).
    baseKey:
      key === 'winter'
        ? 'standard'
        : typeof r.baseKey === 'string' && r.baseKey.trim()
          ? r.baseKey.trim()
          : null,
  };
}

function normSurcharge(raw: unknown, def: UgSurcharge): UgSurcharge {
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const entries = Array.isArray(r.entries)
    ? r.entries
        .map((e): UgSurchargeEntry | null => {
          if (!e || typeof e !== 'object') return null;
          const x = e as Record<string, unknown>;
          const positionKey = typeof x.positionKey === 'string' ? x.positionKey.trim() : '';
          const count = typeof x.count === 'number' && Number.isFinite(x.count) ? Math.round(x.count) : NaN;
          return positionKey && Number.isInteger(count) && count > 0 ? { positionKey, count } : null;
        })
        .filter((e): e is UgSurchargeEntry => e !== null)
    : def.entries;
  const weekdays = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.filter((w): w is number => Number.isInteger(w) && (w as number) >= 1 && (w as number) <= 7))]
    : def.weekdays;
  // Alte Blobs ohne Feld → aktiviert (bisheriges Verhalten).
  const enabled = r.enabled === false ? false : true;
  return { enabled, entries, weekdays };
}

function normKitchenCold(raw: unknown, def: KitchenColdRule | null): KitchenColdRule | null {
  if (raw === null) return null; // explizit deaktiviert
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  const soloId = typeof r.soloId === 'string' ? r.soloId.trim() : '';
  if (!soloId) return def;
  const minHotCooks =
    typeof r.minHotCooks === 'number' && Number.isInteger(r.minHotCooks) && r.minHotCooks >= 1
      ? r.minHotCooks
      : def?.minHotCooks ?? 3;
  return { soloId, fallbackIds: ids(r.fallbackIds), hotCookIds: ids(r.hotCookIds), minHotCooks };
}

/**
 * Baut aus einem unbekannten JSON-Blob eine gültige Konfiguration.
 * Fehlende Teile werden aus den Mandanten-Defaults ergänzt; 'standard' und
 * 'winter' sind immer vorhanden (Defaults zuerst, gespeicherte Werte gewinnen).
 */
export function normalizeStaffingProfilesConfig(
  raw: unknown,
  tenantId: string,
): StaffingProfilesConfig {
  const def = defaultStaffingProfilesConfig(tenantId);
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;

  const storedProfiles = Array.isArray(r.profiles)
    ? r.profiles.map(normProfile).filter((p): p is StaffingProfile => p !== null)
    : [];
  const byKey = new Map<string, StaffingProfile>();
  for (const p of def.profiles) byKey.set(p.key, p);
  for (const p of storedProfiles) byKey.set(p.key, p);

  const cds = Array.isArray(r.cdsPriority)
    ? r.cdsPriority.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : def.cdsPriority;

  let budget = def.revenueBudgetByWeekday;
  if (r.revenueBudgetByWeekday && typeof r.revenueBudgetByWeekday === 'object') {
    budget = {};
    for (const [k, v] of Object.entries(r.revenueBudgetByWeekday as Record<string, unknown>)) {
      const wd = Number(k);
      if (Number.isInteger(wd) && wd >= 1 && wd <= 7 && typeof v === 'number' && Number.isFinite(v)) {
        budget[wd] = v;
      }
    }
  }

  return {
    profiles: [...byKey.values()],
    cdsPriority: cds,
    revenueBudgetByWeekday: budget,
    ugSurcharge: normSurcharge(r.ugSurcharge, def.ugSurcharge),
    // 'kitchenCold' fehlt in alten Blobs → Mandanten-Default ergänzen.
    kitchenCold: 'kitchenCold' in r ? normKitchenCold(r.kitchenCold, def.kitchenCold) : def.kitchenCold,
  };
}

// ─── Aktives Profil je Datum ──────────────────────────────────────────────────

/** 'MM-TT' → Vergleichszahl (Monat*100+Tag); NaN bei ungültig. */
function mmddNum(v: string | null): number {
  if (!isValidMonthDay(v)) return NaN;
  const [m, d] = (v as string).split('-').map(Number);
  return m * 100 + d;
}

/**
 * Liegt das Datum (MM-TT des Jahres) im Bereich [from..to] (einschliesslich)?
 * Unterstützt Jahreswechsel-Bereiche (from > to, z.B. 10-01..03-31).
 */
export function isDateInMonthDayRange(date: Date, from: string | null, to: string | null): boolean {
  const f = mmddNum(from);
  const t = mmddNum(to);
  const x = (date.getMonth() + 1) * 100 + date.getDate();
  if (Number.isNaN(f) && Number.isNaN(t)) return false;
  if (Number.isNaN(t)) return x >= f; // offenes Ende
  if (Number.isNaN(f)) return x <= t; // offener Anfang
  if (f <= t) return x >= f && x <= t;
  return x >= f || x <= t; // über Jahreswechsel
}

/**
 * Ermittelt das für ein Datum aktive Profil:
 * das ERSTE Nicht-Standard-Profil, dessen Datumsbereich das Datum enthält,
 * sonst 'standard' (Rückfall).
 */
export function resolveActiveProfileForDate(
  config: StaffingProfilesConfig,
  date: Date,
): StaffingSeason {
  for (const p of config.profiles) {
    if (p.key === 'standard') continue;
    if (isDateInMonthDayRange(date, p.activeFrom, p.activeTo)) return p.key;
  }
  return 'standard';
}

/** Profil per Schlüssel (oder undefined). */
export function profileByKey(
  config: StaffingProfilesConfig,
  key: StaffingSeason,
): StaffingProfile | undefined {
  return config.profiles.find((p) => p.key === key);
}

/** Ist ein Profil «festgesetzt» (gesperrt)? Unbekannte Profile gelten als offen. */
export function isProfileLocked(config: StaffingProfilesConfig, key: StaffingSeason): boolean {
  return profileByKey(config, key)?.locked === true;
}

// ─── UG-Zuschlag (additiv auf Standard) ───────────────────────────────────────

/**
 * Greift der UG-Zuschlag?
 *  (a) Tages-Flag «UG/Event offen» gesetzt → JA, ganzjährig, profil-unabhängig.
 *  (b) sonst: Profil Winter/UG aktiv UND Wochentag in ugSurcharge.weekdays (Fr/Sa).
 */
export function ugSurchargeApplies(params: {
  config: StaffingProfilesConfig;
  season: StaffingSeason;
  weekday: number;
  eventOpen: boolean;
}): boolean {
  const { config, season, weekday, eventOpen } = params;
  if (config.ugSurcharge.entries.length === 0) return false;
  // Tages-Flag wirkt IMMER (auch bei deaktivierter Automatik) — einmalige Events.
  if (eventOpen) return true;
  // Saisonale Automatik: nur wenn aktiviert (enabled !== false).
  if (config.ugSurcharge.enabled === false) return false;
  return season === 'winter' && config.ugSurcharge.weekdays.includes(weekday);
}

/** Saison, deren Bedarfszeilen ein Profil tatsächlich liest (Winter/UG → standard). */
export function dataSeasonForProfile(
  config: StaffingProfilesConfig,
  season: StaffingSeason,
): StaffingSeason {
  return profileByKey(config, season)?.baseKey ?? season;
}

/**
 * Minimale strukturelle Sicht auf eine Bedarfszeile — vermeidet eine harte
 * Typ-Abhängigkeit; die echten StaffingRequirement-Objekte erfüllen sie.
 */
interface RequirementLike {
  id: string;
  season: string;
  weekday: number;
  positionKey: string;
  shiftStart: string;
  shiftEnd: string;
  requiredCount: number;
  meta: Record<string, unknown>;
}

/**
 * Baut die EFFEKTIVEN Bedarfszeilen für eine Prüfung/Anzeige:
 *  1. abgeleitete Profile lesen die Zeilen ihrer Basis-Saison (Winter/UG →
 *     standard) — die zurückgegebenen Zeilen sind auf `season` umgeschlüsselt,
 *     damit Konsumenten weiter nach (season, weekday) filtern können;
 *  2. greift der UG-Zuschlag, wird je Posten die Anzahl der SPÄTESTEN Schicht
 *     der Position an diesem Wochentag erhöht (UG = Abendbetrieb); hat die
 *     Position dort keine Schicht, entsteht eine synthetische Abend-Zeile
 *     17:00–23:00 (meta.ugSurcharge = true).
 *
 * Rein und kopierend — die Eingabeliste wird nie mutiert.
 */
export function buildEffectiveRequirements<T extends RequirementLike>(params: {
  requirements: T[];
  config: StaffingProfilesConfig;
  season: StaffingSeason;
  weekday: number;
  eventOpen: boolean;
}): T[] {
  const { requirements, config, season, weekday, eventOpen } = params;
  const dataSeason = dataSeasonForProfile(config, season);

  // Zeilen der Basis-Saison auf das angefragte Profil umschlüsseln (Kopien).
  let effective: T[] =
    dataSeason === season
      ? requirements.map((r) => ({ ...r }))
      : requirements
          .filter((r) => r.season !== season) // etwaige verwaiste eigene Zeilen ignorieren
          .map((r) => (r.season === dataSeason ? { ...r, season } : { ...r }));

  if (!ugSurchargeApplies({ config, season, weekday, eventOpen })) return effective;

  for (const entry of config.ugSurcharge.entries) {
    const candidates = effective.filter(
      (r) => r.season === season && r.weekday === weekday && r.positionKey === entry.positionKey,
    );
    if (candidates.length > 0) {
      // späteste Schicht (höchste Startzeit) erhöhen.
      const target = candidates.reduce((a, b) => (b.shiftStart >= a.shiftStart ? b : a));
      effective = effective.map((r) =>
        r === target
          ? { ...r, requiredCount: r.requiredCount + entry.count, meta: { ...r.meta, ugSurcharge: entry.count } }
          : r,
      );
    } else {
      effective.push({
        ...(effective[0] ?? ({} as T)),
        id: `ug-${entry.positionKey}-${weekday}`,
        season,
        weekday,
        positionKey: entry.positionKey,
        shiftStart: '17:00',
        shiftEnd: '23:00',
        requiredCount: entry.count,
        meta: { ugSurcharge: entry.count, synthetic: true },
      } as T);
    }
  }
  return effective;
}

/** Slug für neue (individuelle) Profile aus einem Anzeigenamen. */
export function profileKeyFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? `profil_${slug}` : '';
}
