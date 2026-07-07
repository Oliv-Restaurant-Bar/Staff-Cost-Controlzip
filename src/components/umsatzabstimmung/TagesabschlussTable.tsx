/**
 * TagesabschlussTable.tsx — Monats-Tabelle der Tagesabschlüsse.
 * ===========================================================================
 * Spalten analog Excel "UMSATZ Oliv" / Sheet "Buchung". Visuelle Marker:
 * auto = normal, manuell = blau/fett, korrigiert = gelb hinterlegt,
 * Kommentar = Icon, Kassen-Differenz = grün/orange/rot (Adyen-Ampel).
 * Barausgaben erscheinen hier NUR als Tages-Total.
 *
 * Inline-Bearbeitung (nur wenn NICHT readOnly und Callbacks vorhanden):
 * Bestand Kasse, Einzahlung Bank und Bemerkung sind direkt in der Zeile
 * editierbar (persistiert bei Blur/Enter, Escape verwirft); die Bestätigungs-
 * Checkboxen (Barbestand / Tag) schreiben in den gemeinsamen Adyen-Store.
 * Das Tagesdetail öffnet sich NUR über einen Klick auf das Datum.
 */

import { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import type { DayConfirmation } from '@/lib/adyen-abstimmung';
import {
  type DayCell,
  type TagesabschlussRow,
  type TagesabschlussTotals,
} from '@/lib/tagesabschluss';
import { fmtChf, diffColorClass, parseAmountInput } from './adyen-ui';

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

// ── Inline-Editoren ───────────────────────────────────────────────────────────
// Lokaler Entwurfs-State, Commit bei Blur/Enter, Escape verwirft (kein Save).
// Gespeichert wird NUR bei echter Änderung (Vergleich gegen den Zellenwert).

const INLINE_INPUT_BASE =
  'h-6 w-20 rounded border border-input bg-background px-1 text-right text-xs tabular-nums ' +
  'focus:outline-none focus:ring-1 focus:ring-ring';

function InlineAmountInput({ value, manual, onCommit, testId, ariaLabel }: {
  value: number | null;
  manual: boolean;
  onCommit: (next: number | null) => void;
  testId: string;
  ariaLabel: string;
}) {
  const toText = (v: number | null) => (v === null ? '' : String(v));
  const [text, setText] = useState(() => toText(value));
  const escaped = useRef(false);
  useEffect(() => { setText(toText(value)); }, [value]);

  const commit = () => {
    const parsed = parseAmountInput(text);
    if (parsed === null && text.trim() !== '') { setText(toText(value)); return; } // unlesbar → verwerfen
    if (parsed === value) { setText(toText(value)); return; } // unverändert → kein Save
    onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      className={`${INLINE_INPUT_BASE} ${manual ? 'text-sky-700 dark:text-sky-400 font-medium' : ''}`}
      value={text}
      aria-label={ariaLabel}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        if (escaped.current) { escaped.current = false; return; }
        commit();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') {
          escaped.current = true;
          setText(toText(value));
          e.currentTarget.blur();
        }
      }}
      data-testid={testId}
    />
  );
}

function InlineTextInput({ value, onCommit, testId, ariaLabel }: {
  value: string | null;
  onCommit: (next: string | null) => void;
  testId: string;
  ariaLabel: string;
}) {
  const [text, setText] = useState(() => value ?? '');
  const escaped = useRef(false);
  useEffect(() => { setText(value ?? ''); }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === (value ?? '')) { setText(value ?? ''); return; }
    onCommit(trimmed === '' ? null : trimmed);
  };

  return (
    <input
      type="text"
      className={`h-6 w-full min-w-[120px] rounded border border-input bg-background px-1 text-xs ${
        value ? 'text-sky-700 dark:text-sky-400' : ''
      } focus:outline-none focus:ring-1 focus:ring-ring`}
      value={text}
      aria-label={ariaLabel}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        if (escaped.current) { escaped.current = false; return; }
        commit();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') {
          escaped.current = true;
          setText(value ?? '');
          e.currentTarget.blur();
        }
      }}
      data-testid={testId}
    />
  );
}

