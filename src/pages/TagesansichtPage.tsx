/**
 * TagesansichtPage – Tages-Umsatzvergleich (standalone)
 * =======================================================
 * Route:     /tagesansicht
 * NavLink:   Verkauf → Tagesansicht  (adminOnly)
 *
 * Spaltenreihenfolge:
 *   Datum · WT · Ist · Umsatz VJ · WT VJ · Datum VJ · Abw. VJ
 *   [Budget · Abw. Budget · Kum. Ist · Kum. VJ · Kum. Abw. VJ]
 *
 * VJ-Logik:
 *   1. dailyBudgets[currentDate].previousYearRevenue  (aus Import)
 *   2. dailyBudgets[sameCalendarDayLastYear].actualRevenue  (Fallback)
 *   z.B. 03.03.2026  →  03.03.2025
 *
 * Konsolen-Logs:
 *   [TAGESANSICHT] current date: 2026-03-03
 *   [TAGESANSICHT] prior-year date: 2025-03-03
 *   [TAGESANSICHT] prior-year revenue found: 4320
 */

import { useState, useEffect, useMemo } from 'react';
import {
  startOfMonth, endOfMonth, eachDayOfInterval, format,
  addMonths, subMonths,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Table2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { grossToNet } from '@/types/personnel';

// ── Typen ────────────────────────────────────────────────────────────────────

interface DailyEntry {
  actualRevenue?:       number;
  takeawayRevenue?:     number;
  previousYearRevenue?: number;
  plannedRevenue?:      number;
}

type ViewMode = 'alles' | 'vs-budget' | 'vs-vorjahr' | 'nur-umsaetze';

// ── Wochentags-Abkürzungen (So=0 … Sa=6) ─────────────────────────────────────

const WT_ABBR = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const wtOf     = (d: Date) => WT_ABBR[d.getDay()];
const isWE     = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

// ── Zahlenformate ─────────────────────────────────────────────────────────────

const NUM = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const fmtN = (v: number) => NUM.format(Math.round(v));
const fmtDev = (v: number): string =>
  (v >= 0 ? '+' : '') + NUM.format(Math.round(v));
const devCls = (v: number, active = true) =>
  !active ? 'text-muted-foreground'
  : v > 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium'
  : v < 0 ? 'text-red-600 dark:text-red-400 font-medium'
  : 'text-muted-foreground';

// ── Hilfsfunktion: dailyBudgets aus localStorage sicher lesen ────────────────

function readDailyBudgets(): Record<string, DailyEntry> {
  try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
  catch { return {}; }
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function TagesansichtPage() {
  const { showNetRevenue } = useRevenueDisplay();

  // ── Monat-Selektor ──────────────────────────────────────────────────────────
  const [refDate, setRefDate] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const year  = refDate.getFullYear();
  const month = refDate.getMonth() + 1;

  // ── Vergleichs-Modus ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<ViewMode>('alles');

  // ── Daten laden: localStorage sofort + KV-Sync-Event ────────────────────────
  const [dailyBudgets, setDailyBudgets] = useState<Record<string, DailyEntry>>(readDailyBudgets);

  useEffect(() => {
    // Beim Mounten nochmals aus localStorage frisch lesen
    setDailyBudgets(readDailyBudgets());

    // Zusätzlich aus Supabase KV nachladen (async, falls frischer als localStorage)
    import('@/lib/supabase-kv').then(({ kvGet }) =>
      kvGet('dailyBudgets')
        .then(remote => {
          if (remote && typeof remote === 'object') {
            setDailyBudgets(remote as Record<string, DailyEntry>);
          }
        })
        .catch(() => { /* Netzwerk-Fehler – localStorage-Wert wird verwendet */ })
    );

    const onSync = () => setDailyBudgets(readDailyBudgets());
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  }, []);

  // ── Budget ──────────────────────────────────────────────────────────────────
  const budgetData = useBudgetMonth(year, month);
  const hasBud     = budgetData.revenueBudget > 0;

  // ── Tage des Monats ─────────────────────────────────────────────────────────
  const monthDays = useMemo(() =>
    eachDayOfInterval({ start: startOfMonth(refDate), end: endOfMonth(refDate) }),
  [refDate]);

  const daysInMonth      = monthDays.length;
  const dailyBudgetGross = hasBud ? budgetData.revenueBudget / daysInMonth : 0;
  const dailyBudgetBase  = showNetRevenue ? grossToNet(dailyBudgetGross) : dailyBudgetGross;

  // ── Zeilenberechnung ────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    let cumIst = 0;
    let cumVj  = 0;
    let cumBud = 0;

    return monthDays.map(day => {
      const d = format(day, 'yyyy-MM-dd');

      // Ist-Umsatz
      const gross    = dailyBudgets[d]?.actualRevenue   ?? 0;
      const takeaway = dailyBudgets[d]?.takeawayRevenue ?? 0;
      const ist      = showNetRevenue ? grossToNet(gross, takeaway) : gross;

      // Vorjahr: exakt gleicher Kalendertag, Jahr -1
      //   z.B. 2026-03-03  →  2025-03-03
      const vjKey    = `${year - 1}-${d.slice(5)}`; // "2025-03-03"
      const vjDirect = dailyBudgets[d]?.previousYearRevenue ?? 0;
      const vjRaw    = vjDirect > 0
        ? vjDirect
        : (dailyBudgets[vjKey]?.actualRevenue ?? 0);
      const vj       = showNetRevenue ? grossToNet(vjRaw) : vjRaw;
      const vjDate   = new Date(vjKey + 'T00:00:00');

      // Konsolen-Log für Diagnose (nur erste 5 Tage pro Monat um Flut zu vermeiden)
      if (day.getDate() <= 5) {
        console.log(
          `[TAGESANSICHT] current date: ${d} | prior-year date: ${vjKey}` +
          ` | prior-year revenue found: ${vjRaw}` +
          ` (direct=${vjDirect}, fallback=${dailyBudgets[vjKey]?.actualRevenue ?? 0})`,
        );
      }

      cumIst += ist;
      cumVj  += vj;
      cumBud += dailyBudgetBase;

      return {
        day, vjDate,
        ist, vj,
        bud:       dailyBudgetBase,
        devVj:     ist - vj,
        devBud:    ist - dailyBudgetBase,
        cumIst, cumVj, cumBud,
        cumDevVj:  cumIst - cumVj,
        cumDevBud: cumIst - cumBud,
        hasIst: gross > 0,
        hasVj:  vjRaw > 0,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthDays, dailyBudgets, showNetRevenue, dailyBudgetBase, year]);

  const lastRow = rows[rows.length - 1];

  // ── Spalten-Sichtbarkeit je Modus ───────────────────────────────────────────
  const showVjCols   = ['alles', 'vs-vorjahr', 'nur-umsaetze'].includes(mode);
  const showBudCol   = ['alles', 'vs-budget',  'nur-umsaetze'].includes(mode);
  const showDevVj    = ['alles', 'vs-vorjahr'].includes(mode);
  const showDevBud   = ['alles', 'vs-budget'].includes(mode);
  const showKum      = mode !== 'nur-umsaetze';
  const showKumVj    = showKum && ['alles', 'vs-vorjahr'].includes(mode);
  const showKumBud   = showKum && ['alles', 'vs-budget'].includes(mode);
  const showKumDevVj = showKum && ['alles', 'vs-vorjahr'].includes(mode);
  const showKumDevBud= showKum && ['alles', 'vs-budget'].includes(mode);

  // ── CSS-Kürzel ────────────────────────────────────────────────────────────
  const th  = (align: 'l'|'r', extra = '') =>
    cn(`text-${align === 'l' ? 'left' : 'right'} px-2 py-2 font-medium text-[11px] whitespace-nowrap`, extra);
  const td  = (align: 'l'|'r', extra = '') =>
    cn(`px-2 py-[5px] ${align === 'l' ? 'text-left' : 'text-right tabular-nums'} whitespace-nowrap text-xs`, extra);
  const tdK = (extra = '') =>
    cn('px-2 py-[5px] text-right tabular-nums whitespace-nowrap text-xs border-l border-border/40', extra);

  const MODES: { id: ViewMode; label: string }[] = [
    { id: 'alles',        label: 'Alles' },
    { id: 'vs-budget',    label: 'Ist vs. Budget' },
    { id: 'vs-vorjahr',   label: 'Ist vs. Vorjahr' },
    { id: 'nur-umsaetze', label: 'Nur Umsätze' },
  ];

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">

          {/* Titel */}
          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Tagesansicht</h1>
          </div>

          {/* Monat-Navigator */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setRefDate(d => subMonths(d, 1))}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-sm font-medium min-w-[110px] text-center">
              {format(refDate, 'MMMM yyyy', { locale: de })}
            </span>
            <button
              onClick={() => setRefDate(d => addMonths(d, 1))}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Basis-Info + Vergleichs-Buttons */}
          <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
            <span className="text-[11px] text-muted-foreground">
              {showNetRevenue ? 'Netto' : 'Brutto'}
              {!hasBud && ' · kein Budget'}
            </span>

            <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
              {MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'px-2.5 py-1 text-[11px] font-medium rounded-md transition-all whitespace-nowrap',
                    mode === m.id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* ── Tabelle ────────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-4">
        <Card>
          <CardHeader className="py-2.5 px-4 border-b border-border/60">
            <CardTitle className="text-xs font-normal text-muted-foreground">
              {format(refDate, 'MMMM yyyy', { locale: de })} · {daysInMonth} Tage
              {!hasBud && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  Kein Monatsbudget hinterlegt
                </span>
              )}
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0 pb-1">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">

                {/* Kopfzeile */}
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className={th('l')}>Datum</th>
                    <th className={th('l')}>WT</th>
                    <th className={th('r')}>Ist</th>
                    {showVjCols && <th className={th('r')}>Umsatz VJ</th>}
                    {showVjCols && <th className={th('l')}>WT VJ</th>}
                    {showVjCols && <th className={th('l')}>Datum VJ</th>}
                    {showDevVj  && <th className={th('r')}>Abw. VJ</th>}
                    {showBudCol && <th className={th('r')}>Budget</th>}
                    {showDevBud && <th className={th('r')}>Abw. Budget</th>}
                    {showKum    && <th className={th('r', 'border-l border-border/40')}>Kum. Ist</th>}
                    {showKumVj  && <th className={th('r')}>Kum. VJ</th>}
                    {showKumBud && <th className={th('r')}>Kum. Budget</th>}
                    {showKumDevVj  && <th className={th('r')}>Kum. Abw. VJ</th>}
                    {showKumDevBud && <th className={th('r')}>Kum. Abw. Bud.</th>}
                  </tr>
                </thead>

                {/* Datenzeilen */}
                <tbody>
                  {rows.map((row, i) => {
                    const we = isWE(row.day);
                    return (
                      <tr
                        key={i}
                        className={cn(
                          'border-b border-border/20',
                          we
                            ? 'bg-slate-50/80 dark:bg-slate-900/30'
                            : i % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                        )}
                      >
                        {/* Datum */}
                        <td className={td('l', cn('font-mono', we ? 'text-slate-500 dark:text-slate-400' : 'text-muted-foreground'))}>
                          {format(row.day, 'dd.MM.yyyy')}
                        </td>
                        {/* WT */}
                        <td className={td('l', cn('font-medium', we ? 'text-slate-600 dark:text-slate-300' : ''))}>
                          {wtOf(row.day)}
                        </td>
                        {/* Ist */}
                        <td className={td('r', row.hasIst ? 'font-semibold' : 'text-muted-foreground')}>
                          {row.hasIst ? fmtN(row.ist) : '–'}
                        </td>
                        {/* Umsatz VJ */}
                        {showVjCols && (
                          <td className={td('r', 'text-muted-foreground')}>
                            {row.hasVj ? fmtN(row.vj) : '0'}
                          </td>
                        )}
                        {/* WT VJ */}
                        {showVjCols && (
                          <td className={td('l', cn(
                            isWE(row.vjDate)
                              ? 'text-slate-500 dark:text-slate-400'
                              : 'text-muted-foreground',
                          ))}>
                            {wtOf(row.vjDate)}
                          </td>
                        )}
                        {/* Datum VJ */}
                        {showVjCols && (
                          <td className={td('l', 'text-muted-foreground font-mono')}>
                            {format(row.vjDate, 'dd.MM.yyyy')}
                          </td>
                        )}
                        {/* Abw. VJ */}
                        {showDevVj && (
                          <td className={td('r', devCls(row.devVj, row.hasIst))}>
                            {row.hasIst ? fmtDev(row.devVj) : '–'}
                          </td>
                        )}
                        {/* Budget */}
                        {showBudCol && (
                          <td className={td('r', 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.bud) : '–'}
                          </td>
                        )}
                        {/* Abw. Budget */}
                        {showDevBud && (
                          <td className={td('r', devCls(row.devBud, row.hasIst && hasBud))}>
                            {row.hasIst && hasBud ? fmtDev(row.devBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Ist */}
                        {showKum && (
                          <td className={tdK('font-medium')}>
                            {fmtN(row.cumIst)}
                          </td>
                        )}
                        {/* Kum. VJ */}
                        {showKumVj && (
                          <td className={td('r', 'text-muted-foreground')}>
                            {fmtN(row.cumVj)}
                          </td>
                        )}
                        {/* Kum. Budget */}
                        {showKumBud && (
                          <td className={td('r', 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.cumBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Abw. VJ */}
                        {showKumDevVj && (
                          <td className={td('r', devCls(row.cumDevVj, row.cumVj > 0 || row.cumIst > 0))}>
                            {fmtDev(row.cumDevVj)}
                          </td>
                        )}
                        {/* Kum. Abw. Budget */}
                        {showKumDevBud && (
                          <td className={td('r', devCls(row.cumDevBud, hasBud))}>
                            {hasBud ? fmtDev(row.cumDevBud) : '–'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>

                {/* Gesamt-Zeile */}
                {lastRow && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/50 font-semibold text-xs">
                      <td className={td('l', 'text-muted-foreground')} colSpan={2}>
                        Gesamt
                      </td>
                      <td className={td('r')}>{fmtN(lastRow.cumIst)}</td>
                      {showVjCols && <td className={td('r', 'text-muted-foreground')}>{fmtN(lastRow.cumVj)}</td>}
                      {showVjCols && <td className={td('l')} />}
                      {showVjCols && <td className={td('l')} />}
                      {showDevVj  && <td className={td('r', devCls(lastRow.cumDevVj, lastRow.cumVj > 0 || lastRow.cumIst > 0))}>{fmtDev(lastRow.cumDevVj)}</td>}
                      {showBudCol && <td className={td('r', 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showDevBud && <td className={td('r', devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
                      {showKum    && <td className={tdK()}>{fmtN(lastRow.cumIst)}</td>}
                      {showKumVj  && <td className={td('r', 'text-muted-foreground')}>{fmtN(lastRow.cumVj)}</td>}
                      {showKumBud && <td className={td('r', 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showKumDevVj  && <td className={td('r', devCls(lastRow.cumDevVj, lastRow.cumVj > 0 || lastRow.cumIst > 0))}>{fmtDev(lastRow.cumDevVj)}</td>}
                      {showKumDevBud && <td className={td('r', devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
