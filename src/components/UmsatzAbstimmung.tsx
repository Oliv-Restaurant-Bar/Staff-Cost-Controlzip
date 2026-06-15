import React, { useState, useEffect, useCallback } from 'react';
import { saveMonth } from '@/lib/reporting-store';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_DE } from '@/types/reporting';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, XCircle, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function getDailyGrossForMonth(year: number, month: number, storageKey: string): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return 0;
    const data = JSON.parse(raw) as Record<string, { actualRevenue?: number }>;
    const prefix = `${year}-${String(month).padStart(2, '0')}-`;
    return Object.entries(data)
      .filter(([k]) => k.startsWith(prefix))
      .reduce((sum, [, v]) => sum + (v?.actualRevenue ?? 0), 0);
  } catch { return 0; }
}

type RowStatus = 'ok' | 'warning' | 'error' | 'missing';

function getRowStatus(manual: number | undefined, daily: number): RowStatus {
  if (!manual || manual <= 0) return daily > 0 ? 'warning' : 'missing';
  if (daily <= 0) return 'warning';
  const pct = Math.abs(manual - daily) / manual;
  if (pct < 0.01) return 'ok';
  if (pct < 0.03) return 'warning';
  return 'error';
}

function fmt(n: number): string {
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(n);
}

function fmtDiff(diff: number): string {
  return `${diff >= 0 ? '+' : ''}${fmt(diff)}`;
}

