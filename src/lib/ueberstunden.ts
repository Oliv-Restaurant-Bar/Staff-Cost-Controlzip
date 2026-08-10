/**
 * Überstunden-Konto pro FIX-Mitarbeiter (je Mandant)
 * ===================================================
 * Kernlogik + Datenlader für die Ansicht «Überstunden» und die Cockpit-Zeile
 * «Überstunden total».
 *
 * Modell (Spec 08/2026):
 *  - Nur FIX-Mitarbeiter (Monatslohn) — Lohnart-SSOT je Monat via
 *    applyEffectiveWagesForMonth (gleiche Auflösung wie Personalkosten).
 *  - Wochen-Soll = Pensum × 42 h = employee.weeklyHours (Stammsatz, 100 % = 42).
 *    Tages-Soll (Mo–Fr) = Wochen-Soll / 5 (100 % = 8.4 h). Sa/So = 0 Soll.
 *  - Ist = MIRUS-Arbeitsstunden (actual_hours) + Absenz-Gutschriften.
 *  - Absenzen (manuell, eigener KV-Blob je Jahr): Ferien/Krank/Unfall =
 *    +Wochen-Soll/5 pro Tag (Pensum-skaliert); Frei oder kein Eintrag = 0.
 *  - Saldo je Woche = Ist − Soll; Monat = tageanteilige Summe (Wochen an
 *    Monatsgrenzen über die Tages-Zuordnung gesplittet); LAUFEND = Kumulation
 *    ab Juli 2026 (davor kein Übertrag) bis heute.
 *  - leer statt 0: Wochen OHNE Datenbasis (kein actual_hours-Eintrag des
 *    Mandanten und keine Absenz-Einträge in der Woche) zählen NIRGENDS mit —
 *    weder Soll noch Ist (kein stiller −42-Drift bei fehlendem Import).
 *  - Tage zählen nur bis HEUTE (Stand-bis-heute-Konto; schützt zugleich vor
 *    Geister-Zukunftszeilen in actual_hours).
 *
 * Reine Rechenlogik (berechneUeberstundenJahr) ist DB-frei und testbar.
 */

import { kvGet, kvGetStrict, kvSetStrict } from '@/lib/supabase-kv';
import { loadEmployees, loadActualHoursForMonth } from '@/lib/supabase-db';
import { applyEffectiveWagesForMonth } from '@/lib/wage-history';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { pkHasFixedSalary } from '@/lib/personalkosten';
import type { Employee } from '@/types/personnel';
import type { TenantId } from '@/contexts/TenantContext';

/** Start des laufenden Überstundenkontos (kein Übertrag davor). */
export const UEBERSTUNDEN_START = '2026-07-01';
/** Vollzeit-Basis (100 % Pensum) in h/Woche. */
export const VOLLZEIT_WOCHE_H = 42;

// ── Absenzen-Blob (manuelle Eingabe, je Mandant & Jahr) ───────────────────────

export type UeAbsenzTyp = 'ferien' | 'krank' | 'unfall' | 'frei';

export const UE_ABSENZ_LABELS: Record<UeAbsenzTyp, string> = {
  ferien: 'Ferien', krank: 'Krank', unfall: 'Unfall', frei: 'Frei',
};

/** Absenz-Typen mit Stunden-Gutschrift (Frei = 0). */
export const UE_GUTSCHRIFT_TYPEN: ReadonlySet<UeAbsenzTyp> = new Set(['ferien', 'krank', 'unfall']);

export interface UeAbsenzenBlob {
  year: number;
  /** empId → ISO-Datum → Typ. */
  entries: Record<string, Record<string, UeAbsenzTyp>>;
  /** Vorzustand des letzten Speicherns (einstufiges Rückgängig). */
  prev?: Record<string, Record<string, UeAbsenzTyp>>;
  updatedAt?: string;
}

const ABSENZ_KEY = (year: number) => `ueberstunden-absenzen:${year}`;

