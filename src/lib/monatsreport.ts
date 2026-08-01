/**
 * Monatsreport — zentrale Datenaufbereitung fürs Meeting-Cockpit
 * ==============================================================
 * Etappe 1: nur automatisch füllbare Zeilen. Fehlende Quellen bleiben null
 * (werden in der UI/Excel leer dargestellt, nie als 0 erfunden).
 *
 * Quellen (alles vorhandene, keine neuen Tabellen):
 *  - Umsatz (brutto/netto/TA/Food/Beverage): kanonische Quelle src/lib/umsatz.ts
 *    (gn_imports Tages-Z-Berichte + gn_discounts Marketing) — SSOT, identisch
 *    mit den Personalkosten
 *  - Gäste:                   gaeste-daily-KV (manueller GÄSTE-Import, Zeile «Gesamt»)
 *  - Durchschnittsverkauf:    avgcheck-monthly/-daily-KV (manueller Import, Zeile «Durchschnitt»)
 *  - Reservierte Gäste / Gruppen ab N Pax: reservation_records (Foratable-Import)
 *    via reservation-cockpit-metrics; Zählregel (Status) + Schwelle zentral aus
 *    reservation-cockpit-settings (app_settings, pro Tenant). Zukunft inklusive.
 *  - Budget:                  budget_v1 (P&L pl_revenue, netto) via getMonthlyBudgetRevenue
 *  - Wochenanteil Budget:     Wochentagsgewichte (ladeWochentagsGewichte, Fallback gleichmässig)
 *  - Vorjahr:                 vj_daily (app_settings) via loadVjDailyMonth
 *  - Stunden Ist/Plan:        ladePersonalkostenDaten (MIRUS actual_hours / Dienstplan)
 */
import { supabase } from '@/integrations/supabase/client';
import { ladeUmsatzTage, nettoUmsatzTag, foodBeverageSplit } from '@/lib/umsatz';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import { computeMonthlyDailyBudgets } from '@/lib/budget-day';
import {
  ladeWochentagsGewichte, ladePersonalkostenDaten,
  personalkosten, personalquote, fixKosten, flexKostenProTagDetail, budgetZielQuote,
} from '@/lib/personalkosten';
import { loadGaesteDaily, loadAvgCheckDaily, loadAvgCheckMonthly } from '@/lib/gaeste-store';
import { loadVjDailyMonth, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { loadReservationCounting, DEFAULT_RESERVATION_COUNTING } from '@/lib/reservation-cockpit-settings';
import { loadTakeAwayOffered, filterTakeAwayRows } from '@/lib/takeaway-offered-settings';
import { loadReservationMetrics } from '@/lib/reservation-cockpit-metrics';
import { loadTakeAwayGuests } from '@/lib/takeaway-cockpit-metrics';
import type { TenantId } from '@/contexts/TenantContext';
import type { SocialCostRates } from '@/lib/social-costs';
import { loadVorjahresPersonalkosten } from '@/lib/vorjahres-personalkosten';
import { loadStaffingRequirements } from '@/lib/staffing-requirements-db';
import { loadStaffingProfilesConfig } from '@/lib/staffing-profiles-db';
import { loadPositions } from '@/lib/positions-db';
import {
  bedarfNettoHoursForDates,
  planNettoHoursForDates,
  istHoursForDates,
} from '@/lib/bedarf-stunden-utils';
import { loadEmployees, loadScheduleForMonth, loadActualHoursForMonth } from '@/lib/supabase-db';
import { fetchReviewsData, countReviewsByStar, type SingleReview } from '@/lib/reviews-store';
import { FEEDBACK_PLATFORM } from '@/lib/feedback-import';

/**
 * Zeilendefinitionen der Rezensions-Blöcke: pro Plattform (Google, Lunchgate)
 * ALLE fünf Sternstufen (5→1). Farbe: 5 grün, 1 rot, dazwischen neutral.
 * IDs: google_5_sterne … google_1_stern (bestehende IDs bleiben stabil),
 * lunchgate_5_sterne … lunchgate_1_stern.
 */
export function reviewStarRowDefs(): Array<{
  platform: string; star: number; id: string; label: string; tint: 'green' | 'red' | undefined;
}> {
  const defs: Array<{ platform: string; star: number; id: string; label: string; tint: 'green' | 'red' | undefined }> = [];
  for (const platform of ['Google', FEEDBACK_PLATFORM]) {
    const slug = platform.toLowerCase();
    for (const star of [5, 4, 3, 2, 1]) {
      defs.push({
        platform, star,
        id: `${slug}_${star}_${star === 1 ? 'stern' : 'sterne'}`,
        label: `${platform} ${star} ${star === 1 ? 'Stern' : 'Sterne'}`,
        tint: star === 5 ? 'green' : star === 1 ? 'red' : undefined,
      });
    }
  }
  return defs;
}
import { loadMonthInvoices, loadWarenkostenGrenze, type InvoiceEntry } from '@/lib/waren-db';
import { filterInvoicesByRange, sumInvoicesNet, sumNetByKategorie, aggregateBySupplier, supplierRowIds } from '@/lib/waren-cockpit';
import { nurWarenAnteil, sumBetriebNet, DEFAULT_WARENKOSTEN_GRENZE } from '@/lib/waren-klassen';
import { loadWarenkonten, type Warenkonto } from '@/lib/waren-db';
import { loadZielWarenquote, DEFAULT_ZIEL_WARENQUOTE_PCT } from '@/lib/ziel-warenquote';

type KeyFn = (key: string) => string;

const VAT_STD = 1.081;
const pad2 = (n: number) => String(n).padStart(2, '0');
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Gäste-gewichteter Mittelwert der Durchschnittsverkauf-Tageswerte über die
 * gegebenen Tage (Fallback: einfacher Mittelwert, wenn keine Gästezahlen
 * vorliegen). `null` wenn KEIN Tag einen Wert > 0 hat (leer statt 0).
 * Wird identisch für Wochensicht UND als Ist-Monats-Fallback genutzt
 * (fehlt der direkt importierte avgcheck-monthly-Wert).
 */
export function gewichteterTagesAvg(
  tage: readonly string[],
  avgDaily: Record<string, number>,
  gaesteDaily: Record<string, number>,
): number | null {
  let wSum = 0, wWeight = 0, sSum = 0, sCount = 0;
  for (const date of tage) {
    const v = avgDaily[date];
    if (!(v > 0)) continue;
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) { wSum += v * g; wWeight += g; }
    sSum += v; sCount++;
  }
  if (wWeight > 0) return r2(wSum / wWeight);
  if (sCount > 0) return r2(sSum / sCount);
  return null;
}

/**
 * Harte PKQ-Obergrenze in Prozent (separat/fix, NICHT aus ziel_personalquote_v1 —
 * die Ziel-Quote kommt aus dem Kern via daten.zielQuotePct). Spiegelt die
 * Konstante der Personalkosten-Seite (PkHeadline: OBERGRENZE_PCT = 40).
 */
export const OBERGRENZE_PKQ_PCT = 40;

// ── Wochen-Auswahl ─────────────────────────────────────────────────────────

export type WeekSelection =
  | { kind: 'lastComplete' }
  | { kind: 'current' }
  | { kind: 'last7' }
  /** ISO-Kalenderwoche `kw` des ISO-Wochenjahres `kwYear`.
   *  `kwYear` ist WICHTIG am Jahreswechsel (Dez → KW 1 Folgejahr,
   *  Jan → KW 52/53 Vorjahr). Fehlt kwYear, gilt das Report-Jahr. */
  | { kind: 'kw'; kw: number; kwYear?: number };

const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Montag (00:00) der Woche, die `d` enthält (ISO: Mo=Wochenanfang). */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mo=0
  x.setDate(x.getDate() - dow);
  return x;
}

/** Montag (00:00) der ISO-Kalenderwoche `kw` im gegebenen Jahr. */
function mondayOfIsoWeek(year: number, kw: number): Date {
  // ISO: Woche 1 enthält den 4. Januar (bzw. den ersten Donnerstag).
  const jan4 = new Date(year, 0, 4);
  const week1Monday = mondayOf(jan4);
  const d = new Date(week1Monday);
  d.setDate(d.getDate() + (kw - 1) * 7);
  return d;
}

/** Label für eine Wochen-Auswahl (für UI/Spaltenüberschrift). */
export function weekSelectionLabel(sel: WeekSelection): string {
  switch (sel.kind) {
    case 'current': return 'Aktuelle Woche';
    case 'last7': return 'Letzte 7 Tage';
    case 'kw': return `KW ${sel.kw}`;
    case 'lastComplete':
    default: return 'Letzte abgeschl. Woche';
  }
}

/**
 * Berechnet den ungeklemmten Wochen-Zeitraum (Mo–So bzw. rollend) für eine
 * Auswahl, dann geklemmt auf [fromIso, min(toIso, istToIso)].
 * Ergibt die Klemmung einen leeren Bereich → { weekFrom: null, weekTo: null }.
 * Reine Funktion (keine I/O) — testbar.
 */
export function computeWeekRange(
  sel: WeekSelection,
  year: number,
  fromIso: string,
  toIso: string,
  istToIso: string,   // '' = Zukunftsmonat (kein Ist)
  heute: Date,
): { weekFrom: string | null; weekTo: string | null } {
  let rawFrom: Date;
  let rawTo: Date;
  const today = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());

  switch (sel.kind) {
    case 'current': {
      rawFrom = mondayOf(today);
      rawTo = today;
      break;
    }
    case 'last7': {
      rawTo = today;
      rawFrom = new Date(today);
      rawFrom.setDate(rawFrom.getDate() - 6);
      break;
    }
    case 'kw': {
      // ISO-Wochenjahr verwenden (Fallback: Report-Jahr) — sonst springt der
      // Zeitraum am Jahreswechsel ins falsche Jahr.
      rawFrom = mondayOfIsoWeek(sel.kwYear ?? year, sel.kw);
      rawTo = new Date(rawFrom);
      rawTo.setDate(rawTo.getDate() + 6);
      break;
    }
    case 'lastComplete':
    default: {
      const todayIso = iso(today);
      if (todayIso >= fromIso && todayIso <= toIso) {
        // Aktueller Monat: letzte vollständig abgeschlossene Woche Mo–So vor
        // der laufenden Woche (wie bisher).
        const thisMonday = mondayOf(today);
        rawFrom = new Date(thisMonday);
        rawFrom.setDate(rawFrom.getDate() - 7);
        rawTo = new Date(thisMonday);
        rawTo.setDate(rawTo.getDate() - 1);
      } else {
        // Anderer Monat gewählt: letzte abgeschlossene Woche INNERHALB des
        // Monats — sonst fiele die reale letzte Woche aus dem Monat und die
        // Woche-Spalte bliebe leer. Sonntag = letzter Sonntag ≤ Monatsende.
        const [ty, tm, td] = toIso.split('-').map(Number);
        const monthEnd = new Date(ty, tm - 1, td);
        const lastSunday = new Date(monthEnd);
        lastSunday.setDate(lastSunday.getDate() - (monthEnd.getDay() % 7));
        rawTo = lastSunday;
        rawFrom = new Date(lastSunday);
        rawFrom.setDate(rawFrom.getDate() - 6);
      }
      break;
    }
  }

  const upper = istToIso ? (istToIso < toIso ? istToIso : toIso) : '';
  // Kein Ist verfügbar (Zukunftsmonat) → leer.
  if (!upper) return { weekFrom: null, weekTo: null };

  let wf = iso(rawFrom);
  let wt = iso(rawTo);
  if (wf < fromIso) wf = fromIso;
  if (wt > upper) wt = upper;
  if (wf > wt) return { weekFrom: null, weekTo: null };
  return { weekFrom: wf, weekTo: wt };
}

/**
 * Bildet die Kalendertage der GEWÄHLTEN (evtl. geklemmten) Monats-Woche
 * [weekFrom, weekTo] auf die ENTSPRECHENDEN Tage im Vorjahr ab: gleiche
 * ISO-KW-Position (gleicher Wochentag, gleiche KW-Nummer, ISO-Wochenjahr−1) —
 * konsistent mit `vorjahresWoche`. Für jeden Ist-Tag δ Tage nach dem Montag der
 * enthaltenden ISO-Woche wird der Vorjahres-Tag = (Vorjahres-Montag + δ)
 * geliefert. So bleibt die Zuordnung auch bei Teilwochen (last7, current,
 * geklemmte KW) tag-genau. Existiert die KW im Vorjahr nicht (KW-53-Randfall)
 * → leeres Array. Reine Funktion (keine I/O) — testbar.
 *
 * Rückgabe: geordnetes Array `{ ist, vj }` 'YYYY-MM-DD'-Paare (Ist-Tag → VJ-Tag).
 */
export function computeVorjahrWocheDays(
  weekFrom: string | null,
  weekTo: string | null,
): { ist: string; vj: string }[] {
  if (!weekFrom || !weekTo || weekFrom > weekTo) return [];
  const parse = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const from = parse(weekFrom);
  const refMonday = mondayOf(from);
  const { kw, kwYear } = isoWeekYearOf(refMonday);
  const vj = vorjahresWoche({ kwYear, kw, from: iso(refMonday), to: iso(new Date(refMonday.getTime() + 6 * 86400000)) });
  if (!vj) return [];               // KW existiert im Vorjahr nicht → leer
  const vjMonday = parse(vj.from);
  const out: { ist: string; vj: string }[] = [];
  const to = parse(weekTo);
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const delta = Math.round((d.getTime() - refMonday.getTime()) / 86400000);
    const vjDay = new Date(vjMonday);
    vjDay.setDate(vjDay.getDate() + delta);
    out.push({ ist: iso(d), vj: iso(vjDay) });
  }
  return out;
}

// ── Personal-Block (Personalkosten + Personalquote) ─────────────────────────

/** Eingaben für den Personal-Block — alles aus dem Kern src/lib/personalkosten.ts. */
export interface PersonalBlockInput {
  /** FLEX-Ist je Tag ('YYYY-MM-DD' → istKosten), NUR vergangene Ist-Tage > 0 (Kern: flexKostenProTagDetail). */
  flexIstProTag: Record<string, number>;
  /** Set der Tage, die als Ist-Tag (vergangen) gelten (istTag=true im Kern). */
  istTagSet: Set<string>;
  /** FIX-Kosten des ganzen Monats (Kern: fixKosten().totalMonat). */
  fixMonat: number;
  /** Tage im Monat (für FIX pro-rata). */
  daysInMonth: number;
  /** Tage der gewählten Woche im Monat (geklemmt), aufsteigend. */
  wocheTage: string[];
  /** Netto-Umsatz-Budget der gewählten Woche (gleiche Quelle wie Umsatz-Zeilen). */
  wBudgetNet: number | null;
  /** Netto-Umsatz-Ist der gewählten Woche. */
  wNetIst: number | null;
  /** Ziel-Personalquote als BRUCH (Kern: budgetZielQuote, z.B. 0.355). */
  zielQuote: number;
  /** Personalkosten-Hochrechnung des Monats (Kern: personalkosten(hochrechnung)). */
  hrKostenMonat: number | null;
  /** Umsatz-Budget des Monats (für PK-Budget-Monat = Zielquote × Umsatz-Budget). */
  umsatzBudgetMonat: number | null;
  /** PKQ Hochrechnung des Monats (Kern: personalquote().pkqHochrechnung, Bruch). */
  pkqHrMonat: number | null;
}

