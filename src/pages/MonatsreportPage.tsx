/**
 * Monatsreport — zentrales Meeting-Cockpit (Startseite)
 * Etappe 1: automatisch füllbare Zeilen + Excel-Export.
 * Spalten: Kennzahl | Budget | Vorjahr | Woche | +/- in % | Monat | +/- in %
 * Fehlende Quellen bleiben leer (nie 0). Bestehende Seiten bleiben erreichbar.
 */
import { useEffect, useMemo, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { ChevronLeft, ChevronRight, FileSpreadsheet, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import {
  ladeMonatsreport, ladeWochenverlauf,
  type MonatsreportDaten, type MrRow, type WeekSelection, type WochenverlaufDaten,
} from '@/lib/monatsreport';
import { exportMonatsreportXlsx } from '@/lib/monatsreport-export';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** ISO-Kalenderwoche + ISO-Wochenjahr eines Datums (Mo=Wochenanfang). */
function isoWeekOf(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mo=0
  t.setUTCDate(t.getUTCDate() - day + 3); // Donnerstag dieser Woche = ISO-Wochenjahr
  const weekYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { week, year: weekYear };
}

interface KwOption { kw: number; kwYear: number; start: number; }

/**
 * ISO-KWs, die den gegebenen Monat schneiden — mit ISO-Wochenjahr (wichtig am
 * Jahreswechsel), dedupliziert, chronologisch nach tatsächlichem Wochenstart.
 */
function isoWeeksOfMonth(year: number, month: number): KwOption[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const seen = new Map<string, KwOption>();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const { week, year: kwYear } = isoWeekOf(d);
    const key = `${kwYear}-${week}`;
    if (!seen.has(key)) {
      // Montag dieser Woche als chronologischer Sortierschlüssel.
      const mon = new Date(d);
      mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
      seen.set(key, { kw: week, kwYear, start: mon.getTime() });
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

// Serialisierte Werte fürs Select (WeekSelection ist ein Objekt).
const WEEK_LASTCOMPLETE = 'lastComplete';
const WEEK_CURRENT = 'current';
const WEEK_LAST7 = 'last7';

/** KW-Wert als "YYYY-Wnn" (ISO-Wochenjahr + Woche). */
const kwValue = (o: KwOption) => `${o.kwYear}-W${String(o.kw).padStart(2, '0')}`;

function parseWeekValue(v: string): WeekSelection {
  if (v === WEEK_CURRENT) return { kind: 'current' };
  if (v === WEEK_LAST7) return { kind: 'last7' };
  const m = /^(\d{4})-W(\d{1,2})$/.exec(v);
  if (m) return { kind: 'kw', kw: Number(m[2]), kwYear: Number(m[1]) };
  return { kind: 'lastComplete' };
}

const fmtNum = (v: number, dec = 2) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });

function fmtCell(v: number | null, fmt: MrRow['fmt']): string {
  if (v === null || v === undefined) return '';
  if (fmt === 'count' || fmt === 'hours') return fmtNum(v, 0);
  if (fmt === 'pct') return `${v.toFixed(1)} %`;
  return fmtNum(v);
}

function fmtDev(v: number | null): string {
  if (v === null) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
}

const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

export default function MonatsreportPage() {
  const heute = useMemo(() => new Date(), []);
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();

  const [year, setYear] = useState(heute.getFullYear());
  const [month, setMonth] = useState(heute.getMonth() + 1); // 1-basiert
  const [daten, setDaten] = useState<MonatsreportDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [weekValue, setWeekValue] = useState<string>(WEEK_LASTCOMPLETE);

  const weekSelection = useMemo<WeekSelection>(() => parseWeekValue(weekValue), [weekValue]);
  const kwOptions = useMemo(() => isoWeeksOfMonth(year, month), [year, month]);

  useEffect(() => {
    if (ratesLoading || !rates) return;
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeMonatsreport(year, month, tenantId, tenantKey, rates, heute, weekSelection)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [year, month, tenantId, tenantKey, rates, ratesLoading, heute, weekSelection]);

  const prev = () => { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); };
  const next = () => { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); };

  const wocheRange = daten?.weekFrom && daten?.weekTo
    ? `${fmtDate(daten.weekFrom)}–${fmtDate(daten.weekTo)}`
    : null;

  return (
    <PageShell>
      <div className="space-y-4 max-w-5xl">
        {/* Kopf */}
        <div className="flex items-center gap-3">
          <CalendarDays className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Monatsreport</h1>
            <p className="text-xs text-muted-foreground">
              Meeting-Cockpit — automatisch gefüllte Kennzahlen, fehlende Quellen bleiben leer
            </p>
          </div>
        </div>

        <Tabs defaultValue="monat">
          <TabsList data-testid="tabs-cockpit">
            <TabsTrigger value="monat" data-testid="tab-monat">Monatsübersicht</TabsTrigger>
            <TabsTrigger value="wochen" data-testid="tab-wochen">Wochenverlauf</TabsTrigger>
          </TabsList>

          {/* ── Monatsübersicht (unverändert) ── */}
          <TabsContent value="monat" className="space-y-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={prev} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[130px] text-center text-sm font-semibold" data-testid="text-month-label">
                {MONATE[month - 1]} {year}
              </span>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={next} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Select value={weekValue} onValueChange={setWeekValue}>
                <SelectTrigger className="h-8 w-[210px] text-xs ml-2" data-testid="select-week">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WEEK_LASTCOMPLETE}>Letzte abgeschlossene Woche</SelectItem>
                  <SelectItem value={WEEK_CURRENT}>Aktuelle Woche</SelectItem>
                  <SelectItem value={WEEK_LAST7}>Letzte 7 Tage</SelectItem>
                  {kwOptions.map(o => (
                    <SelectItem key={kwValue(o)} value={kwValue(o)}>KW {o.kw}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm" className="gap-1.5 ml-2"
                disabled={!daten || loading}
                onClick={() => daten && exportMonatsreportXlsx(daten.rows, year, month)}
                data-testid="button-export-excel"
              >
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </Button>
            </div>

            {fehler && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                Fehler beim Laden: {fehler}
              </div>
            )}

            {loading && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}

            {!loading && daten && (
              <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-monatsreport">
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
                      <th className="px-3 py-2 text-right font-semibold">Budget</th>
                      <th className="px-3 py-2 text-right font-semibold">Vorjahr</th>
                      <th className="px-3 py-2 text-right font-semibold">
                        {daten?.weekLabel ?? 'Woche'}
                        {wocheRange ? <span className="block normal-case font-normal">{wocheRange}</span> : null}
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">+/- in %</th>
                      <th className="px-3 py-2 text-right font-semibold">Monat</th>
                      <th className="px-3 py-2 text-right font-semibold">+/- in %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daten.rows.map((row, i) => {
                      if (row.type === 'empty') {
                        return <tr key={i}><td colSpan={7} className="h-3 bg-muted/20" /></tr>;
                      }
                      const wDev = row.week !== null && row.weekBudget !== null && row.weekBudget > 0
                        ? ((row.week - row.weekBudget) / row.weekBudget) * 100 : null;
                      const mDev = row.month !== null && row.budget !== null && row.budget > 0
                        ? ((row.month - row.budget) / row.budget) * 100 : null;
                      return (
                        <tr key={i} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')}>
                          <td className="px-3 py-1.5">{row.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(row.budget, row.fmt)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(row.vj, row.fmt)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(row.week, row.fmt)}</td>
                          <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs',
                            wDev !== null && (wDev >= 0 ? 'text-emerald-600' : 'text-red-600'))}>{fmtDev(wDev)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(row.month, row.fmt)}</td>
                          <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs',
                            mDev !== null && (mDev >= 0 ? 'text-emerald-600' : 'text-red-600'))}>{fmtDev(mDev)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Woche = gewählter Zeitraum ({daten?.weekLabel ?? '—'}
              {wocheRange ? `, ${wocheRange}` : ''}), auf den Monat geklemmt · Monat = Ist bis heute ·
              +/- = Abweichung zum Budget bzw. Budget-Wochenanteil · Umsatz pro Gast = Netto ÷ Gäste
              nur über Tage mit beiden Quellen · leere Felder = keine Datenquelle vorhanden.
              Warenaufwand, Lieferanten und manuelle Felder folgen in einer späteren Etappe.
            </p>
          </TabsContent>

          {/* ── Wochenverlauf (neu) ── */}
          <TabsContent value="wochen" className="space-y-4">
            <WochenverlaufView />
          </TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

// ── Wochenverlauf-Ansicht ─────────────────────────────────────────────────────

const WEEK_COUNT_OPTIONS = [2, 4, 8];

/** Trend gegenüber Vorwoche in %, null wenn eine der beiden Wochen leer ist. */
function trendPct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** Mini-Sparkline (Inline-SVG) über die Wochenwerte; fehlende Wochen übersprungen. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const pts = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <span className="text-muted-foreground">—</span>;
  const w = 64, h = 20, pad = 2;
  const vs = pts.map(p => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => pad + (n <= 1 ? 0 : (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const poly = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1].v >= pts[0].v;
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden="true">
      <polyline
        points={poly} fill="none" strokeWidth={1.5}
        className={up ? 'stroke-emerald-500' : 'stroke-red-500'}
      />
    </svg>
  );
}

function WochenverlaufView() {
  const heute = useMemo(() => new Date(), []);
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();

  const [anzahl, setAnzahl] = useState(4);
  const [daten, setDaten] = useState<WochenverlaufDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (ratesLoading || !rates) return;
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeWochenverlauf(anzahl, tenantId, tenantKey, rates, heute)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [anzahl, tenantId, tenantKey, rates, ratesLoading, heute]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">Anzahl Wochen</span>
        <Select value={String(anzahl)} onValueChange={v => setAnzahl(Number(v))}>
          <SelectTrigger className="h-8 w-20 text-xs" data-testid="select-week-count">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEEK_COUNT_OPTIONS.map(n => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {fehler && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fehler beim Laden: {fehler}
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}

      {!loading && daten && (
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-wochenverlauf">
            <thead>
              <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
                {daten.weeks.map(w => (
                  <th key={`${w.kwYear}-${w.kw}`} className="px-3 py-2 text-right font-semibold">
                    KW {w.kw}
                    <span className="block normal-case font-normal">
                      {fmtDate(w.from)}–{fmtDate(w.to)}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Verlauf</th>
              </tr>
            </thead>
            <tbody>
              {daten.rows.map((row, ri) => (
                <tr key={ri} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')}>
                  <td className="px-3 py-1.5">{row.label}</td>
                  {row.values.map((v, ci) => {
                    const prev = ci > 0 ? row.values[ci - 1] : null;
                    const t = ci > 0 ? trendPct(v, prev) : null;
                    return (
                      <td key={ci} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {v === null ? <span className="text-muted-foreground">—</span> : fmtCell(v, row.fmt)}
                        {t !== null && (
                          <span className={cn('ml-1.5 text-[10px] font-normal',
                            t >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {t >= 0 ? '▲' : '▼'}{Math.abs(t).toFixed(0)}%
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right">
                    <Sparkline values={row.values} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Wochenverlauf = letzte {anzahl} abgeschlossene ISO-Kalenderwochen (Mo–So, älteste links) ·
        Trend ▲/▼ = Veränderung zur Vorwoche · Verlauf = Mini-Trend über alle Wochen ·
        gleiche Quellen &amp; Berechnung wie die Monatsübersicht · leere Felder (—) = keine Datenquelle,
        nie 0. Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen.
      </p>
    </>
  );
}
