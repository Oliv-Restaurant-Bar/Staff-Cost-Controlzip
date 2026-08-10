/**
 * Monatsreport — zentrales Meeting-Cockpit (Startseite)
 * Etappe 1: automatisch füllbare Zeilen + Excel-Export.
 * Spalten: Kennzahl | Δ % | Ist | Vorjahr | Budget (Δ zuerst, Budget zuletzt)
 * Fehlende Quellen bleiben leer (nie 0). Bestehende Seiten bleiben erreichbar.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { ChevronLeft, ChevronRight, ChevronDown, FileSpreadsheet, FileDown, CalendarDays, GitCompareArrows, Table2, ChartLine, GripVertical, ListOrdered, RotateCcw, Check, Info, PencilLine, Undo2 } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CockpitWarenkosten } from '@/components/waren/CockpitWarenkosten';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip,
} from 'recharts';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import {
  ladeMonatsreport, ladeWochenverlauf, ladeJahresvergleich, kwRangeLabel, applyRowOrder,
  type MonatsreportDaten, type MrRow, type WeekSelection, type WochenverlaufDaten,
  type WochenverlaufRow, type JahresvergleichDaten, type VergleichsModus,
} from '@/lib/monatsreport';
import {
  loadCockpitBudget, saveCockpitBudget, leereCockpitBudgetPosition,
  isoWeekKey, erNettoBudgetMonate, COCKPIT_BUDGET_KPIS,
} from '@/lib/cockpit-budget';
import type { CockpitBudgetPosition } from '@/types/budget';
import { exportMonatsreportXlsx } from '@/lib/monatsreport-export';
import { exportCockpitPanelPDF, naechsterFrame } from '@/lib/cockpit-pdf-export';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  fetchReservationDrilldown, type ReservationDrilldownRow,
} from '@/lib/reservation-cockpit-metrics';
import {
  loadReservationCounting, DEFAULT_RESERVATION_COUNTING,
} from '@/lib/reservation-cockpit-settings';
import { useCockpitRowOrder } from '@/hooks/useCockpitRowOrder';

/** Metadaten fürs PDF (Titel/Zeitraum/Dateiname/Fussnote), von jedem Tab gemeldet. */
export interface CockpitPdfMeta {
  title: string;
  subtitle: string;
  fileName: string;
  footnote?: string;
  /** Feste PDF-Orientierung (Wochenverlauf: ≤2 Wochen hoch, ≥3 quer). */
  orientation?: 'portrait' | 'landscape';
  /** Renderbreite des Export-Klons in px (schmaler = grössere Schrift). */
  cloneWidthPx?: number;
}

/** Die vier Cockpit-Zeitebenen (gross → klein). */
type CockpitTab = 'jahr' | 'monat' | 'woche' | 'verlauf';
const isCockpitTab = (v: string): v is CockpitTab =>
  v === 'jahr' || v === 'monat' || v === 'woche' || v === 'verlauf';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** ISO-Kalenderwoche + ISO-Wochenjahr eines Datums (Mo=Wochenanfang). */
function isoWeekOf(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mo=0
  t.setUTCDate(t.getUTCDate() - day + 3); // Donnerstag dieser Woche = ISO-Wochenjahr
  const weekYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { week, year: weekYear };
}

interface KwOption { kw: number; kwYear: number; start: number; }

/**
 * ISO-KWs, die den gegebenen Monat schneiden — mit ISO-Wochenjahr (wichtig am
 * Jahreswechsel), dedupliziert, chronologisch nach tatsächlichem Wochenstart.
 */
function isoWeeksOfMonth(year: number, month: number): KwOption[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const seen = new Map<string, KwOption>();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const { week, year: kwYear } = isoWeekOf(d);
    const key = `${kwYear}-${week}`;
    if (!seen.has(key)) {
      // Montag dieser Woche als chronologischer Sortierschlüssel.
      const mon = new Date(d);
      mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
      seen.set(key, { kw: week, kwYear, start: mon.getTime() });
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

// Serialisierte Werte fürs Select (WeekSelection ist ein Objekt).
const WEEK_LASTCOMPLETE = 'lastComplete';
const WEEK_CURRENT = 'current';
const WEEK_LAST7 = 'last7';

/** KW-Wert als "YYYY-Wnn" (ISO-Wochenjahr + Woche). */
const kwValue = (o: KwOption) => `${o.kwYear}-W${String(o.kw).padStart(2, '0')}`;

/** Dropdown-Label einer KW inkl. Mo–So-Bereich (zentrale, getestete Logik). */
const kwOptionLabel = (o: KwOption): string => kwRangeLabel(o.kwYear, o.kw);

function parseWeekValue(v: string): WeekSelection {
  if (v === WEEK_CURRENT) return { kind: 'current' };
  if (v === WEEK_LAST7) return { kind: 'last7' };
  const m = /^(\d{4})-W(\d{1,2})$/.exec(v);
  if (m) return { kind: 'kw', kw: Number(m[2]), kwYear: Number(m[1]) };
  return { kind: 'lastComplete' };
}

const fmtNum = (v: number, dec = 2) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });

function fmtCell(v: number | null, fmt: MrRow['fmt'], pax?: number | null): string {
  if (v === null || v === undefined) return '';
  if (fmt === 'countPax') {
    const n = fmtNum(v, 0);
    // «8 (255 Pers.)» — der Anteil steht als Unterzeile in der Zelle, nie inline.
    if (pax !== null && pax !== undefined) return `${n} (${fmtNum(pax, 0)} Pers.)`;
    return n;
  }
  if (fmt === 'count' || fmt === 'hours') return fmtNum(v, 0);
  if (fmt === 'pct') return `${v.toFixed(1)} %`;
  return fmtNum(v);
}

function fmtDev(v: number | null): string {
  if (v === null) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
}

/** Δ in PROZENTPUNKTEN (Quoten-Zeilen, z.B. PKQ Ist − Ziel = +16.3 PP). */
function fmtDevPp(v: number | null): string {
  if (v === null) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} PP`;
}

const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

/** Granularität der Report-Tabelle. */
type ReportGranularity = 'monat' | 'woche';

/** Zeilen mit Reservations-Drilldown (Liste der zugrunde liegenden Reservationen). */
const DRILLABLE_ROW_IDS = new Set(['reservierte_gaeste', 'gruppen_ab_20']);

/**
 * Sortierbare Datenzeile im «Zeilen anordnen»-Modus: Ziehgriff links, Zeile
 * per Maus/Touch/Tastatur verschiebbar (dnd-kit: Esc bricht ab, Autoscroll am
 * Rand ist eingebaut). Nur Hauptzeilen — Kinder folgen ihrer Eltern-Zeile.
 */
function SortableDataRow({ id, bold, children }: {
  id: string; bold?: boolean; children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'border-b last:border-0 bg-card hover:bg-muted/30',
        bold && 'font-semibold',
        // Gezogene Zeile: hervorgehoben + über den Nachbarn (Platzhalter-Effekt).
        isDragging && 'relative z-10 opacity-80 shadow-lg ring-2 ring-primary/40 bg-muted/40',
      )}
      data-testid={`row-${id}`}
    >
      <td className="px-2 py-1.5">
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted cursor-grab active:cursor-grabbing touch-none"
          aria-label="Zeile ziehen"
          data-testid={`drag-handle-${id}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </td>
      {children}
    </tr>
  );
}

/**
 * DIESELBE Report-Tabelle für Monats- UND Wochensicht — nur andere Granularität.
 * Zieht je Granularität die passenden Felder aus derselben `MrRow`:
 *  - woche:  Budget = weekBudget, Vorjahr = vj (Woche), Ist = week
 *  - monat:  Budget = monthBudget, Vorjahr = vjMonth,    Ist = month
 * Δ% = (Ist − Budget) / Budget × 100 (identische Basis wie die Budget-Spalte).
 * Kosten-Δ-Invertierung (deltaInverted) und warnAbove-Rot gelten in beiden Sichten.
 */
