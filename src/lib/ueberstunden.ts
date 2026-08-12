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
import { loadEmployees, loadActualHoursForMonth, loadScheduleForMonth } from '@/lib/supabase-db';
import { VACATION_CODES, SICK_CODES, ACCIDENT_CODES, SKIP_CODES } from '@/lib/absence-utils';
import { loadSocialCostRates } from '@/lib/social-costs-db';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { ladeNoTimeTracking } from '@/lib/no-time-tracking';
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

/**
 * Dienstplan-Absenzcode (FE/K/U/F …) → Überstunden-Absenztyp.
 * Unbekannte Codes (z. B. FT) ⇒ null (keine Gutschrift, kein «Frei»).
 */
export function planCodeZuUeTyp(code: string | null | undefined): UeAbsenzTyp | null {
  if (!code) return null;
  if (VACATION_CODES.has(code)) return 'ferien';
  if (SICK_CODES.has(code)) return 'krank';
  if (ACCIDENT_CODES.has(code)) return 'unfall';
  if (SKIP_CODES.has(code)) return 'frei';
  return null;
}

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
  /**
   * Eintritt/Austritt (ISO) — Tage ausserhalb zählen nicht (weder Soll noch
   * Ist). FEHLENDER Eintritt (null/undefined) ⇒ MA wird NICHT gerechnet
   * (kein unterstelltes Voll-Soll), sondern nur als Hinweis geführt
   * (ohneEintritt=true, alle Werte leer).
   */
  contractStart?: string | null;
  employmentEndDate?: string | null;
  /**
   * true = «Keine Zeiterfassung erforderlich» (Personalstamm-Haken) —
   * MA ist vom Überstundenkonto AUSGENOMMEN: alle Wochen/Monate/Laufend
   * bleiben leer (–), zählt NICHT in die Totale. Reversibel über den Haken.
   */
  ausgenommen?: boolean;
  /** AG-Stundenkostensatz (CHF/h, wie Personalkosten fix); null = Lohn fehlt. */
  stundensatz?: number | null;
  /** Ist-Arbeitsstunden je ISO-Datum (MIRUS). */
  istStunden: Record<string, number>;
  /** Manuelle Absenzen je ISO-Datum (Override — sticht Dienstplan). */
  absenzen: Record<string, UeAbsenzTyp>;
  /**
   * Absenzen aus dem DIENSTPLAN je ISO-Datum (FE/K/U/F, Quelle der Wahrheit
   * wenn keine manuelle Erfassung für den Tag existiert).
   */
  planAbsenzen?: Record<string, UeAbsenzTyp>;
}

/** Tages-Aufschlüsselung einer Woche (für das Wochen-Detail beim Zellen-Klick). */
export interface UeTag {
  datum: string;
  /** false = Tag zählt nicht (vor Konto-Start/Eintritt, nach Austritt/heute, kein FIX-Monat, keine Datenbasis). */
  zaehlt: boolean;
  /** Mirus-Arbeitsstunden (0 = kein Eintrag; nur wenn zaehlt). */
  arbeitH: number | null;
  absenzTyp: UeAbsenzTyp | null;
  /** Stunden-Gutschrift der Absenz (Fe/Kr/Un = Tages-Soll, Frei = 0). */
  gutschrift: number | null;
  /** Tages-Soll (Mo–Fr = Wochen-Soll/5, Sa/So = 0; nur wenn zaehlt). */
  soll: number | null;
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
  /** Mo–So-Aufschlüsselung (für das Wochen-Detail). */
  tage: UeTag[];
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
  /** true = kein Eintrittsdatum im Personalstamm — nicht gerechnet, nur Hinweis. */
  ohneEintritt: boolean;
  /** true = per Personalstamm-Haken vom Überstundenkonto ausgenommen (Badge in der UI). */
  ausgenommen: boolean;
  /** AG-Stundenkostensatz (CHF/h); null = Lohn fehlt (Kosten dann leer). */
  stundensatz: number | null;
  /**
   * Überstunden-Kosten (CHF) = POSITIVES laufendes Saldo × Stundensatz;
   * negatives Konto = 0; keine Datenbasis oder kein Satz = null.
   */
  kosten: number | null;
}