const HEADERS = [
  'Datum', 'Umsatz', 'Netto', 'MWST', 'Bargeld / Barumsatz', 'Bestand Kasse',
  'Kreditkarten / Adyen / SIX', 'TWINT', 'Karten/TWINT laut Adyen', 'Adyen-Differenz',
  'Rechnung / Debitoren', 'Verkaufte Gutscheine', 'Eingelöste Gutscheine',
  'Barausgaben total', 'Einzahlung Bank', 'Bemerkung', 'Status',
];

interface TagesabschlussTableProps {
  rows: TagesabschlussRow[];
  totals: TagesabschlussTotals;
  /** Öffnet das Tagesdetail — NUR über die Datum-Zelle erreichbar. */
  onDayClick: (date: string) => void;
  /** Gäste-Modus: keinerlei Eingaben. */
  readOnly?: boolean;
  /** Inline-Save einzelner manueller Felder (nur vorhandene Keys werden angefasst). */
  onSaveManual?: (date: string, patch: {
    bestandKasse?: number | null; einzahlungBank?: number | null; bemerkung?: string | null;
  }) => void;
  /** Bestätigung (gemeinsamer Adyen-Store), identische Semantik wie im Dialog. */
  onConfirm?: (date: string, confirmation: DayConfirmation | null) => void;
}

