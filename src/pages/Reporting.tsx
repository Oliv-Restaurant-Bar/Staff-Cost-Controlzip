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

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Plus,
  Edit3, Upload, CheckCircle2, AlertCircle, Clock,
  Info, Save, X, FileText, BarChart2, RefreshCw, Settings2, AlertTriangle,
  FileDown, FileSpreadsheet, UserX, Palmtree, Stethoscope,
} from 'lucide-react';
import { eachDayOfInterval, startOfMonth, endOfMonth } from 'date-fns';
import {
  computeAbsenceEvents, resolveAbsenceEvent, summarizeAbsences,
  loadAbsenceOverrides,
} from '@/lib/absence-utils';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/lib/supabase-db';
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
import { loadBudgetWithPL, resolveBudgetYear } from '@/lib/budget-store';
import {
  exportReportingToPDF, exportReportingToExcel, calcEffectiveTotals,
} from '@/lib/reporting-export';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';
import { parseAnnualRevenueXLSX, AnnualImportResult } from '@/lib/annual-revenue-import';
import { useStichtag } from '@/contexts/StichtagContext';
import { StichtagBanner } from '@/components/StichtagBanner';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const currentYear = new Date().getFullYear();

/** Summiert ein Tagesdaten-Feld (z.B. actualRevenue) für einen bestimmten Monat */
function sumDailyBudgetField(
  db: Record<string, Record<string, number>>,
  yr: number,
  mo: number,
  field: string,
): number {
  const daysInMonth = new Date(yr, mo, 0).getDate();
  let sum = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    sum += (db[key]?.[field] as number) ?? 0;
  }
  return sum;
}
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

// ─── Absenzen-Controlling-Block ───────────────────────────────────────────────

