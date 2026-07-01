/**
 * SeasonComparisonSection — Multi-Saison-Auswertung (nur Anzeige)
 * ===============================================================
 * Ergänzt den (bereits vom Wochentagsvergleich gerenderten) Saison-Vergleich um
 * drei Ansichten: ein Liniendiagramm (eine Linie je Saison, X = Mo–So), eine
 * Rangliste je Wochentag (welche Saison ist wo am stärksten) und automatische
 * Empfehlungen. Alle Daten kommen fertig berechnet aus `reservation-weekday-
 * analytics` — KEINE Berechnung hier, KEINE Migration, reine Darstellung.
 */
import type { ComponentType, ReactNode } from 'react';
import { Trophy, LineChart as LineChartIcon, Lightbulb } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  WEEKDAY_LABEL,
  METRIC_LABEL,
  type MetricKey,
  type IsoWeekday,
  type SeasonWeekdayRanking,
  type SeasonChartPoint,
  type SeasonChartSeries,
} from '@/lib/reservation-weekday-analytics';

const NUM1 = new Intl.NumberFormat('de-CH', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Fallback-Farben, wenn eine Saison keine eigene Farbe hat. */
const DEFAULT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
];

function SectionTitle({ icon: Icon, children }: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
      <Icon className="h-5 w-5 text-primary" />
      {children}
    </h2>
  );
}

export interface SeasonComparisonSectionProps {
  ranking: SeasonWeekdayRanking[];
  chart: { points: SeasonChartPoint[]; series: SeasonChartSeries[] };
  recommendations: string[];
  metric: MetricKey;
  /** Saison-ID → Farbe (Hex). Fehlende Farben fallen auf DEFAULT_COLORS zurück. */
  colorMap: Record<string, string>;
  /**
   * Klick auf einen Diagrammpunkt / Ranglisten-Eintrag (Saison × Wochentag) →
   * öffnet das bestehende Detail-Popup. Optional; ohne Handler nicht anklickbar.
   */
  onSelect?: (seasonKey: string, weekday: IsoWeekday) => void;
}

export function SeasonComparisonSection({
  ranking,
  chart,
  recommendations,
  metric,
  colorMap,
  onSelect,
}: SeasonComparisonSectionProps) {
  const seriesIndex = new Map(chart.series.map((s, i) => [s.key, i]));
  const colorFor = (key: string) =>
    colorMap[key] ?? DEFAULT_COLORS[(seriesIndex.get(key) ?? 0) % DEFAULT_COLORS.length];

  // Recharts feuert `<Line onClick>` OHNE Punkt-Payload (nur die Kurve). Damit ein
  // Klick auf einen konkreten Punkt (Saison × Wochentag) das Detail-Popup öffnet,
  // rendern wir eigene Punkte: `payload.weekday` liegt hier vor. Ohne `onSelect`
  // bleiben die Punkte einfache, nicht-klickbare Kreise.
  const renderDot =
    (key: string, radius: number) =>
    (props: {
      cx?: number;
      cy?: number;
      index?: number;
      value?: number | null;
      payload?: { weekday?: IsoWeekday };
    }) => {
      const { cx, cy, value, payload } = props;
      const dotKey = `${key}-${props.index ?? 0}`;
      if (
        cx === undefined ||
        cy === undefined ||
        !Number.isFinite(cx) ||
        !Number.isFinite(cy) ||
        value === null ||
        value === undefined
      ) {
        return <g key={dotKey} />;
      }
      const clickable = Boolean(onSelect);
      return (
        <circle
          key={dotKey}
          cx={cx}
          cy={cy}
          r={radius}
          fill={colorFor(key)}
          stroke="#fff"
          strokeWidth={1}
          className={clickable ? 'cursor-pointer' : undefined}
          onClick={
            clickable
              ? () => {
                  const wd = payload?.weekday;
                  if (wd) onSelect!(key, wd);
                }
              : undefined
          }
        />
      );
    };

  // Recharts-Datensatz: ein Objekt je Wochentag mit einem Feld je Saison-ID.
  // `weekday` reist mit, damit der Punkt-Klick den Wochentag kennt.
  const data = chart.points.map((p) => {
    const row: Record<string, number | string | null> = { label: p.label, weekday: p.weekday };
    for (const s of chart.series) row[s.key] = p.values[s.key];
    return row;
  });

  return (
    <div className="space-y-6">
      {/* ── Liniendiagramm ─────────────────────────────────────────────────── */}
      <section>
        <SectionTitle icon={LineChartIcon}>Saisonvergleich nach Wochentag</SectionTitle>
        <p className="mb-2 text-xs text-muted-foreground">
          Eine Linie je Saison; X-Achse Mo–So, Y-Achse{' '}
          <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>{' '}
          als Durchschnitt pro Wochentag.
        </p>
        <div className="h-72 w-full rounded-lg border border-border bg-card p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(v: number | string | null) =>
                  v === null || v === undefined ? '–' : NUM1.format(Number(v))
                }
              />
              <Legend />
              {chart.series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={colorFor(s.key)}
                  strokeWidth={2}
                  dot={renderDot(s.key, 3.5)}
                  activeDot={renderDot(s.key, 5.5)}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ── Rangliste je Wochentag ─────────────────────────────────────────── */}
      <section>
        <SectionTitle icon={Trophy}>Rangliste je Wochentag</SectionTitle>
        <p className="mb-2 text-xs text-muted-foreground">
          Welche Saison ist an welchem Wochentag am stärksten? (Kennzahl:{' '}
          <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>)
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ranking.map((r) => (
            <div key={r.weekday} className="rounded-lg border border-border bg-card p-3">
              <p className="mb-2 text-sm font-medium">{WEEKDAY_LABEL[r.weekday]}</p>
              {r.entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">Keine Daten.</p>
              ) : (
                <ol className="space-y-1">
                  {r.entries.map((e, idx) => {
                    const inner = (
                      <>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">
                            {idx + 1}.
                          </span>
                          <span
                            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: colorFor(e.seasonKey) }}
                          />
                          <span className="truncate">{e.label}</span>
                        </span>
                        <span className="font-medium tabular-nums">{NUM1.format(e.value)}</span>
                      </>
                    );
                    return (
                      <li key={e.seasonKey}>
                        {onSelect ? (
                          <button
                            type="button"
                            onClick={() => onSelect(e.seasonKey, r.weekday)}
                            className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60"
                            title="Details anzeigen"
                          >
                            {inner}
                          </button>
                        ) : (
                          <div className="flex items-center justify-between gap-2 text-sm">
                            {inner}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Empfehlungen ───────────────────────────────────────────────────── */}
      {recommendations.length > 0 && (
        <section>
          <SectionTitle icon={Lightbulb}>Empfehlungen</SectionTitle>
          <ul className="space-y-1.5 rounded-lg border border-border bg-card p-4 text-sm">
            {recommendations.map((r) => (
              <li key={r} className="flex items-start gap-2">
                <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
