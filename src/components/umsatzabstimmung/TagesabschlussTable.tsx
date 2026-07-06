/**
 * TagesabschlussTable.tsx — Monats-Tabelle der Tagesabschlüsse (nur Anzeige).
 * ===========================================================================
 * Spalten analog Excel "UMSATZ Oliv" / Sheet "Buchung". Visuelle Marker:
 * auto = normal, manuell = blau/fett, korrigiert = gelb hinterlegt,
 * Kommentar = Icon, Kassen-Differenz = grün/orange/rot (Adyen-Ampel).
 * Barausgaben erscheinen hier NUR als Tages-Total.
 */

import { MessageSquare } from 'lucide-react';
import {
  type DayCell,
  type TagesabschlussRow,
  type TagesabschlussTotals,
} from '@/lib/tagesabschluss';
import { fmtChf, diffColorClass } from './adyen-ui';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

function cellClasses(cell: DayCell): string {
  if (cell.source === 'corrected') return 'bg-amber-100 dark:bg-amber-900/30 font-medium';
  if (cell.source === 'manual') return 'text-sky-700 dark:text-sky-400 font-medium';
  return '';
}

function ValueCell({ cell, title }: { cell: DayCell; title?: string }) {
  return (
    <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${cellClasses(cell)}`} title={title}>
      <span className="inline-flex items-center gap-1">
        {cell.comment && <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Kommentar" />}
        {cell.value === null ? <span className="text-muted-foreground">—</span> : fmtChf(cell.value)}
      </span>
    </td>
  );
}

function StatusBadge({ status }: { status: TagesabschlussRow['status'] }) {
  if (status === 'bestaetigt') {
    return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">Bestätigt</span>;
  }
  if (status === 'offen') {
    return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">Offen</span>;
  }
  return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">Kein Z-Bericht</span>;
}

const HEADERS = [
  'Datum', 'Umsatz', 'Netto', 'MWST', 'Bargeld / Barumsatz', 'Bestand Kasse',
  'Kreditkarten / Adyen / SIX', 'TWINT', 'Rechnung / Debitoren',
  'Verkaufte Gutscheine', 'Eingelöste Gutscheine', 'Barausgaben total',
  'Einzahlung Bank', 'Bemerkung', 'Status',
];

interface TagesabschlussTableProps {
  rows: TagesabschlussRow[];
  totals: TagesabschlussTotals;
  onDayClick: (date: string) => void;
}

export function TagesabschlussTable({ rows, totals, onDayClick }: TagesabschlussTableProps) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 text-muted-foreground">
            {HEADERS.map((h, i) => (
              <th key={h} className={`px-2 py-1.5 font-medium whitespace-nowrap ${i === 0 || i >= 13 ? 'text-left' : 'text-right'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const diffTitle = row.kassenDiff !== null
              ? `Kassen-Differenz: ${fmtChf(row.kassenDiff)} (Bestand-Delta − erwartete Bewegung)`
              : undefined;
            return (
              <tr
                key={row.date}
                className="border-t border-border hover:bg-accent/40 cursor-pointer"
                onClick={() => onDayClick(row.date)}
                data-testid={`ta-row-${row.date}`}
              >
                <td className="px-2 py-1 whitespace-nowrap font-medium">{dayLabel(row.date)}</td>
                <ValueCell cell={row.cells.umsatz} />
                <ValueCell cell={row.cells.netto} />
                <ValueCell cell={row.cells.mwst} />
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${cellClasses(row.cells.bar)}`}
                    title={row.barumsatz !== null ? `Rechnerischer Barumsatz: ${fmtChf(row.barumsatz)}` : undefined}>
                  {row.cells.bar.value !== null
                    ? fmtChf(row.cells.bar.value)
                    : row.barumsatz !== null
                      ? <span className="text-muted-foreground">({fmtChf(row.barumsatz)})</span>
                      : <span className="text-muted-foreground">—</span>}
                </td>
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${cellClasses(row.cells.bestandKasse)} ${diffColorClass(row.kassenDiffStatus)}`}
                    title={diffTitle} data-testid={`ta-bestand-${row.date}`}>
                  {row.cells.bestandKasse.value === null
                    ? <span className="text-muted-foreground">—</span>
                    : fmtChf(row.cells.bestandKasse.value)}
                  {row.kassenDiff !== null && row.kassenDiffStatus !== 'ok' && (
                    <span className="ml-1 text-[10px]">({fmtChf(row.kassenDiff)})</span>
                  )}
                </td>
                <ValueCell cell={row.cells.karten} />
                <ValueCell cell={row.cells.twint} />
                <ValueCell cell={row.cells.rechnung} />
                <ValueCell cell={row.cells.gutscheinVerkauft} />
                <ValueCell cell={row.cells.gutscheinEingeloest} />
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                  {row.expenseCount > 0
                    ? <span className="font-medium">{fmtChf(row.barausgabenTotal)} <span className="text-[10px] text-muted-foreground">({row.expenseCount})</span></span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                <ValueCell cell={row.cells.einzahlungBank} />
                <td className="px-2 py-1 max-w-[160px] truncate text-muted-foreground" title={row.bemerkung}>
                  {row.bemerkung ?? ''}
                </td>
                <td className="px-2 py-1 whitespace-nowrap"><StatusBadge status={row.status} /></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/40 font-semibold">
            <td className="px-2 py-1.5">Total</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.umsatz)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.netto)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.mwst)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums" title="Summe Bar laut Kasse; rechnerischer Barumsatz in Klammern">
              {fmtChf(totals.values.bar)} <span className="text-[10px] text-muted-foreground">({fmtChf(totals.barumsatz)})</span>
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums" title="Letzter erfasster Bestand (kein Summentotal)">
              {fmtChf(totals.values.bestandKasse)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.karten)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.twint)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.rechnung)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.gutscheinVerkauft)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.gutscheinEingeloest)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums" data-testid="ta-total-barausgaben">{fmtChf(totals.barausgaben)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.einzahlungBank)}</td>
            <td className="px-2 py-1.5 text-muted-foreground" colSpan={2}>
              {totals.daysConfirmed}/{totals.daysWithZbericht} Tage bestätigt
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
