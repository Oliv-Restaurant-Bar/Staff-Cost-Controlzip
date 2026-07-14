/**
 * Gemeinsame Darstellungshelfer der Banken-/Investorenanalyse Phase 2.
 * NUR Formatierung/Mapping — keinerlei Berechnungen (alles kommt aus
 * dem zentralen BankInvestorAnalysis-Objekt).
 */
import type { Tone } from '@/components/ui/tones';
import type { GrowthTone } from '@/lib/multi-year-analysis';
import type { BankTrend, BankHeatmapBucket } from '@/lib/bank-investor-analysis';

export const chfFmt = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('de-CH');

export const pctFmt = (v: number | null): string =>
  v == null || !Number.isFinite(v)
    ? '—'
    : `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

export const toneToUi: Record<GrowthTone, Tone> = {
  good: 'good', critical: 'critical', neutral: 'neutral',
};

/** Trend-Symbol + Label (Mehrjahres-Scorecard). */
export const TREND_META: Record<BankTrend, { symbol: string; label: string }> = {
  steigend: { symbol: '↗', label: 'steigend' },
  fallend: { symbol: '↘', label: 'fallend' },
  stabil: { symbol: '→', label: 'stabil' },
  gemischt: { symbol: '↔', label: 'gemischt' },
};

/** Beschreibende Heatmap-Einordnung (bewusst KEINE gut/schlecht-Ampel). */
export const HEATMAP_BUCKET_STYLE: Record<BankHeatmapBucket, string> = {
  deutlich_ueber: 'bg-sky-600 text-white dark:bg-sky-500',
  leicht_ueber: 'bg-sky-200 dark:bg-sky-900',
  durchschnitt: 'bg-muted',
  unter: 'bg-amber-100 dark:bg-amber-950',
  stark_unter: 'bg-amber-300 dark:bg-amber-800',
};

export const HEATMAP_BUCKET_LABEL: Record<BankHeatmapBucket, string> = {
  deutlich_ueber: 'deutlich über Ø',
  leicht_ueber: 'leicht über Ø',
  durchschnitt: 'im Ø',
  unter: 'unter Ø',
  stark_unter: 'deutlich unter Ø',
};

/** ISO-Datum → de-CH Kurzformat (null = „—"). */
export function fmtDateCH(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Einheitlicher Karten-Rahmen für Analyse-Sektionen. */
export function SectionCard({
  title, info, testId, children, actions,
}: {
  title: string;
  info?: React.ReactNode;
  testId: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">{title}{info}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
