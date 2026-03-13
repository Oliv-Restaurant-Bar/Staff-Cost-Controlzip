/**
 * Reporting / Finanzmodul
 * ========================
 * Fundament-Phase:
 *   - Jahresübersicht mit Monat-für-Monat-Tabelle
 *   - Manuelle Datenerfassung pro Monat
 *   - Vollständigkeitsanzeige pro Monat
 *   - Platzhalter für spätere PDF/CSV-Importe
 *   - Nur für Admin zugänglich
 *
 * Noch nicht implementiert (nächste Phasen):
 *   - PDF-Parsing / OCR-Import
 *   - Export-Funktion (Excel/PDF)
 *   - Mehrjahresvergleich
 */

import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Plus,
  Edit3, Upload, CheckCircle2, AlertCircle, Clock,
  Info, Save, X, FileText, BarChart2, RefreshCw, Settings2,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, Legend, ReferenceLine, ComposedChart,
  Line, Cell,
} from 'recharts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  MonthlyFinancialRecord,
  MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE,
  calcCompleteness,
} from '@/types/reporting';
import {
  loadYear, saveMonth, availableYears,
  calcAnnualSummary, formatCHF, formatMonthLabel,
} from '@/lib/reporting-store';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

function varianceColor(actual?: number, budget?: number): string {
  if (!actual || !budget) return '';
  const pct = ((actual - budget) / budget) * 100;
  if (pct >= 0) return 'text-green-600 dark:text-green-400';
  if (pct >= -5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatVariance(actual?: number, previous?: number): string {
  if (!actual || !previous) return '';
  const pct = ((actual - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %`;
}

// ─── Chart-Datenaufbereitung ──────────────────────────────────────────────────

interface ChartRow {
  monat: string;
  umsatzIst:     number | null;
  umsatzBudget:  number | null;
  umsatzVorjahr: number | null;
  pkIst:         number | null;
  pkGeplant:     number | null;
  pkQuote:       number | null; // Personalkosten / Umsatz Ist in %
}

function buildChartData(months: MonthlyFinancialRecord[]): ChartRow[] {
  return months.map(m => {
    const pkQuote =
      m.personnelCostActual && m.revenueActual && m.revenueActual > 0
        ? parseFloat(((m.personnelCostActual / m.revenueActual) * 100).toFixed(1))
        : null;
    return {
      monat:        MONTH_NAMES_SHORT_DE[m.month],
      umsatzIst:    m.revenueActual        ?? null,
      umsatzBudget: m.revenueBudget        ?? null,
      umsatzVorjahr:m.revenuePreviousYear  ?? null,
      pkIst:        m.personnelCostActual  ?? null,
      pkGeplant:    m.personnelCostPlanned ?? null,
      pkQuote,
    };
  });
}

/** CHF-Tooltip-Formatter */
const chfFormatter = (value: number | null) =>
  value != null
    ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value)
    : '–';

/** Custom Tooltip für CHF-Charts */
const ChfTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="font-bold text-foreground mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold">{chfFormatter(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

/** Custom Tooltip für Prozent-Charts */
const PctTooltip = ({ active, payload, label, threshold }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; threshold: number }) => {
  if (!active || !payload?.length) return null;
  const ratio = payload.find(p => p.name === 'PK-Quote');
  return (
    <div className="bg-card border border-border shadow-lg rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="font-bold text-foreground mb-1">{label}</p>
      {ratio && (
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: ratio.color }} />
          <span className="text-muted-foreground">PK-Quote:</span>
          <span className="font-semibold">{ratio.value.toFixed(1)} %</span>
          <span className={cn('font-bold', ratio.value <= threshold ? 'text-green-600' : 'text-red-600')}>
            {ratio.value <= threshold ? '✓' : '↑'}
          </span>
        </div>
      )}
      <div className="text-muted-foreground/70">Ziel: ≤ {threshold} %</div>
    </div>
  );
};

const AXIS_STYLE = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const GRID_STROKE = 'hsl(var(--border))';

// Farben
const C_ACTUAL   = '#4f46e5'; // indigo-600
const C_BUDGET   = '#d97706'; // amber-600
const C_PREV     = '#94a3b8'; // slate-400
const C_PK       = '#ea580c'; // orange-600
const C_GREEN    = '#16a34a'; // green-600
const C_AMBER    = '#d97706'; // amber-600
const C_RED      = '#dc2626'; // red-600

/** Balkenfarbe für PK-Quote je nach Schwellenwert */
function pkBarColor(value: number | null, threshold: number): string {
  if (!value) return C_PREV;
  if (value <= threshold - 2) return C_GREEN;
  if (value <= threshold + 2) return C_AMBER;
  return C_RED;
}

// ─── Diagramm 1: Umsatzvergleich ─────────────────────────────────────────────

interface ChartProps { data: ChartRow[]; threshold: number }

const NoDataOverlay = ({ message }: { message: string }) => (
  <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground/60 italic">
    {message}
  </div>
);

const RevenueComparisonChart = ({ data }: ChartProps) => {
  const hasData = data.some(d => d.umsatzIst || d.umsatzBudget || d.umsatzVorjahr);
  if (!hasData) return <NoDataOverlay message="Noch keine Umsatzdaten vorhanden – bitte Monate erfassen." />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} barGap={2} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="monat" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip content={<ChfTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />
        <Legend
          iconType="square" iconSize={10}
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>}
        />
        <Bar dataKey="umsatzIst"     name="Umsatz Ist"    fill={C_ACTUAL} radius={[3,3,0,0]} />
        <Bar dataKey="umsatzBudget"  name="Budget"        fill={C_BUDGET} radius={[3,3,0,0]} />
        <Bar dataKey="umsatzVorjahr" name="Vorjahr"       fill={C_PREV}   radius={[3,3,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Diagramm 2: PK-Quote-Verlauf ────────────────────────────────────────────

const PKRatioChart = ({ data, threshold }: ChartProps) => {
  const hasData = data.some(d => d.pkQuote !== null);
  if (!hasData) return <NoDataOverlay message="Noch keine PK-Quote berechenbar – bitte Umsatz und Personalkosten erfassen." />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="monat" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={44}
          tickFormatter={v => `${v}%`}
          domain={[0, Math.max(threshold + 10, 45)]}
        />
        <ReTooltip content={<PctTooltip threshold={threshold} />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />

        {/* Ziellinie */}
        <ReferenceLine
          y={threshold}
          stroke={C_RED}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{
            value: `Ziel ${threshold}%`,
            position: 'insideTopRight',
            fontSize: 10,
            fill: C_RED,
            dy: -4,
          }}
        />

        {/* PK-Quote als farbige Balken */}
        <Bar dataKey="pkQuote" name="PK-Quote" radius={[3,3,0,0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={pkBarColor(entry.pkQuote, threshold)} />
          ))}
        </Bar>

        {/* Verbindungslinie zwischen Balken */}
        <Line
          dataKey="pkQuote"
          name="PK-Quote"
          dot={{ r: 3, fill: C_ACTUAL, stroke: 'white', strokeWidth: 1.5 }}
          stroke={C_ACTUAL}
          strokeWidth={2}
          connectNulls
          legendType="none"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ─── Diagramm 3: Umsatz vs. Personalkosten ───────────────────────────────────

const RevenuePKChart = ({ data }: ChartProps) => {
  const hasData = data.some(d => d.umsatzIst || d.pkIst);
  if (!hasData) return <NoDataOverlay message="Noch keine Daten für dieses Diagramm vorhanden." />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} barGap={3} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="monat" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip content={<ChfTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />
        <Legend
          iconType="square" iconSize={10}
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>}
        />
        <Bar dataKey="umsatzIst" name="Umsatz Ist"       fill={C_ACTUAL} radius={[3,3,0,0]} />
        <Bar dataKey="pkIst"     name="Personalkosten"   fill={C_PK}     radius={[3,3,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Vollständigkeits-Badge ───────────────────────────────────────────────────

const CompletenessBadge = ({ pct }: { pct: number }) => {
  if (pct === 100) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-600">
      <CheckCircle2 className="h-3 w-3" /> Vollständig
    </span>
  );
  if (pct >= 50) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600">
      <Clock className="h-3 w-3" /> {pct} %
    </span>
  );
  if (pct > 0) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
      <AlertCircle className="h-3 w-3" /> {pct} %
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
      <Clock className="h-3 w-3" /> Leer
    </span>
  );
};

// ─── Manuelle Erfassung – Dialog ──────────────────────────────────────────────

interface EntryDialogProps {
  record: MonthlyFinancialRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const EntryDialog = ({ record, onClose, onSaved }: EntryDialogProps) => {
  if (!record) return null;

  const [revenueActual,         setRevenueActual]         = useState(record.revenueActual?.toString() ?? '');
  const [revenueBudget,         setRevenueBudget]         = useState(record.revenueBudget?.toString() ?? '');
  const [revenuePreviousYear,   setRevenuePreviousYear]   = useState(record.revenuePreviousYear?.toString() ?? '');
  const [personnelActual,       setPersonnelActual]       = useState(record.personnelCostActual?.toString() ?? '');
  const [personnelPlanned,      setPersonnelPlanned]      = useState(record.personnelCostPlanned?.toString() ?? '');
  const [personnelPreviousYear, setPersonnelPreviousYear] = useState(record.personnelCostPreviousYear?.toString() ?? '');
  const [note,                  setNote]                  = useState('');
  const [saving,                setSaving]                = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const parse = (v: string) => {
      const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? undefined : n;
    };
    saveMonth(
      {
        year:                    record.year,
        month:                   record.month,
        revenueActual:           parse(revenueActual),
        revenueBudget:           parse(revenueBudget),
        revenuePreviousYear:     parse(revenuePreviousYear),
        personnelCostActual:     parse(personnelActual),
        personnelCostPlanned:    parse(personnelPlanned),
        personnelCostPreviousYear: parse(personnelPreviousYear),
      },
      'manual',
      'update',
      { note: note || undefined },
    );
    setSaving(false);
    toast.success(`${formatMonthLabel(record.year, record.month)} gespeichert`);
    onSaved();
    onClose();
  };

  const isFuture = record.year > currentYear ||
    (record.year === currentYear && record.month > currentMonth);

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit3 className="h-4 w-4" />
            {formatMonthLabel(record.year, record.month)}
          </DialogTitle>
          <DialogDescription>
            Manuelle Datenerfassung. Leere Felder werden nicht überschrieben.
          </DialogDescription>
        </DialogHeader>

        {isFuture && (
          <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            Zukunftsmonat – hier können Budgetwerte eingetragen werden.
          </div>
        )}

        <div className="space-y-5 py-2">
          {/* Umsatz */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Umsatz (CHF)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <NumberField label="Tatsächlich" value={revenueActual} onChange={setRevenueActual} />
              <NumberField label="Budget"      value={revenueBudget} onChange={setRevenueBudget} />
              <NumberField label="Vorjahr"     value={revenuePreviousYear} onChange={setRevenuePreviousYear} />
            </div>
          </section>

          {/* Personalkosten */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Personalkosten (CHF)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <NumberField label="Tatsächlich" value={personnelActual}       onChange={setPersonnelActual} />
              <NumberField label="Geplant"     value={personnelPlanned}      onChange={setPersonnelPlanned} />
              <NumberField label="Vorjahr"     value={personnelPreviousYear} onChange={setPersonnelPreviousYear} />
            </div>
          </section>

          {/* Ausgabenkategorien – Platzhalter */}
          <section className="rounded-md border border-dashed border-muted-foreground/30 p-3">
            <div className="flex items-start gap-2">
              <Upload className="h-4 w-4 text-muted-foreground/50 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-muted-foreground">
                  Ausgabenkategorien
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Wird später aus Buchhaltungsexport (PDF/CSV) importiert.
                  Pro Kategorie: kein Duplikat bei mehrfachem Import.
                </p>
                {record.expenseCategories.length > 0 && (
                  <p className="text-[11px] text-green-600 mt-1">
                    {record.expenseCategories.length} Kategorien bereits vorhanden
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* Notiz */}
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Notiz zum Eintrag</Label>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="z.B. Hochsaison, Umbau, Sonderveranstaltung…"
              className="text-sm resize-none min-h-[60px]"
            />
          </div>

          {/* Import-Protokoll */}
          {record.imports.length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Importverlauf ({record.imports.length})
              </h3>
              <ul className="space-y-1">
                {record.imports.slice(-5).map(imp => (
                  <li key={imp.importId} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                    <span>{new Date(imp.importedAt).toLocaleString('de-CH')}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                      {imp.source === 'manual' ? 'Manuell' : imp.source}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                      {imp.mode === 'replace' ? 'Ersetzt' : 'Update'}
                    </Badge>
                    {imp.note && <span className="italic truncate max-w-[120px]">{imp.note}</span>}
                  </li>
                ))}
                {record.imports.length > 5 && (
                  <li className="text-[11px] text-muted-foreground/60">
                    … und {record.imports.length - 5} weitere Einträge
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            <X className="h-3.5 w-3.5 mr-1" /> Abbrechen
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5 mr-1" />
            {saving ? 'Speichern…' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Hilfkomponente: Zahlenfeld ───────────────────────────────────────────────

const NumberField = ({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) => (
  <div>
    <Label className="text-[10px] text-muted-foreground mb-0.5 block">{label}</Label>
    <Input
      type="number"
      min="0"
      step="100"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="–"
      className="h-8 text-sm"
    />
  </div>
);

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const Reporting = () => {
  const { isAdmin, canAccessSettings } = usePermissions();

  // Route-Schutz
  if (!isAdmin) return <Navigate to="/" replace />;

  const years       = availableYears();
  const [year, setYear]           = useState(currentYear);
  const [months, setMonths]       = useState<MonthlyFinancialRecord[]>(() => loadYear(year));
  const [editRecord, setEditRecord] = useState<MonthlyFinancialRecord | null>(null);

  const summary = useMemo(() => calcAnnualSummary(year), [year, months]);
  const chartData = useMemo(() => buildChartData(months), [months]);
  const threshold = useMemo(
    () => parseInt(localStorage.getItem('labor_cost_threshold') || '35'),
    [],
  );

  const reload = useCallback(() => {
    setMonths(loadYear(year));
  }, [year]);

  const handleYearChange = (y: number) => {
    setYear(y);
    setMonths(loadYear(y));
  };

  const hasAnyData = months.some(m =>
    m.revenueActual !== undefined || m.personnelCostActual !== undefined
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm flex-shrink-0">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">Dashboard</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Reporting
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20">
              Admin
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {/* Kontenplan-Link */}
            <Link to="/kontenplan">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
                <Settings2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Kontenplan</span>
              </Button>
            </Link>

            {/* Jahr-Selector */}
            <Select value={String(year)} onValueChange={v => handleYearChange(Number(v))}>
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant="outline" size="sm" className="h-8" onClick={reload}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-5 space-y-5 pb-20">

        {/* Fundament-Hinweis */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 p-4 flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-blue-800 dark:text-blue-300 space-y-1">
            <p className="font-bold">Fundament-Phase – Reporting im Aufbau</p>
            <p>
              Monatsdaten können jetzt manuell erfasst werden. In der nächsten Phase
              werden Buchhaltungsexporte (PDF/CSV) automatisch eingelesen und den
              richtigen Monaten zugeordnet – ohne Duplikate.
            </p>
          </div>
        </div>

        {/* Jahresübersicht-Karten */}
        {hasAnyData && (
          <section>
            <h2 className="text-sm font-bold mb-3">Jahresübersicht {year}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label="Umsatz Ist"
                value={formatCHF(summary.totalRevenueActual)}
                sub={summary.totalRevenueBudget > 0
                  ? `Budget: ${formatCHF(summary.totalRevenueBudget)}`
                  : undefined}
                color="blue"
              />
              <SummaryCard
                label="Personalkosten Ist"
                value={formatCHF(summary.totalPersonnelCostActual)}
                sub={summary.totalPersonnelCostPlanned > 0
                  ? `Geplant: ${formatCHF(summary.totalPersonnelCostPlanned)}`
                  : undefined}
                color="orange"
              />
              <SummaryCard
                label="PK-Quote"
                value={summary.totalRevenueActual > 0
                  ? `${summary.personnelCostRatio.toFixed(1)} %`
                  : '–'}
                sub="Personalkosten / Umsatz"
                color={summary.personnelCostRatio > 35 ? 'red' : 'green'}
              />
              <SummaryCard
                label="Monate mit Daten"
                value={`${summary.monthsWithData} / 12`}
                sub={`Jahr ${year}`}
                color="gray"
              />
            </div>
          </section>
        )}

        {/* ── Diagramme ─────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-sm font-bold">Diagramme {year}</h2>

          {/* Diagramm 1: Umsatzvergleich */}
          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-muted-foreground" />
                Umsatzvergleich – Ist / Budget / Vorjahr
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Zeigt, welche Monate über oder unter Budget lagen und wie das Jahr im Vorjahresvergleich abschneidet.
              </p>
            </CardHeader>
            <CardContent className="pt-0 pr-2">
              <RevenueComparisonChart data={chartData} threshold={threshold} />
            </CardContent>
          </Card>

          {/* Diagramm 2: PK-Quote */}
          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                Personalkosten-Quote pro Monat
                <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                  Ziel: ≤ {threshold} %
                </span>
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                <span className="inline-flex items-center gap-1 text-green-600 font-medium">■ Grün</span> = unter Ziel ·
                <span className="inline-flex items-center gap-1 text-amber-600 font-medium ml-2">■ Gelb</span> = nahe Ziel ·
                <span className="inline-flex items-center gap-1 text-red-600 font-medium ml-2">■ Rot</span> = über Ziel
              </p>
            </CardHeader>
            <CardContent className="pt-0 pr-2">
              <PKRatioChart data={chartData} threshold={threshold} />
            </CardContent>
          </Card>

          {/* Diagramm 3: Umsatz vs. Personalkosten */}
          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-muted-foreground" />
                Umsatz vs. Personalkosten
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Zeigt, ob Personalkosten schneller wachsen als der Umsatz – wichtig für die Wirtschaftlichkeit.
              </p>
            </CardHeader>
            <CardContent className="pt-0 pr-2">
              <RevenuePKChart data={chartData} threshold={threshold} />
            </CardContent>
          </Card>
        </section>

        {/* Monatstabelle */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold">Monatsdaten {year}</h2>
            <p className="text-xs text-muted-foreground">
              Klick auf «Erfassen» um Daten einzugeben
            </p>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground w-24">Monat</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Umsatz Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Budget</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Vorjahr</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK Geplant</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Ausgaben</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">Vollst.</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground w-20">Aktion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {months.map(m => {
                    const completeness = calcCompleteness(m);
                    const isEmpty = !m.revenueActual && !m.revenueBudget &&
                      !m.personnelCostActual && !m.personnelCostPlanned &&
                      m.expenseCategories.length === 0;
                    const isCurrent = m.year === currentYear && m.month === currentMonth;
                    const isFuture  = m.year > currentYear ||
                      (m.year === currentYear && m.month > currentMonth);

                    return (
                      <tr
                        key={m.id}
                        className={cn(
                          'hover:bg-muted/30 transition-colors',
                          isCurrent && 'bg-primary/5',
                          isEmpty && 'opacity-60',
                        )}
                      >
                        <td className="px-3 py-2.5 font-semibold">
                          <span className={cn(isCurrent && 'text-primary')}>
                            {MONTH_NAMES_SHORT_DE[m.month]}
                          </span>
                          {isCurrent && (
                            <span className="ml-1 text-[9px] text-primary font-bold">●</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          {m.revenueActual !== undefined
                            ? <span className={varianceColor(m.revenueActual, m.revenueBudget)}>
                                {formatCHF(m.revenueActual)}
                              </span>
                            : <span className="text-muted-foreground/40">–</span>
                          }
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          {m.revenueBudget !== undefined ? formatCHF(m.revenueBudget) : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          {m.revenuePreviousYear !== undefined
                            ? <>
                                {formatCHF(m.revenuePreviousYear)}
                                {m.revenueActual && (
                                  <span className="ml-1 text-[9px]">
                                    {formatVariance(m.revenueActual, m.revenuePreviousYear)}
                                  </span>
                                )}
                              </>
                            : '–'
                          }
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          {m.personnelCostActual !== undefined
                            ? formatCHF(m.personnelCostActual)
                            : <span className="text-muted-foreground/40">–</span>
                          }
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          {m.personnelCostPlanned !== undefined ? formatCHF(m.personnelCostPlanned) : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {m.expenseCategories.length > 0
                            ? <span className="text-green-600 font-semibold">
                                {m.expenseCategories.length}
                              </span>
                            : <span className="text-muted-foreground/40">–</span>
                          }
                          {m.expenseCategoriesPreviousYear.length > 0 && (
                            <span className="text-muted-foreground/60 text-[9px] ml-1">
                              VJ:{m.expenseCategoriesPreviousYear.length}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <CompletenessBadge pct={completeness.completenessPercent} />
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => setEditRecord(m)}
                          >
                            {isEmpty ? (
                              <><Plus className="h-3 w-3 mr-0.5" /> Erfassen</>
                            ) : (
                              <><Edit3 className="h-3 w-3 mr-0.5" /> Bearbeiten</>
                            )}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Zukünftige Import-Abschnitte (Platzhalter) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Aktuelles Jahr importieren */}
          <Card className="border-dashed border-2 border-muted-foreground/20">
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <Upload className="h-4 w-4" />
                Buchhaltungsimport – Laufendes Jahr
                <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20 ml-auto">
                  Geplant
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 space-y-2">
              <p className="text-xs text-muted-foreground">
                PDF oder CSV aus dem Buchhaltungsprogramm hochladen.
                Das System erkennt den Monat automatisch und fragt,
                ob die Daten ersetzt oder ergänzt werden sollen.
              </p>
              <ImportModeInfo />
              <Button variant="outline" size="sm" className="w-full h-8 text-xs border-dashed" disabled>
                <FileText className="h-3.5 w-3.5 mr-1.5" /> Datei hochladen (kommt bald)
              </Button>
            </CardContent>
          </Card>

          {/* Vorjahr importieren */}
          <Card className="border-dashed border-2 border-muted-foreground/20">
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <BarChart2 className="h-4 w-4" />
                Vorjahresdaten importieren
                <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20 ml-auto">
                  Geplant
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 space-y-2">
              <p className="text-xs text-muted-foreground">
                Buchhaltungsabschluss des Vorjahres als PDF oder CSV hochladen.
                Wird separat gespeichert – kein Überschreiben der Ist-Daten.
              </p>
              <ImportModeInfo />
              <Button variant="outline" size="sm" className="w-full h-8 text-xs border-dashed" disabled>
                <FileText className="h-3.5 w-3.5 mr-1.5" /> Vorjahresdatei hochladen (kommt bald)
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* Technische Struktur – nur zur Orientierung */}
        <section className="rounded-lg border border-muted-foreground/20 bg-muted/20 p-4 space-y-2">
          <h3 className="text-xs font-bold flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
            Datenstruktur (Übersicht)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px] text-muted-foreground">
            <div>
              <p className="font-semibold text-foreground mb-1">Pro Monat gespeichert:</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>Umsatz: Ist / Budget / Vorjahr</li>
                <li>Personalkosten: Ist / Geplant / Vorjahr</li>
                <li>Ausgabenkategorien (laufendes Jahr)</li>
                <li>Ausgabenkategorien Vorjahr (separat)</li>
                <li>Importverlauf mit Zeitstempel & Quelle</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-foreground mb-1">Duplikate-Schutz:</p>
              <ul className="space-y-0.5 list-disc list-inside">
                <li>Eindeutige Monats-ID: «YYYY-MM»</li>
                <li>Modus «Ersetzen»: Monat komplett überschreiben</li>
                <li>Modus «Aktualisieren»: nur geänderte Felder mergen</li>
                <li>Ausgabenkategorien: kein Duplikat pro Kategorie-ID</li>
              </ul>
            </div>
          </div>
        </section>

      </div>

      {/* Erfassungs-Dialog */}
      {editRecord && (
        <EntryDialog
          record={editRecord}
          onClose={() => setEditRecord(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
};

// ─── Zusammenfassungs-Karte ───────────────────────────────────────────────────

type SummaryColor = 'blue' | 'green' | 'orange' | 'red' | 'gray';

const COLOR_MAP: Record<SummaryColor, string> = {
  blue:   'border-blue-200 bg-blue-50 dark:bg-blue-950/20',
  green:  'border-green-200 bg-green-50 dark:bg-green-950/20',
  orange: 'border-orange-200 bg-orange-50 dark:bg-orange-950/20',
  red:    'border-red-200 bg-red-50 dark:bg-red-950/20',
  gray:   'border-border bg-muted/30',
};

const SummaryCard = ({
  label, value, sub, color = 'gray',
}: { label: string; value: string; sub?: string; color?: SummaryColor }) => (
  <Card className={cn('border', COLOR_MAP[color])}>
    <CardContent className="p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </CardContent>
  </Card>
);

// ─── Import-Modus-Info ────────────────────────────────────────────────────────

const ImportModeInfo = () => (
  <div className="rounded bg-muted/50 border border-border p-2 text-[10px] text-muted-foreground space-y-1">
    <p><span className="font-semibold text-foreground">Ersetzen:</span> Gesamten Monat neu importieren</p>
    <p><span className="font-semibold text-foreground">Aktualisieren:</span> Nur neue/geänderte Positionen übernehmen</p>
  </div>
);

export default Reporting;
