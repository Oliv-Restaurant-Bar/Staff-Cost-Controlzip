/**
 * import-cockpit-db.ts — Read-only Frische-Aggregator für das Import-Cockpit.
 * =========================================================================
 * Sammelt je Datenquelle ein Frische-Signal (letzter Datenstand + letzter
 * Importlauf) aus BESTEHENDEN Tabellen/Speichern. STRIKT READ-ONLY:
 *   - keine Migration, kein Schreibzugriff, keine Änderung an Importprozessen
 *   - jede Quelle wird einzeln über Promise.allSettled abgefragt; eine
 *     fehlschlagende Quelle blockiert die anderen nie (Signal bleibt dann leer)
 *   - es werden NIE Zeitstempel erfunden: fehlt ein Signal → null
 *
 * Mandantentrennung folgt exakt den bestehenden Mustern:
 *   - `actual_hours`/`schedule_entries`: über `employee_id`-Präfix `b-`
 *     (Beaulieu) bzw. NOT LIKE (Oliv) — `employees` hat KEINE `restaurant_id`
 *     (siehe supabase-db.ts loadScheduleForMonth)
 *   - Reservations-/CRM-Tabellen: eigene Spalte `restaurant_id`
 *   - KV/localStorage: über den mandantengeprefixten Schlüssel (tenantKey)
 *   - `product_sales`: KEIN restaurant_id → mandantenübergreifend (in der UI
 *     als `tenantNeutral` gekennzeichnet)
 *
 * WICHTIG (read-only): Budget/Reporting werden hier direkt aus dem
 * localStorage-Blob geparst — NIEMALS über `loadBudgetYear`, denn diese Funktion
 * seedet fehlende Jahre und schreibt dann in localStorage UND Supabase-KV.
 */

import { supabase } from '@/integrations/supabase/client';
import { kvGet } from './supabase-kv';
import { fetchLatestImportRuns } from './import-runs-db';
import { loadGnImports, fetchExtendedCoverage } from './gn-zbericht-db';
import { getImportHistoryAll, type ImportHistoryEntry } from './timesheet-store';
import {
  COCKPIT_SOURCES,
  GAP_WINDOW_DAYS,
  deriveMirusPeriodFromHistory,
  deriveMirusPeriodEndFromDays,
  umsatzabstimmungMonthsFromBlob,
  buchhaltungsExportOverride,
  computeSourceStatus,
  getCockpitSource,
  type CockpitSignal,
  type CockpitSourceId,
} from './import-cockpit';
import { adyenDaysFromBlob } from './adyen-abstimmung';
import {
  deriveExportStatus,
  exportsForMonth,
  latestExportForMonth,
  latestRelevantExportMonth,
} from './buchhaltungs-export';
import { normalizeTagesabschlussBlob } from './tagesabschluss';
import { format, addDays } from 'date-fns';

export interface CockpitFetchContext {
  /** 'oliv' | 'beaulieu' */
  tenantId: string;
  /** Mandanten-Präfixer für KV/localStorage-Schlüssel (aus useTenant). */
  tenantKey: (key: string) => string;
}

const EMPTY: CockpitSignal = { latestDataDate: null };

/** Tag-Anteil (yyyy-MM-dd) eines ISO-Timestamps. */
function dayOf(ts: string | null | undefined): string | null {
  return ts ? ts.slice(0, 10) : null;
}

