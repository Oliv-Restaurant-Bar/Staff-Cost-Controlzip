/**
 * import-tasks-db.ts — Monats-Abdeckung für die Import-Aufgaben (read-only)
 * =========================================================================
 * Liefert pro Importtyp die Abdeckung (`MonthCoverage`) des gewählten Monats
 * als Input für die reine Engine (import-tasks-engine.ts).
 *
 * STRIKT READ-ONLY: keine Migration, kein Schreibzugriff, keine Änderung an
 * Importprozessen. Jede Quelle wird einzeln über Promise.allSettled abgefragt;
 * ein Fehler einer Quelle wird als sichtbare `error`-Coverage ausgewiesen
 * (Fehler-Aufgabe im Cockpit) und blockiert die anderen Quellen nie.
 *
 * LOADER-VERTRAG (Engine): Tages-Coverage (`coveredDays`) umfasst den Bereich
 * [Monatserster − 6 Tage, Monatsende] — die 6 Vortage braucht die Engine für
 * Monats-übergreifende WOCHEN-Aufgaben (eine Woche gehört zum Monat ihres
 * Sonntags, ihr Montag kann im Vormonat liegen).
 *
 * Mandantentrennung folgt exakt den bestehenden Mustern (s. import-cockpit-db):
 *   - reservation_records / import_runs / gn_person_imports: `restaurant_id`
 *   - gn_average_checks: `business_id`
 *   - actual_hours: `employee_id`-Präfix `b-` (Beaulieu) bzw. NOT LIKE (Oliv)
 *   - KV/localStorage-Blobs: mandantengeprefixter Schlüssel (tenantKey)
 *   - supplier_docs_v1 (Warenrechnungen): globaler localStorage-Schlüssel OHNE
 *     Tenant-Präfix (bestehendes Verhalten des Stores — nicht ändern)
 *   - sage_journal_v1_*: globaler Schlüssel OHNE Tenant-Präfix (bestehendes
 *     Verhalten von reporting-store.ts — nicht ändern)
 */

import { supabase } from '@/integrations/supabase/client';
import { kvGet } from './supabase-kv';
import { loadGnImports } from './gn-zbericht-db';
import { getImportHistoryAll, type ImportHistoryEntry } from './timesheet-store';
import { loadDocumentsForMonth } from './supplier-documents-store';
import { isInventurDone, type InventurChecksBlob } from './import-settings';
import { loadInventurChecks } from './import-settings-db';
import type { TenantId } from '@/contexts/TenantContext';
import {
  addDaysIso,
  monthStartIso,
  monthEndIso,
  TASK_TYPE_DEFS,
  type ImportTaskType,
  type MonthCoverage,
  type TypeCoverage,
} from './import-tasks-engine';

export interface ImportTasksFetchContext {
  /** 'oliv' | 'beaulieu' */
  tenantId: string;
  /** Mandanten-Präfixer für KV/localStorage-Schlüssel (aus useTenant). */
  tenantKey: (key: string) => string;
}

const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Vorlauf-Tage vor dem Monatsersten (Wochen-Aufgaben, Loader-Vertrag). */
export const COVERAGE_LEAD_DAYS = 6;

/**
 * Einige Tabellen (import_runs, actual_hours, …) fehlen in den generierten
 * Supabase-Typen — bestehendes Muster im Projekt (s. import-runs-db,
 * gn-zbericht-db): Zugriff über einen untypisierten Client-Alias.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

interface DateQueryResult {
  data: Array<Record<string, unknown>> | null;
  error: { message?: string } | null;
}

/** Alle Tage in [from, to] (inklusive) als yyyy-MM-dd. */
function listDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** Schnitt eines Zeitraums mit dem Ladefenster als Tages-Liste (leer wenn disjunkt). */
function rangeDaysInWindow(
  from: string | null,
  to: string | null,
  windowStart: string,
  windowEnd: string,
): string[] {
  if (!from || !to) return [];
  const f = from.slice(0, 10);
  const t = to.slice(0, 10);
  if (t < windowStart || f > windowEnd) return [];
  return listDays(f > windowStart ? f : windowStart, t < windowEnd ? t : windowEnd);
}

/**
 * Tenant-Filter über den `employee_id`-Präfix — identisch zum bestehenden
 * Muster in supabase-db.ts / import-cockpit-db.ts.
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
 * Paginierter Abruf einer Datumsspalte (dedupliziert) — Supabase liefert
 * maximal ~1000 Zeilen pro Request; Monate mit vielen Zeilen (z. B.
 * actual_hours) brauchen deshalb Seiten-Schleifen.
 */