export interface PersonalBlockErgebnis {
  /** PK-Ist der Woche (FIX pro-rata Wochentage + FLEX-Ist der Woche), null = keine Woche. */
  pkIstWoche: number | null;
  /** PK-Budget der Woche = Zielquote × Netto-Umsatz-Budget-Woche, null = keine Quelle. */
  pkBudgetWoche: number | null;
  /** PK-Budget des Monats = Zielquote × Umsatz-Budget-Monat, null = keine Quelle. */
  pkBudgetMonat: number | null;
  /** PK-Hochrechnung Monat (durchgereicht). */
  pkHrMonat: number | null;
  /** PKQ Woche = PK-Ist-Woche ÷ Netto-Umsatz-Ist-Woche in %, null = kein Umsatz. */
  pkqWochePct: number | null;
  /** PKQ Hochrechnung Monat in %, null = kein Umsatz. */
  pkqMonatPct: number | null;
}

/**
 * Aggregiert den Personal-Block aus den KERN-Werten (keine Parallel-Rechnung):
 *  - PK-Ist-Woche = FIX pro-rata der Wochentage (fixMonat × |Wochentage| ÷
 *    daysInMonth) + Σ FLEX-Ist der Woche (nur vergangene Ist-Tage).
 *  - PK-Budget-Woche = zielQuote × Netto-Umsatz-Budget der Woche.
 *  - PK-Budget-Monat = zielQuote × Umsatz-Budget-Monat.
 *  - PKQ-Woche = PK-Ist-Woche ÷ Netto-Umsatz-Ist-Woche (Ist ÷ Ist), % .
 *  - PKQ-Monat = pkqHrMonat (Hochrechnung ÷ Hochrechnung aus dem Kern), % .
 * «leer statt 0»: fehlt die jeweilige Quelle → null. Reine Funktion — testbar.
 */
export function computePersonalBlock(inp: PersonalBlockInput): PersonalBlockErgebnis {
  const hatWoche = inp.wocheTage.length > 0 && inp.daysInMonth > 0;

  // PK-Ist-Woche: FIX pro-rata + FLEX-Ist der Woche (nur Ist-Tage).
  let pkIstWoche: number | null = null;
  if (hatWoche) {
    const fixAnteil = inp.fixMonat * (inp.wocheTage.length / inp.daysInMonth);
    let flexIst = 0;
    for (const date of inp.wocheTage) {
      if (inp.istTagSet.has(date)) flexIst += inp.flexIstProTag[date] ?? 0;
    }
    pkIstWoche = r2(fixAnteil + flexIst);
  }

  const pkBudgetWoche = hatWoche && inp.wBudgetNet != null && inp.wBudgetNet > 0
    ? r2(inp.zielQuote * inp.wBudgetNet) : null;
  const pkBudgetMonat = inp.umsatzBudgetMonat != null && inp.umsatzBudgetMonat > 0
    ? r2(inp.zielQuote * inp.umsatzBudgetMonat) : null;

  // PKQ-Woche = Ist ÷ Ist (zeitkonsistent). null wenn kein Ist-Umsatz-Woche.
  const pkqWochePct = pkIstWoche != null && inp.wNetIst != null && inp.wNetIst > 0
    ? r2((pkIstWoche / inp.wNetIst) * 100) : null;
  const pkqMonatPct = inp.pkqHrMonat != null ? r2(inp.pkqHrMonat * 100) : null;

  return {
    pkIstWoche,
    pkBudgetWoche,
    pkBudgetMonat,
    pkHrMonat: inp.hrKostenMonat,
    pkqWochePct,
    pkqMonatPct,
  };
}

// ── Wochenverlauf: Fensterbestimmung ─────────────────────────────────────────

/** Ein abgeschlossenes ISO-Wochenfenster (Mo–So, volle 7 Tage). */
export interface WeekWindow {
  /** ISO-Wochenjahr (wichtig am Jahreswechsel) */
  kwYear: number;
  /** ISO-Kalenderwoche */
  kw: number;
  /** 'YYYY-MM-DD' Montag */
  from: string;
  /** 'YYYY-MM-DD' Sonntag */
  to: string;
}

/** ISO-Kalenderwoche + ISO-Wochenjahr eines Datums (Mo=Wochenanfang). */
function isoWeekYearOf(d: Date): { kw: number; kwYear: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mo=0
  t.setUTCDate(t.getUTCDate() - day + 3); // Donnerstag dieser Woche
  const kwYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(kwYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const kw = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { kw, kwYear };
}

/**
 * Die letzten `anzahl` ISO-Kalenderwochen (Mo–So) INKLUSIVE der laufenden
 * Woche, chronologisch: älteste zuerst (links) → laufende Woche zuletzt
 * (rechts). Wochen überschreiten Monats-/Jahresgrenzen (volle 7 Tage, keine
 * Klemmung). Reine Funktion (keine I/O) — testbar.
 */
export function computeLastCompleteWeeks(anzahl: number, heute: Date): WeekWindow[] {
  const today = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());
  // Montag der laufenden Woche = jüngste (rechte) Woche des Fensters.
  const thisMonday = new Date(today);
  thisMonday.setDate(thisMonday.getDate() - ((today.getDay() + 6) % 7));

  const out: WeekWindow[] = [];
  for (let i = anzahl - 1; i >= 0; i--) {
    const mon = new Date(thisMonday);
    mon.setDate(mon.getDate() - i * 7);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const { kw, kwYear } = isoWeekYearOf(mon);
    out.push({ kwYear, kw, from: iso(mon), to: iso(sun) });
  }
  return out;
}

/**
 * Vorjahres-Woche zur gegebenen Woche: GLEICHE ISO-KW-Nummer im ISO-Wochenjahr−1
 * (Mo–So). Existiert die KW im Vorjahr nicht (z.B. KW 53, wenn das Vorjahr nur
 * 52 Wochen hat), → null. Reine Funktion (keine I/O) — testbar.
 */
export function vorjahresWoche(w: WeekWindow): WeekWindow | null {
  const prevYear = w.kwYear - 1;
  const mon = mondayOfIsoWeek(prevYear, w.kw);
  // Verifizieren, dass die berechnete Woche tatsächlich (prevYear, kw) ist —
  // sonst existiert diese KW im Vorjahr nicht (KW-53-Fall).
  const check = isoWeekYearOf(mon);
  if (check.kwYear !== prevYear || check.kw !== w.kw) return null;
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { kwYear: prevYear, kw: w.kw, from: iso(mon), to: iso(sun) };
}

/**
 * Wochenfenster für ein GEWÄHLTES Jahr: dieselben KW-Nummern, die für das
 * aktuelle Jahr angezeigt würden (letzte `anzahl` abgeschlossene Wochen),
 * aber im ISO-Wochenjahr `selectedYear` — d.h. der kwYear jeder Referenzwoche
 * wird um (selectedYear − aktuelles Jahr) verschoben, die KW-Nummer bleibt.
 * Existiert eine KW im Zieljahr nicht (KW-53-Randfall), wird die Woche
 * WEGGELASSEN (dokumentierte Wahl; die restlichen Spalten bleiben stabil).
 * Für das aktuelle Jahr identisch zu computeLastCompleteWeeks. Reine Funktion.
 */
export function computeWeeksForYear(anzahl: number, heute: Date, selectedYear: number): WeekWindow[] {
  const ref = computeLastCompleteWeeks(Math.max(1, anzahl), heute);
  const shift = selectedYear - heute.getFullYear();
  if (shift === 0) return ref;
  const out: WeekWindow[] = [];
  for (const w of ref) {
    const targetKwYear = w.kwYear + shift;
    const mon = mondayOfIsoWeek(targetKwYear, w.kw);
    // Verifizieren, dass (targetKwYear, kw) tatsächlich existiert (KW-53-Fall).
    const chk = isoWeekYearOf(mon);
    if (chk.kwYear !== targetKwYear || chk.kw !== w.kw) continue; // KW gibt es dort nicht
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    out.push({ kwYear: targetKwYear, kw: w.kw, from: iso(mon), to: iso(sun) });
  }
  return out;
}

// ── Jahresvergleich (Year-to-Date) ──────────────────────────────────────────

/** YTD-Fenster: 01.01. bis heute vs. 01.01. Vorjahr bis gleiches Datum (pro rata). */
export interface YtdWindow {
  curYear: number;
  vjYear: number;
  /** 'YYYY-01-01' laufendes Jahr */
  curFrom: string;
  /** 'YYYY-MM-DD' = heute (Ist-Grenze) */
  curTo: string;
  /** 'YYYY-01-01' Vorjahr */
  vjFrom: string;
  /** 'YYYY-MM-DD' = gleiches Datum im Vorjahr (Schaltjahr-Randfall geklemmt) */
  vjTo: string;
}

/**
 * Bestimmt das YTD-Fenster: laufendes Jahr 01.01.→heute und Vorjahr
 * 01.01.→gleiches Kalenderdatum. Schaltjahr-Randfall: fällt «heute» auf den
 * 29.02., existiert dieses Datum im (Nicht-Schalt-)Vorjahr nicht → geklemmt auf
 * 28.02. des Vorjahres. Reine Funktion (keine I/O) — testbar.
 */
export function computeYtdWindow(heute: Date): YtdWindow {
  const curYear = heute.getFullYear();
  const vjYear = curYear - 1;
  const m = heute.getMonth();       // 0-basiert
  const d = heute.getDate();
  const curTo = `${curYear}-${pad2(m + 1)}-${pad2(d)}`;
  const vjTo = spiegelDatumInsVorjahr(vjYear, m, d);
  return {
    curYear, vjYear,
    curFrom: `${curYear}-01-01`, curTo,
    vjFrom: `${vjYear}-01-01`, vjTo,
  };
}

/**
 * Spiegelt (Monat, Tag) ins Vorjahr und klemmt den Schaltjahr-Randfall:
 * fällt das Datum auf den 29.02. und ist das Vorjahr kein Schaltjahr →
 * 28.02. Liefert 'YYYY-MM-DD'.
 */
function spiegelDatumInsVorjahr(vjYear: number, monat0: number, tag: number): string {
  let d = tag;
  if (monat0 === 1 && tag === 29 && new Date(vjYear, 1, 29).getDate() !== 29) {
    d = 28; // 29.02. existiert im Nicht-Schalt-Vorjahr nicht → geklemmt
  }
  return `${vjYear}-${pad2(monat0 + 1)}-${pad2(d)}`;
}

/** Modus des Jahresvergleich-Zeitraums. */
export type VergleichsModus = 'ytd' | 'ganzjahr' | 'custom';

/**
 * Verallgemeinertes Vergleichsfenster für den Jahresvergleich. Liefert stets die
 * YtdWindow-Struktur (aktuelles Jahr vs. Vorjahr):
 *  - 'ytd'      : 01.01.→heute vs. 01.01.→gleiches Datum Vorjahr (29.02.-Klemmung).
 *  - 'ganzjahr' : aktuelles Jahr 01.01.→31.12. vs. ganzes Vorjahr 01.01.→31.12.
 *                 (Ist-Daten reichen faktisch nur bis heute — Kopf weist darauf hin).
 *  - 'custom'   : von→bis im aktuellen Jahr (auf aktuelles Jahr begrenzt);
 *                 Vorjahr = derselbe MM-TT-Bereich mit 29.02.-Klemmung.
 * von/bis sind 'YYYY-MM-DD' und nur im 'custom'-Modus relevant. Reine Funktion.
 */
export function computeVergleichsWindow(
  modus: VergleichsModus,
  heute: Date,
  von?: string,
  bis?: string,
): YtdWindow {
  const curYear = heute.getFullYear();
  const vjYear = curYear - 1;

  if (modus === 'ganzjahr') {
    return {
      curYear, vjYear,
      curFrom: `${curYear}-01-01`, curTo: `${curYear}-12-31`,
      vjFrom: `${vjYear}-01-01`, vjTo: `${vjYear}-12-31`,
    };
  }

  if (modus === 'custom') {
    // von/bis werden vom Aufrufer validiert (von ≤ bis); hier defensiv normalisiert.
    const f = von ?? `${curYear}-01-01`;
    const t = bis ?? `${curYear}-12-31`;
    const [fm, fd] = [Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10))];
    const [tm, td] = [Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10))];
    return {
      curYear, vjYear,
      curFrom: `${curYear}-${pad2(fm + 1)}-${pad2(fd)}`,
      curTo: `${curYear}-${pad2(tm + 1)}-${pad2(td)}`,
      vjFrom: spiegelDatumInsVorjahr(vjYear, fm, fd),
      vjTo: spiegelDatumInsVorjahr(vjYear, tm, td),
    };
  }

  // 'ytd' (Default)
  return computeYtdWindow(heute);
}

/** Eine Kennzahl-Zeile im Jahresvergleich (YTD aktuell vs. Vorjahr). */
export interface JahresvergleichRow {
  label: string;
  fmt: MrFormat;
  bold?: boolean;
  /** YTD laufendes Jahr, null = keine Quelle */
  cur: number | null;
  /** YTD Vorjahr (pro rata), null = keine Quelle */
  vj: number | null;
  /** Farb-Tönung der Werte (Rezensions-Zeilen: 5 grün, 1 rot, 3 neutral). */
  tint?: 'green' | 'red';
}

export interface JahresvergleichDaten extends YtdWindow {
  rows: JahresvergleichRow[];
  /** Gewählter Vergleichsmodus (für die Kopf-Beschriftung). */
  modus: VergleichsModus;
}

/**
 * Dropdown-Label einer ISO-KW inkl. Mo–So-Datumsbereich, z.B.
 * «KW 27 · 29.06.–05.07.». Nutzt dieselbe ISO-Wochenlogik wie der Wochenverlauf.
 * Reine Funktion (keine I/O) — testbar.
 */
export function kwRangeLabel(kwYear: number, kw: number): string {
  const mon = mondayOfIsoWeek(kwYear, kw);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  const dm = (d: Date) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
  return `KW ${kw} · ${dm(mon)}–${dm(sun)}`;
}

// ── Zeilenmodell ─────────────────────────────────────────────────────────────

export type MrFormat = 'chf' | 'count' | 'pct' | 'hours' | 'countPax';