/** Heutiges Datum (yyyy-MM-dd) — Obergrenze für „Ist-Daten bis" (nie Zukunft). */
function todayIso(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Fenster-Untergrenze für die Datenlücken-Prüfung (heute − Fenster − Puffer). */
function gapCutoff(): string {
  return format(addDays(new Date(), -(GAP_WINDOW_DAYS + 5)), 'yyyy-MM-dd');
}

// ─── Einzelne Quell-Signale (alle read-only) ─────────────────────────────────────

/** Reservationen: Frische = letzter Importlauf; „Daten bis" = spätestes Reservationsdatum. */
async function reservationSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const [runs, maxRes, minRes] = await Promise.all([
    fetchLatestImportRuns(ctx.tenantId),
    supabase
      .from('reservation_records')
      .select('reservation_date')
      .eq('restaurant_id', ctx.tenantId)
      .order('reservation_date', { ascending: false })
      .limit(1),
    supabase
      .from('reservation_records')
      .select('reservation_date')
      .eq('restaurant_id', ctx.tenantId)
      .order('reservation_date', { ascending: true })
      .limit(1),
  ]);
  const run = runs.reservations;
  return {
    latestDataDate: null, // Frische über Importlauf-Datum (Reservationen sind zukunftsdatiert)
    dataFrom: (minRes.data?.[0] as { reservation_date?: string } | undefined)?.reservation_date ?? null,
    dataUntil: (maxRes.data?.[0] as { reservation_date?: string } | undefined)?.reservation_date ?? null,
    recordCount: run?.record_count ?? null,
    lastImport: run
      ? { at: run.finished_at ?? run.created_at, status: run.status, by: run.created_by }
      : null,
  };
}

/** Gäste-CRM: Frische = letzter Gästeexport-Lauf; „Daten bis" = spätester Gäste-Datenstand. */
async function guestCrmSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const [runs, maxSeen] = await Promise.all([
    fetchLatestImportRuns(ctx.tenantId),
    supabase
      .from('guest_profiles')
      .select('last_seen_at')
      .eq('restaurant_id', ctx.tenantId)
      .order('last_seen_at', { ascending: false })
      .limit(1),
  ]);
  const run = runs.guest_export;
  return {
    latestDataDate: null, // Frische über Importlauf-Datum
    dataUntil: dayOf((maxSeen.data?.[0] as { last_seen_at?: string } | undefined)?.last_seen_at ?? null),
    recordCount: run?.record_count ?? null,
    lastImport: run
      ? { at: run.finished_at ?? run.created_at, status: run.status, by: run.created_by }
      : null,
  };
}

/** Gastronovi Z-Bericht: Frische = spätestes Berichtsende (period_to). */
async function zberichtSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const rows = await loadGnImports(ctx.tenantId);
  if (!rows.length) return EMPTY;
  const today = todayIso();
  const periodTos = rows.map((r) => r.period_to).filter((d): d is string => !!d).sort();
  const periodFroms = rows.map((r) => r.period_from).filter((d): d is string => !!d).sort();
  const importedAts = rows.map((r) => r.imported_at).filter(Boolean).sort();
  // Zukunft zählt nie als „Ist-Daten bis": spätestes Berichtsende ≤ heute.
  const latest = periodTos.filter((d) => d.slice(0, 10) <= today).at(-1) ?? null;
  const futureLatest = periodTos.filter((d) => d.slice(0, 10) > today).at(-1) ?? null;
  return {
    latestDataDate: latest,
    dataFrom: periodFroms[0] ?? null,
    dataUntil: latest,
    recordCount: rows.length,
    futureDataDate: futureLatest,
    lastImport: importedAts.length
      ? { at: importedAts.at(-1) ?? null, status: 'success' }
      : null,
  };
}

/** Tagesumsatz: KV-Blob `dailyBudgets` (mandantengeprefixt). Datenlücken werden erkannt. */
async function tagesumsatzSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  // KV ist der massgebliche persistente Speicher (localStorage kann abweichen).
  const raw = (await kvGet(ctx.tenantKey('dailyBudgets'))) as
    | Record<string, { actualRevenue?: number }>
    | null;
  if (!raw || typeof raw !== 'object') return EMPTY;
  const today = todayIso();
  // Nur Tage mit echtem Ist-Umsatz (> 0) zählen als importiert.
  const revenueDays = Object.entries(raw)
    .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && (v?.actualRevenue ?? 0) > 0)
    .map(([k]) => k)
    .sort();
  // Zukunft zählt nie als „Ist-Daten bis": nur Tage ≤ heute.
  const days = revenueDays.filter((d) => d <= today);
  const futureLatest = revenueDays.filter((d) => d > today).at(-1) ?? null;
  if (!days.length) return futureLatest ? { latestDataDate: null, futureDataDate: futureLatest } : EMPTY;
  const latest = days.at(-1)!;
  const cutoff = gapCutoff();
  return {
    latestDataDate: latest,
    dataFrom: days[0] ?? null,
    dataUntil: latest,
    recordCount: days.length,
    coveredDates: days.filter((d) => d >= cutoff),
    futureDataDate: futureLatest,
  };
}

