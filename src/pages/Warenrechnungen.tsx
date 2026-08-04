/**
 * Warenrechnungen – Modul zur Erfassung und Kontrolle von Lieferantenrechnungen
 * ==============================================================================
 * Tab A: Erfassung  → KPI-Boxen + Schnellerfassung + letzte Einträge
 * Tab B: Analyse    → Lieferanten-Übersicht + kumulierter Verlauf
 * Mandantenfähig (Oliv / Beaulieu) via TenantContext.
 *
 * Debug-Logs: [WAREN]
 */

import { Fragment, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import {
  loadSuppliers,
  saveSuppliers,
  loadMonthInvoices,
  saveInvoiceEntry,
  deleteInvoiceEntry,
  uploadInvoiceReceipt,
  getInvoiceReceiptUrl,
  deleteInvoiceReceipt,
  loadDailyRevenueFromLocalStorage,
  loadWarenMonthlyRevenue,
  seedMonthlyRevenueIfMissing,
  computeDailyBudgetRevenue,
  computeMonthStats,
  calcAmounts,
  WARENKONTO_LIST,
  kategorieFromKonto,
  kontoKategorie,
  loadWarenkonten,
  saveWarenkonten,
  loadWarenkostenGrenze,
  saveWarenkostenGrenze,
  loadRecentSupplierNames,
  rememberRecentSupplier,
  loadSupplierAliases,
  saveSupplierAlias,
  loadAliasGruppen,
  saveAliasGruppen,
  loadFibuMatchState,
  saveFibuMatchState,
  loadFibuMatchToleranz,
  saveFibuMatchToleranz,
  type Supplier,
  type InvoiceEntry,
  type KontoSplit,
  type WarenKategorie,
  type Warenkonto,
} from '@/lib/waren-db';
import { WarenAnalyseBlock } from '@/components/waren/WarenAnalyse';
import { WarenCsvImport, WarengruppenKontenEditor, MarktLieferantenEditor } from '@/components/waren/WarenCsvImport';
import { FeldschloesschenImport } from '@/components/waren/FeldschloesschenImport';
import { BeaulieuPdfImport, LieferantenProfilEditor } from '@/components/waren/BeaulieuPdfImport';
import { loadPreisHinweise, loadRechnungsPositionen, saveRechnungsPositionen } from '@/lib/waren-db';
import { kontoSplitsAusPositionen, KONTO_LABEL_PFAND, KONTO_LABEL_OFFEN, type PreisAenderung, type GespeichertePosition, type PositionenProRechnung } from '@/lib/waren-positionen';
import { buildKontoAbgleich } from '@/lib/waren-abgleich';
import {
  kontoKlasse, kontoKlasseLabel, sumBetriebNet, nurWarenAnteil,
  aggregateBySupplierKlassen, DEFAULT_WARENKOSTEN_GRENZE,
} from '@/lib/waren-klassen';
import { loadZielWarenquote, DEFAULT_ZIEL_WARENQUOTE_PCT } from '@/lib/ziel-warenquote';
import {
  computeWarenkostenTotals,
  warenkostenQuote,
  buildErVergleich,
  erVergleichStatusLabel,
  type ErVergleichStatus,
} from '@/lib/warenkosten-quote';
import { exportWarenkostenToExcel } from '@/lib/warenkosten-export';
import { loadMonth, STORAGE_KEY as REPORTING_STORAGE_KEY, loadJournalEntriesFromDB } from '@/lib/reporting-store';
import {
  parseInvoiceText, extractPdfInvoiceText, findSupplierInText, matchSupplier,
  normalizeSupplierKey, type ErkannteRechnung,
} from '@/lib/waren-pdf-erkennung';
import { buildWarenAbgleich, findeDublette, journalVerfuegbarFuerTenant, type WarenAbgleich } from '@/lib/waren-abgleich';
import { buildAliasResolver, applyAliasGruppen, type AliasGruppe } from '@/lib/waren-alias-gruppen';
import {
  buchungKeysMitIndex, buchungBetrag, fmtDatumCH, matchAmpel, lieferantMatchStat,
  autoMatchVorschlaege, LEERER_MATCH_STATE, DEFAULT_FIBU_MATCH_TOLERANZ,
  type FibuMatchGruppe, type FibuMatchState,
} from '@/lib/waren-fibu-matches';
import type { SageJournalEntry } from '@/types/reporting';
import { computePLForMonth } from '@/lib/pl-engine';
import { HintBox } from '@/components/ui/hint-box';
import { StatusPill } from '@/components/ui/status-pill';
import { InfoTip } from '@/components/ui/info-tip';
import { Link } from 'react-router-dom';
import { TONE_TEXT, type Tone } from '@/components/ui/tones';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  ShoppingCart, Plus, Minus, Pencil, Trash2, Settings2, ChevronLeft, ChevronRight,
  TrendingUp, AlertCircle, CheckCircle2, Package, BarChart3, ClipboardList, ShieldCheck,
  Filter, X, Receipt, Download, Paperclip, ChevronsUpDown, Check, ChevronDown,
  ScanSearch, Loader2, Scale, ChevronRight as ChevronRightSmall, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Dot, Cell,
} from 'recharts';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface EntryForm {
  date: string;
  supplierName: string;
  amount: string;
  vatIncluded: boolean;
  vatRate: string;
  reference: string;
  note: string;
  warenkonto: string;
  splitEnabled: boolean;
  /** Kontoaufteilung: beliebig viele Zeilen (Konto + Betrag); Summe = Rechnungsbetrag. */
  splits: { konto: string; amount: string }[];
  kategorie: WarenKategorie;
}

const WARE_KATEGORIEN: WarenKategorie[] = ['Food', 'Beverage', 'Sonstiges'];

const EMPTY_FORM: EntryForm = {
  date: ymdLocal(new Date()),
  supplierName: '',
  amount: '',
  vatIncluded: true,
  vatRate: '2.6',
  reference: '',
  note: '',
  warenkonto: '',
  splitEnabled: false,
  splits: [{ konto: '', amount: '' }, { konto: '', amount: '' }],
  kategorie: 'Sonstiges',
};

const VAT_RATES = ['8.1', '2.6', '3.8', '0'];

const MONTHS     = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const MONTHS_LONG = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

type Tab         = 'erfassung' | 'analyse' | 'abgleich';