export function leererAbsenzenBlob(year: number): UeAbsenzenBlob {
  return { year, entries: {} };
}

/** Lädt den Absenzen-Blob des Jahres (fehlend/Fehler → leer, überschreibt nichts). */
export async function ladeUeAbsenzen(
  tenantKey: (k: string) => string, year: number,
): Promise<UeAbsenzenBlob> {
  const raw = (await kvGet(tenantKey(ABSENZ_KEY(year)))) as UeAbsenzenBlob | null;
  if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
    return leererAbsenzenBlob(year);
  }
  return { year, entries: raw.entries, prev: raw.prev, updatedAt: raw.updatedAt };
}

/**
 * STRIKTES Lesen für Schreibpfade (Save/Undo): Lesefehler ≠ leer — wirft,
 * damit nie ein leerer Pseudo-Stand einen echten Remote-Blob überschreibt.
 * Nur «Key existiert nicht» (null ohne Fehler) ergibt einen leeren Blob.
 */
export async function ladeUeAbsenzenStrict(
  tenantKey: (k: string) => string, year: number,
): Promise<UeAbsenzenBlob> {
  const raw = (await kvGetStrict(tenantKey(ABSENZ_KEY(year)))) as UeAbsenzenBlob | null;
  if (raw === null) return leererAbsenzenBlob(year);
  if (typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
    return leererAbsenzenBlob(year);
  }
  return { year, entries: raw.entries, prev: raw.prev, updatedAt: raw.updatedAt };
}

/** Konflikt beim Speichern (Remote-Stand hat sich seit dem Lesen geändert). */
export class UeAbsenzenKonflikt extends Error {
  constructor() { super('Absenzen wurden zwischenzeitlich geändert — bitte neu laden und erneut speichern.'); }
}

/**
 * Speichert den Blob strikt (wirft bei Fehler — kein stiller Verlust).
 * @param erwartetUpdatedAt Stale-Wache: unmittelbar vor dem Write wird der
 *        Remote-Stand strikt gelesen; weicht dessen updatedAt ab, wird mit
 *        UeAbsenzenKonflikt abgebrochen (kein Vollblob-Überschreiben fremder
 *        Änderungen; kein echtes CAS im KV — bewusst enges Fenster).
 */
export async function speichereUeAbsenzen(
  tenantKey: (k: string) => string, blob: UeAbsenzenBlob,
  erwartetUpdatedAt?: string | undefined,
): Promise<void> {
  const remote = await ladeUeAbsenzenStrict(tenantKey, blob.year);
  if ((remote.updatedAt ?? undefined) !== erwartetUpdatedAt) throw new UeAbsenzenKonflikt();
  await kvSetStrict(tenantKey(ABSENZ_KEY(blob.year)), { ...blob, updatedAt: new Date().toISOString() });
  ueberstundenTotalCacheLeeren();
}

// ── Datums-Helfer (TZ-sicher über Mittags-Dates) ─────────────────────────────

