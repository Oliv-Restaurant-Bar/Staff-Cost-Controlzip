/**
 * import-tasks-db.ts — Monats-Abdeckung für die Import-Checkliste (read-only)
 * ===========================================================================
 * Liefert pro Importtyp die Abdeckung (`MonthCoverage`) des gewählten Monats
 * als Input für die reine Engine (import-tasks-engine.ts).
 *
 * STRIKT READ-ONLY: keine Migration, kein Schreibzugriff, keine Änderung an
 * Importprozessen. Jede Quelle wird einzeln über Promise.allSettled abgefragt;
 * ein Fehler einer Quelle wird als sichtbare `error`-Coverage ausgewiesen
 * (Fehler-Aufgabe in der Checkliste) und blockiert die anderen Quellen nie.
 *
 * Mandantentrennung folgt exakt den bestehenden Mustern (s. import-cockpit-db):
 *   - reservation_records / import_runs: Spalte `restaurant_id`
 *   - actual_hours: `employee_id`-Präfix `b-` (Beaulieu) bzw. NOT LIKE (Oliv)
 *   - KV/localStorage-Blobs: mandantengeprefixter Schlüssel (tenantKey)
 *   - product_sales: KEIN restaurant_id → mandantenübergreifend (UI weist
 *     darauf hin)
 *   - sage_journal_v1_*: globaler Schlüssel OHNE Tenant-Präfix (bestehendes
 *     Verhalten von reporting-store.ts — nicht ändern)
 *
 * WICHTIG: Budget/Reporting werden direkt aus den Blobs gelesen — NIEMALS über
 * `loadBudgetYear`/`loadYear`-Seeds, die localStorage/KV beschreiben würden.
 */

import { supabase } from '@/integrations/supabase/client';
import { kvGet } from './supabase-kv';
import { loadGnImports } from './gn-zbericht-db';
import { getImportHistoryAll, type ImportHistoryEntry } from './timesheet-store';
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

/** Schnitt eines Zeitraums mit dem Monat als Tages-Liste (leer wenn disjunkt). */
function rangeDaysInMonth(
  from: string | null,
  to: string | null,
  monthStart: string,
  monthEnd: string,
): string[] {
  if (!from || !to) return [];
  const f = from.slice(0, 10);
  const t = to.slice(0, 10);
  if (t < monthStart || f > monthEnd) return [];
  return listDays(f > monthStart ? f : monthStart, t < monthEnd ? t : monthEnd);
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
 * product_sales, actual_hours) brauchen deshalb Seiten-Schleifen.
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