export interface MrRow {
  type: 'data' | 'empty';
  /**
   * Stabile Zeilen-ID (Slug, z.B. 'netto_umsatz') — NICHT das Label, da Labels
   * sich ändern können. Basis für die benutzerdefinierte Zeilen-Reihenfolge.
   * Nur bei type='data' gesetzt; Trenner (type='empty') haben keine ID.
   */
  id?: string;
  label?: string;
  fmt?: MrFormat;
  bold?: boolean;
  /** Spalte «Budget (Woche)» = Budget-Wochenanteil der gewählten Woche.
   *  IDENTISCH mit `weekBudget` (Basis der Woche-Δ%) → Anzeige & Δ% konsistent. */
  budget: number | null;
  /** Spalte «Vorjahr (Woche)» = Vorjahr derselben Woche (gleiche KW/Kalendertage). */
  vj: number | null;
  /** Vorjahr MONAT (gleicher Monat im Vorjahr, aus vj_daily) — Monatssicht. */
  vjMonth: number | null;
  /** Spalte «Woche» (Ist der aktuellen Woche) */
  week: number | null;
  /** Budget-Wochenanteil (Basis für +/- der Woche = identisch mit `budget`). */
  weekBudget: number | null;
  /** MONATS-Budget (Basis der Monat-Δ% + Budget-Spalte der Monatssicht). */
  monthBudget: number | null;
  /** Spalte «Monat» (Ist bis heute; Personalkosten = Hochrechnung) */
  month: number | null;
  /**
   * true = KOSTEN-Zeile: bei der Δ%-Färbung ist MEHR schlecht (über Budget = rot).
   * Kehrt die Vorzeichen-Färbung gegenüber Umsatz-/Ertragszeilen um.
   */
  deltaInverted?: boolean;
  /**
   * Schwelle in derselben Einheit wie der Zellwert (z.B. 40 für PKQ-Prozent):
   * Woche-/Monatswert ÜBER dieser Schwelle wird rot markiert (Obergrenze-Warnung).
   */
  warnAbove?: number;
  /**
   * true = Δ als PROZENTPUNKTE (Ist − Budget, z.B. PKQ 51.8 % − 35.5 % =
   * +16.3 PP) statt relativer Abweichung. Nur für Quoten-Zeilen (fmt='pct');
   * Färbung wie Kosten: über Ziel = rot.
   */
  deltaPp?: boolean;
  /**
   * true = Δ% gegen das VORJAHR statt gegen das Budget (Zeilen ohne Budget,
   * z.B. Take Away Umsatz): Monat vs. vjMonth, Woche vs. vj (VJ-Woche).
   * Färbung wie Umsatz (mehr = grün); deltaInverted wird respektiert.
   */
  deltaVsVj?: boolean;
  /**
   * Begleit-«Personen»-Werte für fmt='countPax' (Anzeige «Anzahl (Σ Personen)»).
   * Pro Spalte parallel zu month/week/vjMonth; null = kein Zusatzwert.
   * Nur bei fmt='countPax' relevant, sonst undefined.
   */
  monthPax?: number | null;
  weekPax?: number | null;
  vjMonthPax?: number | null;
  /**
   * Farb-Tönung des Ist-Werts (Rezensions-Zeilen: 5 Sterne grün, 1 Stern rot,
   * 3 Sterne neutral/ohne Tönung). Reine Anzeige, keine Δ-Logik.
   */
  tint?: 'green' | 'red';
  /**
   * ID der Eltern-Zeile: diese Zeile ist ein ausklappbares Kind (z.B.
   * Lieferanten-Zeilen unter «Warenkosten total»). Kinder werden IMMER direkt
   * unter ihrer Eltern-Zeile gerendert (unabhängig von der gespeicherten
   * Reihenfolge) und sind standardmässig eingeklappt.
   */
  childOf?: string;
  /**
   * Kompakte WKQ-Zusatzinfo (nur «Warenkosten total»): WKQ inkl. Ziel-Ampel/Δ
   * sowie Food-/Beverage-WKQ als kleine Zeile unter dem Label — je Granularität.
   */
  wkqInline?: { month: WkqInlineInfo | null; week: WkqInlineInfo | null };
  /**
   * Quote der Zeile in % auf den NETTO-Umsatz der Periode (Lieferanten-Zeilen:
   * Lieferant ÷ Umsatz) — kleine Zusatzangabe direkt beim CHF-Wert. null =
   * kein Umsatz (nie durch 0). Die Summe der Lieferanten-% ergibt die WKQ.
   */
  pctOfRevenue?: { month: number | null; week: number | null };
  /**
   * Anteil an «Gäste IN» in % (Basis = 100 %), je Spalte parallel zu
   * month/week/vj/vjMonth. Reservierte Gäste: Personen ÷ Gäste IN; Gruppen:
   * Σ Personen der Gruppen ÷ Gäste IN. null = keine Gäste-IN-Basis (nie ÷ 0).
   */
  sharePct?: { month: number | null; week: number | null; vj: number | null; vjMonth: number | null };
}

/** Kompakte WKQ-Angabe für die Inline-Anzeige bei «Warenkosten total». */
export interface WkqInlineInfo {
  /** WKQ in % (Warenkosten ÷ Netto-Umsatz der Periode); null ohne Umsatz. */
  pct: number | null;
  /** Ziel-WKQ in % (Ampel: über Ziel = rot). */
  ziel: number | null;
  /** Food-WKQ in % (effektive Kategorie); null ohne Wert/Umsatz. */
  food: number | null;
  /** Beverage-WKQ in % (effektive Kategorie); null ohne Wert/Umsatz. */
  bev: number | null;
}

export interface MonatsreportDaten {
  year: number;
  month: number; // 1-basiert
  /** Zeitraum der «Woche»-Spalte (leer, wenn geklemmter Bereich leer ist) */
  weekFrom: string | null;
  weekTo: string | null;
  /** Beschriftung der «Woche»-Auswahl (z.B. "KW 30", "Aktuelle Woche") */
  weekLabel: string;
  /** Zeitraum der «Vorjahr (Woche)»-Spalte (gleiche ISO-KW im Vorjahr); null wenn keine VJ-Woche. */
  vjWeekFrom: string | null;
  vjWeekTo: string | null;
  rows: MrRow[];
  /**
   * Lieferanten-Aufstellung für den Cockpit-Export (zweites Blatt
   * «Warenkosten»), je Granularität. null = keine Rechnungsdaten geladen.
   */
  waren?: {
    monat: WarenExportPeriod | null;
    woche: WarenExportPeriod | null;
    /** Ziel-WKQ in % (pro Mandant). */
    zielWkq: number;
  };
}

/** Perioden-Aufstellung der Warenkosten für den Excel-Export. */
export interface WarenExportPeriod {
  suppliers: { name: string; net: number; count: number }[];
  /** Warenkosten total (netto) der Periode. */
  total: number;
  /** Netto-Umsatz der Periode (Nenner für Anteil/WKQ); null = kein Umsatz. */
  revenue: number | null;
  /** Betriebskosten-Anteile (Konten > Grenze) — separat, NIE in Total/WKQ. */
  betrieb?: number | null;
}

// ── Benutzerdefinierte Zeilen-Reihenfolge (Cockpit) ──────────────────────────

/** Persistiertes Reihenfolge-Setting (app_settings, pro Tenant). */
export interface CockpitRowOrder {
  /** Zeilen-IDs in gewünschter Reihenfolge (nur type='data'). */
  ids: string[];
  /** ISO-Zeitstempel der letzten Änderung (Diagnose/Merge). */
  updatedAt: string;
}

/**
 * Wendet eine gespeicherte Zeilen-Reihenfolge auf die Standard-Zeilen an.
 * REIN & testbar (keine I/O).
 *
 * Trenner-Entscheid: Bei benutzerdefinierter Reihenfolge werden die
 * Block-Trenner (type='empty') WEGGELASSEN — die Tabelle ist dann durchgehend.
 * Trenner haben keine stabile ID und markieren nur die Standard-Blockstruktur;
 * eine frei umsortierte Liste hat keine sinnvolle Blockzuordnung mehr. Ohne
 * gespeicherte Reihenfolge bleibt alles unverändert (inkl. Trenner).
 *
 * Regeln (nie Zeilen verlieren):
 *  - Leeres/fehlendes Setting → Standard-`rows` unverändert (mit Trennern).
 *  - Unbekannte gespeicherte IDs (nicht mehr in `rows`) werden ignoriert.
 *  - NEUE Datenzeilen (in `rows`, aber nicht im Setting) werden in ihrer
 *    Standard-Reihenfolge hinten angehängt → gehen nie verloren.
 */
export function applyRowOrder(rows: MrRow[], savedIds: string[] | null | undefined): MrRow[] {
  if (!savedIds || savedIds.length === 0) return rows;
  const dataRows = rows.filter((r): r is MrRow => r.type === 'data' && !!r.id);
  const byId = new Map(dataRows.map(r => [r.id!, r]));
  const seen = new Set<string>();
  const ordered: MrRow[] = [];
  // 1) Gespeicherte Reihenfolge (unbekannte IDs überspringen, Duplikate einmal).
  for (const id of savedIds) {
    const row = byId.get(id);
    if (row && !seen.has(id)) { ordered.push(row); seen.add(id); }
  }
  // 2) Neue Datenzeilen (nicht im Setting) in Standard-Reihenfolge anhängen.
  for (const row of dataRows) {
    if (!seen.has(row.id!)) { ordered.push(row); seen.add(row.id!); }
  }
  // 3) Stunden-Stapel IMMER als EIN zusammenhängender Block in fester
  //    Reihenfolge (Bedarf → Plan → Ist). Alte gespeicherte Reihenfolgen kennen
  //    'bedarf_stunden' noch nicht → die Zeile würde sonst doppelt wirken bzw.
  //    einzeln ans Tabellenende rutschen.
  return anchorTakeAwayUmsatz(glueStundenStack(ordered), savedIds);
}

/**
 * Verankert «Take Away Umsatz» bei den übrigen Take-Away-Zeilen, WENN die
 * gespeicherte Reihenfolge die Zeile noch nicht kennt (sonst würde sie als
 * «neue» Zeile ans Tabellenende angehängt). Ziel: direkt nach der LETZTEN der
 * Zeilen «Take Away Anteil»/«Gäste Take Away». Kennt das Setting die Zeile
 * (Nutzer hat sie bewusst platziert), bleibt die Nutzer-Position massgeblich.
 */
export function anchorTakeAwayUmsatz(rows: MrRow[], savedIds: string[] | null | undefined): MrRow[] {
  if (savedIds?.includes('take_away_umsatz')) return rows;
  const taIdx = rows.findIndex((r) => r.id === 'take_away_umsatz');
  if (taIdx < 0) return rows;
  const anchorIdx = Math.max(
    rows.findIndex((r) => r.id === 'take_away_anteil'),
    rows.findIndex((r) => r.id === 'gaeste_take_away'),
  );
  if (anchorIdx < 0) return rows;
  const out = rows.slice();
  const [ta] = out.splice(taIdx, 1);
  const insertAt = taIdx < anchorIdx ? anchorIdx : anchorIdx + 1;
  out.splice(insertAt, 0, ta);
  return out;
}

/** IDs des Stunden-Stapels (feste Block-Reihenfolge Bedarf → Plan → Ist). */
export const STUNDEN_STACK_IDS = ['bedarf_stunden', 'prod_stunden_plan', 'prod_stunden_ist'] as const;

/**
 * Zieht die drei Stunden-Zeilen zu EINEM Block zusammen: Position = erste der
 * drei in der aktuellen Reihenfolge, Block-Reihenfolge fest Bedarf → Plan → Ist.
 */
export function glueStundenStack(rows: MrRow[]): MrRow[] {
  const stackIds = new Set<string>(STUNDEN_STACK_IDS);
  const stack = STUNDEN_STACK_IDS
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is MrRow => !!r);
  if (stack.length < 2) return rows; // nichts zu kleben
  const firstIdx = rows.findIndex((r) => !!r.id && stackIds.has(r.id));
  const out: MrRow[] = [];
  rows.forEach((r, i) => {
    if (r.id && stackIds.has(r.id)) {
      if (i === firstIdx) out.push(...stack);
      return; // übrige Stapel-Zeilen an alter Stelle entfernen
    }
    out.push(r);
  });
  return out;
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

// Hinweis: Die früheren Direkt-Zähler countGroupsFrom20Pax(Vj) mit eigener
// Zählregel (nur «ohne Stornos») wurden entfernt — ALLE Ansichten zählen
// ausschliesslich über loadReservationMetrics + zentrale Zählregel
// (reservation-cockpit-settings), Quelle = Foratable-CSV-Import
// (reservation_records). Keine parallele Alt-Zählung mehr.

// ── Hauptlader ───────────────────────────────────────────────────────────────

