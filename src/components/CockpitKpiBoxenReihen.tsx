/**
 * CockpitKpiBoxenReihen — kompakter, ruhiger KPI-Kopf-Streifen des Cockpits
 * über die GANZE Breite: Reihe OBEN = Monat (Ist bis Stichtag), Reihe UNTEN =
 * letzte abgeschlossene Woche. Alle Werte AUSGESCHRIEBEN (kein Abschneiden);
 * dezent — farbig sind nur die Ampelpunkte (WKQ/PKQ) und die Δ%-Werte.
 * Reines Anzeige-Layout — die Werte kommen 1:1 aus kpiBoxenDaten (gleiche
 * Quelle/Logik wie der Vektor-PDF-Export). «Leer statt 0»: fehlende Quelle ⇒
 * «–», keine Ampel, kein Δ.
 */

import type { MrRow } from '@/lib/monatsreport';
import { kpiBoxenDaten, type KpiSpalte } from '@/lib/cockpit-kpi-boxen';
import { cn } from '@/lib/utils';

function KpiReihe({ rows, spalte, label, testid }: {
  rows: MrRow[]; spalte: KpiSpalte; label: string; testid: string;
}) {
  const boxen = kpiBoxenDaten(rows, spalte);
  return (
    <div className="px-3 py-2" data-testid={testid}>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-5">
        {boxen.map(b => (
          <div key={b.id} className="min-w-0" data-testid={`${testid}-${b.id}`}>
            <p className="whitespace-nowrap text-[11px] leading-4 text-muted-foreground">
              {b.label}
            </p>
            <p className="flex items-baseline gap-1.5 text-base font-semibold tabular-nums leading-5 text-foreground">
              {b.wert !== null && b.ampelGut !== undefined && (
                <span
                  className={cn(
                    'inline-block h-2 w-2 shrink-0 self-center rounded-full',
                    b.ampelGut ? 'bg-emerald-500' : 'bg-red-500',
                  )}
                  aria-label={b.ampelGut ? 'im Ziel' : 'über Ziel'}
                />
              )}
              <span className="whitespace-nowrap">{b.wert ?? '–'}</span>
              {b.delta && (
                <span className={cn(
                  'whitespace-nowrap text-[11px] font-medium',
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
    <div className="w-full divide-y divide-border/60 rounded-md border border-border/70 bg-muted/30">
      <KpiReihe rows={monatRows} spalte="month" label={monatLabel} testid="kpi-reihe-monat" />
      {wocheRows && (
        <KpiReihe rows={wocheRows} spalte="week" label={wocheLabel} testid="kpi-reihe-woche" />
      )}
    </div>
  );
}