function parseInput(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/['']/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '—') return undefined;
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface UmsatzAbstimmungProps {
  year: number;
  months: MonthlyFinancialRecord[];
  dailyBudgetsKey: string;
  storeKey: string;
  onRefresh: () => void;
  maisonMonthlyNet?: number[];
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

export function UmsatzAbstimmung({
  year, months, dailyBudgetsKey, storeKey, onRefresh, maisonMonthlyNet,
}: UmsatzAbstimmungProps) {
  const [editing, setEditing] = useState<Record<number, string>>({});
  const [saving,  setSaving]  = useState<Record<number, boolean>>({});
  const [dailySums, setDailySums] = useState<number[]>(() =>
    Array.from({ length: 12 }, (_, i) => getDailyGrossForMonth(year, i + 1, dailyBudgetsKey)),
  );

  useEffect(() => {
    setDailySums(Array.from({ length: 12 }, (_, i) =>
      getDailyGrossForMonth(year, i + 1, dailyBudgetsKey),
    ));
  }, [year, dailyBudgetsKey, months]);

  useEffect(() => {
    const refresh = () => setDailySums(Array.from({ length: 12 }, (_, i) =>
      getDailyGrossForMonth(year, i + 1, dailyBudgetsKey),
    ));
    window.addEventListener('store-synced', refresh);
    return () => window.removeEventListener('store-synced', refresh);
  }, [year, dailyBudgetsKey]);

  const handleGrossBlur = useCallback(async (month: number) => {
    const raw = editing[month];
    if (raw === undefined) return;
    setEditing(ed => { const n = { ...ed }; delete n[month]; return n; });

    const val = parseInput(raw);
    const existing = months.find(m => m.month === month)?.grossRevenueManual;
    if (val === existing) return;

    setSaving(s => ({ ...s, [month]: true }));
    try {
      saveMonth(
        { year, month, grossRevenueManual: val },
        'manual_entry',
        'update',
        { note: 'Bruttoumsatz manuell' },
        storeKey,
      );
      onRefresh();
    } finally {
      setSaving(s => { const n = { ...s }; delete n[month]; return n; });
    }
  }, [editing, months, year, storeKey, onRefresh]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, month: number) => {
    if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') setEditing(ed => { const n = { ...ed }; delete n[month]; return n; });
  };

  const hasAnyData = months.some(m => (m.revenueActual ?? 0) > 0 || dailySums[m.month - 1] > 0 || (m.grossRevenueManual ?? 0) > 0);
  if (!hasAnyData) return null;

  // Jahressummen
  const totalManual   = months.reduce((s, m) => s + (m.grossRevenueManual ?? 0), 0);
  const totalNetER    = months.reduce((s, m) => s + (m.revenueActual ?? 0), 0);
  const totalMaison   = (maisonMonthlyNet ?? []).reduce((s, v) => s + v, 0);
  const totalNetExkl  = Math.max(0, totalNetER - totalMaison);
  const totalDaily    = dailySums.reduce((s, v) => s + v, 0);
  const totalDiff     = totalManual > 0 && totalDaily > 0 ? totalManual - totalDaily : undefined;

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Umsatz-Abstimmung {year}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Bruttoumsatz (manuell, exkl. Maison) eingeben und mit Summe der Tageseinträge abgleichen.
          Differenz soll 0 sein. Netto ER (aus Import) als Referenz.
        </p>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[580px]">
          <thead>
            <tr className="border-b-2 border-border text-muted-foreground">
              <th className="text-left py-2 px-2 font-semibold min-w-[68px]">Monat</th>
              <th className="text-right py-2 px-2 font-semibold min-w-[130px]">
                Bruttoumsatz
                <span className="block text-[10px] font-normal">manuell, exkl. Maison</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[120px]">
                Summe Tage
                <span className="block text-[10px] font-normal">Brutto, Tagesansicht</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[100px]">
                Differenz
                <span className="block text-[10px] font-normal">Manuell − Tage</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[110px]">
                Netto ER
                <span className="block text-[10px] font-normal">exkl. Maison (Referenz)</span>
              </th>
              <th className="text-center py-2 px-2 font-semibold min-w-[50px]">OK?</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, idx) => {
              const daily     = dailySums[m.month - 1] ?? 0;
              const manual    = m.grossRevenueManual;
              const netER     = m.revenueActual;
              const maisonNet = maisonMonthlyNet?.[m.month - 1] ?? 0;
              const netExkl   = Math.max(0, (netER ?? 0) - maisonNet);

              const hasManual = (manual ?? 0) > 0;
              const hasDaily  = daily > 0;
              const hasER     = netExkl > 0;

              const status    = getRowStatus(manual ?? undefined, daily);
              const isEditing = editing[m.month] !== undefined;
              const isSaving  = !!saving[m.month];

              const diff = hasManual && hasDaily ? (manual! - daily) : undefined;
              const diffPct = diff !== undefined && manual! > 0
                ? Math.abs(diff) / manual! : undefined;

              const inputVal = isEditing
                ? editing[m.month]
                : (hasManual ? fmt(manual!) : '');

              if (!hasER && !hasDaily && !hasManual) {
                return (
                  <tr key={m.month} className="border-b border-border/30 opacity-40">
                    <td className="py-1.5 px-2 font-medium">{MONTH_NAMES_DE[m.month]}</td>
                    <td colSpan={5} className="py-1.5 px-2 text-center text-muted-foreground/50 italic">
                      keine Daten
                    </td>
                  </tr>
                );
              }

              return (
                <tr
                  key={m.month}
                  className={cn(
                    'border-b border-border/40 hover:bg-muted/20',
                    idx % 2 === 1 && 'bg-muted/10',
                  )}
                >
                  <td className="py-1.5 px-2 font-medium">{MONTH_NAMES_DE[m.month]}</td>

                  {/* Bruttoumsatz – editierbar */}
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      value={inputVal}
                      placeholder="eingeben…"
                      disabled={isSaving}
                      onFocus={e => setEditing(ed => ({ ...ed, [m.month]: e.target.value }))}
                      onChange={e => setEditing(ed => ({ ...ed, [m.month]: e.target.value }))}
                      onBlur={() => handleGrossBlur(m.month)}
                      onKeyDown={e => handleKeyDown(e, m.month)}
                      className={cn(
                        'w-full text-right font-mono text-xs bg-transparent',
                        'border-b border-transparent hover:border-blue-300 dark:hover:border-blue-700',
                        'focus:border-blue-500 focus:outline-none px-1 py-0.5 rounded-sm',
                        'focus:bg-blue-50/80 dark:focus:bg-blue-950/30 transition-colors',
                        isSaving && 'opacity-40',
                        !hasManual && !isEditing && 'text-muted-foreground/50 italic',
                      )}
                    />
                  </td>

                  {/* Summe Tage Brutto */}
                  <td className={cn('py-1.5 px-2 text-right font-mono', !hasDaily && 'text-muted-foreground/40 italic')}>
                    {hasDaily ? fmt(daily) : '—'}
                  </td>

                  {/* Differenz Manuell − Tage */}
                  <td className={cn(
                    'py-1.5 px-2 text-right font-mono',
                    diff === undefined ? 'text-muted-foreground/30 italic' :
                    diffPct === undefined ? 'text-muted-foreground/30' :
                    diffPct < 0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                    diffPct < 0.01  ? 'text-emerald-600 dark:text-emerald-400' :
                    diffPct < 0.03  ? 'text-amber-600 dark:text-amber-400' :
                    'text-red-600',
                  )}>
                    {diff !== undefined ? (
                      <span>
                        {fmtDiff(diff)}
                        {diffPct !== undefined && diffPct > 0.001 && (
                          <span className="block text-[10px]">
                            {(diffPct * 100).toFixed(1)} %
                          </span>
                        )}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Netto ER exkl. Maison (Referenz) */}
                  <td className={cn('py-1.5 px-2 text-right font-mono', !hasER && 'text-muted-foreground/30 italic')}>
                    {hasER ? fmt(netExkl) : '—'}
                  </td>

                  {/* Status */}
                  <td className="py-1.5 px-2 text-center">
                    {status === 'ok'      && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mx-auto" title="Bruttoumsatz stimmt mit Tageseinträgen überein (< 1 % Diff.)" />}
                    {status === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mx-auto" title="Abweichung oder fehlende Eingabe" />}
                    {status === 'error'   && <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" title="Grosse Abweichung (> 3 %) — bitte prüfen" />}
                    {status === 'missing' && <span className="text-muted-foreground/30 text-[10px]">–</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>

          {/* Jahressummen-Zeile */}
          <tfoot>
            <tr className="border-t-2 border-border font-semibold bg-muted/30">
              <td className="py-2 px-2 text-xs">Total {year}</td>
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalManual > 0 ? fmt(totalManual) : '—'}
              </td>
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalDaily > 0 ? fmt(totalDaily) : '—'}
              </td>
              <td className={cn(
                'py-2 px-2 text-right font-mono text-xs',
                totalDiff === undefined ? 'text-muted-foreground/40' :
                Math.abs(totalDiff) / Math.max(totalManual, 1) < 0.01 ? 'text-emerald-600 dark:text-emerald-400' :
                Math.abs(totalDiff) / Math.max(totalManual, 1) < 0.03 ? 'text-amber-600 dark:text-amber-400' :
                'text-red-600',
              )}>
                {totalDiff !== undefined ? fmtDiff(totalDiff) : '—'}
              </td>
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalNetExkl > 0 ? fmt(totalNetExkl) : '—'}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="mt-2.5 px-1 flex flex-col gap-0.5 text-[10px] text-muted-foreground/60">
          <span><strong>Bruttoumsatz (manuell):</strong> Dein Referenzwert, exkl. Maison/Marketing. Klick in Zelle zum Eingeben.</span>
          <span><strong>Summe Tage:</strong> Automatisch — Summe aller Tageseinträge aus Tagesansicht/Tages-Controlling (Brutto, ohne Maison).</span>
          <span><strong>Differenz:</strong> Manuell minus Summe Tage — Ziel: 0. Grün &lt; 1 %, Gelb = 1–3 %, Rot &gt; 3 %.</span>
          <span><strong>Netto ER:</strong> Aus Erfolgsrechnung-Import, zur Orientierung. Fehlt der Wert = kein Import für diesen Monat.</span>
        </div>
      </CardContent>
    </Card>
  );
}
