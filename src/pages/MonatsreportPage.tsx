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
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { ladeMonatsreport, type MonatsreportDaten, type MrRow } from '@/lib/monatsreport';
import { exportMonatsreportXlsx } from '@/lib/monatsreport-export';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

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

  useEffect(() => {
    if (ratesLoading || !rates) return;
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeMonatsreport(year, month, tenantId, tenantKey, rates, heute)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [year, month, tenantId, tenantKey, rates, ratesLoading, heute]);

  const prev = () => { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); };
  const next = () => { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); };

  const wocheLabel = daten?.weekFrom && daten?.weekTo
    ? `${fmtDate(daten.weekFrom)}–${fmtDate(daten.weekTo)}`
    : null;

  return (
    <PageShell>
      <div className="space-y-4 max-w-5xl">
        {/* Kopf */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-6 w-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Monatsreport</h1>
              <p className="text-xs text-muted-foreground">
                Meeting-Cockpit — automatisch gefüllte Kennzahlen, fehlende Quellen bleiben leer
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={prev} data-testid="button-prev-month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[130px] text-center text-sm font-semibold" data-testid="text-month-label">
              {MONATE[month - 1]} {year}
            </span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={next} data-testid="button-next-month">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              size="sm" className="gap-1.5 ml-2"
              disabled={!daten || loading}
              onClick={() => daten && exportMonatsreportXlsx(daten.rows, year, month)}
              data-testid="button-export-excel"
            >
              <FileSpreadsheet className="h-4 w-4" /> Export Excel
            </Button>
          </div>
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
                    Woche{wocheLabel ? <span className="block normal-case font-normal">{wocheLabel}</span> : null}
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
          Woche = Ist der laufenden Woche (nur im aktuellen Monat) · Monat = Ist bis heute ·
          +/- = Abweichung zum Budget bzw. Budget-Wochenanteil · leere Felder = keine Datenquelle vorhanden.
          Warenaufwand, Lieferanten und manuelle Felder folgen in einer späteren Etappe.
        </p>
      </div>
    </PageShell>
  );
}