const AbsenzMonatsBlock = ({ year }: { year: number }) => {
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem('schedule-employees');
      if (raw) setEmployees(JSON.parse(raw));
    } catch { setEmployees([]); }
  }, []);

  useEffect(() => {
    const key = `schedule-v2-${year}-${String(selectedMonth).padStart(2, '0')}`;
    try {
      const raw = localStorage.getItem(key);
      setScheduleData(raw ? JSON.parse(raw) : {});
    } catch { setScheduleData({}); }
  }, [year, selectedMonth]);

  const summary = useMemo(() => {
    if (employees.length === 0) return null;
    const monthDate = new Date(year, selectedMonth - 1, 1);
    const days = eachDayOfInterval({ start: startOfMonth(monthDate), end: endOfMonth(monthDate) });
    const overrides = loadAbsenceOverrides();
    const events = computeAbsenceEvents(employees, scheduleData, {}, days);
    if (events.length === 0) return null;
    const resolved = events.map(ev => resolveAbsenceEvent(ev, overrides, employees, scheduleData, {}));
    return summarizeAbsences(resolved);
  }, [employees, scheduleData, year, selectedMonth]);

  return (
    <Card>
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <UserX className="h-4 w-4 text-muted-foreground" />
            Absenzen-Controlling · Ersatzkosten
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(selectedMonth)} onValueChange={v => setSelectedMonth(Number(v))}>
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES_DE.slice(1).map((label, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link to="/absenzen">
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <ChevronRight className="h-3.5 w-3.5" />
                Detail
              </Button>
            </Link>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Ferienabsenzen und Krankheitstage fixer Mitarbeiter · automatisch aus Dienstplan {year} berechnet
        </p>
      </CardHeader>
      <CardContent className="pt-2 pb-4">
        {!summary ? (
          <div className="h-16 flex items-center justify-center text-xs text-muted-foreground/60 italic">
            Keine Absenzen in {MONTH_NAMES_DE[selectedMonth]} {year} erkannt — bitte Codes «FE» oder «K» im Dienstplan eintragen.
          </div>
        ) : (
          <div className="space-y-3">
            {/* ── 5 KPI tiles ── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="rounded-lg border bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-3 space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  <Palmtree className="h-3 w-3" />
                  Ferienersatz
                </div>
                <div className="text-xl font-bold tabular-nums font-mono">CHF {summary.vacationCost.toFixed(0)}</div>
                <div className="text-[10px] text-muted-foreground">{summary.vacationDays} Ferientage</div>
              </div>
              <div className="rounded-lg border bg-blue-50/60 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 p-3 space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide">
                  <Stethoscope className="h-3 w-3" />
                  Krankheitsersatz
                </div>
                <div className="text-xl font-bold tabular-nums font-mono">CHF {summary.sickCost.toFixed(0)}</div>
                <div className="text-[10px] text-muted-foreground">{summary.sickDays} Kranktage</div>
              </div>
              <div className="rounded-lg border bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800 p-3 space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
                  <UserX className="h-3 w-3" />
                  Total Ersatz
                </div>
                <div className="text-xl font-bold tabular-nums font-mono">CHF {summary.totalCost.toFixed(0)}</div>
                <div className="text-[10px] text-muted-foreground">Zusatzkosten Absenzen</div>
              </div>
              <div className="rounded-lg border bg-green-50/60 dark:bg-green-950/20 border-green-200 dark:border-green-800 p-3 space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-green-700 dark:text-green-400 uppercase tracking-wide">
                  <TrendingUp className="h-3 w-3" />
                  Einsparung
                </div>
                <div className="text-xl font-bold tabular-nums font-mono">CHF {summary.totalSaving.toFixed(0)}</div>
                <div className="text-[10px] text-muted-foreground">Nicht ersetzte Std.</div>
              </div>
              <div className="rounded-lg border bg-muted/40 border-border p-3 space-y-0.5">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Nicht ersetzt
                </div>
                <div className="text-xl font-bold tabular-nums">{summary.unreplacedHrs.toFixed(1)} h</div>
                <div className="text-[10px] text-muted-foreground">Offene Abwesenheitsstunden</div>
              </div>
            </div>

            {/* ── Dept split: Service / Küche ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                { key: 'service' as const, label: 'Service', color: 'indigo' },
                { key: 'küche'   as const, label: 'Küche',   color: 'orange' },
              ] as const).map(({ key, label, color }) => {
                const d = summary.byDept[key];
                if (d.days === 0) return null;
                const borderCls = color === 'indigo'
                  ? 'border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/20'
                  : 'border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/20';
                const headCls = color === 'indigo'
                  ? 'text-indigo-700 dark:text-indigo-400'
                  : 'text-orange-700 dark:text-orange-400';
                return (
                  <div key={key} className={`rounded-lg border p-3 space-y-2 ${borderCls}`}>
                    <div className={`text-xs font-semibold uppercase tracking-wide ${headCls}`}>{label}</div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <div className="text-[10px] text-muted-foreground">Absenztage</div>
                        <div className="font-bold text-sm">{d.days}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">Ersatzkosten</div>
                        <div className="font-bold text-sm font-mono">
                          {d.cost > 0 ? `CHF ${d.cost.toFixed(0)}` : '–'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground">Einsparung</div>
                        <div className="font-bold text-sm font-mono text-green-600 dark:text-green-400">
                          {d.saving > 0 ? `CHF ${d.saving.toFixed(0)}` : '–'}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const Reporting = () => {
  const { isAdmin, canAccessSettings } = usePermissions();

  // Route-Schutz
  if (!isAdmin) return <Navigate to="/" replace />;

  const { isInScope, isActive: stichtagActive } = useStichtag();
  const years       = availableYears();
  const [year, setYear]               = useState(currentYear);
  const [months, setMonths]           = useState<MonthlyFinancialRecord[]>(() => loadYear(year));
  const [editRecord, setEditRecord]   = useState<MonthlyFinancialRecord | null>(null);
  const [highlightVariance, setHighlightVariance] = useState(false);

  // Nach Supabase-Sync Daten neu laden
  useEffect(() => {
    const handler = () => setMonths(loadYear(year));
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  }, [year]);

  // Gastronovi-Tagesdaten aus localStorage (gleiche Logik wie Erfolgsrechnung)
  const dailyBudgetsData = useMemo<Record<string, Record<string, number>>>(() => {
    try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
    catch { return {}; }
  }, [year, months]);

  // Budget-Daten aus budget_v1 (Jahresplanung)
  const resolvedBudget = useMemo(() => {
    try { return resolveBudgetYear(loadBudgetWithPL(year)); }
    catch { return null; }
  }, [year]);

  // Vorjahres-Reporting-Daten als Fallback für revenuePreviousYear
  const prevYearMonths = useMemo(() => {
    try { return loadYear(year - 1); }
    catch { return [] as MonthlyFinancialRecord[]; }
  }, [year]);

  // Effektive Monatsdaten: Fallbacks für Umsatz-Ist, Budget, Vorjahr, PK Ist
  const effectiveMonths = useMemo<MonthlyFinancialRecord[]>(() => {
    const findBudget = (id: string) => resolvedBudget?.positions.find(p => p.position.id === id);
    const revBudgetPos = findBudget('budget_revenue');
    const perBudgetPos = findBudget('budget_personnel');

    return months.map((rec, idx) => {
      const m = idx + 1; // 1-basierter Monat
      let r = rec;

      // 1) Ist-Umsatz: Gastronovi-Tagesdaten als Fallback
      if (!r.revenueActual) {
        const dailyRev = sumDailyBudgetField(dailyBudgetsData, year, m, 'actualRevenue');
        if (dailyRev > 0) r = { ...r, revenueActual: dailyRev };
      }

      // 2) Vorjahr: erst Gastronovi, dann Vorjahres-Reporting-Monatsdaten
      if (!r.revenuePreviousYear) {
        const fromGastronovi = sumDailyBudgetField(dailyBudgetsData, year, m, 'previousYearRevenue');
        if (fromGastronovi > 0) {
          r = { ...r, revenuePreviousYear: fromGastronovi };
        } else {
          const prevRec = prevYearMonths[idx];
          const prevActual = prevRec?.revenueActual;
          if (prevActual) r = { ...r, revenuePreviousYear: prevActual };
        }
      }

      // 3) Budget: aus budget_v1 übernehmen wenn nicht manuell erfasst
      if (!r.revenueBudget && revBudgetPos) {
        const budgetRev = revBudgetPos.resolvedCHF[idx] ?? 0; // idx = 0-basiert (Jan=0)
        if (budgetRev > 0) r = { ...r, revenueBudget: budgetRev };
      }
      if (!r.personnelCostPlanned && perBudgetPos) {
        const budgetPer = perBudgetPos.resolvedCHF[idx] ?? 0;
        if (budgetPer > 0) r = { ...r, personnelCostPlanned: budgetPer };
      }

      // 4) PK Ist: aus expenseCategories (5xxx) wenn personnelCostActual nicht gesetzt
      if (!r.personnelCostActual && r.expenseCategories.length > 0) {
        const pkFromCats = r.expenseCategories
          .filter(cat => {
            const n = parseInt(cat.categoryId);
            return !isNaN(n) && n >= 5000 && n <= 5999;
          })
          .reduce((sum, cat) => sum + (cat.amount ?? 0), 0);
        if (pkFromCats > 0) r = { ...r, personnelCostActual: pkFromCats };
      }

      return r;
    });
  }, [months, year, dailyBudgetsData, resolvedBudget, prevYearMonths]);

  const summary = useMemo(() => calcAnnualSummary(year), [year, months]);
  const chartData = useMemo(() => buildChartData(effectiveMonths), [effectiveMonths]);
  const threshold = useMemo(
    () => parseInt(localStorage.getItem('labor_cost_threshold') || '40'),
    [],
  );

  const reload = useCallback(() => {
    setMonths(loadYear(year));
  }, [year]);

  const handleYearChange = (y: number) => {
    setYear(y);
    setMonths(loadYear(y));
  };

  const hasAnyData = effectiveMonths.some(m =>
    m.revenueActual !== undefined || m.personnelCostActual !== undefined
  );

  const totals = useMemo(() => calcEffectiveTotals(effectiveMonths), [effectiveMonths]);

  const handleExportPDF = () => {
    try {
      exportReportingToPDF(effectiveMonths, totals, year, threshold);
      toast.success('PDF exportiert (3 Seiten)');
    } catch {
      toast.error('PDF-Export fehlgeschlagen');
    }
  };

  const handleExportExcel = () => {
    try {
      exportReportingToExcel(effectiveMonths, totals, year);
      toast.success('Excel exportiert');
    } catch {
      toast.error('Excel-Export fehlgeschlagen');
    }
  };

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
            {/* Erfolgsrechnung-Link */}
            <Link to="/erfolgsrechnung">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                <BarChart2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">P&L / GuV</span>
              </Button>
            </Link>

            {/* Import-Link */}
            <Link to="/csv-import">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-blue-300 text-blue-700 hover:bg-blue-50">
                <Upload className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Import</span>
              </Button>
            </Link>

            {/* Export PDF */}
            <Button
              variant="outline" size="sm"
              className="h-8 text-xs gap-1 border-rose-300 text-rose-700 hover:bg-rose-50"
              onClick={handleExportPDF}
              title="Jahrestabelle als PDF exportieren"
            >
              <FileDown className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">PDF</span>
            </Button>

            {/* Export Excel */}
            <Button
              variant="outline" size="sm"
              className="h-8 text-xs gap-1 border-green-300 text-green-700 hover:bg-green-50"
              onClick={handleExportExcel}
              title="Jahrestabelle als Excel exportieren"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Excel</span>
            </Button>

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

        {/* Stichtag-Hinweisbanner */}
        <StichtagBanner />

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

        {/* ── Absenzen-Controlling ──────────────────────────────────────────── */}
        <AbsenzMonatsBlock year={year} />

        {/* Monatstabelle */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold">Monatsdaten {year}</h2>
            <div className="flex items-center gap-2">
              <button
                title={highlightVariance ? 'Abweichungs-Highlight deaktivieren' : 'Monate mit Umsatz-Abweichung >10% farblich hervorheben'}
                onClick={() => setHighlightVariance(v => !v)}
                className={cn(
                  'h-7 px-2 flex items-center gap-1 rounded border text-xs transition-colors',
                  highlightVariance
                    ? 'bg-amber-500 text-white border-amber-500'
                    : 'bg-card border-border hover:bg-muted text-muted-foreground',
                )}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>Abw. &gt;10%</span>
              </button>
              <p className="text-xs text-muted-foreground">
                Klick auf «Erfassen» um Daten einzugeben
              </p>
            </div>
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
                  {effectiveMonths.map(m => {
                    const completeness = calcCompleteness(m);
                    const isEmpty = !m.revenueActual && !m.revenueBudget &&
                      !m.personnelCostActual && !m.personnelCostPlanned &&
                      m.expenseCategories.length === 0;
                    const isCurrent = m.year === currentYear && m.month === currentMonth;
                    const isFuture  = m.year > currentYear ||
                      (m.year === currentYear && m.month > currentMonth);
                    const isOutOfScope = stichtagActive && !isInScope(m.year, m.month);

                    const revPct = m.revenueActual != null && m.revenueBudget != null && m.revenueBudget !== 0
                      ? ((m.revenueActual - m.revenueBudget) / Math.abs(m.revenueBudget)) * 100
                      : undefined;
                    const isVarHighlighted = highlightVariance && revPct !== undefined && Math.abs(revPct) > 10;
                    const varRowClass = isVarHighlighted
                      ? revPct! < 0
                        ? 'bg-red-50 dark:bg-red-950/20 border-l-4 border-l-red-400'
                        : 'bg-green-50 dark:bg-green-950/20 border-l-4 border-l-green-400'
                      : '';

                    return (
                      <tr
                        key={m.id}
                        className={cn(
                          'hover:bg-muted/30 transition-colors',
                          isCurrent && !isVarHighlighted && 'bg-primary/5',
                          isEmpty && 'opacity-60',
                          isOutOfScope && 'opacity-40 bg-muted/10',
                          varRowClass,
                        )}
                      >
                        <td className="px-3 py-2.5 font-semibold">
                          <span className={cn(isCurrent && 'text-primary', isOutOfScope && 'line-through text-muted-foreground')}>
                            {MONTH_NAMES_SHORT_DE[m.month]}
                          </span>
                          {isCurrent && !isOutOfScope && (
                            <span className="ml-1 text-[9px] text-primary font-bold">●</span>
                          )}
                          {isOutOfScope && (
                            <span className="ml-1 text-[9px] text-muted-foreground font-bold" title="Ausserhalb Stichtag">✕</span>
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
                  {/* ── Total-Zeile ──────────────────────────────────────── */}
                  {hasAnyData && (
                    <tr className="bg-slate-100 dark:bg-slate-800 border-t-2 border-border font-bold">
                      <td className="px-3 py-2.5 text-sm font-bold text-foreground">
                        Σ Total {year}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {totals.revenueActual > 0 ? formatCHF(totals.revenueActual) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.revenueBudget > 0 ? formatCHF(totals.revenueBudget) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.revenuePreviousYear > 0
                          ? <>
                              {formatCHF(totals.revenuePreviousYear)}
                              {totals.revenueActual > 0 && totals.revenuePreviousYear > 0 && (
                                <span className="ml-1 text-[9px] font-normal">
                                  {totals.revenueActual >= totals.revenuePreviousYear
                                    ? `+${(((totals.revenueActual - totals.revenuePreviousYear) / totals.revenuePreviousYear) * 100).toFixed(1)} %`
                                    : `${(((totals.revenueActual - totals.revenuePreviousYear) / totals.revenuePreviousYear) * 100).toFixed(1)} %`
                                  }
                                </span>
                              )}
                            </>
                          : '–'
                        }
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {totals.personnelCostActual > 0
                          ? <>
                              {formatCHF(totals.personnelCostActual)}
                              {totals.revenueActual > 0 && (
                                <span className="ml-1 text-[9px] font-normal text-muted-foreground">
                                  {((totals.personnelCostActual / totals.revenueActual) * 100).toFixed(1)} %
                                </span>
                              )}
                            </>
                          : '–'
                        }
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.personnelCostPlanned > 0 ? formatCHF(totals.personnelCostPlanned) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-sm text-muted-foreground">–</td>
                      <td className="px-3 py-2.5 text-center text-sm text-muted-foreground">–</td>
                      <td className="px-3 py-2.5 text-center"></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Zukünftige Import-Abschnitte (Platzhalter) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Aktuelles Jahr importieren */}
          <Card className="border-2 border-purple-200 dark:border-purple-800">
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Buchhaltungsimport – Laufendes Jahr
                <Badge variant="outline" className="text-[9px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20 ml-auto">
                  CSV / Excel
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 space-y-2">
              <p className="text-xs text-muted-foreground">
                Excel (Sage Kontoblatt), CSV oder Text-PDF aus dem Buchhaltungsprogramm importieren.
                Monat, Jahr und Datentyp «Ist-Daten» auswählen.
              </p>
              <ImportModeInfo />
              <Link to="/csv-import">
                <Button size="sm" className="w-full h-8 text-xs gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Zum Buchhaltungs-Import
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Vorjahr importieren */}
          <AnnualRevenueImportCard onImported={reload} />
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

// ─── Jahres-Umsatz-Import (Excel) ────────────────────────────────────────────

const AnnualRevenueImportCard = ({ onImported }: { onImported: () => void }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importYear, setImportYear] = useState(currentYear - 1);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<AnnualImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setError('Nur Excel-Dateien (.xlsx/.xls) werden unterstützt.');
      return;
    }
    setParsing(true);
    setError('');
    setResult(null);
    setSaved(false);
    setFileName(file.name);
    try {
      const res = await parseAnnualRevenueXLSX(file);
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler beim Parsen.');
    } finally {
      setParsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleSave = () => {
    if (!result) return;
    setSaving(true);
    let saved = 0;
    for (const row of result.months) {
      if (row.revenue === 0) continue;
      saveMonth(
        { year: importYear, month: row.month, revenueActual: row.revenue },
        'annual_xlsx_import',
        'update',
        { note: `Jahres-Import ${fileName}` },
      );
      saved++;
    }
    setSaving(false);
    setSaved(true);
    onImported();
    toast.success(`${saved} Monate gespeichert (Vorjahr ${importYear})`);
  };

  const fmt = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  return (
    <Card className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Upload className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Jahres-Umsatz importieren (Excel)
          <Badge className="ml-auto text-[9px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-200 dark:border-blue-700">
            Neu
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Lade das Jahres-Umsatz-Excel (Gastronovi-Export) hoch. Die tagesweisen Werte werden
          automatisch auf die 12 Monate summiert und als Ist-Daten für das gewählte Jahr gespeichert.
        </p>

        {/* Jahr-Auswahl */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground whitespace-nowrap">Für Jahr:</label>
          <Select value={String(importYear)} onValueChange={v => { setImportYear(Number(v)); setResult(null); setSaved(false); }}>
            <SelectTrigger className="h-7 text-xs w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 2, currentYear - 1, currentYear].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground">
            (wird als Ist-Daten für dieses Jahr gespeichert)
          </span>
        </div>

        {/* Drop-Zone */}
        {!result && !parsing && (
          <div
            className="border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-colors"
            onClick={() => fileRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
          >
            <Upload className="h-6 w-6 mx-auto mb-2 text-blue-400" />
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
              Excel-Datei hierher ziehen oder klicken
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Gastronovi-Jahresbericht</p>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </div>
        )}

        {/* Parsing Spinner */}
        {parsing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Datei wird analysiert…
          </div>
        )}

        {/* Fehler */}
        {error && (
          <div className="flex items-start gap-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 p-2 text-xs text-red-700 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Vorschau */}
        {result && !saved && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-foreground">
                Vorschau — {fileName}
              </p>
              <button
                className="text-[10px] text-muted-foreground underline"
                onClick={() => { setResult(null); setFileName(''); if (fileRef.current) fileRef.current.value = ''; }}
              >
                Andere Datei
              </button>
            </div>

            {result.debugInfo && (
              <p className="text-[10px] text-muted-foreground/60 italic font-mono">{result.debugInfo}</p>
            )}

            {result.warnings.length > 0 && (
              <div className="rounded bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-700 p-2 text-[10px] text-amber-800 dark:text-amber-300 space-y-0.5">
                {result.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1">
                    <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />{w}
                  </p>
                ))}
              </div>
            )}

            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="bg-muted/60 border-b border-border">
                    <th className="text-left px-2 py-1.5 font-medium">Monat</th>
                    <th className="text-right px-2 py-1.5 font-medium">Umsatz (CHF)</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Food</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Getränke</th>
                  </tr>
                </thead>
                <tbody>
                  {result.months.map(row => (
                    <tr key={row.month} className={cn(
                      'border-b border-border/50',
                      row.revenue === 0 ? 'opacity-40' : '',
                    )}>
                      <td className="px-2 py-1">{MONTH_NAMES_SHORT_DE[row.month]}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold tabular-nums">
                        {fmt(row.revenue)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {fmt(row.food)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                        {fmt(row.beverage)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                    <td className="px-2 py-1.5">Jahrestotal</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {fmt(result.yearTotal)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>

            <Button
              size="sm"
              className="w-full h-8 text-xs bg-blue-600 hover:bg-blue-700 text-white"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? (
                <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />Speichere…</>
              ) : (
                <><Save className="h-3.5 w-3.5 mr-1.5" />12 Monate für {importYear} speichern</>
              )}
            </Button>
          </div>
        )}

        {/* Gespeichert */}
        {saved && (
          <div className="flex items-center gap-2 rounded bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 p-3 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Erfolgreich importiert!</p>
              <p className="text-[10px] opacity-80">
                Umsatzdaten {importYear} wurden gespeichert. Sichtbar unter Vorjahr in der Erfolgsrechnung.
              </p>
            </div>
            <button
              className="ml-auto text-[10px] underline"
              onClick={() => { setResult(null); setFileName(''); setSaved(false); if (fileRef.current) fileRef.current.value = ''; }}
            >
              Weiteren Import
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Import-Modus-Info ────────────────────────────────────────────────────────

const ImportModeInfo = () => (
  <div className="rounded bg-muted/50 border border-border p-2 text-[10px] text-muted-foreground space-y-1">
    <p><span className="font-semibold text-foreground">Ersetzen:</span> Gesamten Monat neu importieren</p>
    <p><span className="font-semibold text-foreground">Aktualisieren:</span> Nur neue/geänderte Positionen übernehmen</p>
  </div>
);

export default Reporting;
