/**
 * TagesabschlussTable.tsx — Monats-Tabelle der Tagesabschlüsse.
 * ===========================================================================
 * Spalten nach realem Arbeitsablauf in 6 visuell getrennten Gruppen:
 *   Umsatz (Datum, Umsatz) · Kartenzahlungen (KK, KK Adyen) ·
 *   Kasse (Bargeld Soll, Einzahlung Bank, Kassensaldo Soll, Cash Ist,
 *   Cash Diff) · Weitere Zahlungsarten (Debitoren, Verkaufte/Eingelöste
 *   Gutscheine) · Ausgaben (Barausgaben) · Status.
 * Bargeld Soll = berechnet (Umsatz − KK − Rechnung − Barausgaben −
 * eingelöste Gutscheine + verkaufte Gutscheine), read-only mit Tooltip
 * (zeigt zusätzlich Bar laut Z-Bericht).
 * Kassensaldo Soll = fortlaufend (Saldo Vortag + Bargeld Soll − Einzahlung
 * Bank); „—" solange kein Anfangsbestand-Anker bekannt ist.
 * Cash Ist = manuell gezählter Kassenbestand (inline editierbar, blau).
 * Cash Diff = Ist − Kassensaldo Soll, farbig (Ampel wie Adyen); „—" solange
 * Ist oder Saldo fehlt. Nicht-grüne Differenzen können BEGRÜNDET werden
 * (onReasonsClick → Grund-Dialog): Badge „Begründet" mit Tooltip der Gründe.
 * TWINT wird intern weiter verarbeitet (Barumsatz/Export), erscheint aber
 * nicht mehr als eigene Spalte; die Adyen-Differenz steckt farbig in
 * „KK Adyen" (Wert + Klammer-Diff + Tooltip). Bemerkung/Gutscheinnummern
 * nur im Tagesdetail (Icon am Datum zeigt eine vorhandene Bemerkung).
 *
 * Visuelle Marker: auto = normal, manuell = blau/fett, korrigiert = gelb
 * hinterlegt, negativ = rot, Kommentar = Icon. Zeilen: Zebra, hover,
 * bestätigt = grün (auch „mit Differenz"), Differenz = rot/orange,
 * offen = gelb, heute = Akzent.
 *
 * Inline-Bearbeitung (nur wenn NICHT readOnly und Callbacks vorhanden):
 * Cash Ist (Bestand Kasse) und Einzahlung Bank direkt in der Zeile (persistiert
 * bei Blur/Enter, Escape verwirft). Debitoren ebenfalls inline — als
 * KORREKTUR des Z-Bericht-Werts (Override, gelb; Leereingabe entfernt die
 * Korrektur). Gutschein-Zellen öffnen den kleinen Gutschein-Dialog
 * (onVoucherClick), die Barausgaben-Zelle NUR den Barausgaben-Dialog
 * (onExpensesClick) — beides öffnet NIE das Tagesdetail.
 * Bestätigungs-Checkboxen (Barbestand/Tag) schreiben in den gemeinsamen
 * Adyen-Store. Das Tagesdetail öffnet sich NUR über einen Klick auf das
 * Datum (als Link gestaltet).
 */

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import type { DayConfirmation } from '@/lib/adyen-abstimmung';
import {
  cashDiffReasonLabel,
  type DayCell,
  type TagesabschlussManualPatch,
  type TagesabschlussRow,
  type TagesabschlussTotals,
} from '@/lib/tagesabschluss';
import { fmtChf, fmtDiffChf, diffColorClass, parseAmountInput } from './adyen-ui';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// ── Spaltengruppen (visuelle Trennung) ───────────────────────────────────────

/** Trennlinie am Beginn jeder Gruppe (auf Header-, Body- und Footer-Zellen). */
const SEP = 'border-l-2 border-border';

/** Fokus-Tint für Zellen mit Inline-Eingabe (aktive Eingabezelle). */
const EDIT_CELL_FOCUS = 'focus-within:bg-sky-100/70 dark:focus-within:bg-sky-900/30';

