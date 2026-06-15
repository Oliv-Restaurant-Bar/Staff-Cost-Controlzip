import React, { useState, useEffect, useCallback } from 'react';
import { saveMonth } from '@/lib/reporting-store';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_DE } from '@/types/reporting';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, XCircle, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function getDailySumForMonth(year: number, month: number, storageKey: string): number {
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

const VAT_FACTOR = 1.081;

function getRowStatus(netExklMaison: number, dailySumNet: number): RowStatus {
  const hasER    = netExklMaison > 0;
  const hasDaily = dailySumNet > 0;
  if (!hasER && !hasDaily) return 'missing';
  if (!hasER || !hasDaily) return 'warning';
  const diff = Math.abs(dailySumNet - netExklMaison);
  const pct  = diff / netExklMaison;
  if (pct < 0.02) return 'ok';
  if (pct < 0.05) return 'warning';
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
  /** Netto-Marketing-Umsatz (Maison) pro Monat, Index 0 = Januar. 0 wenn kein Maison. */
  maisonMonthlyNet?: number[];
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

export function UmsatzAbstimmung({
  year, months, dailyBudgetsKey, storeKey, onRefresh, maisonMonthlyNet,
}: UmsatzAbstimmungProps) {
  const [editing, setEditing] = useState<Record<number, string>>({});
  const [saving,  setSaving]  = useState<Record<number, boolean>>({});
  const [dailySums, setDailySums] = useState<number[]>(() =>
    Array.from({ length: 12 }, (_, i) => getDailySumForMonth(year, i + 1, dailyBudgetsKey)),
  );

  useEffect(() => {
    setDailySums(Array.from({ length: 12 }, (_, i) =>
      getDailySumForMonth(year, i + 1, dailyBudgetsKey),
    ));
  }, [year, dailyBudgetsKey, months]);

  useEffect(() => {
    const refresh = () => setDailySums(Array.from({ length: 12 }, (_, i) =>
      getDailySumForMonth(year, i + 1, dailyBudgetsKey),
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

  const hasAnyData = months.some(m => (m.revenueActual ?? 0) > 0 || dailySums[m.month - 1] > 0);
  if (!hasAnyData) return null;

  const hasMaison = (maisonMonthlyNet ?? []).some(v => v > 0);

  // Jahressummen (exkl. Marketing)
  const totalGross       = months.reduce((s, m) => s + (m.grossRevenueManual ?? 0), 0);
  const totalNetER       = months.reduce((s, m) => s + (m.revenueActual ?? 0), 0);
  const totalMaison      = (maisonMonthlyNet ?? []).reduce((s, v) => s + v, 0);
  const totalNetExkl     = Math.max(0, totalNetER - totalMaison);
  const totalDaily       = dailySums.reduce((s, v) => s + v, 0);
  // Tagesumsätze sind Brutto (inkl. MwSt 8.1%) → für Vergleich mit Netto ER umrechnen
  const totalDailyNet    = totalDaily / VAT_FACTOR;
  const totalDiff        = totalNetExkl > 0 && totalDaily > 0 ? totalDailyNet - totalNetExkl : undefined;

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Umsatz-Abstimmung {year}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Bruttoumsatz (manuell, inkl. MwSt, <strong>exkl. Marketing</strong>) abgleichen
          mit Nettoumsatz ER exkl. Marketing und Summe der Tagesumsätze.
          Klick in Brutto-Zelle zum Eingeben.
        </p>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[640px]">
          <thead>
            <tr className="border-b-2 border-border text-muted-foreground">
              <th className="text-left py-2 px-2 font-semibold min-w-[68px]">Monat</th>
              <th className="text-right py-2 px-2 font-semibold min-w-[120px]">
                Bruttoumsatz
                <span className="block text-[10px] font-normal">manuell, exkl. Mkt.</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[110px]">
                Netto ER
                <span className="block text-[10px] font-normal">
                  {hasMaison ? 'exkl. Marketing' : 'Erfolgsrechnung'}
                </span>
              </th>
              {hasMaison && (
                <th className="text-right py-2 px-2 font-semibold min-w-[90px] text-purple-700 dark:text-purple-400">
                  Marketing
                  <span className="block text-[10px] font-normal">Maison Netto</span>
                </th>
              )}
              <th className="text-right py-2 px-2 font-semibold min-w-[110px]">
                Summe Tage
                <span className="block text-[10px] font-normal">Brutto (Tagesansicht)</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[90px]">
                Diff. Netto/ER
                <span className="block text-[10px] font-normal">Tage÷1.081 − ER</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[80px]">
                MwSt impl.
                <span className="block text-[10px] font-normal">Brutto/Netto</span>
              </th>
              <th className="text-center py-2 px-2 font-semibold min-w-[50px]">OK?</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, idx) => {
              const dailySum     = dailySums[m.month - 1] ?? 0;
              const netER        = m.revenueActual;
              const gross        = m.grossRevenueManual;
              const maisonNet    = maisonMonthlyNet?.[m.month - 1] ?? 0;
              // Vergleichsbasis: ER exkl. Marketing-Umsatz
              const netExkl      = Math.max(0, (netER ?? 0) - maisonNet);
              const hasER        = (netER ?? 0) > 0;
              const hasExkl      = netExkl > 0;
              const hasDaily     = dailySum > 0;
              const hasGross     = (gross ?? 0) > 0;
              const hasMaisonRow = maisonNet > 0;

              // Tagesumsätze Brutto → Netto umrechnen (÷1.081), dann mit ER vergleichen
              const dailySumNet  = hasDaily ? dailySum / VAT_FACTOR : 0;
              const status       = getRowStatus(netExkl, dailySumNet);
              const isEditing    = editing[m.month] !== undefined;
              const isSaving     = !!saving[m.month];

              // Diff: Tage Netto (÷1.081) minus ER exkl. Marketing (Ziel: 0)
              const diff = hasExkl && hasDaily ? dailySumNet - netExkl : undefined;

              // MwSt implizit: (Brutto − Netto exkl. Mkt.) / Netto exkl. Mkt.
              const implVat = hasGross && hasExkl
                ? ((gross! - netExkl) / netExkl * 100)
                : undefined;
              const vatOk   = implVat !== undefined && implVat >= 6.5 && implVat <= 9.5;

              const inputVal = isEditing
                ? editing[m.month]
                : (hasGross ? fmt(gross!) : '');

              if (!hasER && !hasDaily && !hasGross) {
                return (
                  <tr key={m.month} className="border-b border-border/30 opacity-40">
                    <td className="py-1.5 px-2 font-medium">{MONTH_NAMES_DE[m.month]}</td>
                    <td colSpan={hasMaison ? 7 : 6} className="py-1.5 px-2 text-center text-muted-foreground/50 italic">
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
                        !hasGross && !isEditing && 'text-muted-foreground/50 italic',
                      )}
                    />
                  </td>

                  {/* Netto ER exkl. Marketing */}
                  <td className="py-1.5 px-2 text-right font-mono">
                    {hasExkl ? (
                      <span>
                        {fmt(netExkl)}
                        {hasMaisonRow && hasER && (
                          <span className="block text-[10px] text-muted-foreground/50">
                            inkl. Mkt: {fmt(netER!)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40 italic">—</span>
                    )}
                  </td>

                  {/* Marketing (Maison Netto) — nur wenn Maison vorhanden */}
                  {hasMaison && (
                    <td className={cn(
                      'py-1.5 px-2 text-right font-mono',
                      !hasMaisonRow ? 'text-muted-foreground/30' : 'text-purple-700 dark:text-purple-400',
                    )}>
                      {hasMaisonRow ? fmt(maisonNet) : '—'}
                    </td>
                  )}

                  {/* Summe Tagesumsätze */}
                  <td className={cn('py-1.5 px-2 text-right font-mono', !hasDaily && 'text-muted-foreground/40 italic')}>
                    {hasDaily ? fmt(dailySum) : '—'}
                  </td>

                  {/* Diff Tage / ER exkl. Mkt. */}
                  <td className={cn(
                    'py-1.5 px-2 text-right font-mono',
                    diff === undefined                                    ? 'text-muted-foreground/40 italic' :
                    Math.abs(diff) < 500                                  ? 'text-emerald-600 dark:text-emerald-400' :
                    Math.abs(diff) / Math.max(netExkl, 1) < 0.02        ? 'text-emerald-600 dark:text-emerald-400' :
                    Math.abs(diff) / Math.max(netExkl, 1) < 0.05        ? 'text-amber-600 dark:text-amber-400' :
                    'text-red-600',
                  )}>
                    {diff !== undefined ? fmtDiff(diff) : '—'}
                  </td>

                  {/* MwSt implizit (Brutto vs. Netto exkl. Mkt.) */}
                  <td className={cn(
                    'py-1.5 px-2 text-right font-mono',
                    implVat === undefined ? 'text-muted-foreground/40 italic' :
                    vatOk   ? 'text-emerald-600 dark:text-emerald-400' :
                    'text-amber-600 dark:text-amber-400',
                  )}>
                    {implVat !== undefined ? `${implVat.toFixed(1)}%` : '—'}
                  </td>

                  {/* Status */}
                  <td className="py-1.5 px-2 text-center">
                    {status === 'ok'      && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mx-auto" title="Tagesumsätze stimmen mit ER exkl. Marketing überein (< 2 % Abw.)" />}
                    {status === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mx-auto" title="Abweichung vorhanden oder Daten fehlen" />}
                    {status === 'error'   && <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" title="Grosse Abweichung (> 5 %) — bitte prüfen" />}
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
                {totalGross > 0 ? fmt(totalGross) : '—'}
              </td>
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalNetExkl > 0 ? (
                  <span>
                    {fmt(totalNetExkl)}
                    {hasMaison && totalNetER > 0 && (
                      <span className="block text-[10px] text-muted-foreground/50">
                        inkl. Mkt: {fmt(totalNetER)}
                      </span>
                    )}
                  </span>
                ) : '—'}
              </td>
              {hasMaison && (
                <td className="py-2 px-2 text-right font-mono text-xs text-purple-700 dark:text-purple-400">
                  {totalMaison > 0 ? fmt(totalMaison) : '—'}
                </td>
              )}
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalDaily > 0 ? fmt(totalDaily) : '—'}
              </td>
              <td className={cn(
                'py-2 px-2 text-right font-mono text-xs',
                totalDiff === undefined ? 'text-muted-foreground/40' :
                Math.abs(totalDiff) / Math.max(totalNetExkl, 1) < 0.02 ? 'text-emerald-600 dark:text-emerald-400' :
                Math.abs(totalDiff) / Math.max(totalNetExkl, 1) < 0.05 ? 'text-amber-600 dark:text-amber-400' :
                'text-red-600',
              )}>
                {totalDiff !== undefined ? fmtDiff(totalDiff) : '—'}
              </td>
              <td className={cn(
                'py-2 px-2 text-right font-mono text-xs',
                (() => {
                  if (!totalGross || !totalNetExkl) return 'text-muted-foreground/40';
                  const vat = (totalGross - totalNetExkl) / totalNetExkl * 100;
                  return vat >= 6.5 && vat <= 9.5
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400';
                })(),
              )}>
                {totalGross > 0 && totalNetExkl > 0
                  ? `${((totalGross - totalNetExkl) / totalNetExkl * 100).toFixed(1)}%`
                  : '—'}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="mt-2.5 px-1 flex flex-col gap-0.5 text-[10px] text-muted-foreground/60">
          <span>
            <strong>Netto ER exkl. Mkt.:</strong> Nettoumsatz aus Erfolgsrechnung-Import abzüglich Maison-Marketing-Umsatz.
            {hasMaison ? ' In Klammern: inkl. Marketing.' : ''}{' '}
            <em>Fehlt ein Wert, wurde für diesen Monat noch kein ER-Import durchgeführt.</em>
          </span>
          <span><strong>Summe Tage (Brutto):</strong> Summe der Tagesumsätze aus Tagesansicht/Tages-Controlling — Brutto inkl. 8.1 % MwSt.</span>
          <span><strong>Diff. Netto/ER:</strong> (Summe Tage ÷ 1.081) − Netto ER exkl. Mkt. — Vergleich auf Nettobasis. Ziel: 0.</span>
          <span><strong>MwSt impl.:</strong> (Bruttoumsatz − Netto ER) / Netto ER — sollte ≈ 8.1 % ergeben. Grün = 6.5–9.5 %.</span>
          <span><strong>Status ✓:</strong> Diff. Netto/ER &lt; 2 %. Gelb = 2–5 %. Rot = &gt; 5 %.</span>
        </div>
      </CardContent>
    </Card>
  );
}
