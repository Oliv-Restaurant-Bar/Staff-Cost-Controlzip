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
import { ladeUmsatzTage, nettoUmsatzTag, foodBeverageSplit, vjTagWerte } from '@/lib/umsatz';
import { mwstDivisorTakeaway } from '@/lib/mwst';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import { computeMonthlyDailyBudgets } from '@/lib/budget-day';
import { loadCockpitBudget, resolveCockpitBudgets, erNettoBudgetMonate, COCKPIT_BUDGET_KPIS, reviewZielBudget, reviewWochenrate, FB_UMSATZ_ANTEIL_2025 } from '@/lib/cockpit-budget';
import { loadWeqModus, effektiveKategorieWeq, type WeqModus } from '@/lib/weq-modus';
import {
  ladeWochentagsGewichte, ladePersonalkostenDaten,
  personalkosten, personalquote, fixKosten, flexKostenProTagDetail, budgetZielQuote,
} from '@/lib/personalkosten';
import { loadGaesteDaily, loadAvgCheckDaily, loadAvgCheckMonthly } from '@/lib/gaeste-store';
import { ladeGaesteInAbgeleitet } from '@/lib/gaeste-derived';
import { loadVjDailyMonth, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { istAlsVjRecord } from '@/lib/vj-overlay';
import { loadReservationCounting, DEFAULT_RESERVATION_COUNTING } from '@/lib/reservation-cockpit-settings';
import { loadTakeAwayOffered, filterTakeAwayRows } from '@/lib/takeaway-offered-settings';
import { loadReservationMetrics } from '@/lib/reservation-cockpit-metrics';
import { loadTakeAwayGuests } from '@/lib/takeaway-cockpit-metrics';
import { loadTaGaesteDaily, sumTaGaesteRange } from '@/lib/ta-gaeste-store';
import type { TenantId } from '@/contexts/TenantContext';
import type { SocialCostRates } from '@/lib/social-costs';
import { loadVorjahresPersonalkosten } from '@/lib/vorjahres-personalkosten';
import { ladeUeberstundenPeriode } from '@/lib/ueberstunden';
import { computePLForMonth } from '@/lib/pl-engine';
import { loadMonth as loadReportingMonth, STORAGE_KEY as REPORTING_STORAGE_KEY } from '@/lib/reporting-store';
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
 *
 * MANDANTENGETRENNT: Lunchgate existiert nur bei Beaulieu — bei Oliv werden
 * die Lunchgate-Zeilen komplett weggelassen (Anzeige UND Export laufen über
 * dieselben Zeilendefinitionen). Google/übrige Plattformen überall.
 */
export function reviewStarRowDefs(tenantId: TenantId): Array<{
  platform: string; star: number; id: string; label: string; tint: 'green' | 'red' | undefined;
  /** 2/4 Sterne: standardmässig eingeklappt (Kind der 5-Sterne-Zeile). */
  collapsed: boolean; parentId: string;
}> {
  const defs: Array<{ platform: string; star: number; id: string; label: string; tint: 'green' | 'red' | undefined; collapsed: boolean; parentId: string }> = [];
  // Oliv: Google + TripAdvisor (Spec 08/2026); Beaulieu: Google + Lunchgate.
  const platforms = tenantId === 'beaulieu' ? ['Google', FEEDBACK_PLATFORM] : ['Google', 'TripAdvisor'];
  for (const platform of platforms) {
    const slug = platform.toLowerCase();
    for (const star of [5, 4, 3, 2, 1]) {
      defs.push({
        platform, star,
        id: `${slug}_${star}_${star === 1 ? 'stern' : 'sterne'}`,
        label: `${platform} ${star} ${star === 1 ? 'Stern' : 'Sterne'}`,
        tint: star === 5 ? 'green' : star === 1 ? 'red' : undefined,
        collapsed: star === 2 || star === 4,
        parentId: `${slug}_5_sterne`,
      });
    }
  }
  return defs;
}
import { loadMonthInvoices, loadWarenkostenGrenze, loadAliasGruppen, type InvoiceEntry } from '@/lib/waren-db';
import { applyAliasGruppen, type AliasGruppe } from '@/lib/waren-alias-gruppen';
import { filterInvoicesByRange, sumInvoicesNet, sumNetByKategorie, aggregateBySupplier, supplierRowIds } from '@/lib/waren-cockpit';
import { nurWarenAnteil, DEFAULT_WARENKOSTEN_GRENZE } from '@/lib/waren-klassen';
import { mwstDivisorStandard } from '@/lib/mwst';
import { loadWarenkonten, type Warenkonto } from '@/lib/waren-db';
import { loadZielWarenquote, DEFAULT_ZIEL_WARENQUOTE_PCT } from '@/lib/ziel-warenquote';

type KeyFn = (key: string) => string;

const VAT_STD = () => mwstDivisorStandard(); // konfigurierbar (mwst.ts, Default 8.1 %)
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
 * Berechnet den Wochen-Zeitraum (Mo–So bzw. rollend) für eine Auswahl.
 * Die VOLLE ISO-Woche wird gezeigt — auch über Monats-/Jahresgrenzen
 * (KW 31 = 27.07.–02.08., NICHT auf den Monat beschnitten). Geklemmt wird
 * NUR an der Ist-Obergrenze `istToIso` (laufende Woche → bis heute);
 * istToIso '' ⇒ kein Ist verfügbar → leer.
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

  // Kein Ist verfügbar (Zukunftsmonat) → leer. KEINE Klemmung auf den Monat —
  // die Woche darf Monatsgrenzen überschreiten; jeder Tag zieht Budget/Ist aus
  // seinem eigenen Monat (Aufrufer-Verantwortung).
  if (!istToIso) return { weekFrom: null, weekTo: null };

  const wf = iso(rawFrom);
  let wt = iso(rawTo);
  if (wt > istToIso) wt = istToIso; // laufende/zukünftige Woche → bis Ist-Grenze
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
  /** PK-Ist des Monats BIS STICHTAG (Kern: personalkosten(istBisHeute, {stichtag})). */
  istKostenMonat: number | null;
  /** Umsatz-Budget des Monats (für PK-Budget-Monat = Zielquote × Umsatz-Budget). */
  umsatzBudgetMonat: number | null;
  /** PKQ Ist des Monats bis Stichtag (Kern: personalquote({stichtag}).pkqIst, Bruch). */
  pkqIstMonat: number | null;
}

export interface PersonalBlockErgebnis {
  /** PK-Ist der Woche (FIX pro-rata Wochentage + FLEX-Ist der Woche), null = keine Woche. */
  pkIstWoche: number | null;
  /** PK-Budget der Woche = Zielquote × Netto-Umsatz-Budget-Woche, null = keine Quelle. */
  pkBudgetWoche: number | null;
  /** PK-Budget des Monats = Zielquote × Umsatz-Budget-Monat, null = keine Quelle. */
  pkBudgetMonat: number | null;
  /** PK-Ist Monat bis Stichtag (durchgereicht, KEINE Hochrechnung). */
  pkIstMonat: number | null;
  /** PKQ Woche = PK-Ist-Woche ÷ Netto-Umsatz-Ist-Woche in %, null = kein Umsatz. */
  pkqWochePct: number | null;
  /** PKQ Monat = PK-Ist ÷ Umsatz-Ist (beide bis Stichtag) in %, null = kein Umsatz. */
  pkqMonatPct: number | null;
}

/**
 * Aggregiert den Personal-Block aus den KERN-Werten (keine Parallel-Rechnung):
 *  - PK-Ist-Woche = FIX pro-rata der Wochentage (fixMonat × |Wochentage| ÷
 *    daysInMonth) + Σ FLEX-Ist der Woche (nur vergangene Ist-Tage).
 *  - PK-Budget-Woche = zielQuote × Netto-Umsatz-Budget der Woche.
 *  - PK-Budget-Monat = zielQuote × Umsatz-Budget-Monat.
 *  - PKQ-Woche = PK-Ist-Woche ÷ Netto-Umsatz-Ist-Woche (Ist ÷ Ist), % .
 *  - PKQ-Monat = pkqIstMonat (Ist ÷ Ist bis Stichtag aus dem Kern), % .
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
  const pkqMonatPct = inp.pkqIstMonat != null ? r2(inp.pkqIstMonat * 100) : null;

  return {
    pkIstWoche,
    pkBudgetWoche,
    pkBudgetMonat,
    pkIstMonat: inp.istKostenMonat,
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
 *
 * baseYear (optional): frei gewähltes Basisjahr (Jahres-Navigation). Vergleich
 * ist immer baseYear vs. baseYear−1. Ist baseYear NICHT das laufende Jahr
 * (abgeschlossen), wird 'ytd' wie 'ganzjahr' behandelt (ganzes Jahr).
 */