interface ColumnGroup {
  label: string;
  /** Spalten (Label + Ausrichtung); erste Spalte der Gruppe erhält SEP. */
  cols: { label: string; align: 'left' | 'right' }[];
  /** Header-Hintergrund der Gruppe (Gruppenzeile kräftiger, Spaltenzeile dezent). */
  head: string;
  sub: string;
}

export const TAGESABSCHLUSS_COLUMN_GROUPS: ColumnGroup[] = [
  {
    label: 'Umsatz',
    cols: [{ label: 'Datum', align: 'left' }, { label: 'Umsatz', align: 'right' }],
    head: 'bg-muted', sub: 'bg-muted/60',
  },
  {
    label: 'Kartenzahlungen',
    cols: [{ label: 'KK', align: 'right' }, { label: 'KK Adyen', align: 'right' }],
    head: 'bg-sky-100 dark:bg-sky-900/40', sub: 'bg-sky-50 dark:bg-sky-900/20',
  },
  {
    label: 'Kasse',
    cols: [
      { label: 'Bargeld Soll', align: 'right' },
      { label: 'Einzahlung Bank', align: 'right' },
      { label: 'Kassensaldo Soll', align: 'right' },
      { label: 'Cash Ist', align: 'right' },
      { label: 'Cash Diff', align: 'right' },
    ],
    head: 'bg-emerald-100 dark:bg-emerald-900/40', sub: 'bg-emerald-50 dark:bg-emerald-900/20',
  },
  {
    label: 'Weitere Zahlungsarten',
    cols: [
      { label: 'Debitoren', align: 'right' },
      { label: 'Verkaufte Gutscheine', align: 'right' },
      { label: 'Eingelöste Gutscheine', align: 'right' },
    ],
    head: 'bg-violet-100 dark:bg-violet-900/40', sub: 'bg-violet-50 dark:bg-violet-900/20',
  },
  {
    label: 'Ausgaben',
    cols: [{ label: 'Barausgaben', align: 'right' }],
    head: 'bg-orange-100 dark:bg-orange-900/40', sub: 'bg-orange-50 dark:bg-orange-900/20',
  },
  {
    label: 'Status',
    cols: [{ label: 'Status', align: 'left' }],
    head: 'bg-muted', sub: 'bg-muted/60',
  },
];

// ── Zellen-Darstellung ───────────────────────────────────────────────────────

/** Negative Beträge rot — hat Vorrang vor der blauen Manuell-Markierung. */
function amountColor(value: number | null, source: DayCell['source']): string {
  if (value !== null && value < 0) return 'text-red-600 dark:text-red-400 font-medium';
  if (source === 'manual') return 'text-sky-700 dark:text-sky-400 font-medium';
  return '';
}

function cellBg(cell: DayCell): string {
  return cell.source === 'corrected' ? 'bg-amber-100 dark:bg-amber-900/30 font-medium' : '';
}