export async function ladeMonatsreport(
  year: number,
  month: number, // 1-basiert
  tenantId: TenantId,
  tenantKey: KeyFn,
  rates: SocialCostRates,
  heute: Date = new Date(),
  weekSelection: WeekSelection = { kind: 'lastComplete' },
): Promise<MonatsreportDaten> {
  const mm = pad2(month);
  const daysInMonth = new Date(year, month, 0).getDate();
  const fromIso = `${year}-${mm}-01`;
  const toIso = `${year}-${mm}-${pad2(daysInMonth)}`;
  const todayIso = `${heute.getFullYear()}-${pad2(heute.getMonth() + 1)}-${pad2(heute.getDate())}`;
  const isCurrentMonth = heute.getFullYear() === year && heute.getMonth() + 1 === month;
  const isFutureMonth = new Date(year, month - 1, 1) > heute;
  /** Ist-Grenze: laufender Monat = bis heute, vergangene Monate = ganzer Monat. */
  const istToIso = isFutureMonth ? '' : (isCurrentMonth ? todayIso : toIso);

  // «Woche» = gewählte Woche, auf den Monat + Ist-Grenze geklemmt.
  // Die Spalte existiert, sobald der geklemmte Bereich nicht leer ist
  // (funktioniert damit auch für 'kw' in vergangenen Monaten).
  const weekLabel = weekSelectionLabel(weekSelection);
  const { weekFrom, weekTo } = computeWeekRange(weekSelection, year, fromIso, toIso, istToIso, heute);

  // Reservationen dürfen in der ZUKUNFT liegen (geplante Perioden). Deshalb ein
  // NICHT auf «heute» geklemmter Wochenbereich (nur auf den Monat begrenzt): wie
  // computeWeekRange, aber mit istToIso = toIso (ganzer Monat verfügbar).
  const { weekFrom: resWeekFrom, weekTo: resWeekTo } =
    computeWeekRange(weekSelection, year, fromIso, toIso, toIso, heute);

  const alleTage: string[] = [];
  for (let t = 1; t <= daysInMonth; t++) alleTage.push(`${year}-${mm}-${pad2(t)}`);
  const istTage = alleTage.filter(d => istToIso && d <= istToIso);
  const wocheTage = weekFrom && weekTo ? alleTage.filter(d => d >= weekFrom! && d <= weekTo!) : [];

  // Vorjahres-Woche derselben KW/Kalendertage (tag-genaue Ist→VJ-Zuordnung).
  const vjWochePaare = computeVorjahrWocheDays(weekFrom, weekTo);

  // ── Parallel laden ─────────────────────────────────────────────────────────
  const vjMonth = month; // gleicher Monat im Vorjahr
  const vjDays = new Date(year - 1, month, 0).getDate();
  const vjFromIsoG = `${year - 1}-${mm}-01`;
  const vjToIsoG = `${year - 1}-${mm}-${pad2(vjDays)}`;
  // Zentrale Reservations-Zählregel (Status-Set + Gruppen-Schwelle) laden.
  const resCounting = await loadReservationCounting(tenantKey).catch(() => null);
  const resSettings = resCounting ?? DEFAULT_RESERVATION_COUNTING;

  // «Betrieb bietet Take Away» (pro Tenant, Default oliv=ja / beaulieu=nein).
  // Bei «nein» werden die TA-Loads übersprungen UND die TA-Zeilen gar nicht
  // erst gebaut (Anzeige/Export/Umsortier-Liste bleiben so konsistent).
  const taOffered = (await loadTakeAwayOffered(tenantKey, tenantId).catch(() => null))?.offered
    ?? (tenantId === 'oliv');

  // Google-Rezensionen (Einzelerfassung, mandantengetrennt): Zählquelle der
  // Zeilen «Google 5/3/1 Sterne». Ladefehler → null (Zeilen bleiben leer,
  // nie 0 erfinden); geladener Blob → echte Anzahl (0 ist eine echte Aussage).
  const reviewSingles: SingleReview[] | null =
    await fetchReviewsData(tenantId).then(d => d.singleReviews).catch(() => null);

  // Warenkosten (erfasste Warenrechnungen, netto) + Ziel-WKQ: Basis der
  // Lieferanten-/Total-/WKQ-Zeilen. Ladefehler → null (Zeilen bleiben leer).
  const [warenInvoices, zielWkq, warenKonten, warenGrenze] = await Promise.all([
    loadMonthInvoices(tenantId, `${year}-${mm}`).catch(() => null as InvoiceEntry[] | null),
    loadZielWarenquote(tenantId).then(b => b.pct).catch(() => DEFAULT_ZIEL_WARENQUOTE_PCT),
    loadWarenkonten(tenantId).catch(() => [] as Warenkonto[]),
    loadWarenkostenGrenze(tenantId).catch(() => DEFAULT_WARENKOSTEN_GRENZE),
  ]);

  const [
    gaesteDaily, avgDaily, avgMonthly, vjDaily, resMonth, resWeek, resVjMonth,
    taMonth, taWeek, taVjMonth, pk,
    pkVj, staffingPositions, staffingReqs, staffingConfig,
    mrEmployees, mrSchedule, mrActual,
  ] = await Promise.all([
    loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckMonthly(tenantKey).catch(() => ({} as Record<string, number>)),
    loadVjDailyMonth(year - 1, vjMonth, tenantId),
    // Reservationen: GANZER Monat (inkl. Zukunft — geplante Perioden zählen mit).
    loadReservationMetrics(tenantId, fromIso, toIso, resSettings),
    // Reservationen der gewählten Woche (ungeklemmt, future-capable).
    loadReservationMetrics(tenantId, resWeekFrom, resWeekTo, resSettings),
    // Vorjahr: gleicher Monat Jahr−1 (für die Vorjahr-Spalte der Monatssicht).
    loadReservationMetrics(tenantId, vjFromIsoG, vjToIsoG, resSettings),
    // Gäste Take Away (Produktanalyse): Σ Stückzahlen aller TA-Produkte, GANZER
    // Monat bzw. gewählte Woche (ungeklemmt, future-capable). VJ-Monat = gleicher
    // Monat Jahr−1 aus derselben Quelle (fehlt → «—»); VJ-Woche bleibt «—».
    taOffered ? loadTakeAwayGuests(tenantId, fromIso, toIso).catch(() => null) : Promise.resolve(null),
    taOffered ? loadTakeAwayGuests(tenantId, resWeekFrom, resWeekTo).catch(() => null) : Promise.resolve(null),
    taOffered ? loadTakeAwayGuests(tenantId, vjFromIsoG, vjToIsoG).catch(() => null) : Promise.resolve(null),
    ladePersonalkostenDaten(year, month, tenantId, tenantKey, rates).catch(() => null),
    // Vorjahres-Personalkosten aus der BUCHHALTUNG (nur Jahre < 2026, nur Monat)
    loadVorjahresPersonalkosten(tenantId, year - 1, month).catch(() => null),
    // Personalbedarf-Stammdaten für die Bedarf-Stunden-Leitplanke.
    loadPositions(tenantId).catch(() => [] as Awaited<ReturnType<typeof loadPositions>>),
    loadStaffingRequirements(tenantId).catch(() => [] as Awaited<ReturnType<typeof loadStaffingRequirements>>),
    loadStaffingProfilesConfig(tenantId).catch(() => null),
    // Dienstplan/Ist des Monats für den Stunden-Stapel (gemeinsame Helfer —
    // identische Semantik wie die Personalbedarf-Wochenübersicht).
    loadEmployees(tenantId).catch(() => null),
    loadScheduleForMonth(new Date(year, month - 1, 1), tenantId).catch(() => null),
    loadActualHoursForMonth(new Date(year, month - 1, 1), tenantId).catch(() => null),
  ]);

  // ── Vorjahres-Woche: vj_daily der berührten Monate laden ───────────────────
  // Die VJ-Woche kann Monatsgrenzen überschreiten und einen anderen Monat als
  // vjMonth treffen (z.B. Wochenanfang KW am Monatsanfang). Alle berührten
  // vj_daily-Monate laden und in einer Map vereinen.
  const vjWocheDaily: Record<string, VjDayRecord> = {};
  if (vjWochePaare.length > 0) {
    const vjMonate = new Map<string, { y: number; m: number }>();
    for (const { vj } of vjWochePaare) {
      vjMonate.set(vj.slice(0, 7), { y: Number(vj.slice(0, 4)), m: Number(vj.slice(5, 7)) });
    }
    const maps = await Promise.all(
      [...vjMonate.values()].map(({ y, m }) =>
        loadVjDailyMonth(y, m, tenantId).catch(() => ({} as Record<string, VjDayRecord>))),
    );
    for (const mp of maps) Object.assign(vjWocheDaily, mp);
  }

  // ── Umsatz Ist aus der kanonischen Netto-Quelle (src/lib/umsatz.ts) ────────
  const umsatzTage = await ladeUmsatzTage(tenantId, fromIso, toIso);
  let mGross = 0, mNet = 0, mTa = 0, mFood = 0, mBev = 0, mHatUmsatz = false;
  let wGross = 0, wNet = 0, wTa = 0, wFood = 0, wBev = 0, wHatUmsatz = false;
  // «Umsatz pro Gast»: Netto ÷ Gäste, aber NUR über Tage, die BEIDE Quellen
  // haben (Umsatz-Tag mit gesamtBrutto>0 UND gaesteDaily[date]>0).
  let pairedNet = 0, pairedGaeste = 0, wPairedNet = 0, wPairedGaeste = 0;
  for (const date of istTage) {
    const tag = umsatzTage.get(date);
    if (!tag || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    mGross += tag.gesamtBrutto; mTa += tag.takeAwayBrutto; mNet += netto;
    mFood += split.food; mBev += split.beverage;
    mHatUmsatz = true;
    const inWeek = !!(weekFrom && weekTo && date >= weekFrom && date <= weekTo);
    if (inWeek) {
      wGross += tag.gesamtBrutto; wTa += tag.takeAwayBrutto; wNet += netto;
      wFood += split.food; wBev += split.beverage;
      wHatUmsatz = true;
    }
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) {
      pairedNet += netto; pairedGaeste += g;
      if (inWeek) { wPairedNet += netto; wPairedGaeste += g; }
    }
  }

  // ── Budget (netto aus Budget-Modul) + Wochenanteil ─────────────────────────
  const budgetNet = getMonthlyBudgetRevenue(year, month - 1, tenantKey('budget_v1'));
  const gewichte = ladeWochentagsGewichte(tenantKey);
  const budgetProTag = budgetNet > 0 ? computeMonthlyDailyBudgets(budgetNet, year, month, gewichte) : {};
  const wBudgetNet = wocheTage.reduce((s, d) => s + (budgetProTag[d] ?? 0), 0);
  const hatBudget = budgetNet > 0;

  // ── Gäste (manueller GÄSTE-Import, gaeste-daily-KV) ────────────────────────
  let mGaeste = 0, wGaeste = 0, hatGaeste = false, hatWGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < fromIso || !istToIso || date > istToIso) continue;
    if (!(n > 0)) continue;
    mGaeste += n; hatGaeste = true;
    if (weekFrom && weekTo && date >= weekFrom && date <= weekTo) { wGaeste += n; hatWGaeste = true; }
  }
  const vjFrom = `${year - 1}-${mm}-01`;
  const vjTo = `${year - 1}-${mm}-${pad2(new Date(year - 1, vjMonth, 0).getDate())}`;
  let vjGaeste = 0, hatVjGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < vjFrom || date > vjTo || !(n > 0)) continue;
    vjGaeste += n; hatVjGaeste = true;
  }

  // ── Durchschnittsverkauf (manueller Import; Zeitraum-Wert massgeblich) ─────
  // Ist-Monat: primär der direkt importierte Monatswert (avgcheck-monthly).
  // Fehlt dieser, Fallback wie Wochensicht/Vorjahr: gäste-gewichteter
  // Mittelwert der Tageswerte (avgcheck-daily) über den Monat, Fallback
  // einfacher Mittelwert. Leer NUR wenn weder Monats- noch Tageswerte da sind.
  let avgMonat: number | null = avgMonthly[`${year}-${mm}`] ?? null;
  if (avgMonat == null) avgMonat = gewichteterTagesAvg(alleTage, avgDaily, gaesteDaily);
  // Vorjahr: primär der importierte Monatswert (avgcheck-monthly). Fehlt dieser
  // (z.B. alte Importe, die nur Tageswerte schrieben), Fallback = einfacher
  // Mittelwert der Vorjahres-Tageswerte (avgcheck-daily) über den Vorjahres-
  // Monat — Durchschnittsverkauf ist ein direkt importierter Wert, nicht
  // gäste-gewichtet. Leer wenn beide Quellen fehlen (nie 0).
  let avgVj: number | null = avgMonthly[`${year - 1}-${mm}`] ?? null;
  if (avgVj == null) {
    let sSum = 0, sCount = 0;
    for (const [date, v] of Object.entries(avgDaily)) {
      if (date < vjFrom || date > vjTo || !(v > 0)) continue;
      sSum += v; sCount++;
    }
    if (sCount > 0) avgVj = r2(sSum / sCount);
  }
  // Woche: gäste-gewichteter Mittelwert der Tageswerte (Fallback: einfacher Mittelwert)
  const avgWoche: number | null = weekFrom && weekTo
    ? gewichteterTagesAvg(wocheTage, avgDaily, gaesteDaily)
    : null;

  // ── Vorjahr (vj_daily) ─────────────────────────────────────────────────────
  let vjGross = 0, vjFoodG = 0, vjBevG = 0, vjTa = 0;
  let hatVj = false, hatVjFood = false, hatVjBev = false, hatVjTa = false;
  // «Umsatz pro Gast» VJ: Netto-VJ ÷ Gäste-VJ, aber NUR über GEPAARTE Tage
  // (Tag mit vj_daily.actualRevenue>0 UND gaesteDaily[date]>0 im Vorjahr) —
  // exakt dieselbe Paarungs-Regel wie im Ist-Zweig, gleicher Zeitraum.
  let vjPairedNet = 0, vjPairedGaeste = 0;
  for (const [date, rec] of Object.entries(vjDaily)) {
    if ((rec.actualRevenue ?? 0) > 0) { vjGross += rec.actualRevenue; hatVj = true; }
    if ((rec.foodRevenue ?? 0) > 0) { vjFoodG += rec.foodRevenue!; hatVjFood = true; }
    if ((rec.beverageRevenue ?? 0) > 0) { vjBevG += rec.beverageRevenue!; hatVjBev = true; }
    if ((rec.takeawayRevenue ?? 0) > 0) { vjTa += rec.takeawayRevenue!; hatVjTa = true; }
    const gVj = gaesteDaily[date] ?? 0;
    if ((rec.actualRevenue ?? 0) > 0 && gVj > 0) {
      vjPairedNet += rec.actualRevenue / VAT_STD; // Netto wie vjNetV (Standard-MwSt)
      vjPairedGaeste += gVj;
    }
  }

  // ── Vorjahres-WOCHE (vj_daily der gemappten VJ-Kalendertage) ───────────────
  // Verhältnis-/Prozent-Zeilen werden NICHT summiert, sondern als Quote über
  // die Woche gebildet (TA-Anteil, Umsatz/Gast, Durchschnittsverkauf). Gäste-
  // Tagessumme massgeblich; «leer statt 0».
  let vwGross = 0, vwFoodG = 0, vwBevG = 0, vwTa = 0;
  let hatVwUmsatz = false, hatVwFood = false, hatVwBev = false, hatVwTa = false;
  let vwGaeste = 0, hatVwGaeste = false;
  let vwPairedNet = 0, vwPairedGaeste = 0;
  let vwAvgSum = 0, vwAvgWeight = 0, vwAvgSimpleSum = 0, vwAvgSimpleCount = 0;
  for (const { vj } of vjWochePaare) {
    const rec = vjWocheDaily[vj];
    if (rec) {
      if ((rec.actualRevenue ?? 0) > 0) { vwGross += rec.actualRevenue; hatVwUmsatz = true; }
      if ((rec.foodRevenue ?? 0) > 0) { vwFoodG += rec.foodRevenue!; hatVwFood = true; }
      if ((rec.beverageRevenue ?? 0) > 0) { vwBevG += rec.beverageRevenue!; hatVwBev = true; }
      if ((rec.takeawayRevenue ?? 0) > 0) { vwTa += rec.takeawayRevenue!; hatVwTa = true; }
    }
    const gVj = gaesteDaily[vj] ?? 0;
    if (gVj > 0) { vwGaeste += gVj; hatVwGaeste = true; }
    if (rec && (rec.actualRevenue ?? 0) > 0 && gVj > 0) {
      vwPairedNet += rec.actualRevenue / VAT_STD; vwPairedGaeste += gVj;
    }
    // Durchschnittsverkauf VJ-Woche: gäste-gewichtet, Fallback einfacher Mittel.
    const av = avgDaily[vj];
    if (av > 0) {
      if (gVj > 0) { vwAvgSum += av * gVj; vwAvgWeight += gVj; }
      vwAvgSimpleSum += av; vwAvgSimpleCount++;
    }
  }
  const vwNet = vwGross / VAT_STD;

  // ── Stunden-Stapel Bedarf → Dienstplan → Ist ───────────────────────────────
  // GEMEINSAME Helfer (bedarf-stunden-utils) — identische Semantik wie die
  // Personalbedarf-Wochenübersicht: Plan = gespeicherter Dienstplan ohne
  // Absenzen, netto mit ArG-Pausenstaffel; Ist = gestempelte Stunden ohne
  // Absenz-Einträge; ohne Datenquelle bleibt der Wert null (nie 0).
  const stackEmployees = mrEmployees ?? [];
  const stackSchedule = mrSchedule ?? {};
  const stackActual = mrActual ?? {};
  const planStd = stackEmployees.length > 0
    ? planNettoHoursForDates({
        employees: stackEmployees, scheduleData: stackSchedule,
        positions: staffingPositions, dates: alleTage,
      })
    : null;
  const wPlanStd = stackEmployees.length > 0 && wocheTage.length > 0
    ? planNettoHoursForDates({
        employees: stackEmployees, scheduleData: stackSchedule,
        positions: staffingPositions, dates: wocheTage,
      })
    : null;
  const istStd = istHoursForDates(stackActual, alleTage);
  const wIstStd = wocheTage.length > 0 ? istHoursForDates(stackActual, wocheTage) : null;

  // ── Bedarf-Stunden (Soll aus dem Personalbedarf, netto mit ArG-Pausen) ─────
  // Leitplanke der Stapel-Anzeige Bedarf → Dienstplan → Ist: Monat = alle Tage
  // des Monats, Woche = derselbe geklemmte Tagesbereich wie Plan/Ist-Stunden.
  let bedarfStdM: number | null = null, bedarfStdW: number | null = null;
  if (staffingConfig && staffingReqs.length > 0 && staffingPositions.length > 0) {
    const base = { positions: staffingPositions, requirements: staffingReqs, config: staffingConfig };
    bedarfStdM = bedarfNettoHoursForDates({ ...base, dates: alleTage });
    bedarfStdW = wocheTage.length > 0 ? bedarfNettoHoursForDates({ ...base, dates: wocheTage }) : null;
  }

  // ── Personal-Block: ALLE Zahlen aus dem Kern (personalkosten.ts) ───────────
  // KEINE Parallel-Rechnung: FIX/FLEX/Hochrechnung/PKQ stammen aus den zentralen
  // Kern-Funktionen (identisch mit der Personalkosten-Seite).
  let personal: PersonalBlockErgebnis | null = null;
  if (pk) {
    const fixMonat = fixKosten(pk).totalMonat;
    const flexDetail = flexKostenProTagDetail(pk);
    const flexIstProTag: Record<string, number> = {};
    const istTagSet = new Set<string>();
    for (const t of flexDetail.tage) {
      if (t.istTag) { istTagSet.add(t.date); flexIstProTag[t.date] = t.istKosten; }
    }
    const hrKosten = personalkosten(pk, 'hochrechnung');
    const pkq = personalquote(pk);
    personal = computePersonalBlock({
      flexIstProTag,
      istTagSet,
      fixMonat,
      daysInMonth,
      wocheTage,
      wBudgetNet: hatBudget && weekFrom ? r2(wBudgetNet) : null,
      wNetIst: weekFrom && wHatUmsatz ? r2(wNet) : null,
      zielQuote: budgetZielQuote(pk),
      hrKostenMonat: hrKosten.total,
      umsatzBudgetMonat: hatBudget ? r2(budgetNet) : null,
      pkqHrMonat: pkq.pkqHochrechnung,
    });
  }

  // ── Zeilen bauen ───────────────────────────────────────────────────────────
  const N = (v: number, hat: boolean): number | null => (hat ? r2(v) : null);
  const e = (): MrRow => ({ type: 'empty', budget: null, vj: null, vjMonth: null, week: null, weekBudget: null, monthBudget: null, month: null });
  const d = (
    id: string,
    label: string,
    vals: {
      budget?: number | null; vj?: number | null; vjMonth?: number | null;
      week?: number | null; weekBudget?: number | null; monthBudget?: number | null; month?: number | null;
      monthPax?: number | null; weekPax?: number | null; vjMonthPax?: number | null;
    },
    opts: { fmt?: MrFormat; bold?: boolean; deltaInverted?: boolean; warnAbove?: number; deltaPp?: boolean; deltaVsVj?: boolean; tint?: 'green' | 'red' } = {},
  ): MrRow => ({
    type: 'data', id, label,
    budget: vals.budget ?? null, vj: vals.vj ?? null, vjMonth: vals.vjMonth ?? null,
    week: vals.week ?? null, weekBudget: vals.weekBudget ?? null,
    monthBudget: vals.monthBudget ?? null,
    month: vals.month ?? null,
    monthPax: vals.monthPax ?? null, weekPax: vals.weekPax ?? null, vjMonthPax: vals.vjMonthPax ?? null,
    fmt: opts.fmt ?? 'chf', bold: opts.bold,
    deltaInverted: opts.deltaInverted, warnAbove: opts.warnAbove,
    deltaPp: opts.deltaPp, deltaVsVj: opts.deltaVsVj, tint: opts.tint,
  });

  /**
   * Warenkosten-Zeilen: EINE «Warenkosten total»-Zeile (bold) mit kompakter
   * Inline-WKQ (inkl. Food-/Beverage-WKQ, Ziel-Ampel) und darunter die
   * Lieferanten-Zeilen als ausklappbare Kinder (childOf, Standard eingeklappt).
   * Monat = alle Rechnungen des Monats, Woche = Rechnungen im geklemmten
   * Wochenbereich. Leere Periode → null (nie 0); Ladefehler → keine
   * Lieferanten-Zeilen und Total/WKQ leer.
   */
  function buildWarenRows(): MrRow[] {
    // Kontoklassen: «Warenkosten total»/WKQ/Lieferanten-Kinder zählen NUR die
    // Anteile auf Warenkosten-Konten (4000–Grenze); Betriebskosten-Anteile
    // (> Grenze, z.B. 4071/6040) laufen in eine separate Zeile und fliessen
    // NIE in die WKQ — keine Doppelzählung, Summe = alle Rechnungen.
    const invAll = warenInvoices;
    const inv = invAll ? nurWarenAnteil(invAll, warenGrenze) : null;
    const weekInvAll = invAll && weekFrom && weekTo ? filterInvoicesByRange(invAll, weekFrom, weekTo) : null;
    const weekInv = inv && weekFrom && weekTo ? filterInvoicesByRange(inv, weekFrom, weekTo) : null;
    const monthTotal = inv && inv.length > 0 ? r2(sumInvoicesNet(inv)) : null;
    const weekTotal = weekInv && weekInv.length > 0 ? r2(sumInvoicesNet(weekInv)) : null;
    const aggs = inv ? aggregateBySupplier(inv) : [];
    // Kollisionssichere IDs («Migros» vs «MIGROS!» → 'migros'/'migros_2'),
    // sonst überschreibt applyRowOrder eine der Zeilen (Map nach ID).
    const ids = supplierRowIds(aggs.map(a => a.supplierName));
    const supplierRows: MrRow[] = aggs.map((agg, i) => {
      const wSum = weekInv
        ? sumInvoicesNet(weekInv.filter(e2 => (e2.supplierName.trim() || '—') === agg.supplierName))
        : 0;
      // Quote je Lieferant in % auf den Netto-Umsatz der Periode (nie ÷ 0);
      // die Summe der Lieferanten-% ergibt die Gesamt-WKQ.
      const mPct = mNetV != null && mNet > 0 && agg.totalNet > 0 ? r2((agg.totalNet / mNet) * 100) : null;
      const wPct = wNetV != null && wNet > 0 && wSum > 0 ? r2((wSum / wNet) * 100) : null;
      return {
        ...d(`warenkosten_${ids[i]}`, `Warenkosten · ${agg.supplierName}`, {
          month: r2(agg.totalNet),
          week: wSum > 0 ? r2(wSum) : null,
        }, { deltaInverted: true }),
        childOf: 'warenkosten_total',
        pctOfRevenue: { month: mPct, week: wPct },
      };
    });
    // Kompakte WKQ-Infos je Granularität (nie durch 0; ohne Umsatz → null).
    const wkqInfo = (list: InvoiceEntry[] | null, total: number | null,
      netV: number | null, net: number): WkqInlineInfo | null => {
      if (total == null) return null;
      const hatUmsatz = netV != null && net > 0;
      const katPct = (kat: 'Food' | 'Beverage'): number | null => {
        if (!hatUmsatz || !list) return null;
        const s = sumNetByKategorie(list, kat, warenKonten);
        return s > 0 ? r2((s / net) * 100) : null;
      };
      return {
        pct: hatUmsatz ? r2((total / net) * 100) : null,
        ziel: r2(zielWkq),
        food: katPct('Food'),
        bev: katPct('Beverage'),
      };
    };
    const totalRow: MrRow = {
      ...d('warenkosten_total', 'Warenkosten total', {
        month: monthTotal, week: weekTotal,
      }, { bold: true, deltaInverted: true }),
      wkqInline: {
        month: wkqInfo(inv, monthTotal, mNetV, mNet),
        week: wkqInfo(weekInv, weekTotal, wNetV, wNet),
      },
    };
    // Betriebskosten (Konten > Grenze) der Waren-Lieferanten: separat, klar
    // getrennt von der WKQ; «leer statt 0» (0 nur wenn wirklich Anteile = 0
    // existieren würden → dann ebenfalls leer, keine erfundene Aussage).
    const mBetrieb = invAll ? sumBetriebNet(invAll, warenGrenze) : 0;
    const wBetrieb = weekInvAll ? sumBetriebNet(weekInvAll, warenGrenze) : 0;
    const betriebRow: MrRow | null = invAll && mBetrieb > 0 ? {
      ...d('betriebskosten_waren', 'Betriebskosten (Waren-Lieferanten)', {
        month: r2(mBetrieb),
        week: wBetrieb > 0 ? r2(wBetrieb) : null,
      }, { deltaInverted: true }),
    } : null;
    return [totalRow, ...supplierRows, ...(betriebRow ? [betriebRow] : [])];
  }

  /** Lieferanten-Aufstellung für den Excel-Export (zweites Blatt «Warenkosten»). */
  function buildWarenExport(): MonatsreportDaten['waren'] {
    const invAll = warenInvoices;
    const weekInvAll = invAll && weekFrom && weekTo ? filterInvoicesByRange(invAll, weekFrom, weekTo) : null;
    // Konsistent zum Cockpit: Lieferanten/Total/WKQ = nur Warenkosten-Anteile
    // (4000–Grenze); Betriebskosten-Anteile als separate Summe im Blatt.
    const period = (listAll: InvoiceEntry[] | null, netV: number | null, net: number): WarenExportPeriod | null => {
      if (!listAll || listAll.length === 0) return null;
      const list = nurWarenAnteil(listAll, warenGrenze);
      const betrieb = sumBetriebNet(listAll, warenGrenze);
      return {
        suppliers: aggregateBySupplier(list).map(a => ({
          name: a.supplierName, net: r2(a.totalNet), count: a.count,
        })),
        total: r2(sumInvoicesNet(list)),
        revenue: netV != null && net > 0 ? r2(net) : null,
        betrieb: betrieb > 0 ? r2(betrieb) : null,
      };
    };
    return {
      monat: period(invAll, mNetV, mNet),
      woche: period(weekInvAll, wNetV, wNet),
      zielWkq: r2(zielWkq),
    };
  }

  const mGrossV = N(mGross, mHatUmsatz);
  const mNetV = N(mNet, mHatUmsatz);
  const wGrossV = weekFrom ? N(wGross, wHatUmsatz) : null;
  const wNetV = weekFrom ? N(wNet, wHatUmsatz) : null;
  const budgetGross = hatBudget ? r2(budgetNet * VAT_STD) : null;
  const budgetNetV = hatBudget ? r2(budgetNet) : null;
  const wBudget = hatBudget && weekFrom ? r2(wBudgetNet) : null;
  const vjGrossV = N(vjGross, hatVj);
  const vjNetV = hatVj ? r2(vjGross / VAT_STD) : null;
  const mGaesteV = N(mGaeste, hatGaeste);
  const wGaesteV = weekFrom ? N(wGaeste, hatWGaeste) : null;
  const vjGaesteV = N(vjGaeste, hatVjGaeste);
  const taM = mHatUmsatz && mTa > 0 ? r2(mTa) : null;
  const taW = weekFrom && wHatUmsatz && wTa > 0 ? r2(wTa) : null;

  // ── Vorjahres-WOCHE: Anzeigewerte der «Vorjahr (Woche)»-Spalte ─────────────
  // Absolutwerte = Summe über die VJ-Woche; Quoten/Prozente = über die Woche
  // gebildet (NICHT summiert). «leer statt 0».
  const hatVw = vjWochePaare.length > 0;
  const vwGrossV = hatVw && hatVwUmsatz ? r2(vwGross) : null;
  const vwNetV = hatVw && hatVwUmsatz ? r2(vwNet) : null;
  const vwGaesteV = hatVw && hatVwGaeste ? r2(vwGaeste) : null;
  const vwFoodNet = hatVw && hatVwFood ? r2(vwFoodG / VAT_STD) : null;
  const vwBevNet = hatVw && hatVwBev ? r2(vwBevG / VAT_STD) : null;
  // Durchschnittsverkauf VJ-Woche: gäste-gewichtet (Fallback einfacher Mittel).
  let vwAvg: number | null = null;
  if (hatVw) {
    if (vwAvgWeight > 0) vwAvg = r2(vwAvgSum / vwAvgWeight);
    else if (vwAvgSimpleCount > 0) vwAvg = r2(vwAvgSimpleSum / vwAvgSimpleCount);
  }
  // TA-Anteil VJ-Woche = TA-Umsatz ÷ Gesamt-Umsatz der VJ-Woche.
  const vwTaAnteil = hatVw && hatVwTa && vwGross > 0 ? r2((vwTa / vwGross) * 100) : null;
  // Take-Away-UMSATZ VJ-Woche (CHF brutto) — Zähler des VJ-Anteils. «—» wenn keine TA-Quelle.
  const vwTaUmsatz = hatVw && hatVwTa && vwTa > 0 ? r2(vwTa) : null;
  // Umsatz/Gast VJ-Woche = Netto ÷ Gäste über gepaarte Tage (Regel wie Ist).
  const vwUpg = hatVw && vwPairedGaeste > 0 ? r2(vwPairedNet / vwPairedGaeste) : null;

  // ── Vorjahres-MONAT: Anzeigewerte der «Vorjahr»-Spalte in der Monatssicht ──
  // Absolutwerte = Summe über den Vorjahres-Monat; Quoten als Quote (nicht
  // summiert), gleiche Regeln wie Ist. «leer statt 0».
  const vjTaAnteilM = hatVjTa && vjGross > 0 ? r2((vjTa / vjGross) * 100) : null;
  // Take-Away-UMSATZ Vorjahres-Monat (CHF brutto) — Zähler des VJ-Anteils. «—» ohne TA-Quelle.
  const vjTaUmsatzM = hatVjTa && vjTa > 0 ? r2(vjTa) : null;
  const vjUpgM = vjPairedGaeste > 0 ? r2(vjPairedNet / vjPairedGaeste) : null;
  const vjFoodNet = hatVjFood ? r2(vjFoodG / VAT_STD) : null;
  const vjBevNet = hatVjBev ? r2(vjBevG / VAT_STD) : null;

  /** Anteil n ÷ basis in % — null ohne Basis oder Wert (nie durch 0 teilen). */
  const anteilPct = (n: number | null | undefined, basis: number | null): number | null =>
    n != null && basis != null && basis > 0 ? r2((n / basis) * 100) : null;

  const rows: MrRow[] = [
    // ── Block Umsatz/Gäste ──
    // Budget-Spalte = Budget-WOCHENANTEIL (= weekBudget, Basis der Woche-Δ%);
    // Vorjahr-Spalte = VJ-WOCHE. monthBudget trägt das Monatsbudget für die Monat-Δ%.
    d('brutto_umsatz', 'Brutto Umsatz', {
      month: mGrossV, week: wGrossV,
      weekBudget: wBudget != null ? r2(wBudget * VAT_STD) : null,
      budget: wBudget != null ? r2(wBudget * VAT_STD) : null,
      monthBudget: budgetGross,
      vj: vwGrossV, vjMonth: vjGrossV,
    }, { bold: true }),
    d('netto_umsatz', 'Netto Umsatz', {
      month: mNetV, week: wNetV,
      weekBudget: wBudget, budget: wBudget, monthBudget: budgetNetV,
      vj: vwNetV, vjMonth: vjNetV,
    }, { bold: true }),
    d('gaeste_in', 'Gäste IN', { month: mGaesteV, week: wGaesteV, vj: vwGaesteV, vjMonth: vjGaesteV }, { fmt: 'count' }),
    // Reservierte Gäste (Foratable): Σ Personen gezählter Reservationen. Woche =
    // gewählte Woche, Monat = ganzer Monat (inkl. Zukunft). VJ-Woche leer (keine
    // KW-genaue VJ-Zuordnung); VJ-Monat = gleicher Monat Vorjahr.
    {
      ...d('reservierte_gaeste', 'Reservierte Gäste', {
        month: resMonth.reservedGuests, week: resWeek.reservedGuests,
        vj: null, vjMonth: resVjMonth.reservedGuests,
      }, { fmt: 'count' }),
      // Anteil an «Gäste IN» (Basis = 100 %); ohne Gäste-IN-Basis null (nie ÷ 0).
      sharePct: {
        month: anteilPct(resMonth.reservedGuests, mGaesteV),
        week: anteilPct(resWeek.reservedGuests, wGaesteV),
        vj: null,
        vjMonth: anteilPct(resVjMonth.reservedGuests, vjGaesteV),
      },
    },
    // Gruppen ab N Pax: Anzeige «Anzahl (Σ Personen · Anteil an Gäste IN)».
    // Companion-Personen je Spalte in *Pax-Feldern. VJ-Woche leer; VJ-Monat vorhanden.
    {
      ...d('gruppen_ab_20', `Gruppen ab ${resSettings.groupThreshold} Pax`, {
        month: resMonth.largeGroupCount, week: resWeek.largeGroupCount,
        vj: null, vjMonth: resVjMonth.largeGroupCount,
        monthPax: resMonth.largeGroupPersons, weekPax: resWeek.largeGroupPersons,
        vjMonthPax: resVjMonth.largeGroupPersons,
      }, { fmt: 'countPax' }),
      // Anteil = Σ PERSONEN der Gruppen ÷ Gäste IN (nicht Anzahl Gruppen).
      sharePct: {
        month: anteilPct(resMonth.largeGroupPersons, mGaesteV),
        week: anteilPct(resWeek.largeGroupPersons, wGaesteV),
        vj: null,
        vjMonth: anteilPct(resVjMonth.largeGroupPersons, vjGaesteV),
      },
    },
    // Gäste Take Away (Produktanalyse): Σ Stückzahlen aller TA-Produkte (1 Stück
    // = 1 TA-Gast). Woche = gewählte Woche, Monat = ganzer Monat (inkl. Zukunft).
    // VJ-Monat aus derselben Quelle (Jahr−1); VJ-Woche «—». Quelle fehlt → «—» (nie 0).
    d('gaeste_take_away', 'Gäste Take Away', {
      month: taMonth, week: taWeek,
      vj: null, vjMonth: taVjMonth,
    }, { fmt: 'count' }),
    e(),
    // ── Block Durchschnitt ──
    // Durchschnittsverkauf = importierter Wert (Zeitraum-Spalte massgeblich),
    // NICHT berechnet — die berechnete Grösse ist «Umsatz pro Gast».
    d('durchschnittsverkauf', 'Durchschnittsverkauf', {
      month: avgMonat,
      week: avgWoche,
      vj: vwAvg, vjMonth: avgVj,
    }),
    d('take_away_anteil', 'Take Away Anteil', {
      month: taM != null && mGross > 0 ? r2((mTa / mGross) * 100) : null,
      week: taW != null && wGross > 0 ? r2((wTa / wGross) * 100) : null,
      // Vorjahr-Woche: TA-Umsatz ÷ Gesamt-Umsatz der VJ-Woche (Quote, nicht summiert).
      vj: vwTaAnteil, vjMonth: vjTaAnteilM,
    }, { fmt: 'pct' }),
    // Take Away Umsatz (CHF brutto): identische Quelle wie der TA-Anteil (dessen
    // Zähler = takeawayRevenue/takeAwayBrutto). Es gilt: Anteil = Umsatz ÷ Gesamt.
    // Woche = gewählte Woche, Monat = ganzer Monat; VJ wie beim TA-Anteil.
    // Kein Budget vorhanden → Δ% gegen das Vorjahr (deltaVsVj), Farblogik wie
    // die übrigen Umsatzkennzahlen (mehr = grün).
    d('take_away_umsatz', 'Take Away Umsatz', {
      month: taM, week: taW,
      vj: vwTaUmsatz, vjMonth: vjTaUmsatzM,
    }, { deltaVsVj: true }),
    e(),
    // ── Block Sparten (netto) — Gastronovi-Begriffe, Vorjahr in vj-Spalte ──
    d('food', 'Food', {
      month: mHatUmsatz && mFood > 0 ? r2(mFood) : null,
      week: weekFrom && wHatUmsatz && wFood > 0 ? r2(wFood) : null,
      vj: vwFoodNet, vjMonth: vjFoodNet,
    }),
    d('beverage', 'Beverage', {
      month: mHatUmsatz && mBev > 0 ? r2(mBev) : null,
      week: weekFrom && wHatUmsatz && wBev > 0 ? r2(wBev) : null,
      vj: vwBevNet, vjMonth: vjBevNet,
    }),
    e(),
    // ── Block Produktivität ──
    // Stapel Bedarf → Dienstplan → Ist: Bedarf = Leitplanke (Budget-Spalte der
    // beiden Folgezeilen ⇒ Δ% mit Kosten-Ampel: über Bedarf = rot).
    d('bedarf_stunden', 'Bedarf-Stunden (Soll)', {
      month: bedarfStdM, week: bedarfStdW,
    }, { fmt: 'hours', bold: true }),
    d('prod_stunden_plan', 'Dienstplan-Stunden (Plan)', {
      month: planStd, week: wPlanStd,
      monthBudget: bedarfStdM, budget: bedarfStdW, weekBudget: bedarfStdW,
    }, { fmt: 'hours', deltaInverted: true }),
    d('prod_stunden_ist', 'Ist-Stunden (MIRUS)', {
      month: istStd, week: wIstStd,
      monthBudget: bedarfStdM, budget: bedarfStdW, weekBudget: bedarfStdW,
    }, { fmt: 'hours', deltaInverted: true }),
    d('produktivitaet', 'Produktivität (Umsatz/Std)', {
      month: mNetV != null && istStd ? r2(mNet / istStd) : null,
      week: wNetV != null && wIstStd ? r2(wNet / wIstStd) : null,
      // vj_daily hat keine Personalstunden → keine VJ-Produktivität.
    }),
    // Netto ÷ Gäste, NUR über Tage mit BEIDEN Quellen (Umsatz + Gäste).
    d('umsatz_pro_gast', 'Umsatz pro Gast', {
      month: pairedGaeste > 0 ? r2(pairedNet / pairedGaeste) : null,
      week: weekFrom && wPairedGaeste > 0 ? r2(wPairedNet / wPairedGaeste) : null,
      // Vorjahr: Netto-VJ ÷ Gäste-VJ über gepaarte Tage (Woche bzw. Monat).
      vj: vwUpg, vjMonth: vjUpgM,
    }),
    e(),
    // ── Block Personal (ALLE Werte aus dem Kern personalkosten.ts) ─────────────
    // Kosten-Zeile: deltaInverted → über Budget = rot. MONAT = Hochrechnung
    // (bewusst anders als «Ist bis heute» der übrigen Zeilen; im Label markiert).
    d('personalkosten', 'Personalkosten (Monat = Hochrechnung)', {
      week: personal?.pkIstWoche ?? null,
      weekBudget: personal?.pkBudgetWoche ?? null,
      budget: personal?.pkBudgetWoche ?? null,
      monthBudget: personal?.pkBudgetMonat ?? null,
      month: personal?.pkHrMonat ?? null,
      // Vorjahr NUR Monat: Buchhaltungswert (vorjahres_personalkosten,
      // ausschliesslich Jahre < 2026 ohne Dienstplan-Berechnung).
      // KEINE Verteilung auf Wochen → vj (Woche) bleibt leer.
      vj: null, vjMonth: pkVj ? r2(pkVj.chf) : null,
    }, { bold: true, deltaInverted: true }),
    // PKQ: Budget = Ziel-PKQ (Budget-Personalkosten ÷ Budget-Umsatz, aus dem
    // Kern budgetZielQuote) in BEIDEN Sichten; Δ = Ist − Ziel in PROZENTPUNKTEN
    // (deltaPp, über Ziel = rot); zusätzlich rot über harter Obergrenze.
    d('personalquote', 'Personalquote (PKQ)', {
      budget: pk ? r2(budgetZielQuote(pk) * 100) : null,
      weekBudget: pk ? r2(budgetZielQuote(pk) * 100) : null,
      monthBudget: pk ? r2(budgetZielQuote(pk) * 100) : null,
      week: personal?.pkqWochePct ?? null,
      month: personal?.pkqMonatPct ?? null,
      // PKQ Vorjahr (nur Monat) = Buchhaltungs-Personalkosten ÷ Netto-Umsatz
      // desselben VJ-Monats (vj_daily, Standard-MwSt-Netto).
      vj: null,
      vjMonth: pkVj && vjNetV != null && vjNetV > 0 ? r2((pkVj.chf / vjNetV) * 100) : null,
    }, { fmt: 'pct', warnAbove: OBERGRENZE_PKQ_PCT, deltaPp: true }),
    e(),
    // ── Block Warenkosten (erfasste Warenrechnungen, netto) ────────────────
    // Eine Zeile pro Lieferant (Top-Betrag des Monats zuerst) + Total + WKQ.
    // Leere Perioden bleiben leer (nie 0 erfinden); Ladefehler → alles leer.
    // Kosten-Logik (deltaInverted); WKQ mit Ziel-Quote als Budget und Δ in PP
    // (über Ziel = rot, wie PKQ).
    ...buildWarenRows(),
    e(),
    // ── Block Rezensionen (Google-Erfassung + Lunchgate-Feedback-Import) ────
    // Pro Plattform ALLE fünf Sternstufen (5/4/3/2/1): Monat = ganzer Monat,
    // Woche = gewählte Woche. Kein Budget/Vorjahr (Quelle existiert erst seit
    // der Einzelerfassung) → Felder leer. Farbe: 5 grün, 1 rot, sonst neutral.
    // Google und Lunchgate strikt getrennt (Plattform-Filter, nie vermischt).
    ...reviewStarRowDefs().map(({ platform, star, id, label, tint }) =>
      d(id, label, {
        month: reviewSingles ? countReviewsByStar(reviewSingles, platform, fromIso, toIso, star) : null,
        week: reviewSingles && weekFrom && weekTo
          ? countReviewsByStar(reviewSingles, platform, weekFrom, weekTo, star) : null,
      }, { fmt: 'count', tint }),
    ),
  ];

  // Take-Away-Zeilen entfernen, wenn der Betrieb kein Take Away anbietet.
  const rowsFinal = filterTakeAwayRows(rows, taOffered);

  return {
    year, month, weekFrom, weekTo, weekLabel,
    vjWeekFrom: vjWochePaare.length > 0 ? vjWochePaare[0].vj : null,
    vjWeekTo: vjWochePaare.length > 0 ? vjWochePaare[vjWochePaare.length - 1].vj : null,
    rows: rowsFinal,
    waren: buildWarenExport(),
  };
}