function d(iso: string): Date { return new Date(iso + 'T12:00:00'); }
function iso(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Montag der ISO-Woche des Datums. */
export function mondayOf(isoDate: string): string {
  const dt = d(isoDate);
  const wd = (dt.getDay() + 6) % 7; // Mo=0
  dt.setDate(dt.getDate() - wd);
  return iso(dt);
}

/** ISO-KW-Nummer + KW-Jahr eines Datums. */
export function isoWeekOf(isoDate: string): { kw: number; kwYear: number } {
  const mon = d(mondayOf(isoDate));
  const thu = new Date(mon); thu.setDate(mon.getDate() + 3);
  const kwYear = thu.getFullYear();
  const jan4 = new Date(kwYear, 0, 4, 12);
  const mon1 = d(mondayOf(iso(jan4)));
  const kw = Math.round((mon.getTime() - mon1.getTime()) / (7 * 86400000)) + 1;
  return { kw, kwYear };
}

/** Mo–Fr? */
export function istWochentag(isoDate: string): boolean {
  const wd = d(isoDate).getDay();
  return wd >= 1 && wd <= 5;
}

function addDays(isoDate: string, n: number): string {
  const dt = d(isoDate); dt.setDate(dt.getDate() + n); return iso(dt);
}

// ── Reine Berechnung ──────────────────────────────────────────────────────────

/** Eingabe je Mitarbeiter (rein, DB-frei). */
export interface UeMitarbeiterInput {
  id: string;
  name: string;
  /** Wochen-Soll in h (= Pensum × 42, aus weeklyHours). */
  wochenSollH: number;
  /** Monate (1–12), in denen der MA als FIX zählt (Lohnart-SSOT je Monat). */
  fixMonate: ReadonlySet<number>;
  /** Eintritt/Austritt (ISO) — Tage ausserhalb zählen nicht. */
  contractStart?: string | null;
  employmentEndDate?: string | null;
  /** Ist-Arbeitsstunden je ISO-Datum (MIRUS). */
  istStunden: Record<string, number>;
  /** Manuelle Absenzen je ISO-Datum. */
  absenzen: Record<string, UeAbsenzTyp>;
}

export interface UeWoche {
  /** z. B. 'KW 32' */
  label: string;
  kw: number;
  kwYear: number;
  /** Montag der Woche (ISO). */
  monday: string;
  soll: number | null;
  ist: number | null;
  saldo: number | null;
  /** Gutschrift-Anteil im Ist (Fe/Kr/Un). */
  gutschrift: number | null;
  hasData: boolean;
}

export interface UeMitarbeiterErgebnis {
  id: string;
  name: string;
  wochenSollH: number;
  wochen: UeWoche[];
  /** Monats-Saldo je Monat 1–12 (null = keine Datenbasis im Monat). */
  monatsSaldo: Array<number | null>;
  /** Laufendes Konto ab Juli 2026 bis heute (null = gar keine Datenbasis). */
  laufend: number | null;
}

export interface UeJahresErgebnis {
  year: number;
  mitarbeiter: UeMitarbeiterErgebnis[];
  /** Σ laufende Saldi aller MA (null = keiner hat Datenbasis). */
  totalLaufend: number | null;
}

/**
 * Kern: berechnet Wochen/Monats/Laufend-Saldi eines Jahres.
 * @param wochenMitDaten Menge der Wochen-Montage (ISO) MIT Datenbasis
 *        (Mandanten-weit: irgendein actual_hours-Eintrag oder Absenz-Eintrag).
 * @param heute ISO-Datum «heute» — Tage danach zählen nicht.
 */
export function berechneUeberstundenJahr(
  year: number,
  mitarbeiter: UeMitarbeiterInput[],
  wochenMitDaten: ReadonlySet<string>,
  heute: string,
): UeJahresErgebnis {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const ende = heute < yearEnd ? heute : yearEnd;

  // Wochenliste des Jahres: alle ISO-Wochen, deren Tage das Jahr berühren.
  const firstMonday = mondayOf(yearStart);
  const mondays: string[] = [];
  for (let m = firstMonday; m <= yearEnd; m = addDays(m, 7)) mondays.push(m);

  const ergebnisse: UeMitarbeiterErgebnis[] = mitarbeiter.map(emp => {
    const tagesSoll = emp.wochenSollH / 5;
    /** Zählt der Tag für diesen MA? (Jahr, ≤heute, FIX-Monat, Anstellung) */
    const eligible = (day: string): boolean => {
      if (day < yearStart || day > ende) return false;
      const monat = Number(day.slice(5, 7));
      if (!emp.fixMonate.has(monat)) return false;
      if (emp.contractStart && day < emp.contractStart) return false;
      if (emp.employmentEndDate && day > emp.employmentEndDate) return false;
      return true;
    };

    const wochen: UeWoche[] = [];
    const monatsSaldo: Array<number | null> = Array(12).fill(null);
    let laufend: number | null = null;

    for (const monday of mondays) {
      const { kw, kwYear } = isoWeekOf(monday);
      const hasData = wochenMitDaten.has(monday);
      let soll: number | null = null, ist: number | null = null, gut: number | null = null;
      for (let i = 0; i < 7; i++) {
        const day = addDays(monday, i);
        if (!hasData || !eligible(day)) continue;
        const daySoll = istWochentag(day) ? tagesSoll : 0;
        const typ = emp.absenzen[day];
        const credit = typ && UE_GUTSCHRIFT_TYPEN.has(typ) ? tagesSoll : 0;
        const work = emp.istStunden[day] ?? 0;
        const dayIst = work + credit;
        soll = (soll ?? 0) + daySoll;
        ist = (ist ?? 0) + dayIst;
        gut = (gut ?? 0) + credit;
        const dSaldo = dayIst - daySoll;
        // Monats-Zuordnung: tageanteilig (Wochen an Monatsgrenzen gesplittet)
        if (day >= yearStart && day <= yearEnd) {
          const mIdx = Number(day.slice(5, 7)) - 1;
          monatsSaldo[mIdx] = (monatsSaldo[mIdx] ?? 0) + dSaldo;
        }
        // Laufendes Konto: Kumulation ab Juli 2026
        if (day >= UEBERSTUNDEN_START) laufend = (laufend ?? 0) + dSaldo;
      }
      const saldo = soll !== null && ist !== null ? ist - soll : null;
      wochen.push({
        label: `KW ${kw}`, kw, kwYear, monday,
        soll, ist, saldo, gutschrift: gut, hasData,
      });
    }

    return {
      id: emp.id, name: emp.name, wochenSollH: emp.wochenSollH,
      wochen, monatsSaldo, laufend,
    };
  });

  const mitDaten = ergebnisse.filter(e => e.laufend !== null);
  const totalLaufend = mitDaten.length === 0
    ? null
    : mitDaten.reduce((s, e) => s + (e.laufend ?? 0), 0);
  return { year, mitarbeiter: ergebnisse, totalLaufend };
}

// ── Datenlader (DB → reine Berechnung) ────────────────────────────────────────

export interface UeJahresDaten {
  ergebnis: UeJahresErgebnis;
  /** Wochen-Montage mit Datenbasis (für die UI-Legende). */
  wochenMitDaten: Set<string>;
  /** Fix-MA des Jahres (Union aller Monate) für die Absenz-Erfassung. */
  fixEmployees: Employee[];
  absenzen: UeAbsenzenBlob;
}

/**
 * Lädt alles für die Jahres-Ansicht: Mitarbeiter (FIX je Monat via Lohn-SSOT),
 * Ist-Stunden (actual_hours, 12 Monate), Absenzen-Blob — und rechnet.
 */
export async function ladeUeberstundenJahr(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  year: number,
  heute: string = iso(new Date()),
): Promise<UeJahresDaten | null> {
  const emps = await loadEmployees(tenantId);
  if (emps === null) return null; // DB nicht erreichbar → leer, nie stiller 0-Zustand

  // FIX-Zuordnung je Monat (Lohnart-SSOT) — nur Monate ≤ heute laden.
  const heuteJahr = Number(heute.slice(0, 4));
  const maxMonat = year < heuteJahr ? 12 : year > heuteJahr ? 0 : Number(heute.slice(5, 7));
  const fixMonate = new Map<string, Set<number>>();
  const empById = new Map<string, Employee>();
  for (let m = 1; m <= maxMonat; m++) {
    const { employees } = await applyEffectiveWagesForMonth(emps, year, m, tenantId);
    for (const e of employees) {
      if (!isEmployeeActiveInMonth(e, year, m) || !pkHasFixedSalary(e)) continue;
      const id = String(e.id);
      if (!fixMonate.has(id)) { fixMonate.set(id, new Set()); empById.set(id, e); }
      fixMonate.get(id)!.add(m);
    }
  }

  // Ist-Stunden aller Monate (parallel) + Wochen mit Datenbasis (Mandanten-weit).
  const monthResults = await Promise.all(
    Array.from({ length: maxMonat }, (_, i) => loadActualHoursForMonth(new Date(year, i, 15), tenantId)),
  );
  const istProEmp = new Map<string, Record<string, number>>();
  const wochenMitDaten = new Set<string>();
  for (const res of monthResults) {
    if (!res) continue;
    for (const [key, entry] of Object.entries(res)) {
      // key = `${employeeId}-${date}` — Datum sind die letzten 10 Zeichen.
      const date = key.slice(-10);
      const empId = key.slice(0, -11);
      if (date > heute) continue; // Stand bis heute; schützt vor Geister-Zukunftszeilen
      wochenMitDaten.add(mondayOf(date));
      if (!fixMonate.has(empId)) continue;
      const h = typeof entry.hours === 'number' && Number.isFinite(entry.hours) ? entry.hours : 0;
      if (h <= 0) continue;
      const rec = istProEmp.get(empId) ?? {};
      rec[date] = (rec[date] ?? 0) + h;
      istProEmp.set(empId, rec);
    }
  }

  const absenzen = await ladeUeAbsenzen(tenantKey, year);
  for (const perEmp of Object.values(absenzen.entries)) {
    for (const date of Object.keys(perEmp)) {
      if (date <= heute) wochenMitDaten.add(mondayOf(date));
    }
  }

  const inputs: UeMitarbeiterInput[] = [...fixMonate.entries()].map(([id, monate]) => {
    const e = empById.get(id)!;
    return {
      id,
      name: e.name ?? id,
      wochenSollH: typeof e.weeklyHours === 'number' && e.weeklyHours > 0 ? e.weeklyHours : VOLLZEIT_WOCHE_H,
      fixMonate: monate,
      contractStart: (e as { contractStart?: string | null }).contractStart ?? null,
      employmentEndDate: e.employmentEndDate ?? null,
      istStunden: istProEmp.get(id) ?? {},
      absenzen: absenzen.entries[id] ?? {},
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const ergebnis = berechneUeberstundenJahr(year, inputs, wochenMitDaten, heute);
  const fixEmployees = inputs.map(i => empById.get(i.id)!).filter(Boolean);
  return { ergebnis, wochenMitDaten, fixEmployees, absenzen };
}

/**
 * Cockpit-Zeile «Überstunden total»: Σ laufender Saldo aller Fix-MA ab Juli
 * 2026 bis heute (über alle betroffenen Jahre). null = keine Datenbasis.
 */
// Kurzzeit-Cache je Mandant+Stichtag: Der Monatsreport ruft den Lader bei
// jedem Rendern/Monatswechsel auf — der Voll-Jahres-Scan (Lohn-Auflösungen +
// actual_hours) darf nicht jedes Mal laufen. TTL kurz, Invalidierung beim
// Absenzen-Speichern (gleicher Tab); Mirus-Importe schlagen spätestens nach
// Ablauf der TTL durch.
const TOTAL_CACHE_TTL_MS = 5 * 60 * 1000;
const totalCache = new Map<string, { at: number; value: number | null }>();
export function ueberstundenTotalCacheLeeren(): void { totalCache.clear(); }

export async function ladeUeberstundenTotal(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  heute: string = iso(new Date()),
): Promise<number | null> {
  const cacheKey = `${tenantId}|${heute}`;
  const hit = totalCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TOTAL_CACHE_TTL_MS) return hit.value;
  const startJahr = Number(UEBERSTUNDEN_START.slice(0, 4));
  const endJahr = Number(heute.slice(0, 4));
  if (endJahr < startJahr) return null;
  let total: number | null = null;
  for (let y = startJahr; y <= endJahr; y++) {
    const daten = await ladeUeberstundenJahr(tenantId, tenantKey, y, heute);
    const t = daten?.ergebnis.totalLaufend ?? null;
    if (t !== null) total = (total ?? 0) + t;
  }
  totalCache.set(cacheKey, { at: Date.now(), value: total });
  return total;
}