async function fetchDistinctDates(
  buildQuery: (fromIdx: number, toIdx: number) => PromiseLike<DateQueryResult>,
  column: string,
): Promise<Set<string>> {
  const PAGE = 1000;
  const days = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const { data, error } = await buildQuery(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message ?? 'Datenbank-Fehler');
    const rows = data ?? [];
    for (const row of rows) {
      const v = row[column];
      if (typeof v === 'string' && v.length >= 10) days.add(v.slice(0, 10));
    }
    if (rows.length < PAGE) break;
  }
  return days;
}

// ─── Einzelne Coverage-Fetches (alle read-only) ──────────────────────────────

/** Z-Bericht: gn_imports-Perioden, die das Ladefenster schneiden (Tag = from===to). */
async function zberichtCoverage(
  ctx: ImportTasksFetchContext,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  const rows = await loadGnImports(ctx.tenantId);
  const covered = new Set<string>();
  let lastImportAt: string | null = null;
  for (const row of rows) {
    for (const d of rangeDaysInWindow(row.period_from, row.period_to, windowStart, windowEnd)) {
      covered.add(d);
    }
    if (row.imported_at && (!lastImportAt || row.imported_at > lastImportAt)) {
      lastImportAt = row.imported_at;
    }
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/**
 * Gäste & Bonanalyse: SCHNITT der drei Gastronovi-KPI-Quellen — ein Tag gilt
 * erst als abgedeckt, wenn ALLE drei Berichte (Anzahl Personen, Umsatz pro
 * Person, Durchschnittsbon) einen echten Wert für ihn liefern (fehlend ≠ 0).
 * Prädikate identisch zu import-cockpit-db (personMetricSignal /
 * durchschnittsbonSignal) — keine Zweitdefinition der Wertigkeit.
 */
async function gaesteBonCoverage(
  ctx: ImportTasksFetchContext,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  const importsRes = await sb
    .from('gn_person_imports')
    .select('id, created_at, csv_type')
    .eq('restaurant_id', ctx.tenantId)
    .eq('status', 'active')
    .in('csv_type', ['anzahl_personen', 'umsatz_pro_person', 'personen']);
  if (importsRes.error) throw new Error(importsRes.error.message);
  const importRows = (importsRes.data ?? []) as Array<{ id: string; created_at: string | null }>;

  const personDays = new Set<string>();
  const revenueDays = new Set<string>();
  let lastImportAt: string | null = importRows
    .map((i) => i.created_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;

  if (importRows.length > 0) {
    await fetchDistinctDatesMulti(
      (from, to) =>
        sb
          .from('gn_person_metrics')
          .select('date, guests_count, revenue_per_person, metric_type')
          .in('import_id', importRows.map((i) => i.id))
          .gte('date', windowStart)
          .lte('date', windowEnd)
          .order('date', { ascending: true })
          .range(from, to),
      (row) => {
        const date = typeof row.date === 'string' ? row.date.slice(0, 10) : null;
        if (!date) return;
        const t = typeof row.metric_type === 'string' ? row.metric_type : '';
        if ((t === 'anzahl_personen' || t === 'personen')
          && typeof row.guests_count === 'number' && row.guests_count >= 0) {
          personDays.add(date);
        }
        if ((t === 'umsatz_pro_person' || t === 'personen')
          && typeof row.revenue_per_person === 'number' && row.revenue_per_person > 0) {
          revenueDays.add(date);
        }
      },
    );
  }

  const checkRes = await sb
    .from('gn_average_checks')
    .select('report_date, average_check_chf, created_at')
    .eq('business_id', ctx.tenantId)
    .not('average_check_chf', 'is', null)
    .gte('report_date', windowStart)
    .lte('report_date', windowEnd)
    .order('report_date', { ascending: true })
    .limit(1000);
  if (checkRes.error) throw new Error(checkRes.error.message);
  const bonDays = new Set<string>();
  for (const r of (checkRes.data ?? []) as Array<{
    report_date: string | null; average_check_chf: number | null; created_at: string | null;
  }>) {
    if (r.report_date && typeof r.average_check_chf === 'number' && r.average_check_chf > 0) {
      bonDays.add(r.report_date.slice(0, 10));
    }
    if (r.created_at && (!lastImportAt || r.created_at > lastImportAt)) lastImportAt = r.created_at;
  }

  const covered = [...personDays].filter((d) => revenueDays.has(d) && bonDays.has(d)).sort();
  return { coveredDays: covered, lastImportAt };
}

/** Paginierte Abfrage mit Zeilen-Callback (für Mehrspalten-Prädikate). */
async function fetchDistinctDatesMulti(
  buildQuery: (fromIdx: number, toIdx: number) => PromiseLike<DateQueryResult>,
  onRow: (row: Record<string, unknown>) => void,
): Promise<void> {
  const PAGE = 1000;
  for (let page = 0; page < 50; page++) {
    const { data, error } = await buildQuery(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message ?? 'Datenbank-Fehler');
    const rows = data ?? [];
    for (const row of rows) onRow(row);
    if (rows.length < PAGE) break;
  }
}

/**
 * Foratable/Reservationen: Tage mit Reservationsdaten VEREINIGT mit den
 * Perioden erfolgreicher Importläufe (import_runs). Die Läufe zählen auch
 * Tage ohne Reservationen (Ruhetage) als abgedeckt, sofern die importierte
 * Datei den Zeitraum umfasste.
 */
async function reservationenCoverage(
  ctx: ImportTasksFetchContext,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  const [recordDays, runsRes] = await Promise.all([
    fetchDistinctDates(
      (from, to) =>
        sb
          .from('reservation_records')
          .select('reservation_date')
          .eq('restaurant_id', ctx.tenantId)
          .gte('reservation_date', windowStart)
          .lte('reservation_date', windowEnd)
          .order('reservation_date', { ascending: true })
          .range(from, to),
      'reservation_date',
    ),
    sb
      .from('import_runs')
      .select('period_from, period_to, finished_at')
      .eq('restaurant_id', ctx.tenantId)
      .eq('import_type', 'reservations')
      .eq('status', 'success')
      .lte('period_from', windowEnd)
      .gte('period_to', windowStart),
  ]);
  if (runsRes.error) throw new Error(runsRes.error.message);
  const covered = new Set<string>(recordDays);
  let lastImportAt: string | null = null;
  for (const run of (runsRes.data ?? []) as Array<{
    period_from?: string | null; period_to?: string | null; finished_at?: string | null;
  }>) {
    for (const d of rangeDaysInWindow(run.period_from ?? null, run.period_to ?? null, windowStart, windowEnd)) {
      covered.add(d);
    }
    if (run.finished_at && (!lastImportAt || run.finished_at > lastImportAt)) {
      lastImportAt = run.finished_at;
    }
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/**
 * Mirus Stunden: primär die Import-Historie (`timesheet_import_history`) —
 * ein erfolgreicher Lauf für (Jahr, Monat) deckt den ganzen Monat ab (auch
 * für den VORMONAT im 6-Tage-Vorlauf des Ladefensters). Zusätzlich zählen
 * echte Ist-Tage in `actual_hours` (Teilimporte).
 */
async function mirusCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  const realIst = 'hours.gt.0,start_time.not.is.null,end_time.not.is.null';
  const [history, istDays] = await Promise.all([
    getImportHistoryAll(ctx.tenantId, 60),
    fetchDistinctDates(
      (from, to) =>
        applyEmployeeIdTenant(
          sb
            .from('actual_hours')
            .select('date')
            .is('absence_type', null)
            .or(realIst)
            .gte('date', windowStart)
            .lte('date', windowEnd)
            .order('date', { ascending: true })
            .range(from, to),
          ctx.tenantId,
        ),
      'date',
    ),
  ]);
  const monthStart = monthStartIso(year, month);
  const monthEnd = monthEndIso(year, month);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  const matches = (h: ImportHistoryEntry, y: number, m: number) =>
    h.year === y && h.month === m &&
    (h.source == null || h.source === 'mirus') &&
    (h.imported_count == null || h.imported_count > 0);

  const covered = new Set<string>(istDays);
  let lastImportAt: string | null = null;
  const entries = (history as ImportHistoryEntry[]).filter((h) => matches(h, year, month));
  if (entries.length > 0) {
    for (const d of listDays(monthStart, monthEnd)) covered.add(d);
    lastImportAt = entries
      .map((e) => e.created_at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  }
  // Vorlauf-Tage (Vormonat) über die Vormonats-Historie abdecken.
  if (windowStart < monthStart &&
    (history as ImportHistoryEntry[]).some((h) => matches(h, prevYear, prevMonth))) {
    for (const d of listDays(windowStart, addDaysIso(monthStart, -1))) covered.add(d);
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/**
 * Tagesabschluss: bestätigte Tage aus dem Adyen-Abstimmungs-Blob
 * (`adyenAbstimmung_v1`, tenant-präfixiert) — ein Tag gilt als erledigt,
 * wenn «Abschluss geprüft» gesetzt ist (confirmations[date].confirmed).
 * localStorage primär, KV best-effort dazu-VEREINIGT (read-only, kein Write).
 */
async function tagesabschlussCoverage(
  ctx: ImportTasksFetchContext,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  const covered = new Set<string>();
  const collect = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const conf = (raw as { confirmations?: unknown }).confirmations;
    if (!conf || typeof conf !== 'object' || Array.isArray(conf)) return;
    for (const [date, entry] of Object.entries(conf as Record<string, unknown>)) {
      if (!RE_DAY.test(date) || date < windowStart || date > windowEnd) continue;
      if (entry && typeof entry === 'object' && (entry as { confirmed?: unknown }).confirmed === true) {
        covered.add(date);
      }
    }
  };
  try {
    collect(JSON.parse(localStorage.getItem(ctx.tenantKey('adyenAbstimmung_v1')) || 'null'));
  } catch {
    /* lokal nicht lesbar — KV unten */
  }
  try {
    collect(await kvGet(ctx.tenantKey('adyenAbstimmung_v1')));
  } catch {
    /* best-effort: lokaler Stand reicht */
  }
  return { coveredDays: [...covered].sort() };
}

/** Marketing Umsatz: maison-daily-Blob (KV primär, localStorage-Fallback) — read-only. */
async function marketingCoverage(
  ctx: ImportTasksFetchContext,
  windowStart: string,
  windowEnd: string,
): Promise<TypeCoverage> {
  let blob: Record<string, number> | null = null;
  try {
    const remote = await kvGet(ctx.tenantKey('maison-daily'));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      blob = remote as Record<string, number>;
    }
  } catch {
    /* Fallback unten */
  }
  if (!blob) {
    try {
      const raw = JSON.parse(localStorage.getItem(ctx.tenantKey('maison-daily')) || '{}');
      blob = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      blob = {};
    }
  }
  const days = Object.keys(blob)
    .filter((k) => RE_DAY.test(k) && k >= windowStart && k <= windowEnd)
    .sort();
  return { coveredDays: days };
}

/**
 * Erfolgsrechnung IST (verschmilzt den früheren Typ «istkosten»): Monat
 * erledigt, wenn Kostenkategorien im reporting_v1-Blob befüllt sind ODER ein
 * Sage-Journal für den Monat vorliegt (sage_journal_v1_*, globaler Schlüssel
 * OHNE Tenant-Präfix — bestehendes reporting-store-Muster; localStorage
 * primär, KV-Fallback; read-only, keine Migration anstossen).
 */
async function erfolgsrechnungCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
): Promise<TypeCoverage> {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const rep = JSON.parse(localStorage.getItem(ctx.tenantKey('reporting_v1')) || '{}') as Record<
      string,
      { expenseCategories?: unknown[] }
    >;
    const rec = rep[key];
    if (Array.isArray(rec?.expenseCategories) && (rec?.expenseCategories?.length ?? 0) > 0) {
      return { monthDone: true };
    }
  } catch {
    /* weiter mit Sage-Journal */
  }
  const sageKey = `sage_journal_v1_${year}_${String(month).padStart(2, '0')}`;
  try {
    const local = JSON.parse(localStorage.getItem(sageKey) ?? '[]');
    if (Array.isArray(local) && local.length > 0) return { monthDone: true };
  } catch {
    /* weiter mit KV */
  }
  try {
    const remote = await kvGet(sageKey);
    return { monthDone: Array.isArray(remote) && remote.length > 0 };
  } catch {
    return { monthDone: false };
  }
}

/**
 * Warenrechnungen: supplier_docs_v1 (globaler localStorage-Store OHNE
 * Tenant-Präfix — bestehendes Verhalten, UI weist darauf hin). Monat gilt
 * als erledigt, sobald mindestens ein Beleg für den Monat erfasst ist.
 */
function warenrechnungenCoverage(year: number, month: number): TypeCoverage {
  const docs = loadDocumentsForMonth(year, month);
  if (docs.length === 0) return { monthDone: false };
  const lastImportAt = docs
    .map((d) => d.updatedAt ?? d.createdAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  return { monthDone: true, lastImportAt };
}

/** Inventur: manuelles Monats-Häkchen (inventur_checks_v1, tenant-präfixiert). */
async function inventurCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
): Promise<TypeCoverage> {
  const blob: InventurChecksBlob = await loadInventurChecks(ctx.tenantId as TenantId);
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const entry = blob[key];
  return {
    monthDone: isInventurDone(blob, key),
    lastImportAt: entry && !entry.deleted ? entry.updatedAt : null,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Abdeckung aller Importtypen für den gewählten Monat. Fehler einzelner
 * Quellen werden als sichtbare `error`-Coverage ausgewiesen (kein stilles
 * Verschlucken, keine Blockade der übrigen Quellen). Tages-Coverage umfasst
 * zusätzlich die 6 Tage vor dem Monatsersten (Wochen-Aufgaben, s. o.).
 */
export async function fetchMonthCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
): Promise<MonthCoverage> {
  const monthStart = monthStartIso(year, month);
  const monthEnd = monthEndIso(year, month);
  const windowStart = addDaysIso(monthStart, -COVERAGE_LEAD_DAYS);

  const jobs: Array<{ type: ImportTaskType; run: () => Promise<TypeCoverage> | TypeCoverage }> = [
    { type: 'zbericht', run: () => zberichtCoverage(ctx, windowStart, monthEnd) },
    { type: 'gaeste_bon', run: () => gaesteBonCoverage(ctx, windowStart, monthEnd) },
    { type: 'mirus', run: () => mirusCoverage(ctx, year, month, windowStart, monthEnd) },
    { type: 'tagesabschluss', run: () => tagesabschlussCoverage(ctx, windowStart, monthEnd) },
    { type: 'marketing', run: () => marketingCoverage(ctx, windowStart, monthEnd) },
    { type: 'reservationen', run: () => reservationenCoverage(ctx, windowStart, monthEnd) },
    { type: 'erfolgsrechnung', run: () => erfolgsrechnungCoverage(ctx, year, month) },
    { type: 'warenrechnungen', run: () => warenrechnungenCoverage(year, month) },
    { type: 'inventur', run: () => inventurCoverage(ctx, year, month) },
  ];

  const results = await Promise.allSettled(jobs.map((j) => Promise.resolve(j.run())));
  const coverage: MonthCoverage = {};
  results.forEach((res, i) => {
    const type = jobs[i].type;
    if (res.status === 'fulfilled') {
      coverage[type] = res.value;
    } else {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      console.warn(`[import-tasks] Abdeckung für "${type}" fehlgeschlagen:`, res.reason);
      coverage[type] = { error: msg || 'Unbekannter Fehler' };
    }
  });

  // Defensive Vollständigkeit: jeder definierte Typ hat einen Coverage-Eintrag.
  for (const def of TASK_TYPE_DEFS) {
    if (!coverage[def.type]) coverage[def.type] = {};
  }
  return coverage;
}

// ─── Mehr-Monats-Abdeckung (Fortschritt pro Monat, lazy) ─────────────────────

export interface MonthRef {
  year: number;
  /** 1–12 */
  month: number;
}

/**
 * Abdeckung mehrerer Monate mit begrenzter Parallelität (read-only, gleiche
 * Fetches wie `fetchMonthCoverage`). Ergebnis-Schlüssel: `yyyy-MM`.
 * `null` = Monat konnte GAR nicht geladen werden (sichtbar machen, nie still
 * verschlucken); Fehler einzelner Quellen stecken bereits als error-Coverage
 * IM MonthCoverage-Objekt.
 */
export async function fetchCoverageForMonths(
  ctx: ImportTasksFetchContext,
  months: readonly MonthRef[],
  concurrency = 3,
): Promise<Record<string, MonthCoverage | null>> {
  const result: Record<string, MonthCoverage | null> = {};
  const queue = [...months];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      try {
        result[key] = await fetchMonthCoverage(ctx, m.year, m.month);
      } catch (err) {
        console.warn(`[import-tasks] Monats-Abdeckung ${key} fehlgeschlagen:`, err);
        result[key] = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, months.length)) }, worker),
  );
  return result;
}