/**
 * Produktverkäufe: `product_sales` (mandantenübergreifend, kein restaurant_id).
 *
 * Zusätzlich zählt die Abdeckung durch AKTIVE erweiterte Z-Berichte des
 * aktuellen Tenants (gn_extended_positions liefern dieselben Produktdaten).
 * Ist der erweiterte Datenstand mindestens so frisch wie der CSV-Import,
 * wird das sichtbar gemacht («Durch erweiterten Z-Bericht PDF abgedeckt») —
 * der Status kommt dabei weiterhin aus der ZENTRALEN Frische-Berechnung
 * (computeSourceStatus über den gemeinsamen Datenstand), keine Parallel-Logik.
 */
async function produktverkaeufeSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const today = todayIso();
  const [maxRow, minRow, futureRow, coverage] = await Promise.all([
    // Zukunft zählt nie als „Ist-Daten bis": spätestes Verkaufsdatum ≤ heute.
    supabase
      .from('product_sales')
      .select('sale_date')
      .lte('sale_date', today)
      .order('sale_date', { ascending: false })
      .limit(1),
    supabase.from('product_sales').select('sale_date').order('sale_date', { ascending: true }).limit(1),
    supabase
      .from('product_sales')
      .select('sale_date')
      .gt('sale_date', today)
      .order('sale_date', { ascending: false })
      .limit(1),
    fetchExtendedCoverage(ctx.tenantId),
  ]);
  const latest = (maxRow.data?.[0] as { sale_date?: string } | undefined)?.sale_date ?? null;
  const futureLatest = (futureRow.data?.[0] as { sale_date?: string } | undefined)?.sale_date ?? null;

  // Spätestes Bis-Datum aktiver erweiterter Z-Berichte (≤ heute, Zukunft zählt nie).
  const extUntil = coverage.ranges
    .map((r) => r.periodTo)
    .filter((d): d is string => !!d && d <= today)
    .sort()
    .at(-1) ?? null;

  const base: CockpitSignal = latest
    ? {
        latestDataDate: latest,
        dataFrom: (minRow.data?.[0] as { sale_date?: string } | undefined)?.sale_date ?? null,
        dataUntil: latest,
        futureDataDate: futureLatest,
      }
    : futureLatest
      ? { latestDataDate: null, futureDataDate: futureLatest }
      : EMPTY;

  // Erweiterte Berichte decken den Zeitraum mindestens so weit ab wie der
  // Verkaufsdaten-Import → Datenstand zusammenführen + Grund sichtbar machen.
  if (extUntil && (!latest || extUntil >= latest)) {
    const merged: CockpitSignal = {
      ...base,
      latestDataDate: extUntil > (latest ?? '') ? extUntil : latest,
      dataUntil: extUntil > (latest ?? '') ? extUntil : latest,
    };
    const def = getCockpitSource('produktverkaeufe');
    if (def) {
      // Status ZENTRAL berechnen (gleiche Frische-Schwellen), nur der Grund
      // benennt die Quelle der Abdeckung.
      const central = computeSourceStatus(def, merged);
      return {
        ...merged,
        statusOverride: {
          status: central.status,
          reason: `Durch erweiterten Z-Bericht PDF abgedeckt (Detailpositionen bis ${extUntil.split('-').reverse().join('.')}). ${central.reason}`,
        },
      };
    }
    return merged;
  }

  return base;
}

