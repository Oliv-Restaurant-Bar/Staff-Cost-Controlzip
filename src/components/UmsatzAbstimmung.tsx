import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { saveMonth } from '@/lib/reporting-store';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_DE } from '@/types/reporting';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, XCircle, Scale, ArrowRight, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// Zeilenstatus + Tagessumme: zentrale SSoT-Logik (auch von der Startseiten-
// Monatsübersicht read-only konsumiert) — hier KEINE eigene Zweitberechnung.
import { getUmsatzRowStatus, sumDailyGrossForMonth } from '@/lib/umsatzabstimmung-status';
import { readLocalRecord } from '@/lib/kv-blob-utils';

// ── Konstanten ─────────────────────────────────────────────────────────────────
const VAT_TAKEAWAY = 1.026; // 2.6 % MwSt (Takeout/Lieferung)

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function getDailyGrossForMonth(year: number, month: number, storageKey: string): number {
  return sumDailyGrossForMonth(readLocalRecord(storageKey), year, month);
}

function fmt(n: number): string {
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(n);
}

function fmt2(n: number): string {
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
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
  gnRevenueByMonth?: number[];
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

type EditField = 'gross' | 'takeAway';

export function UmsatzAbstimmung({
  year, months, dailyBudgetsKey, storeKey, onRefresh, gnRevenueByMonth,
}: UmsatzAbstimmungProps) {
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving,  setSaving]  = useState<Record<string, boolean>>({});
  // Leeres Jahr: Tabelle erst nach explizitem Klick zeigen (kein irreführender
  // leerer Bericht, aber manuelle Ersterfassung bleibt möglich, T506).
  const [showEmptyTable, setShowEmptyTable] = useState(false);
  useEffect(() => { setShowEmptyTable(false); }, [year]);
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

  const editKey = (month: number, field: EditField) => `${month}:${field}`;

  const handleBlur = useCallback(async (month: number, field: EditField) => {
    const key = editKey(month, field);
    const raw = editing[key];
    if (raw === undefined) return;
    setEditing(ed => { const n = { ...ed }; delete n[key]; return n; });

    const val = parseInput(raw);
    const rec = months.find(m => m.month === month);
    const existing = field === 'gross' ? rec?.grossRevenueManual : rec?.takeAwayGrossManual;
    if (val === existing) return;

    const saveKey = `${month}:${field}`;
    setSaving(s => ({ ...s, [saveKey]: true }));
    try {
      saveMonth(
        {
          year,
          month,
          ...(field === 'gross'    ? { grossRevenueManual:  val } : {}),
          ...(field === 'takeAway' ? { takeAwayGrossManual: val } : {}),
        },
        'manual_entry',
        'update',
        { note: field === 'gross' ? 'Bruttoumsatz manuell' : 'Take Away Bruttoumsatz manuell' },
        storeKey,
      );
      onRefresh();
    } finally {
      setSaving(s => { const n = { ...s }; delete n[saveKey]; return n; });
    }
  }, [editing, months, year, storeKey, onRefresh]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, month: number, field: EditField) => {
    const key = editKey(month, field);
    if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') setEditing(ed => { const n = { ...ed }; delete n[key]; return n; });
  };

  const hasGn = gnRevenueByMonth && gnRevenueByMonth.some(v => v > 0);

  // Datenlage des Jahres — GN-Z-Berichte zählen mit (vorher wurde ein Jahr mit
  // NUR Gastronovi-Daten fälschlich als komplett leer behandelt).
  const hasAnyData = months.some(m =>
    (m.grossRevenueManual ?? 0) > 0 ||
    (m.takeAwayGrossManual ?? 0) > 0 ||
    dailySums[m.month - 1] > 0,
  ) || !!hasGn;

  // Kein stiller Leerzustand mehr (T506): Ohne jede Quelle zeigt die Seite
  // sichtbar an, WELCHE Datenquellen fehlen — inkl. Aktionen. Die manuelle
  // Eingabe bleibt per explizitem Klick möglich (kein Auto-Seeding: blosses
  // Öffnen/Anzeigen schreibt nichts, erst echte Eingaben speichern).
  if (!hasAnyData && !showEmptyTable) {
    return (
      <Card className="border-blue-200 dark:border-blue-800" data-testid="umsatzabstimmung-empty">
        <CardHeader className="pb-2 pt-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Monatsabstimmung Umsatz {year}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-sm text-muted-foreground">
            Für {year} liegen noch keine Abstimmungsdaten vor. Es fehlen alle drei Quellen:
          </p>
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Manuelle Monatswerte</strong> (Bruttoumsatz / Take-Away) — hier unten erfassbar
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Tageseinträge</strong> aus der Tagesansicht —{' '}
                <Link to="/tagesansicht" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  Tagesansicht öffnen <ArrowRight className="h-3 w-3" />
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Gastronovi Z-Berichte</strong> —{' '}
                <Link to="/gastronovi-import" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  Z-Bericht importieren <ArrowRight className="h-3 w-3" />
                </Link>
              </span>
            </li>
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowEmptyTable(true)}
            data-testid="umsatzabstimmung-start-manual"
          >
            <PencilLine className="h-3.5 w-3.5 mr-1.5" />
            Manuelle Monatswerte für {year} erfassen
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Jahressummen
  const totalManual   = months.reduce((s, m) => s + (m.grossRevenueManual   ?? 0), 0);
  const totalTakeAway = months.reduce((s, m) => s + (m.takeAwayGrossManual ?? 0), 0);
  const totalDaily    = dailySums.reduce((s, v) => s + v, 0);
  const totalDiff     = totalManual > 0 && totalDaily > 0 ? totalManual - totalDaily : undefined;
  const totalGn       = hasGn ? (gnRevenueByMonth ?? []).reduce((s, v) => s + v, 0) : 0;
  const totalGnDiff   = totalManual > 0 && totalGn > 0 ? totalManual - totalGn : undefined;

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Monatsabstimmung Umsatz {year}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Bruttoumsatz (exkl. Maison) und Take-Away-Umsatz (2.6 % MwSt) manuell eingeben
          und mit den Tageseinträgen abgleichen. Differenz soll 0 sein.
        </p>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[620px]">
          <thead>
            <tr className="border-b-2 border-border text-muted-foreground">
              <th className="text-left py-2 px-2 font-semibold min-w-[68px]">Monat</th>
              <th className="text-right py-2 px-2 font-semibold min-w-[130px]">
                Bruttoumsatz
                <span className="block text-[10px] font-normal">manuell, exkl. Maison</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[130px] text-orange-700 dark:text-orange-400">
                Take Away
                <span className="block text-[10px] font-normal">Brutto inkl. 2.6 % MwSt</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[120px]">
                Summe Tage
                <span className="block text-[10px] font-normal">Brutto, Tagesansicht</span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[100px]">
                Differenz
                <span className="block text-[10px] font-normal">Manuell − Tage</span>
              </th>
              {hasGn && (
                <th className="text-right py-2 px-2 font-semibold min-w-[110px] text-violet-700 dark:text-violet-400">
                  Gastronovi
                  <span className="block text-[10px] font-normal">Z-Bericht Brutto</span>
                </th>
              )}
              {hasGn && (
                <th className="text-right py-2 px-2 font-semibold min-w-[90px]">
                  Diff GN
                  <span className="block text-[10px] font-normal">Manuell − GN</span>
                </th>
              )}
              <th className="text-center py-2 px-2 font-semibold min-w-[50px]">OK?</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, idx) => {
              const daily       = dailySums[m.month - 1] ?? 0;
              const manual      = m.grossRevenueManual;
              const takeAway    = m.takeAwayGrossManual;
              const hasManual   = (manual   ?? 0) > 0;
              const hasDaily    = daily > 0;
              const hasTakeAway = (takeAway ?? 0) > 0;
              const gnRev       = gnRevenueByMonth ? (gnRevenueByMonth[m.month - 1] ?? 0) : 0;
              const hasGnRow    = hasGn && gnRev > 0;

              // Take Away Netto & MwSt
              const taNet  = hasTakeAway ? (takeAway! / VAT_TAKEAWAY) : 0;
              const taMwSt = hasTakeAway ? (takeAway! - taNet)        : 0;

              const status  = getUmsatzRowStatus(manual ?? undefined, daily);
              const diff    = hasManual && hasDaily ? (manual! - daily) : undefined;
              const diffPct = diff !== undefined && manual! > 0 ? Math.abs(diff) / manual! : undefined;

              // GN Differenz
              const gnDiff    = hasManual && hasGnRow ? (manual! - gnRev) : undefined;
              const gnDiffPct = gnDiff !== undefined && manual! > 0 ? Math.abs(gnDiff) / manual! : undefined;

              const grossKey = editKey(m.month, 'gross');
              const taKey    = editKey(m.month, 'takeAway');
              const isEditingGross = editing[grossKey] !== undefined;
              const isEditingTA    = editing[taKey]    !== undefined;
              const isSavingGross  = !!saving[`${m.month}:gross`];
              const isSavingTA     = !!saving[`${m.month}:takeAway`];

              const grossInput = isEditingGross ? editing[grossKey] : (hasManual   ? fmt(manual!)   : '');
              const taInput    = isEditingTA    ? editing[taKey]    : (hasTakeAway ? fmt(takeAway!) : '');

              if (!hasManual && !hasTakeAway && !hasDaily && !hasGnRow) {
                return (
                  <tr key={m.month} className="border-b border-border/30 opacity-40">
                    <td className="py-1.5 px-2 font-medium">{MONTH_NAMES_DE[m.month]}</td>
                    <td colSpan={hasGn ? 7 : 5} className="py-1.5 px-2 text-center text-muted-foreground/50 italic">
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
                      value={grossInput}
                      placeholder="eingeben…"
                      disabled={isSavingGross}
                      onFocus={e => setEditing(ed => ({ ...ed, [grossKey]: e.target.value }))}
                      onChange={e => setEditing(ed => ({ ...ed, [grossKey]: e.target.value }))}
                      onBlur={() => handleBlur(m.month, 'gross')}
                      onKeyDown={e => handleKeyDown(e, m.month, 'gross')}
                      className={cn(
                        'w-full text-right font-mono text-xs bg-transparent',
                        'border-b border-transparent hover:border-blue-300 dark:hover:border-blue-700',
                        'focus:border-blue-500 focus:outline-none px-1 py-0.5 rounded-sm',
                        'focus:bg-blue-50/80 dark:focus:bg-blue-950/30 transition-colors',
                        isSavingGross && 'opacity-40',
                        !hasManual && !isEditingGross && 'text-muted-foreground/50 italic',
                      )}
                    />
                  </td>

                  {/* Take Away – editierbar */}
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      value={taInput}
                      placeholder="eingeben…"
                      disabled={isSavingTA}
                      onFocus={e => setEditing(ed => ({ ...ed, [taKey]: e.target.value }))}
                      onChange={e => setEditing(ed => ({ ...ed, [taKey]: e.target.value }))}
                      onBlur={() => handleBlur(m.month, 'takeAway')}
                      onKeyDown={e => handleKeyDown(e, m.month, 'takeAway')}
                      className={cn(
                        'w-full text-right font-mono text-xs bg-transparent',
                        'border-b border-transparent hover:border-orange-300 dark:hover:border-orange-700',
                        'focus:border-orange-500 focus:outline-none px-1 py-0.5 rounded-sm',
                        'focus:bg-orange-50/80 dark:focus:bg-orange-950/30 transition-colors',
                        isSavingTA && 'opacity-40',
                        !hasTakeAway && !isEditingTA && 'text-muted-foreground/50 italic',
                      )}
                    />
                    {hasTakeAway && (
                      <span className="block text-[10px] text-muted-foreground/50 text-right px-1 leading-tight">
                        Netto: {fmt2(taNet)} / MwSt: {fmt2(taMwSt)}
                      </span>
                    )}
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

                  {/* Gastronovi Z-Bericht */}
                  {hasGn && (
                    <td className={cn(
                      'py-1.5 px-2 text-right font-mono text-violet-700 dark:text-violet-400',
                      !hasGnRow && 'text-muted-foreground/30 italic',
                    )}>
                      {hasGnRow ? fmt(gnRev) : '—'}
                    </td>
                  )}

                  {/* Diff GN: Manuell − Gastronovi */}
                  {hasGn && (
                    <td className={cn(
                      'py-1.5 px-2 text-right font-mono',
                      gnDiff === undefined ? 'text-muted-foreground/30 italic' :
                      gnDiffPct === undefined ? 'text-muted-foreground/30' :
                      gnDiffPct < 0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                      gnDiffPct < 0.01  ? 'text-emerald-600 dark:text-emerald-400' :
                      gnDiffPct < 0.03  ? 'text-amber-600 dark:text-amber-400' :
                      'text-red-600',
                    )}>
                      {gnDiff !== undefined ? (
                        <span>
                          {fmtDiff(gnDiff)}
                          {gnDiffPct !== undefined && gnDiffPct > 0.001 && (
                            <span className="block text-[10px]">
                              {(gnDiffPct * 100).toFixed(1)} %
                            </span>
                          )}
                        </span>
                      ) : '—'}
                    </td>
                  )}

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
              <td className="py-2 px-2 text-right font-mono text-xs text-orange-700 dark:text-orange-400">
                {totalTakeAway > 0 ? (
                  <span>
                    {fmt(totalTakeAway)}
                    <span className="block text-[10px] font-normal text-muted-foreground/50">
                      Netto: {fmt(totalTakeAway / VAT_TAKEAWAY)}
                    </span>
                  </span>
                ) : '—'}
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
              {hasGn && (
                <td className="py-2 px-2 text-right font-mono text-xs text-violet-700 dark:text-violet-400">
                  {totalGn > 0 ? fmt(totalGn) : '—'}
                </td>
              )}
              {hasGn && (
                <td className={cn(
                  'py-2 px-2 text-right font-mono text-xs',
                  totalGnDiff === undefined ? 'text-muted-foreground/40' :
                  Math.abs(totalGnDiff) / Math.max(totalManual, 1) < 0.01 ? 'text-emerald-600 dark:text-emerald-400' :
                  Math.abs(totalGnDiff) / Math.max(totalManual, 1) < 0.03 ? 'text-amber-600 dark:text-amber-400' :
                  'text-red-600',
                )}>
                  {totalGnDiff !== undefined ? fmtDiff(totalGnDiff) : '—'}
                </td>
              )}
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="mt-2.5 px-1 flex flex-col gap-0.5 text-[10px] text-muted-foreground/60">
          <span><strong>Bruttoumsatz (manuell):</strong> Gesamtumsatz des Monats, exkl. Maison/Marketing, inkl. MwSt. Klick in Zelle zum Eingeben.</span>
          <span><strong>Take Away:</strong> Bruttoumsatz Takeaway, inkl. 2.6 % MwSt. Netto und MwSt-Betrag werden automatisch berechnet (÷ 1.026).</span>
          <span><strong>Summe Tage:</strong> Automatisch — Summe der Tageseinträge aus Tagesansicht/Tages-Controlling (Brutto, ohne Maison).</span>
          <span><strong>Differenz:</strong> Manuell minus Summe Tage — Ziel: 0. Grün &lt; 1 %, Gelb = 1–3 %, Rot &gt; 3 %.</span>
          {hasGn && <span><strong>Gastronovi Z-Bericht:</strong> Bruttoumsatz aus importierten Gastronovi Z-Berichten (Summe nach Monat von period_from).</span>}
        </div>
      </CardContent>
    </Card>
  );
}
