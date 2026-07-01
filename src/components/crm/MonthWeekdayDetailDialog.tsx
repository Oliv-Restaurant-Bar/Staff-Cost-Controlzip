/**
 * Detail-Popup für eine Zelle des Monatsvergleichs (Wochentag × Monat).
 * ====================================================================
 * Erklärt, wie sich die grosse Zahl einer Matrix-Zelle zusammensetzt (z. B.
 * „Montag im Oktober 2025"):
 *   1. Titel + modusabhängiger Untertitel
 *   2. Kennzahl-Zusammensetzung (Formel mit Zahlen)
 *   3. Tabelle der konkreten Kalendertage (Datum · Res. · Pers. · Ø Pers/Res)
 *   4. 2–3 automatische Hinweise
 *   5. Vergleich zum Durchschnitt dieses Wochentags über alle Monate
 *
 * Schliessbar über X und Escape (shadcn `Dialog`), mobil gut lesbar. Reine
 * Anzeige — KEINE neue Tabelle, KEINE Migration, KEINE Schreiboperation.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  WEEKDAY_LABEL,
  monthLongLabel,
  formatIsoDateDe,
  buildDetailFormula,
  buildDetailInsights,
  buildDetailComparison,
  headlineUnit,
  type MonthWeekdayDetail,
  type MetricKey,
} from '@/lib/reservation-weekday-analytics';

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function num1(n: number | null): string {
  return n === null ? '—' : NUM1.format(n);
}

/** Modusabhängiger Untertitel („Ø … pro <Wochentag>"). */
function detailSubtitle(detail: MonthWeekdayDetail, metric: MetricKey): string {
  const wd = WEEKDAY_LABEL[detail.weekday];
  switch (metric) {
    case 'persons':
      return `Ø Personen pro ${wd}`;
    case 'avgPersons':
      return `Ø Personen pro Reservation am ${wd}`;
    case 'reservations':
    default:
      return `Ø Reservationen pro ${wd}`;
  }
}

/** Kurze Einheit für die Differenz-Zeile im Vergleich. */
function diffUnit(metric: MetricKey): string {
  switch (metric) {
    case 'persons':
      return 'Personen';
    case 'avgPersons':
      return 'Personen pro Reservation';
    case 'reservations':
    default:
      return 'Reservationen';
  }
}

/** Vorzeichenbehaftete Differenz (U+2212 als Minus, „±0.0" bei 0). */
function signedDiff(diff: number): string {
  if (diff > 0) return `+${NUM1.format(diff)}`;
  if (diff < 0) return `\u2212${NUM1.format(Math.abs(diff))}`;
  return '\u00B10.0';
}

export interface MonthWeekdayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: MonthWeekdayDetail | null;
  metric: MetricKey;
  /** Ø dieses Wochentags über alle Zeiträume (= Spalten-Ø). */
  columnAverage: number | null;
  /**
   * Bezeichnung des Vergleichs-Bezugs, z. B. „über alle Monate" (Standard) oder
   * „über alle Ferienperioden". Nur Anzeige — ändert keine Berechnung.
   */
  columnAverageLabel?: string;
  /** Hinweis, wenn kein Vergleichswert existiert (nur ein Zeitraum). */
  singleColumnLabel?: string;
}

export function MonthWeekdayDetailDialog({
  open,
  onOpenChange,
  detail,
  metric,
  columnAverage,
  columnAverageLabel = 'über alle Monate',
  singleColumnLabel = 'nur ein Monat im Zeitraum',
}: MonthWeekdayDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        {detail && (
          <DetailBody
            detail={detail}
            metric={metric}
            columnAverage={columnAverage}
            columnAverageLabel={columnAverageLabel}
            singleColumnLabel={singleColumnLabel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({
  detail,
  metric,
  columnAverage,
  columnAverageLabel,
  singleColumnLabel,
}: {
  detail: MonthWeekdayDetail;
  metric: MetricKey;
  columnAverage: number | null;
  columnAverageLabel: string;
  singleColumnLabel: string;
}) {
  const wdLabel = WEEKDAY_LABEL[detail.weekday];
  const month = detail.label ?? monthLongLabel(detail.monthKey);
  const formula = buildDetailFormula(detail, metric);
  const insights = buildDetailInsights(detail, metric, columnAverage);
  const cmp = buildDetailComparison(detail, metric, columnAverage);
  const unit = headlineUnit(detail.weekday, metric);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Details: {wdLabel} im {month}
        </DialogTitle>
        <DialogDescription>{detailSubtitle(detail, metric)}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* 1) Kennzahl-Zusammensetzung */}
        <section className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Zusammensetzung
          </p>
          <ul className="space-y-1 text-sm">
            {formula.lines.map((line, i) => (
              <li
                key={i}
                className={
                  i === formula.lines.length - 1
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground'
                }
              >
                {line}
              </li>
            ))}
          </ul>
        </section>

        {/* 2) Konkrete Kalendertage */}
        <section>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Einzelne {wdLabel}e
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Datum</th>
                  <th className="px-2 py-2 text-right">Res.</th>
                  <th className="px-2 py-2 text-right">Pers.</th>
                  <th className="px-3 py-2 text-right">Ø Pers/Res</th>
                </tr>
              </thead>
              <tbody>
                {detail.days.map((d) => (
                  <tr key={d.date} className="border-t border-border">
                    <td className="whitespace-nowrap px-3 py-1.5 text-left">{formatIsoDateDe(d.date)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{NUM0.format(d.reservations)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{NUM0.format(d.persons)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{num1(d.avgPersonsPerReservation)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/40 font-medium">
                  <td className="px-3 py-1.5 text-left">Total</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{NUM0.format(detail.reservations)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{NUM0.format(detail.persons)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {num1(detail.avgPersonsPerReservation)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* 3) Automatische Hinweise */}
        {insights.length > 0 && (
          <section>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Interpretation
            </p>
            <ul className="space-y-1 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              {insights.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="text-blue-400">
                    •
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 4) Vergleich zum Durchschnitt dieses Wochentags über alle Monate */}
        <section className="rounded-lg border border-border p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Vergleich zum Durchschnitt
          </p>
          <div className="space-y-1 text-sm">
            <p>
              {month} {wdLabel}:{' '}
              <span className="font-medium tabular-nums">Ø {num1(cmp.cellValue)}</span> {unit}
            </p>
            <p className="text-muted-foreground">
              Durchschnitt {wdLabel} {columnAverageLabel}:{' '}
              <span className="font-medium tabular-nums text-foreground">Ø {num1(cmp.columnAverage)}</span> {unit}
            </p>
            {cmp.difference !== null && cmp.direction !== null ? (
              <p>
                Differenz:{' '}
                <span
                  className={
                    cmp.direction === 'above'
                      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                      : cmp.direction === 'below'
                        ? 'font-semibold text-red-600 dark:text-red-400'
                        : 'font-semibold text-foreground'
                  }
                >
                  {signedDiff(cmp.difference)} {diffUnit(metric)}
                </span>{' '}
                <span className="text-muted-foreground">
                  (
                  {cmp.direction === 'above'
                    ? 'über Durchschnitt'
                    : cmp.direction === 'below'
                      ? 'unter Durchschnitt'
                      : 'im Durchschnitt'}
                  )
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                Kein Vergleichswert verfügbar ({singleColumnLabel}).
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