/** Gemeinsames Signal-Gerüst aus einer sortierten Liste von Tages-Daten (yyyy-MM-dd). */
function signalFromDays(
  days: string[],
  lastImportAt: string | null,
): CockpitSignal {
  const today = todayIso();
  const sorted = [...new Set(days)].sort();
  const past = sorted.filter((d) => d <= today);
  const futureLatest = sorted.filter((d) => d > today).at(-1) ?? null;
  if (!past.length) {
    return futureLatest ? { latestDataDate: null, futureDataDate: futureLatest } : EMPTY;
  }
  const latest = past.at(-1)!;
  return {
    latestDataDate: latest,
    dataFrom: sorted[0] ?? null,
    dataUntil: latest,
    recordCount: past.length,
    futureDataDate: futureLatest,
    lastImport: lastImportAt ? { at: lastImportAt, status: 'success' } : null,
  };
}

/**
 * Zeitabschnitte / Stundenumsätze: Tages-Z-Berichte (gn_imports, aktiv,
 * aggregation_level 'day') mit nicht-leerem hourlyRevenue-Abschnitt.
 * Frische = spätester Tagesbericht MIT Zeitabschnittsdaten (fehlend ≠ 0):
 * Tage ohne Abschnitt zählen bewusst nicht als abgedeckt.
 */
async function zeitabschnitteSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const { data } = await (supabase as unknown as {
    from: (t: string) => any;
  })
    .from('gn_imports')
    .select('period_from, imported_at, hourly:raw_csv_json->hourlyRevenue')
    .eq('restaurant_id', ctx.tenantId)
    .eq('status', 'active')
    .eq('aggregation_level', 'day')
    // Frische braucht nur die NEUESTEN Tage — ohne order/limit kappt PostgREST
    // bei ~1000 Zeilen in unbestimmter Reihenfolge (neueste könnten fehlen).
    .order('period_from', { ascending: false })
    .limit(1000);
  const rows = (data ?? []) as Array<{ period_from: string | null; imported_at: string | null; hourly: unknown }>;
  const days: string[] = [];
  let lastImportAt: string | null = null;
  for (const r of rows) {
    if (!r.period_from || !Array.isArray(r.hourly) || r.hourly.length === 0) continue;
    days.push(r.period_from.slice(0, 10));
    if (r.imported_at && (!lastImportAt || r.imported_at > lastImportAt)) lastImportAt = r.imported_at;
  }
  return signalFromDays(days, lastImportAt);
}

/**
 * Personen-Kennzahlen aus den Gastronovi-Auswertungs-PDFs (gn_person_imports →
 * gn_person_metrics, nur AKTIVE Importe). Frische = spätester Tag mit echtem
 * Wert (Anzahl Personen bzw. Umsatz pro Person) — leere Tageswerte zählen nie
 * (fehlend ≠ 0). Kombi-Berichte (csv_type 'personen') decken beide Kennzahlen ab.
 */