function ValueCell({ cell, sep = false, title }: { cell: DayCell; sep?: boolean; title?: string }) {
  return (
    <td
      className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${sep ? `${SEP} pl-3` : ''} ${cellBg(cell)} ${amountColor(cell.value, cell.source)}`}
      title={title}
    >
      <span className="inline-flex items-center gap-1">
        {cell.comment && <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Kommentar" />}
        {cell.value === null ? <span className="text-muted-foreground">—</span> : fmtChf(cell.value)}
      </span>
    </td>
  );
}

/**
 * Klickbare Gutschein-Zelle — öffnet den kleinen Gutschein-Dialog.
 * Zeigt NUR den Betrag (Nummern/Kommentar bleiben im Dialog/Tagesdetail).
 */
function VoucherCell({ cell, label, onClick, testId }: {
  cell: DayCell;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${cellBg(cell)}`}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 rounded px-1 -mx-1 cursor-pointer underline decoration-dotted underline-offset-2 decoration-muted-foreground/60 hover:bg-accent hover:text-accent-foreground ${amountColor(cell.value, cell.source)}`}
        onClick={onClick}
        title={`${label} erfassen (Betrag, Nummern, Kommentar)`}
        data-testid={testId}
      >
        {cell.comment && <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Kommentar" />}
        {cell.value === null ? <span className="text-muted-foreground">—</span> : fmtChf(cell.value)}
      </button>
    </td>
  );
}

function StatusBadge({ status }: { status: TagesabschlussRow['status'] }) {
  if (status === 'bestaetigt') {
    return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">Bestätigt</span>;
  }
  if (status === 'bestaetigt_mit_differenz') {
    return (
      <span
        className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
        title="Abgeschlossen mit begründeter Kassendifferenz"
      >
        Mit Differenz
      </span>
    );
  }
  if (status === 'offen') {
    return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">Offen</span>;
  }
  return <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">Kein Z-Bericht</span>;
}

// ── Zeilen-Hintergrund (Zebra + Zustands-Tints) ──────────────────────────────

/**
 * Priorität: bestätigt (grün) > bestätigt mit Differenz (gelb) >
 * rote Differenz > orange Differenz > offen (rot) > Zebra.
 * Differenzen = Adyen- ODER Cash-Differenz.
 */
function rowTint(row: TagesabschlussRow, zebra: boolean): string {
  if (row.status === 'bestaetigt') return 'bg-green-50/70 dark:bg-green-950/20';
  if (row.status === 'bestaetigt_mit_differenz') return 'bg-yellow-50/70 dark:bg-yellow-950/20';
  const statuses = [row.adyenDiffStatus, row.cashDiffStatus];
  if (statuses.includes('large')) return 'bg-red-50/70 dark:bg-red-950/20';
  if (statuses.includes('small')) return 'bg-orange-50/70 dark:bg-orange-950/20';
  if (row.status === 'offen') return 'bg-red-50/50 dark:bg-red-950/15';
  return zebra ? 'bg-muted/20' : '';
}

// ── Inline-Editoren ───────────────────────────────────────────────────────────
// Lokaler Entwurfs-State, Commit bei Blur/Enter, Escape verwirft (kein Save).
// Gespeichert wird NUR bei echter Änderung (Vergleich gegen den Zellenwert).

const INLINE_INPUT_BASE =
  'h-6 w-20 rounded border border-input bg-background px-1 text-right text-xs tabular-nums ' +
  'focus:outline-none focus:ring-1 focus:ring-ring';

function InlineAmountInput({ value, manual, corrected = false, onCommit, testId, ariaLabel }: {
  value: number | null;
  manual: boolean;
  /** Korrektur eines Auto-Werts (Override) — gelb statt blau markiert. */
  corrected?: boolean;
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

  // Dezente Dauer-Markierung gespeicherter Eingaben: manuell = blau,
  // Korrektur (Override eines Z-Bericht-Werts) = gelb.
  const savedStyle = corrected
    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-400 dark:border-amber-700 font-medium'
    : manual
      ? 'text-sky-700 dark:text-sky-400 font-medium bg-sky-50 dark:bg-sky-900/20 border-sky-300 dark:border-sky-800'
      : '';

  return (
    <input
      type="text"
      inputMode="decimal"
      className={`${INLINE_INPUT_BASE} ${savedStyle}`}
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

interface TagesabschlussTableProps {
  rows: TagesabschlussRow[];
  totals: TagesabschlussTotals;
  /** Öffnet das Tagesdetail — NUR über die Datum-Zelle erreichbar. */
  onDayClick: (date: string) => void;
  /** Gäste-Modus: keinerlei Eingaben. */
  readOnly?: boolean;
  /** Inline-Save einzelner manueller Felder (nur vorhandene Keys werden angefasst). */
  onSaveManual?: (date: string, patch: TagesabschlussManualPatch) => void;
  /**
   * Inline-Korrektur Debitoren (Auto-Feld): corrected null = Korrektur
   * entfernen (Z-Bericht-Wert gilt wieder). prevComment = bestehender
   * Override-Kommentar, damit er beim erneuten Korrigieren erhalten bleibt.
   */
  onCorrectRechnung?: (date: string, original: number, corrected: number | null, prevComment: string | undefined) => void;
  /** Öffnet den kleinen Gutschein-Dialog (Betrag/Nummern/Kommentar) — NICHT das Tagesdetail. */
  onVoucherClick?: (date: string, kind: 'verkauft' | 'eingeloest') => void;
  /** Öffnet AUSSCHLIESSLICH den Barausgaben-Dialog — NICHT das Tagesdetail. */
  onExpensesClick?: (date: string) => void;
  /** Bestätigung (gemeinsamer Adyen-Store), identische Semantik wie im Dialog. */
  onConfirm?: (date: string, confirmation: DayConfirmation | null) => void;
  /** Öffnet den Differenzgrund-Dialog (Mehrfachauswahl + Notiz) für den Tag. */
  onReasonsClick?: (date: string) => void;
}

export function TagesabschlussTable({
  rows, totals, onDayClick, readOnly = false, onSaveManual,
  onCorrectRechnung, onVoucherClick, onExpensesClick, onConfirm, onReasonsClick,
}: TagesabschlussTableProps) {
  const editable = !readOnly && !!onSaveManual;
  const correctable = !readOnly && !!onCorrectRechnung;
  const voucherEditable = !readOnly && !!onVoucherClick;
  const expensesEditable = !readOnly && !!onExpensesClick;
  const confirmable = !readOnly && !!onConfirm;
  const reasonsEditable = !readOnly && !!onReasonsClick;
  const today = todayIso();

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          {/* Gruppenzeile — unterschiedliche Hintergründe je Gruppe. */}
          <tr data-testid="ta-header-groups">
            {TAGESABSCHLUSS_COLUMN_GROUPS.map((g, gi) => (
              <th
                key={g.label}
                colSpan={g.cols.length}
                className={`px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ${g.head} ${gi > 0 ? SEP : ''}`}
              >
                {g.label}
              </th>
            ))}
          </tr>
          {/* Spaltenzeile. */}
          <tr className="text-muted-foreground" data-testid="ta-header-cols">
            {TAGESABSCHLUSS_COLUMN_GROUPS.flatMap((g, gi) =>
              g.cols.map((c, ci) => (
                <th
                  key={c.label}
                  className={`px-2 py-1.5 font-medium whitespace-nowrap ${g.sub} ${c.align === 'left' ? 'text-left' : 'text-right'} ${gi > 0 && ci === 0 ? `${SEP} pl-3` : ''}`}
                >
                  {c.label}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const adyenTitle = row.adyenDiff !== null
              ? `Differenz KK laut Z-Bericht − laut Adyen: ${fmtDiffChf(row.adyenDiff)}`
              : row.hasAdyen ? undefined : 'Kein Adyen-Import für diesen Tag';
            const confirmation = row.confirmation ?? null;
            const cashCounted = confirmation?.cashCounted === true;
            const confirmed = confirmation?.confirmed === true;
            const isToday = row.date === today;
            return (
              <tr
                key={row.date}
                className={`border-t border-border hover:bg-accent/40 ${rowTint(row, idx % 2 === 1)}`}
                data-testid={`ta-row-${row.date}`}
                {...(isToday ? { 'data-today': 'true' } : {})}
              >
                {/* ── Gruppe Umsatz: Datum (Link zum Tagesdetail) + Umsatz ── */}
                <td className={`px-2 py-1 whitespace-nowrap font-medium ${isToday ? 'border-l-2 border-l-primary' : ''}`}>
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      className={`text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer ${isToday ? 'font-bold' : ''}`}
                      onClick={() => onDayClick(row.date)}
                      title="Tagesdetail öffnen"
                      data-testid={`ta-date-${row.date}`}
                    >
                      {dayLabel(row.date)}
                    </button>
                    {row.bemerkung && (
                      <span title={row.bemerkung} className="shrink-0">
                        <MessageSquare className="h-3 w-3 text-muted-foreground" aria-label="Bemerkung vorhanden" />
                      </span>
                    )}
                  </span>
                </td>
                <ValueCell cell={row.cells.umsatz} />

                {/* ── Gruppe Kartenzahlungen: KK (Karten inkl. TWINT laut
                    Z-Bericht — TWINT ohne eigene Spalte) + KK Adyen ── */}
                {(() => {
                  const k = row.cells.karten;
                  const t = row.cells.twint;
                  const kk = k.value === null && t.value === null
                    ? null
                    : Math.round(((k.value ?? 0) + (t.value ?? 0)) * 100) / 100;
                  const corrected = k.source === 'corrected' || t.source === 'corrected';
                  return (
                    <td
                      className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${SEP} pl-3 ${corrected ? 'bg-amber-100 dark:bg-amber-900/30 font-medium' : ''} ${kk !== null && kk < 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}
                      title={kk !== null
                        ? `Karten ${k.value === null ? '—' : fmtChf(k.value)} + TWINT ${t.value === null ? '—' : fmtChf(t.value)}`
                        : undefined}
                      data-testid={`ta-kk-${row.date}`}
                    >
                      {kk === null ? <span className="text-muted-foreground">—</span> : fmtChf(kk)}
                    </td>
                  );
                })()}
                <td
                  className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${row.adyenDiff !== null ? diffColorClass(row.adyenDiffStatus) : ''}`}
                  title={adyenTitle}
                  data-testid={`ta-adyen-${row.date}`}
                >
                  {row.adyenTotal === null
                    ? <span className="text-muted-foreground">—</span>
                    : (
                      <>
                        {fmtChf(row.adyenTotal)}
                        {row.adyenDiff !== null && row.adyenDiffStatus !== 'ok' && (
                          <span className="ml-1 text-[10px]">({fmtDiffChf(row.adyenDiff)})</span>
                        )}
                      </>
                    )}
                </td>

                {/* ── Gruppe Kasse: Bargeld Soll (berechnet) + Einzahlung Bank
                    + Kassensaldo Soll (fortlaufend) + Cash Ist (manuell)
                    + Cash Diff (inkl. Begründet-Badge) ── */}
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${SEP} pl-3 ${row.bargeldSoll !== null && row.bargeldSoll < 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}
                    title={`Bargeld Soll = Umsatz − KK − Rechnung − Barausgaben − eingelöste Gutscheine + verkaufte Gutscheine${row.cells.bar.value !== null ? ` · Bar laut Z-Bericht: ${fmtChf(row.cells.bar.value)}` : ''}`}
                    data-testid={`ta-bargeld-soll-${row.date}`}>
                  {row.bargeldSoll === null
                    ? <span className="text-muted-foreground">—</span>
                    : fmtChf(row.bargeldSoll)}
                </td>
                {editable ? (
                  <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${EDIT_CELL_FOCUS} ${row.cells.einzahlungBank.source === 'corrected' ? cellBg(row.cells.einzahlungBank) : ''}`}>
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
                {/* Kassensaldo Soll — fortlaufend, read-only (Formel im Tooltip). */}
                <td
                  className="px-2 py-1 text-right tabular-nums whitespace-nowrap text-muted-foreground"
                  title={row.kassensaldoSoll === null
                    ? 'Kassensaldo unbekannt — Anfangsbestand erfassen (Banner über der Tabelle)'
                    : 'Kassensaldo Soll = Saldo Vortag + Bargeld Soll − Einzahlung Bank'}
                  data-testid={`ta-saldo-${row.date}`}
                >
                  {row.kassensaldoSoll === null ? '—' : fmtChf(row.kassensaldoSoll)}
                </td>
                {/* Cash Ist — manuell gezählter Kassenbestand (inline, blau). */}
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${editable ? EDIT_CELL_FOCUS : cellBg(row.cells.bestandKasse) + ' ' + amountColor(row.cells.bestandKasse.value, row.cells.bestandKasse.source)}`}
                    title="Cash Ist = manuell gezählter Kassenbestand"
                    data-testid={`ta-bestand-${row.date}`}>
                  {editable ? (
                    <InlineAmountInput
                      value={row.cells.bestandKasse.value}
                      manual={row.cells.bestandKasse.source === 'manual'}
                      onCommit={v => onSaveManual!(row.date, { bestandKasse: v })}
                      testId={`ta-input-bestand-${row.date}`}
                      ariaLabel={`Cash Ist (gezählter Kassenbestand) ${row.date}`}
                    />
                  ) : (
                    row.cells.bestandKasse.value === null
                      ? <span className="text-muted-foreground">—</span>
                      : fmtChf(row.cells.bestandKasse.value)
                  )}
                </td>
                {/* Cash Diff = Ist − Kassensaldo Soll (Ampel); „—" solange Ist
                    oder Saldo fehlt. Nicht-grüne Differenzen: Begründet-Badge
                    (Tooltip = Gründe) bzw. „Begründen"-Button (Dialog). */}
                <td
                  className={`px-2 py-1 text-right tabular-nums whitespace-nowrap font-medium ${diffColorClass(row.cashDiffStatus)}`}
                  title={row.cashDiff !== null
                    ? `Cash Differenz = Cash Ist − Kassensaldo Soll: ${fmtDiffChf(row.cashDiff)}`
                    : 'Cash Differenz erst nach Erfassung von Cash Ist (und bekanntem Kassensaldo)'}
                  data-testid={`ta-cash-diff-${row.date}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {row.cashDiff === null
                      ? <span className="text-muted-foreground font-normal">—</span>
                      : fmtDiffChf(row.cashDiff)}
                    {row.cashDiffStatus !== null && row.cashDiffStatus !== 'ok' && (
                      row.cashDiffBegruendet ? (
                        <button
                          type="button"
                          className={`inline-block rounded px-1 py-0.5 text-[10px] font-medium bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300 ${reasonsEditable ? 'cursor-pointer hover:bg-teal-200 dark:hover:bg-teal-900/60' : 'cursor-default'}`}
                          onClick={reasonsEditable ? () => onReasonsClick!(row.date) : undefined}
                          title={[
                            ...row.cashDiffReasons.map(cashDiffReasonLabel),
                            ...(row.cashDiffNote ? [`Notiz: ${row.cashDiffNote}`] : []),
                          ].join('\n')}
                          data-testid={`ta-diff-begruendet-${row.date}`}
                        >
                          Begründet
                        </button>
                      ) : reasonsEditable ? (
                        <button
                          type="button"
                          className="inline-block rounded px-1 py-0.5 text-[10px] font-medium border border-current/40 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                          onClick={() => onReasonsClick!(row.date)}
                          title="Differenzgrund erfassen"
                          data-testid={`ta-diff-begruenden-${row.date}`}
                        >
                          Begründen
                        </button>
                      ) : null
                    )}
                  </span>
                </td>

                {/* ── Gruppe Weitere Zahlungsarten: Debitoren inline (Korrektur
                    des Z-Bericht-Werts), Gutscheine öffnen den Gutschein-Dialog ── */}
                {correctable ? (
                  <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${SEP} pl-3 ${EDIT_CELL_FOCUS}`}
                      data-testid={`ta-rechnung-${row.date}`}>
                    <span className="inline-flex items-center gap-1">
                      {row.cells.rechnung.comment && (
                        <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Kommentar" />
                      )}
                      <InlineAmountInput
                        value={row.cells.rechnung.value}
                        manual={false}
                        corrected={row.cells.rechnung.source === 'corrected'}
                        onCommit={v => onCorrectRechnung!(
                          row.date,
                          row.cells.rechnung.override?.originalValue ?? row.cells.rechnung.auto ?? 0,
                          v,
                          row.cells.rechnung.override?.comment,
                        )}
                        testId={`ta-input-rechnung-${row.date}`}
                        ariaLabel={`Debitoren ${row.date}`}
                      />
                    </span>
                  </td>
                ) : (
                  <ValueCell cell={row.cells.rechnung} sep />
                )}
                {voucherEditable ? (
                  <>
                    <VoucherCell cell={row.cells.gutscheinVerkauft} label="Verkaufte Gutscheine"
                      onClick={() => onVoucherClick!(row.date, 'verkauft')}
                      testId={`ta-gutschein-verkauft-${row.date}`} />
                    <VoucherCell cell={row.cells.gutscheinEingeloest} label="Eingelöste Gutscheine"
                      onClick={() => onVoucherClick!(row.date, 'eingeloest')}
                      testId={`ta-gutschein-eingeloest-${row.date}`} />
                  </>
                ) : (
                  <>
                    <ValueCell cell={row.cells.gutscheinVerkauft} />
                    <ValueCell cell={row.cells.gutscheinEingeloest} />
                  </>
                )}

                {/* ── Gruppe Ausgaben: Barausgaben (nur Tages-Total; Klick
                    öffnet AUSSCHLIESSLICH den Barausgaben-Dialog) ── */}
                <td className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${SEP} pl-3`}>
                  {expensesEditable ? (
                    <button
                      type="button"
                      className="group inline-flex items-center gap-1 rounded px-1 -mx-1 cursor-pointer hover:bg-accent hover:text-accent-foreground"
                      onClick={() => onExpensesClick!(row.date)}
                      title="Barausgaben erfassen (eigener Dialog)"
                      data-testid={`ta-expenses-${row.date}`}
                    >
                      {row.expenseCount > 0
                        ? <span className="font-medium tabular-nums">{fmtChf(row.barausgabenTotal)} <span className="text-[10px] text-muted-foreground">({row.expenseCount})</span></span>
                        : <span className="text-muted-foreground">—</span>}
                      <Plus className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-accent-foreground" aria-hidden="true" />
                    </button>
                  ) : (
                    row.expenseCount > 0
                      ? <span className="font-medium">{fmtChf(row.barausgabenTotal)} <span className="text-[10px] text-muted-foreground">({row.expenseCount})</span></span>
                      : <span className="text-muted-foreground">—</span>
                  )}
                </td>

                {/* ── Gruppe Status ── */}
                <td className={`px-2 py-1 whitespace-nowrap ${SEP} pl-3`}>
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
            <td className={`px-2 py-1.5 text-right tabular-nums ${totals.values.umsatz < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{fmtChf(totals.values.umsatz)}</td>
            <td className={`px-2 py-1.5 text-right tabular-nums ${SEP} pl-3`}>{fmtChf(totals.values.karten + totals.values.twint)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums" data-testid="ta-total-adyen"
                title="Summe Karten/TWINT laut Adyen; in Klammern die Summe der Tages-Differenzen (Vorzeichen können sich aufheben)">
              {fmtChf(totals.adyenTotal)}
              <span className="ml-1 text-[10px] text-muted-foreground" data-testid="ta-total-adyen-diff">
                ({fmtDiffChf(totals.adyenDiff)})
              </span>
            </td>
            <td className={`px-2 py-1.5 text-right tabular-nums ${SEP} pl-3`} data-testid="ta-total-bargeld-soll"
                title="Total Bargeld Soll; Bar laut Z-Bericht in Klammern">
              {fmtChf(totals.bargeldSoll)} <span className="text-[10px] text-muted-foreground">({fmtChf(totals.values.bar)})</span>
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.einzahlungBank)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground" data-testid="ta-total-saldo"
                title={'Kassensaldo (Soll) am Monatsende; „—" solange kein Anfangsbestand bekannt ist'}>
              {totals.kassensaldoEnde === null ? '—' : fmtChf(totals.kassensaldoEnde)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums" data-testid="ta-total-cash-ist"
                title="Summe Cash Ist (nur Tage mit gezähltem Bestand)">
              {fmtChf(totals.cashIst)}
            </td>
            <td className={`px-2 py-1.5 text-right tabular-nums ${totals.letzteCashDiff !== null ? diffColorClass(totals.letzteCashDiffStatus) : 'text-muted-foreground'}`}
                data-testid="ta-total-cash-diff"
                title="Cash-Differenz am letzten Tag mit gezähltem Bestand (aktueller Stand der Kasse)">
              {totals.letzteCashDiff === null ? '—' : fmtDiffChf(totals.letzteCashDiff)}
            </td>
            <td className={`px-2 py-1.5 text-right tabular-nums ${SEP} pl-3`}>{fmtChf(totals.values.rechnung)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.gutscheinVerkauft)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(totals.values.gutscheinEingeloest)}</td>
            <td className={`px-2 py-1.5 text-right tabular-nums ${SEP} pl-3`} data-testid="ta-total-barausgaben">{fmtChf(totals.barausgaben)}</td>
            <td className={`px-2 py-1.5 text-muted-foreground ${SEP} pl-3`}>
              {totals.daysConfirmed}/{totals.daysWithZbericht} Tage bestätigt
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