export function computeVergleichsWindow(
  modus: VergleichsModus,
  heute: Date,
  von?: string,
  bis?: string,
  baseYear?: number,
): YtdWindow {
  const curYear = baseYear ?? heute.getFullYear();
  const vjYear = curYear - 1;
  // Abgeschlossenes Jahr: YTD ist bedeutungslos → ganzes Jahr.
  if (modus === 'ytd' && curYear !== heute.getFullYear()) modus = 'ganzjahr';

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
  /**
   * Cockpit-KPI-Budget des Zeitraums (pro rata bis Stichtag gekappt, gleiche
   * Tage wie `cur`). undefined/null = kein Budget erfasst («leer statt 0»).
   */
  budget?: number | null;
  /** true = Kosten-Zeile: über Budget = rot (Vorzeichen-Färbung invertiert). */
  deltaInverted?: boolean;
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
  /** Spalte «Monat» (Ist strikt bis Daten-Stichtag; keine Hochrechnung) */
  month: number | null;
  /**
   * Cockpit-Budget-Positions-ID: gesetzt = das MONATS-Budget dieser Zeile ist
   * im Cockpit inline editierbar (schreibt in DENSELBEN Store wie die
   * Budget-Eingabe, cockpit-budget:<jahr>). Wochen-/Jahressicht bleiben read-only.
   */
  ckId?: string;
  /** true = Monatswert im Cockpit-Store manuell überschrieben (monthlyExplicit). */
  monthBudgetManuell?: boolean;
  /**
   * VOLLER Monats-Budgetwert (ohne Stichtag-Klemmung) — Editier-Basis der
   * Inline-Korrektur. Kann von `monthBudget` abweichen (laufender Monat ist
   * in der Anzeige pro rata bis heute gekappt).
   */
  monthBudgetVoll?: number | null;
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
   * Δ%-Basis der Zeile (Ist-Netto-Umsatz) — Warenkosten-Zeilen: Δ% =
   * (Ist − Soll) ÷ Basis, entspricht der PP-Abweichung der WKQ zum Ziel
   * (NICHT mehr ÷ Soll). null = keine Basis → Δ% leer («leer statt 0»).
   */
  deltaPctBasis?: { month: number | null; week: number | null };
  /**
   * Begleitwerte für fmt='countPax': Hauptwert = Σ PERSONEN (Einheit des
   * Budgets), *Pax-Felder = ANZAHL GRUPPEN als Klammer-Zusatz («40 Pers.
   * (2 Gruppen)»). Pro Spalte parallel zu month/week/vjMonth; null = kein
   * Zusatzwert. Bei fmt='hours' (Überstunden-Zeile) tragen die *Pax-Felder
   * die KOSTENWIRKSAMEN Plus-Stunden («davon +X.X kostenwirksam»);
   * sonst undefined.
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
   * Info-Tooltip-Text der Zeile (z.B. Gäste IN: «getippt: X · abgeleitet: Y ·
   * Abweichung Z%»). Reine Anzeige neben dem Label; kein Einfluss auf Werte.
   */
  hinweis?: string;
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
  /**
   * Kleiner Hinweistext unter dem Ist-Anteil in der Δ%-Spalte. Default (UI):
   * «Anteil Gäste IN». «Gäste Take Away» nutzt «Anteil aller Gäste», weil die
   * Basis dort Gäste IN + Gäste TA ist (nicht nur Gäste IN).
   */
  shareHint?: string;
  /**
   * Transparenz «Netto Umsatz»: im ausgewiesenen Netto ENTHALTENER
   * Marketing-/Maison-Anteil (CHF) je Spalte (Monat/Woche), summiert über
   * exakt die gezählten Umsatz-Tage. null = Periode ohne Umsatz. Nur für
   * die Anzeige (Tooltip) — der Betrag ist bereits im Netto eingerechnet,
   * NIE zusätzlich addieren (Doppelzählung).
   */
  marketingNetto?: { month: number | null; week: number | null };
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
  /**
   * WKQ des BUDGET-/Soll-Werts in % (Budget-Warenkosten ÷ Budget-Netto-
   * Umsatz; für Kategorien ohne eigenes Umsatz-Budget: Soll ÷ Ist-Kategorie-
   * Umsatz = wirksame Quote). Anzeige dezent unter dem Budget-Wert. null =
   * kein Budget/keine Basis («leer statt 0», nie ÷ 0).
   */
  budgetPct?: number | null;
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
  /**
   * Daten-Stichtag der Monats-Sicht (ISO): letzter Tag mit Umsatz- UND
   * Ist-Stunden-Daten (min beider Quellen); abgeschlossener Monat =
   * Monatsletzter. null = keine Daten (Zukunftsmonat). Fürs Kopf-Label
   * «Stand bis TT.MM.JJJJ».
   */
  standBis: string | null;
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
  /**
   * Budget-Modus der Monats-Spalte (Spec 08/2026, Umschalter):
   * - 'stichtag' (Default): absolute Budgets ANTEILIG bis zum Daten-Stichtag
   *   (Monatsbudget × Tage-bis-Stichtag ÷ Kalendertage) — gleicher Zeitraum
   *   wie das Ist.
   * - 'monat': volles Monatsbudget (Ist bleibt trotzdem bis Stichtag — nie
   *   Hochrechnung).
   * Verhältnis-Budgets (PKQ, Produktivität, Quoten) sind in BEIDEN Modi der
   * volle Zielwert. Abgeschlossener Monat: beide Modi identisch.
   */
  budgetModus: 'stichtag' | 'monat' = 'stichtag',
  /**
   * Manueller Stichtag (Kalendertag 1–31, nur Modus 'stichtag'): überschreibt
   * den automatisch erkannten letzten Datentag. Ist UND anteilige Budgets
   * klemmen dann auf diesen Tag. null/undefined = Automatik.
   */
  stichtagTag: number | null = null,
): Promise<MonatsreportDaten> {
  const vollerMonat = budgetModus === 'monat';
  const mm = pad2(month);
  const daysInMonth = new Date(year, month, 0).getDate();
  const fromIso = `${year}-${mm}-01`;
  const toIso = `${year}-${mm}-${pad2(daysInMonth)}`;
  const todayIso = `${heute.getFullYear()}-${pad2(heute.getMonth() + 1)}-${pad2(heute.getDate())}`;
  const isCurrentMonth = heute.getFullYear() === year && heute.getMonth() + 1 === month;
  const isFutureMonth = new Date(year, month - 1, 1) > heute;
  /** Ist-Grenze: laufender Monat = bis heute, vergangene Monate = ganzer Monat. */
  const istToIso = isFutureMonth ? '' : (isCurrentMonth ? todayIso : toIso);

  // «Woche» = gewählte VOLLE ISO-Woche (monatsübergreifend), nur an der
  // Ist-Grenze «heute» geklemmt (fairer Vergleich der laufenden Woche).
  // Vergangene Wochen zeigen alle 7 Tage, auch über das Monatsende hinaus.
  const weekLabel = weekSelectionLabel(weekSelection);
  const { weekFrom, weekTo } = computeWeekRange(
    weekSelection, year, fromIso, toIso, istToIso ? todayIso : '', heute);

  // Reservationen dürfen in der ZUKUNFT liegen (geplante Perioden): Wochen-
  // bereich ganz ohne Ist-Klemmung (volle Woche).
  const { weekFrom: resWeekFrom, weekTo: resWeekTo } =
    computeWeekRange(weekSelection, year, fromIso, toIso, '9999-12-31', heute);

  const alleTage: string[] = [];
  for (let t = 1; t <= daysInMonth; t++) alleTage.push(`${year}-${mm}-${pad2(t)}`);
  // Wochen-Tage über Monatsgrenzen hinweg generieren (nicht aus alleTage
  // filtern — die Woche kann Tage ausserhalb des Report-Monats enthalten).
  const wocheTage: string[] = [];
  if (weekFrom && weekTo) {
    const [wy, wm2, wd] = weekFrom.split('-').map(Number);
    const cur = new Date(wy, wm2 - 1, wd);
    for (let guard = 0; guard < 8; guard++) {
      const d0 = `${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`;
      if (d0 > weekTo) break;
      wocheTage.push(d0);
      cur.setDate(cur.getDate() + 1);
    }
  }
  /** Von der Woche berührte Monate ('YYYY-MM'); Fremdmonate ≠ Report-Monat. */
  const wochenMonate = [...new Set(wocheTage.map(d0 => d0.slice(0, 7)))];
  const wochenFremdMonate = wochenMonate.filter(ym => ym !== `${year}-${mm}`);

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

  // «Gäste Take Away»: PRIMÄR aus dem ta-gaeste-daily-Store (Artikel-Anzahl-
  // Import, alle Jahre inkl. Vorjahre); Zeiträume ohne gelieferte Tage fallen
  // auf die product_sales-Berechnung zurück (bestehende Pipeline).
  const taGaesteDaily = taOffered
    ? await loadTaGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>))
    : {};
  const taGuestsCombined = async (from: string, to: string): Promise<number | null> => {
    const fromStore = sumTaGaesteRange(taGaesteDaily, from, to);
    if (fromStore !== null) return fromStore;
    return loadTakeAwayGuests(tenantId, from, to).catch(() => null);
  };

  // Google-Rezensionen (Einzelerfassung, mandantengetrennt): Zählquelle der
  // Zeilen «Google 5/3/1 Sterne». Ladefehler → null (Zeilen bleiben leer,
  // nie 0 erfinden); geladener Blob → echte Anzahl (0 ist eine echte Aussage).
  const reviewSingles: SingleReview[] | null =
    await fetchReviewsData(tenantId).then(d => d.singleReviews).catch(() => null);

  // Warenkosten (erfasste Warenrechnungen, netto) + Ziel-WKQ: Basis der
  // Lieferanten-/Total-/WKQ-Zeilen. Ladefehler → null (Zeilen bleiben leer).
  const [warenInvoicesRaw, zielWkq, warenKonten, warenGrenze, warenAliasGruppen] = await Promise.all([
    loadMonthInvoices(tenantId, `${year}-${mm}`).catch(() => null as InvoiceEntry[] | null),
    loadZielWarenquote(tenantId).then(b => b.pct).catch(() => DEFAULT_ZIEL_WARENQUOTE_PCT),
    loadWarenkonten(tenantId).catch(() => [] as Warenkonto[]),
    loadWarenkostenGrenze(tenantId).catch(() => DEFAULT_WARENKOSTEN_GRENZE),
    loadAliasGruppen(tenantId).catch(() => [] as AliasGruppe[]),
  ]);
  // Lieferanten-Alias-Gruppen: Namen kanonisieren (reine Anzeige-Gruppierung,
  // Beträge/Totale unverändert) — wirkt auf alle Lieferanten-Zeilen/Exporte.
  const warenInvoices = warenInvoicesRaw ? applyAliasGruppen(warenInvoicesRaw, warenAliasGruppen) : null;
  // Monatsübergreifende Woche: Rechnungen der Fremdmonate NUR für die
  // Wochen-Spalte nachladen (Monats-Spalte bleibt der Report-Monat).
  let warenInvoicesWoche = warenInvoices;
  if (warenInvoicesRaw && wochenFremdMonate.length > 0) {
    const extra = await Promise.all(wochenFremdMonate.map(ym =>
      loadMonthInvoices(tenantId, ym).catch(() => null as InvoiceEntry[] | null)));
    const flat = extra.flatMap(l => l ?? []);
    warenInvoicesWoche = applyAliasGruppen([...warenInvoicesRaw, ...flat], warenAliasGruppen);
  }

  const [
    gaesteDaily, gaesteGetippt, avgDaily, avgMonthly, vjDaily, resWeek, resVjMonth,
    taMonth, taWeek, taVjMonth, pk,
    pkVj, staffingPositions, staffingReqs, staffingConfig,
    mrEmployees, mrSchedule, mrActual,
  ] = await Promise.all([
    // «Gäste IN» = ABGELEITET aus Umsatz ÷ Umsatz-pro-Person (Spec 08/2026,
    // gaeste-derived.ts). Der getippte Personen-Import (gaeste-daily) ist NUR
    // noch Referenz für den Tooltip — nie Fallback für Kennzahlen.
    ladeGaesteInAbgeleitet(tenantId, tenantKey).catch(() => ({} as Record<string, number>)),
    loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckMonthly(tenantKey).catch(() => ({} as Record<string, number>)),
    loadVjDailyMonth(year - 1, vjMonth, tenantId),
    // Reservationen der gewählten Woche (ungeklemmt, future-capable).
    loadReservationMetrics(tenantId, resWeekFrom, resWeekTo, resSettings),
    // Vorjahr: gleicher Monat Jahr−1 (für die Vorjahr-Spalte der Monatssicht).
    loadReservationMetrics(tenantId, vjFromIsoG, vjToIsoG, resSettings),
    // Gäste Take Away (Produktanalyse): Σ Stückzahlen aller TA-Produkte, GANZER
    // Monat bzw. gewählte Woche (ungeklemmt, future-capable). VJ-Monat = gleicher
    // Monat Jahr−1 aus derselben Quelle (fehlt → «—»); VJ-Woche bleibt «—».
    taOffered ? taGuestsCombined(fromIso, toIso) : Promise.resolve(null),
    taOffered ? taGuestsCombined(resWeekFrom, resWeekTo) : Promise.resolve(null),
    taOffered ? taGuestsCombined(vjFromIsoG, vjToIsoG) : Promise.resolve(null),
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

  // ── Vorjahr DYNAMISCH: Ist-Daten des Jahres −1 überlagern vj_daily ─────────
  // Jahresbasierte Datenhaltung: die normalen Ist-Importe des Vorjahres
  // (umsatz.ts-SSOT, dailyBudgets/maison) sind die BEVORZUGTE Vorjahres-Quelle
  // — 2026er-Tagesimporte erscheinen 2027 automatisch als Vorjahr, ohne
  // separaten VJ-Import. vj_daily bleibt Fallback (alte VJ-Importe, z.B. 2025).
  // Semantik identisch zu vj_daily: brutto-Werte, Netto = brutto/VAT_STD().
  try {
    const vjIstTage = await ladeUmsatzTage(tenantId, vjFromIsoG, vjToIsoG);
    for (const [date, tag] of vjIstTage) {
      if (tag.gesamtBrutto > 0) vjDaily[date] = istAlsVjRecord(date, tag, vjDaily[date]);
    }
  } catch { /* Ist-Vorjahr nicht ladbar → vj_daily-Fallback bleibt massgeblich */ }

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
    // Auch hier: Ist-Daten des Vorjahres (umsatz.ts-SSOT) überlagern vj_daily —
    // STRIKT nur die exakt gemappten VJ-Kalendertage (die geladene Datumsspanne
    // kann Lücken der geklemmten Woche enthalten; fremde Tage nie überlagern).
    try {
      const vjDates = vjWochePaare.map(p => p.vj).sort();
      const vjDateSet = new Set(vjDates);
      const vjIstWoche = await ladeUmsatzTage(tenantId, vjDates[0], vjDates[vjDates.length - 1]);
      for (const [date, tag] of vjIstWoche) {
        if (vjDateSet.has(date) && tag.gesamtBrutto > 0) vjWocheDaily[date] = istAlsVjRecord(date, tag, vjWocheDaily[date]);
      }
    } catch { /* Fallback: vj_daily */ }
  }

  // ── Personalkosten Vorjahr DYNAMISCH ───────────────────────────────────────
  // Bevorzugt Buchhaltungswert (vorjahres_personalkosten, nur Jahre < 2026).
  // Fehlt er (z.B. Anzeige 2027 → VJ 2026), Fallback auf die Erfolgsrechnungs-
  // Monatsdaten des Vorjahres: Löhne (personnel_wages) + Sozialleistungen
  // (personnel_social) aus computePLForMonth — identische SSOT-Regel wie der
  // ER-Abgleich (personnel_other bleibt bewusst aussen vor). Leer statt 0.
  let pkVjEff: { chf: number; quelle: string } | null = pkVj;
  if (!pkVjEff) {
    try {
      const recVj = loadReportingMonth(year - 1, month, tenantKey(REPORTING_STORAGE_KEY));
      const plVj = computePLForMonth(recVj);
      const cell = (id: string) => plVj.rows.find(r => r.def.id === id)?.values.actual;
      const w = cell('personnel_wages');
      const s = cell('personnel_social');
      if (w !== undefined || s !== undefined) {
        pkVjEff = { chf: (w ?? 0) + (s ?? 0), quelle: 'Erfolgsrechnung' };
      }
    } catch { /* keine ER-Daten → VJ-Personalkosten bleiben leer */ }
  }

  // ── Daten-Stichtag (Spec 08/2026): letzter Tag MIT DATEN im Monat ──────────
  // Stichtag = min(letzter Umsatz-Tag, letzter Ist-Stunden-Tag/MIRUS); fehlt
  // eine Quelle ganz, gilt die vorhandene; abgeschlossener Monat = Monats-
  // letzter. KEINE Hochrechnung mehr — ALLE Ist-Kennzahlen (Umsatz, Gäste,
  // Stunden, Personalkosten) rechnen strikt bis zu diesem Tag.
  let standTag = 0;
  if (!isFutureMonth) {
    if (!isCurrentMonth) standTag = daysInMonth;
    else if (pk) {
      const prefix = `${year}-${mm}-`;
      let hTag = 0, uTag = 0;
      for (const d of pk.istTage) {
        if (d.startsWith(prefix)) hTag = Math.max(hTag, Number(d.slice(8, 10)) || 0);
      }
      for (const [d, v] of Object.entries(pk.umsatzIstProTag)) {
        if (Number(v) > 0 && d.startsWith(prefix)) uTag = Math.max(uTag, Number(d.slice(8, 10)) || 0);
      }
      standTag = hTag > 0 && uTag > 0 ? Math.min(hTag, uTag) : Math.max(hTag, uTag);
      standTag = Math.min(standTag, heute.getDate()); // nie in die Zukunft
    } else {
      standTag = heute.getDate(); // PK-Kern nicht ladbar → bisherige «bis heute»-Grenze
    }
  }
  // Manueller Stichtag (Selektor, nur Modus 'stichtag'): frei wählbarer Tag
  // im Monat — Ist UND anteilige Budgets klemmen auf diesen Tag (Zukunftstage
  // haben schlicht keine Ist-Daten). Modus 'monat' ignoriert die Auswahl.
  if (!vollerMonat && !isFutureMonth
    && typeof stichtagTag === 'number' && Number.isFinite(stichtagTag)) {
    standTag = Math.min(Math.max(1, Math.round(stichtagTag)), daysInMonth);
  }
  const standIso = standTag > 0 ? `${year}-${mm}-${pad2(standTag)}` : '';
  const istTage = alleTage.filter(d => standIso && d <= standIso);

  // ── Reservationen des Monats: BIS STICHTAG (Spec 08/2026) ──────────────────
  // Wie alle anderen Ist-Kennzahlen klemmt «Reservierte Gäste» der Monats-
  // Spalte auf den Stichtag [Monatsanfang … standIso] — sonst wäre der Wert
  // (ganzer Monat inkl. zukünftiger Reservationen) inkonsistent zu Brutto/
  // Netto/Gäste IN und verzerrte «Anteil Gäste IN». Zukunftsmonate (kein
  // Stichtag) zeigen weiterhin den ganzen Monat (geplante Perioden).
  // Zählregel/Import unverändert (zentrale Settings, Dedup via Res.Nr.).
  const resMonthTo = standIso && standIso < toIso ? standIso : toIso;
  const resMonth = await loadReservationMetrics(tenantId, fromIso, resMonthTo, resSettings);
  /** Anteil Kalendertage bis Stichtag (für anteilige absolute Budgets). */
  const standAnteil = standTag > 0 && daysInMonth > 0 ? standTag / daysInMonth : null;
  /** Absolutes Monats-Budget im gewählten Modus: 'stichtag' → anteilig
   *  (× Tage-bis-Stichtag ÷ Kalendertage; ohne Stichtag leer), 'monat' → voll.
   *  NUR für absolute Werte (CHF/Anzahl/Stunden) — Quoten nie kürzen. */
  const budAbs = (v: number | null): number | null =>
    v == null ? null : vollerMonat ? v : standAnteil != null ? r2(v * standAnteil) : null;

  // ── Umsatz Ist aus der kanonischen Netto-Quelle (src/lib/umsatz.ts) ────────
  // Laderange deckt Monat UND (evtl. monatsübergreifende) Woche ab.
  const umsatzTage = await ladeUmsatzTage(
    tenantId,
    weekFrom && weekFrom < fromIso ? weekFrom : fromIso,
    weekTo && weekTo > toIso ? weekTo : toIso,
  );
  let mGross = 0, mNet = 0, mTa = 0, mFood = 0, mBev = 0, mHatUmsatz = false;
  let wGross = 0, wNet = 0, wTa = 0, wFood = 0, wBev = 0, wHatUmsatz = false;
  // «Umsatz pro Gast»: Netto ÷ Gäste, aber NUR über Tage, die BEIDE Quellen
  // haben (Umsatz-Tag mit gesamtBrutto>0 UND gaesteDaily[date]>0).
  let pairedNet = 0, pairedGaeste = 0, wPairedNet = 0, wPairedGaeste = 0;
  // «Ø-Verkauf pro Gast» (gepaarte Tage, mandantenspezifisch):
  //   Oliv: Netto − TA-Netto (TA-brutto ÷ 1.026) · Beaulieu: Netto.
  // Identische Regel wie der Jahresvergleich (ladeJahresvergleich).
  // Nenner = gaesteDaily («Gäste IN», ohne Take-Away) — gleiche Basis wie
  // Jahresvergleich/Wochenverlauf; TA-Gäste (ta-gaeste-daily) NIE abziehen.
  let pairedVerkauf = 0, wPairedVerkauf = 0;
  const verkaufTagM = (netto: number, taBrutto: number): number =>
    tenantId === 'oliv' ? netto - taBrutto / mwstDivisorTakeaway() : netto;
  // Transparenz: im Netto-Umsatz enthaltener Marketing-/Maison-Anteil (CHF),
  // exakt über dieselben gezählten Tage summiert wie mNet/wNet (kein zweiter
  // Datenpfad → keine Abweichung zum ausgewiesenen Netto möglich).
  let mMkt = 0, wMkt = 0;
  for (const date of istTage) {
    const tag = umsatzTage.get(date);
    if (!tag || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    mGross += tag.gesamtBrutto; mTa += tag.takeAwayBrutto; mNet += netto;
    mFood += split.food; mBev += split.beverage;
    mMkt += tag.marketingNetto;
    mHatUmsatz = true;
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) {
      pairedNet += netto; pairedGaeste += g;
      pairedVerkauf += verkaufTagM(netto, tag.takeAwayBrutto);
    }
  }
  // Wochen-Summen als EIGENER Loop über die (evtl. monatsübergreifenden)
  // Wochentage — jeder Tag zählt, auch ausserhalb des Report-Monats.
  // Zusätzlich Netto je berührtem Monat (WEQ-Soll: Monats-Quote × Tages-Ist).
  const wNetProMonat: Record<string, number> = {};
  for (const date of wocheTage) {
    const tag = umsatzTage.get(date);
    if (!tag || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    wGross += tag.gesamtBrutto; wTa += tag.takeAwayBrutto; wNet += netto;
    wFood += split.food; wBev += split.beverage;
    wMkt += tag.marketingNetto;
    wHatUmsatz = true;
    wNetProMonat[date.slice(0, 7)] = (wNetProMonat[date.slice(0, 7)] ?? 0) + netto;
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) {
      wPairedNet += netto; wPairedGaeste += g;
      wPairedVerkauf += verkaufTagM(netto, tag.takeAwayBrutto);
    }
  }

  // ── Budget (netto aus Budget-Modul) + Wochenanteil ─────────────────────────
  const budgetNet = getMonthlyBudgetRevenue(year, month - 1, tenantKey('budget_v1'));
  const gewichte = ladeWochentagsGewichte(tenantKey);
  // Wochen-Budget monatsübergreifend: jeder Wochentag zieht seinen Tages-
  // Budgetanteil aus SEINEM Monat (budget_v1 des jeweiligen Monats/Jahres).
  const budgetProTag: Record<string, number> = {};
  for (const ym of (wochenMonate.length > 0 ? wochenMonate : [`${year}-${mm}`])) {
    const by = Number(ym.slice(0, 4)), bm = Number(ym.slice(5, 7));
    const bn = ym === `${year}-${mm}` ? budgetNet
      : getMonthlyBudgetRevenue(by, bm - 1, tenantKey('budget_v1'));
    if (bn > 0) Object.assign(budgetProTag, computeMonthlyDailyBudgets(bn, by, bm, gewichte));
  }
  const wBudgetNet = wocheTage.reduce((s, d) => s + (budgetProTag[d] ?? 0), 0);
  const hatBudget = budgetNet > 0;

  // ── Cockpit-KPI-Budget (cockpit-budget:<jahr>, SEPARAT von budget_v1) ──────
  // Monats-Budget pro rata bis Stichtag gekappt (laufender Monat = bis heute,
  // wie das Ist; Zukunftsmonat = ganzer Monat als Vorschau). Wochen-Budget über
  // die geklemmten Wochentage (Wochen-Overrides greifen dort). Vorhandene
  // Cockpit-Budgets haben VORRANG vor den bisherigen Quellen (budget_v1-Umsatz,
  // PK-Ziel); fehlen sie, bleibt alles beim bestehenden Verhalten.
  const ckBlob = await loadCockpitBudget(tenantKey, year).catch(() => null);
  // WEQ-Modus je Mandant/Jahr (Soll-Rechnung der Warenkosten, s. buildWarenRows).
  const weqModusBlob = await loadWeqModus(tenantKey, year).catch(() => null);
  const weqModusEff: WeqModus = weqModusBlob?.modus ?? 'gesamt';
  const weqKatQ = effektiveKategorieWeq(weqModusBlob, tenantId);
  // ER-Netto-Monatsbudgets als Ratio-Nenner (die Umsatz-Positionen wurden aus
  // dem Cockpit-Budget entfernt; Umsatz-Budget = budget_v1/ER — dieselbe
  // Quelle wie budgetNet oben). Wochen im Nachbarjahr: Monate des Wochen-
  // Startjahres laden.
  const erMonate = erNettoBudgetMonate(year, tenantKey('budget_v1'));
  // (Frühere pro-rata-Auflösung fromIso..standIso entfernt — anteilige
  // Budgets rechnen jetzt kalendertag-anteilig aus der vollen Monatsauflösung.)
  // VOLLER Monatswert (ohne pro-rata-Klemmung bis Stichtag) — Basis der
  // Inline-Budget-Bearbeitung: der Editor zeigt/schreibt IMMER den ganzen
  // Monat, nie den anteiligen Anzeigwert des laufenden Monats.
  const ckMFull = resolveCockpitBudgets(ckBlob, tenantId, fromIso, toIso, undefined, erMonate);
  // Wochen-Budgets pro JAHRES-Segment auflösen: jeder Wochentag zieht sein
  // Budget aus dem Cockpit-Blob/ER-Nenner SEINES Jahres (Jahreswechsel-Wochen
  // KW 1/KW 53). CHF-Positionen werden über die Segmente summiert; %-
  // Positionen nach dem ER-Netto-Budget der Segmente gewichtet (Fallback
  // Tageszahl); null bleibt null (leer statt 0).
  let ckW: Record<string, number | null> = {};
  if (weekFrom && weekTo && wocheTage.length > 0) {
    const wJahre = [...new Set(wocheTage.map(d0 => d0.slice(0, 4)))];
    const segs = await Promise.all(wJahre.map(async ys => {
      const yn = Number(ys);
      const blobY = yn === year ? ckBlob
        : await loadCockpitBudget(tenantKey, yn).catch(() => null);
      const erY = yn === year ? erMonate : erNettoBudgetMonate(yn, tenantKey('budget_v1'));
      const tage = wocheTage.filter(d0 => d0.slice(0, 4) === ys);
      return {
        tage,
        // pkZielFallback: NUR hier (Wochenübersicht) — fehlendes PK-Wochen-
        // budget = 40 % × Netto-Wochenbudget (PKQ-Budget damit konstant 40 %).
        res: resolveCockpitBudgets(blobY, tenantId, tage[0], tage[tage.length - 1], tage, erY, true),
      };
    }));
    if (segs.length === 1) {
      ckW = segs[0].res;
    } else {
      const pctIds = new Set(COCKPIT_BUDGET_KPIS.filter(d => d.unit === 'pct').map(d => d.id));
      const ids = new Set(segs.flatMap(s => Object.keys(s.res)));
      for (const id of ids) {
        const teile = segs
          .map(s => ({ v: s.res[id] ?? null, w: s.res['netto_umsatz'] ?? s.tage.length }))
          .filter((x): x is { v: number; w: number } => x.v != null);
        if (teile.length === 0) { ckW[id] = null; continue; }
        if (pctIds.has(id)) {
          const wSum = teile.reduce((a, x) => a + (x.w > 0 ? x.w : 0), 0);
          ckW[id] = wSum > 0
            ? r2(teile.reduce((a, x) => a + x.v * (x.w > 0 ? x.w : 0), 0) / wSum)
            : teile[0].v;
        } else {
          ckW[id] = r2(teile.reduce((a, x) => a + x.v, 0));
        }
      }
    }
  }
  // WEQ-Quoten-Kontext je Jahr: Cockpit-Blob + ER-Netto-Monate auch für
  // Fremdjahre der Woche (KW 1/KW 53) — kein stiller zielWkq-Rückfall, wenn
  // das Nachbarjahr ein Cockpit-Wareneinsatz-Budget hat.
  const weqJahrCtx: Record<string, { blob: typeof ckBlob; er: (number | null)[] }> = {
    [String(year)]: { blob: ckBlob, er: erMonate },
  };
  for (const ymX of wochenFremdMonate) {
    const ys = ymX.slice(0, 4);
    if (!weqJahrCtx[ys]) {
      weqJahrCtx[ys] = {
        blob: await loadCockpitBudget(tenantKey, Number(ys)).catch(() => null),
        er: erNettoBudgetMonate(Number(ys), tenantKey('budget_v1')),
      };
    }
  }
  // Monats-Budget je Modus: 'stichtag' = kalendertag-anteilig (budAbs),
  // 'monat' = volle Monatsauflösung (ckMFull). Verhältnis-Positionen (kind
  // 'ratio': Ø-Verkauf, PKQ, Produktivität, TA-Anteil …) sind in BEIDEN Modi
  // die volle Monats-Auflösung (Quoten nie kürzen).
  const ckRatioIds = new Set(
    COCKPIT_BUDGET_KPIS.filter(k => k.kind === 'ratio').map(k => k.id));
  // Absolute Positionen im Modus 'stichtag': KALENDERTAG-anteilig aus dem
  // vollen Monatswert (Monatsbudget × standTag ÷ daysInMonth, Spec 08/2026) —
  // gilt für ALLE absoluten Budgets (Umsatz, PK, Waren, Gäste, Reservierte,
  // TA-Gäste, Gruppen, Stunden, Rezensionen). Ratio-Positionen bleiben voll.
  const ckMk = (id: string): number | null =>
    (vollerMonat || ckRatioIds.has(id))
      ? (ckMFull[id] ?? null)
      : budAbs(ckMFull[id] ?? null);
  const ckWk = (id: string): number | null => ckW[id] ?? null;
  const ckMFullK = (id: string): number | null => ckMFull[id] ?? null;
  /** «manuell»-Marker: Monatswert der Position wurde direkt überschrieben.
   *  AUSNAHME wareneinsatz (Spec 08/2026): das Warenkosten-Budget kommt live
   *  aus der Budget-Eingabe — dort ist «manuell erfasst» der Normalfall der
   *  WEQ-Stufenlogik, kein Override-Zustand → kein «manuell»-Badge im Cockpit. */
  const ckManuell = (id: string): boolean =>
    id !== 'wareneinsatz'
    && ckBlob?.positions?.[id]?.monthlyExplicit?.[month - 1] === true;

  // ── Gäste IN (ABGELEITET: Brutto ÷ Umsatz/Person, gaeste-derived.ts) ───────
  let mGaeste = 0, wGaeste = 0, hatGaeste = false, hatWGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < fromIso || !standIso || date > standIso) continue;
    if (!(n > 0)) continue;
    mGaeste += n; hatGaeste = true;
  }
  // Referenz «getippt» (alter Personen-Import) über denselben Zeitraum — NUR
  // für den Tooltip («getippt: X · abgeleitet: Y · Abweichung Z%»), nie für
  // Kennzahlen. Abweichung relativ zum ABGELEITETEN (massgeblichen) Wert.
  let mGaesteGetippt = 0, hatGetippt = false;
  for (const [date, n] of Object.entries(gaesteGetippt)) {
    if (date < fromIso || !standIso || date > standIso) continue;
    if (!(n > 0)) continue;
    mGaesteGetippt += n; hatGetippt = true;
  }
  for (const date of wocheTage) {
    const n = gaesteDaily[date] ?? 0;
    if (n > 0) { wGaeste += n; hatWGaeste = true; }
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
  // Ist-Fallback strikt bis Daten-Stichtag (keine künftigen Tageswerte).
  if (avgMonat == null) avgMonat = gewichteterTagesAvg(istTage, avgDaily, gaesteDaily);
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
  // Netto + F/B je Tag über vjTagWerte — EXAKT dieselbe Regel wie das laufende
  // Jahr (TA-Satz, Oliv-TA→Food, Rest 50/50). Invariante food+bev=netto.
  let vjGross = 0, vjNetSum = 0, vjFoodNetS = 0, vjBevNetS = 0, vjTa = 0;
  let hatVj = false, hatVjTa = false;
  // «Umsatz pro Gast» VJ: Netto-VJ ÷ Gäste-VJ, aber NUR über GEPAARTE Tage
  // (Tag mit vj_daily.actualRevenue>0 UND gaesteDaily[date]>0 im Vorjahr) —
  // exakt dieselbe Paarungs-Regel wie im Ist-Zweig, gleicher Zeitraum.
  let vjPairedNet = 0, vjPairedGaeste = 0, vjPairedVerkauf = 0;
  for (const [date, rec] of Object.entries(vjDaily)) {
    const w = vjTagWerte(tenantId, rec, date);
    if (w) {
      vjGross += rec.actualRevenue!; vjNetSum += w.netto;
      vjFoodNetS += w.food; vjBevNetS += w.beverage; hatVj = true;
    }
    if ((rec.takeawayRevenue ?? 0) > 0) { vjTa += rec.takeawayRevenue!; hatVjTa = true; }
    const gVj = gaesteDaily[date] ?? 0;
    if (w && gVj > 0) {
      vjPairedNet += w.netto; // Netto wie vjNetV (gleiche Tagesregel)
      vjPairedGaeste += gVj;
      // vj_daily kennt kein Marketing — Netto ohne Maison (bekannte Grenze).
      vjPairedVerkauf += verkaufTagM(w.netto, Number(rec.takeawayRevenue ?? 0));
    }
  }

  // ── Vorjahres-WOCHE (vj_daily der gemappten VJ-Kalendertage) ───────────────
  // Verhältnis-/Prozent-Zeilen werden NICHT summiert, sondern als Quote über
  // die Woche gebildet (TA-Anteil, Umsatz/Gast, Durchschnittsverkauf). Gäste-
  // Tagessumme massgeblich; «leer statt 0».
  let vwGross = 0, vwNetSum = 0, vwFoodNetS = 0, vwBevNetS = 0, vwTa = 0;
  let hatVwUmsatz = false, hatVwTa = false;
  let vwGaeste = 0, hatVwGaeste = false;
  let vwPairedNet = 0, vwPairedGaeste = 0, vwPairedVerkauf = 0;
  let vwAvgSum = 0, vwAvgWeight = 0, vwAvgSimpleSum = 0, vwAvgSimpleCount = 0;
  for (const { vj } of vjWochePaare) {
    const rec = vjWocheDaily[vj];
    const w = rec ? vjTagWerte(tenantId, rec, vj) : null;
    if (rec && w) {
      vwGross += rec.actualRevenue!; vwNetSum += w.netto;
      vwFoodNetS += w.food; vwBevNetS += w.beverage; hatVwUmsatz = true;
    }
    if (rec && (rec.takeawayRevenue ?? 0) > 0) { vwTa += rec.takeawayRevenue!; hatVwTa = true; }
    const gVj = gaesteDaily[vj] ?? 0;
    if (gVj > 0) { vwGaeste += gVj; hatVwGaeste = true; }
    if (w && gVj > 0) {
      vwPairedNet += w.netto; vwPairedGaeste += gVj;
      vwPairedVerkauf += verkaufTagM(w.netto, Number(rec?.takeawayRevenue ?? 0));
    }
    // Durchschnittsverkauf VJ-Woche: gäste-gewichtet, Fallback einfacher Mittel.
    const av = avgDaily[vj];
    if (av > 0) {
      if (gVj > 0) { vwAvgSum += av * gVj; vwAvgWeight += gVj; }
      vwAvgSimpleSum += av; vwAvgSimpleCount++;
    }
  }
  const vwNet = vwNetSum;

  // ── Stunden-Stapel Bedarf → Dienstplan → Ist ───────────────────────────────
  // GEMEINSAME Helfer (bedarf-stunden-utils) — identische Semantik wie die
  // Personalbedarf-Wochenübersicht: Plan = gespeicherter Dienstplan ohne
  // Absenzen, netto mit ArG-Pausenstaffel; Ist = gestempelte Stunden ohne
  // Absenz-Einträge; ohne Datenquelle bleibt der Wert null (nie 0).
  const stackEmployees = mrEmployees ?? [];
  const stackSchedule = { ...(mrSchedule ?? {}) };
  const stackActual = { ...(mrActual ?? {}) };
  // Monatsübergreifende Woche: Plan/Ist der Fremdmonate nachladen (Keys sind
  // datumsbehaftet → Merge kollisionsfrei); Ladefehler → Tage bleiben leer.
  for (const ym of wochenFremdMonate) {
    const dt = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
    const [schX, actX] = await Promise.all([
      loadScheduleForMonth(dt, tenantId).catch(() => null),
      loadActualHoursForMonth(dt, tenantId).catch(() => null),
    ]);
    if (schX) Object.assign(stackSchedule, schX);
    if (actX) Object.assign(stackActual, actX);
  }
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
  // Ist-Stunden strikt bis Stichtag (gleicher Zeitraum wie Umsatz/PK-Ist).
  const istStd = istHoursForDates(stackActual, istTage);
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

  // ── Überstunden total (Fix-MA, laufendes Konto ab Juli 2026 bis heute) ─────
  // Fehler → leer (Cockpit darf nicht am Überstunden-Lader scheitern).
  // Perioden-Werte (NICHT das kumulierte Konto): Monat = Saldo dieses Monats,
  // Woche = Saldo genau der gewählten ISO-Woche. Kosten = Σ max(0, Perioden-
  // Saldo) × AG-Satz je MA. Das laufende Konto bleibt der Überstunden-Ansicht
  // («Laufend») vorbehalten.
  let uePeriode: {
    monat: { stunden: number | null; kosten: number | null; plusStunden: number | null };
    woche: { stunden: number | null; kosten: number | null; plusStunden: number | null };
  } | null = null;
  try {
    uePeriode = await ladeUeberstundenPeriode(
      tenantId, tenantKey, { year, month, weekMonday: weekFrom }, todayIso);
  } catch (err) {
    console.error('[monatsreport] Überstunden (Periode) nicht ladbar:', err);
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
    // KEINE Hochrechnung (Spec 08/2026): tatsächlich bis STICHTAG angefallene
    // Kosten — Stundenlohn-MA = Ist-Stunden × AG-Satz, Fix-MA = Monatslohn ×
    // (Tage bis Stichtag ÷ Kalendertage). PKQ mit demselben Stichtag (Ist÷Ist).
    const istKosten = standTag > 0 ? personalkosten(pk, 'istBisHeute', { stichtag: standTag }) : null;
    const pkq = standTag > 0 ? personalquote(pk, { stichtag: standTag }) : null;
    personal = computePersonalBlock({
      flexIstProTag,
      istTagSet,
      fixMonat,
      daysInMonth,
      // FIX pro-rata bezieht sich auf DIESEN Monat → nur dessen Wochentage;
      // Fremdmonats-Tage werden unten additiv aus deren Kern gerechnet.
      wocheTage: wocheTage.filter(d0 => d0.slice(0, 7) === `${year}-${mm}`),
      wBudgetNet: hatBudget && weekFrom ? r2(wBudgetNet) : null,
      wNetIst: weekFrom && wHatUmsatz ? r2(wNet) : null,
      zielQuote: budgetZielQuote(pk),
      istKostenMonat: istKosten ? istKosten.total : null,
      umsatzBudgetMonat: hatBudget ? r2(budgetNet) : null,
      pkqIstMonat: pkq ? pkq.pkqIst : null,
    });
    // Monatsübergreifende Woche: PK-Ist der Fremdmonats-Tage additiv aus dem
    // Kern des jeweiligen Monats (FIX pro-rata + FLEX-Ist); Ladefehler → die
    // Tage bleiben unberücksichtigt (keine erfundenen Kosten). PKQ-Woche
    // danach neu (Ist ÷ Ist über die volle Woche).
    if (personal.pkIstWoche != null && wochenFremdMonate.length > 0) {
      for (const ym of wochenFremdMonate) {
        const py = Number(ym.slice(0, 4)), pm = Number(ym.slice(5, 7));
        const pkX = await ladePersonalkostenDaten(py, pm, tenantId, tenantKey, rates).catch(() => null);
        if (!pkX) continue;
        const tageX = wocheTage.filter(d0 => d0.slice(0, 7) === ym);
        const dimX = new Date(py, pm, 0).getDate();
        const fixX = fixKosten(pkX).totalMonat * (tageX.length / dimX);
        let flexX = 0;
        const tagSetX = new Set(tageX);
        for (const t of flexKostenProTagDetail(pkX).tage) {
          if (t.istTag && tagSetX.has(t.date)) flexX += t.istKosten;
        }
        personal.pkIstWoche = r2(personal.pkIstWoche + fixX + flexX);
      }
      if (wHatUmsatz && wNet > 0) {
        personal.pkqWochePct = r2((personal.pkIstWoche / wNet) * 100);
      }
    }
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
    opts: { fmt?: MrFormat; bold?: boolean; deltaInverted?: boolean; warnAbove?: number; deltaPp?: boolean; deltaVsVj?: boolean; tint?: 'green' | 'red'; ckId?: string; hinweis?: string } = {},
  ): MrRow => ({
    type: 'data', id, label,
    ckId: opts.ckId,
    monthBudgetManuell: opts.ckId ? ckManuell(opts.ckId) : undefined,
    monthBudgetVoll: opts.ckId ? ckMFullK(opts.ckId) : undefined,
    budget: vals.budget ?? null, vj: vals.vj ?? null, vjMonth: vals.vjMonth ?? null,
    week: vals.week ?? null, weekBudget: vals.weekBudget ?? null,
    monthBudget: vals.monthBudget ?? null,
    month: vals.month ?? null,
    monthPax: vals.monthPax ?? null, weekPax: vals.weekPax ?? null, vjMonthPax: vals.vjMonthPax ?? null,
    fmt: opts.fmt ?? 'chf', bold: opts.bold,
    deltaInverted: opts.deltaInverted, warnAbove: opts.warnAbove,
    deltaPp: opts.deltaPp, deltaVsVj: opts.deltaVsVj, tint: opts.tint,
    hinweis: opts.hinweis,
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
    // Woche aus dem monatsübergreifenden Rechnungs-Set (Fremdmonate geladen).
    const weekInv = warenInvoicesWoche && weekFrom && weekTo
      ? filterInvoicesByRange(nurWarenAnteil(warenInvoicesWoche, warenGrenze), weekFrom, weekTo) : null;
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
    // ── WEQ-Soll: Ist-Warenkosten vs. Wareneinsatz auf EINER Zeile ─────────
    // Soll = WEQ-Quote des Monats × IST-Netto-Umsatz der Periode. Quote =
    // Cockpit-Wareneinsatz-Budget des Monats ÷ ER-Netto-Budget des Monats
    // (die hinterlegte monatliche WEQ); ohne Cockpit-Budget → Ziel-WKQ.
    // Woche monatsübergreifend: Σ je Monat (Quote des Monats × Netto der
    // Wochentage dieses Monats). «leer statt 0», nie ÷ 0.
    const weqQuotePct = (ym: string): number => {
      const ctx = weqJahrCtx[ym.slice(0, 4)];
      const m0 = Number(ym.slice(5, 7)) - 1;
      const chf = ctx?.blob?.positions?.['wareneinsatz']?.monthlyValues?.[m0] ?? null;
      const ern = ctx?.er?.[m0];
      if (chf != null && typeof ern === 'number' && ern > 0) return (chf / ern) * 100;
      return zielWkq;
    };
    const quoteMonat = weqQuotePct(`${year}-${mm}`);

    // ── WEQ-Modus (Spec 08/2026): 'gesamt' (Standard) = EIN WEQ je Monat gilt
    // flach für Food UND Beverage (Summe der Kategorie-Solls = Total-Soll,
    // weil Food+Beverage=Netto); 'kategorie' = getrennte Food-/Bev-WEQ je
    // Monat (manuell + Carry-Forward), Total-Soll = Food-Soll + Bev-Soll.
    // Beide Modi rechnen das Soll auf dem IST-Kategorie-Umsatz. Der Modus
    // ändert NUR die Soll-Rechnung, nie die Ist-Zahlen.
    const katModus = weqModusEff === 'kategorie';
    const m0 = Number(mm) - 1;
    // Wochen-Quote im Kategorie-Modus: Monat des KW-STARTS (nicht der Report-
    // Monat) — Fremdjahr-Wochen (KW 1/53 im Nachbarjahr) bleiben leer, weil
    // der Modus-Blob pro Jahr gilt (wie im Wochenverlauf).
    const wKatM0: number | null = weekFrom
      ? (weekFrom.slice(0, 4) === String(year) ? Number(weekFrom.slice(5, 7)) - 1 : null)
      : m0;
    const foodQ: number | null = katModus ? weqKatQ.food[m0] : r2(quoteMonat);
    const bevQ: number | null = katModus ? weqKatQ.bev[m0] : r2(quoteMonat);
    const foodQW: number | null = katModus
      ? (wKatM0 !== null ? weqKatQ.food[wKatM0] : null) : foodQ;
    const bevQW: number | null = katModus
      ? (wKatM0 !== null ? weqKatQ.bev[wKatM0] : null) : bevQ;
    const katSoll = (q: number | null, umsV: number | null, ums: number): number | null =>
      q !== null && umsV != null && ums > 0 ? r2(ums * (q / 100)) : null;
    let foodSollM = katSoll(foodQ, mNetV, mFood);
    let bevSollM = katSoll(bevQ, mNetV, mBev);
    let foodSollW = katSoll(foodQW, wNetV, wFood);
    let bevSollW = katSoll(bevQW, wNetV, wBev);

    // Total-Soll: Modus 'gesamt' = Quote × Netto (monatsgenau, Woche über
    // wNetProMonat); Modus 'kategorie' = Summe der Kategorie-Solls (leer,
    // wenn beide leer sind — leer statt 0).
    const summe2 = (a: number | null, b: number | null): number | null =>
      a === null && b === null ? null : r2((a ?? 0) + (b ?? 0));
    let sollMonat: number | null;
    let sollWoche: number | null = null;
    if (katModus) {
      sollMonat = summe2(foodSollM, bevSollM);
      sollWoche = summe2(foodSollW, bevSollW);
    } else {
      sollMonat = mNetV != null && mNet > 0 ? r2(mNet * (quoteMonat / 100)) : null;
      if (wNetV != null && wNet > 0) {
        let s = 0;
        for (const [ym, n] of Object.entries(wNetProMonat)) s += n * (weqQuotePct(ym) / 100);
        sollWoche = r2(s);
      }
      // «Summe stimmt exakt» (Spec): das gerundete Total ist massgeblich —
      // Beverage-Soll = Total − Food-Soll, wenn beide Kategorien tragen
      // (sonst könnte die getrennte Rundung um 0.01 abweichen).
      if (sollMonat !== null && foodSollM !== null && bevSollM !== null) {
        bevSollM = r2(sollMonat - foodSollM);
      }
      if (sollWoche !== null && foodSollW !== null && bevSollW !== null) {
        bevSollW = r2(sollWoche - foodSollW);
      }
    }
    const wkqM = wkqInfo(inv, monthTotal, mNetV, mNet);
    const wkqW = wkqInfo(weekInv, weekTotal, wNetV, wNet);
    // Ziel der Inline-WKQ = wirksame WEQ-Quote der Periode (Δ in pp dagegen).
    if (wkqM) {
      wkqM.ziel = katModus
        ? (sollMonat != null && mNet > 0 ? r2((sollMonat / mNet) * 100) : null)
        : r2(quoteMonat);
    }
    if (wkqW && sollWoche != null && wNet > 0) wkqW.ziel = r2((sollWoche / wNet) * 100);
    // WKQ unter dem BUDGET-Wert: Soll ÷ IST-Netto-Umsatz derselben Spalte —
    // per Konstruktion die wirksame Ziel-WKQ (z.B. konstant 24.0 %), NIE auf
    // einer anderen Umsatzbasis (Budget-Umsatz) gerechnet. «leer statt 0»,
    // nie ÷ 0.
    const pctVon = (chf: number | null, basis: number | null): number | null =>
      chf != null && basis != null && basis > 0 ? r2((chf / basis) * 100) : null;
    const totalBasisM = mNetV != null && mNet > 0 ? mNet : null;
    const totalBasisW = wNetV != null && wNet > 0 ? wNet : null;
    if (wkqM) wkqM.budgetPct = pctVon(sollMonat, totalBasisM);
    if (wkqW) wkqW.budgetPct = pctVon(sollWoche, totalBasisW);
    const totalRow: MrRow = {
      ...d('warenkosten_total', 'Warenkosten total (Ist) vs. Wareneinsatz (Soll)', {
        month: monthTotal, week: weekTotal,
        // Soll = Ziel-WKQ × IST-Netto-Umsatz — GLEICHE Logik wie Food/
        // Beverage, damit Total-Soll = Food-Soll + Beverage-Soll gilt.
        // Das Cockpit-Budget «wareneinsatz» steuert die QUOTE (÷ ER-Budget,
        // s. weqQuotePct), wird aber nicht mehr direkt als Soll angezeigt.
        monthBudget: sollMonat,
        weekBudget: sollWoche,
        budget: sollWoche,
      }, { bold: true, deltaInverted: true, ckId: 'wareneinsatz' }),
      wkqInline: {
        month: wkqM,
        week: wkqW,
      },
      // Δ% = (Ist − Soll) ÷ Ist-Netto-Umsatz (PP-Abweichung der WKQ zum Ziel).
      deltaPctBasis: { month: totalBasisM, week: totalBasisW },
    };
    // ── Warenkosten je Kategorie: FOOD (Küche) / BEVERAGE (Bar) ────────────
    // Ist = Kategorie-Anteile der erfassten Warenrechnungen; Soll = wirksame
    // Kategorie-Quote (je Modus, s. oben) × IST-Kategorie-Umsatz; WKQ-Inline-%
    // = Ist ÷ Kategorie-Umsatz (Ziel = Quote). KEINE Budget-Position.
    // «leer statt 0», nie ÷ 0. Fail-safe: unbekannter Mandant ⇒ Soll leer.
    const katRow = (
      kat: 'Food' | 'Beverage', id: string, label: string, weqPct: number | null,
      umsMV: number | null, umsM: number, umsWV: number | null, umsW: number,
      sollM: number | null, sollW: number | null,
    ): MrRow => {
      const istM = inv ? sumNetByKategorie(inv, kat, warenKonten) : 0;
      const istW = weekInv ? sumNetByKategorie(weekInv, kat, warenKonten) : 0;
      const wkq = (ist: number, umsV: number | null, ums: number): WkqInlineInfo | null =>
        ist > 0 && umsV != null && ums > 0
          ? { pct: r2((ist / ums) * 100), ziel: weqPct !== null ? r2(weqPct) : null, food: null, bev: null }
          : null;
      // Budget-WKQ der Kategorie: Soll ÷ Kategorie-Umsatz (es gibt kein
      // eigenes Kategorie-Umsatz-Budget — das Soll ist auf dem Ist-Kategorie-
      // Umsatz gerechnet, die Quote ist also die ehrliche Budget-WKQ).
      // «leer statt 0», nie ÷ 0.
      const budgetPct = (soll: number | null, umsV: number | null, ums: number): number | null =>
        soll != null && umsV != null && ums > 0 ? r2((soll / ums) * 100) : null;
      const mitBudget = (info: WkqInlineInfo | null, soll: number | null, umsV: number | null, ums: number): WkqInlineInfo | null => {
        const bp = budgetPct(soll, umsV, ums);
        if (info) return { ...info, budgetPct: bp };
        // Auch ohne Ist-Warenkosten die Budget-WKQ zeigen (Budget-Spalte).
        return bp != null ? { pct: null, ziel: null, food: null, bev: null, budgetPct: bp } : null;
      };
      return {
        ...d(id, label, {
          month: istM > 0 ? r2(istM) : null,
          week: istW > 0 ? r2(istW) : null,
          monthBudget: sollM,
          weekBudget: sollW,
          budget: sollW,
        }, { deltaInverted: true }),
        wkqInline: {
          month: mitBudget(wkq(istM, umsMV, umsM), sollM, umsMV, umsM),
          week: mitBudget(wkq(istW, umsWV, umsW), sollW, umsWV, umsW),
        },
        // Δ% = (Ist − Soll) ÷ Ist-Kategorie-Umsatz (PP-Abweichung zum Ziel).
        deltaPctBasis: {
          month: umsMV != null && umsM > 0 ? umsM : null,
          week: umsWV != null && umsW > 0 ? umsW : null,
        },
      };
    };
    const foodRow = katRow('Food', 'warenkosten_food',
      'Warenkosten Food (Küche) vs. Soll', foodQ,
      mNetV != null ? r2(mFood) : null, mFood, wNetV != null ? r2(wFood) : null, wFood,
      foodSollM, foodSollW);
    const bevRow = katRow('Beverage', 'warenkosten_beverage',
      'Warenkosten Beverage (Bar) vs. Soll', bevQ,
      mNetV != null ? r2(mBev) : null, mBev, wNetV != null ? r2(wBev) : null, wBev,
      bevSollM, bevSollW);
    // «Betriebskosten (Waren-Lieferanten)» wurde bewusst entfernt — gehört
    // nicht in diese Cockpit-Zeilenliste (Konten > Grenze bleiben aus der WKQ
    // ohnehin draussen; Detail im Waren-Cockpit).
    return [totalRow, foodRow, bevRow, ...supplierRows];
  }

  /** Lieferanten-Aufstellung für den Excel-Export (zweites Blatt «Warenkosten»). */
  function buildWarenExport(): MonatsreportDaten['waren'] {
    const invAll = warenInvoices;
    const weekInvAll = warenInvoicesWoche && weekFrom && weekTo
      ? filterInvoicesByRange(warenInvoicesWoche, weekFrom, weekTo) : null;
    // Konsistent zum Cockpit: Lieferanten/Total/WKQ = nur Warenkosten-Anteile
    // (4000–Grenze); die frühere Betriebskosten-Zeile entfällt (wie im Report).
    const period = (listAll: InvoiceEntry[] | null, netV: number | null, net: number): WarenExportPeriod | null => {
      if (!listAll || listAll.length === 0) return null;
      const list = nurWarenAnteil(listAll, warenGrenze);
      return {
        suppliers: aggregateBySupplier(list).map(a => ({
          name: a.supplierName, net: r2(a.totalNet), count: a.count,
        })),
        total: r2(sumInvoicesNet(list)),
        revenue: netV != null && net > 0 ? r2(net) : null,
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
  // Absolute Umsatz-Budgets folgen dem Budget-Modus (anteilig ↔ voll).
  const budgetGross = hatBudget ? budAbs(r2(budgetNet * VAT_STD())) : null;
  const budgetNetV = hatBudget ? budAbs(r2(budgetNet)) : null;
  const wBudget = hatBudget && weekFrom ? r2(wBudgetNet) : null;

  // ── Food-/Beverage-Umsatz-BUDGET (abgeleitet, Spec 08/2026) ────────────────
  // Kategorie-Budget = 2025-Umsatzanteil × Netto-Umsatz-Budget (Cockpit-
  // Override vor budget_v1) — speist auch das Warenkosten-Soll je Kategorie.
  // Unbekannter Mandant (Test-Mocks) oder fehlendes Netto-Budget ⇒ leer.
  const fbAnteil = FB_UMSATZ_ANTEIL_2025[tenantId] as { food: number; beverage: number } | undefined;
  const fbBudget = (anteilPct: number | undefined, basis: number | null): number | null =>
    anteilPct != null && basis != null ? r2(basis * (anteilPct / 100)) : null;
  const nettoBudM = ckMk('netto_umsatz') ?? budgetNetV;
  const nettoBudW = ckWk('netto_umsatz') ?? wBudget;
  const fbBudFoodM = fbBudget(fbAnteil?.food, nettoBudM);
  const fbBudFoodW = fbBudget(fbAnteil?.food, nettoBudW);
  const fbBudBevM = fbBudget(fbAnteil?.beverage, nettoBudM);
  const fbBudBevW = fbBudget(fbAnteil?.beverage, nettoBudW);
  const vjGrossV = N(vjGross, hatVj);
  const vjNetV = hatVj ? r2(vjNetSum) : null;
  const mGaesteV = N(mGaeste, hatGaeste);
  const wGaesteV = weekFrom ? N(wGaeste, hatWGaeste) : null;
  const vjGaesteV = N(vjGaeste, hatVjGaeste);
  const taM = mHatUmsatz && mTa > 0 ? r2(mTa) : null;
  const taW = weekFrom && wHatUmsatz && wTa > 0 ? r2(wTa) : null;
  // «Take Away Umsatz»-ZEILE zeigt NETTO (TA-brutto ÷ TA-MwSt-Divisor) —
  // konsistent zur netto budgetierten TA-Position («Überall nur Netto»).
  // Der TA-ANTEIL bleibt bewusst brutto ÷ brutto (unveränderte Ist-Quote).
  const taNettoM = taM !== null ? r2(mTa / mwstDivisorTakeaway()) : null;
  const taNettoW = taW !== null ? r2(wTa / mwstDivisorTakeaway()) : null;
  /**
   * Abgeleitetes TA-Gäste-Budget: TA-Umsatz-Budget ÷ Ø-TA-Umsatz-pro-TA-Gast
   * (Ist-Verhältnis derselben Periode). null ohne Budget oder ohne belastbares
   * Ist-Verhältnis (nie ÷ 0, leer statt 0).
   */
  const taGaesteBudget = (
    umsatzBudget: number | null, istUmsatz: number | null, istGaeste: number | null,
  ): number | null =>
    umsatzBudget !== null && istUmsatz !== null && istUmsatz > 0
      && istGaeste !== null && istGaeste > 0
      ? Math.round(umsatzBudget / (istUmsatz / istGaeste))
      : null;

  // ── Vorjahres-WOCHE: Anzeigewerte der «Vorjahr (Woche)»-Spalte ─────────────
  // Absolutwerte = Summe über die VJ-Woche; Quoten/Prozente = über die Woche
  // gebildet (NICHT summiert). «leer statt 0».
  const hatVw = vjWochePaare.length > 0;
  const vwGrossV = hatVw && hatVwUmsatz ? r2(vwGross) : null;
  const vwNetV = hatVw && hatVwUmsatz ? r2(vwNet) : null;
  const vwGaesteV = hatVw && hatVwGaeste ? r2(vwGaeste) : null;
  const vwFoodNet = hatVw && hatVwUmsatz ? r2(vwFoodNetS) : null;
  const vwBevNet = hatVw && hatVwUmsatz ? r2(vwBevNetS) : null;
  // Durchschnittsverkauf VJ-Woche: gäste-gewichtet (Fallback einfacher Mittel).
  let vwAvg: number | null = null;
  if (hatVw) {
    if (vwAvgWeight > 0) vwAvg = r2(vwAvgSum / vwAvgWeight);
    else if (vwAvgSimpleCount > 0) vwAvg = r2(vwAvgSimpleSum / vwAvgSimpleCount);
  }
  // TA-Anteil VJ-Woche = TA-Umsatz ÷ Gesamt-Umsatz der VJ-Woche.
  const vwTaAnteil = hatVw && hatVwTa && vwGross > 0 ? r2((vwTa / vwGross) * 100) : null;
  // Take-Away-UMSATZ VJ-Woche (CHF brutto) — Zähler des VJ-Anteils. «—» wenn keine TA-Quelle.
  const vwTaUmsatz = hatVw && hatVwTa && vwTa > 0 ? r2(vwTa / mwstDivisorTakeaway()) : null;

  // ── Vorjahres-MONAT: Anzeigewerte der «Vorjahr»-Spalte in der Monatssicht ──
  // Absolutwerte = Summe über den Vorjahres-Monat; Quoten als Quote (nicht
  // summiert), gleiche Regeln wie Ist. «leer statt 0».
  const vjTaAnteilM = hatVjTa && vjGross > 0 ? r2((vjTa / vjGross) * 100) : null;
  // Take-Away-UMSATZ Vorjahres-Monat (CHF brutto) — Zähler des VJ-Anteils. «—» ohne TA-Quelle.
  const vjTaUmsatzM = hatVjTa && vjTa > 0 ? r2(vjTa / mwstDivisorTakeaway()) : null; // netto
  const vjFoodNet = hatVj ? r2(vjFoodNetS) : null;
  const vjBevNet = hatVj ? r2(vjBevNetS) : null;

  /** Anteil n ÷ basis in % — null ohne Basis oder Wert (nie durch 0 teilen). */
  const anteilPct = (n: number | null | undefined, basis: number | null): number | null =>
    n != null && basis != null && basis > 0 ? r2((n / basis) * 100) : null;

  const rows: MrRow[] = [
    // ── Block Umsatz/Gäste ──
    // Budget-Spalte = Budget-WOCHENANTEIL (= weekBudget, Basis der Woche-Δ%);
    // Vorjahr-Spalte = VJ-WOCHE. monthBudget trägt das Monatsbudget für die Monat-Δ%.
    // Cockpit-KPI-Budget (falls erfasst) hat VORRANG vor budget_v1-Ableitung.
    d('brutto_umsatz', 'Brutto Umsatz', {
      month: mGrossV, week: wGrossV,
      weekBudget: ckWk('brutto_umsatz') ?? (wBudget != null ? r2(wBudget * VAT_STD()) : null),
      budget: ckWk('brutto_umsatz') ?? (wBudget != null ? r2(wBudget * VAT_STD()) : null),
      monthBudget: ckMk('brutto_umsatz') ?? budgetGross,
      vj: vwGrossV, vjMonth: vjGrossV,
    }, { bold: true }),
    {
      ...d('netto_umsatz', 'Netto Umsatz', {
        month: mNetV, week: wNetV,
        weekBudget: ckWk('netto_umsatz') ?? wBudget,
        budget: ckWk('netto_umsatz') ?? wBudget,
        monthBudget: ckMk('netto_umsatz') ?? budgetNetV,
        vj: vwNetV, vjMonth: vjNetV,
      }, { bold: true }),
      marketingNetto: {
        month: mHatUmsatz ? r2(mMkt) : null,
        week: weekFrom && wHatUmsatz ? r2(wMkt) : null,
      },
    },
    d('gaeste_in', 'Gäste IN', {
      month: mGaesteV, week: wGaesteV, vj: vwGaesteV, vjMonth: vjGaesteV,
      monthBudget: ckMk('gaeste_in'), weekBudget: ckWk('gaeste_in'), budget: ckWk('gaeste_in'),
    }, {
      fmt: 'count', ckId: 'gaeste_in',
      // Tooltip-Referenz: getippter Personen-Import vs. abgeleiteter Wert.
      hinweis: hatGetippt
        ? `getippt: ${Math.round(mGaesteGetippt).toLocaleString('de-CH')}`
          + (hatGaeste
            ? ` · abgeleitet: ${Math.round(mGaeste).toLocaleString('de-CH')}`
              + ` · Abweichung ${(((mGaesteGetippt - mGaeste) / mGaeste) * 100) >= 0 ? '+' : ''}${(((mGaesteGetippt - mGaeste) / mGaeste) * 100).toFixed(1)} %`
            : ' · abgeleitet: — (kein Umsatz/Gast-Import)')
        : undefined,
    }),
    // Reservierte Gäste (Foratable): Σ Personen gezählter Reservationen. Woche =
    // gewählte Woche, Monat = ganzer Monat (inkl. Zukunft). VJ-Woche leer (keine
    // KW-genaue VJ-Zuordnung); VJ-Monat = gleicher Monat Vorjahr.
    {
      ...d('reservierte_gaeste', 'Reservierte Gäste', {
        month: resMonth.reservedGuests, week: resWeek.reservedGuests,
        vj: null, vjMonth: resVjMonth.reservedGuests,
        // Budget = Cockpit-Position (Ist-Reservationsanteil × Gäste-IN-Budget,
        // je Monat überschreibbar); Δ bleibt VJ-basiert (sharePct-Zeile).
        monthBudget: ckMk('reservierte_gaeste'), weekBudget: ckWk('reservierte_gaeste'),
        budget: ckWk('reservierte_gaeste'),
      }, { fmt: 'count', ckId: 'reservierte_gaeste' }),
      // Anteil an «Gäste IN» (Basis = 100 %); ohne Gäste-IN-Basis null (nie ÷ 0).
      sharePct: {
        month: anteilPct(resMonth.reservedGuests, mGaesteV),
        week: anteilPct(resWeek.reservedGuests, wGaesteV),
        vj: null,
        vjMonth: anteilPct(resVjMonth.reservedGuests, vjGaesteV),
      },
    },
    // Gruppen ab N Pax: HAUPTWERT = Σ PERSONEN (gleiche Einheit wie das
    // Budget!), Anzahl Gruppen als Zusatz in Klammern («40 Pers. (2 Gruppen)»).
    // Δ rechnet damit Ist − Budget in Personen — wie alle anderen Kennzahlen;
    // der VJ-Vergleich bleibt als eigene Spalte sichtbar (nicht mehr Δ-Basis).
    // VJ-Woche leer; VJ-Monat vorhanden.
    {
      ...d('gruppen_ab_20', `Gruppen ab ${resSettings.groupThreshold} Pax`, {
        month: resMonth.largeGroupPersons, week: resWeek.largeGroupPersons,
        vj: null, vjMonth: resVjMonth.largeGroupPersons,
        monthPax: resMonth.largeGroupCount, weekPax: resWeek.largeGroupCount,
        vjMonthPax: resVjMonth.largeGroupCount,
        // Budget ebenfalls in PERSONEN (Gruppen-Anteil-% × reservierte-Gäste-
        // Budget bzw. «Aus Vorjahr übernehmen») — Einheitengleichheit mit Ist.
        monthBudget: ckMk('gruppen_20pax'), weekBudget: ckWk('gruppen_20pax'),
        budget: ckWk('gruppen_20pax'),
      }, { fmt: 'countPax', ckId: 'gruppen_20pax' }),
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
    {
      ...d('gaeste_take_away', 'Gäste Take Away', {
        month: taMonth, week: taWeek,
        vj: null, vjMonth: taVjMonth,
        // Abgeleitetes TA-Gäste-Budget (Spec 08/2026): TA-Umsatz-Budget der
        // Periode ÷ Ø-TA-Umsatz-pro-TA-Gast (IST-Verhältnis derselben Periode).
        // Verhältnis nur bei beiden Ist-Quellen > 0 (nie ÷ 0, leer statt 0).
        monthBudget: taGaesteBudget(ckMk('take_away_umsatz'), taNettoM, taMonth),
        weekBudget: taGaesteBudget(ckWk('take_away_umsatz'), taNettoW, taWeek),
        budget: taGaesteBudget(ckWk('take_away_umsatz'), taNettoW, taWeek),
      }, { fmt: 'count' }),
      // Anteil an ALLEN Gästen: TA ÷ (Gäste IN + Gäste TA). Ohne Gäste-IN-Basis
      // null (nie ÷ 0) — parallel zur umsatzbasierten Zeile «Take Away Anteil».
      sharePct: {
        month: anteilPct(taMonth, taMonth != null && mGaesteV != null ? mGaesteV + taMonth : null),
        week: anteilPct(taWeek, taWeek != null && wGaesteV != null ? wGaesteV + taWeek : null),
        vj: null,
        vjMonth: anteilPct(taVjMonth, taVjMonth != null && vjGaesteV != null ? vjGaesteV + taVjMonth : null),
      },
      shareHint: 'Anteil aller Gäste',
    },
    e(),
    // ── Block Durchschnitt ──
    // Zeile «Durchschnittsverkauf» bewusst ENTFERNT (Spec 08/2026: kein Budget,
    // keine Anzeige mehr) — die berechnete Grösse bleibt «Ø-Verkauf pro Gast».
    d('take_away_anteil', 'Take Away Anteil', {
      month: taM != null && mGross > 0 ? r2((mTa / mGross) * 100) : null,
      week: taW != null && wGross > 0 ? r2((wTa / wGross) * 100) : null,
      // Vorjahr-Woche: TA-Umsatz ÷ Gesamt-Umsatz der VJ-Woche (Quote, nicht summiert).
      vj: vwTaAnteil, vjMonth: vjTaAnteilM,
      monthBudget: ckMk('take_away_anteil'), weekBudget: ckWk('take_away_anteil'),
      budget: ckWk('take_away_anteil'),
    }, { fmt: 'pct', ckId: 'take_away_anteil' }),
    // Take Away Umsatz (CHF NETTO): gleiche Quelle wie der TA-Anteil, aber
    // netto ausgewiesen (÷ TA-MwSt-Divisor) — konsistent zum netto budgetierten
    // Cockpit-Budget. Woche = gewählte Woche, Monat = ganzer Monat; VJ analog.
    // Kein Budget vorhanden → Δ% gegen das Vorjahr (deltaVsVj), Farblogik wie
    // die übrigen Umsatzkennzahlen (mehr = grün).
    d('take_away_umsatz', 'Take Away Umsatz (netto)', {
      month: taNettoM, week: taNettoW,
      vj: vwTaUmsatz, vjMonth: vjTaUmsatzM,
      monthBudget: ckMk('take_away_umsatz'), weekBudget: ckWk('take_away_umsatz'),
      budget: ckWk('take_away_umsatz'),
      // Mit erfasstem Cockpit-Budget Δ% gegen das Budget, sonst gegen das VJ.
    }, { deltaVsVj: ckMk('take_away_umsatz') == null, ckId: 'take_away_umsatz' }),
    // Food-/Beverage-UMSATZ (netto): Ist = foodBeverageSplit (Invariante
    // Food+Beverage=Netto); Budget = 2025-Umsatzanteil × Netto-Umsatz-Budget
    // (FB_UMSATZ_ANTEIL_2025, abgeleitet — KEINE eigene Cockpit-Position).
    // Mit Budget Δ% gegen Budget, ohne (kein Netto-Budget) gegen das VJ.
    d('food_umsatz', 'Food Umsatz (netto)', {
      month: mHatUmsatz ? r2(mFood) : null,
      week: weekFrom && wHatUmsatz ? r2(wFood) : null,
      vj: vwFoodNet, vjMonth: vjFoodNet,
      monthBudget: fbBudFoodM, weekBudget: fbBudFoodW, budget: fbBudFoodW,
    }, { deltaVsVj: fbBudFoodM == null }),
    d('beverage_umsatz', 'Beverage Umsatz (netto)', {
      month: mHatUmsatz ? r2(mBev) : null,
      week: weekFrom && wHatUmsatz ? r2(wBev) : null,
      vj: vwBevNet, vjMonth: vjBevNet,
      monthBudget: fbBudBevM, weekBudget: fbBudBevW, budget: fbBudBevW,
    }, { deltaVsVj: fbBudBevM == null }),
    e(),
    // ── Block Produktivität ──
    // EINE Stunden-Zeile (Spec 08/2026, ersetzt Bedarf/Plan/Ist-Einzelzeilen):
    // Ist-Spalte = Ist-Stunden (MIRUS), Budget-Spalte = Dienstplan-PLAN-Stunden,
    // Bedarf (Soll) informativ im Label (Monatswert). Δ% Ist vs. Plan mit
    // Kosten-Ampel (über Plan = rot). «leer statt 0» bleibt je Quelle erhalten.
    d('prod_stunden_ist',
      bedarfStdM != null
        ? `Stunden — Bedarf (Soll) ${Math.round(bedarfStdM).toLocaleString('de-CH')} / Plan (Budget) / Ist (MIRUS)`
        : 'Stunden — Plan (Budget) / Ist (MIRUS)', {
      month: istStd, week: wIstStd,
      // Stunden-Budget (Plan) ist absolut → folgt dem Budget-Modus.
      monthBudget: budAbs(planStd), weekBudget: wPlanStd, budget: wPlanStd,
    }, { fmt: 'hours', bold: true, deltaInverted: true }),
    d('produktivitaet', 'Produktivität (Umsatz/Std)', {
      month: mNetV != null && istStd ? r2(mNet / istStd) : null,
      week: wNetV != null && wIstStd ? r2(wNet / wIstStd) : null,
      // vj_daily hat keine Personalstunden → keine VJ-Produktivität.
      // Budget: direkter Override/Ratio aus dem Cockpit-Budget (Netto ÷
      // prod_stunden-Position); FEHLT die Stunden-Position, gilt der Fallback
      // Netto-Umsatz-Budget ÷ Stunden-Budget (Plan) — dieselben Werte wie in
      // der Stunden-Zeile darüber. Leer wenn Stunden-Budget fehlt, nie ÷ 0.
      monthBudget: ckMk('produktivitaet')
        ?? (hatBudget && planStd != null && planStd > 0 ? r2(budgetNet / planStd) : null),
      weekBudget: ckWk('produktivitaet')
        ?? (wBudgetNet > 0 && wPlanStd != null && wPlanStd > 0 ? r2(wBudgetNet / wPlanStd) : null),
      budget: ckWk('produktivitaet')
        ?? (wBudgetNet > 0 && wPlanStd != null && wPlanStd > 0 ? r2(wBudgetNet / wPlanStd) : null),
    }, { ckId: 'produktivitaet' }),
    // «Umsatz pro Gast» wurde konsolidiert — es bleibt NUR «Ø-Verkauf pro Gast».
    // Ø-Verkauf pro Gast (wie Jahresvergleich): Oliv (Netto − TA-Netto) ÷ Gäste,
    // Beaulieu Netto ÷ Gäste — NUR gepaarte Tage, «leer statt 0», nie ÷ 0.
    // Budget = Verhältnis-Budget (Basis-Budgets) bzw. direktes Override.
    d('avg_verkauf_gast', 'Ø-Verkauf pro Gast', {
      month: pairedGaeste > 0 ? r2(pairedVerkauf / pairedGaeste) : null,
      week: weekFrom && wPairedGaeste > 0 ? r2(wPairedVerkauf / wPairedGaeste) : null,
      vj: hatVw && vwPairedGaeste > 0 ? r2(vwPairedVerkauf / vwPairedGaeste) : null,
      vjMonth: vjPairedGaeste > 0 ? r2(vjPairedVerkauf / vjPairedGaeste) : null,
      monthBudget: ckMk('avg_verkauf_gast'), weekBudget: ckWk('avg_verkauf_gast'),
      budget: ckWk('avg_verkauf_gast'),
    }, { ckId: 'avg_verkauf_gast' }),
    e(),
    // ── Block Personal (ALLE Werte aus dem Kern personalkosten.ts) ─────────────
    // Kosten-Zeile: deltaInverted → über Budget = rot. MONAT = tatsächlich bis
    // STICHTAG angefallene Kosten (KEINE Hochrechnung; Stichtag im Label).
    d('personalkosten',
      standIso
        ? `Personalkosten (Monat — bis ${standIso.split('-').reverse().join('.')})`
        : 'Personalkosten', {
      week: personal?.pkIstWoche ?? null,
      // Budget AUSSCHLIESSLICH aus dem Cockpit-Budget-Store (eine Quelle);
      // ohne gespeichertes Budget bleibt die Zelle leer (nie die alte
      // Kern-Zielquote als stiller Fallback).
      weekBudget: ckWk('personalkosten'),
      budget: ckWk('personalkosten'),
      monthBudget: ckMk('personalkosten'),
      month: personal?.pkIstMonat ?? null,
      // Vorjahr NUR Monat: Buchhaltungswert (vorjahres_personalkosten,
      // ausschliesslich Jahre < 2026 ohne Dienstplan-Berechnung).
      // KEINE Verteilung auf Wochen → vj (Woche) bleibt leer.
      vj: null, vjMonth: pkVjEff ? r2(pkVjEff.chf) : null,
    }, { bold: true, deltaInverted: true, ckId: 'personalkosten' }),
    // PKQ: Budget = Ziel-PKQ (Budget-Personalkosten ÷ Budget-Umsatz, aus dem
    // Kern budgetZielQuote) in BEIDEN Sichten; Δ = Ist − Ziel in PROZENTPUNKTEN
    // (deltaPp, über Ziel = rot); zusätzlich rot über harter Obergrenze.
    // PKQ-Ziel: direktes Cockpit-Budget (Quote/Override) hat Vorrang vor der
    // Kern-Zielquote (budgetZielQuote).
    d('personalquote', 'Personalquote (PKQ)', {
      // Ziel-PKQ NUR aus dem Cockpit-Budget (kein 35.5 %-Fallback aus dem
      // Personal-Modul mehr); leer wenn nicht budgetiert.
      budget: ckWk('personalquote'),
      weekBudget: ckWk('personalquote'),
      monthBudget: ckMk('personalquote'),
      week: personal?.pkqWochePct ?? null,
      month: personal?.pkqMonatPct ?? null,
      // PKQ Vorjahr (nur Monat) = Buchhaltungs-Personalkosten ÷ Netto-Umsatz
      // desselben VJ-Monats (vj_daily, Standard-MwSt-Netto).
      vj: null,
      vjMonth: pkVjEff && vjNetV != null && vjNetV > 0 ? r2((pkVjEff.chf / vjNetV) * 100) : null,
    }, { fmt: 'pct', warnAbove: OBERGRENZE_PKQ_PCT, deltaPp: true, ckId: 'personalquote' }),
    // Überstunden total: Σ laufender Saldo aller FIX-MA ab Juli 2026 bis HEUTE
    // (je Mandant; unabhängig vom gewählten Monat — Konto-Stand, kein
    // Periodenwert). leer statt 0 wenn keine Datenbasis. Kein Budget/VJ.
    // Klammer-Zusatz «(davon +X.X kostenwirksam)»: Σ max(0, Saldo je MA) —
    // genau die Plus-Stunden hinter der Kosten-Zeile (Minus-Salden erzeugen
    // keine negativen Kosten). Transport über die *Pax-Begleitfelder.
    d('ueberstunden_total', 'Überstunden (Fix-MA)', {
      month: uePeriode?.monat.stunden != null ? r2(uePeriode.monat.stunden) : null,
      week: uePeriode?.woche.stunden != null ? r2(uePeriode.woche.stunden) : null,
      monthPax: uePeriode?.monat.plusStunden != null ? r2(uePeriode.monat.plusStunden) : null,
      weekPax: uePeriode?.woche.plusStunden != null ? r2(uePeriode.woche.plusStunden) : null,
    }, { fmt: 'hours', deltaInverted: true }),
    // Überstunden-Kosten: Σ max(0, Perioden-Saldo) × AG-Stundensatz je MA.
    d('ueberstunden_kosten_total', 'Überstunden-Kosten (Fix-MA)', {
      month: uePeriode?.monat.kosten != null ? r2(uePeriode.monat.kosten) : null,
      week: uePeriode?.woche.kosten != null ? r2(uePeriode.woche.kosten) : null,
    }, { fmt: 'chf', deltaInverted: true }),
    e(),
    // ── Block Warenkosten (erfasste Warenrechnungen, netto) ────────────────
    // Eine Zeile pro Lieferant (Top-Betrag des Monats zuerst) + Total + WKQ.
    // Leere Perioden bleiben leer (nie 0 erfinden); Ladefehler → alles leer.
    // Kosten-Logik (deltaInverted); WKQ mit Ziel-Quote als Budget und Δ in PP
    // (über Ziel = rot, wie PKQ).
    ...buildWarenRows(),
    e(),
    // ── Block Rezensionen (Google/TripAdvisor-Erfassung + Lunchgate-Import) ─
    // Pro Plattform alle fünf Sternstufen: Monat = ganzer Monat, Woche =
    // gewählte Woche. 2/4 Sterne standardmässig eingeklappt (Kind der
    // 5-Sterne-Zeile, per Klick sichtbar). Budgets (Spec 08/2026): 5 Sterne
    // Ziel 5/Woche, 1/3 Sterne Ziel 0 (echte Ziel-0, kein «leer statt 0»),
    // je Monat via Cockpit-Budget überschreibbar; 2/4 Sterne ohne Budget.
    // Plattformen strikt getrennt (Plattform-Filter, nie vermischt).
    ...reviewStarRowDefs(tenantId).map(({ platform, star, id, label, tint, collapsed, parentId }) => {
      const hatCk = COCKPIT_BUDGET_KPIS.some(k => k.id === id);
      const mTage = new Date(year, month, 0).getDate();
      const wTage = weekFrom && weekTo
        ? Math.round((Date.parse(weekTo) - Date.parse(weekFrom)) / 86_400_000) + 1 : 0;
      // Rezensions-Budget: absolut → im Stichtag-Modus kalendertag-anteilig
      // (Kontrolle: 22 × 9/31 ≈ 6); ckMk ist bereits anteilig, der
      // reviewZielBudget-Fallback (volle Monatstage) wird via budAbs gekürzt.
      const mBud = collapsed ? null : (hatCk ? ckMk(id) : null)
        ?? budAbs(reviewZielBudget(star, mTage, reviewWochenrate(tenantId, platform)));
      const wBud = collapsed ? null : (hatCk ? ckWk(id) : null) ?? reviewZielBudget(star, wTage, reviewWochenrate(tenantId, platform));
      return {
        ...d(id, label, {
          month: reviewSingles ? countReviewsByStar(reviewSingles, platform, fromIso, toIso, star) : null,
          week: reviewSingles && weekFrom && weekTo
            ? countReviewsByStar(reviewSingles, platform, weekFrom, weekTo, star) : null,
          monthBudget: mBud, weekBudget: wBud, budget: wBud,
        }, {
          fmt: 'count', tint,
          // 1/3 Sterne: mehr als das Ziel (0) ist schlecht → Kosten-Ampel.
          deltaInverted: star === 1 || star === 3,
          ...(hatCk ? { ckId: id } : {}),
        }),
        ...(collapsed ? { childOf: parentId } : {}),
      };
    }),
  ];

  // Take-Away-Zeilen entfernen, wenn der Betrieb kein Take Away anbietet.
  const rowsFinal = filterTakeAwayRows(rows, taOffered);

  return {
    year, month, weekFrom, weekTo, weekLabel,
    standBis: standIso || null,
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
  /**
   * Cockpit-Budget je Woche (pro rata auf die KW-Tage; KW-Override falls
   * gesetzt; laufende Woche auf die Ist-Tage geklemmt). null = kein Budget
   * («leer statt 0») — die UI zeigt dann keine Budget-Subzeile.
   */
  budgetValues?: (number | null)[];
  /** Δ-Färbung invertiert (Kostenzeilen: über Budget = rot). */
  budgetInverted?: boolean;
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
 * Vorjahres-Aggregat je Woche (vj_daily brutto → netto per VAT_STD(), wie im
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
    // Netto + F/B je Tag über vjTagWerte — identische Regel wie laufendes Jahr.
    const w = vjTagWerte(tenantId, rec, date);
    if (w) {
      a.gross += rec.actualRevenue!; a.net += w.netto; a.hatUmsatz = true;
      a.food += w.food; a.hatFood = true;
      a.bev += w.beverage; a.hatBev = true;
    }
    if ((rec.takeawayRevenue ?? 0) > 0) { a.ta += rec.takeawayRevenue!; a.hatTa = true; }
    const g = gaesteDaily[date] ?? 0;
    if (w && g > 0) {
      a.pairedNet += w.netto; a.pairedGaeste += g;
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
  /** Aufgelöste Cockpit-Budgets je Woche (resolveCockpitBudgets). */
  budgets?: Record<string, number | null>[],
  /** F/B-Umsatzanteil 2025 des Mandanten (abgeleitetes Kategorie-Budget). */
  fbAnteil?: { food: number; beverage: number },
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
    /** Cockpit-Budget-KPI dieser Zeile (Subzeile «B …» je Woche). */
    budgetId?: string;
    /** Abgeleitetes Budget aus den aufgelösten Wochen-Budgets (Vorrang vor budgetId). */
    budgetOf?: (b: Record<string, number | null>) => number | null;
    /** Budget aus dem Ist-Aggregat (z.B. Plan-Stunden) — nur im aktuellen Jahr. */
    budgetIst?: (a: WeekAgg) => number | null;
    budgetInverted?: boolean;
  };
  const defs: Def[] = [
    { label: 'Brutto Umsatz', fmt: 'chf', bold: true, budgetId: 'brutto_umsatz',
      ist: a => a.hatUmsatz ? r2(a.gross) : null, vj: a => a.hatUmsatz ? r2(a.gross) : null },
    { label: 'Netto Umsatz', fmt: 'chf', bold: true, budgetId: 'netto_umsatz',
      ist: a => a.hatUmsatz ? r2(a.net) : null, vj: a => a.hatUmsatz ? r2(a.net) : null },
    // Food-/Beverage-UMSATZ (netto): Ist = foodBeverageSplit; Budget =
    // 2025-Umsatzanteil × Netto-Umsatz-Budget der KW (abgeleitet, Spec 08/2026).
    { label: 'Food Umsatz (netto)', fmt: 'chf',
      ist: a => a.hatUmsatz ? r2(a.food) : null, vj: a => a.hatFood ? r2(a.food) : null,
      budgetOf: b => fbAnteil && b['netto_umsatz'] != null
        ? r2(b['netto_umsatz']! * (fbAnteil.food / 100)) : null },
    { label: 'Beverage Umsatz (netto)', fmt: 'chf',
      ist: a => a.hatUmsatz ? r2(a.bev) : null, vj: a => a.hatBev ? r2(a.bev) : null,
      budgetOf: b => fbAnteil && b['netto_umsatz'] != null
        ? r2(b['netto_umsatz']! * (fbAnteil.beverage / 100)) : null },
    { label: 'Gäste IN', fmt: 'count', budgetId: 'gaeste_in',
      ist: a => a.hatGaeste ? r2(a.gaeste) : null, vj: a => a.hatGaeste ? r2(a.gaeste) : null },
    // «Durchschnittsverkauf» bewusst entfernt (Spec 08/2026).
    { label: 'Take Away Anteil', fmt: 'pct', budgetId: 'take_away_anteil',
      ist: a => a.hatUmsatz && a.gross > 0 && a.ta > 0 ? r2((a.ta / a.gross) * 100) : null,
      vj: a => a.hatTa && a.gross > 0 ? r2((a.ta / a.gross) * 100) : null },
    // EINE Stunden-Zeile (Spec 08/2026): Ist = MIRUS, Budget = Dienstplan-PLAN
    // aus dem Wochen-Ist-Aggregat (nur aktuelles Jahr; VJ hat keine Stunden).
    { label: 'Stunden — Plan (Budget) / Ist (MIRUS)', fmt: 'hours', budgetInverted: true,
      ist: a => a.hatIst ? r2(a.istStd) : null, vj: () => null,
      budgetIst: a => a.hatPlan ? r2(a.planStd) : null },
    { label: 'Produktivität (Umsatz/Std)', fmt: 'chf', budgetId: 'produktivitaet',
      ist: a => a.hatUmsatz && a.hatIst && a.istStd > 0 ? r2(a.net / a.istStd) : null, vj: () => null },
    // «Umsatz pro Gast» konsolidiert (es bleibt «Ø-Verkauf pro Gast» in den
    // Monats-/Wochen-/Jahres-Ansichten; hier keine TA-Netto-Quelle je Woche).
  ];

  return defs.map(d => ({
    label: d.label, fmt: d.fmt, bold: d.bold,
    values: mainAus === 'ist' ? istCol(d.ist) : vjMainCol(d.vj),
    vjValues: vjCol(d.vj),
    budgetValues: d.budgetIst
      ? (mainAus === 'ist' ? istCol(d.budgetIst) : undefined)
      : d.budgetOf
        ? (budgets ? budgets.map(b => d.budgetOf!(b)) : undefined)
        : budgets && d.budgetId
          ? budgets.map(b => b[d.budgetId!] ?? null) : undefined,
    budgetInverted: d.budgetInverted,
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
    // Abgeleitete Gäste IN (Umsatz ÷ Umsatz/Person) — gleiche Quelle wie Monatssicht.
    ladeGaesteInAbgeleitet(tenantId, tenantKey).catch(() => ({} as Record<string, number>)),
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

  // ── Cockpit-Budget je Woche (mandantengetrennt, pro Jahr) ─────────────────
  // Wochenbudget = KW-Override falls gesetzt, sonst Monatsbudget pro rata über
  // die Tagesanteile (auch über Monatsgrenzen). Laufende Woche: auf die
  // Ist-Tage bis heute geklemmt (gemeinsamer Stichtag mit dem Ist). Blob und
  // ER-Netto-Basis je Jahr des Wochenstarts (Jahreswechsel-Fenster).
  const wochenBudgets: Record<string, number | null>[] = await (async () => {
    try {
      const years = [...new Set(weeks.map(w => Number(w.from.slice(0, 4))))];
      const blobs = new Map(await Promise.all(years.map(async y =>
        [y, await loadCockpitBudget(tenantKey, y).catch(() => null)] as const)));
      const erM = new Map(years.map(y =>
        [y, erNettoBudgetMonate(y, tenantKey('budget_v1'))] as const));
      return weeks.map((w, i) => {
        const to = partialWeekIndex === i && todayIso < w.to ? todayIso : w.to;
        const days: string[] = [];
        for (let d = new Date(`${w.from}T00:00:00`); iso(d) <= to; d.setDate(d.getDate() + 1)) {
          days.push(iso(d));
        }
        const y = Number(w.from.slice(0, 4));
        return resolveCockpitBudgets(
          blobs.get(y) ?? null, tenantId, w.from, to, days, erM.get(y) ?? null);
      });
    } catch (e) {
      console.error('[WOCHENVERLAUF] Budget-Auflösung fehlgeschlagen:', e);
      return weeks.map(() => ({} as Record<string, number | null>));
    }
  })();

  const rows = baueWochenverlaufRows(mainAggs, mainAus, vjAggs, wochenBudgets,
    FB_UMSATZ_ANTEIL_2025[tenantId] as { food: number; beverage: number } | undefined);

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
    budgetValues: wochenBudgets.map(b => b['reservierte_gaeste'] ?? null),
  });
  // Gruppen: Ist = Σ PERSONEN (Einheitengleichheit mit dem gruppen_20pax-Budget,
  // das ausdrücklich in Personen definiert ist — nicht Anzahl Gruppen).
  rows.push({
    label: `Gruppen ab ${wvCounting.groupThreshold} Pax (Personen)`, fmt: 'count', id: 'gruppen_ab_20',
    values: wvResMetrics.map(m => m.largeGroupPersons),
    vjValues: wvResVj ? wvResVj.map(m => m.largeGroupPersons) : undefined,
    budgetValues: wochenBudgets.map(b => b['gruppen_20pax'] ?? null),
  });

  // ── Rezensionen je Woche (ALLE Sternstufen 5–1, Google + Lunchgate) ────────
  // Ladefehler → alle Spalten null (leer, nie 0 erfinden); geladener Blob →
  // echte Anzahl je Wochenfenster. VJ-Spalte nur, wenn dort wirklich Rezensionen
  // erfasst sind (>0) — die Quelle existiert erst seit der Einzelerfassung.
  const reviewSingles: SingleReview[] | null =
    await fetchReviewsData(tenantId).then(d => d.singleReviews).catch(() => null);
  // 2/4 Sterne sind im Wochenverlauf ausgeblendet (kein Aufklapp-Mechanismus).
  for (const { platform, star, id, label, tint } of reviewStarRowDefs(tenantId).filter(r => !r.collapsed)) {
    rows.push({
      label, fmt: 'count', tint,
      // Budget: Cockpit-Override der Woche, sonst Standardziel (5★ = 5/Woche,
      // 1/3★ = 0) — Tage wie beim Budget auf «bis heute» geklemmt.
      budgetValues: weeks.map((w, i) => {
        const ck = wochenBudgets[i]?.[id];
        if (ck != null) return ck;
        const to = partialWeekIndex === i && todayIso < w.to ? todayIso : w.to;
        const tage = Math.round((Date.parse(to) - Date.parse(w.from)) / 86_400_000) + 1;
        return reviewZielBudget(star, tage, reviewWochenrate(tenantId, platform));
      }),
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
  // Alias-Gruppen: Lieferanten-Namen kanonisieren (wie Monats-Cockpit/Abgleich).
  const wvAliasGruppen = await loadAliasGruppen(tenantId).catch(() => [] as AliasGruppe[]);
  const allInvoices: InvoiceEntry[] | null =
    invLists.every(l => l === null) ? null : applyAliasGruppen(invLists.flatMap(l => l ?? []), wvAliasGruppen);
  if (allInvoices) {
    // Kontoklassen: Total/WKQ/Lieferanten nur Warenkosten-Anteile (4000–Grenze);
    // Betriebskosten-Anteile separat als eigene Zeile (nie in der WKQ).
    const grenzeVerlauf = await loadWarenkostenGrenze(tenantId).catch(() => DEFAULT_WARENKOSTEN_GRENZE);
    const warenOnly = nurWarenAnteil(allInvoices, grenzeVerlauf);
    // Laufende (partielle) Woche: Rechnungen wie das Ist auf «bis heute»
    // klemmen — sonst zählen zukünftig datierte Rechnungen gegen einen nur
    // bis heute laufenden Umsatz-Nenner (falsche WKQ/Δ in der KW).
    const invTo = (w: WeekWindow, i: number): string =>
      partialWeekIndex === i && todayIso < w.to ? todayIso : w.to;
    const weekInvAll = weeks.map((w, i) => filterInvoicesByRange(allInvoices, w.from, invTo(w, i)));
    const weekInv = weeks.map((w, i) => filterInvoicesByRange(warenOnly, w.from, invTo(w, i)));
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
      // Platzhalter — wird unten in BEIDEN Modi durch Food-Soll + Bev-Soll
      // ersetzt (Quote × IST-Netto der KW), nie Cockpit-Budget-CHF direkt.
      budgetValues: weeks.map(() => null),
      budgetInverted: true,
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
    // «Betriebskosten (Waren-Lieferanten)» bewusst entfernt (Konten > Grenze
    // bleiben aus der WKQ ohnehin draussen; Detail im Waren-Cockpit).
    // ── Warenkosten je Kategorie: FOOD (Küche) / BEVERAGE (Bar) ──────────────
    // Ist (CHF) = Kategorie-Anteile der Rechnungen; Soll = wirksame Kategorie-
    // Quote × IST-Kategorie-Umsatz der KW (WEQ-Modus, Spec 08/2026):
    //  - 'gesamt': flache Wochen-WEQ = Cockpit-Wareneinsatz-Budget ÷ Netto-
    //    Budget der KW (Fallback Ziel-WKQ) für Food UND Beverage;
    //  - 'kategorie': Food-/Bev-WEQ des Monats des KW-Starts (manuell + Carry).
    // WKQ-% = Ist ÷ IST-Kategorie-Umsatz (Ziel = Quote). «leer statt 0», nie ÷0.
    const weqModusWv = await loadWeqModus(tenantKey, selectedYear).catch(() => null);
    const katModusWv = (weqModusWv?.modus ?? 'gesamt') === 'kategorie';
    const weqKatQWv = effektiveKategorieWeq(weqModusWv, tenantId);
    const gesamtQOf = (i: number): number | null => {
      const bud = wochenBudgets?.[i]?.['wareneinsatz'];
      const netBud = wochenBudgets?.[i]?.['netto_umsatz'];
      if (bud != null && netBud != null && netBud > 0) return r2((bud / netBud) * 100);
      return zielWkqVerlauf > 0 ? r2(zielWkqVerlauf) : null;
    };
    const katQOf = (i: number, kat: 'Food' | 'Beverage'): number | null => {
      if (!katModusWv) return gesamtQOf(i);
      // Wochen dem Jahr des KW-Starts zuordnen; Fremdjahr-Wochen (KW 1/53
      // im Nachbarjahr) haben keinen Blob des gewählten Jahres → leer.
      const from = weeks[i].from;
      if (from.slice(0, 4) !== String(selectedYear)) return null;
      const m0 = Number(from.slice(5, 7)) - 1;
      const q = kat === 'Food' ? weqKatQWv.food[m0] : weqKatQWv.bev[m0];
      return q !== null ? r2(q) : null;
    };
    const warenKonten = await loadWarenkonten(tenantId).catch(() => [] as Warenkonto[]);
    const katNetOf = (i: number, kat: 'Food' | 'Beverage'): number | null => {
      const a = mainAggs[i];
      if (!a || !a.hatUmsatz) return null;
      const n = kat === 'Food' ? a.food : a.bev;
      return n > 0 ? n : null;
    };
    const katSollOf = (i: number, kat: 'Food' | 'Beverage'): number | null => {
      const q = katQOf(i, kat);
      const n = katNetOf(i, kat);
      return q !== null && n !== null ? r2(n * (q / 100)) : null;
    };
    // Total-Soll der KW = Food-Soll + Bev-Soll in BEIDEN Modi (leer, wenn
    // beide leer) — Quote × IST-Netto, gleiche Basis wie der Monatsreport;
    // damit gilt auch im Verlauf Total-Soll = Food-Soll + Beverage-Soll und
    // nie mehr ein Cockpit-Budget-CHF auf Budget-Umsatz-Basis.
    {
      const totalWvRow = rows.find(rw => rw.id === 'warenkosten_total');
      if (totalWvRow) {
        totalWvRow.budgetValues = weeks.map((_, i) => {
          const f = katSollOf(i, 'Food'), b = katSollOf(i, 'Beverage');
          return f === null && b === null ? null : r2((f ?? 0) + (b ?? 0));
        });
      }
    }
    for (const kat of ['Food', 'Beverage'] as const) {
      rows.push({
        label: kat === 'Food' ? 'Warenkosten Food (Küche)' : 'Warenkosten Beverage (Bar)',
        fmt: 'chf',
        values: weekInv.map(list => {
          const s = sumNetByKategorie(list, kat, warenKonten);
          return s > 0 ? r2(s) : null;
        }),
        budgetValues: weeks.map((_, i) => katSollOf(i, kat)),
        budgetInverted: true,
        wkqValues: weekInv.map((list, i) => {
          const n = katNetOf(i, kat);
          const s = sumNetByKategorie(list, kat, warenKonten);
          return s > 0 && n !== null ? r2((s / n) * 100) : null;
        }),
        // Ziel-Quote je Modus: 'kategorie' = Default-Quote des Mandanten als
        // Kopfwert (Monatswerte variieren je KW); 'gesamt' ohne festes Ziel.
        wkqZiel: undefined,
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
  baseYear?: number,
): Promise<JahresvergleichDaten> {
  const win = computeVergleichsWindow(modus, heute, von, bis, baseYear);
  // Abgeschlossenes Jahr: 'ytd' wurde im Fenster als 'ganzjahr' behandelt —
  // auch im Rückgabewert ausweisen (Kopf-/Spalten-Beschriftung).
  if (modus === 'ytd' && win.curYear !== heute.getFullYear()) modus = 'ganzjahr';
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
    // Abgeleitete Gäste IN (Umsatz ÷ Umsatz/Person) — gleiche Quelle wie Monatssicht.
    ladeGaesteInAbgeleitet(tenantId, tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    ladeUmsatzTage(tenantId, curFrom, curTo),
  ]);

  // Umsatz aktuell + gepaarte Umsatz/Gäste-Tage.
  let gross = 0, net = 0, ta = 0, food = 0, bev = 0, hatUmsatz = false;
  let pairedNet = 0, pairedGaeste = 0;
  // «Ø-Verkauf pro Gast» (ersetzt die Ø-Bon-Kachel) — mandantenspezifischer
  // Zähler über GEPAARTE Tage (Umsatz UND Gäste vorhanden):
  //   Beaulieu: Netto (inkl. Marketing/Maison — Nennwert = netto, SSOT-Regel)
  //   Oliv:     Netto − Take-Away-Netto (TA-brutto ÷ 1.026); Maison bleibt drin.
  // Der maisonExclude-Anzeige-Toggle greift hier bewusst NICHT (reine
  // Betriebsertrags-Darstellung, nicht diese Kennzahl).
  // NENNER-INVARIANTE (alle Ansichten: Jahr/Monat/Woche): gaesteDaily =
  // «Gäste IN» (importierte Anzahl Personen, OHNE Take-Away — TA-Gäste liegen
  // separat in ta-gaeste-daily; verifiziert 08/2026 Oliv: 1'384 vs. 517).
  // NIE TA-Gäste zusätzlich abziehen (wäre Doppelabzug) und NIE addieren.
  let pairedVerkauf = 0, vjPairedVerkauf = 0;
  const verkaufTagCur = (netto: number, taBrutto: number): number =>
    tenantId === 'oliv' ? netto - taBrutto / mwstDivisorTakeaway() : netto;
  for (const [date, tag] of umsatzTage) {
    if (date < curFrom || date > curTo || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    gross += tag.gesamtBrutto; net += netto;
    ta += tag.takeAwayBrutto;
    food += split.food; bev += split.beverage; hatUmsatz = true;
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) {
      pairedNet += netto; pairedGaeste += g;
      pairedVerkauf += verkaufTagCur(netto, tag.takeAwayBrutto);
    }
  }

  // Fallback GEWÄHLTES Jahr: hat der Ist-Store (dailyBudgets) im Zeitraum
  // KEINEN Tag, liegt das Jahr nur im Vorjahr-Store (vj_daily) — z.B. 2024.
  // Dann exakt dieselbe Quelle+Regel wie die Vorjahres-Spalte (vjTagWerte),
  // damit ein Jahr als gewähltes Jahr dieselben Werte zeigt wie als Vorjahr.
  // Invariante food+beverage=netto gilt konstruktiv. Mandantengetrennt.
  if (!hatUmsatz && curMonths.length > 0) {
    const curVjMaps = await Promise.all(
      curMonths.map(mo =>
        loadVjDailyMonth(curYear, mo, tenantId).catch(() => ({} as Record<string, VjDayRecord>))),
    );
    const curVjDaily: Record<string, VjDayRecord> = {};
    for (const m of curVjMaps) Object.assign(curVjDaily, m);
    for (const [date, rec] of Object.entries(curVjDaily)) {
      if (date < curFrom || date > curTo) continue;
      const w = vjTagWerte(tenantId, rec, date);
      if (w) {
        gross += rec.actualRevenue!; net += w.netto;
        food += w.food; bev += w.beverage; hatUmsatz = true;
      }
      if ((rec.takeawayRevenue ?? 0) > 0) { ta += rec.takeawayRevenue!; }
      const g = gaesteDaily[date] ?? 0;
      if (w && g > 0) {
        pairedNet += w.netto; pairedGaeste += g;
        // vj_daily kennt kein Marketing — Netto ist ohne Maison (bekannte Grenze).
        pairedVerkauf += verkaufTagCur(w.netto, Number(rec.takeawayRevenue ?? 0));
      }
    }
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

  // Netto + F/B je Tag über vjTagWerte — identische Regel wie das laufende
  // Jahr (TA-Satz, Oliv-TA→Food, Rest 50/50). Invariante food+bev=netto.
  let vjGross = 0, vjNet = 0, vjFoodG = 0, vjBevG = 0, vjTaG = 0;
  let hatVj = false, hatVjTa = false;
  let vjPairedNet = 0, vjPairedGaeste = 0;
  for (const [date, rec] of Object.entries(vjDaily)) {
    if (date < vjFrom || date > vjTo) continue;
    const w = vjTagWerte(tenantId, rec, date);
    if (w) {
      vjGross += rec.actualRevenue!; vjNet += w.netto; hatVj = true;
      vjFoodG += w.food; vjBevG += w.beverage;
    }
    if ((rec.takeawayRevenue ?? 0) > 0) { vjTaG += rec.takeawayRevenue!; hatVjTa = true; }
    const gVj = gaesteDaily[date] ?? 0;
    if (w && gVj > 0) {
      vjPairedNet += w.netto; vjPairedGaeste += gVj;
      vjPairedVerkauf += verkaufTagCur(w.netto, Number(rec.takeawayRevenue ?? 0));
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

  // ── Cockpit-KPI-Budget des Zeitraums (pro rata über die Ist-Tage) ──────────
  // Fenster = exakt der Ist-Zeitraum [curFrom..curTo] (bei YTD/Ganzjahr bereits
  // bis heute gekappt) → periodenBudget kappt pro rata über Tagesanteile.
  const jvBudget = await loadCockpitBudget(tenantKey, curYear)
    .then(b => resolveCockpitBudgets(
      b, tenantId, curFrom, curTo, undefined,
      erNettoBudgetMonate(curYear, tenantKey('budget_v1'))))
    .catch(() => ({} as Record<string, number | null>));
  const jb = (id: string): number | null => jvBudget[id] ?? null;

  // ── Zeilen bauen (cur | vj; Δ% berechnet die UI) ───────────────────────────
  const rows: JahresvergleichRow[] = [
    { label: 'Brutto Umsatz', fmt: 'chf', bold: true,
      cur: hatUmsatz ? r2(gross) : null, vj: hatVj ? r2(vjGross) : null,
      budget: jb('brutto_umsatz') },
    { label: 'Netto Umsatz', fmt: 'chf', bold: true,
      cur: hatUmsatz ? r2(net) : null, vj: hatVj ? r2(vjNet) : null,
      budget: jb('netto_umsatz') },
    // Food-/Beverage-UMSATZ (netto) — reine IST-Aufteilung (foodBeverageSplit /
    // vjTagWerte, Invariante Food+Beverage=Netto), OHNE Budget-Position.
    { label: 'Food Umsatz (netto)', fmt: 'chf',
      cur: hatUmsatz ? r2(food) : null, vj: hatVj ? r2(vjFoodG) : null },
    { label: 'Beverage Umsatz (netto)', fmt: 'chf',
      cur: hatUmsatz ? r2(bev) : null, vj: hatVj ? r2(vjBevG) : null },
    { label: 'Gäste IN', fmt: 'count',
      cur: hatGaeste ? r2(gaeste) : null, vj: hatVjGaeste ? r2(vjGaeste) : null,
      budget: jb('gaeste_in') },
    // «Durchschnittsverkauf» bewusst entfernt (Spec 08/2026).
    // Ø-Verkauf pro Gast (ersetzt die alten Bon-Zeilen): mandantenspezifisch —
    // Beaulieu Netto÷Gäste, Oliv (Netto−TA-Netto)÷Gäste; Maison immer im
    // Zähler (unabhängig vom maisonExclude-Toggle). Nur gepaarte Tage,
    // keine Gäste → leer (nie ÷ 0).
    { label: 'Ø-Verkauf pro Gast', fmt: 'chf',
      cur: pairedGaeste > 0 ? r2(pairedVerkauf / pairedGaeste) : null,
      vj: vjPairedGaeste > 0 ? r2(vjPairedVerkauf / vjPairedGaeste) : null,
      budget: jb('avg_verkauf_gast') },
    { label: 'Take Away Anteil', fmt: 'pct',
      cur: hatUmsatz && gross > 0 && ta > 0 ? r2((ta / gross) * 100) : null,
      vj: hatVjTa && vjGross > 0 ? r2((vjTaG / vjGross) * 100) : null,
      budget: jb('take_away_anteil') },
    // Wareneinsatz: konsolidierte Budget-Position (Ist folgt im Waren-Block).
    { label: 'Wareneinsatz', fmt: 'chf', cur: null, vj: null,
      budget: jb('wareneinsatz'), deltaInverted: true },
    // EINE Stunden-Zeile (Spec 08/2026): Ist = MIRUS, Budget = Dienstplan-Plan
    // aus dem Ist-Aggregat (keine VJ-Quelle) — konsistent zur Haupttabelle.
    { label: 'Stunden — Plan (Budget) / Ist (MIRUS)', fmt: 'hours',
      cur: hatIst ? r2(istStd) : null, vj: null,   // keine VJ-Quelle
      budget: hatPlan ? r2(planStd) : null, deltaInverted: true },
    { label: 'Produktivität (Umsatz/Std)', fmt: 'chf',
      cur: hatUmsatz && hatIst && istStd > 0 ? r2(net / istStd) : null, vj: null, // keine VJ-Quelle
      budget: jb('produktivitaet') },
    { label: 'Reservierte Gäste', fmt: 'count',
      cur: resCur.reservedGuests, vj: resVj.reservedGuests,
      budget: jb('reservierte_gaeste') },
    // Gruppen: Ist = Σ PERSONEN (Einheitengleichheit mit dem gruppen_20pax-
    // Budget, das ausdrücklich in Personen definiert ist).
    { label: `Gruppen ab ${jvCounting.groupThreshold} Pax (Personen)`, fmt: 'count',
      cur: resCur.largeGroupPersons, vj: resVj.largeGroupPersons,
      budget: jb('gruppen_20pax') },
    // Rezensionen (ALLE Sternstufen 5–1, Google + Lunchgate). Ladefehler → leer;
    // VJ nur wenn dort wirklich erfasst (>0) — Quelle existiert erst seit der
    // Einzelerfassung, ein «0» im VJ wäre erfunden.
    // 2/4 Sterne ausgeblendet (kein Aufklapp-Mechanismus im Jahresvergleich).
    // Budget: Cockpit-Override (0 bleibt echter Zielwert), sonst Standardziel
    // über die Periodentage (5★ = 5/Woche, 1/3★ = 0).
    ...reviewStarRowDefs(tenantId).filter(r => !r.collapsed)
      .map(({ platform, star, id, label, tint }): JahresvergleichRow => {
        const cur = reviewSingles
          ? countReviewsByStar(reviewSingles, platform, curFrom, curTo, star) : null;
        const vjN = reviewSingles
          ? countReviewsByStar(reviewSingles, platform, vjFrom, vjTo, star) : 0;
        const pTage = Math.round((Date.parse(curTo) - Date.parse(curFrom)) / 86_400_000) + 1;
        return { label, fmt: 'count', tint, cur, vj: vjN > 0 ? vjN : null,
          budget: jb(id) ?? reviewZielBudget(star, pTage, reviewWochenrate(tenantId, platform)),
          deltaInverted: star === 1 || star === 3 };
      }),
  ];

  return { ...win, rows, modus };
}
