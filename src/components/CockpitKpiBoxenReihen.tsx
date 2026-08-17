/**
 * CockpitKpiBoxenReihen — kompakter, ruhiger KPI-Kopf-Streifen des Cockpits:
 * Reihe OBEN = Monat (Ist bis Stichtag), Reihe UNTEN = letzte abgeschlossene
 * Woche. Bewusst dezent (kleine Schrift, gedämpfte Farben) — nur die
 * Ampelpunkte (WKQ/PKQ) und die Δ%-Werte sind farbig. Reines Anzeige-Layout —
 * die Werte kommen 1:1 aus kpiBoxenDaten (gleiche Quelle/Logik wie der
 * Vektor-PDF-Export). «Leer statt 0»: fehlende Quelle ⇒ «–», keine Ampel,
 * kein Δ.
 */

import type { MrRow } from '@/lib/monatsreport';
import { kpiBoxenDaten, type KpiSpalte } from '@/lib/cockpit-kpi-boxen';
import { cn } from '@/lib/utils';

function KpiReihe({ rows, spalte, label, testid }: {
  rows: MrRow[]; spalte: KpiSpalte; label: string; testid: string;
}) {
  const boxen = kpiBoxenDaten(rows, spalte);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={testid}>
      <span className="w-44 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3 lg:grid-cols-5">
        {boxen.map(b => (
          <div key={b.id} className="min-w-0" data-testid={`${testid}-${b.id}`}>
            <p className="truncate text-[10px] leading-3 text-muted-foreground" title={b.label}>
              {b.label}
            </p>
            <p className="flex items-center gap-1 text-[13px] font-semibold tabular-nums leading-4 text-foreground">
              {b.wert !== null && b.ampelGut !== undefined && (
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                    b.ampelGut ? 'bg-emerald-500' : 'bg-red-500',
                  )}
                  aria-label={b.ampelGut ? 'im Ziel' : 'über Ziel'}
                />
              )}
              <span className="truncate">{b.wert ?? '–'}</span>
              {b.delta && (
                <span className={cn(
                  'text-[10px] font-medium',
                  b.delta.positiv
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400',
                )}>
                  {b.delta.text}
                </span>
              )}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CockpitKpiBoxenReihen({ monatRows, monatLabel, wocheRows, wocheLabel }: {
  monatRows: MrRow[];
  monatLabel: string;
  /** null = Wochen-Reihe (noch) nicht verfügbar — Reihe wird weggelassen. */
  wocheRows: MrRow[] | null;
  wocheLabel: string;
}) {
  return (
    <div className="w-full space-y-1.5 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <KpiReihe rows={monatRows} spalte="month" label={monatLabel} testid="kpi-reihe-monat" />
      {wocheRows && (
        <>
          <div className="border-t border-border/60" />
          <KpiReihe rows={wocheRows} spalte="week" label={wocheLabel} testid="kpi-reihe-woche" />
        </>
      )}
    </div>
  );
}