export interface UeJahresErgebnis {
  year: number;
  mitarbeiter: UeMitarbeiterErgebnis[];
  /** Σ laufende Saldi aller MA (null = keiner hat Datenbasis). */
  totalLaufend: number | null;
  /** Σ Überstunden-Kosten (nur positive Konten; null = keine Datenbasis). */
  totalKosten: number | null;
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
  // Konto-Start: vor dem 01.07.2026 wird NICHTS gezeigt/gezählt (kein Übertrag).
  // Jahre komplett vor dem Konto-Start → explizit leeres Ergebnis (keine Wochen).
  if (yearEnd < UEBERSTUNDEN_START) {
    return {
      year,
      mitarbeiter: mitarbeiter.map(emp => ({
        id: emp.id, name: emp.name, wochenSollH: emp.wochenSollH,
        wochen: [], monatsSaldo: Array(12).fill(null), laufend: null,
        ohneEintritt: !emp.contractStart,
        ausgenommen: emp.ausgenommen === true,
        stundensatz: emp.stundensatz ?? null, kosten: null,
      })),
      totalLaufend: null,
      totalKosten: null,
    };
  }
  const kontoStart = yearStart > UEBERSTUNDEN_START ? yearStart : UEBERSTUNDEN_START;

  // Wochenliste: ISO-Wochen ab der Woche des Konto-Starts (KW27 enthält den
  // 01.07. — ihre Juni-Tage zählen NICHT ⇒ anteiliges Soll) bis Jahresende.
  const firstMonday = mondayOf(kontoStart);
  const mondays: string[] = [];
  for (let m = firstMonday; m <= yearEnd; m = addDays(m, 7)) mondays.push(m);

