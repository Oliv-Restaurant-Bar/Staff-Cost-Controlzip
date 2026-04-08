/**
 * TagesansichtPage – Tages-Umsatzvergleich (standalone)
 * =======================================================
 * Zeigt Ist / Vorjahr / Budget pro Tag des gewählten Monats.
 * Wochentage als Abkürzung: Mo Di Mi Do Fr Sa So
 * Spaltenreihenfolge: Datum · WT · Ist · Umsatz VJ · WT VJ · Datum VJ · Abw. VJ
 *   danach je Modus: Budget · Abw. Budget · Kum.Ist · Kum.VJ · Kum.Abw.VJ
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

interface DailyBudget {
  actualRevenue?:      number;
  takeawayRevenue?:    number;
  previousYearRevenue?: number;
  plannedRevenue?:     number;
}

type ViewMode = 'alles' | 'vs-budget' | 'vs-vorjahr' | 'nur-umsaetze';

// ── Wochentags-Abkürzungen ────────────────────────────────────────────────────

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const wtOf = (d: Date) => WT[d.getDay()];
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

// ── Zahlenformate ─────────────────────────────────────────────────────────────

const numFmt = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const fmtN   = (v: number, visible = true) =>
  !visible ? '–' : v === 0 ? '0' : numFmt.format(Math.round(v));
const fmtDev = (v: number, visible = true): string => {
  if (!visible) return '–';
  return (v >= 0 ? '+' : '') + numFmt.format(Math.round(v));
};
const devCls = (v: number, visible = true) =>
  !visible ? 'text-muted-foreground'
  : v > 0  ? 'text-emerald-600 dark:text-emerald-400 font-medium'
  : v < 0  ? 'text-red-600 dark:text-red-400 font-medium'
  : 'text-muted-foreground';

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function TagesansichtPage() {
  const { showNetRevenue } = useRevenueDisplay();

  // Monat/Jahr-Selektor
  const [refDate, setRefDate] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const year  = refDate.getFullYear();
  const month = refDate.getMonth() + 1;

  // Vergleichsmodus
  const [mode, setMode] = useState<ViewMode>('alles');

  // dailyBudgets aus localStorage laden + bei Sync-Event neu lesen
  const [dailyBudgets, setDailyBudgets] = useState<Record<string, DailyBudget>>(() => {
    try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
    catch { return {}; }
  });

  useEffect(() => {
    const reload = () => {
      try { setDailyBudgets(JSON.parse(localStorage.getItem('dailyBudgets') || '{}')); }
      catch { /* ignore */ }
    };
    window.addEventListener('supabase-kv-synced', reload);
    return () => window.removeEventListener('supabase-kv-synced', reload);
  }, []);

  // Budget für den gewählten Monat
  const budgetData  = useBudgetMonth(year, month);
  const hasBud      = budgetData.revenueBudget > 0;

  // Tage des Monats
  const monthDays = useMemo(() =>
    eachDayOfInterval({
      start: startOfMonth(refDate),
      end:   endOfMonth(refDate),
    }),
  [refDate]);

  const daysInMonth = monthDays.length;
  const dailyBudgetGross = hasBud ? budgetData.revenueBudget / daysInMonth : 0;
  const dailyBudgetBase  = showNetRevenue ? grossToNet(dailyBudgetGross) : dailyBudgetGross;

  // Zeilenberechnung
  const rows = useMemo(() => {
    let cumIst = 0;
    let cumVj  = 0;
    let cumBud = 0;

    return monthDays.map(day => {
      const d = format(day, 'yyyy-MM-dd');

      // Ist
      const gross    = dailyBudgets[d]?.actualRevenue   ?? 0;
      const takeaway = dailyBudgets[d]?.takeawayRevenue ?? 0;
      const ist      = showNetRevenue ? grossToNet(gross, takeaway) : gross;

      // Vorjahr: direktes Feld zuerst, Fallback auf Vorjahres-Ist-Datensatz
      const vjKey   = d.replace(/^(\d{4})/, (_, y) => String(parseInt(y) - 1));
      const vjDirect = dailyBudgets[d]?.previousYearRevenue ?? 0;
      const vjGross  = vjDirect > 0 ? vjDirect : (dailyBudgets[vjKey]?.actualRevenue ?? 0);
      const vj       = showNetRevenue ? grossToNet(vjGross) : vjGross;
      const vjDate   = new Date(vjKey + 'T00:00:00');

      cumIst += ist;
      cumVj  += vj;
      cumBud += dailyBudgetBase;

      return {
        day,
        vjDate,
        ist,
        vj,
        bud:        dailyBudgetBase,
        devVj:      ist - vj,
        devBud:     ist - dailyBudgetBase,
        cumIst,
        cumVj,
        cumBud,
        cumDevVj:  cumIst - cumVj,
        cumDevBud: cumIst - cumBud,
        hasIst:    gross > 0,
        hasVj:     vjGross > 0,
      };
    });
  }, [monthDays, dailyBudgets, showNetRevenue, dailyBudgetBase]);

  const lastRow = rows[rows.length - 1];

  // ── Spalten-Sichtbarkeit ──────────────────────────────────────────────────
  const showVjCols   = ['alles','vs-vorjahr','nur-umsaetze'].includes(mode);
  const showBudCol   = ['alles','vs-budget','nur-umsaetze'].includes(mode);
  const showDevVj    = ['alles','vs-vorjahr'].includes(mode);
  const showDevBud   = ['alles','vs-budget'].includes(mode);
  const showKum      = mode !== 'nur-umsaetze';
  const showKumVj    = showKum && ['alles','vs-vorjahr'].includes(mode);
  const showKumBud   = showKum && ['alles','vs-budget'].includes(mode);
  const showKumDevVj = showKum && ['alles','vs-vorjahr'].includes(mode);
  const showKumDevBud= showKum && ['alles','vs-budget'].includes(mode);

  // ── CSS-Shortcuts ─────────────────────────────────────────────────────────
  const thL  = 'text-left  px-2 py-2 font-medium text-[11px] whitespace-nowrap';
  const thR  = 'text-right px-2 py-2 font-medium text-[11px] whitespace-nowrap';
  const thK  = 'text-right px-2 py-2 font-medium text-[11px] whitespace-nowrap border-l border-border/50';
  const tdL  = 'px-2 py-1 text-left  whitespace-nowrap text-xs';
  const tdR  = 'px-2 py-1 text-right tabular-nums whitespace-nowrap text-xs';
  const tdK  = 'px-2 py-1 text-right tabular-nums whitespace-nowrap text-xs border-l border-border/50';

  const MODES: { id: ViewMode; label: string }[] = [
    { id: 'alles',        label: 'Alles' },
    { id: 'vs-budget',    label: 'Ist vs. Budget' },
    { id: 'vs-vorjahr',   label: 'Ist vs. Vorjahr' },
    { id: 'nur-umsaetze', label: 'Nur Umsätze' },
  ];

  // Spaltenanzahl für Gesamt-colSpan (Datum + WT)
  const leadColSpan = 2;

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Table2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-base font-semibold">Tagesansicht</h1>
          </div>

          {/* Monat-Navigator */}
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => setRefDate(d => subMonths(d, 1))}
              className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium min-w-[120px] text-center">
              {format(refDate, 'MMMM yyyy', { locale: de })}
            </span>
            <button
              onClick={() => setRefDate(d => addMonths(d, 1))}
              className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {showNetRevenue ? 'Netto' : 'Brutto'}{hasBud ? '' : ' · kein Budget'}
            </span>

            {/* Vergleichs-Buttons */}
            <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
              {MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'px-2.5 py-1 text-xs font-medium rounded-md transition-all whitespace-nowrap',
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

      {/* ── Tabelle ─────────────────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-4 py-4">
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm text-muted-foreground font-normal">
              {format(refDate, 'MMMM yyyy', { locale: de })} · {daysInMonth} Tage
              {!hasBud && <span className="ml-2 text-amber-600 dark:text-amber-400">Kein Monatsbudget hinterlegt</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                {/* ── Kopfzeile ──────────────────────────────────────────── */}
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                    <th className={thL}>Datum</th>
                    <th className={thL}>WT</th>
                    <th className={thR}>Ist</th>
                    {showVjCols && <th className={thR}>Umsatz VJ</th>}
                    {showVjCols && <th className={thL}>WT VJ</th>}
                    {showVjCols && <th className={thL}>Datum VJ</th>}
                    {showDevVj  && <th className={thR}>Abw. VJ</th>}
                    {showBudCol && <th className={thR}>Budget</th>}
                    {showDevBud && <th className={thR}>Abw. Budget</th>}
                    {showKum    && <th className={thK}>Kum. Ist</th>}
                    {showKumVj  && <th className={thR}>Kum. VJ</th>}
                    {showKumBud && <th className={thR}>Kum. Budget</th>}
                    {showKumDevVj  && <th className={thR}>Kum. Abw. VJ</th>}
                    {showKumDevBud && <th className={thR}>Kum. Abw. Budget</th>}
                  </tr>
                </thead>

                {/* ── Zeilen ──────────────────────────────────────────────── */}
                <tbody>
                  {rows.map((row, i) => {
                    const we = isWeekend(row.day);
                    return (
                      <tr
                        key={i}
                        className={cn(
                          'border-b border-border/30 transition-colors',
                          we
                            ? 'bg-amber-50/60 dark:bg-amber-950/10'
                            : i % 2 === 0 ? 'bg-background' : 'bg-muted/15',
                        )}
                      >
                        {/* Datum aktuell */}
                        <td className={cn(tdL, we ? 'font-medium' : 'text-muted-foreground')}>
                          {format(row.day, 'dd.MM.yyyy')}
                        </td>
                        {/* WT aktuell */}
                        <td className={cn(tdL, we ? 'font-semibold text-amber-700 dark:text-amber-400' : '')}>
                          {wtOf(row.day)}
                        </td>
                        {/* Ist */}
                        <td className={cn(tdR, row.hasIst ? 'font-semibold' : 'text-muted-foreground')}>
                          {fmtN(row.ist, row.hasIst || row.ist > 0)}
                        </td>
                        {/* Umsatz VJ */}
                        {showVjCols && (
                          <td className={cn(tdR, row.hasVj ? '' : 'text-muted-foreground')}>
                            {row.hasVj ? fmtN(row.vj) : '–'}
                          </td>
                        )}
                        {/* WT VJ */}
                        {showVjCols && (
                          <td className={cn(tdL,
                            isWeekend(row.vjDate)
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground',
                          )}>
                            {wtOf(row.vjDate)}
                          </td>
                        )}
                        {/* Datum VJ */}
                        {showVjCols && (
                          <td className="px-2 py-1 text-left text-xs text-muted-foreground whitespace-nowrap">
                            {format(row.vjDate, 'dd.MM.yyyy')}
                          </td>
                        )}
                        {/* Abw. VJ */}
                        {showDevVj && (
                          <td className={cn(tdR, devCls(row.devVj, row.hasIst && row.hasVj))}>
                            {row.hasIst && row.hasVj ? fmtDev(row.devVj) : '–'}
                          </td>
                        )}
                        {/* Budget */}
                        {showBudCol && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.bud) : '–'}
                          </td>
                        )}
                        {/* Abw. Budget */}
                        {showDevBud && (
                          <td className={cn(tdR, devCls(row.devBud, row.hasIst && hasBud))}>
                            {row.hasIst && hasBud ? fmtDev(row.devBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Ist */}
                        {showKum && (
                          <td className={cn(tdK, 'font-medium')}>
                            {fmtN(row.cumIst)}
                          </td>
                        )}
                        {/* Kum. VJ */}
                        {showKumVj && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {row.cumVj > 0 ? fmtN(row.cumVj) : '–'}
                          </td>
                        )}
                        {/* Kum. Budget */}
                        {showKumBud && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.cumBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Abw. VJ */}
                        {showKumDevVj && (
                          <td className={cn(tdR, devCls(row.cumDevVj, row.cumVj > 0))}>
                            {row.cumVj > 0 ? fmtDev(row.cumDevVj) : '–'}
                          </td>
                        )}
                        {/* Kum. Abw. Budget */}
                        {showKumDevBud && (
                          <td className={cn(tdR, devCls(row.cumDevBud, hasBud))}>
                            {hasBud ? fmtDev(row.cumDevBud) : '–'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>

                {/* ── Gesamt-Zeile ────────────────────────────────────────── */}
                {lastRow && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/60 font-semibold text-xs">
                      <td className={cn(tdL, 'text-muted-foreground')} colSpan={leadColSpan}>
                        Gesamt
                      </td>
                      <td className={tdR}>{fmtN(lastRow.cumIst)}</td>
                      {showVjCols && <td className={cn(tdR, 'text-muted-foreground')}>{lastRow.cumVj > 0 ? fmtN(lastRow.cumVj) : '–'}</td>}
                      {showVjCols && <td className={tdL} />}
                      {showVjCols && <td className={tdL} />}
                      {showDevVj  && <td className={cn(tdR, devCls(lastRow.cumDevVj, lastRow.cumVj > 0))}>{lastRow.cumVj > 0 ? fmtDev(lastRow.cumDevVj) : '–'}</td>}
                      {showBudCol && <td className={cn(tdR, 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showDevBud && <td className={cn(tdR, devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
                      {showKum    && <td className={cn(tdK)}>{fmtN(lastRow.cumIst)}</td>}
                      {showKumVj  && <td className={cn(tdR, 'text-muted-foreground')}>{lastRow.cumVj > 0 ? fmtN(lastRow.cumVj) : '–'}</td>}
                      {showKumBud && <td className={cn(tdR, 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showKumDevVj  && <td className={cn(tdR, devCls(lastRow.cumDevVj, lastRow.cumVj > 0))}>{lastRow.cumVj > 0 ? fmtDev(lastRow.cumDevVj) : '–'}</td>}
                      {showKumDevBud && <td className={cn(tdR, devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
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