function ReportTable({
  rows, granularity, budgetSub, vjHeader = 'Vorjahr', vjSub, istHeader, istSub, testid,
  editMode = false, onReorder, onDrill, showVj = false,
  budgetEdit = false, onBudgetEdit, onBudgetReset,
}: {
  rows: MrRow[];
  granularity: ReportGranularity;
  budgetSub?: string | null;
  /** Eindeutiger Vorjahres-Spaltentitel (z.B. «Vorjahr (Monat 2025)»). */
  vjHeader?: string;
  vjSub?: string | null;
  istHeader: string;
  istSub?: string | null;
  testid: string;
  /** Bearbeiten-Modus («Zeilen anordnen»): Drag & Drop je Datenzeile. */
  editMode?: boolean;
  /** Persistiert die komplette neue Reihenfolge der Hauptzeilen-IDs. */
  onReorder?: (ids: string[]) => void;
  /** Drilldown: Zeilen-IDs mit Detail-Liste (z.B. Reservationen) klickbar machen. */
  onDrill?: (id: string) => void;
  /** Vorjahr-Spalte anzeigen (Toggle, Default AUS — Budget-Vergleich im Fokus). */
  showVj?: boolean;
  /** «Budget bearbeiten»: Monats-Budgets der Cockpit-Positionen (row.ckId)
   *  inline editierbar — NUR Monatssicht, Woche/Jahr bleiben read-only. */
  budgetEdit?: boolean;
  onBudgetEdit?: (ckId: string, value: number | null) => void;
  /** «Zurück auf abgeleitet/Ist» für manuell überschriebene Monate. */
  onBudgetReset?: (ckId: string) => void;
}) {
  // Spaltenzahl für Trenner-/Colspan-Zeilen: Kennzahl+Δ%+Δabs+Ist+Budget (5)
  // + optional Vorjahr + optional Ziehgriff.
  const colCount = 4 + (showVj ? 1 : 0) + (editMode ? 1 : 0);
  const pick = (row: MrRow) => granularity === 'monat'
    ? { budget: row.monthBudget, vj: row.vjMonth, ist: row.month, devBudget: row.monthBudget,
        vjPax: row.vjMonthPax, istPax: row.monthPax,
        istShare: row.sharePct?.month ?? null, vjShare: row.sharePct?.vjMonth ?? null,
        pct: row.pctOfRevenue?.month ?? null }
    : { budget: row.budget, vj: row.vj, ist: row.week, devBudget: row.weekBudget,
        vjPax: null as number | null, istPax: row.weekPax,
        istShare: row.sharePct?.week ?? null, vjShare: row.sharePct?.vj ?? null,
        pct: row.pctOfRevenue?.week ?? null };
  // Ausklappbare Gruppen: Kinder (childOf) werden IMMER direkt unter ihrer
  // Eltern-Zeile gerendert (unabhängig von gespeicherter Reihenfolge) und sind
  // standardmässig eingeklappt.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const childrenBy = new Map<string, MrRow[]>();
  for (const r of rows) {
    if (r.type === 'data' && r.childOf) {
      const list = childrenBy.get(r.childOf) ?? [];
      list.push(r);
      childrenBy.set(r.childOf, list);
    }
  }
  const mains = rows.filter(r => !(r.type === 'data' && r.childOf));
  // Im Bearbeiten-Modus nur Datenzeilen (Trenner ausblenden → eindeutige
  // Pfeile); Kinder sind dort ausgeblendet (sie folgen ihrer Eltern-Zeile).
  const shown = editMode ? mains.filter(r => r.type === 'data') : mains;
  // Drag & Drop («Zeilen anordnen»): sortierbare Hauptzeilen-IDs in effektiver
  // Reihenfolge. Pointer mit kleiner Distanz-Schwelle (Klicks bleiben Klicks),
  // Touch mit Halte-Verzögerung (Scrollen bleibt möglich), Tastatur inklusive.
  const sortIds = shown.filter(r => r.type === 'data' && r.id).map(r => r.id as string);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sortIds.indexOf(String(active.id));
    const to = sortIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder?.(arrayMove(sortIds, from, to));
  };
  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <table className="w-full text-sm" data-testid={testid}>
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            {editMode ? <th className="px-2 py-2 w-16" /> : null}
            <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
            <th className="px-3 py-2 text-right font-semibold">Δ</th>
            <th className="px-3 py-2 text-right font-semibold">
              {istHeader}
              {istSub ? <span className="block normal-case font-normal">{istSub}</span> : null}
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              Budget
              {budgetSub ? <span className="block normal-case font-normal">{budgetSub}</span> : null}
            </th>
            {showVj && (
              <th className="px-3 py-2 text-right font-semibold">
                {vjHeader}
                {vjSub ? <span className="block normal-case font-normal">{vjSub}</span> : null}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          <SortableContext items={sortIds} strategy={verticalListSortingStrategy}>
          {shown.map((row, i) => {
            if (row.type === 'empty') {
              return <tr key={`e${i}`}><td colSpan={colCount} className="h-3 bg-muted/20" /></tr>;
            }
            const p = pick(row);
            const children = row.id ? (childrenBy.get(row.id) ?? []) : [];
            const isOpen = !!row.id && expanded.has(row.id);
            const wkq = row.wkqInline ? (granularity === 'monat' ? row.wkqInline.month : row.wkqInline.week) : null;
            // Δ-Varianten:
            //  - deltaPp:   Ist − Budget in PROZENTPUNKTEN (Quoten, z.B. PKQ);
            //               über Ziel = rot (Kosten-Logik).
            //  - deltaVsVj: Δ% gegen das Vorjahr (Zeilen ohne Budget, z.B.
            //               Take Away Umsatz); Farblogik wie Umsatz.
            //  - Standard:  Δ% gegen das Budget.
            let dev: number | null = null;
            let inverted = !!row.deltaInverted;
            // Δ abs: GLEICHE Basis wie Δ% — Zeilen mit VJ-Vergleich (deltaVsVj/
            // sharePct) rechnen Ist − VJ, alle anderen Ist − Budget. Nie zwei
            // verschiedene Basen nebeneinander in derselben Zeile.
            const devAbsBase = (row.deltaVsVj || row.sharePct) ? p.vj : p.devBudget;
            const devAbs = p.ist !== null && devAbsBase !== null ? p.ist - devAbsBase : null;
            if (row.deltaPp) {
              dev = p.ist !== null && p.devBudget !== null ? p.ist - p.devBudget : null;
              inverted = true; // Quote über Ziel = rot
            } else if (row.deltaVsVj || row.sharePct) {
              // Anteil-Zeilen (sharePct): Δ% = Veränderung Ist vs. Vorjahr —
              // konsistent mit den übrigen Kennzahlen; der Anteil selbst steht
              // als dezente Unterzeile unter der Zahl (Ist + Vorjahr).
              dev = p.ist !== null && p.vj !== null && p.vj > 0
                ? ((p.ist - p.vj) / p.vj) * 100 : null;
            } else {
              dev = p.ist !== null && p.devBudget !== null && p.devBudget > 0
                ? ((p.ist - p.devBudget) / p.devBudget) * 100 : null;
            }
            // Kosten-Zeilen (inverted): über Budget/Ziel = rot (Vorzeichen umgekehrt).
            const devClass = dev === null ? undefined
              : (inverted ? dev <= 0 : dev >= 0) ? 'text-emerald-600' : 'text-red-600';
            // Schwellen-Rot (warnAbove, z.B. PKQ > 40 %) für den Ist-Wert.
            const warnClass = row.warnAbove != null && p.ist !== null && p.ist > row.warnAbove
              ? 'text-red-600 font-semibold' : undefined;
            // Farb-Tönung (Rezensions-Zeilen: 5 Sterne grün, 1 Stern rot).
            const tintClass = row.tint === 'green' ? 'text-emerald-600 dark:text-emerald-400'
              : row.tint === 'red' ? 'text-red-600 dark:text-red-400' : undefined;
            // WKQ-Inline-Ampel (nur «Warenkosten total»): über Ziel = rot.
            const wkqGut = wkq?.pct != null && wkq.ziel != null ? wkq.pct <= wkq.ziel : null;
            const wkqDelta = wkq?.pct != null && wkq.ziel != null ? wkq.pct - wkq.ziel : null;
            // Transparenz «Netto Umsatz»: enthaltener Marketing-/Maison-Anteil
            // der gewählten Periode (bereits eingerechnet, reine Anzeige).
            const mkt = row.marketingNetto
              ? (granularity === 'monat' ? row.marketingNetto.month : row.marketingNetto.week)
              : null;
            // Zellen der Hauptzeile (Label | Δ% | Ist | Vorjahr | Budget) — im
            // «Zeilen anordnen»-Modus in einer sortierbaren Zeile mit Ziehgriff.
            const rowCells = (
              <>
                <td className="px-3 py-1.5">
                  {children.length > 0 && !editMode ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-left hover:underline"
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev);
                        if (row.id) { if (next.has(row.id)) next.delete(row.id); else next.add(row.id); }
                        return next;
                      })}
                      aria-expanded={isOpen}
                      data-testid={`button-toggle-${row.id}`}
                    >
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      {row.label}
                    </button>
                  ) : onDrill && row.id && DRILLABLE_ROW_IDS.has(row.id) && !editMode ? (
                    <button
                      type="button"
                      className="text-left hover:underline underline-offset-2 decoration-dotted"
                      onClick={() => onDrill(row.id!)}
                      data-testid={`button-drill-${row.id}`}
                      title="Zugrunde liegende Reservationen anzeigen"
                    >
                      {row.label}
                    </button>
                  ) : row.label}
                  {row.id === 'netto_umsatz' && mkt !== null ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
                          aria-label="Netto-Umsatz Zusammensetzung"
                          data-testid={`info-netto-umsatz-${granularity}`}
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[280px] text-xs">
                        <p className="font-medium">Netto-Umsatz = MwSt-bereinigter Umsatz + Marketing/Maison</p>
                        <p className="mt-1">
                          Davon Marketing/Maison ({granularity === 'monat' ? 'Monat' : 'Woche'}):{' '}
                          <span className="tabular-nums font-medium">
                            CHF {mkt.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </p>
                        <p className="mt-1 text-muted-foreground">Betrag ist bereits im Netto-Umsatz enthalten (keine Doppelzählung).</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {wkq ? (
                    <span className="block text-[11px] font-normal tabular-nums" data-testid={`wkq-inline-${granularity}`}>
                      {wkq.pct != null ? (
                        <span className="inline-flex items-center gap-1">
                          <span className={cn('h-2 w-2 rounded-full inline-block',
                            wkqGut ? 'bg-emerald-500' : 'bg-red-500')} />
                          <span className={wkqGut ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                            WKQ {wkq.pct.toFixed(1)} %
                          </span>
                          {wkqDelta != null && (
                            <span className="text-muted-foreground">
                              ({wkqDelta >= 0 ? '+' : ''}{wkqDelta.toFixed(1)} PP zu Ziel {wkq.ziel!.toFixed(1)} %)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">WKQ — (kein Umsatz)</span>
                      )}
                      {(wkq.food != null || wkq.bev != null) && (
                        <span className="text-muted-foreground">
                          {' · '}Food {wkq.food != null ? `${wkq.food.toFixed(1)} %` : '—'}
                          {' · '}Beverage {wkq.bev != null ? `${wkq.bev.toFixed(1)} %` : '—'}
                        </span>
                      )}
                    </span>
                  ) : null}
                </td>
                {/* EINE Δ-Spalte: Hauptwert = absolute Veränderung (CHF bzw. PP
                    bei Quoten-Zeilen), darunter dezent der Prozentwert. Farb-/
                    Ampellogik unverändert (Kosten-Zeilen invertiert); leer statt 0. */}
                <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs', devClass)}>
                  {row.deltaPp
                    ? fmtDevPp(dev)
                    : row.fmt === 'pct'
                      ? fmtDevPp(devAbs) // Quoten-Zeilen: Δ in Prozentpunkten
                      : devAbs === null ? '' : `${devAbs >= 0 ? '+' : '−'}${fmtCell(Math.abs(devAbs), row.fmt) ?? ''}`}
                  {!row.deltaPp && row.fmt !== 'pct' && dev !== null ? (
                    <span className="block text-[9px] font-normal text-muted-foreground">
                      {fmtDev(dev)}{(row.deltaVsVj || row.sharePct) ? ' vs. VJ' : ''}
                    </span>
                  ) : null}
                </td>
                {/* Ist-Zelle: Zahl gross; bei Anteil-Zeilen der Anteil als dezente
                    Unterzeile («18.3 % Anteil Gäste IN»). Ohne Basis kein Anteil. */}
                <td className={cn('px-3 py-1.5 text-right tabular-nums', tintClass, warnClass)}>
                  {fmtCell(p.ist, row.fmt, p.istPax)}
                  {row.sharePct && p.ist !== null && p.istShare !== null ? (
                    <span className="block text-[10px] font-normal text-muted-foreground" data-testid={`share-${row.id}-${granularity}`}>
                      {p.istShare.toFixed(1)} % {row.shareHint ?? 'Anteil Gäste IN'}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {granularity === 'monat' && budgetEdit && row.ckId && onBudgetEdit && !editMode ? (
                    <span className="inline-flex items-center justify-end gap-1">
                      {row.monthBudgetManuell && onBudgetReset ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          title="Zurück auf abgeleitet/Ist"
                          onClick={() => onBudgetReset(row.ckId!)}
                          data-testid={`button-budget-reset-${row.id}`}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      {/* Editier-Basis = VOLLER Monatswert (monthBudgetVoll) — die
                          Anzeige des laufenden Monats ist pro rata bis heute gekappt
                          und darf NIE als Monatswert zurückgeschrieben werden. */}
                      <input
                        type="number" inputMode="decimal"
                        // key: bei neuem Store-Wert neu initialisieren (unkontrolliert).
                        key={`${row.ckId}-${row.monthBudgetVoll ?? 'leer'}`}
                        defaultValue={row.monthBudgetVoll ?? ''}
                        title="Voller Monatswert (nicht der pro-rata-Anzeigewert)"
                        className="h-7 w-24 rounded border bg-background px-1.5 text-right text-xs tabular-nums"
                        data-testid={`input-budget-${row.id}`}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onBlur={e => {
                          const raw = e.target.value.trim().replace(',', '.');
                          const v = raw === '' ? null : Number(raw);
                          if (v !== null && !isFinite(v)) return; // ungültig: ignorieren
                          if ((v ?? null) === (row.monthBudgetVoll ?? null)) return; // unverändert
                          onBudgetEdit(row.ckId!, v);
                        }}
                      />
                      {(row.monthBudgetVoll ?? null) !== (p.budget ?? null) ? (
                        <span className="text-[9px] text-muted-foreground">voller Monat</span>
                      ) : null}
                    </span>
                  ) : (
                    <>
                      {fmtCell(p.budget, row.fmt)}
                      {granularity === 'monat' && row.monthBudgetManuell ? (
                        <span
                          className="ml-1 inline-block rounded bg-amber-100 px-1 align-middle text-[9px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                          title="Monatswert manuell überschrieben (Budget bearbeiten → Reset stellt die Ableitung wieder her)"
                          data-testid={`badge-manuell-${row.id}`}
                        >manuell</span>
                      ) : null}
                    </>
                  )}
                </td>
                {showVj && (
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {fmtCell(p.vj, row.fmt, p.vjPax)}
                    {row.sharePct && p.vj !== null && p.vjShare !== null ? (
                      <span className="block text-[10px] font-normal text-muted-foreground" data-testid={`share-vj-${row.id}-${granularity}`}>
                        {p.vjShare.toFixed(1)} %
                      </span>
                    ) : null}
                  </td>
                )}
              </>
            );
            const parentTr = editMode && row.id ? (
              // «Zeilen anordnen»: Ziehgriff links, Drag & Drop statt Pfeilen.
              <SortableDataRow key={row.id} id={row.id} bold={row.bold}>
                {rowCells}
              </SortableDataRow>
            ) : (
              <tr key={row.id ?? `d${i}`} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')} data-testid={`row-${row.id ?? i}`}>
                {editMode ? <td className="px-2 py-1.5" /> : null}
                {rowCells}
              </tr>
            );
            if (children.length === 0 || editMode || !isOpen) return parentTr;
            return (
              <Fragment key={`g-${row.id}`}>
                {parentTr}
                {children.map(child => {
                  const cp = pick(child);
                  return (
                    <tr key={child.id} className="border-b last:border-0 bg-muted/10 hover:bg-muted/30" data-testid={`row-${child.id}`}>
                      <td className="px-3 py-1 pl-9 text-xs text-muted-foreground">{child.label}</td>
                      {/* EINE leere Δ-Zelle (zusammengelegte Δ-Spalte). */}
                      <td className="px-3 py-1" />
                      <td className="px-3 py-1 text-right tabular-nums text-xs">
                        {fmtCell(cp.ist, child.fmt)}
                        {/* Quote je Lieferant in % auf den Netto-Umsatz der Periode. */}
                        {cp.pct !== null && (
                          <span className="ml-1 text-[10px] text-muted-foreground" data-testid={`pct-${child.id}`}>
                            · {cp.pct.toFixed(1)} %
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-xs text-muted-foreground">{fmtCell(cp.budget, child.fmt)}</td>
                      {showVj && (
                        <td className="px-3 py-1 text-right tabular-nums text-xs text-muted-foreground">{fmtCell(cp.vj, child.fmt)}</td>
                      )}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
          </SortableContext>
        </tbody>
      </table>
      </DndContext>
    </div>
  );
}

/**
 * Kompakte 2-Wochen-Tabelle der Wochenübersicht: zwei ISO-Wochen nebeneinander,
 * je Woche Ist | Budget | Δ (Δ CHF gross, Δ% klein darunter). Feste Spalten-
 * breiten (table-fixed), damit 2 Wochen × (Ist+Budget+Δ) auch im PDF-Hochformat
 * sauber passen. Skeleton (Zeilen/Reihenfolge/Kinder) = NEUERE Woche (rowsB);
 * die ältere Woche (rowsA) wird per Zeilen-ID zugeordnet — fehlende Zeilen
 * bleiben leer (leer statt 0).
 */
export function ZweiWochenTable({ rowsA, rowsB, headerA, subA, headerB, subB, testid, onDrill }: {
  rowsA: MrRow[] | null;
  rowsB: MrRow[];
  headerA: string; subA?: string | null;
  headerB: string; subB?: string | null;
  testid: string;
  onDrill?: (rowId: string) => void;
}) {
  const byIdA = new Map<string, MrRow>();
  for (const r of rowsA ?? []) if (r.type === 'data' && r.id) byIdA.set(r.id, r);
  const childrenBy = new Map<string, MrRow[]>();
  for (const r of rowsB) {
    if (r.type === 'data' && r.childOf) {
      const list = childrenBy.get(r.childOf) ?? [];
      list.push(r);
      childrenBy.set(r.childOf, list);
    }
  }
  const mains = rowsB.filter(r => !(r.type === 'data' && r.childOf));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  /** Wochen-Werte einer Zeile (null-Zeile = ganze Wochenspalte leer). */
  const pickW = (row: MrRow | undefined) => row ? {
    ist: row.week, budget: row.budget, devBudget: row.weekBudget, vj: row.vj,
    istPax: row.weekPax, istShare: row.sharePct?.week ?? null,
    pct: row.pctOfRevenue?.week ?? null,
    wkq: row.wkqInline ? row.wkqInline.week : null,
  } : null;

  /** Die drei Zellen (Ist | Budget | Δ) einer Woche — Flags aus der Skeleton-Zeile. */
  const wochenZellen = (skel: MrRow, src: MrRow | undefined, keyPrefix: string) => {
    const p = pickW(src);
    if (!p) {
      return (
        <>
          <td className="px-2 py-1.5" />
          <td className="px-2 py-1.5" />
          <td className="px-2 py-1.5" />
        </>
      );
    }
    // Δ-Logik identisch zur Report-Tabelle (deltaPp / deltaVsVj / Standard).
    let dev: number | null = null;
    let inverted = !!skel.deltaInverted;
    const devAbsBase = (skel.deltaVsVj || skel.sharePct) ? p.vj : p.devBudget;
    const devAbs = p.ist !== null && devAbsBase !== null ? p.ist - devAbsBase : null;
    if (skel.deltaPp) {
      dev = p.ist !== null && p.devBudget !== null ? p.ist - p.devBudget : null;
      inverted = true;
    } else if (skel.deltaVsVj || skel.sharePct) {
      dev = p.ist !== null && p.vj !== null && p.vj > 0 ? ((p.ist - p.vj) / p.vj) * 100 : null;
    } else {
      dev = p.ist !== null && p.devBudget !== null && p.devBudget > 0
        ? ((p.ist - p.devBudget) / p.devBudget) * 100 : null;
    }
    const devClass = dev === null ? undefined
      : (inverted ? dev <= 0 : dev >= 0) ? 'text-emerald-600' : 'text-red-600';
    const warnClass = skel.warnAbove != null && p.ist !== null && p.ist > skel.warnAbove
      ? 'text-red-600 font-semibold' : undefined;
    const tintClass = skel.tint === 'green' ? 'text-emerald-600 dark:text-emerald-400'
      : skel.tint === 'red' ? 'text-red-600 dark:text-red-400' : undefined;
    const wkqGut = p.wkq?.pct != null && p.wkq.ziel != null ? p.wkq.pct <= p.wkq.ziel : null;
    return (
      <>
        <td className={cn('px-2 py-1.5 text-right tabular-nums', tintClass, warnClass)}
          data-testid={`${keyPrefix}-ist-${skel.id}`}>
          {fmtCell(p.ist, skel.fmt, p.istPax)}
          {skel.sharePct && p.ist !== null && p.istShare !== null ? (
            <span className="block text-[10px] font-normal text-muted-foreground">
              {p.istShare.toFixed(1)} % {skel.shareHint ?? 'Anteil Gäste IN'}
            </span>
          ) : null}
          {p.wkq && p.wkq.pct != null ? (
            <span className={cn('block text-[10px] font-normal tabular-nums',
              wkqGut ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
              WKQ {p.wkq.pct.toFixed(1)} %
            </span>
          ) : null}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground"
          data-testid={`${keyPrefix}-budget-${skel.id}`}>
          {fmtCell(p.budget, skel.fmt)}
        </td>
        {/* Δ kompakt: Hauptwert = absolute Differenz (CHF/PP), darunter klein Δ%. */}
        <td className={cn('px-2 py-1.5 text-right tabular-nums text-xs', devClass)}
          data-testid={`${keyPrefix}-delta-${skel.id}`}>
          {skel.deltaPp
            ? fmtDevPp(dev)
            : skel.fmt === 'pct'
              ? fmtDevPp(devAbs)
              : devAbs === null ? '' : `${devAbs >= 0 ? '+' : '−'}${fmtCell(Math.abs(devAbs), skel.fmt) ?? ''}`}
          {!skel.deltaPp && skel.fmt !== 'pct' && dev !== null ? (
            <span className="block text-[9px] font-normal text-muted-foreground">
              {fmtDev(dev)}{(skel.deltaVsVj || skel.sharePct) ? ' vs. VJ' : ''}
            </span>
          ) : null}
        </td>
      </>
    );
  };

  const colCount = 7;
  const wochenKopf = (label: string, sub?: string | null) => (
    <>
      <th className="px-2 py-2 text-right font-semibold" colSpan={3}>
        {label}
        {sub ? <span className="block normal-case font-normal">{sub}</span> : null}
      </th>
    </>
  );

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
      <table className="w-full table-fixed text-sm" data-testid={testid}>
        <colgroup>
          <col className="w-[200px]" />
          <col className="w-[96px]" /><col className="w-[96px]" /><col className="w-[84px]" />
          <col className="w-[96px]" /><col className="w-[96px]" /><col className="w-[84px]" />
        </colgroup>
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-2 text-left font-semibold" rowSpan={2}>Kennzahl</th>
            {wochenKopf(headerA, subA)}
            {wochenKopf(headerB, subB)}
          </tr>
          <tr className="border-b bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1 text-right font-semibold">Ist</th>
            <th className="px-2 py-1 text-right font-semibold">Budget</th>
            <th className="px-2 py-1 text-right font-semibold">Δ</th>
            <th className="px-2 py-1 text-right font-semibold">Ist</th>
            <th className="px-2 py-1 text-right font-semibold">Budget</th>
            <th className="px-2 py-1 text-right font-semibold">Δ</th>
          </tr>
        </thead>
        <tbody>
          {mains.map((row, i) => {
            if (row.type === 'empty') {
              return <tr key={`e${i}`}><td colSpan={colCount} className="h-3 bg-muted/20" /></tr>;
            }
            const children = row.id ? (childrenBy.get(row.id) ?? []) : [];
            const isOpen = !!row.id && expanded.has(row.id);
            const srcA = row.id ? byIdA.get(row.id) : undefined;
            const parentTr = (
              <tr
                key={row.id ?? `d${i}`}
                className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')}
                data-testid={`row2w-${row.id ?? i}`}
              >
                <td className="px-2 py-1.5">
                  {children.length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-left hover:underline"
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev);
                        if (row.id) { if (next.has(row.id)) next.delete(row.id); else next.add(row.id); }
                        return next;
                      })}
                      aria-expanded={isOpen}
                      data-testid={`button-toggle2w-${row.id}`}
                    >
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      {row.label}
                    </button>
                  ) : onDrill && row.id && DRILLABLE_ROW_IDS.has(row.id) ? (
                    <button
                      type="button"
                      className="text-left hover:underline underline-offset-2 decoration-dotted"
                      onClick={() => onDrill(row.id!)}
                      data-testid={`button-drill2w-${row.id}`}
                      title="Zugrunde liegende Reservationen anzeigen"
                    >
                      {row.label}
                    </button>
                  ) : row.label}
                </td>
                {wochenZellen(row, srcA, 'wa')}
                {wochenZellen(row, row, 'wb')}
              </tr>
            );
            if (children.length === 0 || !isOpen) return parentTr;
            return (
              <Fragment key={`g-${row.id}`}>
                {parentTr}
                {children.map(child => {
                  const ca = child.id ? byIdA.get(child.id) : undefined;
                  const cA = pickW(ca), cB = pickW(child);
                  const kindZelle = (p: ReturnType<typeof pickW>, key: string) => (
                    <Fragment key={key}>
                      <td className="px-2 py-1 text-right tabular-nums text-xs">
                        {p ? fmtCell(p.ist, child.fmt) : ''}
                        {p && p.pct !== null && (
                          <span className="ml-1 text-[10px] text-muted-foreground">· {p.pct.toFixed(1)} %</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-xs text-muted-foreground">
                        {p ? fmtCell(p.budget, child.fmt) : ''}
                      </td>
                      <td className="px-2 py-1" />
                    </Fragment>
                  );
                  return (
                    <tr key={child.id} className="border-b last:border-0 bg-muted/10 hover:bg-muted/30" data-testid={`row2w-${child.id}`}>
                      <td className="px-2 py-1 pl-9 text-xs text-muted-foreground">{child.label}</td>
                      {kindZelle(cA, 'a')}
                      {kindZelle(cB, 'b')}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** «Zeilen anordnen»-Umschalter + «Standard wiederherstellen» (Bearbeiten-Modus). */
function RowOrderControls({
  editMode, onToggle, onReset, disabled,
}: {
  editMode: boolean;
  onToggle: () => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 ml-2">
      {editMode ? (
        <Button
          variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground"
          onClick={onReset} disabled={disabled}
          data-testid="button-reset-order"
        >
          <RotateCcw className="h-4 w-4" /> Standard
        </Button>
      ) : null}
      <Button
        variant={editMode ? 'default' : 'outline'} size="sm" className="h-8 gap-1.5"
        onClick={onToggle} disabled={disabled}
        data-testid="button-toggle-order"
      >
        {editMode ? <Check className="h-4 w-4" /> : <ListOrdered className="h-4 w-4" />}
        {editMode ? 'Fertig' : 'Zeilen anordnen'}
      </Button>
    </div>
  );
}

export default function MonatsreportPage() {
  const heute = useMemo(() => new Date(), []);
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();
  const { toast } = useToast();

  // Aktiver Tab (kontrolliert), damit der PDF-Button die richtige Ansicht erfasst.
  // Reihenfolge gross → klein: Jahr · Monat · Woche · Verlauf.
  const [activeTab, setActiveTab] = useState<CockpitTab>('monat');
  // Unbekannte/alte Tab-Werte (z.B. gespeicherte Deep-Links) → Default «monat».
  const onTabChange = (v: string) => setActiveTab(isCockpitTab(v) ? v : 'monat');
  // Refs auf die vier Tab-Panels (das wird jeweils gecaptured).
  const jahrPanelRef = useRef<HTMLDivElement>(null);
  const monatPanelRef = useRef<HTMLDivElement>(null);
  const wochePanelRef = useRef<HTMLDivElement>(null);
  const verlaufPanelRef = useRef<HTMLDivElement>(null);
  // PDF-Metadaten je Tab; Wochenverlauf/Jahresübersicht melden sie via Callback.
  const [verlaufMeta, setVerlaufMeta] = useState<CockpitPdfMeta | null>(null);
  const [jahrMeta, setJahrMeta] = useState<CockpitPdfMeta | null>(null);
  const [pdfLaeuft, setPdfLaeuft] = useState(false);

  const [year, setYear] = useState(heute.getFullYear());
  const [month, setMonth] = useState(heute.getMonth() + 1); // 1-basiert

  const [daten, setDaten] = useState<MonatsreportDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [weekValue, setWeekValue] = useState<string>(WEEK_LASTCOMPLETE);

  const weekSelection = useMemo<WeekSelection>(() => parseWeekValue(weekValue), [weekValue]);
  const kwOptions = useMemo(() => isoWeeksOfMonth(year, month), [year, month]);

  // ── Reservations-Drilldown (Klick auf «Reservierte Gäste»/«Gruppen ab N Pax») ──
  const [drill, setDrill] = useState<{
    title: string; sub: string; loading: boolean; error: string | null;
    rows: ReservationDrilldownRow[];
  } | null>(null);
  const openDrill = useCallback(async (rowId: string, granularity: ReportGranularity) => {
    if (!daten) return;
    const groupsOnly = rowId === 'gruppen_ab_20';
    // Zeitraum EXAKT wie die Kennzahl: Monat = ganzer Monat (inkl. Zukunft),
    // Woche = gewählte Woche (daten.weekFrom/weekTo).
    const mm = String(month).padStart(2, '0');
    const fromIso = granularity === 'monat'
      ? `${year}-${mm}-01` : daten.weekFrom;
    const toIso = granularity === 'monat'
      ? `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
      : daten.weekTo;
    const settings = (await loadReservationCounting(tenantKey).catch(() => null))
      ?? DEFAULT_RESERVATION_COUNTING;
    const title = groupsOnly ? `Gruppen ab ${settings.groupThreshold} Pax` : 'Reservierte Gäste';
    const sub = granularity === 'monat'
      ? `${MONATE[month - 1]} ${year}` : `${fmtDate(fromIso ?? '')}–${fmtDate(toIso ?? '')}`;
    setDrill({ title, sub, loading: true, error: null, rows: [] });
    try {
      const rows = await fetchReservationDrilldown(tenantId, fromIso ?? null, toIso ?? null, settings, groupsOnly);
      setDrill({ title, sub, loading: false, error: null, rows });
    } catch (e) {
      setDrill({ title, sub, loading: false, error: e instanceof Error ? e.message : String(e), rows: [] });
    }
  }, [daten, month, year, tenantId, tenantKey]);

  // Benutzerdefinierte Zeilen-Reihenfolge (EINE für Monat + Woche, pro Tenant).
  const { savedIds, saveOrder, resetOrder } = useCockpitRowOrder();
  const [editRows, setEditRows] = useState(false);
  // Effektive (sortierte) Zeilen — Basis für Anzeige UND Export.
  const orderedRows = useMemo(
    () => (daten ? applyRowOrder(daten.rows, savedIds) : []),
    [daten, savedIds],
  );
  // Aktuelle Datenzeilen-IDs in effektiver Reihenfolge (Basis fürs Umsortieren).
  const currentIds = useMemo(
    // Kinder-Zeilen (childOf, z.B. Lieferanten) sind NICHT umsortierbar und
    // dürfen nicht in die gespeicherte Reihenfolge geraten — sonst verschieben
    // Pfeile gegen versteckte Nachbarn und dynamische Lieferanten-IDs werden
    // dauerhaft persistiert.
    () => orderedRows.filter(r => r.type === 'data' && r.id && !r.childOf).map(r => r.id as string),
    [orderedRows],
  );
  // Drag & Drop: komplette neue Hauptzeilen-Reihenfolge persistieren. Nur
  // gültige, aktuell bekannte Haupt-IDs übernehmen (keine Kind-/Fremd-IDs).
  const reorderRows = useCallback((ids: string[]) => {
    const known = new Set(currentIds);
    const next = ids.filter(id => known.has(id));
    if (next.length !== currentIds.length) return; // defensiv: nichts verlieren
    saveOrder(next);
  }, [currentIds, saveOrder]);

  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetBusy, setBudgetBusy] = useState(false);
  // Ein-Schritt-Rückgängig: Positions-Snapshot VOR der letzten Änderung.
  const [budgetUndo, setBudgetUndo] = useState<{
    ckId: string; year: number; prev: CockpitBudgetPosition | null; label: string;
    /** Positions-Stand NACH unserer Änderung — Undo nur, wenn er noch gilt
     *  (sonst hat inzwischen jemand anderes geändert → Konflikt, kein Write). */
    expectedAfter: CockpitBudgetPosition;
  } | null>(null);
  const [budgetReloadTick, setBudgetReloadTick] = useState(0);

  useEffect(() => {
    if (ratesLoading || !rates) return;
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeMonatsreport(year, month, tenantId, tenantKey, rates, heute, weekSelection)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [year, month, tenantId, tenantKey, rates, ratesLoading, heute, weekSelection, budgetReloadTick]);

  useEffect(() => { setBudgetUndo(null); }, [year, month, tenantId]);

  // ── Vorwoche für die 2-Wochen-Ansicht der Wochenübersicht ──────────────────
  // Nur laden, wenn der Woche-Tab aktiv ist (ladeMonatsreport ist teuer);
  // Fenster = [Vorwoche, gewählte Woche]. Fehler → Vorwochen-Spalte leer.
  const [datenPrev, setDatenPrev] = useState<MonatsreportDaten | null>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);
  useEffect(() => {
    if (activeTab !== 'woche' || !daten?.weekFrom || ratesLoading || !rates) {
      setDatenPrev(null);
      return;
    }
    const mo = new Date(Number(daten.weekFrom.slice(0, 4)),
      Number(daten.weekFrom.slice(5, 7)) - 1, Number(daten.weekFrom.slice(8, 10)));
    mo.setDate(mo.getDate() - ((mo.getDay() + 6) % 7) - 7); // Montag der Vorwoche
    const { week, year: kwYear } = isoWeekOf(mo);
    let alive = true;
    // Sofort invalidieren: nie die neue Woche mit einer stalen Vorwoche mischen.
    setDatenPrev(null);
    setLoadingPrev(true);
    ladeMonatsreport(mo.getFullYear(), mo.getMonth() + 1, tenantId, tenantKey, rates, heute,
      { kind: 'kw', kw: week, kwYear })
      .then(d => { if (alive) setDatenPrev(d); })
      .catch(() => { if (alive) setDatenPrev(null); })
      .finally(() => { if (alive) setLoadingPrev(false); });
    return () => { alive = false; };
  }, [activeTab, daten?.weekFrom, tenantId, tenantKey, rates, ratesLoading, heute, budgetReloadTick]);

  const prev = () => { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); };
  /** Wochen-Navigation: springt genau eine ISO-KW weiter/zurück (auch über
   *  Monats-/Jahresgrenzen); der Report-Monat folgt dem Montag der neuen
   *  Woche. Basis = konkrete KW der Auswahl bzw. der geladene Wochenstart. */
  const shiftWeek = (dir: 1 | -1) => {
    let base: Date | null = null;
    const sel = parseWeekValue(weekValue);
    if (sel.kind === 'kw') {
      // Montag der ISO-KW (Woche 1 enthält den 4. Januar).
      const jan4 = new Date(sel.kwYear ?? year, 0, 4);
      jan4.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (sel.kw - 1) * 7);
      base = jan4;
    } else if (daten?.weekFrom) {
      base = parseIso(daten.weekFrom);
      base.setDate(base.getDate() - ((base.getDay() + 6) % 7)); // Montag
    }
    if (!base) return;
    base.setDate(base.getDate() + dir * 7);
    const { week, year: kwYear } = isoWeekOf(base);
    setWeekValue(`${kwYear}-W${String(week).padStart(2, '0')}`);
    // Report-Monat folgt dem Montag (KW 31 = 27.07.–02.08. → Juli-Sicht).
    if (base.getFullYear() !== year) setYear(base.getFullYear());
    if (base.getMonth() + 1 !== month) setMonth(base.getMonth() + 1);
  };
  const next = () => { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); };

  // Vorjahr-Spalte: nur per Toggle (Default AUS) — Budget-Vergleich im Fokus.
  const [showVj, setShowVj] = useState(false);

  // ── Inline-Budget-Korrektur (NUR Monatsebene, top-down) ────────────────────
  // Schreibt in DENSELBEN Store wie die Budget-Eingabe (cockpit-budget:<jahr>,
  // tenant-präfixiert) — eine einzige Quelle der Wahrheit. Der Monatswert
  // bricht wie bisher pro rata auf die Wochen herunter (resolveCockpitBudgets);
  // Wochen-/Jahressicht bleiben read-only, KEIN Hochrechnen Woche → Monat.

  /** ISO-Wochen-Keys, die Tage dieses Monats enthalten (für Override-Warnung). */
  const wochenKeysDesMonats = useCallback((): Set<string> => {
    const dim = new Date(year, month, 0).getDate();
    const keys = new Set<string>();
    for (let d = 1; d <= dim; d++) {
      keys.add(isoWeekKey(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`));
    }
    return keys;
  }, [year, month]);

  /** Blob laden (oder leeres Jahres-Blob) + Position der ID (oder leer). */
  const ladePosition = useCallback(async (ckId: string) => {
    const def = COCKPIT_BUDGET_KPIS.find(k => k.id === ckId);
    if (!def) throw new Error(`Unbekannte Budget-Position: ${ckId}`);
    const blob = (await loadCockpitBudget(tenantKey, year))
      ?? { year, positions: {}, updatedAt: '', taNetto: true as const };
    const pos = blob.positions[ckId] ?? leereCockpitBudgetPosition(ckId, def.unit);
    return { def, blob, pos };
  }, [tenantKey, year]);

  /** Monats-Edit: überschreibt den Monatswert dieser Position (explicit). */
  const budgetMonatSetzen = useCallback(async (ckId: string, value: number | null) => {
    if (budgetBusy) return;
    setBudgetBusy(true);
    try {
      const { def, blob, pos } = await ladePosition(ckId);
      const prev: CockpitBudgetPosition = JSON.parse(JSON.stringify(pos));
      // Bestehende KW-Overrides in DIESEM Monat: warnen und nur nach
      // Bestätigung ersetzen — sonst bleiben sie stehen (Präzedenz Woche > Monat).
      const monatsKeys = wochenKeysDesMonats();
      const betroffen = Object.keys(pos.weekOverrides).filter(k => monatsKeys.has(k));
      let weekOverrides = pos.weekOverrides;
      if (betroffen.length > 0) {
        const ersetzen = window.confirm(
          `${betroffen.length} Wochen-Override${betroffen.length === 1 ? '' : 's'} in ${MONATE[month - 1]} ${year} (${betroffen.join(', ')}) `
          + `werden durch den neuen Monatswert ersetzt.

OK = Overrides entfernen (Monatswert gilt voll) · `
          + `Abbrechen = Overrides bleiben stehen (Präzedenz Woche > Monat gilt weiter).`);
        if (ersetzen) {
          weekOverrides = Object.fromEntries(
            Object.entries(pos.weekOverrides).filter(([k]) => !monatsKeys.has(k)));
        }
      }
      const mv = pos.monthlyValues.slice();
      const me = pos.monthlyExplicit.slice();
      mv[month - 1] = value; // null = bewusst leer (nie 0 erfinden)
      me[month - 1] = value !== null;
      const neu = { ...pos, monthlyValues: mv, monthlyExplicit: me, weekOverrides };
      blob.positions[ckId] = neu;
      await saveCockpitBudget(tenantKey, blob);
      setBudgetUndo({ ckId, year, prev, label: def.label, expectedAfter: neu });
      setBudgetReloadTick(t => t + 1);
      toast({
        title: 'Monats-Budget überschrieben',
        description: `${def.label} · ${MONATE[month - 1]} ${year}: `
          + (value === null ? 'geleert' : value.toLocaleString('de-CH'))
          + ' — Wochen dieses Monats skalieren pro rata mit. «Rückgängig» oben verfügbar.',
      });
    } catch (e) {
      toast({ title: 'Budget-Korrektur fehlgeschlagen', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally { setBudgetBusy(false); }
  }, [budgetBusy, ladePosition, wochenKeysDesMonats, month, year, tenantKey, toast]);

  /** «Zurück auf abgeleitet/Ist»: hebt den manuellen Monats-Override auf.
   *  %-Positionen (pctValue) erhalten den abgeleiteten Wert zurück (Quote ×
   *  ER-Netto-Monat); Ratio-Zeilen fallen auf die Ableitung zurück (null);
   *  sonst leer («leer statt 0»). */
  const budgetMonatReset = useCallback(async (ckId: string) => {
    if (budgetBusy) return;
    setBudgetBusy(true);
    try {
      const { def, blob, pos } = await ladePosition(ckId);
      const prev: CockpitBudgetPosition = JSON.parse(JSON.stringify(pos));
      const mv = pos.monthlyValues.slice();
      const me = pos.monthlyExplicit.slice();
      let abgeleitet: number | null = null;
      if (def.kind === 'base' && (pos.inputMode ?? 'chf') === 'pct' && pos.pctValue !== null) {
        const er = erNettoBudgetMonate(year, tenantKey('budget_v1'))[month - 1];
        abgeleitet = typeof er === 'number'
          ? Math.round(er * pos.pctValue / 100 * 100) / 100 : null;
      }
      mv[month - 1] = abgeleitet;
      me[month - 1] = false;
      const neu = { ...pos, monthlyValues: mv, monthlyExplicit: me };
      blob.positions[ckId] = neu;
      await saveCockpitBudget(tenantKey, blob);
      setBudgetUndo({ ckId, year, prev, label: def.label, expectedAfter: neu });
      setBudgetReloadTick(t => t + 1);
      toast({
        title: 'Zurück auf abgeleitet/Ist',
        description: `${def.label} · ${MONATE[month - 1]} ${year}: manueller Monatswert entfernt`
          + (abgeleitet !== null ? ` — abgeleiteter Wert ${abgeleitet.toLocaleString('de-CH')} wiederhergestellt.` : ' — Zeile folgt wieder der Ableitung bzw. bleibt leer.'),
      });
    } catch (e) {
      toast({ title: 'Reset fehlgeschlagen', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally { setBudgetBusy(false); }
  }, [budgetBusy, ladePosition, month, year, tenantKey, toast]);

  /** Ein-Schritt-Rückgängig: stellt den Positions-Stand VOR der letzten Änderung wieder her. */
  const budgetUndoAusfuehren = useCallback(async () => {
    if (!budgetUndo || budgetBusy) return;
    setBudgetBusy(true);
    try {
      const blob = (await loadCockpitBudget(tenantKey, budgetUndo.year))
        ?? { year: budgetUndo.year, positions: {}, updatedAt: '', taNetto: true as const };
      // Konfliktwache: nur rückgängig machen, wenn die Position noch exakt
      // unserem Nach-Zustand entspricht (kein CAS im KV — Stale-Undo würde
      // sonst eine fremde Zwischenänderung stillschweigend löschen).
      const aktuell = blob.positions[budgetUndo.ckId] ?? null;
      if (JSON.stringify(aktuell) !== JSON.stringify(budgetUndo.expectedAfter)) {
        setBudgetUndo(null);
        toast({
          title: 'Rückgängig nicht möglich',
          description: `${budgetUndo.label}: Position wurde inzwischen anderweitig geändert (z.B. Budget-Eingabe) — nichts überschrieben.`,
          variant: 'destructive',
        });
        return;
      }
      if (budgetUndo.prev) blob.positions[budgetUndo.ckId] = budgetUndo.prev;
      else delete blob.positions[budgetUndo.ckId];
      await saveCockpitBudget(tenantKey, blob);
      setBudgetUndo(null);
      setBudgetReloadTick(t => t + 1);
      toast({ title: 'Rückgängig', description: `${budgetUndo.label}: vorheriger Stand wiederhergestellt.` });
    } catch (e) {
      toast({ title: 'Rückgängig fehlgeschlagen', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally { setBudgetBusy(false); }
  }, [budgetUndo, budgetBusy, tenantKey, toast]);

  const wocheRange = daten?.weekFrom && daten?.weekTo
    ? `${fmtDate(daten.weekFrom)}–${fmtDate(daten.weekTo)}`
    : null;

  // KW + Datum als Untertitel der Budget-/Vorjahr-Wochenspalten (gleiche Woche
  // wie die «Woche»-Spalte bzw. gleiche ISO-KW im Vorjahr).
  const parseIso = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const budgetWocheSub = daten?.weekFrom && daten?.weekTo
    ? `KW ${isoWeekOf(parseIso(daten.weekFrom)).week} · ${fmtDate(daten.weekFrom)}–${fmtDate(daten.weekTo)}`
    : null;
  const vjWocheSub = daten?.vjWeekFrom && daten?.vjWeekTo
    ? `KW ${isoWeekOf(parseIso(daten.vjWeekFrom)).week} · ${fmtDate(daten.vjWeekFrom)}–${fmtDate(daten.vjWeekTo)}${daten.vjWeekTo.slice(0, 4)}`
    : null;

  // PDF-Export der aktuell aktiven Ansicht «genau so wie angezeigt».
  const handlePdfExport = useCallback(async () => {
    // Panel + Metadaten je aktivem Tab bestimmen.
    let el: HTMLElement | null = null;
    let meta: CockpitPdfMeta | null = null;
    if (activeTab === 'monat') {
      el = monatPanelRef.current;
      meta = {
        title: 'Monatsübersicht',
        subtitle: `${MONATE[month - 1]} ${year}`,
        fileName: `cockpit-monatsuebersicht-${year}-${String(month).padStart(2, '0')}`,
        footnote: 'Budget = Monatsbudget · Vorjahr = gleicher Monat im Vorjahr (aus Tages-Vorjahresdaten) · Ist (Monat) = Ist bis heute · '
          + 'Δ% = Monat-Ist vs. Monatsbudget · Verhältnis-Kennzahlen (Take-Away-Anteil, Ø-Verkauf pro Gast, Produktivität) '
          + 'als Quote über den Monat, nicht summiert · Ø-Verkauf pro Gast nur über Tage mit beiden Quellen · '
          + 'Personalkosten = HOCHRECHNUNG des Monats (Budget = Zielquote × Umsatzbudget-Monat), Δ% gegen Monatsbudget · '
          + 'PKQ = Hochrechnung ÷ Hochrechnung, Budget = Ziel-PKQ, Δ in Prozentpunkten (über Ziel = rot), rot über Obergrenze 40 %; bei Personalkosten ist «über Budget» rot · '
          + 'Take Away Umsatz: Δ% gegen das Vorjahr (kein Budget) · '
          + 'Stunden-Block: Bedarf-Stunden (Soll) = Referenz; Dienstplan-/Ist-Stunden vergleichen sich gegen den BEDARF, nicht das Budget · '
          + 'leere Felder = keine Datenquelle vorhanden (nie 0). Wochenwerte im Tab «Wochenübersicht».',
      };
    } else if (activeTab === 'woche') {
      el = wochePanelRef.current;
      meta = {
        title: 'Wochenübersicht',
        subtitle: `${MONATE[month - 1]} ${year}${daten?.weekLabel ? ` · ${daten.weekLabel}` : ''}${wocheRange ? ` ${wocheRange}` : ''}`,
        fileName: `cockpit-wochenuebersicht-${year}-${String(month).padStart(2, '0')}`,
        footnote: 'Woche = gewählter Zeitraum, auf den Monat geklemmt · Budget = Budget-Wochenanteil dieses Zeitraums · '
          + 'Vorjahr = gleiche Kalenderwoche im Vorjahr (gleiche ISO-KW, aus Tages-Vorjahresdaten) · Ist = Woche · '
          + 'Δ% = Woche-Ist vs. Budget-Woche · Verhältnis-Kennzahlen (Take-Away-Anteil, Ø-Verkauf pro Gast, '
          + 'Produktivität) als Quote über die Woche, nicht summiert · Ø-Verkauf pro Gast nur über Tage mit beiden Quellen · '
          + 'Personalkosten = FIX pro-rata der Wochentage + FLEX-Ist (Budget = Zielquote × Netto-Umsatz-Budget-Woche), Δ% gegen Budget-Woche · '
          + 'PKQ = Ist ÷ Ist, Budget = Ziel-PKQ, Δ in Prozentpunkten (über Ziel = rot), rot über Obergrenze 40 %; bei Personalkosten ist «über Budget» rot · '
          + 'Take Away Umsatz: Δ% gegen das Vorjahr (kein Budget) · '
          + 'Stunden-Block: Bedarf-Stunden (Soll) = Referenz; Dienstplan-/Ist-Stunden vergleichen sich gegen den BEDARF, nicht das Budget · '
          + 'leere Felder = keine Datenquelle vorhanden (nie 0). Monatswerte im Tab «Monatsübersicht».',
      };
    } else if (activeTab === 'verlauf') {
      el = verlaufPanelRef.current;
      meta = verlaufMeta;
    } else {
      el = jahrPanelRef.current;
      meta = jahrMeta;
    }
    if (!el || !meta) {
      toast({ title: 'PDF-Export nicht möglich', description: 'Ansicht ist noch nicht geladen.', variant: 'destructive' });
      return;
    }
    setPdfLaeuft(true);
    try {
      await naechsterFrame(); // Recharts/Layout sicher fertig
      await exportCockpitPanelPDF(el, meta, heute);
    } catch (e) {
      toast({
        title: 'PDF-Export fehlgeschlagen',
        description: e instanceof Error ? e.message : 'Unbekannter Fehler',
        variant: 'destructive',
      });
    } finally {
      setPdfLaeuft(false);
    }
  }, [activeTab, month, year, daten, wocheRange, verlaufMeta, jahrMeta, heute, toast]);

  return (
    <PageShell>
      <div className="space-y-4 max-w-5xl">
        {/* Kopf */}
        <div className="flex items-center gap-3">
          <CalendarDays className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Cockpit</h1>
            <p className="text-xs text-muted-foreground">
              Meeting-Cockpit — automatisch gefüllte Kennzahlen, fehlende Quellen bleiben leer
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={onTabChange}>
          <div className="flex items-center justify-between gap-2">
            <TabsList data-testid="tabs-cockpit">
              <TabsTrigger value="jahr" data-testid="tab-jahr">Jahresübersicht</TabsTrigger>
              <TabsTrigger value="monat" data-testid="tab-monat">Monatsübersicht</TabsTrigger>
              <TabsTrigger value="woche" data-testid="tab-woche">Wochenübersicht</TabsTrigger>
              <TabsTrigger value="verlauf" data-testid="tab-verlauf">Wochenverlauf</TabsTrigger>
            </TabsList>
            <Button
              variant="outline" size="sm" className="h-8 gap-1.5"
              onClick={handlePdfExport}
              disabled={pdfLaeuft}
              data-testid="button-pdf-export"
            >
              {pdfLaeuft
                ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                : <FileDown className="h-4 w-4" />}
              PDF
            </Button>
          </div>

          {/* ── 1) Jahresübersicht (YTD) ── */}
          <TabsContent value="jahr" className="space-y-4" ref={jahrPanelRef}>
            <JahresvergleichView onPdfMeta={setJahrMeta} />
          </TabsContent>

          {/* ── 2) Monatsübersicht — dieselbe Report-Tabelle, Granularität «monat» ── */}
          <TabsContent value="monat" className="space-y-4" ref={monatPanelRef}>
            {/* Capture-only: schlichte Zeitraum-Zeile anstelle der Controls (nur im PDF sichtbar) */}
            <div className="pdf-only hidden items-center gap-2 text-sm font-semibold" data-testid="pdf-summary-monat">
              {MONATE[month - 1]} {year}
            </div>
            <div className="pdf-hide flex flex-wrap items-center justify-end gap-2">
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
                variant={showVj ? 'default' : 'outline'} size="sm" className="h-8 ml-2"
                onClick={() => setShowVj(v => !v)}
                data-testid="button-toggle-vj-monat"
              >
                Vorjahr {showVj ? 'ein' : 'aus'}
              </Button>
              <Button
                variant={budgetEdit ? 'default' : 'outline'} size="sm" className="h-8 gap-1.5"
                onClick={() => setBudgetEdit(v => !v)}
                disabled={!daten || loading || budgetBusy}
                data-testid="button-toggle-budget-edit"
              >
                {budgetEdit ? <Check className="h-4 w-4" /> : <PencilLine className="h-4 w-4" />}
                {budgetEdit ? 'Fertig' : 'Budget bearbeiten'}
              </Button>
              {budgetUndo && (
                <Button
                  variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground"
                  onClick={budgetUndoAusfuehren} disabled={budgetBusy}
                  data-testid="button-budget-undo"
                >
                  <Undo2 className="h-4 w-4" /> Rückgängig
                </Button>
              )}
              <RowOrderControls
                editMode={editRows}
                onToggle={() => setEditRows(v => !v)}
                onReset={() => { resetOrder(); }}
                disabled={!daten || loading}
              />
              <Button
                size="sm" className="gap-1.5 ml-2"
                disabled={!daten || loading}
                onClick={() => daten && exportMonatsreportXlsx(orderedRows, year, month, 'monat', daten.waren)}
                data-testid="button-export-excel-monat"
              >
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </Button>
            </div>

            {fehler && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                Fehler beim Laden: {fehler}
              </div>
            )}
            {loading && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}
            {!loading && daten && (
              <ReportTable
                rows={orderedRows}
                granularity="monat"
                budgetSub="Monatsbudget"
                vjHeader={`Vorjahr (Monat ${year - 1})`}
                vjSub={`${MONATE[month - 1]} ${year - 1}`}
                istHeader="Ist (Monat)"
                istSub="bis heute"
                testid="table-monatsuebersicht"
                editMode={editRows}
                onReorder={reorderRows}
                onDrill={(id) => openDrill(id, 'monat')}
                showVj={showVj}
                budgetEdit={budgetEdit}
                onBudgetEdit={budgetMonatSetzen}
                onBudgetReset={budgetMonatReset}
              />
            )}

            <p className="pdf-footnote text-xs text-muted-foreground">
              Budget = Monatsbudget · Vorjahr = gleicher Monat im Vorjahr (aus Tages-Vorjahresdaten) ·
              Ist (Monat) = Ist bis heute · Δ% = Monat-Ist vs. Monatsbudget · Verhältnis-Kennzahlen
              (Take-Away-Anteil, Ø-Verkauf pro Gast, Produktivität) werden als Quote
              über den Monat gebildet, nicht summiert · Ø-Verkauf pro Gast nur über Tage mit
              beiden Quellen · Personalkosten = HOCHRECHNUNG des Monats (Budget = Zielquote ×
              Umsatzbudget-Monat), Δ% gegen Monatsbudget · PKQ = Hochrechnung ÷ Hochrechnung, Budget =
              Ziel-PKQ (Budget-Personalkosten ÷ Budget-Umsatz), Δ in PROZENTPUNKTEN (über Ziel = rot), rot über
              Obergrenze 40 %; bei Personalkosten ist «über Budget» rot (Kosten) · Take Away Umsatz:
              Δ% gegen das Vorjahr, da kein Budget vorhanden («vs. VJ») · Personalkosten/PKQ
              (Vorjahr) = schreibgeschützter Buchhaltungswert «aus Buchhaltung {year - 1}» (nur Jahre ohne
              Dienstplan-Berechnung, keine Wochen-Verteilung) · Bedarf-Stunden (Soll) = Leitplanke aus dem
              Personalbedarf; Dienstplan- und Ist-Stunden vergleichen sich gegen den BEDARF, nicht gegen das Budget (Δ% dazu, über Bedarf = rot) · leere Felder = keine
              Datenquelle vorhanden (nie 0). Wochenwerte im Tab «Wochenübersicht», Jahreswerte im Tab
              «Jahresübersicht».
            </p>
          </TabsContent>

          {/* ── 3) Wochenübersicht — dieselbe Report-Tabelle, Granularität «woche» ── */}
          <TabsContent value="woche" className="space-y-4" ref={wochePanelRef}>
            {/* Capture-only: schlichte Zeitraum-Zeile anstelle der Controls (nur im PDF sichtbar) */}
            <div className="pdf-only hidden items-center gap-2 text-sm font-semibold" data-testid="pdf-summary-woche">
              {MONATE[month - 1]} {year}
              {datenPrev?.weekLabel ? ` · ${datenPrev.weekLabel}` : ''}
              {daten?.weekLabel ? ` · ${daten.weekLabel}` : ''}
              {wocheRange ? ` ${wocheRange}` : ''}
            </div>
            <div className="pdf-hide flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={prev} data-testid="button-prev-month-woche">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[130px] text-center text-sm font-semibold" data-testid="text-month-label-woche">
                {MONATE[month - 1]} {year}
              </span>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={next} data-testid="button-next-month-woche">
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8 ml-2"
                onClick={() => shiftWeek(-1)} title="Eine Woche zurück"
                data-testid="button-prev-week">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => shiftWeek(1)} title="Eine Woche vor"
                data-testid="button-next-week">
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Select value={weekValue} onValueChange={setWeekValue}>
                <SelectTrigger className="h-8 w-[210px] text-xs" data-testid="select-week">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WEEK_LASTCOMPLETE}>Letzte abgeschlossene Woche</SelectItem>
                  <SelectItem value={WEEK_CURRENT}>Aktuelle Woche</SelectItem>
                  <SelectItem value={WEEK_LAST7}>Letzte 7 Tage</SelectItem>
                  {kwOptions.map(o => (
                    <SelectItem key={kwValue(o)} value={kwValue(o)}>{kwOptionLabel(o)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editRows && (
                <Button
                  variant={showVj ? 'default' : 'outline'} size="sm" className="h-8 ml-2"
                  onClick={() => setShowVj(v => !v)}
                  data-testid="button-toggle-vj-woche"
                >
                  Vorjahr {showVj ? 'ein' : 'aus'}
                </Button>
              )}
              <RowOrderControls
                editMode={editRows}
                onToggle={() => setEditRows(v => !v)}
                onReset={() => { resetOrder(); }}
                disabled={!daten || loading}
              />
              <Button
                size="sm" className="gap-1.5 ml-2"
                disabled={!daten || loading}
                onClick={() => daten && exportMonatsreportXlsx(orderedRows, year, month, 'woche', daten.waren)}
                data-testid="button-export-excel"
              >
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </Button>
            </div>

            {fehler && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                Fehler beim Laden: {fehler}
              </div>
            )}
            {loading && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}
            {/* «Zeilen anordnen» weiter über die 1-Wochen-Tabelle (Drag & Drop);
                Normalansicht = kompakte 2-Wochen-Tabelle (Vorwoche + Woche). */}
            {!loading && daten && editRows && (
              <ReportTable
                rows={orderedRows}
                granularity="woche"
                budgetSub={budgetWocheSub}
                vjHeader={`Vorjahr (Woche ${year - 1})`}
                vjSub={vjWocheSub}
                istHeader={daten?.weekLabel ?? 'Woche'}
                istSub={wocheRange}
                testid="table-wochenuebersicht"
                editMode={editRows}
                onReorder={reorderRows}
                onDrill={(id) => openDrill(id, 'woche')}
                showVj={showVj}
              />
            )}
            {!loading && daten && !editRows && (
              <>
                {loadingPrev && (
                  <p className="text-xs text-muted-foreground">Lade Vorwoche …</p>
                )}
                <ZweiWochenTable
                  rowsA={datenPrev?.rows ?? null}
                  rowsB={orderedRows}
                  headerA={datenPrev?.weekLabel ?? 'Vorwoche'}
                  subA={datenPrev?.weekFrom && datenPrev?.weekTo
                    ? `${fmtDate(datenPrev.weekFrom)}–${fmtDate(datenPrev.weekTo)}`
                    : null}
                  headerB={daten?.weekLabel ?? 'Woche'}
                  subB={wocheRange}
                  testid="table-wochenuebersicht"
                  onDrill={(id) => openDrill(id, 'woche')}
                />
              </>
            )}

            <p className="pdf-footnote text-xs text-muted-foreground">
              Ansicht = die gewählte Woche ({daten?.weekLabel ?? '—'}
              {wocheRange ? `, ${wocheRange}` : ''}) plus die Vorwoche nebeneinander, je Woche
              Ist / Budget / Δ; die Pfeile schieben das 2-Wochen-Fenster eine KW vor/zurück ·
              Woche = volle ISO-Woche, auch über Monatsgrenzen — jeder Tag zieht
              Ist und Budget aus seinem eigenen Monat; nur die laufende Woche ist auf die Ist-Tage
              bis heute geklemmt · Budget = Budget-Wochenanteil dieses Zeitraums · Warenkosten total:
              Ist = erfasste Lieferantenrechnungen (netto), Soll = WEQ × Ist-Netto-Umsatz ·
              Warenkosten Food/Beverage: Ist = Kategorie-Anteile der Rechnungen, Soll = Kategorie-WEQ ×
              Food-/Beverage-Umsatz, WKQ = Ist ÷ Kategorie-Umsatz — die
              Ist-Warenkosten sind wochenweise sprunghaft (Lieferungen fallen in einzelne Wochen);
              aussagekräftig ist der Monatsvergleich, der Wochen-Δ schwankt naturgemäss ·
              Vorjahr = gleiche Kalenderwoche im Vorjahr
              (gleiche ISO-KW, aus Tages-Vorjahresdaten) · Ist = Woche · Δ% = Woche-Ist vs. Budget-Woche ·
              Verhältnis-Kennzahlen (Take-Away-Anteil, Ø-Verkauf pro Gast,
              Produktivität) werden als Quote über die Woche gebildet, nicht summiert · Ø-Verkauf pro Gast =
              Netto ÷ Gäste nur über Tage mit beiden Quellen · Personalkosten = FIX pro-rata der Wochentage
              + FLEX-Ist (Budget = Zielquote × Netto-Umsatz-Budget-Woche), Δ% gegen Budget-Woche · PKQ =
              Ist ÷ Ist, Budget = Ziel-PKQ, Δ in PROZENTPUNKTEN (über Ziel = rot), rot über Obergrenze 40 %;
              bei Personalkosten ist «über Budget» rot (Kosten) · Take Away Umsatz: Δ% gegen das Vorjahr («vs. VJ») ·
              leere Felder = keine Datenquelle vorhanden (nie 0). Monatswerte im Tab «Monatsübersicht».
            </p>
          </TabsContent>

          {/* ── 4) Wochenverlauf (unverändert) ── */}
          <TabsContent value="verlauf" className="space-y-4" ref={verlaufPanelRef}>
            <WochenverlaufView onPdfMeta={setVerlaufMeta} />
          </TabsContent>
        </Tabs>

        {/* ── Warenkosten-Block (folgt dem Cockpit-Monat) ── */}
        <div className="pdf-hide">
          <CockpitWarenkosten year={year} month={month} />
        </div>

        {/* ── Reservations-Drilldown (Kennzahl → zugrunde liegende Reservationen) ── */}
        <Dialog open={drill !== null} onOpenChange={(o) => { if (!o) setDrill(null); }}>
          <DialogContent className="max-w-2xl" data-testid="dialog-reservation-drill">
            <DialogHeader>
              <DialogTitle>{drill?.title ?? ''}</DialogTitle>
              <DialogDescription>
                {drill?.sub ?? ''} · gezählt nach der zentralen Zählregel
                (Quelle: Foratable-CSV-Import)
              </DialogDescription>
            </DialogHeader>
            {drill?.loading && (
              <p className="text-sm text-muted-foreground py-4">Lade Reservationen …</p>
            )}
            {drill?.error && (
              <p className="text-sm text-red-600 py-2">Fehler: {drill.error}</p>
            )}
            {drill && !drill.loading && !drill.error && (
              drill.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                  Keine Reservationen im Zeitraum (oder noch kein Foratable-Import vorhanden).
                </p>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
                  <table className="w-full text-sm" data-testid="table-reservation-drill">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Datum</th>
                        <th className="px-3 py-2 font-medium">Zeit</th>
                        <th className="px-3 py-2 font-medium text-right">Pers.</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Bereich</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drill.rows.map((r, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">
                            {`${r.reservationDate.slice(8, 10)}.${r.reservationDate.slice(5, 7)}.${r.reservationDate.slice(0, 4)}`}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums">{r.reservationTime ? r.reservationTime.slice(0, 5) : '—'}</td>
                          <td className="px-3 py-1.5 tabular-nums text-right">{r.partySize}</td>
                          <td className="px-3 py-1.5">{r.name}</td>
                          <td className="px-3 py-1.5">{r.status}</td>
                          <td className="px-3 py-1.5">{r.area ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t">
                    {drill.rows.length} Reservationen · Σ {drill.rows.reduce((s, r) => s + r.partySize, 0)} Personen
                  </p>
                </div>
              )
            )}
          </DialogContent>
        </Dialog>
      </div>
    </PageShell>
  );
}

// ── Wochenverlauf-Ansicht ─────────────────────────────────────────────────────

const WEEK_COUNT_OPTIONS = [2, 4, 8];

/** Trend gegenüber Vorwoche in %, null wenn eine der beiden Wochen leer ist. */
function trendPct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** Mini-Sparkline (Inline-SVG) über die Wochenwerte; fehlende Wochen übersprungen. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const pts = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <span className="text-muted-foreground">—</span>;
  const w = 64, h = 20, pad = 2;
  const vs = pts.map(p => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => pad + (n <= 1 ? 0 : (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const poly = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1].v >= pts[0].v;
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden="true">
      <polyline
        points={poly} fill="none" strokeWidth={1.5}
        className={up ? 'stroke-emerald-500' : 'stroke-red-500'}
      />
    </svg>
  );
}

function WochenverlaufView({ onPdfMeta }: { onPdfMeta: (m: CockpitPdfMeta) => void }) {
  const heute = useMemo(() => new Date(), []);
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();

  const [anzahl, setAnzahl] = useState(4);
  const [jahr, setJahr] = useState(heute.getFullYear());
  const [mitVorjahr, setMitVorjahr] = useState(false);
  const [ansicht, setAnsicht] = useState<'table' | 'chart'>('table');
  const [daten, setDaten] = useState<WochenverlaufDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  // Offene ausklappbare Gruppen (z.B. 'warenkosten_total'); Standard eingeklappt.
  const [offeneGruppen, setOffeneGruppen] = useState<Set<string>>(() => new Set());

  // Jahr-Optionen: aktuelles Jahr … 2024.
  const jahrOptions = useMemo(() => {
    const cur = heute.getFullYear();
    const out: number[] = [];
    for (let y = cur; y >= 2024; y--) out.push(y);
    return out;
  }, [heute]);
  const istAktuellesJahr = jahr === heute.getFullYear();

  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetBusy, setBudgetBusy] = useState(false);
  // Ein-Schritt-Rückgängig: Positions-Snapshot VOR der letzten Änderung.
  const [budgetUndo, setBudgetUndo] = useState<{
    ckId: string; year: number; prev: CockpitBudgetPosition | null; label: string;
    /** Positions-Stand NACH unserer Änderung — Undo nur, wenn er noch gilt
     *  (sonst hat inzwischen jemand anderes geändert → Konflikt, kein Write). */
    expectedAfter: CockpitBudgetPosition;
  } | null>(null);
  const [budgetReloadTick, setBudgetReloadTick] = useState(0);

  useEffect(() => {
    if (ratesLoading || !rates) return;
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeWochenverlauf(anzahl, tenantId, tenantKey, rates, heute, mitVorjahr, jahr)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [anzahl, jahr, mitVorjahr, tenantId, tenantKey, rates, ratesLoading, heute]);

  const showVj = mitVorjahr && !!daten?.vjWeeks;
  // Grafik braucht Vorjahresdaten (zwei Linien) → nur bei mitVorjahr wählbar.
  // Wird der Toggle abgeschaltet, fällt die Ansicht automatisch auf Tabelle.
  const effektiveAnsicht: 'table' | 'chart' = mitVorjahr ? ansicht : 'table';

  const einstellungText = `${jahr} · letzte ${anzahl} Wochen${mitVorjahr ? ' · mit Vorjahr' : ''} · ${effektiveAnsicht === 'chart' ? 'Grafik' : 'Tabelle'}`;

  // PDF-Metadaten an die Seite melden (Titel/Zeitraum/Dateiname je nach Einstellungen).
  useEffect(() => {
    const ans = effektiveAnsicht === 'chart' ? 'grafik' : 'tabelle';
    onPdfMeta({
      title: 'Wochenverlauf',
      subtitle: einstellungText,
      fileName: `cockpit-wochenverlauf-${jahr}-${anzahl}w-${ans}`,
      // Orientierung nach Wochen-Anzahl: ≤2 Wochen Hochformat, ≥3 Querformat —
      // immer 1 Seite, ganze Tabelle auf Seitenbreite. Klonbreite passend zur
      // Spaltenzahl (schmaler = grössere Schrift, nichts abgeschnitten).
      orientation: ans === 'tabelle' ? (anzahl <= 2 ? 'portrait' : 'landscape') : undefined,
      cloneWidthPx: ans === 'tabelle'
        ? (anzahl <= 2 ? 1000 : anzahl <= 4 ? 1400 : 1700)
        : undefined,
      footnote: 'Wochenverlauf = ISO-Kalenderwochen inkl. laufender Woche (Mo–So, älteste links, aktuelle Woche ganz rechts) · '
        + 'laufende Woche = partiell bis heute; Trend/VJ-Δ/Verlauf nur über volle Wochen · Trend ▲/▼ = Veränderung zur Vorwoche · '
        + 'Verlauf = Mini-Trend über alle Wochen · gleiche Quellen & Berechnung wie die Monatsübersicht · '
        + 'B = Cockpit-Budget der KW (Monatsbudget pro rata über die Tagesanteile, KW-Override falls gesetzt; laufende Woche bis heute geklemmt) '
        + 'mit Δ Ist−Budget absolut und in % · '
        + 'leere Felder (—) = keine Datenquelle, nie 0 · Ø-Verkauf pro Gast nur über Tage mit beiden Quellen'
        + (mitVorjahr ? ' · Vorjahr = kleine Zeile darunter + Δ%; Produktive Stunden/Produktivität haben keine VJ-Quelle.' : '.'),
    });
  }, [onPdfMeta, jahr, anzahl, mitVorjahr, effektiveAnsicht, einstellungText]);

  return (
    <>
      {/* Capture-only: Einstellungs-Zusammenfassung anstelle der Controls */}
      <div className="pdf-only hidden items-center gap-2 text-sm font-semibold" data-testid="pdf-summary-wochen">
        Wochenverlauf · {einstellungText}
      </div>
      <div className="pdf-hide flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">Jahr</span>
        <Select value={String(jahr)} onValueChange={v => setJahr(Number(v))}>
          <SelectTrigger className="h-8 w-24 text-xs" data-testid="select-jahr">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {jahrOptions.map(y => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={mitVorjahr ? 'default' : 'outline'}
          size="sm" className="h-8 gap-1.5 ml-2"
          aria-pressed={mitVorjahr}
          onClick={() => setMitVorjahr(v => !v)}
          data-testid="button-toggle-vorjahr"
        >
          <GitCompareArrows className="h-4 w-4" /> Vorjahr vergleichen
        </Button>

        {/* Tabelle ⇄ Grafik. Grafik nur bei aktivem Vorjahresvergleich. */}
        <ToggleGroup
          type="single"
          value={effektiveAnsicht}
          onValueChange={v => { if (v === 'table' || v === 'chart') setAnsicht(v); }}
          className="ml-2"
          data-testid="toggle-ansicht"
        >
          <ToggleGroupItem value="table" size="sm" className="h-8 w-8 p-0" aria-label="Tabelle" data-testid="toggle-tabelle">
            <Table2 className="h-4 w-4" />
          </ToggleGroupItem>
          {mitVorjahr ? (
            <ToggleGroupItem value="chart" size="sm" className="h-8 w-8 p-0" aria-label="Grafik" data-testid="toggle-grafik">
              <ChartLine className="h-4 w-4" />
            </ToggleGroupItem>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* deaktivierte Grafik-Option: erst «Vorjahr vergleichen» einschalten */}
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/40 cursor-not-allowed" data-testid="toggle-grafik-disabled">
                  <ChartLine className="h-4 w-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent>«Vorjahr vergleichen» einschalten, um die Grafik zu sehen</TooltipContent>
            </Tooltip>
          )}
        </ToggleGroup>

        <span className="text-xs text-muted-foreground ml-2">Anzahl Wochen</span>
        <Select value={String(anzahl)} onValueChange={v => setAnzahl(Number(v))}>
          <SelectTrigger className="h-8 w-20 text-xs" data-testid="select-week-count">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEEK_COUNT_OPTIONS.map(n => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {fehler && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fehler beim Laden: {fehler}
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}

      {!loading && daten && effektiveAnsicht === 'chart' && showVj && (
        <WochenverlaufChart daten={daten} jahr={jahr} />
      )}

      {!loading && daten && effektiveAnsicht === 'table' && (
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-wochenverlauf">
            <thead>
              <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
                {daten.weeks.map((w, ci) => {
                  const vjw = daten.vjWeeks?.[ci] ?? null;
                  const partial = daten.partialWeekIndex === ci;
                  return (
                    <th key={`${w.kwYear}-${w.kw}`} className="px-3 py-2 text-right font-semibold">
                      KW {w.kw}{partial ? ' (laufend)' : ''}
                      <span className="block normal-case font-normal">
                        {fmtDate(w.from)}–{fmtDate(w.to)}
                      </span>
                      {showVj && (
                        <span className="block normal-case font-normal text-muted-foreground/70">
                          {vjw ? `VJ ${vjw.kwYear}` : 'VJ —'}
                        </span>
                      )}
                    </th>
                  );
                })}
                <th className="px-3 py-2 text-right font-semibold">Verlauf</th>
              </tr>
            </thead>
            <tbody>
              {daten.rows.map((row, ri) => {
                // Ausklappbare Kinder (z.B. Lieferanten unter «Warenkosten
                // total»): Standard eingeklappt; Chevron auf der Eltern-Zeile.
                if (row.childOf && !offeneGruppen.has(row.childOf)) return null;
                const hatKinder = !!row.id && daten.rows.some(r2x => r2x.childOf === row.id);
                const istOffen = !!row.id && offeneGruppen.has(row.id);
                return (
                <tr key={ri} className={cn('border-b last:border-0 hover:bg-muted/30 align-top', row.bold && 'font-semibold', row.childOf && 'bg-muted/10')}>
                  <td className={cn('px-3 py-1.5', row.childOf && 'pl-9 text-xs text-muted-foreground font-normal')}>
                    {hatKinder ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-left hover:underline"
                        onClick={() => setOffeneGruppen(prev => {
                          const next = new Set(prev);
                          if (row.id) { if (next.has(row.id)) next.delete(row.id); else next.add(row.id); }
                          return next;
                        })}
                        aria-expanded={istOffen}
                        data-testid={`button-toggle-verlauf-${row.id}`}
                      >
                        {istOffen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        {row.label}
                      </button>
                    ) : row.label}
                  </td>
                  {row.values.map((v, ci) => {
                    // Laufende (partielle) Woche: Trend-/VJ-Δ unterdrücken —
                    // partiell vs. volle Woche wäre nicht aussagekräftig.
                    const partial = daten.partialWeekIndex === ci;
                    const prev = ci > 0 ? row.values[ci - 1] : null;
                    const t = ci > 0 && !partial ? trendPct(v, prev) : null;
                    const vjV = showVj ? (row.vjValues?.[ci] ?? null) : null;
                    const vjDelta = showVj && !partial ? trendPct(v, vjV) : null;
                    const wkqV = row.wkqValues?.[ci] ?? null;
                    const wkqGut = wkqV != null && row.wkqZiel != null ? wkqV <= row.wkqZiel : null;
                    return (
                      <td key={ci} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                        <span className="block">
                          {v === null ? <span className="text-muted-foreground">—</span> : (
                            <span className={cn(row.tint === 'green' && 'text-emerald-600 dark:text-emerald-400',
                              row.tint === 'red' && 'text-red-600 dark:text-red-400')}>
                              {fmtCell(v, row.fmt)}
                            </span>
                          )}
                          {t !== null && (
                            <span className={cn('ml-1.5 text-[10px] font-normal',
                              t >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                              {t >= 0 ? '▲' : '▼'}{Math.abs(t).toFixed(0)}%
                            </span>
                          )}
                        </span>
                        {/* Kompakte Quote unter dem CHF-Wert: «Warenkosten total» mit
                            Ziel-Ampel (wkqZiel), Lieferanten-Zeilen neutral (Anteil
                            am Netto-Umsatz der KW, ohne Ampel). */}
                        {row.wkqValues && (
                          <span className={cn('block text-[10px] font-normal',
                            wkqV == null || row.wkqZiel == null ? 'text-muted-foreground'
                              : wkqGut ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                            {row.wkqZiel != null
                              ? (wkqV == null ? 'WKQ —' : `WKQ ${wkqV.toFixed(1)} %`)
                              : (wkqV == null ? '—' : `${wkqV.toFixed(1)} %`)}
                          </span>
                        )}
                        {/* Budget-Subzeile: «B <Wochenbudget> Δabs (Δ%)» — pro-rata-
                            KW-Budget (laufende Woche bis heute geklemmt). Kein
                            Budget → keine Subzeile (leer statt 0, nie ÷ 0). */}
                        {(() => {
                          const bv = row.budgetValues?.[ci] ?? null;
                          if (bv === null) return null;
                          const dAbs = v !== null ? v - bv : null;
                          const dPct = dAbs !== null && bv !== 0 ? (dAbs / bv) * 100 : null;
                          const gut = dAbs !== null
                            ? (row.budgetInverted ? dAbs <= 0 : dAbs >= 0) : null;
                          return (
                            <span className="block text-[10px] font-normal text-muted-foreground"
                              data-testid={`budget-sub-${ri}-${ci}`}>
                              {'B '}{fmtCell(bv, row.fmt)}
                              {dAbs !== null && (
                                <span className={cn('ml-1',
                                  gut ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-red-600 dark:text-red-400')}>
                                  {dAbs >= 0 ? '+' : '−'}{fmtCell(Math.abs(dAbs), row.fmt)}
                                  {dPct !== null && ` (${dPct >= 0 ? '+' : ''}${dPct.toFixed(0)}%)`}
                                </span>
                              )}
                            </span>
                          );
                        })()}
                        {showVj && (
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {vjV === null ? '—' : fmtCell(vjV, row.fmt)}
                            {vjDelta !== null && (
                              <span className={cn('ml-1', vjDelta >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                                {vjDelta >= 0 ? '+' : ''}{vjDelta.toFixed(0)}%
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right">
                    {/* Sparkline nur über volle Wochen (laufende Woche ausgeblendet). */}
                    <Sparkline values={row.values.map((v, ci) =>
                      daten.partialWeekIndex === ci ? null : v)} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {effektiveAnsicht === 'table' && (
        <p className="pdf-footnote text-xs text-muted-foreground">
          Wochenverlauf {jahr} = {istAktuellesJahr
            ? `letzte ${anzahl} ISO-Kalenderwochen inkl. laufender Woche`
            : `dieselben ${anzahl} KW-Nummern wie aktuell, aber im Jahr ${jahr}`} (Mo–So, älteste links, aktuelle Woche ganz rechts) ·
          {istAktuellesJahr && ' laufende Woche = partiell bis heute (Trend/VJ-Δ/Verlauf nur über volle Wochen) ·'}
          Trend ▲/▼ = Veränderung zur Vorwoche · Verlauf = Mini-Trend über alle Wochen ·
          gleiche Quellen &amp; Berechnung wie die Monatsübersicht · leere Felder (—) = keine Datenquelle,
          nie 0. Ø-Verkauf pro Gast nur über Tage mit beiden Quellen.
          {!istAktuellesJahr && ` · ${jahr} aus Vorjahresdaten (vj_daily); Produktive Stunden/Produktivität nur fürs aktuelle Jahr → «—».`}
          {showVj && ` · Vergleich = gleiche ISO-KW ${jahr - 1} (kleine Zeile darunter + Δ%); Produktive Stunden/Produktivität haben keine Vergleichsquelle.`}
        </p>
      )}
    </>
  );
}

// ── Wochenverlauf: Grafik (Small Multiples, Aktuell vs. Vorjahr) ─────────────

/** Kennzahlen (Reihenfolge) fürs Grafik-Grid — ohne Produktive Stunden/Produktivität. */
const CHART_METRICS = [
  'Brutto Umsatz', 'Netto Umsatz', 'Gäste IN',
  'Take Away Anteil',
];

/** Kompaktes Achsen-Label: 60'000 → «60k», 1'250'000 → «1.25M». */
function fmtAxisCompact(v: number, fmt: MrRow['fmt']): string {
  if (fmt === 'pct') return `${v.toFixed(0)}%`;
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toLocaleString('de-CH', { maximumFractionDigits: 1 })}M`;
  if (a >= 1_000) return `${Math.round(v / 1_000)}k`;
  return fmtNum(v, 0);
}

/** Ein Mini-Liniendiagramm (aktuelles Jahr Volllinie, Vorjahr gestrichelt). */
function MiniChart({ row, weeks, partialWeekIndex }: {
  row: WochenverlaufRow; weeks: WochenverlaufDaten['weeks']; partialWeekIndex: number | null;
}) {
  const data = weeks.map((w, i) => ({
    kw: `KW ${w.kw}${partialWeekIndex === i ? '*' : ''}`,
    cur: row.values[i],
    vj: row.vjValues?.[i] ?? null,
  }));
  // Δ% = letzte VOLLE Woche vs. gleiche VJ-Woche (laufende Woche ist partiell
  // → für den Vergleich überspringen; nur wenn beide Werte vorhanden).
  let lastFull = row.values.length - 1;
  if (partialWeekIndex === lastFull) lastFull--;
  const lastCur = lastFull >= 0 ? row.values[lastFull] ?? null : null;
  const lastVj = lastFull >= 0 ? row.vjValues?.[lastFull] ?? null : null;
  const delta = trendPct(lastCur, lastVj);

  return (
    <div className="rounded-lg border bg-card p-2.5 shadow-sm" data-testid={`chart-${row.label}`}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold">{row.label}</span>
        {delta !== null && (
          <span className={cn('text-[10px] font-medium', delta >= 0 ? 'text-emerald-600' : 'text-red-600')}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(0)}% ggü. VJ
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
          <XAxis dataKey="kw" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis
            width={38} tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => fmtAxisCompact(v, row.fmt)}
          />
          <ReTooltip
            formatter={(value: number | null, name: string) =>
              [value == null ? '—' : fmtCell(value, row.fmt), name]}
            labelClassName="text-xs" contentStyle={{ fontSize: 12 }}
          />
          {/* Vorjahr: hellgrau + gestrichelt (Unterscheidung nicht nur über Farbe). */}
          <Line
            type="monotone" dataKey="vj" name="Vorjahr"
            stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeDasharray="5 4"
            dot={false} connectNulls={false} isAnimationActive={false}
          />
          {/* Aktuelles Jahr: kräftige Volllinie in der Akzentfarbe. */}
          <Line
            type="monotone" dataKey="cur" name="Aktuell"
            stroke="hsl(var(--primary))" strokeWidth={2.25}
            dot={{ r: 2 }} connectNulls={false} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function WochenverlaufChart({ daten, jahr }: { daten: WochenverlaufDaten; jahr: number }) {
  const charts = CHART_METRICS
    .map(label => daten.rows.find(r => r.label === label))
    .filter((r): r is WochenverlaufRow => !!r);

  return (
    <div className="space-y-3" data-testid="wochenverlauf-grafik">
      {/* Gemeinsame Legende oben (Jahre gemäss Auswahl) */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <svg width="24" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="24" y2="4" stroke="hsl(var(--primary))" strokeWidth="2.25" />
          </svg>
          {jahr}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="24" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="24" y2="4" stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" strokeDasharray="5 4" />
          </svg>
          {jahr - 1}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {charts.map(row => (
          <MiniChart key={row.label} row={row} weeks={daten.weeks}
            partialWeekIndex={daten.partialWeekIndex} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Produktive Stunden/Produktivität: keine Vorjahresdaten · Δ% = letzte VOLLE Woche vs. gleiche KW im Vorjahr ·
        * = laufende (partielle) Woche · Lücken = keine Datenquelle (nie 0).
      </p>
    </div>
  );
}

// ── Jahresvergleich-Ansicht (wählbarer Zeitraum) ──────────────────────────────

// Session-Cache: der Load ist teuer (bis zu 12 Monate PK + Vorjahr) und
// Radix-Tabs unmounten inaktive Inhalte — ohne Cache würde jeder Tab-Wechsel
// alles neu laden. Key = Mandant + Kalendertag + Modus + Zeitraum (sonst liefert
// der Cache beim Umschalten des Zeitraums falsche Daten!).
let jahresvergleichCache: { key: string; daten: JahresvergleichDaten } | null = null;

function JahresvergleichView({ onPdfMeta }: { onPdfMeta: (m: CockpitPdfMeta) => void }) {
  const heute = useMemo(() => new Date(), []);
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();

  const curYear = heute.getFullYear();
  const heuteIso = heute.toISOString().slice(0, 10);

  // Jahres-Navigation: frei wählbares Basisjahr, Vergleich immer Jahr vs. Jahr−1.
  const JAHR_MIN = 2022;
  const [jahr, setJahr] = useState(curYear);
  const istLaufendesJahr = jahr === curYear;

  const [modus, setModus] = useState<VergleichsModus>('ytd');
  // Eigener Zeitraum: Default 01.01. → heute (bzw. 31.12. bei abgeschlossenem Jahr).
  const [von, setVon] = useState(`${curYear}-01-01`);
  const [bis, setBis] = useState(heuteIso);
  // Vorjahr-Spalten nur per Toggle (Default AUS — Budget-Vergleich im Fokus).
  const [showVj, setShowVj] = useState(false);

  const wechsleJahr = (j: number) => {
    if (j < JAHR_MIN || j > curYear) return;
    setJahr(j);
    // Abgeschlossenes Jahr kennt kein YTD → explizit auf «Ganzes Jahr» stellen.
    if (j !== curYear && modus === 'ytd') setModus('ganzjahr');
    // Eigener Zeitraum auf das neue Jahr zurücksetzen (Grenzen ändern sich).
    setVon(`${j}-01-01`);
    setBis(j === curYear ? heuteIso : `${j}-12-31`);
  };

  const jahrMin = `${jahr}-01-01`;
  const jahrMax = `${jahr}-12-31`;
  // Validierung nur im custom-Modus: von ≤ bis. Sonst kein Load, Hinweis anzeigen.
  const customValid = modus !== 'custom' || (!!von && !!bis && von <= bis);

  // Ladeparameter für den aktiven Modus (custom nur bei gültigem Bereich).
  const loadVon = modus === 'custom' ? von : undefined;
  const loadBis = modus === 'custom' ? bis : undefined;

  const cacheKey = `${tenantId}:${heuteIso}:${jahr}:${modus}:${modus === 'custom' ? `${von}_${bis}` : '-'}`;
  const cached = jahresvergleichCache?.key === cacheKey ? jahresvergleichCache!.daten : null;
  const [daten, setDaten] = useState<JahresvergleichDaten | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [fehler, setFehler] = useState<string | null>(null);

  // Lazy: erst beim Öffnen des Tabs (Mount) laden; Reload bei Modus-/Zeitraumwechsel.
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetBusy, setBudgetBusy] = useState(false);
  // Ein-Schritt-Rückgängig: Positions-Snapshot VOR der letzten Änderung.
  const [budgetUndo, setBudgetUndo] = useState<{
    ckId: string; year: number; prev: CockpitBudgetPosition | null; label: string;
    /** Positions-Stand NACH unserer Änderung — Undo nur, wenn er noch gilt
     *  (sonst hat inzwischen jemand anderes geändert → Konflikt, kein Write). */
    expectedAfter: CockpitBudgetPosition;
  } | null>(null);
  const [budgetReloadTick, setBudgetReloadTick] = useState(0);

  useEffect(() => {
    if (ratesLoading || !rates) return;
    if (!customValid) { setDaten(null); setLoading(false); return; }
    if (jahresvergleichCache?.key === cacheKey) {
      setDaten(jahresvergleichCache.daten);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setFehler(null);
    ladeJahresvergleich(tenantId, tenantKey, rates, heute, modus, loadVon, loadBis, jahr)
      .then(d => {
        jahresvergleichCache = { key: cacheKey, daten: d };
        if (alive) setDaten(d);
      })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, tenantKey, rates, ratesLoading, heute, cacheKey, modus, loadVon, loadBis, customValid, jahr]);

  const spaltenLabel = daten?.modus === 'ytd'
    ? (jahr: number) => `YTD ${jahr}`
    : (jahr: number) => `${jahr}`;

  // PDF-Metadaten an die Seite melden (Zeitraum aus den geladenen Fensterdaten).
  useEffect(() => {
    const fmtFull = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
    const modusSlug = modus === 'ganzjahr' ? 'ganzjahr' : modus === 'custom' ? 'eigener' : 'ytd';
    let subtitle: string;
    let fileName: string;
    if (daten && customValid) {
      subtitle = daten.modus === 'ganzjahr' && daten.curYear === curYear
        ? `Aktuelles Jahr bis heute vs. ganzes Vorjahr · ${fmtFull(daten.curFrom)}–${fmtFull(daten.curTo)} vs. ${daten.vjYear}`
        : `${fmtFull(daten.curFrom)}–${fmtFull(daten.curTo)} vs. ${fmtFull(daten.vjFrom)}–${fmtFull(daten.vjTo)}`;
      fileName = `cockpit-jahresvergleich-${modusSlug}-${daten.curFrom}_${daten.curTo}`;
    } else {
      subtitle = modus === 'custom' ? `Eigener Zeitraum ${von}–${bis}` : `${jahr} vs. ${jahr - 1}`;
      fileName = `cockpit-jahresvergleich-${modusSlug}-${jahr}`;
    }
    const footnote = 'Jahresvergleich: «Bis heute (YTD)» = 01.01.–heute vs. 01.01.–gleiches Datum im Vorjahr · '
      + (jahr === curYear
        ? '«Ganzes Jahr» = aktuelles Jahr bis heute vs. ganzes Vorjahr · '
        : '«Ganzes Jahr» = vollständiges Basisjahr vs. vollständiges Vorjahr · ')
      + '«Eigener Zeitraum» = gewählter Bereich vs. gleicher MM-TT-Bereich im Vorjahr (29.02. → 28.02. geklemmt) · '
      + 'gleiche Quellen & Berechnung wie die Monatsübersicht (keine Z-Berichte) · +/- = aktuell vs. Vorjahr (nur wenn beide Werte vorhanden) · '
      + 'Vorjahr aus vj_daily; Produktive Stunden/Produktivität haben keine VJ-Quelle → «—» · leere Felder (—) = keine Datenquelle, nie 0.';
    onPdfMeta({ title: 'Jahresvergleich', subtitle, fileName, footnote });
  }, [onPdfMeta, daten, customValid, modus, von, bis, curYear, jahr]);

  const modusText = modus === 'ganzjahr' ? 'Ganzes Jahr' : modus === 'custom' ? 'Eigener Zeitraum' : 'Bis heute (YTD)';

  return (
    <>
      {/* Capture-only: Modus-/Zeitraum-Zusammenfassung anstelle der Controls */}
      <div className="pdf-only hidden items-center gap-2 text-sm font-semibold" data-testid="pdf-summary-jahr">
        Jahresvergleich · {modusText}
        {daten && customValid && (
          <span className="font-normal text-muted-foreground">
            {' '}· {daten.curYear}: {fmtDate(daten.curFrom)}–{fmtDate(daten.curTo)} · {daten.vjYear}: {fmtDate(daten.vjFrom)}–{fmtDate(daten.vjTo)}
          </span>
        )}
      </div>
      {/* Zeitraum-Wähler */}
      <div className="pdf-hide flex flex-wrap items-center gap-3">
        {/* Jahres-Navigation: ‹ Jahr › + Dropdown — Vergleich immer Jahr vs. Jahr−1 */}
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline" size="icon" className="h-8 w-8"
            onClick={() => wechsleJahr(jahr - 1)}
            disabled={jahr <= JAHR_MIN}
            data-testid="button-prev-jahr"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Select value={String(jahr)} onValueChange={(v) => wechsleJahr(Number(v))}>
            <SelectTrigger className="h-8 w-[92px] text-sm font-semibold" data-testid="select-jahr">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: curYear - JAHR_MIN + 1 }, (_, i) => curYear - i).map(j => (
                <SelectItem key={j} value={String(j)}>{j}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="icon" className="h-8 w-8"
            onClick={() => wechsleJahr(jahr + 1)}
            disabled={jahr >= curYear}
            data-testid="button-next-jahr"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground ml-1" data-testid="text-vergleich-jahre">
            vs. {jahr - 1}
          </span>
        </div>

        <ToggleGroup
          type="single"
          value={istLaufendesJahr ? modus : (modus === 'ytd' ? 'ganzjahr' : modus)}
          onValueChange={(v) => v && setModus(v as VergleichsModus)}
          className="justify-start"
          data-testid="toggle-vergleichsmodus"
        >
          {istLaufendesJahr && (
            <ToggleGroupItem value="ytd" data-testid="modus-ytd" className="text-xs">Bis heute (YTD)</ToggleGroupItem>
          )}
          <ToggleGroupItem value="ganzjahr" data-testid="modus-ganzjahr" className="text-xs">Ganzes Jahr</ToggleGroupItem>
          <ToggleGroupItem value="custom" data-testid="modus-custom" className="text-xs">Eigener Zeitraum</ToggleGroupItem>
        </ToggleGroup>

        {modus === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">von</span>
              <input
                type="date"
                value={von}
                min={jahrMin}
                max={jahrMax}
                onChange={(e) => setVon(e.target.value)}
                data-testid="input-von"
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">bis</span>
              <input
                type="date"
                value={bis}
                min={jahrMin}
                max={jahrMax}
                onChange={(e) => setBis(e.target.value)}
                data-testid="input-bis"
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
          </div>
        )}
      </div>

      {!customValid && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          data-testid="hinweis-zeitraum"
        >
          Bitte gültigen Zeitraum wählen: «von» darf nicht nach «bis» liegen.
        </div>
      )}

      {daten && customValid && (
        <div className="pdf-hide flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
          <span data-testid="jahresvergleich-kopf">
            {daten.modus === 'ganzjahr' && daten.curYear === curYear
              ? <>Aktuelles Jahr bis heute vs. ganzes Vorjahr · {daten.curYear}: {fmtDate(daten.curFrom)}–{fmtDate(daten.curTo)} · {daten.vjYear}: {fmtDate(daten.vjFrom)}–{fmtDate(daten.vjTo)}</>
              : <>{daten.curYear}: {fmtDate(daten.curFrom)}–{fmtDate(daten.curTo)} · {daten.vjYear}: {fmtDate(daten.vjFrom)}–{fmtDate(daten.vjTo)}</>}
          </span>
          <Button
            variant={showVj ? 'default' : 'outline'} size="sm" className="h-7"
            onClick={() => setShowVj(v => !v)}
            data-testid="button-toggle-vj-jahr"
          >
            Vorjahr {showVj ? 'ein' : 'aus'}
          </Button>
        </div>
      )}

      {fehler && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fehler beim Laden: {fehler}
        </div>
      )}

      {loading && customValid && <p className="text-sm text-muted-foreground py-8">Lade Daten …</p>}

      {!loading && daten && customValid && (
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" data-testid="table-jahresvergleich">
            <thead>
              <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
                <th className="px-3 py-2 text-right font-semibold">{spaltenLabel(daten.curYear)}</th>
                <th className="px-3 py-2 text-right font-semibold">Budget<span className="block normal-case font-normal">pro rata</span></th>
                <th className="px-3 py-2 text-right font-semibold">Δ<span className="block normal-case font-normal">vs. Budget</span></th>
                {showVj && <th className="px-3 py-2 text-right font-semibold">{spaltenLabel(daten.vjYear)}</th>}
                {showVj && <th className="px-3 py-2 text-right font-semibold">Δ %<span className="block normal-case font-normal">vs. VJ</span></th>}
              </tr>
            </thead>
            <tbody>
              {daten.rows.map((row, i) => {
                const delta = trendPct(row.cur, row.vj);
                const budget = row.budget ?? null;
                // Δ abs / Δ% gegen das Budget; Kosten-artige Zeilen (deltaInverted)
                // färben «über Budget» rot. %-Zeilen: Δ als Prozentpunkte.
                const devAbs = row.cur !== null && budget !== null ? row.cur - budget : null;
                const devPct = row.cur !== null && budget !== null && budget !== 0
                  ? ((row.cur - budget) / Math.abs(budget)) * 100 : null;
                const gut = (v: number) => (row.deltaInverted ? v <= 0 : v >= 0);
                return (
                  <tr key={i} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')}>
                    <td className="px-3 py-1.5">{row.label}</td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums',
                      row.tint === 'green' && 'text-emerald-600 dark:text-emerald-400',
                      row.tint === 'red' && 'text-red-600 dark:text-red-400')}>
                      {row.cur === null ? <span className="text-muted-foreground">—</span> : fmtCell(row.cur, row.fmt)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {budget === null ? <span className="text-muted-foreground">—</span> : fmtCell(budget, row.fmt)}
                    </td>
                    {/* EINE Δ-Spalte vs. Budget: abs (CHF bzw. PP bei Quoten)
                        gross, Prozent dezent darunter; Ampellogik unverändert. */}
                    <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs',
                      devAbs !== null && (gut(devAbs) ? 'text-emerald-600' : 'text-red-600'))}>
                      {devAbs === null ? ''
                        : row.fmt === 'pct'
                          ? `${devAbs >= 0 ? '+' : ''}${devAbs.toFixed(1)} PP`
                          : `${devAbs >= 0 ? '+' : '−'}${fmtCell(Math.abs(devAbs), row.fmt) ?? ''}`}
                      {devAbs !== null && row.fmt !== 'pct' && devPct !== null ? (
                        <span className="block text-[9px] font-normal text-muted-foreground">
                          {devPct >= 0 ? '+' : ''}{devPct.toFixed(1)} %
                        </span>
                      ) : null}
                    </td>
                    {showVj && (
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {row.vj === null ? <span className="text-muted-foreground">—</span> : fmtCell(row.vj, row.fmt)}
                      </td>
                    )}
                    {showVj && (
                      <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs',
                        delta !== null && (delta >= 0 ? 'text-emerald-600' : 'text-red-600'))}>
                        {delta === null ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %`}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="pdf-footnote text-xs text-muted-foreground">
        Jahresvergleich mit wählbarem Zeitraum: «Bis heute (YTD)» = 01.01.–heute vs. 01.01.–gleiches Datum
        im Vorjahr (pro rata) · «Ganzes Jahr» = aktuelles Jahr bis heute vs. ganzes Vorjahr (das laufende
        Jahr ist unvollständig) · «Eigener Zeitraum» = frei gewählter Bereich im aktuellen Jahr vs. gleicher
        MM-TT-Bereich im Vorjahr (29.02. → 28.02. geklemmt) · gleiche Quellen &amp; Berechnung wie die
        Monatsübersicht (keine Z-Berichte) · +/- = aktuell vs. Vorjahr (nur wenn beide Werte vorhanden) ·
        Vorjahr aus vj_daily; Produktive Stunden/Produktivität haben keine VJ-Quelle → «—» · leere Felder (—)
        = keine Datenquelle, nie 0. Ø-Verkauf pro Gast nur über Tage mit beiden Quellen.
      </p>
    </>
  );
}