  const ergebnisse: UeMitarbeiterErgebnis[] = mitarbeiter.map(emp => {
    const tagesSoll = emp.wochenSollH / 5;
    const ohneEintritt = !emp.contractStart;
    /** Zählt der Tag für diesen MA? (Konto-Start, ≤heute, FIX-Monat, Anstellung) */
    const eligible = (day: string): boolean => {
      // «Keine Zeiterfassung erforderlich» → komplett ausgenommen: kein Tag
      // zählt (Soll/Ist/Laufend bleiben null, damit auch Totale unberührt).
      if (emp.ausgenommen === true) return false;
      if (ohneEintritt) return false; // kein Eintrittsdatum → nie Voll-Soll unterstellen
      if (day < kontoStart || day > ende) return false;
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
      // Datenbasis der Woche: Mandanten-weit (MIRUS-Import oder manuelle
      // Absenz) ODER — nur für DIESEN MA — eine gutschrift-fähige
      // Dienstplan-Absenz (FE/K/U) in der Woche. Fremde Dienstplan-Absenzen
      // dürfen NIE eine Woche für andere MA aktivieren (sonst −42-Drift bei
      // fehlendem MIRUS-Import); Plan-«Frei» allein aktiviert ebenfalls nicht.
      const hasData = wochenMitDaten.has(monday)
        || (!!emp.planAbsenzen && Array.from({ length: 7 }, (_, i) => addDays(monday, i))
          .some(day => {
            const t = emp.planAbsenzen![day];
            return !!t && UE_GUTSCHRIFT_TYPEN.has(t);
          }));
      let soll: number | null = null, ist: number | null = null, gut: number | null = null;
      const tage: UeTag[] = [];
      // Pass 1: Tageswerte sammeln (Absenz = manueller Override, sonst
      // Dienstplan). Roh-Gutschrift NOCH ungedeckelt.
      type TagRoh = { day: string; zaehlt: boolean; daySoll: number; work: number; typ: UeAbsenzTyp | null; rawCredit: number };
      const roh: TagRoh[] = [];
      let sollSum = 0, workSum = 0, rawCreditSum = 0;
      for (let i = 0; i < 7; i++) {
        const day = addDays(monday, i);
        if (!hasData || !eligible(day)) {
          roh.push({ day, zaehlt: false, daySoll: 0, work: 0, typ: null, rawCredit: 0 });
          continue;
        }
        const daySoll = istWochentag(day) ? tagesSoll : 0;
        const typ = emp.absenzen[day] ?? emp.planAbsenzen?.[day] ?? null;
        const rawCredit = typ && UE_GUTSCHRIFT_TYPEN.has(typ) ? tagesSoll : 0;
        const work = emp.istStunden[day] ?? 0;
        roh.push({ day, zaehlt: true, daySoll, work, typ, rawCredit });
        sollSum += daySoll; workSum += work; rawCreditSum += rawCredit;
      }
      // Deckelung (Spec 08/2026): Wochen-Gutschrift ≤ max(0, Wochen-Soll −
      // Arbeits-Ist) — Absenzen füllen höchstens bis Saldo 0, erzeugen nie
      // Plus-Überstunden. Proportional auf die Absenz-Tage verteilt (Monats-
      // Splits bleiben tageanteilig konsistent).
      const capFaktor = rawCreditSum > 0
        ? Math.min(1, Math.max(0, sollSum - workSum) / rawCreditSum)
        : 1;
      for (const t of roh) {
        if (!t.zaehlt) {
          tage.push({ datum: t.day, zaehlt: false, arbeitH: null, absenzTyp: null, gutschrift: null, soll: null });
          continue;
        }
        const credit = t.rawCredit * capFaktor;
        const dayIst = t.work + credit;
        tage.push({ datum: t.day, zaehlt: true, arbeitH: t.work, absenzTyp: t.typ, gutschrift: credit, soll: t.daySoll });
        soll = (soll ?? 0) + t.daySoll;
        ist = (ist ?? 0) + dayIst;
        gut = (gut ?? 0) + credit;
        const dSaldo = dayIst - t.daySoll;
        // Monats-Zuordnung: tageanteilig (Wochen an Monatsgrenzen gesplittet)
        if (t.day >= yearStart && t.day <= yearEnd) {
          const mIdx = Number(t.day.slice(5, 7)) - 1;
          monatsSaldo[mIdx] = (monatsSaldo[mIdx] ?? 0) + dSaldo;
        }
        // Laufendes Konto: Kumulation ab Juli 2026
        if (t.day >= UEBERSTUNDEN_START) laufend = (laufend ?? 0) + dSaldo;
      }
      const saldo = soll !== null && ist !== null ? ist - soll : null;
      wochen.push({
        label: `KW ${kw}`, kw, kwYear, monday,
        soll, ist, saldo, gutschrift: gut, hasData, tage,
      });
    }

    const stundensatz = emp.stundensatz ?? null;
    // Kosten = POSITIVES laufendes Saldo × AG-Satz; negativ/0 → 0 CHF;
    // keine Datenbasis oder kein Satz → leer (null), nie stille 0.
    const kosten = laufend === null || stundensatz === null
      ? null
      : laufend > 0 ? Math.round(laufend * stundensatz * 100) / 100 : 0;
    return {
      id: emp.id, name: emp.name, wochenSollH: emp.wochenSollH,
      wochen, monatsSaldo, laufend, ohneEintritt, stundensatz, kosten,
      ausgenommen: emp.ausgenommen === true,
    };
  });

  const mitDaten = ergebnisse.filter(e => e.laufend !== null);
  const totalLaufend = mitDaten.length === 0
    ? null
    : mitDaten.reduce((s, e) => s + (e.laufend ?? 0), 0);
  const mitKosten = ergebnisse.filter(e => e.kosten !== null);
  const totalKosten = mitKosten.length === 0
    ? null
    : Math.round(mitKosten.reduce((s, e) => s + (e.kosten ?? 0), 0) * 100) / 100;
  return { year, mitarbeiter: ergebnisse, totalLaufend, totalKosten };
}

// ── Datenlader (DB → reine Berechnung) ────────────────────────────────────────