export function TagesabschlussTable({
  rows, totals, onDayClick, readOnly = false, onSaveManual, onConfirm,
}: TagesabschlussTableProps) {
  const editable = !readOnly && !!onSaveManual;
  const confirmable = !readOnly && !!onConfirm;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 text-muted-foreground">
            {HEADERS.map((h, i) => (
              <th key={h} className={`px-2 py-1.5 font-medium whitespace-nowrap ${i === 0 || i >= 15 ? 'text-left' : 'text-right'}`}>
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
            const confirmation = row.confirmation ?? null;
            const cashCounted = confirmation?.cashCounted === true;
            const confirmed = confirmation?.confirmed === true;
            return (
              <tr
                key={row.date}
                className="border-t border-border hover:bg-accent/40"
                data-testid={`ta-row-${row.date}`}
              >
                <td className="px-2 py-1 whitespace-nowrap font-medium">
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-primary cursor-pointer"
                    onClick={() => onDayClick(row.date)}
                    title="Tagesdetail öffnen"
                    data-testid={`ta-date-${row.date}`}
                  >
                    {dayLabel(row.date)}
                  </button>
                </td>
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
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${editable ? '' : cellClasses(row.cells.bestandKasse)} ${diffColorClass(row.kassenDiffStatus)}`}
                    title={diffTitle} data-testid={`ta-bestand-${row.date}`}>
                  {editable ? (
                    <span className="inline-flex items-center gap-1">
                      <InlineAmountInput
                        value={row.cells.bestandKasse.value}
                        manual={row.cells.bestandKasse.source === 'manual'}
                        onCommit={v => onSaveManual!(row.date, { bestandKasse: v })}
                        testId={`ta-input-bestand-${row.date}`}
                        ariaLabel={`Bestand Kasse ${row.date}`}
                      />
                      {row.kassenDiff !== null && row.kassenDiffStatus !== 'ok' && (
                        <span className="text-[10px]">({fmtChf(row.kassenDiff)})</span>
                      )}
                    </span>
                  ) : (
                    <>
                      {row.cells.bestandKasse.value === null
                        ? <span className="text-muted-foreground">—</span>
                        : fmtChf(row.cells.bestandKasse.value)}
                      {row.kassenDiff !== null && row.kassenDiffStatus !== 'ok' && (
                        <span className="ml-1 text-[10px]">({fmtChf(row.kassenDiff)})</span>
                      )}
                    </>
                  )}
                </td>
                <ValueCell cell={row.cells.karten} />
                <ValueCell cell={row.cells.twint} />
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                    title={row.hasAdyen ? undefined : 'Kein Adyen-Import für diesen Tag'}
                    data-testid={`ta-adyen-${row.date}`}>
                  {row.adyenTotal === null
                    ? <span className="text-muted-foreground">—</span>
                    : fmtChf(row.adyenTotal)}
                </td>
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${diffColorClass(row.adyenDiffStatus)}`}
                    title={row.adyenDiff !== null ? `Karten/TWINT laut Z-Bericht − laut Adyen = ${fmtChf(row.adyenDiff)}` : undefined}
                    data-testid={`ta-adyen-diff-${row.date}`}>
                  {row.adyenDiff === null
                    ? <span className="text-muted-foreground">—</span>
                    : fmtChf(row.adyenDiff)}
                </td>
                <ValueCell cell={row.cells.rechnung} />
                <ValueCell cell={row.cells.gutscheinVerkauft} />
                <ValueCell cell={row.cells.gutscheinEingeloest} />
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                  {row.expenseCount > 0
                    ? <span className="font-medium">{fmtChf(row.barausgabenTotal)} <span className="text-[10px] text-muted-foreground">({row.expenseCount})</span></span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
                {editable ? (
                  <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${row.cells.einzahlungBank.source === 'corrected' ? cellClasses(row.cells.einzahlungBank) : ''}`}>
                    <span className="inline-flex items-center gap-1">
                      {row.cells.einzahlungBank.comment && (
                        <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Kommentar" />
                      )}
                      <InlineAmountInput
                        value={row.cells.einzahlungBank.value}
                        manual={row.cells.einzahlungBank.source === 'manual'}
                        onCommit={v => onSaveManual!(row.date, { einzahlungBank: v })}
                        testId={`ta-input-einzahlung-${row.date}`}
                        ariaLabel={`Einzahlung Bank ${row.date}`}
                      />
                    </span>
                  </td>
                ) : (
                  <ValueCell cell={row.cells.einzahlungBank} />
                )}
                {editable ? (
                  <td className="px-2 py-1 min-w-[130px] max-w-[200px]" title={row.bemerkung ?? undefined}>
                    <InlineTextInput
                      value={row.bemerkung ?? null}
                      onCommit={v => onSaveManual!(row.date, { bemerkung: v })}
                      testId={`ta-input-bemerkung-${row.date}`}
                      ariaLabel={`Bemerkung ${row.date}`}
                    />
                  </td>
                ) : (
                  <td className="px-2 py-1 max-w-[160px] truncate text-muted-foreground" title={row.bemerkung ?? undefined}>
                    {row.bemerkung ?? ''}
                  </td>
                )}
                <td className="px-2 py-1 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={row.status} />
                    {confirmable && row.hasZbericht && (
                      <span className="inline-flex items-center gap-1.5">
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Barbestand gezählt und bestätigt">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={cashCounted}
                            onCheckedChange={v => onConfirm!(row.date, {
                              confirmed: confirmed && v === true,
                              cashCounted: v === true,
                              ...(confirmation?.confirmedAt ? { confirmedAt: confirmation.confirmedAt } : {}),
                              ...(confirmation?.comment ? { comment: confirmation.comment } : {}),
                            })}
                            data-testid={`ta-row-check-cash-${row.date}`}
                          />
                          Bar
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Tag bestätigt (abgeschlossen) — erst nach bestätigtem Barbestand">
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={confirmed}
                            disabled={!cashCounted}
                            onCheckedChange={v => onConfirm!(row.date, {
                              confirmed: v === true,
                              cashCounted,
                              ...(v === true ? { confirmedAt: new Date().toISOString() } : {}),
                              ...(confirmation?.comment ? { comment: confirmation.comment } : {}),
                            })}
                            data-testid={`ta-row-check-confirm-${row.date}`}
                          />
                          Tag
                        </label>
                      </span>
                    )}
                  </div>
                </td>
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
            <td className="px-2 py-1.5 text-right tabular-nums" data-testid="ta-total-adyen">{fmtChf(totals.adyenTotal)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums" data-testid="ta-total-adyen-diff"
                title="Summe der Tages-Differenzen (Vorzeichen können sich aufheben)">
              {fmtChf(totals.adyenDiff)}
            </td>
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
