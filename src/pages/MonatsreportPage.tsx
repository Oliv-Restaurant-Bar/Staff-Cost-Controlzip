/**
 * Monatsreport — zentrales Meeting-Cockpit (Startseite)
 * Etappe 1: automatisch füllbare Zeilen + Excel-Export.
 * Spalten: Kennzahl | Budget | Vorjahr | Woche | +/- in % | Monat | +/- in %
 * Fehlende Quellen bleiben leer (nie 0). Bestehende Seiten bleiben erreichbar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileDown, CalendarDays, GitCompareArrows, Table2, ChartLine, ArrowUp, ArrowDown, ListOrdered, RotateCcw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
import { exportMonatsreportXlsx } from '@/lib/monatsreport-export';
import { exportCockpitPanelPDF, naechsterFrame } from '@/lib/cockpit-pdf-export';
import { useToast } from '@/hooks/use-toast';
import { useCockpitRowOrder } from '@/hooks/useCockpitRowOrder';

/** Metadaten fürs PDF (Titel/Zeitraum/Dateiname/Fussnote), von jedem Tab gemeldet. */
export interface CockpitPdfMeta {
  title: string;
  subtitle: string;
  fileName: string;
  footnote?: string;
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
    return pax !== null && pax !== undefined ? `${n} (${fmtNum(pax, 0)})` : n;
  }
  if (fmt === 'count' || fmt === 'hours') return fmtNum(v, 0);
  if (fmt === 'pct') return `${v.toFixed(1)} %`;
  return fmtNum(v);
}

function fmtDev(v: number | null): string {
  if (v === null) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
}

const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