// ── Wochenverlauf (mehrere abgeschlossene Wochen nebeneinander) ──────────────

/** Eine Kennzahl-Zeile im Wochenverlauf: Werte je Wochenfenster (null = leer). */
export interface WochenverlaufRow {
  label: string;
  fmt: MrFormat;
  bold?: boolean;
  /** Werte je Woche (Reihenfolge = weeks), null = keine Datenquelle */
  values: (number | null)[];
  /** Vorjahreswerte je Woche (nur bei mitVorjahr), null = keine VJ-Quelle */
  vjValues?: (number | null)[];
  /** Farb-Tönung der Werte (Rezensions-Zeilen: 5 grün, 1 rot, 3 neutral). */
  tint?: 'green' | 'red';
  /** Stabile Zeilen-ID (nur für Gruppierungszwecke, z.B. 'warenkosten_total'). */
  id?: string;
  /** ID der Eltern-Zeile: ausklappbares Kind (Standard eingeklappt). */
  childOf?: string;
  /**
   * Kompakte WKQ je Woche (nur «Warenkosten total»): Prozentwert unter dem
   * CHF-Wert, Ampel gegen `wkqZiel` (über Ziel = rot); null = kein Umsatz.
   */
  wkqValues?: (number | null)[];
  /** Ziel-WKQ in % für die Ampel der `wkqValues`. */
  wkqZiel?: number;
}