async function personMetricSignal(
  ctx: CockpitFetchContext,
  kind: 'anzahl_personen' | 'umsatz_pro_person',
): Promise<CockpitSignal> {
  const sb = supabase as unknown as { from: (t: string) => any };
  const { data: imports } = await sb
    .from('gn_person_imports')
    .select('id, created_at')
    .eq('restaurant_id', ctx.tenantId)
    .eq('status', 'active')
    .in('csv_type', [kind, 'personen']);
  const importRows = (imports ?? []) as Array<{ id: string; created_at: string | null }>;
  if (!importRows.length) return EMPTY;
  const lastImportAt = importRows
    .map((i) => i.created_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  const { data: metrics } = await sb
    .from('gn_person_metrics')
    .select('date, guests_count, revenue_per_person, metric_type')
    .in('import_id', importRows.map((i) => i.id))
    // Frische braucht nur die NEUESTEN Tage (PostgREST-Cap ~1000 Zeilen).
    .order('date', { ascending: false })
    .limit(1000);
  const days: string[] = [];
  for (const r of (metrics ?? []) as Array<{
    date: string | null;
    guests_count: number | null;
    revenue_per_person: number | null;
    metric_type: string | null;
  }>) {
    if (!r.date) continue;
    const t = r.metric_type ?? '';
    const hasValue =
      kind === 'anzahl_personen'
        ? (t === 'anzahl_personen' || t === 'personen') && typeof r.guests_count === 'number' && r.guests_count >= 0
        : (t === 'umsatz_pro_person' || t === 'personen') && typeof r.revenue_per_person === 'number' && r.revenue_per_person > 0;
    if (hasValue) days.push(r.date);
  }
  return signalFromDays(days, lastImportAt);
}

/**
 * Durchschnittsbon: gn_average_checks (business_id = Tenant). Frische =
 * spätester Tag mit Bonwert > 0 — leere Tageswerte zählen nie (fehlend ≠ 0).
 */
async function durchschnittsbonSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const { data } = await (supabase as unknown as { from: (t: string) => any })
    .from('gn_average_checks')
    .select('report_date, average_check_chf, created_at')
    .eq('business_id', ctx.tenantId)
    .not('average_check_chf', 'is', null)
    // Frische braucht nur die NEUESTEN Tage (PostgREST-Cap ~1000 Zeilen).
    .order('report_date', { ascending: false })
    .limit(1000);
  const rows = (data ?? []) as Array<{
    report_date: string | null;
    average_check_chf: number | null;
    created_at: string | null;
  }>;
  const days = rows
    .filter((r) => !!r.report_date && typeof r.average_check_chf === 'number' && r.average_check_chf > 0)
    .map((r) => r.report_date!);
  const lastImportAt = rows
    .map((r) => r.created_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  return signalFromDays(days, lastImportAt);
}

/**
 * Tenant-Filter über den `employee_id`-Präfix — identisch zum bestehenden Muster
 * in supabase-db.ts (loadScheduleForMonth). Gilt für Tabellen mit `employee_id`
 * (actual_hours, schedule_entries); `employees` hat KEINE `restaurant_id`.
 */
function applyEmployeeIdTenant<T>(q: T, tenantId: string): T {
  const query = q as unknown as {
    like: (c: string, p: string) => T;
    not: (c: string, o: string, p: string) => T;
  };
  return tenantId === 'beaulieu'
    ? query.like('employee_id', 'b-%')
    : query.not('employee_id', 'like', 'b-%');
}

/**
 * Mirus Arbeitszeiten — PERIODENBASIERT, nicht MAX(date).
 *
 * „Ist-Daten bis" ist das Ende der zuletzt erfolgreich importierten Mirus-Periode
 * aus der Import-Historie (`timesheet_import_history`, Quelle 'mirus'), NICHT das
 * späteste Einzeldatum in `actual_hours`. Damit setzen einzelne, verirrte
 * Tageszeilen (z. B. ein Datensatz vom 04.07., obwohl nur bis 30.06. importiert
 * wurde) den Stand NICHT fälschlich nach vorn.
 *
 * `actual_hours` liefert nur noch Drawer-Hinweise: der späteste ECHTE Ist-Tag
 * (`absence_type IS NULL` UND (`hours > 0` ODER `start_time` ODER `end_time`))
 * als „letzter gefundener Tagesdatensatz" (`latestRecordDate`) sowie ein
 * spätestes Zukunftsdatum (`futureDataDate`). Beide fliessen NIE in „Ist-Daten
 * bis" oder den Status ein.
 *
 * Fallback (nur wenn keine Historie): Ende des letzten Monats VOR dem laufenden
 * Monat, der echte Ist-Tage enthält. STRIKT READ-ONLY — keine Migration/Writes.
 */
async function mirusSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const applyTenant = <T>(q: T): T => applyEmployeeIdTenant(q, ctx.tenantId);
  const today = todayIso();
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const realIst = 'hours.gt.0,start_time.not.is.null,end_time.not.is.null';
  const [history, latestRow, futureRow, prevMonthRow] = await Promise.all([
    // PRIMÄR: erfolgreich importierte Mirus-Perioden (tenant-gefiltert, graceful []).
    getImportHistoryAll(ctx.tenantId, 60),
    // Drawer-Hinweis: spätester echter Ist-Tag ≤ heute (kann NACH dem Perioden-Ende liegen).
    applyTenant(
      supabase
        .from('actual_hours')
        .select('date')
        .is('absence_type', null)
        .or(realIst)
        .lte('date', today)
        .order('date', { ascending: false })
        .limit(1),
    ),
    // Reiner Zukunftshinweis: irgendeine Zeile > heute (Plan/Ferien/Zukunft).
    applyTenant(
      supabase
        .from('actual_hours')
        .select('date')
        .gt('date', today)
        .order('date', { ascending: false })
        .limit(1),
    ),
    // FALLBACK: spätester echter Ist-Tag VOR dem laufenden Monat (nur ohne Historie).
    applyTenant(
      supabase
        .from('actual_hours')
        .select('date')
        .is('absence_type', null)
        .or(realIst)
        .lt('date', firstOfMonth)
        .order('date', { ascending: false })
        .limit(1),
    ),
  ]);

  const latestRecord = (latestRow.data?.[0] as { date?: string } | undefined)?.date ?? null;
  const futureLatest = (futureRow.data?.[0] as { date?: string } | undefined)?.date ?? null;

  // 1) Primär: Periode aus der Mirus-Import-Historie.
  const period = deriveMirusPeriodFromHistory(
    (history as ImportHistoryEntry[]).map((h) => ({
      year: h.year,
      month: h.month,
      source: h.source,
      fileName: h.file_name,
      importedAt: h.created_at,
      importedCount: h.imported_count,
    })),
  );
  if (period) {
    // Teil-Import des LAUFENDEN Monats: `periodTo` (Monatsende) läge in der Zukunft.
    // „Ist-Daten bis" darf nie ein Zukunftsdatum sein → auf heute kappen und als
    // Zukunftshinweis ausweisen. (`computeSourceStatus` kappt nur bei detectGaps.)
    const cappedEnd = period.periodTo > today ? today : period.periodTo;
    const futureHint = period.periodTo > today ? period.periodTo : futureLatest;
    return {
      latestDataDate: cappedEnd,
      dataFrom: period.periodFrom,
      dataUntil: cappedEnd,
      lastImport: { at: period.importedAt, status: 'success' },
      fileName: period.fileName,
      latestRecordDate: latestRecord,
      futureDataDate: futureHint,
    };
  }

  // 2) Fallback: Perioden-Ende aus echten Ist-Tagen vor dem laufenden Monat.
  const prevMonthDay = (prevMonthRow.data?.[0] as { date?: string } | undefined)?.date ?? null;
  const fallbackEnd = prevMonthDay ? deriveMirusPeriodEndFromDays([prevMonthDay], today) : null;
  if (fallbackEnd) {
    return {
      latestDataDate: fallbackEnd,
      dataFrom: `${fallbackEnd.slice(0, 7)}-01`,
      dataUntil: fallbackEnd,
      latestRecordDate: latestRecord,
      futureDataDate: futureLatest,
    };
  }

  // 3) Keine vollständig importierte Periode ableitbar → kein Datum (never);
  //    Drawer-Hinweise (letzter gefundener Tag / Zukunft) bleiben erhalten.
  if (latestRecord || futureLatest) {
    return { latestDataDate: null, latestRecordDate: latestRecord, futureDataDate: futureLatest };
  }
  return EMPTY;
}