/** Status der PDF-Erkennung für die Bestätigungs-Vorschau im Formular. */
interface PdfErkennungState {
  fileName: string;
  /** Erkannte Lieferanten-Schreibweise aus dem PDF (für Alias-Lernen). */
  supplierRaw: string | null;
  /** Auto-Match gefunden? (sonst manuell zuordnen → Alias wird gespeichert) */
  supplierMatched: boolean;
  felder: ErkannteRechnung;
  /** false = per OCR gelesen (Scan) → Felder generell mit Vorsicht. */
  textLayer: boolean;
  ocrFehler?: string;
}
type AnalyseMode = 'week' | 'month' | 'multi_month' | 'year' | 'ytd';

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmtChf(val: number): string {
  return val.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(val: number): string {
  return val.toFixed(1) + ' %';
}
/**
 * Relevante Warenkosten (Food + Beverage) einer Eintragsliste – Basis JEDER
 * Warenkostenquote. Sonstiges ist bewusst AUSGESCHLOSSEN. Zusätzlich zählt
 * seit der Kontoklassen-Trennung NUR der Anteil auf Warenkosten-Konten
 * (4000–Grenze): Betriebskosten-Anteile (> Grenze) fliessen NIE in die WKQ.
 * Single Source of Truth: `nurWarenAnteil` + `computeWarenkostenTotals`.
 */
function relevantNetOf(list: InvoiceEntry[], grenze: number): number {
  return computeWarenkostenTotals(nurWarenAnteil(list, grenze), grenze).relevantNet;
}
function generateId(): string {
  return `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
/**
 * Lokales yyyy-MM-dd (NIE toISOString: das serialisiert in UTC und kippt an
 * Monats-/Wochengrenzen je nach Zeitzone um einen Tag).
 */
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getDaysInMonth(year: number, month: number): string[] {
  const days: string[] = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    days.push(ymdLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}
function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}
function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

// ISO-Kalenderwoche (Mo–So) + Wochenjahr
function getIsoWeek(dateStr: string): { week: number; isoYear: number; weekLabel: string } {
  const d = new Date(dateStr + 'T12:00:00');
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const jan4 = new Date(tmp.getFullYear(), 0, 4);
  const week = 1 + Math.round(((tmp.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { week, isoYear: tmp.getFullYear(), weekLabel: `KW ${String(week).padStart(2, '0')}` };
}

// Montag und Sonntag einer ISO-Woche als Datumsstring
function isoWeekRange(isoYear: number, week: number): { from: string; to: string } {
  const jan4 = new Date(isoYear, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7; // 0 = Mon
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: ymdLocal(monday), to: ymdLocal(sunday) };
}

// ─── KPI-Box ──────────────────────────────────────────────────────────────────

const KpiBox = ({
  label, value, sub, sub2, icon: Icon, variant = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  sub2?: string;
  icon?: React.FC<{ className?: string }>;
  variant?: 'default' | 'warn' | 'alert' | 'ok' | 'muted';
}) => {
  const bg: Record<string, string> = {
    default: 'bg-card border-border',
    warn:    'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800',
    alert:   'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800',
    ok:      'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800',
    muted:   'bg-muted/30 border-border',
  };
  const vc: Record<string, string> = {
    default: 'text-foreground',
    warn:    'text-amber-700 dark:text-amber-400',
    alert:   'text-red-700 dark:text-red-400',
    ok:      'text-emerald-700 dark:text-emerald-400',
    muted:   'text-muted-foreground',
  };
  const dot: Record<string, string> = {
    default: 'bg-blue-400',
    warn:    'bg-amber-400',
    alert:   'bg-red-500',
    ok:      'bg-emerald-500',
    muted:   'bg-muted-foreground/30',
  };
  // Betrag skaliert mit der Kachelbreite (Container-Query-Einheiten) UND der
  // Zeichenlänge: tabellarische Ziffern sind ~0.6em breit, also passt eine
  // Zeile der Länge n bei ≤ (100cqw − Padding) / (0.6·n). clamp() hält die
  // Grösse zwischen 0.8rem und 1.5rem (= text-2xl) — nie Overflow, auch bei
  // 7-stelligen Beträgen oder schmalen Spalten. overflow-hidden als Sicherheitsnetz.
  const fontSize = `clamp(0.8rem, calc((100cqw - 2rem) / ${Math.max(6, value.length) * 0.62}), 1.5rem)`;
  return (
    <div className={cn('rounded-xl border p-4 flex flex-col gap-1 min-h-[96px] min-w-0 overflow-hidden [container-type:inline-size]', bg[variant])}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dot[variant])} />
        {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
        <p className="text-xs text-muted-foreground font-medium leading-tight truncate">{label}</p>
      </div>
      <p className={cn('font-bold tabular-nums leading-none mt-0.5 whitespace-nowrap', vc[variant])} style={{ fontSize }}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground leading-tight truncate" title={sub}>{sub}</p>}
      {sub2 && <p className="text-[11px] text-muted-foreground/60 leading-tight truncate" title={sub2}>{sub2}</p>}
    </div>
  );
};

// ─── Pct-Badge ────────────────────────────────────────────────────────────────

function PctBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-muted-foreground/40">–</span>;
  const cls = pct > 35
    ? 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400'
    : pct > 30
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400';
  return (
    <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-mono font-semibold tabular-nums', cls)}>
      {fmtPct(pct)}
    </span>
  );
}

/** ER-Abgleich-Status → Design-System-Ton (Ampel). */
const ER_STATUS_TONE: Record<ErVergleichStatus, Tone> = {
  ok: 'good',
  warn: 'warn',
  critical: 'critical',
  none: 'neutral',
};

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function WarenrechnungenPage() {
  const { tenantId, tenant, tenantKey } = useTenant();
  const { role, warenrechnungenPerms } = usePermissions();
  const { canView, canCreate, canEdit, canDelete, canExport } = warenrechnungenPerms;

  // ─── Permissions Debug-Logs ──────────────────────────────────────────────
  useEffect(() => {
    console.log(`[PERMISSIONS] role: ${role}`);
    console.log(`[PERMISSIONS] module: warenrechnungen`);
    console.log(`[PERMISSIONS] view: ${canView}`);
    console.log(`[PERMISSIONS] create: ${canCreate}`);
    console.log(`[PERMISSIONS] edit: ${canEdit}`);
    console.log(`[PERMISSIONS] delete: ${canDelete}`);
    console.log(`[PERMISSIONS] export: ${canExport}`);
  }, [role, canView, canCreate, canEdit, canDelete, canExport]);

  const today = new Date();
  const todayStr = ymdLocal(today);

  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  const [suppliers,      setSuppliers]      = useState<Supplier[]>([]);
  const [entries,        setEntries]        = useState<InvoiceEntry[]>([]);
  const [revenueByDate,  setRevenueByDate]  = useState<Record<string, number>>({});
  const [loading,        setLoading]        = useState(true);
  const [tab,            setTab]            = useState<Tab>('erfassung');

  const [form,              setForm]              = useState<EntryForm>(EMPTY_FORM);
  const [receiptFile,       setReceiptFile]       = useState<File | null>(null);
  const [receiptInputKey,   setReceiptInputKey]   = useState(0);
  const [editReceiptFile,   setEditReceiptFile]   = useState<File | null>(null);
  const [saving,            setSaving]            = useState(false);
  const [editEntry,         setEditEntry]         = useState<InvoiceEntry | null>(null);
  const [showEditDialog,    setShowEditDialog]    = useState(false);
  const [showSupplierDialog,setShowSupplierDialog]= useState(false);
  const [newSupplierName,   setNewSupplierName]   = useState('');
  const [deleteConfirm,     setDeleteConfirm]     = useState<string | null>(null);
  const [targetPct,         setTargetPct]         = useState<number>(30);

  // ─── Schnellerfassung: Warenkonten, zuletzt genutzte Lieferanten, Details ──
  const [warenkonten,       setWarenkonten]       = useState<Warenkonto[]>(WARENKONTO_LIST);
  const [recentSuppliers,   setRecentSuppliers]   = useState<string[]>([]);
  const [showDetails,       setShowDetails]       = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [zielWkqPct,        setZielWkqPct]        = useState<number>(DEFAULT_ZIEL_WARENQUOTE_PCT);
  const amountInputRef = useRef<HTMLInputElement>(null);
  // Warenkonten-Verwaltung (im Lieferantenstamm-Dialog)
  const [newKontoValue,     setNewKontoValue]     = useState('');
  const [newKontoLabel,     setNewKontoLabel]     = useState('');
  // Kontoklassen-Grenze: 4000–warenGrenze = Warenkosten (WKQ), darüber = Betriebskosten.
  const [warenGrenze,       setWarenGrenze]       = useState<number>(DEFAULT_WARENKOSTEN_GRENZE);
  const [grenzeInput,       setGrenzeInput]       = useState<string>(String(DEFAULT_WARENKOSTEN_GRENZE));

  useEffect(() => {
    setRecentSuppliers(loadRecentSupplierNames(tenantId));
    loadWarenkonten(tenantId).then(setWarenkonten).catch(() => setWarenkonten(WARENKONTO_LIST));
    loadZielWarenquote(tenantId).then(b => setZielWkqPct(b.pct)).catch(() => {});
    loadSupplierAliases(tenantId).then(setAliases).catch(() => setAliases({}));
    loadAliasGruppen(tenantId).then(setAliasGruppen).catch(() => setAliasGruppen([]));
    loadWarenkostenGrenze(tenantId)
      .then(g => { setWarenGrenze(g); setGrenzeInput(String(g)); })
      .catch(() => { setWarenGrenze(DEFAULT_WARENKOSTEN_GRENZE); setGrenzeInput(String(DEFAULT_WARENKOSTEN_GRENZE)); });
  }, [tenantId]);

  // ─── PDF-Erkennung (Erfassung) ────────────────────────────────────────────
  const [aliases,        setAliases]        = useState<Record<string, string>>({});
  const [pdfQueue,       setPdfQueue]       = useState<File[]>([]);
  const [pdfBusy,        setPdfBusy]        = useState(false);
  const [erkennung,      setErkennung]      = useState<PdfErkennungState | null>(null);
  // Alias-Lernen nur mit EXPLIZITER Zustimmung: die erkannte Schreibweise kann
  // auch eine Adress-/Kopfzeile sein — nie automatisch dauerhaft zuordnen.
  const [aliasLernen,    setAliasLernen]    = useState(false);

  // ─── Lieferanten-Alias-Gruppen (mandantengetrennt, reine Anzeige-Gruppierung) ──
  const [aliasGruppen,   setAliasGruppen]   = useState<AliasGruppe[]>([]);
  const aliasResolver = useMemo(() => buildAliasResolver(aliasGruppen), [aliasGruppen]);

  // ─── FIBU-Matches auto/manuell (Rechnungen ↔ Buchungen, pro Mandant+Monat) ─
  const [fibuState, setFibuState] = useState<FibuMatchState>(LEERER_MATCH_STATE);
  const [fibuGeladen, setFibuGeladen] = useState(false); // Auto-Match erst NACH dem Load
  const [fibuToleranz, setFibuToleranz] = useState<number>(DEFAULT_FIBU_MATCH_TOLERANZ);
  const fibuMonthKey = `${year}-${String(month).padStart(2, '0')}`;
  useEffect(() => {
    if (tab !== 'abgleich') return;
    let alive = true;
    setFibuState(LEERER_MATCH_STATE);
    setFibuGeladen(false);
    Promise.all([
      loadFibuMatchState(tenantId, fibuMonthKey),
      loadFibuMatchToleranz(tenantId),
    ]).then(([st, tol]) => {
      if (!alive) return;
      setFibuState(st); setFibuToleranz(tol); setFibuGeladen(true);
    }).catch(() => { if (alive) setFibuGeladen(true); });
    return () => { alive = false; };
  }, [tab, tenantId, fibuMonthKey]);
  // Saves sind SERIALISIERT und arbeiten funktional auf dem jeweils
  // aktuellsten Stand (Ref) — schnelle Folge-Mutationen können sich so nicht
  // gegenseitig überschreiben; Rollback betrifft nur die fehlgeschlagene
  // Mutation. Rückgabe: true = persistiert (erst dann Erfolgs-UI).
  const fibuStateRef = useRef<FibuMatchState>(LEERER_MATCH_STATE);
  useEffect(() => { fibuStateRef.current = fibuState; }, [fibuState]);
  const fibuSaveChain = useRef<Promise<unknown>>(Promise.resolve());
  const persistFibuState = useCallback(
    (mutate: (cur: FibuMatchState) => FibuMatchState): Promise<boolean> => {
      const run = fibuSaveChain.current.then(async (): Promise<boolean> => {
        const prev = fibuStateRef.current;
        const next = mutate(prev);
        if (next === prev) return true; // No-op (z.B. Auto-Lauf ohne Treffer) — kein Save
        fibuStateRef.current = next;
        setFibuState(next); // optimistisch — bei Fehler nur diese Mutation zurückrollen
        try {
          await saveFibuMatchState(tenantId, fibuMonthKey, next);
          return true;
        } catch (e) {
          fibuStateRef.current = prev;
          setFibuState(prev);
          toast.error(`Match speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      });
      fibuSaveChain.current = run.catch(() => undefined);
      return run;
    }, [tenantId, fibuMonthKey]);
  const speichereToleranz = useCallback(async (tol: number) => {
    setFibuToleranz(tol);
    try { await saveFibuMatchToleranz(tenantId, tol); }
    catch (e) { toast.error(`Toleranz speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`); }
  }, [tenantId]);

  // ─── FIBU-Abgleich pro Lieferant ──────────────────────────────────────────
  const [journal,        setJournal]        = useState<SageJournalEntry[] | null>(null);
  const [abgleichOffen,  setAbgleichOffen]  = useState<string | null>(null); // Drilldown
  useEffect(() => {
    if (tab !== 'abgleich') return;
    let alive = true;
    setJournal(null);
    // MANDANTEN-SCHUTZ: Journal-Keys sind mandantenfähig (Oliv historisch ohne
    // Präfix, Beaulieu mit `beaulieu:`-Präfix) — für unbekannte Mandanten
    // NIE laden (sonst fremde Buchungen), dort degradierter Modus.
    if (!journalVerfuegbarFuerTenant(tenantId)) { setJournal([]); return; }
    loadJournalEntriesFromDB(year, month, tenantId)
      .then(e => { if (alive) setJournal(e); })
      .catch(() => { if (alive) setJournal([]); });
    return () => { alive = false; };
  }, [tab, year, month, tenantId]);

  /** Abgleich-Modell (degradiert automatisch, wenn keine Buchungszeilen da sind). */
  const abgleich: WarenAbgleich | null = useMemo(() => {
    if (tab !== 'abgleich' || journal === null) return null; // lädt noch
    // ER-/Kontoblatt-Total (total_cogs) für den degradierten Modus — gleiche
    // Quelle wie der bestehende FIBU-Abgleich (computePLForMonth).
    let buchhaltungTotal: number | null = null;
    try {
      const record = loadMonth(year, month, tenantKey(REPORTING_STORAGE_KEY));
      const pl = computePLForMonth(record);
      const row = pl.rows.find(r => r.def.id === 'total_cogs');
      buchhaltungTotal = row && row.values.actual !== null ? Math.abs(row.values.actual) : null;
    } catch { buchhaltungTotal = null; }
    return buildWarenAbgleich({
      invoices: entries,
      journal,
      warenkontoNummern: warenkonten.map(k => k.value),
      supplierNames: suppliers.map(s => s.name),
      aliases,
      buchhaltungTotal,
      aliasGruppen,
    });
  }, [tab, journal, entries, warenkonten, suppliers, aliases, aliasGruppen, year, month, tenantKey]);

  /** Abgleich PRO KONTO (ergänzend — Totale/WKQ unverändert). */
  const kontoAbgleich = useMemo(() => {
    if (tab !== 'abgleich') return [];
    const kontoNamen = Object.fromEntries(warenkonten.map(k => [k.value, k.label]));
    return buildKontoAbgleich({ invoices: entries, journal, kontoNamen, relevanteKonten: warenkonten.map(k => k.value) });
  }, [tab, entries, journal, warenkonten]);

  // ─── Analyse: Zeitraum-Steuerung ──────────────────────────────────────────
  const [analyseMode, setAnalyseMode] = useState<AnalyseMode>('month');
  const [aYear,       setAYear]       = useState(today.getFullYear());
  const [aMonth,      setAMonth]      = useState(today.getMonth() + 1);
  const [aWeekNum,    setAWeekNum]    = useState(() => getIsoWeek(ymdLocal(new Date())).week);
  const [aFromYear,   setAFromYear]   = useState(today.getFullYear());
  const [aFromMonth,  setAFromMonth]  = useState(() => { const m = today.getMonth(); return m < 1 ? 12 : m; });
  const [aToYear,     setAToYear]     = useState(today.getFullYear());
  const [aToMonth,    setAToMonth]    = useState(today.getMonth() + 1);
  const [aRangeYear,  setARangeYear]  = useState(today.getFullYear());
  const [rangeEntries, setRangeEntries] = useState<InvoiceEntry[]>([]);
  const [rangeRevenue, setRangeRevenue] = useState<Record<string, number>>({});
  const [monthlyRevBudget, setMonthlyRevBudget] = useState<Record<string, number>>({}); // YYYY-MM → CHF
  const [rangeLoading, setRangeLoading] = useState(false);

  // ─── Erfassung: Lieferanten-Filter ────────────────────────────────────────
  const [erfassungSupplierFilter, setErfassungSupplierFilter] = useState<string>(''); // '' = alle

  // ─── Analyse: Lieferanten-Filter ──────────────────────────────────────────
  const [supplierFilter, setSupplierFilter] = useState<string>(''); // '' = alle

  // ─── Forecast Umsatz (per Zeitraum, localStorage) ─────────────────────────
  const [forecastRevs, setForecastRevs] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`waren_analyse_forecasts_${tenantId}`);
      setForecastRevs(stored ? JSON.parse(stored) : {});
    } catch { setForecastRevs({}); }
  }, [tenantId]);
  const updateForecastRev = (key: string, value: number) => {
    const updated = { ...forecastRevs, [key]: Math.max(0, Math.round(value)) };
    setForecastRevs(updated);
    localStorage.setItem(`waren_analyse_forecasts_${tenantId}`, JSON.stringify(updated));
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    console.log(`[WAREN] tenant: ${tenantId} · month: ${monthKey}`);
    const [sups, invs] = await Promise.all([
      loadSuppliers(tenantId),
      loadMonthInvoices(tenantId, monthKey),
    ]);
    const rev = loadDailyRevenueFromLocalStorage(tenantId, monthKey);
    setSuppliers(sups);
    setEntries(invs);
    setRevenueByDate(rev);
    setLoading(false);
  }, [tenantId, monthKey]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Preisänderungs-Hinweise des Monats (Icon + Tooltip an der Rechnung) ──
  const [preisHinweise, setPreisHinweise] = useState<Record<string, PreisAenderung[]>>({});
  const ladePreisHinweise = useCallback(async () => {
    try { setPreisHinweise(await loadPreisHinweise(tenantId, monthKey)); }
    catch { setPreisHinweise({}); }
  }, [tenantId, monthKey]);
  useEffect(() => { void ladePreisHinweise(); }, [ladePreisHinweise]);

  // ── Rechnungspositionen des Monats (Konto pro Position, Drilldown/Override) ──
  const [rechnungsPositionen, setRechnungsPositionen] = useState<PositionenProRechnung>({});
  const [positionenDialog, setPositionenDialog] = useState<{ invoiceId: string; positionen: GespeichertePosition[] } | null>(null);
  const ladePositionen = useCallback(async () => {
    try { setRechnungsPositionen(await loadRechnungsPositionen(tenantId, monthKey)); }
    catch { setRechnungsPositionen({}); }
  }, [tenantId, monthKey]);
  useEffect(() => { void ladePositionen(); }, [ladePositionen]);

  /** Manuelles Konto-Override einer Position speichern + Rechnungs-Splits neu ableiten. */
  const speicherePositionen = async (invoiceId: string, positionen: GespeichertePosition[]) => {
    const entry = entries.find(e => e.id === invoiceId);
    try {
      const next = { ...rechnungsPositionen, [invoiceId]: positionen };
      await saveRechnungsPositionen(tenantId, monthKey, next);
      setRechnungsPositionen(next);
      if (entry) {
        const splits = kontoSplitsAusPositionen(positionen);
        const haupt = splits.find(s => /^\d+$/.test(s.warenkonto))?.warenkonto;
        const aktualisiert: InvoiceEntry = {
          ...entry,
          ...(splits.length > 1
            ? { kontoSplits: splits, warenkonto: undefined }
            : { warenkonto: splits[0]?.warenkonto, kontoSplits: undefined }),
          ...(haupt ? { kategorie: kategorieFromKonto(haupt) } : {}),
          updatedAt: new Date().toISOString(),
        };
        await saveInvoiceEntry(tenantId, aktualisiert);
        await loadData();
      }
      toast.success('Kontierung gespeichert.');
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const loadAnalyseRange = useCallback(async () => {
    setRangeLoading(true);
    let monthKeys: string[] = [];
    if (analyseMode === 'week') {
      const { from, to } = isoWeekRange(aYear, aWeekNum);
      const seen = new Set<string>();
      let d = new Date(from + 'T12:00:00');
      const toD = new Date(to + 'T12:00:00');
      while (d <= toD) {
        seen.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
        d.setDate(d.getDate() + 1);
      }
      monthKeys = Array.from(seen);
    } else if (analyseMode === 'month') {
      monthKeys = [`${aYear}-${String(aMonth).padStart(2,'0')}`];
    } else if (analyseMode === 'multi_month') {
      let y = aFromYear, m = aFromMonth;
      const endKey = `${aToYear}-${String(aToMonth).padStart(2,'0')}`;
      for (let i = 0; i < 25; i++) {
        const k = `${y}-${String(m).padStart(2,'0')}`;
        monthKeys.push(k);
        if (k === endKey) break;
        m++; if (m > 12) { m = 1; y++; }
      }
    } else {
      for (let m2 = 1; m2 <= 12; m2++) {
        monthKeys.push(`${aRangeYear}-${String(m2).padStart(2,'0')}`);
      }
    }
    const results = await Promise.all(monthKeys.map(mk => loadMonthInvoices(tenantId, mk)));
    const allEntries: InvoiceEntry[] = results.flat();
    const allRevenue: Record<string, number> = {};
    for (const mk of monthKeys) {
      Object.assign(allRevenue, loadDailyRevenueFromLocalStorage(tenantId, mk));
    }
    // Monatliches Umsatz-Budget laden (als Fallback wenn kein tagesgenauer Umsatz vorhanden)
    // Seed-Daten werden beim ersten Aufruf automatisch eingetragen (einmalig, authentifiziert)
    const years = Array.from(new Set(monthKeys.map(mk => Number(mk.slice(0, 4)))));
    await Promise.all(years.map(y => seedMonthlyRevenueIfMissing(tenantId, y)));
    const budgetResults = await Promise.all(years.map(y => loadWarenMonthlyRevenue(tenantId, y)));
    const allBudget: Record<string, number> = {};
    budgetResults.forEach(b => Object.assign(allBudget, b));

    // Tagesverteilung: für Monate ohne tagesgenauem Umsatz → Budget verteilen
    // Gewichtung: Mo–Fr = 15, Sa = 10, So = 0 (geschlossen)
    for (const mk of monthKeys) {
      const monthBudget = allBudget[mk];
      if (!monthBudget || monthBudget <= 0) continue;
      const [y2, m2] = mk.split('-').map(Number);
      const daysInMk = getDaysInMonth(y2, m2);
      const hasActual = daysInMk.some(d => (allRevenue[d] ?? 0) > 0);
      if (!hasActual) {
        for (const d of daysInMk) {
          const daily = computeDailyBudgetRevenue(monthBudget, d, daysInMk);
          if (daily > 0) allRevenue[d] = daily;
        }
        console.log(`[WAREN] budget distributed for ${mk}: ${daysInMk.filter(d => (allRevenue[d] ?? 0) > 0).length} Tage mit Umsatz`);
      }
    }

    setRangeEntries(allEntries);
    setRangeRevenue(allRevenue);
    setMonthlyRevBudget(allBudget);
    setRangeLoading(false);
  }, [analyseMode, aYear, aMonth, aWeekNum, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, tenantId]);

  useEffect(() => { void loadAnalyseRange(); }, [loadAnalyseRange]);

  // Analyse-Monat folgt dem Haupt-Monatspicker (oben) wenn im Monat-Modus
  useEffect(() => {
    if (analyseMode === 'month') {
      setAYear(year);
      setAMonth(month);
    }
  }, [year, month, analyseMode]);

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

  const stats = useMemo(() => computeMonthStats(entries, revenueByDate), [entries, revenueByDate]);
  // Kategorisierte Monatssummen (Food/Beverage/Sonstiges) – Basis der Quote.
  // Kontoklassen: nur Warenkosten-Anteile (4000–Grenze); Betriebskosten separat.
  const monthTotals = useMemo(() => computeWarenkostenTotals(nurWarenAnteil(entries, warenGrenze), warenGrenze), [entries, warenGrenze]);
  const monthBetrieb = useMemo(() => sumBetriebNet(entries, warenGrenze), [entries, warenGrenze]);

  const totalRevenue = useMemo(
    () => Object.values(revenueByDate).reduce((s, v) => s + v, 0),
    [revenueByDate],
  );
  // Quote = relevante Warenkosten (Food+Beverage) / Umsatz; Sonstiges ausgeschlossen.
  const monthPct     = warenkostenQuote(monthTotals.relevantNet, totalRevenue);
  const todayEntries = useMemo(() => entries.filter(e => e.date === todayStr), [entries, todayStr]);
  const todayNet     = useMemo(() => todayEntries.reduce((s, e) => s + e.amountNet, 0), [todayEntries]);
  const todayRevenue = revenueByDate[todayStr] ?? 0;
  const todayPct     = warenkostenQuote(relevantNetOf(todayEntries, warenGrenze), todayRevenue);

  const datesWithEntries = useMemo(() => Array.from(new Set(entries.map(e => e.date))).sort(), [entries]);

  // Gefilterte Einträge für Erfassung-Tab (nach Lieferant)
  const filteredEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
    if (!erfassungSupplierFilter) return sorted;
    return sorted.filter(e => e.supplierName === erfassungSupplierFilter);
  }, [entries, erfassungSupplierFilter]);

  const filteredTotalNet   = useMemo(() => filteredEntries.reduce((s, e) => s + e.amountNet, 0),   [filteredEntries]);
  const filteredTotalGross = useMemo(() => filteredEntries.reduce((s, e) => s + e.amountGross, 0), [filteredEntries]);

  // Alle Lieferanten die im aktuellen Monat Einträge haben (für Dropdown)
  const entrySupplierNames = useMemo(() =>
    Array.from(new Set(entries.map(e => e.supplierName))).sort(),
    [entries],
  );

  const tableDates = useMemo(() => {
    const all  = getDaysInMonth(year, month);
    const past = all.filter(d => d <= todayStr);
    return past.slice(-14);
  }, [year, month, todayStr]);

  const liveAmounts = useMemo(() => {
    const r = Number(form.vatRate);
    if (form.splitEnabled) {
      let gross = 0, net = 0, any = false;
      for (const s of form.splits) {
        const a = Number(s.amount);
        if (!s.amount || isNaN(a) || a <= 0) continue;
        const v = calcAmounts(a, form.vatIncluded, r);
        gross += v.amountGross; net += v.amountNet; any = true;
      }
      return any ? { amountGross: gross, amountNet: net } : null;
    }
    if (!form.amount || isNaN(Number(form.amount))) return null;
    return calcAmounts(Number(form.amount), form.vatIncluded, r);
  }, [form.amount, form.vatIncluded, form.vatRate, form.splitEnabled, form.splits]);

  const activeSuppliers    = suppliers.filter(s => s.active);
  // Zuletzt genutzte Lieferanten zuoberst im Schnellerfassungs-Dropdown.
  const recentSupplierOptions = useMemo(
    () => recentSuppliers
      .map(name => activeSuppliers.find(s => s.name === name))
      .filter((s): s is Supplier => Boolean(s)),
    [recentSuppliers, suppliers], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const suppliersWithEntries = stats.supplierTotals.length;

  function getCumulative(upToDate: string) {
    const list   = entries.filter(e => e.date <= upToDate);
    const cumNet = list.reduce((s, e) => s + e.amountNet, 0);
    const cumRev = Object.entries(revenueByDate).filter(([d]) => d <= upToDate).reduce((s, [, v]) => s + v, 0);
    // Quote nur auf relevante Warenkosten (Food+Beverage); cumNet bleibt Gesamtanzeige.
    return { cumNet, cumRev, pct: warenkostenQuote(relevantNetOf(list, warenGrenze), cumRev) };
  }

  // ─── Chart-Daten ────────────────────────────────────────────────────────────

  interface ChartPoint {
    date:    string;
    label:   string;
    dayNet:  number;
    dayRev:  number;
    dayPct:  number | null;
    cumNet:  number;
    cumRev:  number;
    cumPct:  number | null;
    hasEntry: boolean;
  }

  // ─── Wochen-Daten ───────────────────────────────────────────────────────────

  type WeekStatus = 'green' | 'yellow' | 'red' | 'nodata';

  interface WeekData {
    weekKey:   string;   // "2026-W14"
    weekLabel: string;   // "KW 14"
    from:      string;   // "2026-04-01"
    to:        string;   // "2026-04-07"
    revenue:   number;
    costNet:   number;
    pct:       number | null;
    cumNet:    number;
    cumRev:    number;
    cumPct:    number | null;
    status:    WeekStatus;
    isCurrent: boolean;
    isComplete: boolean; // Sonntag der Woche liegt in der Vergangenheit
  }

  const weeklyData = useMemo((): WeekData[] => {
    const allDays = getDaysInMonth(year, month);
    // Nur vergangene oder heutige Tage
    const pastDays = allDays.filter(d => d <= todayStr);

    // Alle vorkommenden Wochen sammeln
    const weekKeys = new Set<string>();
    for (const d of pastDays) {
      const { week, isoYear } = getIsoWeek(d);
      weekKeys.add(`${isoYear}-W${String(week).padStart(2, '0')}`);
    }

    // Kumulierte Werte über den ganzen Monat
    let runCumNet = 0;
    let runCumRev = 0;
    let runCumRel = 0;
    const cumByDate: Record<string, { cumNet: number; cumRev: number; cumRel: number }> = {};
    for (const d of allDays.filter(d2 => d2 <= todayStr)) {
      const dayEntries = entries.filter(e => e.date === d);
      runCumNet += dayEntries.reduce((s, e) => s + e.amountNet, 0);
      runCumRel += relevantNetOf(dayEntries, warenGrenze);
      runCumRev += revenueByDate[d] ?? 0;
      cumByDate[d] = { cumNet: runCumNet, cumRev: runCumRev, cumRel: runCumRel };
    }

    const currentWeekKey = (() => { const { week, isoYear } = getIsoWeek(todayStr); return `${isoYear}-W${String(week).padStart(2, '0')}`; })();

    const result: WeekData[] = [];
    for (const wk of Array.from(weekKeys).sort()) {
      const [isoYStr, wStr] = wk.split('-W');
      const isoYear = Number(isoYStr);
      const week    = Number(wStr);
      const { from, to } = isoWeekRange(isoYear, week);

      // Tage dieser Woche die im Monat und Vergangenheit liegen
      const weekDays = pastDays.filter(d => d >= from && d <= to);

      const revenue = weekDays.reduce((s, d) => s + (revenueByDate[d] ?? 0), 0);
      const costNet = weekDays.reduce((s, d) => s + entries.filter(e => e.date === d).reduce((s2, e) => s2 + e.amountNet, 0), 0);
      const costRel = weekDays.reduce((s, d) => s + relevantNetOf(entries.filter(e => e.date === d), warenGrenze), 0);
      const pct     = warenkostenQuote(costRel, revenue);

      // Kumuliert bis Ende der Woche (letzter bekannter Tag)
      const lastDay    = weekDays[weekDays.length - 1] ?? to;
      const cum        = cumByDate[lastDay] ?? { cumNet: 0, cumRev: 0, cumRel: 0 };
      const cumPct     = warenkostenQuote(cum.cumRel, cum.cumRev);
      const isComplete = to <= todayStr;
      const isCurrent  = wk === currentWeekKey;

      const status: WeekStatus = (() => {
        if (pct === null) return 'nodata';
        if (pct <= targetPct)            return 'green';
        if (pct <= targetPct + 2)        return 'yellow';
        return 'red';
      })();

      console.log(`[WAREN-WEEK] tenant: ${tenantId}`);
      console.log(`[WAREN-WEEK] week: ${wk} (${from}–${to})`);
      console.log(`[WAREN-WEEK] revenue: CHF ${revenue.toFixed(0)}`);
      console.log(`[WAREN-WEEK] cost chf: CHF ${costNet.toFixed(0)}`);
      console.log(`[WAREN-WEEK] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
      console.log(`[WAREN-WEEK] status: ${status}`);

      result.push({
        weekKey: wk, weekLabel: `KW ${String(week).padStart(2, '0')}`,
        from, to, revenue, costNet, pct, cumNet: cum.cumNet, cumRev: cum.cumRev,
        cumPct, status, isCurrent, isComplete,
      });
    }

    // Aktuelle Woche oben, dann nach Status (rot zuerst), dann nach Wochennummer absteigend
    return result.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return  1;
      const order: Record<WeekStatus, number> = { red: 0, yellow: 1, green: 2, nodata: 3 };
      return order[a.status] - order[b.status];
    });
  }, [entries, revenueByDate, year, month, todayStr, targetPct, tenantId, warenGrenze]);

  const chartData = useMemo((): ChartPoint[] => {
    const allDays = getDaysInMonth(year, month);
    const past = allDays.filter(d => d <= todayStr);
    let cumNet = 0;
    let cumRev = 0;
    let cumRel = 0;
    const points = past.map(d => {
      const dayEntries = entries.filter(e => e.date === d);
      const dayNet = dayEntries.reduce((s, e) => s + e.amountNet, 0);
      const dayRel = relevantNetOf(dayEntries, warenGrenze);
      const dayRev = revenueByDate[d] ?? 0;
      cumNet += dayNet;
      cumRel += dayRel;
      cumRev += dayRev;
      // Quote-Prozente auf relevante Warenkosten (Food+Beverage); dayNet/cumNet bleiben Gesamtanzeige.
      const dayPct = warenkostenQuote(dayRel, dayRev);
      const cumPct = warenkostenQuote(cumRel, cumRev);
      return { date: d, label: formatDateShort(d), dayNet, dayRev, dayPct, cumNet, cumRev, cumPct, hasEntry: dayNet > 0 };
    });
    const daysLoaded = points.filter(p => p.hasEntry).length;
    const lastCum = points.length > 0 ? points[points.length - 1].cumPct : null;
    console.log(`[WAREN-CHART] tenant: ${tenantId}`);
    console.log(`[WAREN-CHART] days loaded: ${daysLoaded}`);
    console.log(`[WAREN-CHART] cumulative pct: ${lastCum !== null ? lastCum.toFixed(1) + '%' : '–'}`);
    console.log(`[WAREN-CHART] daily pct: ${points.filter(p => p.dayPct !== null).map(p => p.dayPct!.toFixed(1) + '%').join(', ') || '–'}`);
    return points;
  }, [entries, revenueByDate, year, month, todayStr, tenantId, warenGrenze]);

  // ─── Analyse: abgeleitete Daten ──────────────────────────────────────────

  const analyseDates = useMemo((): { from: string; to: string } => {
    if (analyseMode === 'week') {
      return isoWeekRange(aYear, aWeekNum);
    } else if (analyseMode === 'month') {
      const days = getDaysInMonth(aYear, aMonth);
      return { from: days[0], to: days[days.length - 1] };
    } else if (analyseMode === 'multi_month') {
      const fromDays = getDaysInMonth(aFromYear, aFromMonth);
      const toDays   = getDaysInMonth(aToYear, aToMonth);
      return { from: fromDays[0], to: toDays[toDays.length - 1] };
    } else if (analyseMode === 'ytd') {
      return { from: `${aRangeYear}-01-01`, to: todayStr };
    } else {
      return { from: `${aRangeYear}-01-01`, to: `${aRangeYear}-12-31` };
    }
  }, [analyseMode, aYear, aMonth, aWeekNum, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, todayStr]);

  const analysisEntries = useMemo(
    () => rangeEntries.filter(e => e.date >= analyseDates.from && e.date <= analyseDates.to),
    [rangeEntries, analyseDates],
  );

  const analysisRevenue = useMemo(() => {
    const rv: Record<string, number> = {};
    for (const [k, v] of Object.entries(rangeRevenue)) {
      if (k >= analyseDates.from && k <= analyseDates.to) rv[k] = v;
    }
    return rv;
  }, [rangeRevenue, analyseDates]);

  const analyseKPIs = useMemo(() => {
    const effectiveTo = analyseDates.to > todayStr ? todayStr : analyseDates.to;
    const totalRev  = Object.entries(analysisRevenue).filter(([k]) => k <= effectiveTo).reduce((s, [, v]) => s + v, 0);
    const periodEntries = analysisEntries.filter(e => e.date <= effectiveTo);
    // Kontoklassen: Warenkosten-Anteile (4000–Grenze) für Total/Quote;
    // Betriebskosten-Anteile (> Grenze) separat — NIE in der WKQ.
    const totals = computeWarenkostenTotals(nurWarenAnteil(periodEntries, warenGrenze), warenGrenze);
    const betriebCost  = sumBetriebNet(periodEntries, warenGrenze);
    const totalCost    = totals.totalNet;     // Warenkosten inkl. Sonstiges – Gesamtanzeige
    const relevantCost = totals.relevantNet;  // Food+Beverage – alleinige Quotenbasis
    const pct = warenkostenQuote(relevantCost, totalRev);
    console.log(`[WAREN-ANALYSE] mode: ${analyseMode}`);
    console.log(`[WAREN-ANALYSE] range: ${analyseDates.from} – ${effectiveTo}`);
    console.log(`[WAREN-ANALYSE] revenue total: CHF ${totalRev.toFixed(0)}`);
    console.log(`[WAREN-ANALYSE] cost total (inkl. Sonstiges): CHF ${totalCost.toFixed(0)}`);
    console.log(`[WAREN-ANALYSE] cost relevant (Food+Bev): CHF ${relevantCost.toFixed(0)}`);
    console.log(`[WAREN-ANALYSE] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
    return {
      totalRev, totalCost, relevantCost, betriebCost, pct, effectiveTo,
      foodCost: totals.foodNet, beverageCost: totals.beverageNet, sonstigeCost: totals.sonstigeNet,
    };
  }, [analysisEntries, analysisRevenue, analyseDates, analyseMode, todayStr, warenGrenze]);

  /**
   * Abgleich berechnete Warenkosten (operativ, Food+Beverage) ↔ Erfolgsrechnung
   * (FIBU cogs_food/cogs_bev). SINGLE SOURCE OF TRUTH:
   *  - berechnete Seite = dieselben kategorisierten Summen wie die Analyse-KPIs,
   *  - FIBU-Seite = `computePLForMonth` (identische Quelle wie Reporting/PLView),
   *    die Werte werden NICHT nachträglich faktorisiert.
   * Beide Quoten teilen die FIBU-Umsatzbasis (net_revenue) über `buildErVergleich`.
   */
  const erVergleich = useMemo(() => {
    const sk = tenantKey(REPORTING_STORAGE_KEY);
    const [fy, fm, fd] = analyseDates.from.split('-').map(Number);
    const [ty, tm, td] = analyseDates.to.split('-').map(Number);
    let cogsFood = 0, cogsBev = 0, cogsOther = 0, netRev = 0;
    let anyEr = false;
    let y = fy, m = fm;
    // Über alle Kalendermonate des Analyse-Zeitraums summieren.
    while (y < ty || (y === ty && m <= tm)) {
      const record = loadMonth(y, m, sk);
      if (record.expenseCategories.length > 0) anyEr = true;
      const pl = computePLForMonth(record);
      const val = (id: string) => pl.rows.find(r => r.def.id === id)?.values.actual ?? 0;
      cogsFood  += val('cogs_food');
      cogsBev   += val('cogs_bev');
      cogsOther += val('cogs_other');
      netRev    += val('net_revenue');
      m++; if (m > 12) { m = 1; y++; }
    }
    const v = buildErVergleich({
      calcFood: analyseKPIs.foodCost,
      calcBev: analyseKPIs.beverageCost,
      er: anyEr ? { cogsFood, cogsBev, cogsOther, revenue: netRev > 0 ? netRev : null } : null,
    });
    // Der FIBU-Abgleich summiert IMMER ganze Kalendermonate. Aussagekräftig ist
    // er nur, wenn der Analyse-Zeitraum genau abgeschlossene Monate abdeckt
    // (1. bis Monatsende, komplett in der Vergangenheit). Teilzeiträume
    // (Woche / laufender Monat / YTD) würden eine Scheindifferenz erzeugen.
    const lastDayToMonth = new Date(ty, tm, 0).getDate();
    const [cy, cm] = todayStr.split('-').map(Number);
    const monthAligned =
      fd === 1 && td === lastDayToMonth && (ty < cy || (ty === cy && tm < cm));
    console.log(`[WAREN-ER] hasEr: ${v.hasEr} · aligned: ${monthAligned} · calc ${v.calcQuote?.toFixed(1) ?? '–'}% · er ${v.erQuote?.toFixed(1) ?? '–'}% · diffPp ${v.diffPp?.toFixed(2) ?? '–'}`);
    return { ...v, monthAligned };
    // tenantKey ist nicht memoisiert; tenantId triggert korrektes Neuladen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyseDates, analyseKPIs.foodCost, analyseKPIs.beverageCost, tenantId, todayStr]);

  // Lieferanten-Auswertung: GESAMT-Total über ALLE Konten (Waren + Betrieb) —
  // für den vollständigen Vergleich mit Buchhaltung/Kontoblatt — plus die
  // Aufschlüsselung «davon Warenkosten / davon Betriebskosten».
  const analyseSuppliers = useMemo(() => {
    const effectiveTo = analyseDates.to > todayStr ? todayStr : analyseDates.to;
    // Alias-Gruppen: gleiche Zusammenführung wie im FIBU-Abgleich (nur Namen,
    // Beträge/Totale unverändert).
    const list = applyAliasGruppen(analysisEntries.filter(x => x.date <= effectiveTo), aliasGruppen);
    const grossByName: Record<string, number> = {};
    for (const e of list) {
      grossByName[(e.supplierName || '—').trim() || '—'] =
        (grossByName[(e.supplierName || '—').trim() || '—'] ?? 0) + e.amountGross;
    }
    return aggregateBySupplierKlassen(list, warenGrenze).map(r => ({
      name: r.supplierName, net: r.totalNet, gross: grossByName[r.supplierName] ?? 0,
      waren: r.warenNet, betrieb: r.betriebNet,
    }));
  }, [analysisEntries, analyseDates, todayStr, warenGrenze, aliasGruppen]);

  // Einzel-Rechnungen des gefilterten Lieferanten im gewählten Zeitraum
  const supplierDetailEntries = useMemo(() => {
    if (!supplierFilter) return [];
    const effectiveTo = analyseDates.to > todayStr ? todayStr : analyseDates.to;
    // Filter über den kanonischen Namen — bei Alias-Gruppen zählen alle
    // Original-Namen der Gruppe zum gefilterten Lieferanten.
    return analysisEntries
      .filter(e => aliasResolver(e.supplierName) === supplierFilter && e.date <= effectiveTo)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [analysisEntries, supplierFilter, analyseDates, todayStr, aliasResolver]);

  // Summen für den gefilterten Lieferanten
  const supplierFilterTotals = useMemo(() => {
    const net   = supplierDetailEntries.reduce((s, e) => s + e.amountNet, 0);
    const gross = supplierDetailEntries.reduce((s, e) => s + e.amountGross, 0);
    return { net, gross };
  }, [supplierDetailEntries]);

  // Tages-Chart (Woche / Monat)
  interface AChartPoint { date: string; label: string; dayNet: number; dayRev: number; dayPct: number | null; cumNet: number; cumRev: number; cumPct: number | null; hasEntry: boolean; }
  const analyseChartPoints = useMemo((): AChartPoint[] => {
    if (analyseMode !== 'week' && analyseMode !== 'month') return [];
    const allDays = (() => {
      if (analyseMode === 'week') {
        const days: string[] = [];
        const d = new Date(analyseDates.from + 'T12:00:00');
        while (ymdLocal(d) <= analyseDates.to) {
          days.push(ymdLocal(d));
          d.setDate(d.getDate() + 1);
        }
        return days;
      }
      return getDaysInMonth(aYear, aMonth);
    })();
    const past = allDays.filter(d => d <= todayStr);
    let cumNet = 0, cumRev = 0, cumRel = 0;
    return past.map(d => {
      const dayEntries = analysisEntries.filter(e => e.date === d);
      const dayNet = dayEntries.reduce((s, e) => s + e.amountNet, 0);
      const dayRel = relevantNetOf(dayEntries, warenGrenze);
      const dayRev = analysisRevenue[d] ?? 0;
      cumNet += dayNet; cumRel += dayRel; cumRev += dayRev;
      const dayPct = warenkostenQuote(dayRel, dayRev);
      const cumPct = warenkostenQuote(cumRel, cumRev);
      return { date: d, label: formatDateShort(d), dayNet, dayRev, dayPct, cumNet, cumRev, cumPct, hasEntry: dayNet > 0 };
    });
  }, [analyseMode, analysisEntries, analysisRevenue, analyseDates, aYear, aMonth, todayStr]);

  // Monats-Chart (Mehrere Monate / Jahr / YTD)
  interface AMonthPoint { monthKey: string; label: string; revenue: number; costNet: number; pct: number | null; cumNet: number; cumRev: number; cumPct: number | null; }
  const analyseMonthPoints = useMemo((): AMonthPoint[] => {
    if (analyseMode === 'week' || analyseMode === 'month') return [];
    const monthList: string[] = [];
    if (analyseMode === 'multi_month') {
      let y = aFromYear, m = aFromMonth;
      const endKey = `${aToYear}-${String(aToMonth).padStart(2,'0')}`;
      for (let i = 0; i < 25; i++) {
        const k = `${y}-${String(m).padStart(2,'0')}`;
        monthList.push(k);
        if (k === endKey) break;
        m++; if (m > 12) { m = 1; y++; }
      }
    } else {
      for (let m2 = 1; m2 <= 12; m2++) {
        monthList.push(`${aRangeYear}-${String(m2).padStart(2,'0')}`);
      }
    }
    let cumNet = 0, cumRev = 0, cumRel = 0;
    return monthList.map(mk => {
      const [y, m] = mk.split('-').map(Number);
      const days   = getDaysInMonth(y, m);
      const pastDs = days.filter(d => d <= todayStr && d <= analyseDates.to);
      const revenue = pastDs.reduce((s, d) => s + (rangeRevenue[d] ?? 0), 0);
      const monthEntries = rangeEntries.filter(e => e.date >= days[0] && e.date <= days[days.length-1] && e.date <= todayStr);
      const costNet = monthEntries.reduce((s, e) => s + e.amountNet, 0);
      const costRel = relevantNetOf(monthEntries, warenGrenze);
      cumNet += costNet; cumRel += costRel; cumRev += revenue;
      const pct    = warenkostenQuote(costRel, revenue);
      const cumPct = warenkostenQuote(cumRel, cumRev);
      // Debug-Logs
      console.log(`[WAREN-YEAR] month: ${mk}`);
      console.log(`[WAREN-YEAR] revenue: CHF ${revenue.toFixed(0)}`);
      console.log(`[WAREN-YEAR] cost chf: CHF ${costNet.toFixed(0)}`);
      console.log(`[WAREN-YEAR] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
      console.log(`[WAREN-YEAR] status: ${pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red'}`);
      return { monthKey: mk, label: `${MONTHS[m-1]} ${y !== aRangeYear ? y : ''}`.trim(), revenue, costNet, pct, cumNet, cumRev, cumPct };
    });
  }, [analyseMode, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, rangeEntries, rangeRevenue, analyseDates, todayStr, targetPct]);

  // Wochen-Alerts (innerhalb des gewählten Analyse-Zeitraums, nur Monat-Modus sinnvoll)
  const analyseWeeklyData = useMemo((): WeekData[] => {
    if (analyseMode !== 'month') return [];
    const allDays = getDaysInMonth(aYear, aMonth);
    const pastDays = allDays.filter(d => d <= todayStr);
    const weekKeys = new Set<string>();
    for (const d of pastDays) {
      const { week, isoYear } = getIsoWeek(d);
      weekKeys.add(`${isoYear}-W${String(week).padStart(2,'0')}`);
    }
    let runCumNet = 0, runCumRev = 0, runCumRel = 0;
    const cumByDate: Record<string, { cumNet: number; cumRev: number; cumRel: number }> = {};
    for (const d of pastDays) {
      const dayEntries = analysisEntries.filter(e => e.date === d);
      runCumNet += dayEntries.reduce((s, e) => s + e.amountNet, 0);
      runCumRel += relevantNetOf(dayEntries, warenGrenze);
      runCumRev += analysisRevenue[d] ?? 0;
      cumByDate[d] = { cumNet: runCumNet, cumRev: runCumRev, cumRel: runCumRel };
    }
    const currentWeekKey = (() => { const { week, isoYear } = getIsoWeek(todayStr); return `${isoYear}-W${String(week).padStart(2,'0')}`; })();
    const result: WeekData[] = [];
    for (const wk of Array.from(weekKeys).sort()) {
      const [isoYStr, wStr] = wk.split('-W');
      const isoYear2 = Number(isoYStr); const week2 = Number(wStr);
      const { from, to } = isoWeekRange(isoYear2, week2);
      const weekDays = pastDays.filter(d => d >= from && d <= to);
      const revenue = weekDays.reduce((s, d) => s + (analysisRevenue[d] ?? 0), 0);
      const costNet = weekDays.reduce((s, d) => s + analysisEntries.filter(e => e.date === d).reduce((s2, e) => s2 + e.amountNet, 0), 0);
      const costRel = weekDays.reduce((s, d) => s + relevantNetOf(analysisEntries.filter(e => e.date === d), warenGrenze), 0);
      const pct = warenkostenQuote(costRel, revenue);
      const lastDay = weekDays[weekDays.length - 1] ?? to;
      const cum = cumByDate[lastDay] ?? { cumNet: 0, cumRev: 0, cumRel: 0 };
      const cumPct = warenkostenQuote(cum.cumRel, cum.cumRev);
      const isComplete = to <= todayStr; const isCurrent = wk === currentWeekKey;
      const status: WeekStatus = pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
      result.push({ weekKey: wk, weekLabel: `KW ${String(week2).padStart(2,'0')}`, from, to, revenue, costNet, pct, cumNet: cum.cumNet, cumRev: cum.cumRev, cumPct, status, isCurrent, isComplete });
    }
    return result.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1; if (!a.isCurrent && b.isCurrent) return 1;
      const o: Record<WeekStatus, number> = { red: 0, yellow: 1, green: 2, nodata: 3 };
      return o[a.status] - o[b.status];
    });
  }, [analyseMode, analysisEntries, analysisRevenue, aYear, aMonth, targetPct, todayStr, warenGrenze]);

  // Navigation-Helfer für Analyse
  const prevAWeek = () => { let w = aWeekNum - 1, y = aYear; if (w < 1) { y--; w = getIsoWeek(`${y}-12-28`).week; } setAWeekNum(w); setAYear(y); };
  const nextAWeek = () => { const maxW = getIsoWeek(`${aYear}-12-28`).week; let w = aWeekNum + 1, y = aYear; if (w > maxW) { w = 1; y++; } setAWeekNum(w); setAYear(y); };
  const isCurrentAWeek = aYear === today.getFullYear() && aWeekNum === getIsoWeek(todayStr).week;
  const prevAMonth = () => { if (aMonth === 1) { setAYear(y => y - 1); setAMonth(12); } else setAMonth(m => m - 1); };
  const nextAMonth = () => { if (aMonth === 12) { setAYear(y => y + 1); setAMonth(1); } else setAMonth(m => m + 1); };
  const isCurrentAMonth = aYear === today.getFullYear() && aMonth === today.getMonth() + 1;
  const analyseRangeLabel = (() => {
    if (analyseMode === 'week')        return `KW ${String(aWeekNum).padStart(2,'0')} · ${aYear}`;
    if (analyseMode === 'month')       return `${MONTHS_LONG[aMonth-1]} ${aYear}`;
    if (analyseMode === 'multi_month') return `${MONTHS[aFromMonth-1]} ${aFromYear} – ${MONTHS[aToMonth-1]} ${aToYear}`;
    if (analyseMode === 'ytd')         return `YTD ${aRangeYear} (Jan – heute)`;
    return `Jahr ${aRangeYear}`;
  })();

  // ─── Forecast-Abgeleitete Werte ────────────────────────────────────────────
  const forecastKey = (() => {
    if (analyseMode === 'week')        return `week_${aYear}-W${String(aWeekNum).padStart(2,'0')}`;
    if (analyseMode === 'month')       return `month_${aYear}-${String(aMonth).padStart(2,'0')}`;
    if (analyseMode === 'multi_month') return `multi_${aFromYear}-${aFromMonth}_${aToYear}-${aToMonth}`;
    if (analyseMode === 'ytd')         return `ytd_${aRangeYear}`;
    return `year_${aRangeYear}`;
  })();
  const forecastRev      = forecastRevs[forecastKey] ?? 0;         // nur der Zusatzumsatz
  const forecastTotal    = analyseKPIs.totalRev + forecastRev;     // aktuell + zusatz
  const forecastPct      = forecastRev > 0 && analyseKPIs.relevantCost > 0 && forecastTotal > 0
    ? warenkostenQuote(analyseKPIs.relevantCost, forecastTotal) : null;
  const forecastQuickValues = analyseMode === 'week'
    ? [1000, 2000, 3000, 5000, 7500, 10000]
    : analyseMode === 'year' || analyseMode === 'ytd'
    ? [25000, 50000, 75000, 100000, 150000, 200000]
    : [2000, 5000, 10000, 15000, 20000, 25000, 30000];

  /** Excel-Export des aktuellen Analyse-Zeitraums (Detail + Zusammenfassung). */
  async function handleWarenkostenExport() {
    if (!canExport) { toast.error('Keine Berechtigung zum Export.'); return; }
    if (analysisEntries.length === 0) { toast.error('Keine Rechnungen im gewählten Zeitraum.'); return; }
    try {
      await exportWarenkostenToExcel({
        periodLabel: analyseRangeLabel,
        from: analyseDates.from,
        to: analyseDates.to,
        tenantName: tenant.name,
        invoices: analysisEntries,
        revenue: analyseKPIs.totalRev > 0 ? analyseKPIs.totalRev : null,
      });
      toast.success('Excel-Export erstellt.');
    } catch (e) {
      console.error('[WAREN-EXPORT] Export fehlgeschlagen:', e);
      toast.error('Export fehlgeschlagen.');
    }
  }

  // ─── PDF-Erkennung: Datei(en) verarbeiten ─────────────────────────────────

  /** Ein PDF analysieren und die erkannten Werte ins Formular vorfüllen. */
  const processPdf = useCallback(async (file: File) => {
    setPdfBusy(true);
    try {
      const { text, textLayer, ocrFehler } = await extractPdfInvoiceText(file);
      const felder = parseInvoiceText(text);
      const supplierNames = suppliers.filter(s => s.active).map(s => s.name);
      const hit = findSupplierInText(text, supplierNames, aliases);
      // Erkannte Roh-Schreibweise (erste nichtleere Zeile mit Buchstaben) fürs
      // Alias-Lernen, wenn kein Auto-Match gelingt.
      const rawLine = text.split('\n').map(l => l.trim())
        .find(l => /[A-Za-zÄÖÜäöü]{3,}/.test(l) && l.length <= 60) ?? null;

      setForm(f => {
        const sup = hit ? suppliers.find(s => s.name === hit) : undefined;
        return {
          ...f,
          date: felder.date ?? f.date,
          supplierName: hit ?? f.supplierName,
          amount: felder.amount !== null ? String(felder.amount) : f.amount,
          vatIncluded: true, // erkanntes Total ist brutto
          vatRate: felder.vatRate !== null ? String(felder.vatRate) : f.vatRate,
          reference: felder.reference ?? f.reference,
          // Kontierung: Vorschlag = Standard-Konto/-Kategorie des Lieferanten
          warenkonto: sup?.defaultWarenkonto ?? f.warenkonto,
          kategorie: sup?.defaultKategorie
            ?? (sup?.defaultWarenkonto ? kontoKategorie(sup.defaultWarenkonto, warenkonten) : f.kategorie),
        };
      });
      setReceiptFile(file); // Original-PDF wird als Beleg gespeichert
      setAliasLernen(false);
      setErkennung({
        fileName: file.name,
        supplierRaw: hit ? null : rawLine,
        supplierMatched: !!hit,
        felder, textLayer, ocrFehler,
      });
      if (ocrFehler) {
        toast.warning('Kein Text im PDF erkannt (Scan?) — bitte manuell erfassen, das PDF bleibt als Beleg angehängt.');
      } else if (!hit) {
        toast.info('Lieferant nicht erkannt — bitte zuordnen. Die Schreibweise wird für das nächste Mal gemerkt.');
      }
    } catch (err) {
      console.error('[WAREN-PDF] Erkennung fehlgeschlagen:', err);
      setReceiptFile(file);
      setErkennung({ fileName: file.name, supplierRaw: null, supplierMatched: false,
        felder: { date: null, dateSicher: false, amount: null, amountSicher: false, vatRate: null, reference: null },
        textLayer: false, ocrFehler: err instanceof Error ? err.message : String(err) });
      toast.warning('PDF konnte nicht gelesen werden — manuelle Erfassung, PDF als Beleg angehängt.');
    } finally {
      setPdfBusy(false);
      requestAnimationFrame(() => amountInputRef.current?.focus());
    }
  }, [suppliers, aliases, warenkonten]);

  /** Upload-Handler: mehrere PDFs → Stapel; erstes sofort verarbeiten. */
  function handlePdfErkennungFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfs.length === 0) { toast.error('Bitte PDF-Dateien wählen.'); return; }
    const [first, ...rest] = pdfs;
    setPdfQueue(rest);
    void processPdf(first);
  }

  /** Erkennung abbrechen: Vorschau + Beleg verwerfen, Stapel bleibt. */
  function resetErkennung(clearQueue = false) {
    setErkennung(null);
    setAliasLernen(false);
    setReceiptFile(null);
    setReceiptInputKey(k => k + 1);
    if (clearQueue) setPdfQueue([]);
  }

  async function handleSave() {
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    if (!form.supplierName) { toast.error('Bitte Lieferant wählen.'); return; }
    if (!form.splitEnabled && !form.warenkonto) { toast.error('Bitte Warenkonto wählen (Pflichtfeld).'); return; }

    let entry: InvoiceEntry;

    if (form.splitEnabled) {
      // Mehr-Konten-Split: jede Zeile braucht Konto + gültigen Betrag; die
      // Summe der Split-Beträge IST der Rechnungsbetrag (keine Differenz möglich).
      if (form.splits.length < 2) { toast.error('Split braucht mindestens 2 Zeilen.'); return; }
      for (let i = 0; i < form.splits.length; i++) {
        const s = form.splits[i];
        if (!s.konto) { toast.error(`Bitte Konto in Split-Zeile ${i + 1} wählen.`); return; }
        const a = Number(s.amount);
        if (!s.amount || isNaN(a) || a <= 0) {
          toast.error(`Bitte gültigen Betrag in Split-Zeile ${i + 1} eingeben.`); return;
        }
      }
      const r = Number(form.vatRate);
      const splits: KontoSplit[] = form.splits.map(s => {
        const v = calcAmounts(Number(s.amount), form.vatIncluded, r);
        return { warenkonto: s.konto, amountGross: v.amountGross, amountNet: v.amountNet };
      });
      const totGross = splits.reduce((s, x) => s + x.amountGross, 0);
      const totNet   = splits.reduce((s, x) => s + x.amountNet, 0);
      entry = {
        id: generateId(), date: form.date, supplierName: form.supplierName,
        amountGross: totGross,
        amountNet:   totNet,
        vatIncluded: form.vatIncluded, vatRate: r,
        reference: form.reference || undefined, note: form.note || undefined,
        kontoSplits: splits,
        kategorie: form.kategorie,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    } else {
      if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) {
        toast.error('Bitte gültigen Betrag eingeben.'); return;
      }
      const amounts = calcAmounts(Number(form.amount), form.vatIncluded, Number(form.vatRate));
      entry = {
        id: generateId(), date: form.date, supplierName: form.supplierName,
        amountGross: amounts.amountGross, amountNet: amounts.amountNet,
        vatIncluded: form.vatIncluded, vatRate: Number(form.vatRate),
        reference: form.reference || undefined, note: form.note || undefined,
        warenkonto: form.warenkonto || undefined,
        kategorie: form.kategorie,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    }

    // Dublettencheck nach DATEN-Schlüssel (Lieferant + Datum + Betrag bzw.
    // gleiche Referenz) — warnen, nie blockieren: der Nutzer entscheidet.
    // Immer gegen den Bestand des BELEG-Monats prüfen (nicht nur gegen den
    // gerade angezeigten Monat — Datum kann in einem anderen Monat liegen).
    let bestand = entries;
    try { bestand = await loadMonthInvoices(tenantId, entry.date.slice(0, 7)); } catch { /* Fallback: angezeigter Monat */ }
    const dublette = findeDublette(bestand, {
      supplierName: entry.supplierName, date: entry.date,
      amountGross: entry.amountGross, reference: entry.reference,
    });
    if (dublette) {
      const ok = window.confirm(
        `Mögliche Dublette: ${dublette.supplierName} · ${dublette.date} · CHF ${fmtChf(dublette.amountGross)} brutto`
        + `${dublette.reference ? ` · Ref. ${dublette.reference}` : ''} ist bereits erfasst.\n\nTrotzdem speichern?`);
      if (!ok) return;
    }

    setSaving(true);
    if (receiptFile) {
      try {
        entry.receiptPath = await uploadInvoiceReceipt(tenantId, entry.id, receiptFile);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Beleg-Upload fehlgeschlagen.');
        setSaving(false);
        return; // Eintrag NICHT ohne den gewünschten Beleg speichern
      }
    }
    await saveInvoiceEntry(tenantId, entry);
    console.log(`[WAREN] entry saved: ${entry.supplierName} · ${entry.date} · net CHF ${entry.amountNet.toFixed(2)}${entry.kontoSplits ? ' (split)' : entry.warenkonto ? ` · konto ${entry.warenkonto}` : ''}`);
    await loadData();
    // Stapelerfassung: Datum, Lieferant, Konto, Kategorie und MWST bleiben —
    // nur Betrag/Referenz/Bemerkung/Beleg werden geleert, Fokus zurück auf Betrag.
    setForm(f => ({
      ...EMPTY_FORM, date: f.date, supplierName: f.supplierName,
      vatRate: f.vatRate, vatIncluded: f.vatIncluded,
      warenkonto: f.warenkonto, kategorie: f.kategorie,
    }));
    setRecentSuppliers(rememberRecentSupplier(tenantId, entry.supplierName));
    setReceiptFile(null);
    setReceiptInputKey(k => k + 1);
    toast.success(`${form.supplierName} · CHF ${fmtChf(entry.amountNet)} netto gespeichert`);
    setSaving(false);

    // Alias lernen — NUR mit expliziter Zustimmung (Checkbox in der Vorschau):
    // die erkannte Zeile könnte auch eine Adress-/Kopfzeile sein, ein falscher
    // Alias würde künftige Auto-Matches dauerhaft vergiften.
    if (aliasLernen && erkennung && !erkennung.supplierMatched && erkennung.supplierRaw) {
      const aliasKey = normalizeSupplierKey(erkennung.supplierRaw);
      if (aliasKey && !matchSupplier(erkennung.supplierRaw, suppliers.map(s => s.name), aliases)) {
        try {
          await saveSupplierAlias(tenantId, aliasKey, entry.supplierName);
          setAliases(a => ({ ...a, [aliasKey]: entry.supplierName }));
          toast.info(`«${erkennung.supplierRaw}» wird künftig automatisch als ${entry.supplierName} erkannt.`);
        } catch { /* Alias-Lernen ist Komfort — nie den Save-Erfolg stören */ }
      }
    }
    setErkennung(null);
    setAliasLernen(false);

    // Stapel: nächstes PDF aus der Warteschlange verarbeiten.
    if (pdfQueue.length > 0) {
      const [next, ...rest] = pdfQueue;
      setPdfQueue(rest);
      void processPdf(next);
      return;
    }
    requestAnimationFrame(() => amountInputRef.current?.focus());
  }

  /** Lieferant wählen: Standard-Konto/-Kategorie vorfüllen, Fokus auf Betrag. */
  function handlePickSupplier(sup: Supplier) {
    setForm(f => {
      const konto = sup.defaultWarenkonto ?? f.warenkonto;
      const kategorie = sup.defaultKategorie
        ?? (sup.defaultWarenkonto ? kontoKategorie(sup.defaultWarenkonto, warenkonten) : f.kategorie);
      return {
        ...f, supplierName: sup.name, warenkonto: konto, kategorie,
        // MwSt-Satz aus Lieferanten-Profil vorbefüllen (Beaulieu-PDF-Profile)
        vatRate: sup.defaultVatRate !== undefined ? String(sup.defaultVatRate) : f.vatRate,
      };
    });
    setSupplierPickerOpen(false);
    requestAnimationFrame(() => amountInputRef.current?.focus());
  }

  async function handleEditSave() {
    if (!canEdit) { toast.error('Keine Berechtigung zum Bearbeiten von Einträgen.'); return; }
    if (!editEntry) return;
    setSaving(true);
    let receiptPath = editEntry.receiptPath;
    if (editReceiptFile) {
      try {
        receiptPath = await uploadInvoiceReceipt(tenantId, editEntry.id, editReceiptFile);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Beleg-Upload fehlgeschlagen.');
        setSaving(false);
        return;
      }
    }
    await saveInvoiceEntry(tenantId, { ...editEntry, ...(receiptPath ? { receiptPath } : {}), updatedAt: new Date().toISOString() });
    console.log(`[WAREN] entry updated: ${editEntry.id}`);
    await loadData();
    setShowEditDialog(false);
    setEditEntry(null);
    setEditReceiptFile(null);
    toast.success('Eintrag aktualisiert.');
    setSaving(false);
  }

  async function handleDelete(entry: InvoiceEntry) {
    if (!canDelete) { toast.error('Keine Berechtigung zum Löschen von Einträgen.'); return; }
    await deleteInvoiceEntry(tenantId, entry.id, entry.date);
    console.log(`[WAREN] entry deleted: ${entry.id}`);
    if (entry.receiptPath) {
      try { await deleteInvoiceReceipt(tenantId, entry.receiptPath); } catch { /* best effort */ }
    }
    await loadData();
    setDeleteConfirm(null);
    toast.success('Eintrag gelöscht.');
  }

  async function openReceipt(path: string) {
    try {
      const url = await getInvoiceReceiptUrl(tenantId, path);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Beleg konnte nicht geöffnet werden.');
    }
  }

  async function handleAddSupplier() {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const name = newSupplierName.trim();
    if (!name) return;
    if (suppliers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      toast.error('Lieferant existiert bereits.'); return;
    }
    const updated: Supplier[] = [...suppliers, { id: `sup-${Date.now()}`, name, active: true, createdAt: new Date().toISOString() }];
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
    setNewSupplierName('');
    toast.success(`"${name}" hinzugefügt.`);
  }

  async function handleToggleSupplier(sup: Supplier) {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const updated = suppliers.map(s => s.id === sup.id ? { ...s, active: !s.active } : s);
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
  }

  /** Lieferanten-Vorgaben (Standard-Konto/-Kategorie) speichern. */
  async function handleSupplierDefaults(sup: Supplier, patch: Partial<Pick<Supplier, 'defaultWarenkonto' | 'defaultKategorie'>>) {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const updated = suppliers.map(s => {
      if (s.id !== sup.id) return s;
      const next = { ...s, ...patch };
      // Konto gesetzt, aber keine explizite Kategorie → Kategorie aus dem Konto ableiten
      if ('defaultWarenkonto' in patch && patch.defaultWarenkonto && !('defaultKategorie' in patch)) {
        next.defaultKategorie = kontoKategorie(patch.defaultWarenkonto, warenkonten);
      }
      return next;
    });
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
  }

  // ─── Warenkonten verwalten (frei definierbare Liste pro Mandant) ──────────
  async function handleAddKonto() {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const value = newKontoValue.trim();
    const label = newKontoLabel.trim();
    if (!value) return;
    if (warenkonten.some(k => k.value === value)) { toast.error('Kontonummer existiert bereits.'); return; }
    const updated = [...warenkonten, { value, label: label ? `${value} – ${label}` : value }];
    await saveWarenkonten(tenantId, updated);
    setWarenkonten(updated);
    setNewKontoValue(''); setNewKontoLabel('');
    toast.success(`Warenkonto ${value} hinzugefügt.`);
  }

  /** Standard-Kategorie eines Warenkontos setzen (Stammdaten). */
  async function handleSetKontoKategorie(value: string, kategorie: WarenKategorie) {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const updated = warenkonten.map(k => k.value === value ? { ...k, kategorie } : k);
    await saveWarenkonten(tenantId, updated);
    setWarenkonten(updated);
  }

  async function handleRemoveKonto(value: string) {
    if (!canEdit) { toast.error('Keine Berechtigung für Stammdaten-Änderungen.'); return; }
    const updated = warenkonten.filter(k => k.value !== value);
    if (updated.length === 0) { toast.error('Mindestens ein Warenkonto muss bleiben.'); return; }
    await saveWarenkonten(tenantId, updated);
    setWarenkonten(updated);
    // Verwaiste Referenzen im Formular sofort leeren (sonst würde ein
    // entferntes Konto weiter gespeichert werden können).
    setForm(f => ({
      ...f,
      warenkonto: f.warenkonto === value ? '' : f.warenkonto,
      kategorie: f.warenkonto === value ? 'Sonstiges' : f.kategorie,
      splits: f.splits.map(s => s.konto === value ? { ...s, konto: '' } : s),
    }));
    // Lieferanten-Vorgaben auf das entfernte Konto ebenfalls zurücksetzen.
    if (suppliers.some(s => s.defaultWarenkonto === value)) {
      const supUpdated = suppliers.map(s => s.defaultWarenkonto === value ? { ...s, defaultWarenkonto: undefined } : s);
      await saveSuppliers(tenantId, supUpdated);
      setSuppliers(supUpdated);
    }
    toast.success(`Warenkonto ${value} entfernt. Bestehende Buchungen bleiben unverändert.`);
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
  const kpiVariant = (pct: number | null): 'ok' | 'warn' | 'alert' | 'muted' => {
    if (pct === null) return 'muted';
    if (pct > 35) return 'alert';
    if (pct > 30) return 'warn';
    return 'ok';
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap">

          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="p-1.5 rounded-lg flex-shrink-0" style={{ backgroundColor: tenant.color + '18' }}>
              <ShoppingCart className="h-4 w-4" style={{ color: tenant.color }} />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-none">Warenrechnungen</h1>
              <p className="text-xs text-muted-foreground mt-0.5">{tenant.name}</p>
            </div>
          </div>

          {/* Monat */}
          <div className="flex items-center gap-1.5">
            <button onClick={prevMonth} className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums min-w-[148px] text-center">{monthLabel}</span>
            <button onClick={nextMonth} disabled={isCurrentMonth} className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-40">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Lieferanten – nur für Benutzer mit Schreibrecht */}
          {canCreate && (
          <Button variant="outline" size="sm" onClick={() => setShowSupplierDialog(true)} className="h-8 gap-1.5 text-xs">
            <Settings2 className="h-3.5 w-3.5" />
            Lieferanten
          </Button>
          )}
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 flex gap-0 border-t border-border/50">
          {([
            { id: 'erfassung', label: 'Erfassung',  Icon: ClipboardList },
            { id: 'analyse',   label: 'Analyse',    Icon: BarChart3     },
            { id: 'abgleich',  label: 'FIBU-Abgleich', Icon: Scale      },
          ] as { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              <t.Icon className="h-3.5 w-3.5" />
              {t.label}
              {t.id === 'erfassung' && entries.length > 0 && (
                <span className="ml-1 text-[10px] bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 font-mono">
                  {entries.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── Inhalt ──────────────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm gap-2">
            <span className="animate-spin rounded-full h-4 w-4 border-2 border-border border-t-foreground" />
            Wird geladen…
          </div>
        ) : (
          <>
            {/* ── KPI-Block (immer sichtbar) ──────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
              <KpiBox
                label="Warenkosten heute"
                value={`CHF ${fmtChf(todayNet)}`}
                sub={todayPct !== null ? `${fmtPct(todayPct)} vom Umsatz` : 'Kein Umsatz'}
                sub2={isCurrentMonth ? undefined : undefined}
                icon={ShoppingCart}
                variant={todayNet === 0 ? 'muted' : kpiVariant(todayPct)}
              />
              <KpiBox
                label="Warenkosten heute %"
                value={todayPct !== null ? fmtPct(todayPct) : '–'}
                sub={todayRevenue > 0 ? `Umsatz CHF ${fmtChf(todayRevenue)}` : 'Kein Umsatz'}
                icon={TrendingUp}
                variant={kpiVariant(todayPct)}
              />
              <KpiBox
                label="Warenkosten Monat"
                value={`CHF ${fmtChf(monthTotals.totalNet)}`}
                sub={`${stats.entryCount} Einträge (exkl. MWST) · Konten 4000–${warenGrenze}`}
                sub2={monthBetrieb > 0 ? `Betriebskosten (≥ ${warenGrenze + 1}): CHF ${fmtChf(monthBetrieb)}` : undefined}
                icon={Package}
                variant={monthTotals.totalNet > 0 ? 'default' : 'muted'}
              />
              <KpiBox
                label="Warenkosten Monat %"
                value={monthPct !== null ? fmtPct(monthPct) : '–'}
                sub={monthPct !== null ? `Ziel ≤ 30 %` : 'Kein Umsatz'}
                sub2={monthPct !== null && monthPct <= 30 ? '✓ Im Zielbereich' : monthPct !== null ? '↑ Über Ziel' : undefined}
                icon={TrendingUp}
                variant={kpiVariant(monthPct)}
              />
              <KpiBox
                label="Kum. Umsatz Monat"
                value={totalRevenue > 0 ? `CHF ${fmtChf(totalRevenue)}` : '–'}
                sub={totalRevenue === 0 ? 'Keine Umsatzdaten' : `${Object.keys(revenueByDate).length} Tage`}
                icon={TrendingUp}
                variant={totalRevenue > 0 ? 'default' : 'muted'}
              />
              <KpiBox
                label="Lieferanten aktiv"
                value={String(suppliersWithEntries)}
                sub={`von ${activeSuppliers.length} verfügbar`}
                icon={CheckCircle2}
                variant={suppliersWithEntries > 0 ? 'ok' : 'muted'}
              />
            </div>

            {/* ── Tab: Erfassung ────────────────────────────────────────── */}
            {tab === 'erfassung' && (
              <div className="space-y-5">

                {/* Schnellerfassung – nur für Benutzer mit Erfassungsrecht */}
                {!canCreate && (
                  <div className="flex items-center gap-2.5 text-xs text-muted-foreground bg-muted/30 border border-border rounded-lg px-4 py-3">
                    <ShieldCheck className="h-4 w-4 flex-shrink-0" />
                    <span>Lesezugriff – Erfassen, Bearbeiten und Löschen ist für diese Rolle nicht erlaubt.</span>
                  </div>
                )}
                {canCreate && (
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
                    <Plus className="h-4 w-4" style={{ color: tenant.color }} />
                    <h2 className="text-sm font-semibold">Neue Rechnung erfassen</h2>
                  </div>
                  <div className="px-5 py-4 space-y-4">

                    {/* ── CSV-Positionsimport (Transgourmet/Prodega) mit Preisüberwachung ── */}
                    <WarenCsvImport tenantId={tenantId} suppliers={suppliers}
                      onImported={() => { void loadData(); void ladePreisHinweise(); }} />

                    {/* ── Feldschlösschen PDF-Import (Lieferscheine · Monatsrechnung · Historie) ── */}
                    <FeldschloesschenImport tenantId={tenantId} suppliers={suppliers}
                      onImported={() => { void loadData(); void ladePreisHinweise(); }} />

                    {/* ── Lieferanten-PDF-Import über MWST-Nr-Profile (nur Beaulieu) ── */}
                    {tenantId === 'beaulieu' && (
                      <BeaulieuPdfImport tenantId={tenantId}
                        onImported={() => { void loadData(); void ladePreisHinweise(); }} />
                    )}

                    {/* ── PDF-Erkennung: Rechnung hochladen → Felder vorfüllen ── */}
                    <div className="flex flex-wrap items-center gap-3">
                      <label className={cn(
                        'inline-flex items-center gap-2 text-xs font-medium rounded-lg border border-dashed px-3 py-2 cursor-pointer transition-colors',
                        pdfBusy ? 'opacity-60 pointer-events-none' : 'hover:bg-muted/40',
                      )}>
                        {pdfBusy
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <ScanSearch className="h-4 w-4" style={{ color: tenant.color }} />}
                        {pdfBusy ? 'PDF wird gelesen…' : 'PDF-Rechnung erkennen (Lieferant, Datum, Betrag)'}
                        <input
                          type="file" accept="application/pdf" multiple className="hidden"
                          data-testid="input-pdf-erkennung"
                          disabled={pdfBusy}
                          onChange={e => { handlePdfErkennungFiles(e.target.files); e.target.value = ''; }}
                        />
                      </label>
                      {pdfQueue.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">
                          Stapel: noch {pdfQueue.length} PDF{pdfQueue.length > 1 ? 's' : ''} in der Warteschlange
                        </span>
                      )}
                    </div>

                    {/* Vorschau der erkannten Werte — nie blind speichern */}
                    {erkennung && (
                      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs space-y-1.5" data-testid="pdf-erkennung-vorschau">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium flex items-center gap-1.5">
                            <Paperclip className="h-3.5 w-3.5" />
                            {erkennung.fileName}
                            {!erkennung.textLayer && !erkennung.ocrFehler && (
                              <Badge variant="outline" className="text-[10px]">per OCR gelesen</Badge>
                            )}
                          </span>
                          <button type="button" className="text-muted-foreground hover:text-foreground"
                            onClick={() => resetErkennung()} title="Erkennung verwerfen">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {erkennung.ocrFehler ? (
                          <p className="text-amber-600 dark:text-amber-400">
                            Keine automatische Erkennung möglich — bitte Felder manuell ausfüllen. Das PDF wird beim Speichern als Beleg angehängt.
                          </p>
                        ) : (
                          <p className="flex flex-wrap gap-x-4 gap-y-1">
                            <span className={form.supplierName ? '' : 'text-amber-600 dark:text-amber-400'}>
                              Lieferant: {form.supplierName || (erkennung.supplierRaw ? `«${erkennung.supplierRaw}» — bitte zuordnen` : 'nicht erkannt — bitte wählen')}
                              {erkennung.supplierMatched && <Check className="inline h-3 w-3 ml-0.5 text-emerald-600" />}
                            </span>
                            <span className={erkennung.felder.dateSicher ? '' : 'text-amber-600 dark:text-amber-400'}>
                              Datum: {erkennung.felder.date ?? '—'}{!erkennung.felder.dateSicher && erkennung.felder.date ? ' (unsicher)' : ''}
                            </span>
                            <span className={erkennung.felder.amountSicher ? '' : 'text-amber-600 dark:text-amber-400'}>
                              Betrag: {erkennung.felder.amount !== null ? `CHF ${fmtChf(erkennung.felder.amount)} brutto` : '—'}
                              {!erkennung.felder.amountSicher && erkennung.felder.amount !== null ? ' (unsicher)' : ''}
                            </span>
                            <span>MWST: {erkennung.felder.vatRate !== null ? `${erkennung.felder.vatRate} %` : '—'}</span>
                            {erkennung.felder.reference && <span>Ref.: {erkennung.felder.reference}</span>}
                          </p>
                        )}
                        {/* Alias nur mit expliziter Zustimmung lernen */}
                        {!erkennung.supplierMatched && erkennung.supplierRaw && !erkennung.ocrFehler && (
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={aliasLernen}
                              onChange={e => setAliasLernen(e.target.checked)}
                              data-testid="checkbox-alias-lernen"
                            />
                            <span>
                              «{erkennung.supplierRaw}» künftig automatisch dem unten gewählten Lieferanten zuordnen (Alias speichern)
                            </span>
                          </label>
                        )}
                        <p className="text-muted-foreground">
                          Werte prüfen/korrigieren und wie gewohnt speichern — das Konto setzt du selbst (Vorschlag = Standard des Lieferanten).
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-10 gap-3 items-end">

                      {/* Datum */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Datum</Label>
                        <Input
                          type="date"
                          value={form.date}
                          max={ymdLocal(today)}
                          onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>

                      {/* Lieferant – suchbares Dropdown, zuletzt genutzte zuoberst */}
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">Lieferant</Label>
                        <Popover open={supplierPickerOpen} onOpenChange={setSupplierPickerOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline" role="combobox"
                              data-testid="button-supplier-picker"
                              className="h-9 w-full justify-between text-sm font-normal"
                            >
                              <span className={form.supplierName ? '' : 'text-muted-foreground'}>
                                {form.supplierName || 'Lieferant wählen…'}
                              </span>
                              <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[280px] p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Lieferant suchen…" />
                              <CommandList>
                                <CommandEmpty>Kein Lieferant gefunden.</CommandEmpty>
                                {recentSupplierOptions.length > 0 && (
                                  <CommandGroup heading="Zuletzt genutzt">
                                    {recentSupplierOptions.map(s => (
                                      <CommandItem key={`r-${s.id}`} value={`r ${s.name}`} onSelect={() => handlePickSupplier(s)}>
                                        <Check className={cn('mr-2 h-3.5 w-3.5', form.supplierName === s.name ? 'opacity-100' : 'opacity-0')} />
                                        {s.name}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                )}
                                <CommandGroup heading="Alle Lieferanten">
                                  {activeSuppliers.map(s => (
                                    <CommandItem key={s.id} value={s.name} onSelect={() => handlePickSupplier(s)}>
                                      <Check className={cn('mr-2 h-3.5 w-3.5', form.supplierName === s.name ? 'opacity-100' : 'opacity-0')} />
                                      {s.name}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>

                      {/* Warenkonto (Pflichtfeld) – füllt sich via Lieferanten-Vorgabe */}
                      {!form.splitEnabled && (
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">
                          Konto <span className="text-destructive">*</span>
                        </Label>
                        <Select value={form.warenkonto} onValueChange={v => setForm(f => ({ ...f, warenkonto: v, kategorie: kontoKategorie(v, warenkonten) }))}>
                          <SelectTrigger className="h-9 text-sm" data-testid="select-warenkonto">
                            <SelectValue placeholder="Konto wählen…" />
                          </SelectTrigger>
                          <SelectContent>
                            {warenkonten.map(k => (
                              <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      )}

                      {/* Betrag – nur wenn kein Split */}
                      {!form.splitEnabled && (
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Betrag (CHF)</Label>
                        <Input
                          type="number" step="0.01" min="0" placeholder="0.00"
                          value={form.amount}
                          ref={amountInputRef}
                          data-testid="input-amount"
                          onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                          className="h-9 text-sm"
                          onKeyDown={e => e.key === 'Enter' && handleSave()}
                        />
                      </div>
                      )}

                      {/* MWST Toggle */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">MWST</Label>
                        <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs font-medium">
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, vatIncluded: true }))}
                            className={cn(
                              'flex-1 transition-colors',
                              form.vatIncluded ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >inkl.</button>
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, vatIncluded: false }))}
                            className={cn(
                              'flex-1 transition-colors border-l border-border',
                              !form.vatIncluded ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >exkl.</button>
                        </div>
                      </div>

                      {/* Satz */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Satz</Label>
                        <Select value={form.vatRate} onValueChange={v => setForm(f => ({ ...f, vatRate: v }))}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VAT_RATES.map(r => (
                              <SelectItem key={r} value={r}>{r === '0' ? '0 % (befreit)' : `${r} %`}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Speichern */}
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs">&nbsp;</Label>
                        <Button
                          onClick={handleSave}
                          disabled={
                            saving || !form.supplierName ||
                            (form.splitEnabled
                              ? form.splits.some(s => !s.konto || !s.amount)
                              : !form.amount)
                          }
                          className="h-9 w-full gap-1.5 font-semibold"
                          style={{ backgroundColor: tenant.color }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {saving ? 'Speichern…' : 'Speichern'}
                        </Button>
                      </div>
                    </div>

    {/* ── Details (Sekundärfelder) einklappbar ──────────────────────────── */}
                    <button
                      type="button"
                      data-testid="button-toggle-details"
                      onClick={() => setShowDetails(v => !v)}
                      className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showDetails && 'rotate-180')} />
                      Details {showDetails ? 'ausblenden' : '(Kategorie, Split, Referenz, Beleg …)'}
                      {(form.splitEnabled || form.reference || form.note || receiptFile) && !showDetails && (
                        <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">aktiv</Badge>
                      )}
                    </button>
                    {showDetails && (
                    <div className="flex flex-wrap items-end gap-3 pt-1">

                      {/* Kategorie (Pflichtfeld) */}
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">
                          Kategorie <span className="text-destructive">*</span>
                        </Label>
                        <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs font-medium">
                          {WARE_KATEGORIEN.map(k => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setForm(f => ({ ...f, kategorie: k }))}
                              className={cn(
                                'px-3 transition-colors border-l border-border first:border-l-0',
                                form.kategorie === k
                                  ? k === 'Food' ? 'bg-emerald-600 text-white'
                                    : k === 'Beverage' ? 'bg-blue-600 text-white'
                                    : 'bg-foreground text-background'
                                  : 'text-muted-foreground hover:bg-muted',
                              )}
                            >{k}</button>
                          ))}
                        </div>
                      </div>

                      {/* Split-Toggle */}
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Kontozuweisung</Label>
                        <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs font-medium">
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, splitEnabled: false }))}
                            className={cn(
                              'px-3 transition-colors',
                              !form.splitEnabled ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >1 Konto</button>
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, splitEnabled: true, amount: '' }))}
                            className={cn(
                              'px-3 transition-colors border-l border-border',
                              form.splitEnabled ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >Split (mehrere Konten)</button>
                        </div>
                      </div>

                      {/* Split-Felder: beliebig viele Zeilen (Konto + Betrag) */}
                      {form.splitEnabled && (
                        <div className="space-y-2 flex-1 basis-full">
                          {form.splits.map((s, i) => {
                            const klasse = s.konto ? kontoKlasse(s.konto, warenGrenze) : null;
                            return (
                            <div key={i} className="flex flex-wrap items-end gap-3" data-testid={`split-row-${i}`}>
                              <div className="space-y-1 min-w-[200px]">
                                <Label className="text-xs text-muted-foreground">Konto {i + 1}</Label>
                                <Select value={s.konto} onValueChange={v => setForm(f => ({
                                  ...f, splits: f.splits.map((x, j) => j === i ? { ...x, konto: v } : x),
                                }))}>
                                  <SelectTrigger className="h-9 text-sm" data-testid={`select-split-konto-${i}`}><SelectValue placeholder="Konto wählen…" /></SelectTrigger>
                                  <SelectContent>
                                    {warenkonten.map(k => (
                                      <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1 w-[130px]">
                                <Label className="text-xs text-muted-foreground">Betrag (CHF)</Label>
                                <Input
                                  type="number" step="0.01" min="0" placeholder="0.00"
                                  value={s.amount}
                                  data-testid={`input-split-amount-${i}`}
                                  onChange={e => setForm(f => ({
                                    ...f, splits: f.splits.map((x, j) => j === i ? { ...x, amount: e.target.value } : x),
                                  }))}
                                  className="h-9 text-sm"
                                />
                              </div>
                              {/* Klassen-Hinweis: Warenkosten (WKQ) vs. Betriebskosten */}
                              {klasse && (
                                <Badge variant="secondary" className={cn('h-6 text-[10px]',
                                  klasse === 'warenkosten' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
                                  {kontoKlasseLabel(klasse)}
                                </Badge>
                              )}
                              {form.splits.length > 2 && (
                                <button
                                  type="button"
                                  className="h-9 px-2 rounded-md border border-border text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
                                  title="Split-Zeile entfernen"
                                  data-testid={`button-remove-split-${i}`}
                                  onClick={() => setForm(f => ({ ...f, splits: f.splits.filter((_, j) => j !== i) }))}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          ); })}
                          <button
                            type="button"
                            data-testid="button-add-split-row"
                            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => setForm(f => ({ ...f, splits: [...f.splits, { konto: '', amount: '' }] }))}
                          >
                            <Plus className="h-3.5 w-3.5" /> Weitere Split-Zeile
                          </button>
                          <p className="text-[11px] text-muted-foreground">
                            Der Rechnungsbetrag ist die Summe der Split-Zeilen (siehe Live-Berechnung unten) — MWST gilt auf Rechnungsebene.
                          </p>
                        </div>
                      )}
                    </div>
                    )} {/* end showDetails (Kategorie/Split) */}

                    {/* Live-Berechnung */}
                    {liveAmounts && (
                      <div className="flex items-center gap-5 text-xs bg-muted/40 rounded-lg px-4 py-2 border border-border/50">
                        <span className="text-muted-foreground">Netto:</span>
                        <strong className="text-foreground tabular-nums">CHF {fmtChf(liveAmounts.amountNet)}</strong>
                        <span className="text-muted-foreground/40">|</span>
                        <span className="text-muted-foreground">Brutto:</span>
                        <strong className="text-foreground tabular-nums">CHF {fmtChf(liveAmounts.amountGross)}</strong>
                        <span className="text-muted-foreground/50 ml-auto">MWST {form.vatRate} %</span>
                      </div>
                    )}

                    {/* Optionale Felder (Details) */}
                    {showDetails && (<>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Rechnungs-/Lieferscheinnummer</Label>
                        <Input
                          placeholder="z.B. LS-2025-0412"
                          value={form.reference}
                          onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Bemerkung</Label>
                        <Input
                          placeholder="z.B. Wochenlieferung"
                          value={form.note}
                          onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                    {/* Optionaler Beleg/Screenshot */}
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Beleg / Screenshot (optional, JPEG/PNG/WebP/PDF, max. 10 MB)</Label>
                      <input
                        type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                        data-testid="input-receipt-file"
                        className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
                        onChange={e => setReceiptFile(e.target.files?.[0] ?? null)}
                        // key erzwingt Reset des nativen Inputs nach dem Speichern
                        key={receiptInputKey}
                      />
                    </div>
                    </>)} {/* end showDetails (Sekundärfelder) */}
                  </div>
                </section>
                )} {/* end canCreate */}

                {/* Letzte Einträge */}
                {entries.length === 0 ? (
                  <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center">
                    <ShoppingCart className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">Noch keine Einträge für {monthLabel}</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">Erfasse oben deine erste Warenrechnung.</p>
                  </div>
                ) : (
                  <section className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                      <h2 className="text-sm font-semibold">Einträge {monthLabel}</h2>
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Lieferanten-Filter Dropdown */}
                        <div className="flex items-center gap-1.5">
                          <Filter className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <select
                            value={erfassungSupplierFilter}
                            onChange={e => setErfassungSupplierFilter(e.target.value)}
                            className="h-7 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring min-w-[140px]"
                          >
                            <option value="">Alle Lieferanten</option>
                            {entrySupplierNames.map(name => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                          {erfassungSupplierFilter && (
                            <button
                              onClick={() => setErfassungSupplierFilter('')}
                              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                              title="Filter zurücksetzen"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {erfassungSupplierFilter
                            ? `${filteredEntries.length} von ${entries.length} Einträgen · CHF ${fmtChf(filteredTotalNet)} netto`
                            : `${entries.length} Einträge · CHF ${fmtChf(stats.totalNet)} netto`}
                        </span>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                            <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                            <th className="px-4 py-2.5 text-left font-medium">Lieferant</th>
                            <th className="px-4 py-2.5 text-left font-medium w-[110px]">Kategorie</th>
                            <th className="px-4 py-2.5 text-right font-medium">Netto CHF</th>
                            <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto CHF</th>
                            <th className="px-4 py-2.5 text-center font-medium w-[70px]">MWST</th>
                            <th className="px-4 py-2.5 text-left font-medium w-[160px]">Warenkonto</th>
                            <th className="px-4 py-2.5 text-left font-medium">Referenz</th>
                            <th className="px-4 py-2.5 text-left font-medium">Bemerkung</th>
                            <th className="px-4 py-2.5 w-[88px]"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredEntries.map((e, i) => (
                            <tr key={e.id} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10')}>
                              <td className="px-4 py-2.5 text-sm text-muted-foreground">{formatDateLong(e.date)}</td>
                              <td className="px-4 py-2.5 font-medium">{e.supplierName}</td>
                              <td className="px-4 py-2.5">
                                {(() => {
                                  // Explizite Kategorie hat Vorrang, dann Konto-Kategorie (Stammdaten vor Heuristik)
                                  const kat: WarenKategorie = e.kategorie ?? kontoKategorie(e.warenkonto ?? '', warenkonten);
                                  return (
                                    <span className={cn(
                                      'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                      kat === 'Food'     ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                                      : kat === 'Beverage' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                      : 'bg-muted text-muted-foreground',
                                    )}>{kat}</span>
                                  );
                                })()}
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(e.amountNet)}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(e.amountGross)}</td>
                              <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">{e.vatRate} %</td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                                {e.kontoSplits && e.kontoSplits.length > 0 ? (
                                  <div className="flex flex-col gap-0.5">
                                    {e.kontoSplits.map((s, si) => (
                                      <span key={si} className="inline-flex items-center gap-1">
                                        <span className="font-mono font-semibold text-foreground/80">{s.warenkonto}</span>
                                        <span className="text-muted-foreground/60">CHF {fmtChf(s.amountNet)}</span>
                                      </span>
                                    ))}
                                  </div>
                                ) : e.warenkonto ? (
                                  <span className="font-mono font-semibold text-foreground/80">{e.warenkonto}</span>
                                ) : (
                                  <span className="opacity-30">–</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1.5">
                                  {e.reference ?? (!e.receiptPath && <span className="opacity-30">–</span>)}
                                  {e.quelle === 'monatsrechnung' && (
                                    <span className="inline-flex items-center rounded-full border border-amber-400/50 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-400"
                                      title="Aus der Monatsrechnung übernommen (provisorisch) — der echte Lieferschein ersetzt diesen Eintrag beim Import."
                                      data-testid={`badge-monatsrechnung-${e.id}`}>
                                      aus Monatsrechnung
                                    </span>
                                  )}
                                  {(preisHinweise[e.id]?.length ?? 0) > 0 && (
                                    <span
                                      className={cn('inline-flex items-center gap-0.5 cursor-help',
                                        preisHinweise[e.id].some(a => a.stark && a.erhoehung)
                                          ? 'text-red-600 dark:text-red-400'
                                          : preisHinweise[e.id].some(a => a.stark)
                                            ? 'text-amber-600 dark:text-amber-400'
                                            : 'text-muted-foreground')}
                                      title={preisHinweise[e.id].map(a =>
                                        `${a.artikel}: CHF ${fmtChf(a.alt)} → CHF ${fmtChf(a.neu)}`
                                        + `${a.diffPct !== null ? ` (${a.diffPct > 0 ? '+' : ''}${a.diffPct.toFixed(1)} %)` : ''}`
                                        + ` · seit ${fmtDatumCH(a.seit)}`).join('\n')}
                                      data-testid={`preis-hinweis-${e.id}`}
                                    >
                                      <AlertTriangle className="h-3 w-3" />
                                      <span className="text-[10px] tabular-nums">{preisHinweise[e.id].length}</span>
                                    </span>
                                  )}
                                  {(rechnungsPositionen[e.id]?.length ?? 0) > 0 && (
                                    <button
                                      type="button"
                                      title={`${rechnungsPositionen[e.id].length} Positionen mit Konto anzeigen`}
                                      data-testid={`positionen-open-${e.id}`}
                                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                                      onClick={() => setPositionenDialog({ invoiceId: e.id, positionen: rechnungsPositionen[e.id].map(p => ({ ...p })) })}
                                    >
                                      <ClipboardList className="h-3 w-3" /> {rechnungsPositionen[e.id].length} Pos.
                                    </button>
                                  )}
                                  {e.receiptPath && (
                                    <button
                                      type="button" title="Beleg öffnen" data-testid={`receipt-open-${e.id}`}
                                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                                      onClick={() => openReceipt(e.receiptPath!)}
                                    >
                                      <Paperclip className="h-3 w-3" /> Beleg
                                    </button>
                                  )}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[140px] truncate">{e.note ?? <span className="opacity-30">–</span>}</td>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-1">
                                  {canEdit && (
                                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => { setEditEntry(e); setEditReceiptFile(null); setShowEditDialog(true); }}>
                                    <Pencil className="h-3 w-3" />
                                    Edit
                                  </Button>
                                  )}
                                  {canDelete && (deleteConfirm === e.id ? (
                                    <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => handleDelete(e)}>
                                      Löschen?
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive/50 hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteConfirm(e.id)}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  ))}
                                  {!canEdit && !canDelete && (
                                    <span className="text-[10px] text-muted-foreground/40 px-1">Lesezugriff</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-border bg-muted/20 font-bold">
                            <td className="px-4 py-2.5 text-xs text-muted-foreground uppercase tracking-wide" colSpan={2}>
                              {erfassungSupplierFilter ? erfassungSupplierFilter : 'Total'}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums font-bold">CHF {fmtChf(erfassungSupplierFilter ? filteredTotalNet : stats.totalNet)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(erfassungSupplierFilter ? filteredTotalGross : stats.totalGross)}</td>
                            <td colSpan={4} className="px-4 py-2.5 text-right">
                              {!erfassungSupplierFilter && monthPct !== null && <PctBadge pct={monthPct} />}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* ── Tab: Analyse ──────────────────────────────────────────── */}
            {tab === 'analyse' && (
              <div className="space-y-5">

                {/* ── Zeitraum-Auswahl ─────────────────────────────────────── */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="flex flex-wrap gap-1 p-2 border-b border-border bg-muted/20">
                    {([
                      ['week',        'Woche'],
                      ['month',       'Monat'],
                      ['multi_month', 'Mehrere Monate'],
                      ['year',        'Jahr'],
                      ['ytd',         'YTD'],
                    ] as [AnalyseMode, string][]).map(([m, label]) => (
                      <button
                        key={m}
                        onClick={() => setAnalyseMode(m)}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                          analyseMode === m
                            ? 'bg-foreground text-background shadow-sm'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    <div className="ml-auto flex items-center gap-3">
                      {canExport && (
                        <button
                          onClick={handleWarenkostenExport}
                          disabled={rangeLoading || analysisEntries.length === 0}
                          title="Warenkosten des Zeitraums als Excel exportieren"
                          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium border border-border bg-background hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Excel-Export
                        </button>
                      )}
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground pr-1">
                        <span>Ziel</span>
                        <input
                          type="number" min={0} max={100} step={1} value={targetPct}
                          onChange={e => setTargetPct(Number(e.target.value))}
                          className="w-14 h-7 rounded-md border border-border bg-background px-2 text-center text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <span>%</span>
                      </div>
                    </div>
                  </div>

                  {/* Range Picker */}
                  <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                    {analyseMode === 'week' && (
                      <>
                        <button onClick={prevAWeek} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="font-semibold text-sm min-w-[140px] text-center">{analyseRangeLabel}</span>
                        <button onClick={nextAWeek} disabled={isCurrentAWeek} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                      </>
                    )}
                    {analyseMode === 'month' && (
                      <>
                        <button onClick={prevAMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="font-semibold text-sm min-w-[140px] text-center">{analyseRangeLabel}</span>
                        <button onClick={nextAMonth} disabled={isCurrentAMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                      </>
                    )}
                    {analyseMode === 'multi_month' && (
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="text-muted-foreground text-xs">Von</span>
                        <select value={aFromMonth} onChange={e => setAFromMonth(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          {MONTHS_LONG.map((ml, i) => <option key={i+1} value={i+1}>{ml}</option>)}
                        </select>
                        <select value={aFromYear} onChange={e => setAFromYear(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm w-[80px] focus:outline-none focus:ring-1 focus:ring-ring">
                          {[today.getFullYear()-2, today.getFullYear()-1, today.getFullYear()].map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                        <span className="text-muted-foreground text-xs">Bis</span>
                        <select value={aToMonth} onChange={e => setAToMonth(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          {MONTHS_LONG.map((ml, i) => <option key={i+1} value={i+1}>{ml}</option>)}
                        </select>
                        <select value={aToYear} onChange={e => setAToYear(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm w-[80px] focus:outline-none focus:ring-1 focus:ring-ring">
                          {[today.getFullYear()-2, today.getFullYear()-1, today.getFullYear()].map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                      </div>
                    )}
                    {(analyseMode === 'year' || analyseMode === 'ytd') && (
                      <>
                        {analyseMode === 'year' && (
                          <>
                            <button onClick={() => setARangeYear(y => y - 1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                            <span className="font-semibold text-sm min-w-[80px] text-center">{aRangeYear}</span>
                            <button onClick={() => setARangeYear(y => y + 1)} disabled={aRangeYear >= today.getFullYear()} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                          </>
                        )}
                        {analyseMode === 'ytd' && (
                          <>
                            <button onClick={() => setARangeYear(y => y - 1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                            <span className="font-semibold text-sm min-w-[80px] text-center">{analyseRangeLabel}</span>
                            <button onClick={() => setARangeYear(y => y + 1)} disabled={aRangeYear >= today.getFullYear()} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* ── Forecast Zusatzumsatz ────────────────────────────────── */}
                <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                  {/* Header */}
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm font-semibold text-foreground">Erwarteter Zusatzumsatz bis Ende {analyseMode === 'week' ? 'Woche' : analyseMode === 'month' ? 'Monat' : analyseMode === 'year' ? 'Jahr' : 'Zeitraum'}</span>
                    {forecastRev > 0 && (
                      <button
                        onClick={() => updateForecastRev(forecastKey, 0)}
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground underline flex-shrink-0"
                      >zurücksetzen</button>
                    )}
                  </div>

                  {/* Eingabe-Zeile */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* +/- Steuerung */}
                    <div className="flex items-center border border-border rounded-lg overflow-hidden bg-background h-9">
                      <button
                        onClick={() => updateForecastRev(forecastKey, forecastRev - 1000)}
                        className="h-9 w-9 flex items-center justify-center hover:bg-muted transition-colors border-r border-border"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="text-xs text-muted-foreground px-2 select-none">+ CHF</span>
                      <input
                        type="number"
                        step="1000"
                        min="0"
                        value={forecastRev === 0 ? '' : forecastRev}
                        placeholder="0"
                        onChange={e => {
                          const v = Number(e.target.value);
                          if (!isNaN(v) && v >= 0) updateForecastRev(forecastKey, v);
                          else if (e.target.value === '') updateForecastRev(forecastKey, 0);
                        }}
                        className="w-28 h-9 text-sm font-semibold tabular-nums text-center bg-transparent border-none focus:outline-none"
                      />
                      <button
                        onClick={() => updateForecastRev(forecastKey, forecastRev + 1000)}
                        className="h-9 w-9 flex items-center justify-center hover:bg-muted transition-colors border-l border-border"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Schnellwahl */}
                    <div className="flex gap-1.5 flex-wrap">
                      {forecastQuickValues.map(v => (
                        <button
                          key={v}
                          onClick={() => updateForecastRev(forecastKey, v)}
                          className={cn(
                            'h-8 px-2.5 rounded-md text-xs font-medium border transition-colors tabular-nums',
                            forecastRev === v
                              ? 'bg-foreground text-background border-foreground'
                              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40',
                          )}
                        >
                          +{v >= 1000 ? `${(v / 1000 % 1 === 0 ? (v / 1000).toFixed(0) : (v / 1000).toFixed(1))}k` : v}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Aufschlüsselung + Ergebnis (nur wenn Zusatz eingegeben) */}
                  {forecastRev > 0 && (
                    <div className="flex items-start gap-4 flex-wrap pt-1 border-t border-border/50">
                      {/* Rechenweg */}
                      <div className="text-xs text-muted-foreground space-y-1 tabular-nums min-w-[220px]">
                        <div className="flex justify-between gap-6">
                          <span>Aktueller Umsatz</span>
                          <span className="font-medium text-foreground">CHF {fmtChf(analyseKPIs.totalRev)}</span>
                        </div>
                        <div className="flex justify-between gap-6">
                          <span>+ Erwarteter Zusatz</span>
                          <span className="font-medium text-foreground">CHF {fmtChf(forecastRev)}</span>
                        </div>
                        <div className="flex justify-between gap-6 border-t border-border/50 pt-1">
                          <span className="font-semibold text-foreground">= Forecast Gesamtumsatz</span>
                          <span className="font-bold text-foreground">CHF {fmtChf(forecastTotal)}</span>
                        </div>
                      </div>

                      {/* Forecast % Badge */}
                      {forecastPct !== null && (
                        <div className={cn(
                          'ml-auto flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold border self-end',
                          forecastPct > targetPct + 2
                            ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/20 dark:text-red-400 dark:border-red-800'
                            : forecastPct > targetPct
                            ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400 dark:border-amber-800'
                            : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-800',
                        )}>
                          <TrendingUp className="h-3.5 w-3.5 flex-shrink-0" />
                          <span>Forecast {fmtPct(forecastPct)}</span>
                          <span className="text-xs font-normal opacity-70">
                            {forecastPct <= targetPct ? '✓ Im Ziel' : '↑ Über Ziel'}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {forecastRev === 0 && (
                    <p className="text-xs text-muted-foreground opacity-70">
                      Noch erwarteten Zusatzumsatz eingeben — das System rechnet ihn auf den aktuellen Umsatz drauf und berechnet die Forecast-Quote.
                    </p>
                  )}
                </div>

                {/* ── Anomalie-Analyse (Lieferant/Konto/Woche/Monat) ───────── */}
                {!rangeLoading && (
                  <WarenAnalyseBlock
                    entries={applyAliasGruppen(analysisEntries, aliasGruppen)}
                    revenueByDate={analysisRevenue}
                    konten={warenkonten}
                    zielPct={zielWkqPct}
                    periodLabel={analyseRangeLabel}
                    warenGrenze={warenGrenze}
                    onOpenReceipt={openReceipt}
                  />
                )}

                {/* ── KPI-Karten ──────────────────────────────────────────── */}
                {!rangeLoading && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    <KpiBox
                      label="Umsatz (Zeitraum)" Icon={TrendingUp}
                      value={analyseKPIs.totalRev > 0 ? `CHF ${fmtChf(analyseKPIs.totalRev)}` : '–'}
                      variant="default"
                    />
                    <KpiBox
                      label="Warenkosten netto" Icon={ShoppingCart}
                      value={analyseKPIs.totalCost > 0 ? `CHF ${fmtChf(analyseKPIs.totalCost)}` : '–'}
                      variant="default"
                      sub={analyseKPIs.totalCost > 0 ? `davon relevant (Food+Bev): CHF ${fmtChf(analyseKPIs.relevantCost)}` : undefined}
                      sub2={analyseKPIs.betriebCost > 0
                        ? `Betriebskosten (≥ ${warenGrenze + 1}): CHF ${fmtChf(analyseKPIs.betriebCost)} · nicht in Quote`
                        : analyseKPIs.sonstigeCost > 0 ? `Sonstiges: CHF ${fmtChf(analyseKPIs.sonstigeCost)} · nicht in Quote` : undefined}
                    />
                    <KpiBox
                      label="Warenkosten % · Stand aktuell" Icon={BarChart3}
                      value={analyseKPIs.pct !== null ? fmtPct(analyseKPIs.pct) : '–'}
                      variant={analyseKPIs.pct === null ? 'muted' : analyseKPIs.pct > targetPct + 2 ? 'alert' : analyseKPIs.pct > targetPct ? 'warn' : 'ok'}
                      sub={analyseKPIs.pct !== null ? `Ziel: ${targetPct} %` : 'Kein Umsatz'}
                      sub2={forecastPct !== null ? `Forecast Endwert: ${fmtPct(forecastPct)}` : undefined}
                    />
                    <KpiBox
                      label="Lieferanten aktiv" Icon={Package}
                      value={String(analyseSuppliers.length)}
                      sub={analyseSuppliers.length > 0 ? analyseSuppliers[0].name : '–'}
                      variant="default"
                    />
                  </div>
                )}

                {/* ── Warenkosten vs. Erfolgsrechnung (FIBU-Abgleich) ──────── */}
                {!rangeLoading && (
                  <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <BarChart3 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm font-semibold text-foreground">Warenkosten vs. Erfolgsrechnung</span>
                      <InfoTip
                        text={
                          <span>
                            <b>Berechnete Quote</b> = relevante Warenkosten (Food&nbsp;+&nbsp;Beverage) ÷ Umsatz.
                            «Sonstiges» ist bewusst ausgeschlossen. Zum Abgleich werden die berechneten Werte dem
                            FIBU-Warenaufwand der Erfolgsrechnung (Konten Küche + Getränke) gegenübergestellt.
                            Beide Quoten nutzen dieselbe Umsatzbasis (Betriebsertrag netto der Erfolgsrechnung),
                            damit die Differenz die Kostenabweichung misst – nicht eine Umsatzverzerrung.
                          </span>
                        }
                      />
                      {erVergleich.monthAligned && erVergleich.hasEr && (
                        <StatusPill tone={ER_STATUS_TONE[erVergleich.status]} className="ml-auto">
                          {erVergleichStatusLabel(erVergleich.status)}
                        </StatusPill>
                      )}
                    </div>

                    {!erVergleich.monthAligned ? (
                      <HintBox
                        tone="neutral"
                        title="Abgleich nur für ganze Monate"
                      >
                        Der FIBU-Abgleich vergleicht immer vollständige Kalendermonate. Für Wochen, den laufenden (Teil-)Monat oder YTD ist er nicht aussagekräftig – wähle einen abgeschlossenen Monat oder mehrere ganze Monate (bis zum Vormonat).
                      </HintBox>
                    ) : !erVergleich.hasEr ? (
                      <HintBox
                        tone="info"
                        title="Keine Erfolgsrechnung importiert"
                        action={
                          <Link to="/reporting" className="font-medium underline whitespace-nowrap">
                            Erfolgsrechnung importieren →
                          </Link>
                        }
                      >
                        Für diesen Zeitraum liegen keine FIBU-Werte vor – die berechnete Warenkostenquote kann nicht gegengeprüft werden.
                      </HintBox>
                    ) : (
                      <div className="space-y-2">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-muted-foreground">
                                <th className="text-left font-medium py-1 pr-2"> </th>
                                <th className="text-right font-medium py-1 px-2">Food</th>
                                <th className="text-right font-medium py-1 px-2">Beverage</th>
                                <th className="text-right font-medium py-1 px-2">Total relevant</th>
                                <th className="text-right font-medium py-1 pl-2">Quote</th>
                              </tr>
                            </thead>
                            <tbody className="tabular-nums">
                              <tr className="border-t border-border/60">
                                <td className="py-1.5 pr-2 text-muted-foreground">Berechnet (operativ)</td>
                                <td className="text-right px-2">CHF {fmtChf(erVergleich.calcFood)}</td>
                                <td className="text-right px-2">CHF {fmtChf(erVergleich.calcBev)}</td>
                                <td className="text-right px-2 font-semibold">CHF {fmtChf(erVergleich.calcTotal)}</td>
                                <td className="text-right pl-2 font-semibold">{erVergleich.calcQuote !== null ? fmtPct(erVergleich.calcQuote) : '–'}</td>
                              </tr>
                              <tr className="border-t border-border/60">
                                <td className="py-1.5 pr-2 text-muted-foreground">Erfolgsrechnung (FIBU)</td>
                                <td className="text-right px-2">CHF {fmtChf(erVergleich.erFood)}</td>
                                <td className="text-right px-2">CHF {fmtChf(erVergleich.erBev)}</td>
                                <td className="text-right px-2 font-semibold">CHF {fmtChf(erVergleich.erTotal)}</td>
                                <td className="text-right pl-2 font-semibold">{erVergleich.erQuote !== null ? fmtPct(erVergleich.erQuote) : '–'}</td>
                              </tr>
                              <tr className="border-t border-border">
                                <td className="py-1.5 pr-2 font-medium">Differenz (FIBU − berechnet)</td>
                                <td className="px-2" />
                                <td className="px-2" />
                                <td className="text-right px-2 font-semibold">{erVergleich.diffChf !== null ? `CHF ${fmtChf(erVergleich.diffChf)}` : '–'}</td>
                                <td className={cn('text-right pl-2 font-bold', TONE_TEXT[ER_STATUS_TONE[erVergleich.status]])}>
                                  {erVergleich.diffPp !== null ? `${erVergleich.diffPp > 0 ? '+' : ''}${erVergleich.diffPp.toFixed(1)} pp` : '–'}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        {erVergleich.erOther > 0 && (
                          <p className="text-[11px] text-muted-foreground/70">
                            FIBU «Warenaufwand Diverses» (nicht in relevanter Quote): CHF {fmtChf(erVergleich.erOther)}
                          </p>
                        )}
                      </div>
                    )}

                    {erVergleich.monthAligned && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground border-t border-border/50 pt-2">
                        <span>
                          Relevant (Food+Bev):{' '}
                          <span className="font-medium text-foreground tabular-nums">CHF {fmtChf(analyseKPIs.relevantCost)}</span>
                        </span>
                        <span>
                          Sonstiges (nicht in Quote):{' '}
                          <span className="font-medium text-foreground tabular-nums">CHF {fmtChf(analyseKPIs.sonstigeCost)}</span>
                        </span>
                        <span className="sm:ml-auto">
                          Umsatzbasis:{' '}
                          {erVergleich.revenue !== null ? (
                            <span className="font-medium text-foreground tabular-nums">CHF {fmtChf(erVergleich.revenue)} (FIBU netto)</span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400">kein FIBU-Umsatz</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {rangeLoading ? (
                  <div className="flex items-center justify-center h-40 gap-3 text-muted-foreground">
                    <div className="h-5 w-5 rounded-full border-2 border-foreground/20 border-t-foreground/60 animate-spin" />
                    <span className="text-sm">Lade Daten…</span>
                  </div>
                ) : (
                  <>
                {/* ── Verlaufsgrafik ──────────────────────────────────────── */}
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">Verlauf Warenkosten · {analyseRangeLabel}</h2>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="text-foreground/50">Ziel {targetPct} %</span>
                    </div>
                  </div>

                  {/* ── Woche / Monat: zu wenig Daten ──────────────────── */}
                  {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).length < 2 && (
                    <div className="flex flex-col items-center justify-center h-52 gap-2 text-muted-foreground">
                      <BarChart3 className="h-8 w-8 opacity-20" />
                      <p className="text-sm">Noch zu wenig Daten für {analyseRangeLabel}</p>
                      <p className="text-xs opacity-60">Mindestens 2 Tage mit Umsatzdaten erforderlich.</p>
                    </div>
                  )}

                  {/* ── Woche / Monat: Tages-Chart ──────────────────────── */}
                  {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).length >= 2 && (
                    <div className="px-2 pt-4 pb-3">
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={analyseChartPoints} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                            tickLine={false}
                            axisLine={{ stroke: 'hsl(var(--border))' }}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tickFormatter={v => `${v}%`}
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                            tickLine={false}
                            axisLine={false}
                            width={42}
                            domain={[0, (max: number) => Math.max(Math.ceil(max / 5) * 5 + 5, targetPct + 5)]}
                          />
                          <Tooltip
                            content={({ active, payload, label }) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0]?.payload as ChartPoint;
                              return (
                                <div className="rounded-lg border border-border bg-card shadow-lg px-3.5 py-3 text-xs space-y-1.5 min-w-[180px]">
                                  <p className="font-semibold text-foreground text-sm">{label}</p>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-muted-foreground">Umsatz</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.dayRev)}</span>
                                  </div>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-muted-foreground">Warenkosten</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.dayNet)}</span>
                                  </div>
                                  {d.dayPct !== null && (
                                    <div className="flex justify-between gap-4">
                                      <span className="text-muted-foreground">Tages %</span>
                                      <span className={cn('tabular-nums font-semibold', d.dayPct > 35 ? 'text-red-600' : d.dayPct > 30 ? 'text-amber-600' : 'text-emerald-600')}>
                                        {fmtPct(d.dayPct)}
                                      </span>
                                    </div>
                                  )}
                                  <div className="border-t border-border/50 pt-1.5 flex justify-between gap-4">
                                    <span className="text-muted-foreground">Kum. Waren</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.cumNet)}</span>
                                  </div>
                                  {d.cumPct !== null && (
                                    <div className="flex justify-between gap-4">
                                      <span className="text-muted-foreground font-medium">Kum. %</span>
                                      <span className={cn('tabular-nums font-bold', d.cumPct > 35 ? 'text-red-600' : d.cumPct > 30 ? 'text-amber-600' : 'text-emerald-600')}>
                                        {fmtPct(d.cumPct)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            }}
                          />
                          <ReferenceLine
                            y={targetPct}
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="6 4"
                            strokeWidth={1.5}
                            strokeOpacity={0.6}
                            label={{ value: `Ziel ${targetPct}%`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          />
                          <Line
                            type="monotone"
                            dataKey="dayPct"
                            name="Tages %"
                            stroke="hsl(var(--muted-foreground))"
                            strokeWidth={1.5}
                            strokeOpacity={0.55}
                            dot={(props) => {
                              const { cx, cy, payload } = props;
                              if (!payload.hasEntry || payload.dayPct === null) return <g key={props.key} />;
                              return (
                                <Dot
                                  key={props.key}
                                  cx={cx} cy={cy} r={3}
                                  fill={payload.dayPct > 35 ? '#ef4444' : payload.dayPct > 30 ? '#f59e0b' : '#10b981'}
                                  stroke="white"
                                  strokeWidth={1}
                                />
                              );
                            }}
                            activeDot={{ r: 4, strokeWidth: 1.5, stroke: 'white' }}
                            connectNulls={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="cumPct"
                            name="Kum. %"
                            stroke="#3b82f6"
                            strokeWidth={2.5}
                            dot={false}
                            activeDot={{ r: 5, fill: '#3b82f6', stroke: 'white', strokeWidth: 2 }}
                            connectNulls
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div className="flex items-center gap-5 justify-end px-3 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-6 h-0.5 bg-muted-foreground/50" />
                          <span>Tages %</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-6 h-[3px] bg-blue-500 rounded" />
                          <span className="font-medium text-foreground/80">Kumuliert %</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-5 border-t border-dashed border-muted-foreground/60" style={{ borderSpacing: '4px' }} />
                          <span>Ziel {targetPct} %</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Multi / Jahr / YTD: zu wenig Daten ─────────────── */}
                  {analyseMode !== 'week' && analyseMode !== 'month' && analyseMonthPoints.length < 2 && (
                    <div className="flex flex-col items-center justify-center h-52 gap-2 text-muted-foreground">
                      <BarChart3 className="h-8 w-8 opacity-20" />
                      <p className="text-sm">Noch zu wenig Daten für {analyseRangeLabel}</p>
                      <p className="text-xs opacity-60">Mindestens 2 Monate mit Daten erforderlich.</p>
                    </div>
                  )}

                  {/* ── Multi / Jahr / YTD: Monats-Chart ───────────────── */}
                  {analyseMode !== 'week' && analyseMode !== 'month' && analyseMonthPoints.length >= 2 && (
                    <div className="px-2 pt-4 pb-3">
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={analyseMonthPoints} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                          <YAxis yAxisId="chf" orientation="left" tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={44} />
                          <YAxis yAxisId="pct" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={38} domain={[0, (mx: number) => Math.max(Math.ceil(mx / 5) * 5 + 5, targetPct + 5)]} />
                          <Tooltip content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0]?.payload as AMonthPoint;
                            return (
                              <div className="rounded-lg border border-border bg-card shadow-lg px-3.5 py-3 text-xs space-y-1.5 min-w-[180px]">
                                <p className="font-semibold text-foreground text-sm">{label}</p>
                                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Umsatz</span><span className="tabular-nums font-medium">CHF {fmtChf(d.revenue)}</span></div>
                                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Warenkosten</span><span className="tabular-nums font-medium">CHF {fmtChf(d.costNet)}</span></div>
                                {d.pct !== null && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Monats %</span><span className={cn('tabular-nums font-semibold', d.pct > targetPct + 2 ? 'text-red-600' : d.pct > targetPct ? 'text-amber-600' : 'text-emerald-600')}>{fmtPct(d.pct)}</span></div>}
                                {d.cumPct !== null && <div className="border-t border-border/50 pt-1.5 flex justify-between gap-4"><span className="text-muted-foreground font-medium">Kum. %</span><span className={cn('tabular-nums font-bold', d.cumPct > targetPct + 2 ? 'text-red-600' : d.cumPct > targetPct ? 'text-amber-600' : 'text-emerald-600')}>{fmtPct(d.cumPct)}</span></div>}
                              </div>
                            );
                          }} />
                          <ReferenceLine yAxisId="pct" y={targetPct} stroke="hsl(var(--muted-foreground))" strokeDasharray="6 4" strokeWidth={1.5} strokeOpacity={0.6} label={{ value: `Ziel ${targetPct}%`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                          <Bar yAxisId="chf" dataKey="revenue" name="Umsatz" fill="hsl(var(--muted-foreground))" fillOpacity={0.15} radius={[3,3,0,0]} maxBarSize={40}>
                            {analyseMonthPoints.map((_, i) => <Cell key={i} fill="hsl(var(--muted-foreground))" fillOpacity={0.15} />)}
                          </Bar>
                          <Bar yAxisId="chf" dataKey="costNet" name="Warenkosten" fill="#3b82f6" fillOpacity={0.7} radius={[3,3,0,0]} maxBarSize={40}>
                            {analyseMonthPoints.map((p, i) => <Cell key={i} fill={p.pct !== null && p.pct > targetPct + 2 ? '#ef4444' : p.pct !== null && p.pct > targetPct ? '#f59e0b' : '#3b82f6'} fillOpacity={0.7} />)}
                          </Bar>
                          <Line yAxisId="pct" type="monotone" dataKey="pct" name="Monats %" stroke="#f97316" strokeWidth={2} dot={{ r: 4, fill: '#f97316', stroke: 'white', strokeWidth: 1.5 }} activeDot={{ r: 5 }} connectNulls />
                          <Line yAxisId="pct" type="monotone" dataKey="cumPct" name="Kum. %" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 5, fill: '#3b82f6', stroke: 'white', strokeWidth: 2 }} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div className="flex items-center gap-5 justify-end px-3 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-sm bg-muted-foreground/20" /><span>Umsatz</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-sm bg-blue-500/70" /><span>Warenkosten CHF</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-6 h-[2.5px] rounded bg-orange-500" /><span>Monats %</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-6 h-[3px] rounded bg-blue-500" /><span className="font-medium text-foreground/80">Kum. %</span></div>
                      </div>
                    </div>
                  )}
                </section>

                    {/* ── Wochen-Alerts (nur Monat-Modus) ─────────────────── */}
                    {analyseWeeklyData.length > 0 && (
                      <section className="bg-card border border-border rounded-xl overflow-hidden">
                        <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">Wochen-Alerts</span>
                            <span className="text-xs text-muted-foreground">Ziel {targetPct} %  ·  +2 % = Warnung  ·  &gt;+2 % = Kritisch</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {analyseWeeklyData.some(w => w.status === 'red') && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400 px-2 py-0.5 font-medium">
                                {analyseWeeklyData.filter(w => w.status === 'red').length}× kritisch
                              </span>
                            )}
                            {analyseWeeklyData.some(w => w.status === 'yellow') && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 px-2 py-0.5 font-medium">
                                {analyseWeeklyData.filter(w => w.status === 'yellow').length}× Warnung
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
                          {analyseWeeklyData.map(w => {
                            const statusCfg: Record<WeekStatus, {
                              bg: string; border: string; dot: string; label: string; badge: string;
                            }> = {
                              green:  { bg: 'bg-emerald-50 dark:bg-emerald-950/20',  border: 'border-emerald-200 dark:border-emerald-800', dot: 'bg-emerald-500', label: 'Im Ziel', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
                              yellow: { bg: 'bg-amber-50 dark:bg-amber-950/20',     border: 'border-amber-200 dark:border-amber-800',     dot: 'bg-amber-400',   label: 'Über Ziel', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
                              red:    { bg: 'bg-red-50 dark:bg-red-950/20',         border: 'border-red-200 dark:border-red-800',         dot: 'bg-red-500',     label: 'Kritisch', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
                              nodata: { bg: 'bg-muted/30',                           border: 'border-border',                              dot: 'bg-muted-foreground/30', label: 'Kein Umsatz', badge: 'bg-muted text-muted-foreground' },
                            };
                            const cfg = statusCfg[w.status];
                            return (
                              <div
                                key={w.weekKey}
                                className={cn(
                                  'rounded-xl border p-4 space-y-2.5 relative',
                                  cfg.bg, cfg.border,
                                  w.isCurrent && 'ring-2 ring-offset-1 ring-blue-400 dark:ring-blue-600',
                                )}
                              >
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0', cfg.dot)} />
                                    <span className="font-bold text-sm tabular-nums">{w.weekLabel}</span>
                                    {w.isCurrent && (
                                      <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded px-1.5 py-0.5 font-medium">laufend</span>
                                    )}
                                    {!w.isCurrent && w.isComplete && (
                                      <span className="text-[10px] text-muted-foreground/60">abgeschlossen</span>
                                    )}
                                  </div>
                                  <span className={cn('text-xs font-semibold rounded-md px-2 py-0.5', cfg.badge)}>
                                    {cfg.label}
                                  </span>
                                </div>

                                {/* Datum-Range */}
                                <p className="text-[11px] text-muted-foreground">
                                  {formatDateShort(w.from)} – {formatDateShort(w.to)}
                                </p>

                                {/* Zahlen */}
                                <div className="space-y-1.5 pt-0.5">
                                  <div className="flex justify-between items-baseline gap-2">
                                    <span className="text-xs text-muted-foreground">Umsatz</span>
                                    <span className="text-xs tabular-nums font-medium">
                                      {w.revenue > 0 ? `CHF ${fmtChf(w.revenue)}` : <span className="opacity-40">–</span>}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-baseline gap-2">
                                    <span className="text-xs text-muted-foreground">Warenkosten</span>
                                    <span className="text-xs tabular-nums font-semibold">
                                      {w.costNet > 0 ? `CHF ${fmtChf(w.costNet)}` : <span className="opacity-40">–</span>}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-baseline gap-2 pt-0.5 border-t border-current/10">
                                    <span className="text-xs text-muted-foreground font-medium">Wochen %</span>
                                    <span className={cn(
                                      'text-sm tabular-nums font-bold',
                                      w.status === 'red' ? 'text-red-700 dark:text-red-400' :
                                      w.status === 'yellow' ? 'text-amber-700 dark:text-amber-400' :
                                      w.status === 'green' ? 'text-emerald-700 dark:text-emerald-400' :
                                      'text-muted-foreground',
                                    )}>
                                      {w.pct !== null ? fmtPct(w.pct) : '–'}
                                    </span>
                                  </div>
                                  {w.cumPct !== null && (
                                    <div className="flex justify-between items-baseline gap-2">
                                      <span className="text-[11px] text-muted-foreground/70">Kum. bis hier</span>
                                      <span className="text-[11px] tabular-nums text-muted-foreground/80 font-medium">
                                        {fmtPct(w.cumPct)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    {/* ── Lieferanten-Rangliste ────────────────────────── */}
                    {analyseSuppliers.length > 0 && (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                          <h2 className="text-sm font-semibold">Lieferanten · {analyseRangeLabel}</h2>
                          {supplierFilter && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-foreground text-background">
                              {supplierFilter}
                              <button
                                onClick={() => setSupplierFilter('')}
                                className="ml-0.5 hover:opacity-70 transition-opacity"
                                title="Filter zurücksetzen"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Gesamt-Total (alle Konten) CHF {fmtChf(analyseSuppliers.reduce((s, x) => s + x.net, 0))} · {analyseSuppliers.length} Lieferanten
                          {!supplierFilter && <span className="ml-1 opacity-60">· Zeile anklicken zum Filtern</span>}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium">Lieferant</th>
                              <th className="px-4 py-2.5 text-right font-medium">Total Netto (alle Konten)</th>
                              <th className="px-4 py-2.5 text-right font-medium">davon Warenkosten (4000–{warenGrenze})</th>
                              <th className="px-4 py-2.5 text-right font-medium">davon Betriebskosten (≥ {warenGrenze + 1})</th>
                              <th className="px-4 py-2.5 text-right font-medium">Anteil Gesamt</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseSuppliers.map((s, i) => {
                              const gesamt = analyseSuppliers.reduce((a, x) => a + x.net, 0);
                              const pct = gesamt > 0 ? (s.net / gesamt) * 100 : 0;
                              const isSelected = supplierFilter === s.name;
                              return (
                                <tr
                                  key={s.name}
                                  onClick={() => setSupplierFilter(isSelected ? '' : s.name)}
                                  className={cn(
                                    'border-b border-border/40 cursor-pointer transition-colors',
                                    isSelected
                                      ? 'bg-foreground/5 ring-1 ring-inset ring-foreground/20'
                                      : i % 2 === 1 ? 'bg-muted/10 hover:bg-muted/30' : 'hover:bg-muted/20',
                                  )}
                                >
                                  <td className="px-4 py-2.5 font-medium">
                                    <div className="flex items-center gap-2">
                                      {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-foreground flex-shrink-0" />}
                                      {s.name}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">CHF {fmtChf(s.net)}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs">{s.waren > 0 ? `CHF ${fmtChf(s.waren)}` : '—'}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-amber-700 dark:text-amber-400">{s.betrieb > 0 ? `CHF ${fmtChf(s.betrieb)}` : '—'}</td>
                                  <td className="px-4 py-2.5 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                        <div className="h-full rounded-full bg-foreground/30" style={{ width: `${Math.min(pct, 100)}%` }} />
                                      </div>
                                      <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">{pct.toFixed(0)} %</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(s.gross)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-border bg-muted/20 font-bold">
                              <td className="px-4 py-3 font-bold">Total</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(analyseSuppliers.reduce((s, x) => s + x.net, 0))}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-semibold">CHF {fmtChf(analyseSuppliers.reduce((s, x) => s + x.waren, 0))}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-semibold text-amber-700 dark:text-amber-400">CHF {fmtChf(analyseSuppliers.reduce((s, x) => s + x.betrieb, 0))}</td>
                              <td className="px-4 py-3 text-right">
                                <span className="text-[10px] text-muted-foreground font-normal mr-1">WKQ</span>
                                <PctBadge pct={analyseKPIs.pct} />
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(analyseSuppliers.reduce((s, x) => s + x.gross, 0))}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>
                    )}

                    {/* ── Lieferanten-Detail (wenn gefiltert) ──────────── */}
                    {supplierFilter && supplierDetailEntries.length > 0 && (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                          <h2 className="text-sm font-semibold">Einzelrechnungen · {supplierFilter}</h2>
                          <span className="text-xs text-muted-foreground">· {analyseRangeLabel}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-semibold tabular-nums">CHF {fmtChf(supplierFilterTotals.net)} netto</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{fmtChf(supplierFilterTotals.gross)} brutto</span>
                          <span className="text-xs text-muted-foreground">{supplierDetailEntries.length} Rechnung{supplierDetailEntries.length !== 1 ? 'en' : ''}</span>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                              <th className="px-4 py-2.5 text-left font-medium">Referenz / Notiz</th>
                              <th className="px-4 py-2.5 text-left font-medium">Kategorie</th>
                              <th className="px-4 py-2.5 text-left font-medium">Konto</th>
                              <th className="px-4 py-2.5 text-right font-medium">Netto</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {supplierDetailEntries.map((e, i) => {
                              const kontoLabel = e.kontoSplits && e.kontoSplits.length > 0
                                ? e.kontoSplits.map(k => k.warenkonto).join(' + ')
                                : e.warenkonto || '–';
                              const kat = e.kategorie ?? 'Sonstiges';
                              const katColor: Record<string, string> = {
                                Food:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400',
                                Beverage:  'bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400',
                                Sonstiges: 'bg-muted text-muted-foreground',
                              };
                              return (
                                <tr key={e.id} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10')}>
                                  <td className="px-4 py-2.5 font-medium text-sm">{formatDateLong(e.date)}</td>
                                  <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[200px]">
                                    {e.reference && <span className="font-mono text-foreground/80 mr-1.5">{e.reference}</span>}
                                    {e.note && <span className="italic">{e.note}</span>}
                                    {!e.reference && !e.note && <span className="opacity-30">–</span>}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', katColor[kat])}>
                                      {kat}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">{kontoLabel}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">CHF {fmtChf(e.amountNet)}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(e.amountGross)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-border bg-muted/20">
                              <td className="px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide font-medium" colSpan={4}>Total</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(supplierFilterTotals.net)}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(supplierFilterTotals.gross)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>
                    )}

                    {/* ── Tages-Detail-Tabelle (nur Woche / Monat) ─────────── */}
                    {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry).length > 0 && (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Tagesverlauf · {analyseRangeLabel}</h2>
                        <span className="text-xs text-muted-foreground">{analyseChartPoints.filter(p => p.hasEntry).length} Tage mit Einträgen</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                              <th className="px-4 py-2.5 text-right font-medium">Warenkosten</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">Tages %</th>
                              <th className="px-4 py-2.5 text-right font-medium border-l border-border/50"><span className="text-foreground/80">Kum. Waren</span></th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Kum. Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium"><span className="text-foreground/80">Kum. %</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).map((p, i) => {
                              const isToday = p.date === todayStr;
                              return (
                                <tr key={p.date} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10', isToday && 'ring-1 ring-inset ring-blue-200 dark:ring-blue-800')}>
                                  <td className="px-4 py-2.5 font-medium text-sm">
                                    {formatDateLong(p.date)}
                                    {isToday && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded px-1 py-0.5">heute</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{p.dayNet > 0 ? `CHF ${fmtChf(p.dayNet)}` : <span className="text-muted-foreground/30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.dayRev > 0 ? fmtChf(p.dayRev) : <span className="opacity-30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right"><PctBadge pct={p.dayPct} /></td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-bold border-l border-border/50 text-foreground/80">CHF {fmtChf(p.cumNet)}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.cumRev > 0 ? fmtChf(p.cumRev) : <span className="opacity-30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right"><PctBadge pct={p.cumPct} /></td>
                                </tr>
                              );
                            })}
                          </tbody>
                          {(() => {
                            const last = analyseChartPoints[analyseChartPoints.length - 1];
                            if (!last) return null;
                            return (
                              <tfoot>
                                <tr className="border-t-2 border-border bg-muted/20 font-bold">
                                  <td className="px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Stand {formatDateShort(last.date)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums">CHF {fmtChf(last.cumNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(last.cumRev)}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={analyseKPIs.pct} /></td>
                                  <td className="px-4 py-3 text-right tabular-nums font-bold border-l border-border/50">CHF {fmtChf(last.cumNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{last.cumRev > 0 ? fmtChf(last.cumRev) : '–'}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={last.cumPct} /></td>
                                </tr>
                              </tfoot>
                            );
                          })()}
                        </table>
                      </div>
                    </section>
                    )}

                    {/* ── Monats-Ampel-Karten (nur Jahr / YTD) ─────────────── */}
                    {(analyseMode === 'year' || analyseMode === 'ytd') && analyseMonthPoints.length > 0 && (() => {
                      const getStatus = (pct: number | null) =>
                        pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
                      const statusCfg = {
                        green:  { bg: 'bg-green-50 dark:bg-green-950/30',  border: 'border-green-200 dark:border-green-800',  dot: 'bg-green-500',  label: 'Im Ziel',       txt: 'text-green-700 dark:text-green-400'  },
                        yellow: { bg: 'bg-amber-50 dark:bg-amber-950/30',  border: 'border-amber-200 dark:border-amber-800',  dot: 'bg-amber-400',  label: 'Leicht über',   txt: 'text-amber-700 dark:text-amber-400'  },
                        red:    { bg: 'bg-red-50 dark:bg-red-950/30',      border: 'border-red-200 dark:border-red-800',      dot: 'bg-red-500',    label: 'Über Ziel',     txt: 'text-red-700 dark:text-red-400'      },
                        nodata: { bg: 'bg-muted/20',                       border: 'border-border',                           dot: 'bg-muted-foreground/30', label: 'Keine Daten', txt: 'text-muted-foreground' },
                      };
                      return (
                      <section className="bg-card border border-border rounded-xl overflow-hidden">
                        <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                          <h2 className="text-sm font-semibold">Monatsvergleich · {analyseRangeLabel}</h2>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" />≤ {targetPct.toFixed(0)}%</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" />≤ {(targetPct + 2).toFixed(0)}%</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" />&gt; {(targetPct + 2).toFixed(0)}%</span>
                          </div>
                        </div>
                        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                          {analyseMonthPoints.map(p => {
                            const st = getStatus(p.pct);
                            const cfg = statusCfg[st];
                            return (
                              <div key={p.monthKey} className={cn('rounded-lg border p-3 flex flex-col gap-1', cfg.bg, cfg.border)}>
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-semibold text-foreground/80">{p.label}</span>
                                  <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full', cfg.txt)}>
                                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', cfg.dot)} />
                                    {cfg.label}
                                  </span>
                                </div>
                                <div className="tabular-nums text-sm font-bold text-foreground">
                                  {p.pct !== null ? `${p.pct.toFixed(1)} %` : <span className="text-muted-foreground/40 font-normal text-xs">–</span>}
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                                  <span>{p.costNet > 0 ? `CHF ${fmtChf(p.costNet)}` : '–'}</span>
                                  <span className="opacity-70">{p.revenue > 0 ? `/ ${fmtChf(p.revenue)}` : ''}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* Jahres-Zusammenfassung */}
                        <div className="px-5 py-3 border-t border-border bg-muted/10 flex items-center gap-6 flex-wrap text-sm">
                          <span className="text-muted-foreground text-xs uppercase tracking-wide font-medium">Jahres-Total</span>
                          <span className="tabular-nums font-semibold">Umsatz <span className="text-muted-foreground font-normal">CHF {fmtChf(analyseKPIs.totalRev)}</span></span>
                          <span className="tabular-nums font-semibold">Waren <span className="text-muted-foreground font-normal">CHF {fmtChf(analyseKPIs.totalCost)}</span></span>
                          <span className="font-semibold">Quote <PctBadge pct={analyseKPIs.pct} /></span>
                          <span className="ml-auto flex gap-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'green').length}× Im Ziel</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'yellow').length}× Leicht</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'red').length}× Über Ziel</span>
                          </span>
                        </div>
                      </section>
                      );
                    })()}

                    {/* ── Monats-Übersicht Tabelle (nur multi_month / Jahr / YTD) ─── */}
                    {(analyseMode === 'multi_month' || analyseMode === 'year' || analyseMode === 'ytd') && analyseMonthPoints.length > 0 && (() => {
                      const getStatus = (pct: number | null) =>
                        pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
                      const rowBg: Record<string, string> = {
                        green:  'border-l-2 border-l-green-400',
                        yellow: 'border-l-2 border-l-amber-400',
                        red:    'border-l-2 border-l-red-500',
                        nodata: '',
                      };
                      const dotColor: Record<string, string> = {
                        green: 'bg-green-500', yellow: 'bg-amber-400', red: 'bg-red-500', nodata: 'bg-muted-foreground/30',
                      };
                      return (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Monatsdetail · {analyseRangeLabel}</h2>
                        <span className="text-xs text-muted-foreground">{analyseMonthPoints.length} Monate · Ziel {targetPct.toFixed(0)} %</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-6"></th>
                              <th className="px-4 py-2.5 text-left font-medium">Monat</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">Warenkosten</th>
                              <th className="px-4 py-2.5 text-right font-medium">Monats %</th>
                              <th className="px-4 py-2.5 text-right font-medium">Status</th>
                              <th className="px-4 py-2.5 text-right font-medium border-l border-border/50"><span className="text-foreground/80">Kum. %</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseMonthPoints.map((p, i) => {
                              const st = getStatus(p.pct);
                              return (
                              <tr key={p.monthKey} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10', rowBg[st])}>
                                <td className="pl-3 pr-1 py-2.5 w-6">
                                  <span className={cn('inline-block w-2 h-2 rounded-full', dotColor[st])} />
                                </td>
                                <td className="px-4 py-2.5 font-medium">{p.label}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.revenue > 0 ? `CHF ${fmtChf(p.revenue)}` : <span className="opacity-30">–</span>}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{p.costNet > 0 ? `CHF ${fmtChf(p.costNet)}` : <span className="text-muted-foreground/30">–</span>}</td>
                                <td className="px-4 py-2.5 text-right"><PctBadge pct={p.pct} /></td>
                                <td className="px-4 py-2.5 text-right text-xs">
                                  {st === 'green'  && <span className="text-green-600 dark:text-green-400 font-medium">Im Ziel</span>}
                                  {st === 'yellow' && <span className="text-amber-600 dark:text-amber-400 font-medium">Leicht über</span>}
                                  {st === 'red'    && <span className="text-red-600 dark:text-red-400 font-semibold">Über Ziel</span>}
                                  {st === 'nodata' && <span className="text-muted-foreground/40">–</span>}
                                </td>
                                <td className="px-4 py-2.5 text-right border-l border-border/50"><PctBadge pct={p.cumPct} /></td>
                              </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-border bg-muted/20 font-bold">
                              <td className="px-4 py-3" colSpan={2}>Total</td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">CHF {fmtChf(analyseKPIs.totalRev)}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(analyseKPIs.totalCost)}</td>
                              <td className="px-4 py-3 text-right" colSpan={3}><PctBadge pct={analyseKPIs.pct} /></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>
                      );
                    })()}

                    {/* Umsatzbasis fehlt */}
                    {analyseKPIs.totalRev === 0 && analysisEntries.length > 0 && (
                      <div className="flex items-center gap-2.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-400 rounded-lg px-4 py-3">
                        <AlertCircle className="h-4 w-4 flex-shrink-0" />
                        Kein Tagesumsatz für {analyseRangeLabel} vorhanden. %-Berechnungen nicht möglich. Bitte Umsatzdaten importieren.
                      </div>
                    )}
                    {analysisEntries.length === 0 && (
                      <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center">
                        <BarChart3 className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                        <p className="text-sm font-medium text-muted-foreground">Keine Warenrechnungen für {analyseRangeLabel}</p>
                        <p className="text-xs text-muted-foreground/50 mt-1">Wechsle zur Erfassung und trage Warenrechnungen ein.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Tab: FIBU-Abgleich pro Lieferant ─────────────────────────── */}
            {tab === 'abgleich' && (
              <div className="space-y-5">
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
                    <Scale className="h-4 w-4" style={{ color: tenant.color }} />
                    <h2 className="text-sm font-semibold">Warenrechnungen ↔ Buchhaltung · {MONTHS_LONG[month - 1]} {year}</h2>
                    <InfoTip text={<span>Erfasste Warenrechnungen (netto) gegen die importierten Buchhaltungskosten. Mit Buchungszeilen («Ist Kosten Buchhaltung»-Import mit Kontoblatt/Journal) erfolgt der Abgleich <b>pro Lieferant</b> über Buchungstext ↔ Name/Alias; ohne Buchungszeilen nur Total gegen die Erfolgsrechnung. Verglichen wird das <b>Gesamt-Total pro Lieferant über ALLE Konten</b> (Warenkosten + Betriebskosten) — nur so stimmt der Vergleich mit dem Kontoblatt.</span>} />
                  </div>

                  {abgleich === null ? (
                    <div className="px-5 py-8 text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Buchhaltungsdaten werden geladen…
                    </div>
                  ) : (
                    <div className="px-5 py-4 space-y-4">
                      {/* Degradierter Modus: keine Lieferanten-Ebene in der FIBU */}
                      {abgleich.mode === 'nur-total' && (
                        journalVerfuegbarFuerTenant(tenantId) ? (
                          <HintBox tone="info" title="Kein Buchungsjournal für diesen Monat">
                            Für {MONTHS_LONG[month - 1]} {year} sind keine Buchungszeilen mit Lieferantennamen importiert
                            (z.B. nur Jahres-Kontoblatt oder kein Journal-Import). Der Abgleich zeigt deshalb nur
                            «erfasst total» gegen das Buchhaltungs-Total der Erfolgsrechnung; pro Lieferant stehen keine
                            Buchhaltungsdaten zur Verfügung.
                          </HintBox>
                        ) : (
                          <HintBox tone="info" title={`Kein Lieferanten-Abgleich für ${tenant.name}`}>
                            Das importierte Buchungsjournal stammt aus der Oliv-Buchhaltung und ist nicht
                            mandantengetrennt — für {tenant.name} wird es deshalb bewusst NICHT verwendet.
                            Der Abgleich zeigt nur «erfasst total» gegen das Buchhaltungs-Total der Erfolgsrechnung;
                            pro Lieferant stehen keine Buchhaltungsdaten zur Verfügung.
                          </HintBox>
                        )
                      )}

                      {/* Total-Vergleich */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="rounded-lg border border-border px-4 py-3">
                          <p className="text-[11px] text-muted-foreground">Warenrechnungen erfasst (netto)</p>
                          <p className="text-lg font-semibold tabular-nums" data-testid="abgleich-erfasst-total">CHF {fmtChf(abgleich.erfasstTotal)}</p>
                        </div>
                        <div className="rounded-lg border border-border px-4 py-3">
                          <p className="text-[11px] text-muted-foreground">
                            {abgleich.mode === 'lieferanten' ? 'Buchhaltung (Warenkonten, Journal)' : 'Buchhaltung/ER total'}
                          </p>
                          <p className="text-lg font-semibold tabular-nums" data-testid="abgleich-gebucht-total">
                            {abgleich.gebuchtTotal !== null ? `CHF ${fmtChf(abgleich.gebuchtTotal)}` : '— keine FIBU-Daten'}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border px-4 py-3">
                          <p className="text-[11px] text-muted-foreground">Differenz (Buchhaltung − erfasst)</p>
                          <p className={cn('text-lg font-semibold tabular-nums',
                            abgleich.diffTotal !== null && Math.abs(abgleich.diffTotal) > 50 && 'text-red-600 dark:text-red-400')}
                            data-testid="abgleich-diff-total">
                            {abgleich.diffTotal !== null ? `CHF ${fmtChf(abgleich.diffTotal)}` : '—'}
                          </p>
                        </div>
                      </div>

                      {/* Lieferanten-Tabelle */}
                      {abgleich.zeilen.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4">Keine Warenrechnungen in diesem Monat erfasst.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                                <th className="px-3 py-2 text-left font-medium">Lieferant</th>
                                <th className="px-3 py-2 text-right font-medium">Erfasst (CHF)</th>
                                <th className="px-3 py-2 text-right font-medium">Buchhaltung (CHF)</th>
                                <th className="px-3 py-2 text-right font-medium">Differenz</th>
                                <th className="px-3 py-2 text-left font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {abgleich.zeilen.map(z => {
                                const offen = abgleichOffen === z.lieferant;
                                const kannDrilldown = abgleich.mode === 'lieferanten';
                                return (
                                <Fragment key={z.lieferant}>
                                <tr
                                  className={cn('border-b border-border/40',
                                    kannDrilldown && 'cursor-pointer hover:bg-muted/20',
                                    z.status === 'abweichung' && 'bg-red-500/5',
                                    (z.status === 'nur-erfasst' || z.status === 'nur-gebucht') && 'bg-amber-500/5')}
                                  onClick={() => kannDrilldown && setAbgleichOffen(offen ? null : z.lieferant)}
                                  data-testid={`abgleich-row-${z.lieferant}`}
                                >
                                  <td className="px-3 py-2">
                                    <span className="inline-flex items-center gap-1">
                                      {kannDrilldown && (offen
                                        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                        : <ChevronRightSmall className="h-3.5 w-3.5 text-muted-foreground" />)}
                                      {z.lieferant}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">{z.erfasst !== null ? fmtChf(z.erfasst) : '—'}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {z.status === 'keine-fibu'
                                      ? <span className="text-muted-foreground text-xs">keine Buchhaltungsdaten</span>
                                      : z.gebucht !== null ? fmtChf(z.gebucht) : '—'}
                                  </td>
                                  <td className={cn('px-3 py-2 text-right tabular-nums',
                                    z.status === 'abweichung' && 'text-red-600 dark:text-red-400 font-medium')}>
                                    {z.diff !== null ? fmtChf(z.diff) : '—'}
                                  </td>
                                  <td className="px-3 py-2">
                                    {z.status === 'ok' && <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-600/40">OK</Badge>}
                                    {z.status === 'abweichung' && <Badge variant="outline" className="text-[10px] text-red-600 border-red-600/40">Abweichung</Badge>}
                                    {z.status === 'nur-erfasst' && <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-600/40">keine Buchung gefunden</Badge>}
                                    {z.status === 'nur-gebucht' && <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-600/40">nicht erfasst</Badge>}
                                    {z.status === 'keine-fibu' && <span className="text-[10px] text-muted-foreground">—</span>}
                                  </td>
                                </tr>
                                {/* Drilldown: Rechnungen und Buchungen nebeneinander */}
                                {offen && kannDrilldown && (
                                  <tr className="border-b border-border/40 bg-muted/10">
                                    <td colSpan={5} className="px-4 py-3">
                                      {/* Transparenz Alias-Gruppe: Original-Namen und Beträge je Alias */}
                                      {z.mitglieder && z.mitglieder.length > 0 && (
                                        <div className="mb-3 rounded border border-border/60 bg-muted/20 px-3 py-2 text-xs" data-testid={`abgleich-gruppe-${z.lieferant}`}>
                                          <p className="font-medium mb-1">Zusammengeführte Gruppe — Original-Namen:</p>
                                          {z.mitglieder.map(mg => (
                                            <p key={mg.name} className="flex justify-between gap-3 tabular-nums py-0.5">
                                              <span>{mg.name}</span>
                                              <span className="text-muted-foreground">
                                                Erfasst: {mg.erfasst !== null ? `CHF ${fmtChf(mg.erfasst)}` : '—'}
                                                {' · '}Buchhaltung: {mg.gebucht !== null ? `CHF ${fmtChf(mg.gebucht)}` : '—'}
                                              </span>
                                            </p>
                                          ))}
                                        </div>
                                      )}
                                      <FibuMatchBereich
                                        lieferant={z.lieferant}
                                        invoices={entries.filter(e => aliasResolver(e.supplierName) === z.lieferant)}
                                        buchungen={z.buchungen}
                                        state={fibuState}
                                        stateGeladen={fibuGeladen}
                                        toleranz={fibuToleranz}
                                        onToleranzChange={speichereToleranz}
                                        onMutate={persistFibuState}
                                      />
                                    </td>
                                  </tr>
                                )}
                                </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Nicht zugeordnete Buchungen */}
                      {abgleich.mode === 'lieferanten' && abgleich.nichtZugeordnet.length > 0 && (
                        <div className="text-xs text-muted-foreground border-t border-border/50 pt-3">
                          <p className="font-medium text-foreground mb-1">
                            Buchungen ohne Lieferanten-Zuordnung: {abgleich.nichtZugeordnet.length} · CHF {fmtChf(abgleich.nichtZugeordnetSumme)}
                          </p>
                          {abgleich.nichtZugeordnet.slice(0, 12).map((b, i) => (
                            <p key={i} className="tabular-nums">{b.date} · {b.text} · CHF {fmtChf((b.soll ?? 0) - (b.haben ?? 0))}</p>
                          ))}
                          {abgleich.nichtZugeordnet.length > 12 && <p>… und {abgleich.nichtZugeordnet.length - 12} weitere</p>}
                          <p className="mt-1">Tipp: Lieferant im Stamm anlegen oder eine PDF-Rechnung zuordnen — der Alias wirkt auch hier.</p>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* ── Abgleich PRO KONTO: erfasst je Warenkonto vs. Kontoblatt ── */}
                <section className="bg-card border border-border rounded-xl overflow-hidden" data-testid="konto-abgleich">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
                    <Scale className="h-4 w-4" style={{ color: tenant.color }} />
                    <h2 className="text-sm font-semibold">Abgleich pro Konto · {MONTHS_LONG[month - 1]} {year}</h2>
                    <InfoTip text={<span>Erfasste Rechnungen (netto, je Konto aus Splits bzw. Einzelkonto) gegen die Kontoblatt-Buchungen desselben Kontos. <b>Ergänzend</b> zum Lieferanten-Abgleich — Totale und WKQ bleiben unverändert. «Depot» = Pfand/Gebinde (neutral), «offen» = Positionen ohne Konto-Zuordnung.</span>} />
                  </div>
                  {journal === null ? (
                    <div className="px-5 py-6 text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Buchhaltungsdaten werden geladen…
                    </div>
                  ) : kontoAbgleich.length === 0 ? (
                    <div className="px-5 py-6 text-sm text-muted-foreground">Keine erfassten Rechnungen und keine Buchungen in diesem Monat.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-xs text-muted-foreground">
                            <th className="text-left  px-4 py-2 font-medium">Konto</th>
                            <th className="text-right px-4 py-2 font-medium">Erfasst (netto)</th>
                            <th className="text-right px-4 py-2 font-medium">Gebucht (Kontoblatt)</th>
                            <th className="text-right px-4 py-2 font-medium">Differenz</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kontoAbgleich.map(z => (
                            <tr key={z.konto} className="border-b border-border/40" data-testid={`konto-abgleich-${z.konto}`}>
                              <td className="px-4 py-2">
                                <span className="font-mono font-semibold">{z.konto}</span>
                                {z.bezeichnung && <span className="text-xs text-muted-foreground ml-2">{z.bezeichnung}</span>}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums">{z.erfasst !== 0 ? `CHF ${fmtChf(z.erfasst)}` : <span className="opacity-40">—</span>}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{z.gebucht !== null ? `CHF ${fmtChf(z.gebucht)}` : <span className="opacity-40">—</span>}</td>
                              <td className={cn('px-4 py-2 text-right tabular-nums font-medium',
                                z.diff === null ? 'text-muted-foreground'
                                  : Math.abs(z.diff) <= 10 ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-amber-600 dark:text-amber-400')}>
                                {z.diff !== null ? `CHF ${fmtChf(z.diff)}` : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* ── Lieferanten-Zuordnung (Alias-Gruppen, mandantengetrennt) ── */}
                <AliasGruppenVerwaltung
                  gruppen={aliasGruppen}
                  onSave={async (next) => {
                    try {
                      await saveAliasGruppen(tenantId, next);
                      setAliasGruppen(next);
                      toast.success('Lieferanten-Zuordnung gespeichert.');
                    } catch (e) {
                      toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                />
              </div>
            )}

            {/* ── Legende ───────────────────────────────────────────────── */}
            <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-muted-foreground border-t border-border/50 pt-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-emerald-500" />
                <span>≤ 30 % – im Ziel</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-amber-400" />
                <span>30–35 % – erhöht</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-red-500" />
                <span>&gt; 35 % – kritisch</span>
              </div>
              <span className="ml-auto">Alle Beträge exkl. MWST (Netto)</span>
            </div>
          </>
        )}
      </main>

      {/* ── Dialog: Eintrag bearbeiten ──────────────────────────────────────── */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Eintrag bearbeiten</DialogTitle>
          </DialogHeader>
          {editEntry && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Datum</Label>
                  <Input type="date" value={editEntry.date}
                    onChange={e => setEditEntry(v => v ? { ...v, date: e.target.value } : v)}
                    className="h-9 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Lieferant</Label>
                  <Select value={editEntry.supplierName} onValueChange={v => setEditEntry(x => x ? { ...x, supplierName: v } : x)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {activeSuppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Netto CHF</Label>
                  <Input type="number" step="0.01" value={editEntry.amountNet.toFixed(2)}
                    onChange={e => {
                      const net = Number(e.target.value);
                      setEditEntry(x => x ? { ...x, amountNet: net, amountGross: net * (1 + x.vatRate / 100) } : x);
                    }}
                    className="h-9 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Brutto CHF</Label>
                  <Input type="number" step="0.01" value={editEntry.amountGross.toFixed(2)} readOnly className="h-9 text-sm bg-muted" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">MWST %</Label>
                  <Select value={String(editEntry.vatRate)} onValueChange={v => {
                    const rate = Number(v);
                    setEditEntry(x => x ? { ...x, vatRate: rate, amountGross: x.amountNet * (1 + rate / 100) } : x);
                  }}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VAT_RATES.map(r => <SelectItem key={r} value={r}>{r} %</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* Kategorie */}
              <div className="space-y-1">
                <Label className="text-xs">Kategorie</Label>
                <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs font-medium">
                  {WARE_KATEGORIEN.map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEditEntry(x => x ? { ...x, kategorie: k as WarenKategorie } : x)}
                      className={cn(
                        'px-3 flex-1 transition-colors border-l border-border first:border-l-0',
                        (editEntry?.kategorie ?? 'Sonstiges') === k
                          ? k === 'Food' ? 'bg-emerald-600 text-white'
                            : k === 'Beverage' ? 'bg-blue-600 text-white'
                            : 'bg-foreground text-background'
                          : 'text-muted-foreground hover:bg-muted',
                      )}
                    >{k}</button>
                  ))}
                </div>
              </div>
              {/* Warenkonto (einfach) – nur wenn kein Split */}
              {(!editEntry.kontoSplits || editEntry.kontoSplits.length === 0) && (
                <div className="space-y-1">
                  <Label className="text-xs">Warenkonto (optional)</Label>
                  <Select
                    value={editEntry.warenkonto ?? '__none__'}
                    onValueChange={v => setEditEntry(x => {
                      if (!x) return x;
                      const konto = v === '__none__' ? undefined : v;
                      return { ...x, warenkonto: konto, kategorie: kontoKategorie(konto, warenkonten) };
                    })}
                  >
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— kein Konto —</SelectItem>
                      {warenkonten.map(k => (
                        <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* Split-Konten – nur lesen, kein Bearbeiten der Split-Aufteilung im Edit-Dialog */}
              {editEntry.kontoSplits && editEntry.kontoSplits.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Kontoaufteilung (Split)</Label>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1">
                    {editEntry.kontoSplits.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold">{s.warenkonto}</span>
                        <span className="text-muted-foreground">Netto CHF {fmtChf(s.amountNet)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground/60">Split-Aufteilung kann nur beim Erstellen geändert werden.</p>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Referenz (optional)</Label>
                <Input value={editEntry.reference ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, reference: e.target.value || undefined } : x)}
                  className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Beleg / Screenshot (optional)</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  {editEntry.receiptPath && (
                    <button type="button" className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                      onClick={() => openReceipt(editEntry.receiptPath!)}>
                      <Paperclip className="h-3 w-3" /> Beleg öffnen
                    </button>
                  )}
                  <input
                    type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                    data-testid="input-edit-receipt-file"
                    className="block text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                    onChange={e => setEditReceiptFile(e.target.files?.[0] ?? null)}
                  />
                </div>
                {editEntry.receiptPath && (
                  <p className="text-[10px] text-muted-foreground/60">Neue Datei wählen ersetzt den bestehenden Beleg beim Speichern.</p>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bemerkung (optional)</Label>
                <Input value={editEntry.note ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, note: e.target.value || undefined } : x)}
                  className="h-8 text-sm" />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Abbrechen</Button>
            <Button onClick={handleEditSave} disabled={saving}>{saving ? 'Speichern…' : 'Speichern'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Stammdaten (Lieferanten + Warenkonten) ─────────────────── */}
      <Dialog open={showSupplierDialog} onOpenChange={setShowSupplierDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              Stammdaten · Lieferanten &amp; Warenkonten
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex gap-2">
              <Input
                placeholder="Neuer Lieferant…"
                value={newSupplierName}
                onChange={e => setNewSupplierName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddSupplier()}
                className="h-9 text-sm"
              />
              <Button onClick={handleAddSupplier} size="sm" className="h-9 px-3" disabled={!newSupplierName.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {suppliers.length} Lieferanten · {activeSuppliers.length} aktiv — Standard-Konto/-Kategorie füllen sich bei der Erfassung automatisch vor.
            </p>
            <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
              {suppliers.map(s => (
                <div key={s.id} className={cn(
                  'flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 text-sm border transition-colors',
                  s.active ? 'bg-card border-border' : 'bg-muted/30 border-border/40',
                )}>
                  <span className={cn('min-w-[130px] flex-1', s.active ? 'font-medium' : 'text-muted-foreground/50 line-through text-xs')}>{s.name}</span>
                  {/* Standard-Konto */}
                  <Select
                    value={s.defaultWarenkonto ?? '__none__'}
                    onValueChange={v => handleSupplierDefaults(s, { defaultWarenkonto: v === '__none__' ? undefined : v })}
                  >
                    <SelectTrigger className="h-8 w-[170px] text-xs" data-testid={`supplier-default-konto-${s.id}`}>
                      <SelectValue placeholder="Standard-Konto" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— kein Standard —</SelectItem>
                      {warenkonten.map(k => (
                        <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Standard-Kategorie */}
                  <Select
                    value={s.defaultKategorie ?? '__none__'}
                    onValueChange={v => handleSupplierDefaults(s, { defaultKategorie: v === '__none__' ? undefined : v as WarenKategorie })}
                  >
                    <SelectTrigger className="h-8 w-[120px] text-xs">
                      <SelectValue placeholder="Kategorie" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— keine —</SelectItem>
                      {WARE_KATEGORIEN.map(k => (
                        <SelectItem key={k} value={k}>{k}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-md border transition-colors',
                      s.active ? 'text-muted-foreground border-border hover:bg-muted' : 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100',
                    )}
                    onClick={() => handleToggleSupplier(s)}
                  >
                    {s.active ? 'Deaktivieren' : 'Aktivieren'}
                  </button>
                </div>
              ))}
            </div>

            {/* ── Warenkonten verwalten ─────────────────────────────────────── */}
            <div className="border-t border-border pt-3 space-y-2">
              <h3 className="text-sm font-semibold">Warenkonten ({warenkonten.length})</h3>
              <p className="text-xs text-muted-foreground">
                Frei definierbare Liste pro Restaurant. Entfernte Konten verändern bestehende Buchungen nicht.
                Die Klasse ergibt sich aus der Kontonummer: 4000–{warenGrenze} = Warenkosten (zählen in der WKQ),
                ab {warenGrenze + 1} = Betriebskosten (separat, nicht in der WKQ).
              </p>
              {/* Kontoklassen-Grenze (konfigurierbar, Standard 4070) */}
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Warenkosten bis Konto</Label>
                <Input
                  type="number" min={4000} max={9999} step={1}
                  value={grenzeInput}
                  onChange={e => setGrenzeInput(e.target.value)}
                  className="h-8 text-sm w-[100px]"
                  data-testid="input-waren-grenze"
                />
                <Button
                  size="sm" variant="outline" className="h-8 px-3 text-xs"
                  disabled={!canEdit || Number(grenzeInput) === warenGrenze}
                  data-testid="button-save-waren-grenze"
                  onClick={async () => {
                    const g = Number(grenzeInput);
                    if (!Number.isFinite(g) || g < 4000 || g > 9999) {
                      toast.error('Grenze muss zwischen 4000 und 9999 liegen.'); return;
                    }
                    try {
                      await saveWarenkostenGrenze(tenantId, g);
                      setWarenGrenze(g);
                      toast.success(`Warenkosten-Grenze gespeichert: Konten 4000–${g} zählen in die WKQ.`);
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Speichern fehlgeschlagen.');
                    }
                  }}
                >Grenze speichern</Button>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Nr. (z.B. 4010)"
                  value={newKontoValue}
                  onChange={e => setNewKontoValue(e.target.value)}
                  className="h-9 text-sm w-[110px]"
                />
                <Input
                  placeholder="Bezeichnung (z.B. Fleisch)"
                  value={newKontoLabel}
                  onChange={e => setNewKontoLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddKonto()}
                  className="h-9 text-sm flex-1"
                />
                <Button onClick={handleAddKonto} size="sm" className="h-9 px-3" disabled={!newKontoValue.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1 max-h-[200px] overflow-y-auto pr-1">
                {warenkonten.map(k => (
                  <div key={k.value} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm border border-border bg-card">
                    <span className="text-xs font-medium flex-1">{k.label}</span>
                    <Badge variant="secondary" className={cn('h-5 text-[10px] whitespace-nowrap',
                      kontoKlasse(k.value, warenGrenze) === 'warenkosten'
                        ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
                      {kontoKlasseLabel(kontoKlasse(k.value, warenGrenze))}
                    </Badge>
                    <Select
                      value={k.kategorie ?? kategorieFromKonto(k.value)}
                      onValueChange={v => handleSetKontoKategorie(k.value, v as WarenKategorie)}
                    >
                      <SelectTrigger className="h-7 w-[110px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WARE_KATEGORIEN.map(kat => (
                          <SelectItem key={kat} value={kat}>{kat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      className="text-xs px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
                      onClick={() => handleRemoveKonto(k.value)}
                      title="Konto aus der Auswahl entfernen"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Warengruppe → Konto (CSV-Positionsimport) ── */}
            <div className="border-t border-border/50 pt-4">
              <h3 className="text-sm font-semibold mb-2">Warengruppen → Konto (CSV-Import)</h3>
              <WarengruppenKontenEditor tenantId={tenantId} canEdit={canEdit} />
            </div>

            {/* ── Markt → Lieferant (CSV-Import: Transgourmet/Prodega getrennt) ── */}
            <div className="border-t border-border/50 pt-4">
              <h3 className="text-sm font-semibold mb-2">Markt → Lieferant (CSV-Import)</h3>
              <MarktLieferantenEditor tenantId={tenantId} canEdit={canEdit} />
            </div>

            {/* ── Lieferanten-Profile für PDF-Erkennung (nur Beaulieu) ── */}
            {tenantId === 'beaulieu' && (
              <div className="border-t border-border/50 pt-4">
                <h3 className="text-sm font-semibold mb-2">Lieferanten-Profile (PDF-Erkennung)</h3>
                <LieferantenProfilEditor tenantId={tenantId} canEdit={canEdit} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSupplierDialog(false)}>Schliessen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Positionen einer Rechnung: Konto pro Position (manuell überschreibbar) ── */}
      <Dialog open={positionenDialog !== null} onOpenChange={o => { if (!o) setPositionenDialog(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Rechnungspositionen &amp; Kontierung</DialogTitle>
          </DialogHeader>
          {positionenDialog && (
            <div className="space-y-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left  px-2 py-1.5 font-medium">Artikel</th>
                      <th className="text-left  px-2 py-1.5 font-medium">Warengruppe</th>
                      <th className="text-right px-2 py-1.5 font-medium">Netto</th>
                      <th className="text-left  px-2 py-1.5 font-medium">Konto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positionenDialog.positionen.map((p, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="px-2 py-1 max-w-[220px] truncate" title={p.artNr ? `Art. ${p.artNr}` : undefined}>{p.bezeichnung}</td>
                        <td className="px-2 py-1 text-muted-foreground">{p.status === 'pfand' ? 'Pfand/Gebinde' : p.warengruppe || '—'}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtChf(p.positionspreis)}</td>
                        <td className="px-2 py-1">
                          <Select
                            value={p.konto ?? (p.status === 'pfand' ? KONTO_LABEL_PFAND : KONTO_LABEL_OFFEN)}
                            onValueChange={v => setPositionenDialog(d => d && ({
                              ...d,
                              positionen: d.positionen.map((x, xi) => xi === i
                                ? {
                                    ...x,
                                    konto: v === KONTO_LABEL_PFAND || v === KONTO_LABEL_OFFEN ? null : v,
                                    status: v === KONTO_LABEL_PFAND ? 'pfand' : v === KONTO_LABEL_OFFEN ? 'offen' : 'zugeordnet',
                                    manuell: true,
                                  }
                                : x),
                            }))}
                            disabled={!canEdit}
                          >
                            <SelectTrigger className={cn('h-7 w-[190px] text-xs', p.status === 'offen' && 'border-amber-500/60 text-amber-700 dark:text-amber-400')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {warenkonten.map(k => (
                                <SelectItem key={k.value} value={k.value}>{k.value} · {k.label}</SelectItem>
                              ))}
                              <SelectItem value={KONTO_LABEL_PFAND}>Pfand/Depot (kein Warenkonto)</SelectItem>
                              <SelectItem value={KONTO_LABEL_OFFEN}>Konto offen</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Summe je Konto */}
              <div className="rounded border border-border/50 bg-muted/20 px-3 py-2 text-xs space-y-0.5" data-testid="positionen-konto-summen">
                <p className="font-medium mb-1">Rechnungssumme je Konto (netto):</p>
                {kontoSplitsAusPositionen(positionenDialog.positionen).map(s => (
                  <p key={s.warenkonto} className="flex justify-between tabular-nums">
                    <span className={cn('font-mono', s.warenkonto === KONTO_LABEL_OFFEN && 'text-amber-600 dark:text-amber-400')}>
                      {s.warenkonto === KONTO_LABEL_PFAND ? 'Pfand/Depot' : s.warenkonto === KONTO_LABEL_OFFEN ? 'Konto offen' : s.warenkonto}
                    </span>
                    <span>CHF {fmtChf(s.amountNet)}</span>
                  </p>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPositionenDialog(null)}>Abbrechen</Button>
                {canEdit && (
                  <Button
                    data-testid="positionen-speichern"
                    onClick={async () => {
                      const d = positionenDialog;
                      setPositionenDialog(null);
                      await speicherePositionen(d.invoiceId, d.positionen);
                    }}
                  >Kontierung speichern</Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}

// ── Lieferanten-Zuordnung: Alias-Gruppen-Verwaltung (mandantengetrennt) ──────
//
// Pro kanonischem Lieferanten (Gruppenname) mehrere Namens-Aliasse —
// Erfassungs- UND Buchhaltungs-Schreibweisen. Reine Anzeige-/Abgleich-
// Gruppierung: Rechnungen und Buchungen bleiben unverändert gespeichert.
function AliasGruppenVerwaltung({
  gruppen, onSave,
}: {
  gruppen: AliasGruppe[];
  onSave: (next: AliasGruppe[]) => Promise<void>;
}) {
  const [offen, setOffen] = useState(false);
  const [draft, setDraft] = useState<Array<{ id: string; name: string; aliasesText: string }>>([]);
  const [busy,  setBusy]  = useState(false);

  // Draft bei Öffnen/Änderung des gespeicherten Stands neu initialisieren.
  useEffect(() => {
    setDraft(gruppen.map(g => ({ id: g.id, name: g.name, aliasesText: g.aliases.join(', ') })));
  }, [gruppen, offen]);

  const speichern = async () => {
    const next: AliasGruppe[] = [];
    for (const d of draft) {
      const name = d.name.trim();
      const aliases = d.aliasesText.split(',').map(a => a.trim()).filter(Boolean);
      if (!name && aliases.length === 0) continue; // leere Zeile still verwerfen
      if (!name || aliases.length === 0) {
        toast.error('Jede Gruppe braucht einen Gruppennamen UND mindestens einen Alias.');
        return;
      }
      next.push({ id: d.id, name, aliases });
    }
    setBusy(true);
    try { await onSave(next); } finally { setBusy(false); }
  };

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden" data-testid="alias-gruppen-verwaltung">
      <button
        type="button"
        className="w-full px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2 text-left"
        onClick={() => setOffen(o => !o)}
      >
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Lieferanten-Zuordnung (Alias-Gruppen)</h2>
        <span className="text-xs text-muted-foreground">{gruppen.length} Gruppe{gruppen.length === 1 ? '' : 'n'}</span>
        {offen ? <ChevronDown className="h-4 w-4 ml-auto text-muted-foreground" /> : <ChevronRightSmall className="h-4 w-4 ml-auto text-muted-foreground" />}
      </button>
      {offen && (
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Unterschiedliche Namen aus Erfassung und Buchhaltung werden als EIN Lieferant
            zusammengeführt (nur Anzeige/Abgleich — Rechnungen und Buchungen bleiben unverändert).
            Aliasse kommagetrennt eingeben, z.B. «Prodega, Transgourmet».
          </p>
          {draft.length === 0 && (
            <p className="text-xs text-muted-foreground italic">Keine Gruppen definiert.</p>
          )}
          {draft.map((d, i) => (
            <div key={d.id} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <Input
                value={d.name}
                placeholder="Gruppenname (z.B. Prodega / Transgourmet)"
                onChange={e => setDraft(ds => ds.map((x, xi) => xi === i ? { ...x, name: e.target.value } : x))}
                className="h-8 text-xs sm:w-64"
                data-testid={`alias-gruppe-name-${i}`}
              />
              <Input
                value={d.aliasesText}
                placeholder="Aliasse, kommagetrennt (z.B. Prodega, Transgourmet)"
                onChange={e => setDraft(ds => ds.map((x, xi) => xi === i ? { ...x, aliasesText: e.target.value } : x))}
                className="h-8 text-xs flex-1"
                data-testid={`alias-gruppe-aliases-${i}`}
              />
              <Button
                variant="ghost" size="sm" className="h-8 px-2 text-red-600"
                onClick={() => setDraft(ds => ds.filter((_, xi) => xi !== i))}
                title="Gruppe löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline" size="sm" className="h-8 text-xs"
              onClick={() => setDraft(ds => [...ds, { id: `grp-${Date.now()}-${ds.length}`, name: '', aliasesText: '' }])}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Gruppe hinzufügen
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={speichern} disabled={busy} data-testid="alias-gruppen-speichern">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null} Speichern
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── FIBU-Abgleich-Drilldown: manuelles Matching Rechnungen ↔ Buchungen ───────
//
// N:M-Match-Gruppen (mehrere Rechnungen ↔ mehrere Buchungen), rein zuordnend/
// visuell — keine Beträge werden verändert. Gematchte Zeilen grün mit
// Gruppen-Nummer; Auswahl zeigt live Summen + Differenz-Ampel. Persistiert
// pro Mandant und Monat (waren_fibu_matches_<YYYY-MM>_v1).
function FibuMatchBereich({
  lieferant, invoices, buchungen, state, stateGeladen, toleranz, onToleranzChange, onMutate,
}: {
  lieferant: string;
  invoices: InvoiceEntry[];
  buchungen: SageJournalEntry[];
  state: FibuMatchState;
  /** true = gespeicherter Zustand ist geladen (Auto-Match erst danach). */
  stateGeladen: boolean;
  /** Auto-Match-Toleranz (CHF, pro Mandant). */
  toleranz: number;
  onToleranzChange: (tol: number) => Promise<void>;
  /** Funktionale, serialisierte Mutation; true = erfolgreich persistiert. */
  onMutate: (mutate: (cur: FibuMatchState) => FibuMatchState) => Promise<boolean>;
}) {
  const gruppen = state.gruppen;
  const [selInv,  setSelInv]  = useState<Set<string>>(new Set());
  const [selBuch, setSelBuch] = useState<Set<string>>(new Set());
  const [tolText, setTolText] = useState<string>(String(toleranz));
  useEffect(() => { setTolText(String(toleranz)); }, [toleranz]);

  // Buchungs-Schlüssel mit Duplikat-Index (Anzeige-Reihenfolge).
  const buchKeys = useMemo(() => buchungKeysMitIndex(buchungen), [buchungen]);

  // ── Auto-Match beim Öffnen (nur Ungematchtes + Ungesperrtes; eindeutige
  // Treffer; No-op wenn nichts gefunden). Läuft erneut via Button. ──
  const autoLauf = useCallback((zeigeToast: boolean) => {
    void onMutate(cur => {
      const neue = autoMatchVorschlaege({ invoices, buchungen, keys: buchKeys, state: cur, toleranz });
      if (neue.length === 0) {
        if (zeigeToast) toast.info('Keine eindeutigen Auto-Matches gefunden — Rest bitte manuell zuordnen.');
        return cur; // No-op → kein Save
      }
      if (zeigeToast) toast.success(`${neue.length} Auto-Match${neue.length === 1 ? '' : 'es'} gesetzt.`);
      return { ...cur, gruppen: [...cur.gruppen, ...neue] };
    });
  }, [onMutate, invoices, buchungen, buchKeys, toleranz]);
  const autoGestartet = useRef(false);
  useEffect(() => {
    if (!stateGeladen || autoGestartet.current) return;
    autoGestartet.current = true;
    autoLauf(false); // beim Öffnen still (kein Toast-Spam)
  }, [stateGeladen, autoLauf]);

  // Nur Gruppen, die diesen Lieferanten berühren; Nummerierung 1..n lokal.
  const invIdSet = useMemo(() => new Set(invoices.map(i => i.id)), [invoices]);
  const buchKeySet = useMemo(() => new Set(buchKeys), [buchKeys]);
  const lokaleGruppen = useMemo(
    () => gruppen.filter(g =>
      g.invoiceIds.some(id => invIdSet.has(id)) || g.buchungKeys.some(k => buchKeySet.has(k))),
    [gruppen, invIdSet, buchKeySet],
  );
  const gruppeNrByInv  = useMemo(() => {
    const m = new Map<string, number>();
    lokaleGruppen.forEach((g, i) => g.invoiceIds.forEach(id => m.set(id, i + 1)));
    return m;
  }, [lokaleGruppen]);
  const gruppeNrByKey = useMemo(() => {
    const m = new Map<string, number>();
    lokaleGruppen.forEach((g, i) => g.buchungKeys.forEach(k => m.set(k, i + 1)));
    return m;
  }, [lokaleGruppen]);

  // Übersicht: gematcht X von Y · offen erfasst/gebucht.
  const stat = useMemo(
    () => lieferantMatchStat(invoices, buchungen, buchKeys, lokaleGruppen),
    [invoices, buchungen, buchKeys, lokaleGruppen],
  );

  // Live-Summen der aktuellen Auswahl.
  const selSummen = useMemo(() => {
    const erfasst = invoices.filter(i => selInv.has(i.id)).reduce((s, i) => s + i.amountNet, 0);
    let gebucht = 0;
    buchungen.forEach((b, i) => { if (selBuch.has(buchKeys[i])) gebucht += buchungBetrag(b); });
    return { erfasst, gebucht, diff: gebucht - erfasst, ampel: matchAmpel(erfasst, gebucht, toleranz) };
  }, [invoices, buchungen, buchKeys, selInv, selBuch, toleranz]);

  const toggle = (set: Set<string>, val: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    apply(next);
  };

  const matchen = async () => {
    if (selInv.size === 0 || selBuch.size === 0) return;
    const neue: FibuMatchGruppe = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      invoiceIds: [...selInv],
      buchungKeys: [...selBuch],
      herkunft: 'manuell',
    };
    const ok = await onMutate(cur => ({
      gruppen: [...cur.gruppen, neue],
      // Manuelles Match entsperrt seine Mitglieder wieder (neue Entscheidung).
      gesperrt: {
        invoiceIds: cur.gesperrt.invoiceIds.filter(id => !neue.invoiceIds.includes(id)),
        buchungKeys: cur.gesperrt.buchungKeys.filter(k => !neue.buchungKeys.includes(k)),
      },
    }));
    if (ok) {
      setSelInv(new Set()); setSelBuch(new Set());
      toast.success('Match gespeichert.');
    } // Fehler-Toast kommt aus dem Persist-Pfad; Auswahl bleibt erhalten
  };

  const aufheben = async (gruppeId: string) => {
    const ok = await onMutate(cur => {
      const g = cur.gruppen.find(x => x.id === gruppeId);
      if (!g) return cur;
      return {
        gruppen: cur.gruppen.filter(x => x.id !== gruppeId),
        // Manuell aufgelöste Mitglieder sperren: der Auto-Lauf fasst sie NIE
        // wieder an — manuelle Entscheidung bleibt stehen (manuelles Matchen
        // bleibt möglich und entsperrt wieder).
        gesperrt: {
          invoiceIds: [...new Set([...cur.gesperrt.invoiceIds, ...g.invoiceIds])],
          buchungKeys: [...new Set([...cur.gesperrt.buchungKeys, ...g.buchungKeys])],
        },
      };
    });
    if (ok) toast.success('Match aufgehoben — wird nicht mehr automatisch gematcht.');
  };

  const ampelText = { gruen: 'text-emerald-600 dark:text-emerald-400', gelb: 'text-amber-600 dark:text-amber-400', rot: 'text-red-600 dark:text-red-400' } as const;
  const auswahlAktiv = selInv.size > 0 || selBuch.size > 0;

  return (
    <div className="space-y-3">
      {/* Übersicht: Match-Fortschritt + offener Rest (= ungeklärte Differenz) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground" data-testid={`match-stat-${lieferant}`}>
        <span>gematcht <b className="text-foreground">{stat.matchedInvoices} von {stat.totalInvoices}</b> Rechnungen · <b className="text-foreground">{stat.matchedBuchungen} von {stat.totalBuchungen}</b> Buchungen</span>
        <span>noch offen: erfasst {stat.totalInvoices - stat.matchedInvoices > 0 ? `CHF ${fmtChf(stat.offenErfasst)}` : '—'} / Buchhaltung {stat.totalBuchungen - stat.matchedBuchungen > 0 ? `CHF ${fmtChf(stat.offenGebucht)}` : '—'}</span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            Toleranz CHF
            <Input
              value={tolText}
              onChange={e => setTolText(e.target.value)}
              onBlur={() => {
                const n = Number(tolText.replace(',', '.'));
                if (Number.isFinite(n) && n >= 0 && n !== toleranz) void onToleranzChange(n);
                else setTolText(String(toleranz));
              }}
              className="h-6 w-16 px-1.5 text-[11px] text-right tabular-nums"
              data-testid={`match-toleranz-${lieferant}`}
            />
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            onClick={() => autoLauf(true)} data-testid={`automatch-button-${lieferant}`}>
            Auto-Match neu ausführen
          </Button>
        </span>
      </div>

      {/* Auswahl-Leiste: Live-Summen + Matchen */}
      {auswahlAktiv && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-border/60 bg-muted/20 px-3 py-2 text-xs" data-testid={`match-auswahl-${lieferant}`}>
          <span className="tabular-nums">Auswahl: {selInv.size} Rechnung{selInv.size === 1 ? '' : 'en'} CHF {fmtChf(selSummen.erfasst)} · {selBuch.size} Buchung{selBuch.size === 1 ? '' : 'en'} CHF {fmtChf(selSummen.gebucht)}</span>
          <span className={cn('tabular-nums font-medium', ampelText[selSummen.ampel])}>
            Differenz: CHF {fmtChf(selSummen.diff)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setSelInv(new Set()); setSelBuch(new Set()); }}>
              Auswahl leeren
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={matchen}
              disabled={selInv.size === 0 || selBuch.size === 0}
              data-testid={`match-button-${lieferant}`}>
              <Check className="h-3.5 w-3.5 mr-1" /> Matchen
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        {/* Erfasste Rechnungen */}
        <div>
          <p className="font-medium mb-1.5">Erfasste Rechnungen ({invoices.length})</p>
          {invoices.map(e => {
            const nr = gruppeNrByInv.get(e.id);
            const gematcht = nr !== undefined;
            return (
              <label key={e.id}
                className={cn('flex items-center gap-2 py-0.5 border-b border-border/30 last:border-0 tabular-nums',
                  gematcht ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 rounded px-1 -mx-1' : 'cursor-pointer hover:bg-muted/20')}>
                {gematcht ? (
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <Check className="h-3.5 w-3.5" />
                    <span className="text-[10px] rounded bg-emerald-500/20 px-1">#{nr}</span>
                  </span>
                ) : (
                  <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600 shrink-0"
                    checked={selInv.has(e.id)}
                    onChange={() => toggle(selInv, e.id, setSelInv)}
                    data-testid={`match-inv-${e.id}`} />
                )}
                <span className="flex-1">{fmtDatumCH(e.date)}{e.reference ? ` · ${e.reference}` : ''}</span>
                <span>CHF {fmtChf(e.amountNet)}</span>
              </label>
            );
          })}
          {invoices.length === 0 && <p className="text-muted-foreground">keine</p>}
        </div>
        {/* Buchungen */}
        <div>
          <p className="font-medium mb-1.5">Buchungen ({buchungen.length})</p>
          {buchungen.map((b, bi) => {
            const key = buchKeys[bi];
            const nr = gruppeNrByKey.get(key);
            const gematcht = nr !== undefined;
            return (
              <label key={key}
                className={cn('flex items-center gap-2 py-0.5 border-b border-border/30 last:border-0 tabular-nums',
                  gematcht ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 rounded px-1 -mx-1' : 'cursor-pointer hover:bg-muted/20')}>
                {gematcht ? (
                  <span className="inline-flex items-center gap-1 shrink-0">
                    <Check className="h-3.5 w-3.5" />
                    <span className="text-[10px] rounded bg-emerald-500/20 px-1">#{nr}</span>
                  </span>
                ) : (
                  <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600 shrink-0"
                    checked={selBuch.has(key)}
                    onChange={() => toggle(selBuch, key, setSelBuch)} />
                )}
                <span className="flex-1 truncate max-w-[260px]" title={b.text}>{b.date} · {b.text}</span>
                <span>CHF {fmtChf(buchungBetrag(b))}</span>
              </label>
            );
          })}
          {buchungen.length === 0 && <p className="text-muted-foreground">keine</p>}
        </div>
      </div>

      {/* Match-Gruppen dieses Lieferanten: Summen + Aufheben */}
      {lokaleGruppen.length > 0 && (
        <div className="space-y-1 border-t border-border/40 pt-2">
          {lokaleGruppen.map((g, i) => {
            const erfasst = invoices.filter(x => g.invoiceIds.includes(x.id)).reduce((s, x) => s + x.amountNet, 0);
            let gebucht = 0;
            buchungen.forEach((b, bi) => { if (g.buchungKeys.includes(buchKeys[bi])) gebucht += buchungBetrag(b); });
            const ampel = matchAmpel(erfasst, gebucht, toleranz);
            const diffAbs = Math.abs(gebucht - erfasst);
            return (
              <div key={g.id} className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
                <span className="rounded bg-emerald-500/20 px-1 text-emerald-700 dark:text-emerald-400">#{i + 1}</span>
                <span className={cn('rounded px-1 text-[10px] uppercase tracking-wide',
                  g.herkunft === 'auto' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400' : 'bg-muted text-muted-foreground')}>
                  {g.herkunft === 'auto' ? 'auto' : 'manuell'}
                </span>
                <span>{g.invoiceIds.filter(id => invIdSet.has(id)).length} Rechnung(en) CHF {fmtChf(erfasst)} ↔ {g.buchungKeys.filter(k => buchKeySet.has(k)).length} Buchung(en) CHF {fmtChf(gebucht)}</span>
                {/* Rest-Differenz: 0 = nur grünes Häkchen; >0 innerhalb Toleranz = grün mit Betrag */}
                {diffAbs < 0.005
                  ? <Check className={cn('h-3 w-3', ampelText.gruen)} />
                  : <span className={cn('font-medium inline-flex items-center gap-0.5', ampelText[ampel])}>
                      {ampel === 'gruen' && <Check className="h-3 w-3" />}Diff CHF {fmtChf(gebucht - erfasst)}
                    </span>}
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => aufheben(g.id)} data-testid={`match-aufheben-${g.id}`}>
                  <X className="h-3 w-3 mr-0.5" /> Match aufheben
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