export interface WochenverlaufDaten {
  weeks: WeekWindow[];
  /** Vorjahres-Wochen je Spalte (nur bei mitVorjahr; null = KW im VJ inexistent) */
  vjWeeks?: (WeekWindow | null)[];
  rows: WochenverlaufRow[];
  /**
   * Index der LAUFENDEN (partiellen) Woche in `weeks` — nur im aktuellen Jahr
   * gesetzt. Die Ist-Aggregation dieser Woche ist auf «bis heute» geklemmt;
   * Trend-/Vorjahres-Δ sind für diese Spalte nicht aussagekräftig (partiell
   * vs. volle Woche) und sollen in der UI unterdrückt/markiert werden.
   */
  partialWeekIndex: number | null;
}

/** Enthält das Wochenfenster das Datum `todayIso` (⇒ laufende Woche)? */
export function isRunningWeek(w: WeekWindow, todayIso: string): boolean {
  return todayIso >= w.from && todayIso <= w.to;
}

/**
 * Aggregierte Tageswerte einer Woche — dieselbe Logik/Quellen wie
 * ladeMonatsreport, nur pro Wochenfenster (keine Z-Berichte).
 */
interface WeekAgg {
  gross: number; net: number; ta: number; food: number; bev: number; hatUmsatz: boolean;
  gaeste: number; hatGaeste: boolean;
  pairedNet: number; pairedGaeste: number; // Tage mit Umsatz UND Gästen
  avgW: number | null;
  istStd: number; hatIst: boolean;
  planStd: number; hatPlan: boolean;
}

function emptyAgg(): WeekAgg {
  return {
    gross: 0, net: 0, ta: 0, food: 0, bev: 0, hatUmsatz: false,
    gaeste: 0, hatGaeste: false, pairedNet: 0, pairedGaeste: 0, avgW: null,
    istStd: 0, hatIst: false, planStd: 0, hatPlan: false,
  };
}

/**
 * Vorjahres-Aggregat je Woche (vj_daily brutto → netto per VAT_STD, wie im
 * Monats-VJ-Zweig). Keine VJ-Quelle für Produktive Stunden/Produktivität.
 */
interface VjWeekAgg {
  gross: number; net: number; food: number; bev: number; ta: number;
  hatUmsatz: boolean; hatFood: boolean; hatBev: boolean; hatTa: boolean;
  gaeste: number; hatGaeste: boolean;
  avgSum: number; avgCount: number;             // avgcheck-daily: einfacher Mittelwert
  pairedNet: number; pairedGaeste: number;      // vj-Umsatz>0 UND Gäste>0
}

function emptyVjAgg(): VjWeekAgg {
  return {
    gross: 0, net: 0, food: 0, bev: 0, ta: 0,
    hatUmsatz: false, hatFood: false, hatBev: false, hatTa: false,
    gaeste: 0, hatGaeste: false, avgSum: 0, avgCount: 0,
    pairedNet: 0, pairedGaeste: 0,
  };
}

/**
 * Aggregiert vj_daily + gaeste-daily + avgcheck-daily auf die gegebenen
 * Wochenfenster (Mo–So) — dieselbe Logik/Quellen wie der Vorjahres-Zweig.
 * Wird für den Vorjahresvergleich UND für ein allein ausgewertetes
 * Vergangenheits-Jahr (Hauptlinie aus vj_daily) genutzt. Wochen = null → kein
 * Aggregat (KW existiert im Zieljahr nicht). Keine Personalstunden aus dieser
 * Quelle (Produktive Stunden/Produktivität bleiben «—»).
 */
async function aggregiereVjWochen(
  weeks: (WeekWindow | null)[],
  tenantId: TenantId,
  gaesteDaily: Record<string, number>,
  avgDaily: Record<string, number>,
): Promise<(VjWeekAgg | null)[]> {
  const indexOf = (date: string): number => {
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      if (w && date >= w.from && date <= w.to) return i;
    }
    return -1;
  };
  // Berührte vj_daily-Monate (kann Monatsgrenzen überschreiten).
  const months = new Map<string, { year: number; month: number }>();
  for (const w of weeks) {
    if (!w) continue;
    for (const dateStr of [w.from, w.to]) {
      months.set(`${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}`,
        { year: Number(dateStr.slice(0, 4)), month: Number(dateStr.slice(5, 7)) });
    }
  }
  const monthMaps = await Promise.all(
    [...months.values()].map(({ year, month }) =>
      loadVjDailyMonth(year, month, tenantId).catch(() => ({} as Record<string, VjDayRecord>))),
  );
  const vjDaily: Record<string, VjDayRecord> = {};
  for (const m of monthMaps) Object.assign(vjDaily, m);

  const aggs = weeks.map(w => (w ? emptyVjAgg() : null));

  for (const [date, rec] of Object.entries(vjDaily)) {
    const wi = indexOf(date);
    if (wi < 0) continue;
    const a = aggs[wi];
    if (!a) continue;
    if ((rec.actualRevenue ?? 0) > 0) {
      a.gross += rec.actualRevenue; a.net += rec.actualRevenue / VAT_STD; a.hatUmsatz = true;
    }
    if ((rec.foodRevenue ?? 0) > 0) { a.food += rec.foodRevenue! / VAT_STD; a.hatFood = true; }
    if ((rec.beverageRevenue ?? 0) > 0) { a.bev += rec.beverageRevenue! / VAT_STD; a.hatBev = true; }
    if ((rec.takeawayRevenue ?? 0) > 0) { a.ta += rec.takeawayRevenue!; a.hatTa = true; }
    const g = gaesteDaily[date] ?? 0;
    if ((rec.actualRevenue ?? 0) > 0 && g > 0) {
      a.pairedNet += rec.actualRevenue / VAT_STD; a.pairedGaeste += g;
    }
  }
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (!(n > 0)) continue;
    const wi = indexOf(date);
    if (wi < 0) continue;
    const a = aggs[wi];
    if (!a) continue;
    a.gaeste += n; a.hatGaeste = true;
  }
  for (const [date, v] of Object.entries(avgDaily)) {
    if (!(v > 0)) continue;
    const wi = indexOf(date);
    if (wi < 0) continue;
    const a = aggs[wi];
    if (!a) continue;
    a.avgSum += v; a.avgCount++;
  }
  return aggs;
}