/** Dienstplanung: `schedule_entries`, Tenant über employee_id-Präfix. „Daten bis" = weiteste geplante Zukunft. */
async function dienstplanungSignal(ctx: CockpitFetchContext): Promise<CockpitSignal> {
  const { data } = await applyEmployeeIdTenant(
    supabase.from('schedule_entries').select('date').order('date', { ascending: false }).limit(1),
    ctx.tenantId,
  );
  const latest = (data?.[0] as { date?: string } | undefined)?.date ?? null;
  if (!latest) return EMPTY;
  return { latestDataDate: latest, dataUntil: latest };
}

/** Monatsabschluss: reporting_v1-Blob (localStorage, mandantengeprefixt) — read-only, kein Store-Aufruf. */
function monatsabschlussSignal(ctx: CockpitFetchContext): CockpitSignal {
  try {
    const rep = JSON.parse(localStorage.getItem(ctx.tenantKey('reporting_v1')) || '{}') as Record<
      string,
      { expenseCategories?: unknown[] }
    >;
    const months = Object.entries(rep)
      .filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Array.isArray(v?.expenseCategories) && (v.expenseCategories?.length ?? 0) > 0)
      .map(([k]) => k)
      .sort();
    if (!months.length) return EMPTY;
    return {
      latestDataDate: months.at(-1)!,
      dataFrom: months[0] ?? null,
      dataUntil: months.at(-1)!,
      recordCount: months.length,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Umsatzabstimmung: reporting_v1-Blob (localStorage, mandantengeprefixt) — read-only.
 * Ein Monat gilt als erledigt, sobald manuelle Werte (Bruttoumsatz ODER Take-Away)
 * erfasst sind (siehe umsatzabstimmungMonthsFromBlob). Frische = letzter gepflegter
 * Monat. KEIN Store-Aufruf (loadYear/saveMonth), keine Migration, kein Schreibpfad.
 */
function umsatzabstimmungSignal(ctx: CockpitFetchContext): CockpitSignal {
  try {
    const rep = JSON.parse(localStorage.getItem(ctx.tenantKey('reporting_v1')) || '{}') as Record<
      string,
      { grossRevenueManual?: number; takeAwayGrossManual?: number }
    >;
    const months = umsatzabstimmungMonthsFromBlob(rep);
    if (!months.length) return EMPTY;
    return {
      latestDataDate: months.at(-1)!,
      dataFrom: months[0] ?? null,
      dataUntil: months.at(-1)!,
      recordCount: months.length,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Adyen-Abgleich: adyenAbstimmung_v1-Blob (localStorage, mandantengeprefixt) — read-only.
 * Frische = letzter importierter Adyen-Tag (≤ heute). KEIN Zugriff über die
 * Save-Schicht (adyen-abstimmung-db) — nur Direkt-Read aus localStorage.
 */
function adyenSignal(ctx: CockpitFetchContext): CockpitSignal {
  try {
    const raw = JSON.parse(localStorage.getItem(ctx.tenantKey('adyenAbstimmung_v1')) || 'null') as unknown;
    const days = adyenDaysFromBlob(raw, todayIso());
    if (!days.length) return EMPTY;
    return {
      latestDataDate: days.at(-1)!,
      dataFrom: days[0] ?? null,
      dataUntil: days.at(-1)!,
      recordCount: days.length,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Buchhaltungs-Export (§11): tagesabschluss_v1-Blob (localStorage, mandanten-
 * geprefixt) — read-only, KEIN Zugriff über die Save-Schicht. Bezugsmonat =
 * jüngster Monat mit Tagesabschluss-Aktivität; Status offen/bereit/exportiert/
 * veraltet wird über `buchhaltungsExportOverride` hart auf den Cockpit-Status
 * abgebildet (Frische-Schwellen greifen hier bewusst nicht).
 */
function buchhaltungsExportSignal(ctx: CockpitFetchContext): CockpitSignal {
  try {
    const raw = JSON.parse(localStorage.getItem(ctx.tenantKey('tagesabschluss_v1')) || 'null') as unknown;
    const blob = normalizeTagesabschlussBlob(raw);
    const monthKey = latestRelevantExportMonth(blob);
    if (!monthKey) return EMPTY;
    const status = deriveExportStatus(blob, monthKey);
    const latest = latestExportForMonth(blob, monthKey);
    return {
      latestDataDate: monthKey,
      dataUntil: monthKey,
      recordCount: exportsForMonth(blob, monthKey).length,
      lastImport: latest
        ? { at: latest.exportedAt, status: 'success', by: latest.exportedBy }
        : null,
      statusOverride: buchhaltungsExportOverride(status, monthKey, latest?.version ?? null),
    };
  } catch {
    return EMPTY;
  }
}

/** Jahresbudget: budget_v1-Blob (localStorage, mandantengeprefixt) — read-only, NIEMALS loadBudgetYear. Export nur für Tests. */
export function jahresbudgetSignal(ctx: CockpitFetchContext): CockpitSignal {
  try {
    const key = ctx.tenantKey('budget_v1');
    const all = JSON.parse(localStorage.getItem(key) || '{}') as Record<
      string,
      { updatedAt?: string; deleted?: boolean }
    >;
    // Tombstones (gelöschte Jahre) zählen nicht als Datenbestand
    const years = Object.keys(all)
      .filter((k) => /^\d{4}$/.test(k) && !all[k]?.deleted)
      .sort();
    if (!years.length) return EMPTY;
    const latestYear = years.at(-1)!;
    return {
      latestDataDate: latestYear,
      dataFrom: years[0] ?? null,
      dataUntil: latestYear,
      recordCount: years.length,
      lastImport: all[latestYear]?.updatedAt ? { at: all[latestYear].updatedAt!, status: 'success' } : null,
    };
  } catch {
    return EMPTY;
  }
}

// ─── Aggregation ─────────────────────────────────────────────────────────────────

/**
 * Sammelt die Frische-Signale aller prüfbaren Quellen. Nicht prüfbare Quellen
 * (checkable=false) erhalten ein leeres Signal (computeSourceStatus liefert dann
 * `uncheckable`). Robust gegen Einzelausfälle via Promise.allSettled.
 */
export async function fetchCockpitSignals(
  ctx: CockpitFetchContext,
): Promise<Record<CockpitSourceId, CockpitSignal>> {
  const out = Object.fromEntries(COCKPIT_SOURCES.map((s) => [s.id, EMPTY])) as Record<
    CockpitSourceId,
    CockpitSignal
  >;

  const jobs: Array<{ id: CockpitSourceId; run: () => Promise<CockpitSignal> | CockpitSignal }> = [
    { id: 'reservationen', run: () => reservationSignal(ctx) },
    { id: 'gaeste_crm', run: () => guestCrmSignal(ctx) },
    { id: 'zbericht', run: () => zberichtSignal(ctx) },
    { id: 'tagesumsatz', run: () => tagesumsatzSignal(ctx) },
    { id: 'produktverkaeufe', run: () => produktverkaeufeSignal(ctx) },
    { id: 'zeitabschnitte', run: () => zeitabschnitteSignal(ctx) },
    { id: 'anzahl_personen', run: () => personMetricSignal(ctx, 'anzahl_personen') },
    { id: 'umsatz_pro_person', run: () => personMetricSignal(ctx, 'umsatz_pro_person') },
    { id: 'durchschnittsbon', run: () => durchschnittsbonSignal(ctx) },
    { id: 'mirus', run: () => mirusSignal(ctx) },
    { id: 'dienstplanung', run: () => dienstplanungSignal(ctx) },
    { id: 'umsatzabstimmung', run: () => umsatzabstimmungSignal(ctx) },
    { id: 'adyen', run: () => adyenSignal(ctx) },
    { id: 'monatsabschluss', run: () => monatsabschlussSignal(ctx) },
    { id: 'buchhaltungs_export', run: () => buchhaltungsExportSignal(ctx) },
    { id: 'jahresbudget', run: () => jahresbudgetSignal(ctx) },
  ];

  const results = await Promise.allSettled(jobs.map((j) => Promise.resolve(j.run())));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      out[jobs[i].id] = res.value;
    } else {
      console.warn(`[import-cockpit] Signal für "${jobs[i].id}" fehlgeschlagen:`, res.reason);
    }
  });

  return out;
}

/** Kleiner Helfer: „vor N Tagen"-Datum (für UI-Fensteranzeigen). */
export function daysAgoIso(days: number): string {
  return format(addDays(new Date(), -days), 'yyyy-MM-dd');
}