/** Granularität der Report-Tabelle. */
type ReportGranularity = 'monat' | 'woche';

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
  editMode = false, onMove,
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
  /** Bearbeiten-Modus: Auf/Ab-Pfeile je Datenzeile. */
  editMode?: boolean;
  /** Verschiebt die Zeile `id` um `dir` (-1 hoch, +1 runter). */
  onMove?: (id: string, dir: -1 | 1) => void;
}) {
  const pick = (row: MrRow) => granularity === 'monat'
    ? { budget: row.monthBudget, vj: row.vjMonth, ist: row.month, devBudget: row.monthBudget,
        vjPax: row.vjMonthPax, istPax: row.monthPax }
    : { budget: row.budget, vj: row.vj, ist: row.week, devBudget: row.weekBudget,
        vjPax: null as number | null, istPax: row.weekPax };
  // Im Bearbeiten-Modus nur Datenzeilen (Trenner ausblenden → eindeutige Pfeile).
  const shown = editMode ? rows.filter(r => r.type === 'data') : rows;
  const dataCount = shown.filter(r => r.type === 'data').length;
  let dataIdx = -1;
  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
      <table className="w-full text-sm" data-testid={testid}>
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            {editMode ? <th className="px-2 py-2 w-16" /> : null}
            <th className="px-3 py-2 text-left font-semibold">Kennzahl</th>
            <th className="px-3 py-2 text-right font-semibold">
              Budget
              {budgetSub ? <span className="block normal-case font-normal">{budgetSub}</span> : null}
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              {vjHeader}
              {vjSub ? <span className="block normal-case font-normal">{vjSub}</span> : null}
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              {istHeader}
              {istSub ? <span className="block normal-case font-normal">{istSub}</span> : null}
            </th>
            <th className="px-3 py-2 text-right font-semibold">Δ %</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => {
            if (row.type === 'empty') {
              return <tr key={`e${i}`}><td colSpan={editMode ? 6 : 5} className="h-3 bg-muted/20" /></tr>;
            }
            dataIdx++;
            const isFirst = dataIdx === 0;
            const isLast = dataIdx === dataCount - 1;
            const p = pick(row);
            const dev = p.ist !== null && p.devBudget !== null && p.devBudget > 0
              ? ((p.ist - p.devBudget) / p.devBudget) * 100 : null;
            // Kosten-Zeilen (deltaInverted): über Budget = rot (Vorzeichen umgekehrt).
            const devClass = dev === null ? undefined
              : (row.deltaInverted ? dev <= 0 : dev >= 0) ? 'text-emerald-600' : 'text-red-600';
            // Schwellen-Rot (warnAbove, z.B. PKQ > 40 %) für den Ist-Wert.
            const warnClass = row.warnAbove != null && p.ist !== null && p.ist > row.warnAbove
              ? 'text-red-600 font-semibold' : undefined;
            return (
              <tr key={row.id ?? `d${i}`} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')} data-testid={`row-${row.id ?? i}`}>
                {editMode ? (
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost" size="icon" className="h-6 w-6"
                        disabled={isFirst || !row.id}
                        onClick={() => row.id && onMove?.(row.id, -1)}
                        data-testid={`button-move-up-${row.id}`}
                        aria-label="nach oben"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-6 w-6"
                        disabled={isLast || !row.id}
                        onClick={() => row.id && onMove?.(row.id, 1)}
                        data-testid={`button-move-down-${row.id}`}
                        aria-label="nach unten"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                ) : null}
                <td className="px-3 py-1.5">{row.label}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(p.budget, row.fmt)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtCell(p.vj, row.fmt, p.vjPax)}</td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', warnClass)}>{fmtCell(p.ist, row.fmt, p.istPax)}</td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs', devClass)}>{fmtDev(dev)}</td>
              </tr>
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
    () => orderedRows.filter(r => r.type === 'data' && r.id).map(r => r.id as string),
    [orderedRows],
  );
  // Zeile verschieben: Reihenfolge neu berechnen und persistieren.
  const moveRow = useCallback((id: string, dir: -1 | 1) => {
    const idx = currentIds.indexOf(id);
    if (idx < 0) return;
    const to = idx + dir;
    if (to < 0 || to >= currentIds.length) return;
    const next = [...currentIds];
    [next[idx], next[to]] = [next[to], next[idx]];
    saveOrder(next);
  }, [currentIds, saveOrder]);

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
  }, [year, month, tenantId, tenantKey, rates, ratesLoading, heute, weekSelection]);

  const prev = () => { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); };
  const next = () => { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); };

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
          + 'Δ% = Monat-Ist vs. Monatsbudget · Verhältnis-Kennzahlen (Durchschnittsverkauf, Take-Away-Anteil, Umsatz pro Gast, Produktivität) '
          + 'als Quote über den Monat, nicht summiert · Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen · '
          + 'Personalkosten = HOCHRECHNUNG des Monats (Budget = Zielquote × Umsatzbudget-Monat), Δ% gegen Monatsbudget · '
          + 'PKQ = Hochrechnung ÷ Hochrechnung, rot über Obergrenze 40 %; bei Personalkosten ist «über Budget» rot · '
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
          + 'Δ% = Woche-Ist vs. Budget-Woche · Verhältnis-Kennzahlen (Durchschnittsverkauf, Take-Away-Anteil, Umsatz pro Gast, '
          + 'Produktivität) als Quote über die Woche, nicht summiert · Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen · '
          + 'Personalkosten = FIX pro-rata der Wochentage + FLEX-Ist (Budget = Zielquote × Netto-Umsatz-Budget-Woche), Δ% gegen Budget-Woche · '
          + 'PKQ = Ist ÷ Ist, rot über Obergrenze 40 %; bei Personalkosten ist «über Budget» rot · '
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
              <RowOrderControls
                editMode={editRows}
                onToggle={() => setEditRows(v => !v)}
                onReset={() => { resetOrder(); }}
                disabled={!daten || loading}
              />
              <Button
                size="sm" className="gap-1.5 ml-2"
                disabled={!daten || loading}
                onClick={() => daten && exportMonatsreportXlsx(orderedRows, year, month, 'monat')}
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
                onMove={moveRow}
              />
            )}

            <p className="pdf-footnote text-xs text-muted-foreground">
              Budget = Monatsbudget · Vorjahr = gleicher Monat im Vorjahr (aus Tages-Vorjahresdaten) ·
              Ist (Monat) = Ist bis heute · Δ% = Monat-Ist vs. Monatsbudget · Verhältnis-Kennzahlen
              (Durchschnittsverkauf, Take-Away-Anteil, Umsatz pro Gast, Produktivität) werden als Quote
              über den Monat gebildet, nicht summiert · Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit
              beiden Quellen · Personalkosten = HOCHRECHNUNG des Monats (Budget = Zielquote ×
              Umsatzbudget-Monat), Δ% gegen Monatsbudget · PKQ = Hochrechnung ÷ Hochrechnung, rot über
              Obergrenze 40 %; bei Personalkosten ist «über Budget» rot (Kosten) · leere Felder = keine
              Datenquelle vorhanden (nie 0). Wochenwerte im Tab «Wochenübersicht», Jahreswerte im Tab
              «Jahresübersicht».
            </p>
          </TabsContent>

          {/* ── 3) Wochenübersicht — dieselbe Report-Tabelle, Granularität «woche» ── */}
          <TabsContent value="woche" className="space-y-4" ref={wochePanelRef}>
            {/* Capture-only: schlichte Zeitraum-Zeile anstelle der Controls (nur im PDF sichtbar) */}
            <div className="pdf-only hidden items-center gap-2 text-sm font-semibold" data-testid="pdf-summary-woche">
              {MONATE[month - 1]} {year}
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
              <Select value={weekValue} onValueChange={setWeekValue}>
                <SelectTrigger className="h-8 w-[210px] text-xs ml-2" data-testid="select-week">
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
              <RowOrderControls
                editMode={editRows}
                onToggle={() => setEditRows(v => !v)}
                onReset={() => { resetOrder(); }}
                disabled={!daten || loading}
              />
              <Button
                size="sm" className="gap-1.5 ml-2"
                disabled={!daten || loading}
                onClick={() => daten && exportMonatsreportXlsx(orderedRows, year, month, 'woche')}
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
            {!loading && daten && (
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
                onMove={moveRow}
              />
            )}

            <p className="pdf-footnote text-xs text-muted-foreground">
              Woche = gewählter Zeitraum ({daten?.weekLabel ?? '—'}
              {wocheRange ? `, ${wocheRange}` : ''}), auf den Monat geklemmt · Budget =
              Budget-Wochenanteil dieses Zeitraums · Vorjahr = gleiche Kalenderwoche im Vorjahr
              (gleiche ISO-KW, aus Tages-Vorjahresdaten) · Ist = Woche · Δ% = Woche-Ist vs. Budget-Woche ·
              Verhältnis-Kennzahlen (Durchschnittsverkauf, Take-Away-Anteil, Umsatz pro Gast,
              Produktivität) werden als Quote über die Woche gebildet, nicht summiert · Umsatz pro Gast =
              Netto ÷ Gäste nur über Tage mit beiden Quellen · Personalkosten = FIX pro-rata der Wochentage
              + FLEX-Ist (Budget = Zielquote × Netto-Umsatz-Budget-Woche), Δ% gegen Budget-Woche · PKQ =
              Ist ÷ Ist, rot über Obergrenze 40 %; bei Personalkosten ist «über Budget» rot (Kosten) ·
              leere Felder = keine Datenquelle vorhanden (nie 0). Monatswerte im Tab «Monatsübersicht».
            </p>
          </TabsContent>

          {/* ── 4) Wochenverlauf (unverändert) ── */}
          <TabsContent value="verlauf" className="space-y-4" ref={verlaufPanelRef}>
            <WochenverlaufView onPdfMeta={setVerlaufMeta} />
          </TabsContent>
        </Tabs>
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

  // Jahr-Optionen: aktuelles Jahr … 2024.
  const jahrOptions = useMemo(() => {
    const cur = heute.getFullYear();
    const out: number[] = [];
    for (let y = cur; y >= 2024; y--) out.push(y);
    return out;
  }, [heute]);
  const istAktuellesJahr = jahr === heute.getFullYear();

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
      footnote: 'Wochenverlauf = abgeschlossene ISO-Kalenderwochen (Mo–So, älteste links) · Trend ▲/▼ = Veränderung zur Vorwoche · '
        + 'Verlauf = Mini-Trend über alle Wochen · gleiche Quellen & Berechnung wie die Monatsübersicht · '
        + 'leere Felder (—) = keine Datenquelle, nie 0 · Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen'
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
                  return (
                    <th key={`${w.kwYear}-${w.kw}`} className="px-3 py-2 text-right font-semibold">
                      KW {w.kw}
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
              {daten.rows.map((row, ri) => (
                <tr key={ri} className={cn('border-b last:border-0 hover:bg-muted/30 align-top', row.bold && 'font-semibold')}>
                  <td className="px-3 py-1.5">{row.label}</td>
                  {row.values.map((v, ci) => {
                    const prev = ci > 0 ? row.values[ci - 1] : null;
                    const t = ci > 0 ? trendPct(v, prev) : null;
                    const vjV = showVj ? (row.vjValues?.[ci] ?? null) : null;
                    const vjDelta = showVj ? trendPct(v, vjV) : null;
                    return (
                      <td key={ci} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                        <span className="block">
                          {v === null ? <span className="text-muted-foreground">—</span> : fmtCell(v, row.fmt)}
                          {t !== null && (
                            <span className={cn('ml-1.5 text-[10px] font-normal',
                              t >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                              {t >= 0 ? '▲' : '▼'}{Math.abs(t).toFixed(0)}%
                            </span>
                          )}
                        </span>
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
                    <Sparkline values={row.values} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {effektiveAnsicht === 'table' && (
        <p className="pdf-footnote text-xs text-muted-foreground">
          Wochenverlauf {jahr} = {istAktuellesJahr
            ? `letzte ${anzahl} abgeschlossene ISO-Kalenderwochen`
            : `dieselben ${anzahl} KW-Nummern wie aktuell, aber im Jahr ${jahr}`} (Mo–So, älteste links) ·
          Trend ▲/▼ = Veränderung zur Vorwoche · Verlauf = Mini-Trend über alle Wochen ·
          gleiche Quellen &amp; Berechnung wie die Monatsübersicht · leere Felder (—) = keine Datenquelle,
          nie 0. Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen.
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
  'Brutto Umsatz', 'Netto Umsatz', 'Gäste IN', 'Durchschnittsverkauf',
  'Take Away Anteil', 'Food', 'Beverage', 'Umsatz pro Gast',
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
function MiniChart({ row, weeks }: { row: WochenverlaufRow; weeks: WochenverlaufDaten['weeks'] }) {
  const data = weeks.map((w, i) => ({
    kw: `KW ${w.kw}`,
    cur: row.values[i],
    vj: row.vjValues?.[i] ?? null,
  }));
  // Δ% letzte Woche vs. gleiche VJ-Woche (nur wenn beide Werte vorhanden).
  const lastCur = row.values[row.values.length - 1] ?? null;
  const lastVj = row.vjValues?.[row.vjValues.length - 1] ?? null;
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
        {charts.map(row => <MiniChart key={row.label} row={row} weeks={daten.weeks} />)}
      </div>

      <p className="text-xs text-muted-foreground">
        Produktive Stunden/Produktivität: keine Vorjahresdaten · Δ% = letzte Woche vs. gleiche KW im Vorjahr ·
        Lücken = keine Datenquelle (nie 0).
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

  const [modus, setModus] = useState<VergleichsModus>('ytd');
  // Eigener Zeitraum: Default 01.01. → heute; auf aktuelles Jahr begrenzt.
  const [von, setVon] = useState(`${curYear}-01-01`);
  const [bis, setBis] = useState(heuteIso);

  const jahrMin = `${curYear}-01-01`;
  const jahrMax = `${curYear}-12-31`;
  // Validierung nur im custom-Modus: von ≤ bis. Sonst kein Load, Hinweis anzeigen.
  const customValid = modus !== 'custom' || (!!von && !!bis && von <= bis);

  // Ladeparameter für den aktiven Modus (custom nur bei gültigem Bereich).
  const loadVon = modus === 'custom' ? von : undefined;
  const loadBis = modus === 'custom' ? bis : undefined;

  const cacheKey = `${tenantId}:${heuteIso}:${modus}:${modus === 'custom' ? `${von}_${bis}` : '-'}`;
  const cached = jahresvergleichCache?.key === cacheKey ? jahresvergleichCache!.daten : null;
  const [daten, setDaten] = useState<JahresvergleichDaten | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [fehler, setFehler] = useState<string | null>(null);

  // Lazy: erst beim Öffnen des Tabs (Mount) laden; Reload bei Modus-/Zeitraumwechsel.
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
    ladeJahresvergleich(tenantId, tenantKey, rates, heute, modus, loadVon, loadBis)
      .then(d => {
        jahresvergleichCache = { key: cacheKey, daten: d };
        if (alive) setDaten(d);
      })
      .catch(e => { if (alive) { setDaten(null); setFehler(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, tenantKey, rates, ratesLoading, heute, cacheKey, modus, loadVon, loadBis, customValid]);

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
      subtitle = daten.modus === 'ganzjahr'
        ? `Aktuelles Jahr bis heute vs. ganzes Vorjahr · ${fmtFull(daten.curFrom)}–${fmtFull(daten.curTo)} vs. ${daten.vjYear}`
        : `${fmtFull(daten.curFrom)}–${fmtFull(daten.curTo)} vs. ${fmtFull(daten.vjFrom)}–${fmtFull(daten.vjTo)}`;
      fileName = `cockpit-jahresvergleich-${modusSlug}-${daten.curFrom}_${daten.curTo}`;
    } else {
      subtitle = modus === 'custom' ? `Eigener Zeitraum ${von}–${bis}` : `${curYear} vs. ${curYear - 1}`;
      fileName = `cockpit-jahresvergleich-${modusSlug}-${curYear}`;
    }
    const footnote = 'Jahresvergleich: «Bis heute (YTD)» = 01.01.–heute vs. 01.01.–gleiches Datum im Vorjahr · '
      + '«Ganzes Jahr» = aktuelles Jahr bis heute vs. ganzes Vorjahr · «Eigener Zeitraum» = gewählter Bereich vs. gleicher MM-TT-Bereich im Vorjahr (29.02. → 28.02. geklemmt) · '
      + 'gleiche Quellen & Berechnung wie die Monatsübersicht (keine Z-Berichte) · +/- = aktuell vs. Vorjahr (nur wenn beide Werte vorhanden) · '
      + 'Vorjahr aus vj_daily; Produktive Stunden/Produktivität haben keine VJ-Quelle → «—» · leere Felder (—) = keine Datenquelle, nie 0.';
    onPdfMeta({ title: 'Jahresvergleich', subtitle, fileName, footnote });
  }, [onPdfMeta, daten, customValid, modus, von, bis, curYear]);

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
        <ToggleGroup
          type="single"
          value={modus}
          onValueChange={(v) => v && setModus(v as VergleichsModus)}
          className="justify-start"
          data-testid="toggle-vergleichsmodus"
        >
          <ToggleGroupItem value="ytd" data-testid="modus-ytd" className="text-xs">Bis heute (YTD)</ToggleGroupItem>
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
            {daten.modus === 'ganzjahr'
              ? <>Aktuelles Jahr bis heute vs. ganzes Vorjahr · {daten.curYear}: {fmtDate(daten.curFrom)}–{fmtDate(daten.curTo)} · {daten.vjYear}: {fmtDate(daten.vjFrom)}–{fmtDate(daten.vjTo)}</>
              : <>{daten.curYear}: {fmtDate(daten.curFrom)}–{fmtDate(daten.curTo)} · {daten.vjYear}: {fmtDate(daten.vjFrom)}–{fmtDate(daten.vjTo)}</>}
          </span>
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
                <th className="px-3 py-2 text-right font-semibold">{spaltenLabel(daten.vjYear)}</th>
                <th className="px-3 py-2 text-right font-semibold">Δ %</th>
              </tr>
            </thead>
            <tbody>
              {daten.rows.map((row, i) => {
                const delta = trendPct(row.cur, row.vj);
                return (
                  <tr key={i} className={cn('border-b last:border-0 hover:bg-muted/30', row.bold && 'font-semibold')}>
                    <td className="px-3 py-1.5">{row.label}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.cur === null ? <span className="text-muted-foreground">—</span> : fmtCell(row.cur, row.fmt)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {row.vj === null ? <span className="text-muted-foreground">—</span> : fmtCell(row.vj, row.fmt)}
                    </td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums text-xs',
                      delta !== null && (delta >= 0 ? 'text-emerald-600' : 'text-red-600'))}>
                      {delta === null ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %`}
                    </td>
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
        = keine Datenquelle, nie 0. Umsatz pro Gast = Netto ÷ Gäste nur über Tage mit beiden Quellen.
      </p>
    </>
  );
}