/**
 * Baut die Kennzahlen-Zeilen des Wochenverlaufs. `mainAus` = Datenquelle der
 * Hauptlinie: 'ist' (WeekAgg, aktuelles Jahr, inkl. Personalstunden) oder 'vj'
 * (VjWeekAgg, vergangenes Jahr aus vj_daily, keine Stunden). `vjAggs` = optionale
 * Vergleichs-Spalte (immer aus vj_daily).
 */
function baueWochenverlaufRows(
  mainAggs: WeekAgg[] | (VjWeekAgg | null)[],
  mainAus: 'ist' | 'vj',
  vjAggs: (VjWeekAgg | null)[] | undefined,
): WochenverlaufRow[] {
  const vjCol = (fn: (a: VjWeekAgg) => number | null): (number | null)[] | undefined =>
    vjAggs ? vjAggs.map(a => (a ? fn(a) : null)) : undefined;

  // Hauptspalte je Kennzahl: aus WeekAgg (Ist) oder VjWeekAgg (vergangenes Jahr).
  const istCol = (fn: (a: WeekAgg) => number | null): (number | null)[] =>
    (mainAggs as WeekAgg[]).map(fn);
  const vjMainCol = (fn: (a: VjWeekAgg) => number | null): (number | null)[] =>
    (mainAggs as (VjWeekAgg | null)[]).map(a => (a ? fn(a) : null));

  // Für jede Kennzahl je ein Ist- und ein Vj-Extraktor (gleiche Semantik wie
  // bisher; Produktive Stunden/Produktivität aus vj-Quelle → null).
  type Def = {
    label: string; fmt: MrFormat; bold?: boolean;
    ist: (a: WeekAgg) => number | null;
    vj: (a: VjWeekAgg) => number | null;
  };
  const defs: Def[] = [
    { label: 'Brutto Umsatz', fmt: 'chf', bold: true,
      ist: a => a.hatUmsatz ? r2(a.gross) : null, vj: a => a.hatUmsatz ? r2(a.gross) : null },
    { label: 'Netto Umsatz', fmt: 'chf', bold: true,
      ist: a => a.hatUmsatz ? r2(a.net) : null, vj: a => a.hatUmsatz ? r2(a.net) : null },
    { label: 'Gäste IN', fmt: 'count',
      ist: a => a.hatGaeste ? r2(a.gaeste) : null, vj: a => a.hatGaeste ? r2(a.gaeste) : null },
    { label: 'Durchschnittsverkauf', fmt: 'chf',
      ist: a => a.avgW, vj: a => a.avgCount > 0 ? r2(a.avgSum / a.avgCount) : null },
    { label: 'Take Away Anteil', fmt: 'pct',
      ist: a => a.hatUmsatz && a.gross > 0 && a.ta > 0 ? r2((a.ta / a.gross) * 100) : null,
      vj: a => a.hatTa && a.gross > 0 ? r2((a.ta / a.gross) * 100) : null },
    { label: 'Food', fmt: 'chf',
      ist: a => a.hatUmsatz && a.food > 0 ? r2(a.food) : null, vj: a => a.hatFood ? r2(a.food) : null },
    { label: 'Beverage', fmt: 'chf',
      ist: a => a.hatUmsatz && a.bev > 0 ? r2(a.bev) : null, vj: a => a.hatBev ? r2(a.bev) : null },
    { label: 'Produktive Stunden (Ist)', fmt: 'hours',
      ist: a => a.hatIst ? r2(a.istStd) : null, vj: () => null },       // keine vj-Quelle
    { label: 'Produktive Stunden geplant', fmt: 'hours',
      ist: a => a.hatPlan ? r2(a.planStd) : null, vj: () => null },      // keine vj-Quelle
    { label: 'Produktivität (Umsatz/Std)', fmt: 'chf',
      ist: a => a.hatUmsatz && a.hatIst && a.istStd > 0 ? r2(a.net / a.istStd) : null, vj: () => null },
    { label: 'Umsatz pro Gast', fmt: 'chf',
      ist: a => a.pairedGaeste > 0 ? r2(a.pairedNet / a.pairedGaeste) : null,
      vj: a => a.pairedGaeste > 0 ? r2(a.pairedNet / a.pairedGaeste) : null },
  ];

  return defs.map(d => ({
    label: d.label, fmt: d.fmt, bold: d.bold,
    values: mainAus === 'ist' ? istCol(d.ist) : vjMainCol(d.vj),
    vjValues: vjCol(d.vj),
  }));
}

/**
 * Lädt `anzahlWochen` ISO-Wochen (Mo–So) des gewählten Jahres und berechnet je
 * Woche dieselben Kennzahlen wie der Monatsreport. KEINE Z-Berichte, «leer statt
 * 0».
 *
 * Jahr-Auswahl (`jahr`, Default = aktuelles Jahr → rückwärtskompatibel):
 *  - Aktuelles Jahr: letzte N abgeschlossene Wochen; Hauptlinie aus
 *    ladeUmsatzTage (dailyBudgets) inkl. Personalstunden.
 *  - Vergangenes Jahr: DIESELBEN KW-Nummern, aber im gewählten ISO-Wochenjahr
 *    (KW existiert dort nicht → Woche weggelassen). Hauptlinie aus vj_daily
 *    (konsistent zum Vorjahresvergleich); keine Personalstunden → «—».
 *
 * `mitVorjahr` bezieht sich stets aufs GEWÄHLTE Jahr (Vergleich = Jahr−1).
 */
export async function ladeWochenverlauf(
  anzahlWochen: number,
  tenantId: TenantId,
  tenantKey: KeyFn,
  rates: SocialCostRates,
  heute: Date = new Date(),
  mitVorjahr = false,
  jahr?: number,
): Promise<WochenverlaufDaten> {
  const anzahl = Math.max(1, anzahlWochen);
  const curYear = heute.getFullYear();
  const selectedYear = jahr ?? curYear;
  const istAktuell = selectedYear === curYear;

  const weeks = computeWeeksForYear(anzahl, heute, selectedYear);

  // Globale KV-Maps sind ISO-datumsbasiert → liefern automatisch die Daten des
  // gewählten Jahres (Gäste, Durchschnittsverkauf).
  const [gaesteDaily, avgDaily] = await Promise.all([
    loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
  ]);

  // Laufende (partielle) Woche: nur im aktuellen Jahr; Ist-Aggregation wird
  // auf «bis heute» geklemmt, damit keine zukünftigen Datensätze einfliessen.
  const todayIso = iso(new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()));
  const partialWeekIndex = istAktuell
    ? (() => { const i = weeks.findIndex(w => isRunningWeek(w, todayIso)); return i >= 0 ? i : null; })()
    : null;

  // Welcher Woche gehört ein Datum? (Index in weeks) — sonst -1.
  // Im aktuellen Jahr werden Zukunfts-Daten (date > heute) NIE zugeordnet.
  const weekIndexOf = (date: string): number => {
    if (istAktuell && date > todayIso) return -1;
    for (let i = 0; i < weeks.length; i++) {
      if (date >= weeks[i].from && date <= weeks[i].to) return i;
    }
    return -1;
  };

  // ── Hauptlinie ─────────────────────────────────────────────────────────────
  let mainAggs: WeekAgg[] | (VjWeekAgg | null)[];
  let mainAus: 'ist' | 'vj';

  if (istAktuell) {
    // Aktuelles Jahr: Umsatz-Import (dailyBudgets) + Personalstunden wie bisher.
    mainAus = 'ist';
    const fromIso = weeks[0].from;
    const toIso = weeks[weeks.length - 1].to;
    const umsatzTage = await ladeUmsatzTage(tenantId, fromIso, toIso);

    // Personalkosten monatsweise (alle berührten Monate einmalig).
    const monthsTouched = new Map<string, { year: number; month: number }>();
    for (const w of weeks) {
      for (const dateStr of [w.from, w.to]) {
        monthsTouched.set(`${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}`,
          { year: Number(dateStr.slice(0, 4)), month: Number(dateStr.slice(5, 7)) });
      }
    }
    const pkList = await Promise.all(
      [...monthsTouched.values()].map(({ year, month }) =>
        ladePersonalkostenDaten(year, month, tenantId, tenantKey, rates).catch(() => null)),
    );
    const istStdProTag: Record<string, Record<string, number>> = {};
    const planStdProTag: Record<string, Record<string, number>> = {};
    for (const pk of pkList) {
      if (!pk) continue;
      for (const [date, perEmp] of Object.entries(pk.istStdProTag) as [string, Record<string, number>][]) {
        istStdProTag[date] = { ...(istStdProTag[date] ?? {}), ...perEmp };
      }
      for (const [date, perEmp] of Object.entries(pk.planStdProTag) as [string, Record<string, number>][]) {
        planStdProTag[date] = { ...(planStdProTag[date] ?? {}), ...perEmp };
      }
    }

    const aggs: WeekAgg[] = weeks.map(emptyAgg);
    for (const [date, tag] of umsatzTage) {
      const wi = weekIndexOf(date);
      if (wi < 0 || tag.gesamtBrutto <= 0) continue;
      const a = aggs[wi];
      const netto = nettoUmsatzTag(tag);
      const split = foodBeverageSplit(tag);
      a.gross += tag.gesamtBrutto; a.ta += tag.takeAwayBrutto; a.net += netto;
      a.food += split.food; a.bev += split.beverage; a.hatUmsatz = true;
      const g = gaesteDaily[date] ?? 0;
      if (g > 0) { a.pairedNet += netto; a.pairedGaeste += g; }
    }
    for (const [date, n] of Object.entries(gaesteDaily)) {
      if (!(n > 0)) continue;
      const wi = weekIndexOf(date);
      if (wi < 0) continue;
      aggs[wi].gaeste += n; aggs[wi].hatGaeste = true;
    }
    const avgSum = weeks.map(() => ({ wSum: 0, wWeight: 0, sSum: 0, sCount: 0 }));
    for (const [date, v] of Object.entries(avgDaily)) {
      if (!(v > 0)) continue;
      const wi = weekIndexOf(date);
      if (wi < 0) continue;
      const g = gaesteDaily[date] ?? 0;
      if (g > 0) { avgSum[wi].wSum += v * g; avgSum[wi].wWeight += g; }
      avgSum[wi].sSum += v; avgSum[wi].sCount++;
    }
    weeks.forEach((_, i) => {
      const s = avgSum[i];
      aggs[i].avgW = s.wWeight > 0 ? r2(s.wSum / s.wWeight)
        : s.sCount > 0 ? r2(s.sSum / s.sCount) : null;
    });
    for (const [date, perEmp] of Object.entries(istStdProTag)) {
      const wi = weekIndexOf(date);
      if (wi < 0) continue;
      for (const h of Object.values(perEmp)) { aggs[wi].istStd += h; aggs[wi].hatIst = true; }
    }
    for (const [date, perEmp] of Object.entries(planStdProTag)) {
      const wi = weekIndexOf(date);
      if (wi < 0) continue;
      for (const h of Object.values(perEmp)) { aggs[wi].planStd += h; aggs[wi].hatPlan = true; }
    }
    mainAggs = aggs;
  } else {
    // Vergangenes Jahr: Hauptlinie aus vj_daily (konsistent zum VJ-Vergleich);
    // keine Personalstunden → Produktive Stunden/Produktivität «—».
    mainAus = 'vj';
    mainAggs = await aggregiereVjWochen(weeks, tenantId, gaesteDaily, avgDaily);
  }

  // ── Vergleichsjahr (Toggle) = gewähltes Jahr − 1, immer aus vj_daily ────────
  const vjWeeks: (WeekWindow | null)[] | undefined = mitVorjahr
    ? weeks.map(vorjahresWoche) : undefined;
  const vjAggs = mitVorjahr && vjWeeks
    ? await aggregiereVjWochen(vjWeeks, tenantId, gaesteDaily, avgDaily)
    : undefined;

  const rows = baueWochenverlaufRows(mainAggs, mainAus, vjAggs);

  // ── Reservationen je Woche (Foratable-CSV = ALLEINIGE Quelle) ─────────────
  // «Reservierte Gäste» (Σ Personen gezählter Reservationen) und «Gruppen ab
  // N Pax» je KW — dieselbe zentrale Zählregel (Status-Set + Schwelle) wie in
  // Monats-/Wochensicht. Keine Daten im Fenster → null («leer statt 0»).
  const wvCounting = (await loadReservationCounting(tenantKey).catch(() => null))
    ?? DEFAULT_RESERVATION_COUNTING;
  const [wvResMetrics, wvResVj] = await Promise.all([
    Promise.all(weeks.map(w => loadReservationMetrics(tenantId, w.from, w.to, wvCounting))),
    vjWeeks
      ? Promise.all(vjWeeks.map(w =>
          w ? loadReservationMetrics(tenantId, w.from, w.to, wvCounting)
            : Promise.resolve({ reservedGuests: null, largeGroupCount: null, largeGroupPersons: null })))
      : Promise.resolve(undefined),
  ]);
  rows.push({
    label: 'Reservierte Gäste', fmt: 'count', id: 'reservierte_gaeste',
    values: wvResMetrics.map(m => m.reservedGuests),
    vjValues: wvResVj ? wvResVj.map(m => m.reservedGuests) : undefined,
  });
  rows.push({
    label: `Gruppen ab ${wvCounting.groupThreshold} Pax`, fmt: 'count', id: 'gruppen_ab_20',
    values: wvResMetrics.map(m => m.largeGroupCount),
    vjValues: wvResVj ? wvResVj.map(m => m.largeGroupCount) : undefined,
  });

  // ── Rezensionen je Woche (ALLE Sternstufen 5–1, Google + Lunchgate) ────────
  // Ladefehler → alle Spalten null (leer, nie 0 erfinden); geladener Blob →
  // echte Anzahl je Wochenfenster. VJ-Spalte nur, wenn dort wirklich Rezensionen
  // erfasst sind (>0) — die Quelle existiert erst seit der Einzelerfassung.
  const reviewSingles: SingleReview[] | null =
    await fetchReviewsData(tenantId).then(d => d.singleReviews).catch(() => null);
  for (const { platform, star, label, tint } of reviewStarRowDefs()) {
    rows.push({
      label, fmt: 'count', tint,
      values: weeks.map(w =>
        reviewSingles ? countReviewsByStar(reviewSingles, platform, w.from, w.to, star) : null),
      vjValues: vjWeeks
        ? vjWeeks.map(w => {
            if (!w || !reviewSingles) return null;
            const n = countReviewsByStar(reviewSingles, platform, w.from, w.to, star);
            return n > 0 ? n : null;
          })
        : undefined,
    });
  }

  // ── Warenkosten je Woche (erfasste Warenrechnungen, netto) ────────────────
  // Eine Zeile pro Lieferant (Top-Gesamtbetrag zuerst) + Total + WKQ — so sind
  // die KW-Spalten pro Lieferant direkt vergleichbar. Berührte Monate der
  // Wochenfenster laden; Ladefehler ⇒ Zeilen bleiben leer (nie 0 erfinden).
  const invMonths = new Set<string>();
  for (const w of weeks) {
    invMonths.add(w.from.slice(0, 7));
    invMonths.add(w.to.slice(0, 7));
  }
  const invLists = await Promise.all([...invMonths].map(mk =>
    loadMonthInvoices(tenantId, mk).catch(() => null as InvoiceEntry[] | null)));
  // Alle Monate fehlgeschlagen → keine Datenbasis (leer); sonst Teilmenge nutzen.
  const allInvoices: InvoiceEntry[] | null =
    invLists.every(l => l === null) ? null : invLists.flatMap(l => l ?? []);
  if (allInvoices) {
    // Kontoklassen: Total/WKQ/Lieferanten nur Warenkosten-Anteile (4000–Grenze);
    // Betriebskosten-Anteile separat als eigene Zeile (nie in der WKQ).
    const grenzeVerlauf = await loadWarenkostenGrenze(tenantId).catch(() => DEFAULT_WARENKOSTEN_GRENZE);
    const warenOnly = nurWarenAnteil(allInvoices, grenzeVerlauf);
    const weekInvAll = weeks.map(w => filterInvoicesByRange(allInvoices, w.from, w.to));
    const weekInv = weeks.map(w => filterInvoicesByRange(warenOnly, w.from, w.to));
    // WKQ je Woche = Warenkosten ÷ Netto-Umsatz derselben Woche (Hauptlinie).
    const netOf = (i: number): number | null => {
      const a = mainAggs[i];
      return a && a.hatUmsatz && a.net > 0 ? a.net : null;
    };
    const zielWkqVerlauf = await loadZielWarenquote(tenantId)
      .then(b => b.pct).catch(() => DEFAULT_ZIEL_WARENQUOTE_PCT);
    // «Warenkosten total» (bold) mit kompakter WKQ je KW-Spalte; Lieferanten
    // als ausklappbare Kinder (Standard eingeklappt), Food-/Bev-WKQ ebenfalls
    // als Kinder — keine langen Extrazeilen in der Standardansicht.
    rows.push({
      id: 'warenkosten_total',
      label: 'Warenkosten total', fmt: 'chf', bold: true,
      values: weekInv.map(list => (list.length > 0 ? r2(sumInvoicesNet(list)) : null)),
      wkqValues: weekInv.map((list, i) => {
        const net = netOf(i);
        return list.length > 0 && net !== null ? r2((sumInvoicesNet(list) / net) * 100) : null;
      }),
      wkqZiel: r2(zielWkqVerlauf) ?? undefined,
    });
    for (const agg of aggregateBySupplier(warenOnly)) {
      const sums = weekInv.map(list =>
        sumInvoicesNet(list.filter(e2 => (e2.supplierName.trim() || '—') === agg.supplierName)));
      rows.push({
        label: `Warenkosten · ${agg.supplierName}`, fmt: 'chf',
        childOf: 'warenkosten_total',
        values: sums.map(s => (s > 0 ? r2(s) : null)),
        // Quote je Lieferant in % auf den Netto-Umsatz der KW (nie ÷ 0). Kein
        // wkqZiel: die Anzeige bleibt neutral (keine Ampel je Lieferant).
        wkqValues: sums.map((s, i) => {
          const net = netOf(i);
          return s > 0 && net !== null ? r2((s / net) * 100) : null;
        }),
      });
    }
    // Betriebskosten (Konten > Grenze) separat — klar getrennt von der WKQ.
    const betriebSums = weekInvAll.map(list => sumBetriebNet(list, grenzeVerlauf));
    if (betriebSums.some(s => s > 0)) {
      rows.push({
        id: 'betriebskosten_waren',
        label: 'Betriebskosten (Waren-Lieferanten)', fmt: 'chf',
        values: betriebSums.map(s => (s > 0 ? r2(s) : null)),
      });
    }
    // WKQ je Kategorie (Food/Beverage) — separate Zielquoten, deshalb einzeln.
    const warenKonten = await loadWarenkonten(tenantId).catch(() => [] as Warenkonto[]);
    for (const kat of ['Food', 'Beverage'] as const) {
      rows.push({
        label: `WKQ ${kat}`, fmt: 'pct',
        childOf: 'warenkosten_total',
        values: weekInv.map((list, i) => {
          const net = netOf(i);
          const s = sumNetByKategorie(list, kat, warenKonten);
          return s > 0 && net !== null ? r2((s / net) * 100) : null;
        }),
      });
    }
  }

  return { weeks, vjWeeks, rows, partialWeekIndex };
}