/** Z-Bericht: gn_imports-Perioden, die den Monat schneiden (Tag = from===to). */
async function zberichtCoverage(
  ctx: ImportTasksFetchContext,
  monthStart: string,
  monthEnd: string,
): Promise<TypeCoverage> {
  const rows = await loadGnImports(ctx.tenantId);
  const covered = new Set<string>();
  let lastImportAt: string | null = null;
  for (const row of rows) {
    for (const d of rangeDaysInMonth(row.period_from, row.period_to, monthStart, monthEnd)) {
      covered.add(d);
    }
    if (row.imported_at && (!lastImportAt || row.imported_at > lastImportAt)) {
      lastImportAt = row.imported_at;
    }
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/**
 * Foratable/Reservationen: Tage mit Reservationsdaten im Monat VEREINIGT mit
 * den Perioden erfolgreicher Importläufe (import_runs). Die Läufe zählen auch
 * Tage ohne Reservationen (Ruhetage) als abgedeckt, sofern die importierte
 * Datei den Zeitraum umfasste.
 */
async function reservationenCoverage(
  ctx: ImportTasksFetchContext,
  monthStart: string,
  monthEnd: string,
): Promise<TypeCoverage> {
  const [recordDays, runsRes] = await Promise.all([
    fetchDistinctDates(
      (from, to) =>
        sb
          .from('reservation_records')
          .select('reservation_date')
          .eq('restaurant_id', ctx.tenantId)
          .gte('reservation_date', monthStart)
          .lte('reservation_date', monthEnd)
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
      .lte('period_from', monthEnd)
      .gte('period_to', monthStart),
  ]);
  if (runsRes.error) throw new Error(runsRes.error.message);
  const covered = new Set<string>(recordDays);
  let lastImportAt: string | null = null;
  for (const run of (runsRes.data ?? []) as Array<{
    period_from?: string | null; period_to?: string | null; finished_at?: string | null;
  }>) {
    for (const d of rangeDaysInMonth(run.period_from ?? null, run.period_to ?? null, monthStart, monthEnd)) {
      covered.add(d);
    }
    if (run.finished_at && (!lastImportAt || run.finished_at > lastImportAt)) {
      lastImportAt = run.finished_at;
    }
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/** Umsatz: dailyBudgets-KV — Tage im Monat mit echtem Ist-Umsatz (> 0). */
async function umsatzCoverage(
  ctx: ImportTasksFetchContext,
  monthStart: string,
  monthEnd: string,
): Promise<TypeCoverage> {
  const raw = (await kvGet(ctx.tenantKey('dailyBudgets'))) as
    | Record<string, { actualRevenue?: number }>
    | null;
  if (!raw || typeof raw !== 'object') return { coveredDays: [] };
  const days = Object.entries(raw)
    .filter(([k, v]) => RE_DAY.test(k) && k >= monthStart && k <= monthEnd && (v?.actualRevenue ?? 0) > 0)
    .map(([k]) => k)
    .sort();
  return { coveredDays: days };
}

/** Verkaufsdaten: product_sales.sale_date im Monat (mandantenübergreifend!). */
async function verkaufsdatenCoverage(monthStart: string, monthEnd: string): Promise<TypeCoverage> {
  const days = await fetchDistinctDates(
    (from, to) =>
      sb
        .from('product_sales')
        .select('sale_date')
        .gte('sale_date', monthStart)
        .lte('sale_date', monthEnd)
        .order('sale_date', { ascending: true })
        .range(from, to),
    'sale_date',
  );
  return { coveredDays: [...days].sort() };
}

/**
 * Mirus Stunden: primär die Import-Historie (`timesheet_import_history`) —
 * ein erfolgreicher Lauf für (Jahr, Monat) deckt den ganzen Monat ab.
 * Zusätzlich zählen echte Ist-Tage in `actual_hours` (Teilimporte).
 */
async function mirusCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
  monthStart: string,
  monthEnd: string,
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
            .gte('date', monthStart)
            .lte('date', monthEnd)
            .order('date', { ascending: true })
            .range(from, to),
          ctx.tenantId,
        ),
      'date',
    ),
  ]);
  const entries = (history as ImportHistoryEntry[]).filter(
    (h) =>
      h.year === year &&
      h.month === month &&
      (h.source == null || h.source === 'mirus') &&
      (h.imported_count == null || h.imported_count > 0),
  );
  const covered = new Set<string>(istDays);
  let lastImportAt: string | null = null;
  if (entries.length > 0) {
    // Monat als Ganzes importiert → alle Tage abgedeckt.
    for (const d of listDays(monthStart, monthEnd)) covered.add(d);
    lastImportAt = entries
      .map((e) => e.created_at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  }
  return { coveredDays: [...covered].sort(), lastImportAt };
}

/** Marketing Umsatz: maison-daily-Blob (KV primär, localStorage-Fallback) — read-only. */
async function marketingCoverage(
  ctx: ImportTasksFetchContext,
  monthStart: string,
  monthEnd: string,
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
    .filter((k) => RE_DAY.test(k) && k >= monthStart && k <= monthEnd)
    .sort();
  return { coveredDays: days };
}

/** Erfolgsrechnung: reporting_v1-Blob — Monat erledigt, wenn expenseCategories befüllt. */
function erfolgsrechnungCoverage(ctx: ImportTasksFetchContext, year: number, month: number): TypeCoverage {
  try {
    const rep = JSON.parse(localStorage.getItem(ctx.tenantKey('reporting_v1')) || '{}') as Record<
      string,
      { expenseCategories?: unknown[] }
    >;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const rec = rep[key];
    const done = Array.isArray(rec?.expenseCategories) && (rec?.expenseCategories?.length ?? 0) > 0;
    return { monthDone: done };
  } catch {
    return { monthDone: false };
  }
}

/**
 * IST-Kosten Buchhaltung: sage_journal_v1_{year}_{MM} (Monat zero-padded,
 * globaler Schlüssel OHNE Tenant-Präfix — bestehendes reporting-store-Muster).
 * localStorage primär, KV-Fallback (read-only, keine Migration anstossen).
 */
async function istkostenCoverage(year: number, month: number): Promise<TypeCoverage> {
  const key = `sage_journal_v1_${year}_${String(month).padStart(2, '0')}`;
  try {
    const local = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(local) && local.length > 0) return { monthDone: true };
  } catch {
    /* weiter mit KV */
  }
  try {
    const remote = await kvGet(key);
    return { monthDone: Array.isArray(remote) && remote.length > 0 };
  } catch {
    return { monthDone: false };
  }
}

/** Budget: budget_v1-Blob — Jahr erledigt, wenn der Jahres-Key existiert. NIEMALS loadBudgetYear (seedet). */
function budgetCoverage(ctx: ImportTasksFetchContext, year: number): TypeCoverage {
  try {
    const all = JSON.parse(localStorage.getItem(ctx.tenantKey('budget_v1')) || '{}') as Record<
      string,
      { updatedAt?: string }
    >;
    const rec = all[String(year)];
    return {
      yearDone: rec != null,
      lastImportAt: rec?.updatedAt ?? null,
    };
  } catch {
    return { yearDone: false };
  }
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Abdeckung aller Importtypen für den gewählten Monat. Fehler einzelner
 * Quellen werden als sichtbare `error`-Coverage ausgewiesen (kein stilles
 * Verschlucken, keine Blockade der übrigen Quellen).
 */
export async function fetchMonthCoverage(
  ctx: ImportTasksFetchContext,
  year: number,
  month: number,
): Promise<MonthCoverage> {
  const monthStart = monthStartIso(year, month);
  const monthEnd = monthEndIso(year, month);

  const jobs: Array<{ type: ImportTaskType; run: () => Promise<TypeCoverage> | TypeCoverage }> = [
    { type: 'zbericht', run: () => zberichtCoverage(ctx, monthStart, monthEnd) },
    { type: 'reservationen', run: () => reservationenCoverage(ctx, monthStart, monthEnd) },
    { type: 'umsatz', run: () => umsatzCoverage(ctx, monthStart, monthEnd) },
    { type: 'verkaufsdaten', run: () => verkaufsdatenCoverage(monthStart, monthEnd) },
    { type: 'mirus', run: () => mirusCoverage(ctx, year, month, monthStart, monthEnd) },
    { type: 'marketing', run: () => marketingCoverage(ctx, monthStart, monthEnd) },
    { type: 'erfolgsrechnung', run: () => erfolgsrechnungCoverage(ctx, year, month) },
    { type: 'istkosten', run: () => istkostenCoverage(year, month) },
    { type: 'budget', run: () => budgetCoverage(ctx, year) },
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