export interface UeJahresDaten {
  ergebnis: UeJahresErgebnis;
  /** Wochen-Montage mit Datenbasis (für die UI-Legende). */
  wochenMitDaten: Set<string>;
  /** Fix-MA des Jahres (Union aller Monate) für die Absenz-Erfassung. */
  fixEmployees: Employee[];
  absenzen: UeAbsenzenBlob;
  /**
   * ISO-Daten (≤ heute) mit Mirus-Datenbasis (Mandanten-weit) — für die
   * Import-Ampel je KW (voll/teilweise/nicht importiert).
   */
  tageMitDaten: Set<string>;
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
  // Konto startet 01.07.2026 → im Startjahr Monate vor Juli gar nicht laden.
  const startJahr = Number(UEBERSTUNDEN_START.slice(0, 4));
  const minMonat = year < startJahr ? 13 : year === startJahr ? Number(UEBERSTUNDEN_START.slice(5, 7)) : 1;
  const fixMonate = new Map<string, Set<number>>();
  const empById = new Map<string, Employee>();
  for (let m = minMonat; m <= maxMonat; m++) {
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
    Array.from({ length: Math.max(0, maxMonat - minMonat + 1) },
      (_, i) => loadActualHoursForMonth(new Date(year, minMonat - 1 + i, 15), tenantId)),
  );
  const istProEmp = new Map<string, Record<string, number>>();
  const wochenMitDaten = new Set<string>();
  const tageMitDaten = new Set<string>();
  for (const res of monthResults) {
    if (!res) continue;
    for (const [key, entry] of Object.entries(res)) {
      // key = `${employeeId}-${date}` — Datum sind die letzten 10 Zeichen.
      const date = key.slice(-10);
      const empId = key.slice(0, -11);
      if (date > heute) continue; // Stand bis heute; schützt vor Geister-Zukunftszeilen
      wochenMitDaten.add(mondayOf(date));
      tageMitDaten.add(date);
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

  // Dienstplan-Absenzen (FE/K/U/F) — Quelle der Wahrheit, wenn keine manuelle
  // Erfassung existiert (Override-Vorrang liegt in berechneUeberstundenJahr).
  // Mandanten-gefiltert. WICHTIG: Plan-Absenzen aktivieren die Woche NICHT
  // mandanten-weit (kein Eintrag in wochenMitDaten) — nur der betroffene MA
  // selbst zählt die Woche (per-MA-Prüfung in berechneUeberstundenJahr),
  // sonst entstünde ein −42-Drift für andere MA ohne MIRUS-Import.
  const planProEmp = new Map<string, Record<string, UeAbsenzTyp>>();
  const scheduleResults = await Promise.all(
    Array.from({ length: Math.max(0, maxMonat - minMonat + 1) },
      (_, i) => loadScheduleForMonth(new Date(year, minMonat - 1 + i, 15), tenantId)),
  );
  for (const res of scheduleResults) {
    if (!res) continue;
    for (const [key, dayPlan] of Object.entries(res)) {
      const date = key.slice(-10);
      const empId = key.slice(0, -11);
      if (date > heute) continue; // Stand bis heute (geplante Zukunft zählt nicht)
      if (!fixMonate.has(empId)) continue;
      const typ = planCodeZuUeTyp(dayPlan.frühAbsence) ?? planCodeZuUeTyp(dayPlan.spätAbsence);
      if (!typ) continue;
      const rec = planProEmp.get(empId) ?? {};
      rec[date] = typ;
      planProEmp.set(empId, rec);
    }
  }

  // AG-Stundenkostensatz (gleiche Basis wie Personalkosten fix): zentrale
  // Sozialkostensätze des Mandanten + employee-rate-SSOT.
  const ratesBlob = await loadSocialCostRates(tenantId).catch(() => null);
  const rates = ratesBlob?.rates ?? null;

  // «Keine Zeiterfassung erforderlich» (Personalstamm-Haken, KV, mandanten-
  // getrennt) → MA erscheint in der Liste, aber ohne Konto (Badge in der UI).
  const ausgenommenMap = await ladeNoTimeTracking(tenantId);

  const inputs: UeMitarbeiterInput[] = [...fixMonate.entries()].map(([id, monate]) => {
    const e = empById.get(id)!;
    return {
      stundensatz: rates ? getEffectiveHourlyRate(e, rates) : null,
      ausgenommen: ausgenommenMap[id] === true,
      id,
      name: e.name ?? id,
      wochenSollH: typeof e.weeklyHours === 'number' && e.weeklyHours > 0 ? e.weeklyHours : VOLLZEIT_WOCHE_H,
      fixMonate: monate,
      contractStart: e.contractStart ?? null,
      employmentEndDate: e.employmentEndDate ?? null,
      istStunden: istProEmp.get(id) ?? {},
      absenzen: absenzen.entries[id] ?? {},
      planAbsenzen: planProEmp.get(id) ?? {},
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const ergebnis = berechneUeberstundenJahr(year, inputs, wochenMitDaten, heute);
  const fixEmployees = inputs.map(i => empById.get(i.id)!).filter(Boolean);
  return { ergebnis, wochenMitDaten, fixEmployees, absenzen, tageMitDaten };
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

export interface UeTotals {
  /** Σ laufender Saldo (h) aller Fix-MA; null = keine Datenbasis. */
  stunden: number | null;
  /** Σ Überstunden-Kosten (CHF, nur positive Konten); null = keine Datenbasis. */
  kosten: number | null;
}

const totalCache = new Map<string, { at: number; value: UeTotals }>();
const jahrCache = new Map<string, { at: number; daten: UeJahresDaten | null }>();
export function ueberstundenTotalCacheLeeren(): void { totalCache.clear(); jahrCache.clear(); }

/** Jahresdaten mit Kurzzeit-Cache (gleiche TTL wie das Total). */
async function ladeUeberstundenJahrCached(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  year: number,
  heute: string,
): Promise<UeJahresDaten | null> {
  const key = `${tenantId}|${year}|${heute}`;
  const hit = jahrCache.get(key);
  if (hit && Date.now() - hit.at < TOTAL_CACHE_TTL_MS) return hit.daten;
  const daten = await ladeUeberstundenJahr(tenantId, tenantKey, year, heute);
  jahrCache.set(key, { at: Date.now(), daten });
  return daten;
}

export interface UePeriodenWerte {
  /** Σ Perioden-Saldo (h) aller Fix-MA; null = keine Datenbasis in der Periode. */
  stunden: number | null;
  /** Σ max(0, Perioden-Saldo) × AG-Satz je MA; null = keine Datenbasis/kein Satz. */
  kosten: number | null;
}

function bewertePeriode(
  saldi: Array<{ saldo: number | null; satz: number | null }>,
): UePeriodenWerte {
  let stunden: number | null = null;
  let kosten: number | null = null;
  for (const { saldo, satz } of saldi) {
    if (saldo === null) continue;
    stunden = (stunden ?? 0) + saldo;
    if (satz !== null) {
      const k = saldo > 0 ? Math.round(saldo * satz * 100) / 100 : 0;
      kosten = Math.round(((kosten ?? 0) + k) * 100) / 100;
    }
  }
  if (stunden !== null) stunden = Math.round(stunden * 100) / 100;
  return { stunden, kosten };
}

/**
 * Perioden-Werte für das Cockpit: Saldo/Kosten NUR der angezeigten Periode
 * (Woche = Saldo genau dieser ISO-Woche, Monat = Monats-Saldo, Jahr =
 * laufendes Saldo des Jahres) — NICHT das kumulierte Konto. Kosten = Σ
 * max(0, Perioden-Saldo) × AG-Satz je MA. Nicht importierte Wochen zählen
 * nicht (Saldo null). null = keine Datenbasis, nie stille 0.
 */
export async function ladeUeberstundenPeriode(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  opts: { year: number; month: number; weekMonday: string | null },
  heute: string = iso(new Date()),
): Promise<{ monat: UePeriodenWerte; woche: UePeriodenWerte; jahr: UePeriodenWerte }> {
  const leer: UePeriodenWerte = { stunden: null, kosten: null };
  const jahrDaten = await ladeUeberstundenJahrCached(tenantId, tenantKey, opts.year, heute);
  const mas = jahrDaten?.ergebnis.mitarbeiter ?? [];
  const monat = bewertePeriode(mas.map(m => ({ saldo: m.monatsSaldo[opts.month - 1] ?? null, satz: m.stundensatz })));
  const jahr = bewertePeriode(mas.map(m => ({ saldo: m.laufend, satz: m.stundensatz })));
  let woche = leer;
  if (opts.weekMonday) {
    // Auf den ISO-Montag normalisieren (z.B. «letzte 7 Tage» liefert einen
    // rollierenden Starttag, keinen Montag).
    const monday = mondayOf(opts.weekMonday);
    const sonntag = addDays(monday, 6);
    // Dez/Jan-Wochen liegen in ZWEI Kalenderjahren: berechneUeberstundenJahr
    // schneidet am Jahresende ab, daher beide Jahres-Teilsaldi derselben
    // Woche (gleicher Montag) je MA aufsummieren.
    const jahre = [...new Set([Number(monday.slice(0, 4)), Number(sonntag.slice(0, 4))])];
    const proMa = new Map<string, { saldo: number | null; satz: number | null }>();
    for (const y of jahre) {
      const daten = y === opts.year ? jahrDaten
        : await ladeUeberstundenJahrCached(tenantId, tenantKey, y, heute);
      for (const m of daten?.ergebnis.mitarbeiter ?? []) {
        const s = m.wochen.find(w => w.monday === monday)?.saldo ?? null;
        const cur = proMa.get(m.id) ?? { saldo: null, satz: null };
        if (s !== null) cur.saldo = (cur.saldo ?? 0) + s;
        if (m.stundensatz !== null) cur.satz = m.stundensatz;
        proMa.set(m.id, cur);
      }
    }
    woche = bewertePeriode([...proMa.values()]);
  }
  return { monat, woche, jahr };
}

export async function ladeUeberstundenTotals(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  heute: string = iso(new Date()),
): Promise<UeTotals> {
  const cacheKey = `${tenantId}|${heute}`;
  const hit = totalCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TOTAL_CACHE_TTL_MS) return hit.value;
  const startJahr = Number(UEBERSTUNDEN_START.slice(0, 4));
  const endJahr = Number(heute.slice(0, 4));
  if (endJahr < startJahr) return { stunden: null, kosten: null };
  // Laufendes KONTO über Jahre: erst je MA über alle Jahre konsolidieren
  // (negatives Altjahr verrechnet sich mit positivem Folgejahr), DANN
  // max(0, Saldo) × Satz bewerten — nie Jahres-Kosten aufsummieren.
  const konto = new Map<string, { laufend: number; satz: number | null }>();
  for (let y = startJahr; y <= endJahr; y++) {
    const daten = await ladeUeberstundenJahr(tenantId, tenantKey, y, heute);
    for (const m of daten?.ergebnis.mitarbeiter ?? []) {
      if (m.laufend === null) continue;
      const cur = konto.get(m.id) ?? { laufend: 0, satz: null };
      cur.laufend += m.laufend;
      // Satz des jüngsten Jahres mit Datenbasis gilt für den Stichtag.
      if (m.stundensatz !== null) cur.satz = m.stundensatz;
      konto.set(m.id, cur);
    }
  }
  let stunden: number | null = null;
  let kosten: number | null = null;
  for (const { laufend, satz } of konto.values()) {
    stunden = (stunden ?? 0) + laufend;
    if (satz !== null) {
      const k = laufend > 0 ? Math.round(laufend * satz * 100) / 100 : 0;
      kosten = Math.round(((kosten ?? 0) + k) * 100) / 100;
    }
  }
  const value: UeTotals = { stunden, kosten };
  totalCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Rückwärtskompatibel: nur die Stunden (Cockpit-Zeile «Überstunden total»). */
export async function ladeUeberstundenTotal(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  heute: string = iso(new Date()),
): Promise<number | null> {
  return (await ladeUeberstundenTotals(tenantId, tenantKey, heute)).stunden;
}