// ── Jahresvergleich (Year-to-Date, aktuell vs. Vorjahr pro rata) ─────────────

/**
 * Lädt den Year-to-Date-Vergleich: 01.01.→heute vs. 01.01. Vorjahr→gleiches
 * Datum. Zeilen = dieselben Kennzahlen wie Cockpit/Wochenverlauf, gleiche
 * Quellen (keine Z-Berichte). Personalkosten werden pro Monat (Jan→heute) lazy
 * geladen; scheitert ein Monat, bleiben die Stunden-Zeilen «—» (kein Absturz).
 * Vorjahr: vj_daily je Monat, gaeste-daily/avgcheck-daily auf VJ-Zeitraum;
 * keine VJ-Personalstunden → «—». «leer statt 0» durchgehend.
 */
export async function ladeJahresvergleich(
  tenantId: TenantId,
  tenantKey: KeyFn,
  rates: SocialCostRates,
  heute: Date = new Date(),
  modus: VergleichsModus = 'ytd',
  von?: string,
  bis?: string,
): Promise<JahresvergleichDaten> {
  const win = computeVergleichsWindow(modus, heute, von, bis);
  const { curYear, vjYear, curFrom, curTo, vjFrom, vjTo } = win;
  // Monats-Fenster (1-basiert) für PK/vj_daily aus dem gewählten Zeitraum ableiten.
  // Aktuelles Jahr: nur bis zum aktuellen Monat laden, wenn der Zeitraum darüber
  // hinausreicht (Ganzjahr) — künftige Monate haben ohnehin keine Ist-Daten.
  const curStartMonth = Number(curFrom.slice(5, 7));                 // 1..12
  const curEndMonthRaw = Number(curTo.slice(5, 7));                  // 1..12
  const heuteMonth = heute.getFullYear() === curYear ? heute.getMonth() + 1 : 12;
  const curEndMonth = Math.min(curEndMonthRaw, heuteMonth);
  const curMonths = curStartMonth <= curEndMonth
    ? Array.from({ length: curEndMonth - curStartMonth + 1 }, (_, i) => curStartMonth + i)
    : [];
  // Vorjahr: derselbe MM-Bereich (aus vjFrom/vjTo), volle Monate (Daten liegen vor).
  const vjStartMonth = Number(vjFrom.slice(5, 7));
  const vjEndMonth = Number(vjTo.slice(5, 7));
  const vjMonths = vjStartMonth <= vjEndMonth
    ? Array.from({ length: vjEndMonth - vjStartMonth + 1 }, (_, i) => vjStartMonth + i)
    : [];

  // ── Aktuelles Jahr: Umsatz + globale KV-Maps ───────────────────────────────
  const [gaesteDaily, avgDaily, umsatzTage] = await Promise.all([
    loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    ladeUmsatzTage(tenantId, curFrom, curTo),
  ]);

  // Umsatz aktuell + gepaarte Umsatz/Gäste-Tage.
  let gross = 0, net = 0, ta = 0, food = 0, bev = 0, hatUmsatz = false;
  let pairedNet = 0, pairedGaeste = 0;
  for (const [date, tag] of umsatzTage) {
    if (date < curFrom || date > curTo || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    gross += tag.gesamtBrutto; ta += tag.takeAwayBrutto; net += netto;
    food += split.food; bev += split.beverage; hatUmsatz = true;
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) { pairedNet += netto; pairedGaeste += g; }
  }

  // Gäste aktuell (volle importierte Summe im Zeitraum).
  let gaeste = 0, hatGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < curFrom || date > curTo || !(n > 0)) continue;
    gaeste += n; hatGaeste = true;
  }
  // Durchschnittsverkauf aktuell — einfacher Mittelwert der Tageswerte
  // (Direkt-Import-Regel, konsistent zu Wochenverlauf/VJ).
  let avgSum = 0, avgCount = 0;
  for (const [date, v] of Object.entries(avgDaily)) {
    if (date < curFrom || date > curTo || !(v > 0)) continue;
    avgSum += v; avgCount++;
  }
  const avgCur = avgCount > 0 ? r2(avgSum / avgCount) : null;

  // ── Personalkosten aktuell: Monate Jan..aktueller Monat (lazy, fehlertolerant) ──
  const pkList = await Promise.all(
    curMonths.map(mo =>
      ladePersonalkostenDaten(curYear, mo, tenantId, tenantKey, rates).catch(() => null)),
  );
  let istStd = 0, hatIst = false, planStd = 0, hatPlan = false;
  for (const pk of pkList) {
    if (!pk) continue;
    for (const [date, perEmp] of Object.entries(pk.istStdProTag) as [string, Record<string, number>][]) {
      if (date < curFrom || date > curTo) continue;
      for (const h of Object.values(perEmp)) { istStd += h; hatIst = true; }
    }
    for (const [date, perEmp] of Object.entries(pk.planStdProTag) as [string, Record<string, number>][]) {
      if (date < curFrom || date > curTo) continue;
      for (const h of Object.values(perEmp)) { planStd += h; hatPlan = true; }
    }
  }

  // ── Vorjahr (pro rata): vj_daily je Monat Jan..aktueller Monat ─────────────
  const vjMonthMaps = await Promise.all(
    vjMonths.map(mo =>
      loadVjDailyMonth(vjYear, mo, tenantId).catch(() => ({} as Record<string, VjDayRecord>))),
  );
  const vjDaily: Record<string, VjDayRecord> = {};
  for (const m of vjMonthMaps) Object.assign(vjDaily, m);

  let vjGross = 0, vjNet = 0, vjFoodG = 0, vjBevG = 0, vjTaG = 0;
  let hatVj = false, hatVjFood = false, hatVjBev = false, hatVjTa = false;
  let vjPairedNet = 0, vjPairedGaeste = 0;
  for (const [date, rec] of Object.entries(vjDaily)) {
    if (date < vjFrom || date > vjTo) continue;
    if ((rec.actualRevenue ?? 0) > 0) {
      vjGross += rec.actualRevenue; vjNet += rec.actualRevenue / VAT_STD; hatVj = true;
    }
    if ((rec.foodRevenue ?? 0) > 0) { vjFoodG += rec.foodRevenue! / VAT_STD; hatVjFood = true; }
    if ((rec.beverageRevenue ?? 0) > 0) { vjBevG += rec.beverageRevenue! / VAT_STD; hatVjBev = true; }
    if ((rec.takeawayRevenue ?? 0) > 0) { vjTaG += rec.takeawayRevenue!; hatVjTa = true; }
    const gVj = gaesteDaily[date] ?? 0;
    if ((rec.actualRevenue ?? 0) > 0 && gVj > 0) {
      vjPairedNet += rec.actualRevenue / VAT_STD; vjPairedGaeste += gVj;
    }
  }
  // Gäste VJ (volle Summe im VJ-Zeitraum).
  let vjGaeste = 0, hatVjGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < vjFrom || date > vjTo || !(n > 0)) continue;
    vjGaeste += n; hatVjGaeste = true;
  }
  // Durchschnittsverkauf VJ — einfacher Mittelwert der VJ-Tageswerte.
  let vjAvgSum = 0, vjAvgCount = 0;
  for (const [date, v] of Object.entries(avgDaily)) {
    if (date < vjFrom || date > vjTo || !(v > 0)) continue;
    vjAvgSum += v; vjAvgCount++;
  }
  const avgVj = vjAvgCount > 0 ? r2(vjAvgSum / vjAvgCount) : null;

  // ── Reservationen (Foratable-CSV = alleinige Quelle) — zentrale Zählregel ──
  // Dieselbe Regel (Status-Set + Schwelle) wie Monats-/Wochen-/Wochenverlaufs-
  // Ansicht; keine Daten im Zeitraum → null («—», nie erfundene 0).
  const jvCounting = (await loadReservationCounting(tenantKey).catch(() => null))
    ?? DEFAULT_RESERVATION_COUNTING;
  const [resCur, resVj, reviewSingles] = await Promise.all([
    loadReservationMetrics(tenantId, curFrom, curTo, jvCounting),
    loadReservationMetrics(tenantId, vjFrom, vjTo, jvCounting),
    // Google-Rezensionen (Anzahl je Sternzahl) — Ladefehler → null (leer).
    fetchReviewsData(tenantId).then(d => d.singleReviews).catch(() => null as SingleReview[] | null),
  ]);

  // ── Zeilen bauen (cur | vj; Δ% berechnet die UI) ───────────────────────────
  const rows: JahresvergleichRow[] = [
    { label: 'Brutto Umsatz', fmt: 'chf', bold: true,
      cur: hatUmsatz ? r2(gross) : null, vj: hatVj ? r2(vjGross) : null },
    { label: 'Netto Umsatz', fmt: 'chf', bold: true,
      cur: hatUmsatz ? r2(net) : null, vj: hatVj ? r2(vjNet) : null },
    { label: 'Gäste IN', fmt: 'count',
      cur: hatGaeste ? r2(gaeste) : null, vj: hatVjGaeste ? r2(vjGaeste) : null },
    { label: 'Durchschnittsverkauf', fmt: 'chf', cur: avgCur, vj: avgVj },
    { label: 'Take Away Anteil', fmt: 'pct',
      cur: hatUmsatz && gross > 0 && ta > 0 ? r2((ta / gross) * 100) : null,
      vj: hatVjTa && vjGross > 0 ? r2((vjTaG / vjGross) * 100) : null },
    { label: 'Food', fmt: 'chf',
      cur: hatUmsatz && food > 0 ? r2(food) : null, vj: hatVjFood ? r2(vjFoodG) : null },
    { label: 'Beverage', fmt: 'chf',
      cur: hatUmsatz && bev > 0 ? r2(bev) : null, vj: hatVjBev ? r2(vjBevG) : null },
    { label: 'Produktive Stunden (Ist)', fmt: 'hours',
      cur: hatIst ? r2(istStd) : null, vj: null },  // keine VJ-Quelle
    { label: 'Produktive Stunden geplant', fmt: 'hours',
      cur: hatPlan ? r2(planStd) : null, vj: null }, // keine VJ-Quelle
    { label: 'Produktivität (Umsatz/Std)', fmt: 'chf',
      cur: hatUmsatz && hatIst && istStd > 0 ? r2(net / istStd) : null, vj: null }, // keine VJ-Quelle
    { label: 'Umsatz pro Gast', fmt: 'chf',
      cur: pairedGaeste > 0 ? r2(pairedNet / pairedGaeste) : null,
      vj: vjPairedGaeste > 0 ? r2(vjPairedNet / vjPairedGaeste) : null },
    { label: 'Reservierte Gäste', fmt: 'count',
      cur: resCur.reservedGuests, vj: resVj.reservedGuests },
    { label: `Gruppen ab ${jvCounting.groupThreshold} Pax`, fmt: 'count',
      cur: resCur.largeGroupCount, vj: resVj.largeGroupCount },
    // Rezensionen (ALLE Sternstufen 5–1, Google + Lunchgate). Ladefehler → leer;
    // VJ nur wenn dort wirklich erfasst (>0) — Quelle existiert erst seit der
    // Einzelerfassung, ein «0» im VJ wäre erfunden.
    ...reviewStarRowDefs().map(({ platform, star, label, tint }): JahresvergleichRow => {
      const cur = reviewSingles
        ? countReviewsByStar(reviewSingles, platform, curFrom, curTo, star) : null;
      const vjN = reviewSingles
        ? countReviewsByStar(reviewSingles, platform, vjFrom, vjTo, star) : 0;
      return { label, fmt: 'count', tint, cur, vj: vjN > 0 ? vjN : null };
    }),
  ];

  return { ...win, rows, modus };
}
