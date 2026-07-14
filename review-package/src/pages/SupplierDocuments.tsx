/**
 * Lieferantendokumente – Operative Warenkostenverfolgung
 * =======================================================
 * Nur für Administratoren.
 *
 * Funktionen:
 *   - Lieferanten-Stammdatenverwaltung (inkl. Standard-Konto + Standard-Kategorie)
 *   - Belegerfassung mit Lieferanten-Dropdown + Kontozuordnung aus dem Kontenplan
 *   - Buchhaltungsvergleich (operativ vs. offizieller Abschluss)
 *
 * Wichtige Regel:
 *   Lieferantendokumente sind SCHÄTZWERTE. Sie ersetzen NIEMALS die
 *   offiziellen Buchhaltungswerte aus dem PDF/CSV-Import.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Truck, Plus, Trash2, Edit3, Info, AlertTriangle, ChevronDown,
  ShoppingCart, Package, Wine, ArrowUpDown, CheckCircle2, Scale,
  BookOpen, ChevronRight, Building2, Hash, Star, Link2, Link2Off, Sparkles, Tag,
  Minus, TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  addDocument, updateDocument, deleteDocument,
  loadDocumentsForMonth, getMonthSummary, buildCostComparison,
  availableYears,
  loadSupplierMasters, upsertSupplierMaster, deleteSupplierMaster,
  findMatchCandidates, linkDocuments, unlinkDocuments,
  getSuggestedAllocation,
  type MatchCandidate,
} from '@/lib/supplier-documents-store';
import {
  loadAllMappings,
} from '@/lib/account-mapping-store';
import { loadArtikelFromDB, getFibuLabel, type Artikel } from '@/lib/artikel-store';
import {
  SupplierDocument, SupplierMaster, DocumentType, DocumentCategory,
  DOCUMENT_TYPE_LABELS, CATEGORY_LABELS, CATEGORY_COLORS,
  CostComparisonRecord,
  CostAllocationTarget, AllocationSplit, ALLOCATION_TARGET_LABELS,
} from '@/types/supplier-documents';
import { AccountMapping } from '@/types/account-mapping';
import { toast } from 'sonner';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const CURRENT_YEAR  = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function chf(n: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(n);
}

function diffColor(diff: number | undefined): string {
  if (diff === undefined) return 'text-muted-foreground';
  if (Math.abs(diff) < 10) return 'text-green-700';
  return diff > 0 ? 'text-orange-600' : 'text-green-700';
}

function categoryIcon(cat: DocumentCategory) {
  if (cat === 'food')     return <ShoppingCart className="h-3.5 w-3.5" />;
  if (cat === 'beverage') return <Wine className="h-3.5 w-3.5" />;
  return <Package className="h-3.5 w-3.5" />;
}

function accountLabel(acc: AccountMapping) {
  return `${acc.accountNumber} – ${acc.accountName}`;
}

// ─── Formular-State ───────────────────────────────────────────────────────────

interface FormState {
  supplier: string;
  documentType: DocumentType;
  date: string;
  deliveryDate: string;       // '' = nicht gesetzt, Fallback auf date
  category: DocumentCategory;
  amount: string;
  accountNumber: string;
  note: string;
  referenceNumber: string;    // Lieferschein-Nr. / Rechnungs-Nr. / Bestellnummer
  allocationTarget: CostAllocationTarget;
  allocationSplits: AllocationSplit[];  // leer = kein Split, Haupt-Target wird verwendet
  useSplit: boolean;           // UI-Schalter: Prozentuale Aufteilung aktiv?
  allocationSuggested?: CostAllocationTarget; // auto-Vorschlag (für Hinweis-Badge)
}

const emptyForm = (): FormState => ({
  supplier:            '',
  documentType:        'delivery_note',
  date:                new Date().toISOString().split('T')[0],
  deliveryDate:        '',
  category:            'food',
  amount:              '',
  accountNumber:       '',
  note:                '',
  referenceNumber:     '',
  allocationTarget:    'unassigned',
  allocationSplits:    [],
  useSplit:            false,
  allocationSuggested: undefined,
});

// ─── Kategorie-Badge ──────────────────────────────────────────────────────────

function CatBadge({ cat }: { cat: DocumentCategory }) {
  const c = CATEGORY_COLORS[cat];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
      c.bg, c.text, c.border,
    )}>
      {categoryIcon(cat)}
      {CATEGORY_LABELS[cat]}
    </span>
  );
}

// ─── Zusammenfassungskarten ───────────────────────────────────────────────────

function SummaryCards({ foodCost, beverageCost, otherCost, totalCost, betriebsaufwandCost, docCount }: {
  foodCost: number; beverageCost: number; otherCost: number;
  totalCost: number; betriebsaufwandCost: number; docCount: number;
}) {
  const hasBetrieb = betriebsaufwandCost > 0;
  return (
    <div className={cn(
      'grid gap-3',
      hasBetrieb
        ? 'grid-cols-2 md:grid-cols-5'
        : 'grid-cols-2 md:grid-cols-4',
    )}>
      <Card className="bg-orange-50 border-orange-200">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-orange-600 flex items-center gap-1">
            <ShoppingCart className="h-3 w-3" /> Küche (Food)
          </p>
          <p className="text-xl font-bold text-orange-800 mt-0.5">{chf(foodCost)}</p>
          <p className="text-[10px] text-orange-500 mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-blue-600 flex items-center gap-1">
            <Wine className="h-3 w-3" /> Getränke (Bev.)
          </p>
          <p className="text-xl font-bold text-blue-800 mt-0.5">{chf(beverageCost)}</p>
          <p className="text-[10px] text-blue-500 mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      <Card className="bg-muted/50">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Package className="h-3 w-3" /> Diverses
          </p>
          <p className="text-xl font-bold mt-0.5">{chf(otherCost)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      {hasBetrieb && (
        <Card className="bg-amber-50 border-amber-200">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-amber-700 flex items-center gap-1">
              <Package className="h-3 w-3" /> Betriebsaufwand
              <span className="font-mono bg-amber-100 px-1 rounded text-[10px]">6040</span>
            </p>
            <p className="text-xl font-bold text-amber-900 mt-0.5">{chf(betriebsaufwandCost)}</p>
            <p className="text-[10px] text-amber-600 mt-0.5">separat · nicht in WK%</p>
          </CardContent>
        </Card>
      )}
      <Card className="bg-zinc-900 border-zinc-700">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-zinc-300 flex items-center gap-1">
            <Truck className="h-3 w-3" /> Total · {docCount} Belege
          </p>
          <p className="text-xl font-bold text-white mt-0.5">{chf(totalCost)}</p>
          <p className="text-[10px] text-zinc-400 mt-0.5">
            Warenkosten {hasBetrieb ? '(exkl. Betriebsaufwand)' : 'gesamt'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Forecast-Helpers ────────────────────────────────────────────────────────

function forecastRevenueKey(year: number, month: number): string {
  return `waren_forecast_rev_${year}-${String(month).padStart(2, '0')}`;
}

const FORECAST_TARGET_KEY = 'waren_forecast_target_pct';

function loadForecastRevenue(year: number, month: number): number | null {
  try {
    const raw = localStorage.getItem(forecastRevenueKey(year, month));
    if (!raw) return null;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function saveForecastRevenue(year: number, month: number, value: number | null): void {
  try {
    const key = forecastRevenueKey(year, month);
    if (value === null || value <= 0) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* silent */ }
}

function loadForecastTarget(): number | null {
  try {
    const raw = localStorage.getItem(FORECAST_TARGET_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function saveForecastTarget(value: number | null): void {
  try {
    if (value === null || value <= 0) localStorage.removeItem(FORECAST_TARGET_KEY);
    else localStorage.setItem(FORECAST_TARGET_KEY, String(value));
  } catch { /* silent */ }
}

// ─── Forecast-Karte ──────────────────────────────────────────────────────────

const QUICK_VALUES = [50000, 60000, 70000, 80000, 90000, 100000, 120000, 150000];

function ForecastCard({
  totalCost,
  forecastRevenue,
  onForecastChange,
  forecastTarget,
  onTargetChange,
  actualNetRevenue,
}: {
  totalCost: number;
  forecastRevenue: number | null;
  onForecastChange: (v: number | null) => void;
  forecastTarget: number | null;
  onTargetChange: (v: number | null) => void;
  /** Kumulierter Ist-Umsatz netto aus dailyBudgets (÷ 1.081). null = keine Daten. */
  actualNetRevenue: number | null;
}) {
  const [rawInput, setRawInput] = useState(
    forecastRevenue !== null ? String(forecastRevenue) : '',
  );

  useEffect(() => {
    setRawInput(forecastRevenue !== null ? String(forecastRevenue) : '');
  }, [forecastRevenue]);

  function step(delta: number) {
    const current = forecastRevenue ?? 0;
    const next = Math.max(0, current + delta);
    onForecastChange(next === 0 ? null : next);
  }

  function handleInputBlur() {
    const n = parseInt(rawInput.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > 0) {
      onForecastChange(n);
      setRawInput(String(n));
    } else {
      onForecastChange(null);
      setRawInput('');
    }
  }

  // Ist-Umsatz netto hat Vorrang vor Forecast für die WK%-Berechnung
  const hasActual  = actualNetRevenue !== null && actualNetRevenue > 0;
  const effectiveRevenue = hasActual ? actualNetRevenue : forecastRevenue;

  const actualPct   = hasActual
    ? (totalCost / actualNetRevenue!) * 100
    : null;
  const forecastPct = forecastRevenue && forecastRevenue > 0
    ? (totalCost / forecastRevenue) * 100
    : null;
  const displayPct  = actualPct ?? forecastPct;

  const isOnTarget = forecastTarget !== null && displayPct !== null
    ? displayPct <= forecastTarget
    : null;

  const statusColor = isOnTarget === null
    ? 'border-slate-300 bg-slate-50 dark:bg-slate-800/40 dark:border-slate-600'
    : isOnTarget
      ? 'border-green-400 bg-green-50 dark:bg-green-950/30'
      : 'border-red-400 bg-red-50 dark:bg-red-950/30';

  const pctColor = isOnTarget === null
    ? 'text-slate-700 dark:text-slate-300'
    : isOnTarget ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400';

  return (
    <Card className="border-dashed border-2 border-slate-300 dark:border-slate-600">
      <CardContent className="pt-4 pb-4 space-y-3">

        {/* Ist-Umsatz netto – prominente Anzeige wenn Daten vorhanden */}
        {hasActual && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-700 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 uppercase tracking-widest">
                Kumulierter Ist-Umsatz (netto)
              </p>
              <span className="text-[10px] bg-emerald-100 dark:bg-emerald-900/50 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 px-1.5 py-px rounded font-mono">
                Brutto ÷ 1.081
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg border border-emerald-200 bg-white dark:bg-emerald-950/20 px-4 py-2 text-center">
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mb-0.5">Umsatz netto (kum.)</p>
                <p className="text-base font-bold tabular-nums text-emerald-900 dark:text-emerald-200">
                  {chf(actualNetRevenue!)}
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white dark:bg-emerald-950/20 px-4 py-2 text-center">
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mb-0.5">Warenkosten (exkl. BA)</p>
                <p className="text-base font-bold tabular-nums text-emerald-900 dark:text-emerald-200">
                  {chf(totalCost)}
                </p>
              </div>
              <div className={cn('rounded-lg border-2 px-4 py-2 text-center', statusColor)}>
                <p className="text-[10px] text-muted-foreground mb-0.5">WK% auf Ist-Umsatz netto</p>
                <p className={cn('text-xl font-black tabular-nums', pctColor)}>
                  {actualPct !== null ? `${actualPct.toFixed(1)} %` : '–'}
                </p>
                {isOnTarget !== null && (
                  <p className={cn('text-[10px] font-semibold mt-0.5', pctColor)}>
                    {isOnTarget
                      ? `✓ Im Ziel (≤ ${forecastTarget}%)`
                      : `↑ Ziel ${forecastTarget}% überschritten`}
                  </p>
                )}
                {isOnTarget === null && forecastTarget !== null && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Zielwert unten setzen</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Header Forecast-Eingabe */}
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {hasActual ? 'Forecast Umsatz (Vergleich / laufender Monat)' : 'Forecast Umsatz Monat'}
          </p>
          {!hasActual && (
            <span className="text-[10px] text-muted-foreground">
              — WK% hochrechnen ohne Umsatzdaten zu überschreiben
            </span>
          )}
        </div>

        {/* Input row */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline" size="icon" className="h-8 w-8 shrink-0"
            onClick={() => step(-1000)}
            disabled={!forecastRevenue || forecastRevenue <= 1000}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>

          <Input
            type="text"
            inputMode="numeric"
            className="h-8 w-32 text-center font-mono text-sm"
            value={rawInput}
            placeholder="z.B. 90000"
            onChange={e => setRawInput(e.target.value)}
            onBlur={handleInputBlur}
            onKeyDown={e => e.key === 'Enter' && handleInputBlur()}
          />

          <Button
            variant="outline" size="icon" className="h-8 w-8 shrink-0"
            onClick={() => step(+1000)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>

          <span className="text-[10px] text-muted-foreground">CHF · ±1'000</span>

          {forecastRevenue !== null && (
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground underline ml-1"
              onClick={() => { onForecastChange(null); setRawInput(''); }}
            >
              zurücksetzen
            </button>
          )}
        </div>

        {/* Schnellauswahl */}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_VALUES.map(v => (
            <button
              key={v}
              onClick={() => { onForecastChange(v); setRawInput(String(v)); }}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors',
                forecastRevenue === v
                  ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200'
                  : 'bg-muted text-muted-foreground border-border hover:border-foreground hover:text-foreground',
              )}
            >
              {(v / 1000).toFixed(0)}'000
            </button>
          ))}
        </div>

        {/* Forecast-Ergebnis (nur wenn kein Ist-Umsatz, oder als Zusatz) */}
        {forecastRevenue && forecastRevenue > 0 ? (
          <div className="flex flex-wrap gap-3 pt-1">
            <div className="rounded-lg border bg-muted/40 px-4 py-2 text-center">
              <p className="text-[10px] text-muted-foreground mb-0.5">Forecast Umsatz</p>
              <p className="text-base font-bold tabular-nums">{chf(forecastRevenue)}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 px-4 py-2 text-center">
              <p className="text-[10px] text-muted-foreground mb-0.5">Warenkosten bisher</p>
              <p className="text-base font-bold tabular-nums">{chf(totalCost)}</p>
            </div>
            {!hasActual && (
              <div className={cn('rounded-lg border-2 px-4 py-2 text-center', statusColor)}>
                <p className="text-[10px] text-muted-foreground mb-0.5">Forecast WK%</p>
                <p className={cn('text-xl font-black tabular-nums', pctColor)}>
                  {forecastPct !== null ? `${forecastPct.toFixed(1)} %` : '–'}
                </p>
                {isOnTarget !== null && (
                  <p className={cn('text-[10px] font-semibold mt-0.5', pctColor)}>
                    {isOnTarget
                      ? `✓ Im Ziel (≤ ${forecastTarget}%)`
                      : `↑ Ziel ${forecastTarget}% überschritten`}
                  </p>
                )}
                {isOnTarget === null && forecastTarget === null && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Ziel unten eingeben</p>
                )}
              </div>
            )}
            {hasActual && forecastPct !== null && (
              <div className="rounded-lg border bg-muted/40 px-4 py-2 text-center">
                <p className="text-[10px] text-muted-foreground mb-0.5">Forecast WK% (nachrichtlich)</p>
                <p className="text-base font-semibold tabular-nums text-muted-foreground">
                  {forecastPct.toFixed(1)} %
                </p>
              </div>
            )}
          </div>
        ) : !hasActual ? (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Forecast Umsatz eingeben um die Warenkostenquote zu berechnen
          </p>
        ) : null}

        {/* Zielwert-Input */}
        <div className="flex items-center gap-2 pt-2 border-t">
          <p className="text-xs text-muted-foreground">Zielwert Warenkosten %:</p>
          <Input
            type="number"
            min="1"
            max="100"
            step="0.5"
            className="h-7 w-20 text-xs"
            placeholder="z.B. 30"
            value={forecastTarget !== null ? forecastTarget : ''}
            onChange={e => {
              const v = parseFloat(e.target.value);
              onTargetChange(!isNaN(v) && v > 0 ? v : null);
            }}
          />
          <span className="text-xs text-muted-foreground">%</span>
          {forecastTarget !== null && (
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
              onClick={() => onTargetChange(null)}
            >
              löschen
            </button>
          )}
          <span className="text-[10px] text-muted-foreground ml-1">
            (gilt für alle Monate, wird gespeichert)
          </span>
        </div>

      </CardContent>
    </Card>
  );
}

// ─── Buchhaltungsvergleich ─────────────────────────────────────────────────────

function ComparisonSection({ comp }: { comp: CostComparisonRecord }) {
  if (!comp.hasAccountingData) {
    return (
      <Alert className="text-sm">
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Buchhaltungsvergleich:</strong> Noch kein Buchhaltungsimport für{' '}
          {MONTHS[comp.month - 1]} {comp.year} vorhanden.
          Nach dem PDF/CSV-Import erscheint hier der Vergleich zwischen operativer Schätzung
          und offiziellem Buchhaltungsabschluss.
        </AlertDescription>
      </Alert>
    );
  }

  const rows = [
    { label: 'Küche (Food)',       op: comp.operationalFoodCost,     acc: comp.accountingFoodCost,     diff: comp.diffFoodCost },
    { label: 'Getränke (Bev.)',    op: comp.operationalBeverageCost, acc: comp.accountingBeverageCost, diff: comp.diffBeverageCost },
    { label: 'Total Warenaufwand', op: comp.operationalTotalCost,    acc: comp.accountingTotalCost,    diff: comp.diffTotalCost, isBold: true },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4" />
          Vergleich: Operative Schätzung vs. Buchhaltung
          <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]">
            Buchhaltungsimport vorhanden
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kategorie</TableHead>
                <TableHead className="text-right">Lieferantendok. (operativ)</TableHead>
                <TableHead className="text-right">Buchhaltung (offiziell)</TableHead>
                <TableHead className="text-right">Differenz</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.label} className={row.isBold ? 'font-semibold bg-muted/30' : ''}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{chf(row.op)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.acc !== undefined ? chf(row.acc) : '—'}
                  </TableCell>
                  <TableCell className={cn('text-right font-mono text-sm', diffColor(row.diff))}>
                    {row.diff !== undefined ? (row.diff > 0 ? '+' : '') + chf(row.diff) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {comp.diffTotalPct !== undefined && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-t">
            Abweichung: <strong className={diffColor(comp.diffTotalCost)}>
              {comp.diffTotalPct > 0 ? '+' : ''}{comp.diffTotalPct.toFixed(1)}%
            </strong>
            {' '}(operative Schätzung vs. Buchhaltungsabschluss)
            {Math.abs(comp.diffTotalPct) < 5 && (
              <span className="ml-2 text-green-600 font-medium">✓ Gute Übereinstimmung</span>
            )}
          </div>
        )}
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-700 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>Hinweis:</strong> Buchhaltungswerte sind die offiziellen Werte für das Reporting.
            Lieferantendokumente sind nur operative Schätzwerte.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Lieferant-Schnellerfassung (inline im Dialog) ────────────────────────────

interface NewSupplierFormState {
  name: string;
  defaultCategory: DocumentCategory | '';
  defaultAccountNumber: string;
  note: string;
}

function NewSupplierInline({
  accounts,
  onCreated,
  onCancel,
}: {
  accounts: AccountMapping[];
  onCreated: (master: SupplierMaster) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<NewSupplierFormState>({
    name: '', defaultCategory: '', defaultAccountNumber: '', note: '',
  });
  const [error, setError] = useState('');

  const expenseAccounts = useMemo(
    () => accounts.filter(a => a.sign === 'expense').sort((a, b) =>
      a.accountNumber.localeCompare(b.accountNumber)),
    [accounts],
  );

  function handleCreate() {
    if (!form.name.trim()) { setError('Name ist erforderlich'); return; }
    const master = upsertSupplierMaster({
      name:                 form.name,
      defaultCategory:      form.defaultCategory || undefined,
      defaultAccountNumber: form.defaultAccountNumber || undefined,
      note:                 form.note || undefined,
      isActive:             true,
    });
    toast.success(`Lieferant «${master.name}» wurde angelegt`);
    onCreated(master);
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-3">
      <p className="text-xs font-semibold text-blue-800 flex items-center gap-1">
        <Building2 className="h-3.5 w-3.5" /> Neuen Lieferanten anlegen
      </p>

      <div className="space-y-1.5">
        <Label className="text-xs">Name *</Label>
        <Input
          className="h-8 text-sm"
          placeholder="z.B. Pistor AG, Transgourmet…"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Standard-Kategorie</Label>
          <Select
            value={form.defaultCategory}
            onValueChange={v => setForm(f => ({ ...f, defaultCategory: v as DocumentCategory }))}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="(keine)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">keine</SelectItem>
              <SelectItem value="food">Küche / Food</SelectItem>
              <SelectItem value="beverage">Getränke / Beverage</SelectItem>
              <SelectItem value="other">Diverses / Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Standard-Konto</Label>
          <Select
            value={form.defaultAccountNumber}
            onValueChange={v => setForm(f => ({ ...f, defaultAccountNumber: v }))}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="(kein)" /></SelectTrigger>
            <SelectContent className="max-h-48">
              <SelectItem value="">kein Standard-Konto</SelectItem>
              {expenseAccounts.map(a => (
                <SelectItem key={a.accountNumber} value={a.accountNumber}>
                  {a.accountNumber} – {a.accountName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleCreate}>
          <Plus className="h-3 w-3 mr-1" /> Anlegen & auswählen
        </Button>
      </div>
    </div>
  );
}

// ─── Beleg-Dialog (Add + Edit) ────────────────────────────────────────────────

interface DocumentDialogProps {
  open: boolean;
  title: string;
  form: FormState;
  error: string;
  supplierMasters: SupplierMaster[];
  accounts: AccountMapping[];
  onFormChange: (f: FormState) => void;
  onSave: () => void;
  onClose: () => void;
  onSupplierMasterCreated: (master: SupplierMaster) => void;
}

function DocumentDialog({
  open, title, form, error, supplierMasters, accounts, onFormChange, onSave, onClose,
  onSupplierMasterCreated,
}: DocumentDialogProps) {
  const [showNewSupplier, setShowNewSupplier] = useState(false);

  function set(field: keyof FormState, value: string | boolean | AllocationSplit[]) {
    onFormChange({ ...form, [field]: value });
  }

  const allocationTargetOptions: CostAllocationTarget[] = [
    'lunch_basic', 'lunch_premium', 'a_la_carte', 'pizza',
    'dessert', 'kinder', 'kueche_allgemein', 'beverage', 'unassigned',
  ];

  function setSplitTarget(idx: number, target: CostAllocationTarget) {
    const splits = [...form.allocationSplits];
    splits[idx] = { ...splits[idx], target };
    set('allocationSplits', splits);
  }

  function setSplitPct(idx: number, pct: string) {
    const splits = [...form.allocationSplits];
    splits[idx] = { ...splits[idx], pct: Number(pct) || 0 };
    set('allocationSplits', splits);
  }

  function addSplitRow() {
    const splits = [...form.allocationSplits, { target: 'unassigned' as CostAllocationTarget, pct: 0 }];
    set('allocationSplits', splits);
  }

  function removeSplitRow(idx: number) {
    const splits = form.allocationSplits.filter((_, i) => i !== idx);
    set('allocationSplits', splits);
  }

  const splitTotal = form.allocationSplits.reduce((s, r) => s + r.pct, 0);

  const expenseAccounts = useMemo(
    () => accounts.filter(a => a.sign === 'expense').sort((a, b) =>
      a.accountNumber.localeCompare(b.accountNumber)),
    [accounts],
  );

  const activeSuppliers = useMemo(
    () => supplierMasters.filter(s => s.isActive).sort((a, b) => a.name.localeCompare(b.name)),
    [supplierMasters],
  );

  function handleSupplierSelect(name: string) {
    if (name === '__new__') {
      setShowNewSupplier(true);
      return;
    }
    const master = activeSuppliers.find(s => s.name === name);
    const newForm = { ...form, supplier: name };
    if (master?.defaultCategory)      newForm.category      = master.defaultCategory;
    if (master?.defaultAccountNumber) newForm.accountNumber = master.defaultAccountNumber;

    // Automatischer Vorschlag: häufigste bisherige Kostenzuordnung für diesen Lieferanten
    if (!form.useSplit) {
      const suggestion = getSuggestedAllocation(name);
      if (suggestion) {
        newForm.allocationTarget    = suggestion;
        newForm.allocationSuggested = suggestion;
      } else {
        newForm.allocationSuggested = undefined;
      }
    }

    onFormChange(newForm);
    setShowNewSupplier(false);
  }

  function handleNewSupplierCreated(master: SupplierMaster) {
    onSupplierMasterCreated(master);
    const newForm = { ...form, supplier: master.name };
    if (master.defaultCategory)      newForm.category      = master.defaultCategory;
    if (master.defaultAccountNumber) newForm.accountNumber = master.defaultAccountNumber;
    onFormChange(newForm);
    setShowNewSupplier(false);
  }

  const selectedAccount = expenseAccounts.find(a => a.accountNumber === form.accountNumber);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">

          {/* ── Lieferant ─────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label>Lieferant *</Label>
            {activeSuppliers.length > 0 ? (
              <Select value={form.supplier} onValueChange={handleSupplierSelect}>
                <SelectTrigger>
                  <SelectValue placeholder="Lieferant auswählen…" />
                </SelectTrigger>
                <SelectContent className="max-h-56">
                  {activeSuppliers.map(s => (
                    <SelectItem key={s.id} value={s.name}>
                      <span className="flex items-center gap-2">
                        {s.name}
                        {s.defaultAccountNumber && (
                          <span className="text-[10px] text-muted-foreground font-mono bg-muted px-1 rounded">
                            {s.defaultAccountNumber}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                  <Separator className="my-1" />
                  <SelectItem value="__new__">
                    <span className="flex items-center gap-1 text-blue-700">
                      <Plus className="h-3 w-3" /> Neuen Lieferanten anlegen…
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div className="space-y-2">
                <Input
                  placeholder="z.B. Pistor AG, Transgourmet…"
                  value={form.supplier}
                  onChange={e => set('supplier', e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1 text-blue-700 border-blue-200"
                  onClick={() => setShowNewSupplier(true)}
                >
                  <Plus className="h-3 w-3" /> Lieferanten im Stamm erfassen
                </Button>
              </div>
            )}

            {activeSuppliers.length > 0 && !showNewSupplier && (
              <p className="text-[10px] text-muted-foreground">
                Standard-Kategorie und Konto werden automatisch vorbelegt, falls hinterlegt.
              </p>
            )}

            {showNewSupplier && (
              <NewSupplierInline
                accounts={accounts}
                onCreated={handleNewSupplierCreated}
                onCancel={() => setShowNewSupplier(false)}
              />
            )}
          </div>

          {/* ── Typ + Belegdatum ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Dokumenttyp</Label>
              <Select value={form.documentType} onValueChange={v => set('documentType', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="delivery_note">Lieferschein</SelectItem>
                  <SelectItem value="invoice">Rechnung</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Belegdatum *</Label>
              <Input
                type="date"
                value={form.date}
                onChange={e => set('date', e.target.value)}
              />
            </div>
          </div>

          {/* ── Lieferdatum (optional) ─────────────────────────────────────── */}
          {(form.documentType === 'delivery_note' || form.documentType === 'invoice') && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                Lieferdatum
                <span className="text-[10px] text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                type="date"
                value={form.deliveryDate}
                onChange={e => set('deliveryDate', e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground leading-tight">
                {form.deliveryDate
                  ? <>
                      <span className="font-medium text-emerald-700">Lieferdatum aktiv</span>
                      {' – Dieser Beleg wird dem Monat «'}
                      {new Date(form.deliveryDate).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' })}
                      {'» zugeordnet (nicht dem Belegdatum).'}
                    </>
                  : <>
                      <span className="font-medium">Kein Lieferdatum gesetzt</span>
                      {' – Es wird das Belegdatum verwendet ('}
                      {form.date
                        ? new Date(form.date).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' })
                        : '–'}
                      {').'}
                    </>
                }
              </p>
            </div>
          )}

          {/* ── Kategorie + Betrag ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Kategorie</Label>
              <Select value={form.category} onValueChange={v => set('category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="food">Küche / Food</SelectItem>
                  <SelectItem value="beverage">Getränke / Beverage</SelectItem>
                  <SelectItem value="other">Diverses / Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Betrag CHF (netto) *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={e => set('amount', e.target.value)}
              />
            </div>
          </div>

          {/* ── Kontozuordnung ─────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5 text-muted-foreground" />
              Kontozuordnung (Kontenplan)
            </Label>
            <Select
              value={form.accountNumber || '__none__'}
              onValueChange={v => set('accountNumber', v === '__none__' ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Konto auswählen…" />
              </SelectTrigger>
              <SelectContent className="max-h-56">
                <SelectItem value="__none__">
                  <span className="text-muted-foreground italic text-sm">Kein Konto</span>
                </SelectItem>
                <Separator className="my-1" />
                {expenseAccounts.map(a => (
                  <SelectItem key={a.accountNumber} value={a.accountNumber}>
                    <span className="font-mono text-xs mr-2 text-muted-foreground">{a.accountNumber}</span>
                    {a.accountName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-600" />
                {selectedAccount.accountNumber} – {selectedAccount.accountName}
                {' '}· P&L: {selectedAccount.plSection}
              </p>
            )}
            {!selectedAccount && (
              <p className="text-[10px] text-muted-foreground">
                Optional. Verbindet den Beleg mit dem offiziellen Kontenplan für den Buchhaltungsvergleich.
              </p>
            )}
          </div>

          {/* ── Referenznummer + Notiz ─────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                Referenznummer
                <span className="text-[10px] text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                placeholder="z.B. LS-2025-001, RG-0815…"
                value={form.referenceNumber}
                onChange={e => set('referenceNumber', e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                Lieferschein-Nr. oder Rechnungs-Nr. – hilft beim Duplikat-Matching
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Notiz (optional)</Label>
              <Textarea
                placeholder="Kommentar…"
                rows={2}
                value={form.note}
                onChange={e => set('note', e.target.value)}
              />
            </div>
          </div>

          {/* ── Kostenzuordnung ────────────────────────────────────────────── */}
          <div className="space-y-2 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <Tag className="h-3.5 w-3.5" />
                Kostenzuordnung
                <span className="font-normal normal-case text-[10px]">(für Lunch-Analyse)</span>
              </Label>
              <button
                type="button"
                className="text-[10px] text-violet-600 hover:text-violet-800 underline"
                onClick={() => set('useSplit', !form.useSplit)}
              >
                {form.useSplit ? '← Einfach-Zuordnung' : '% Aufteilung auf mehrere Pools'}
              </button>
            </div>

            {!form.useSplit ? (
              <div className="space-y-1.5">
                <Select
                  value={form.allocationTarget}
                  onValueChange={v => set('allocationTarget', v as CostAllocationTarget)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allocationTargetOptions.map(t => (
                      <SelectItem key={t} value={t} className="text-xs">
                        {ALLOCATION_TARGET_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.allocationSuggested && form.allocationSuggested === form.allocationTarget && (
                  <p className="text-[10px] text-violet-600 dark:text-violet-400 flex items-center gap-1">
                    <Sparkles className="h-2.5 w-2.5" />
                    Vorschlag basierend auf früheren Belegen dieses Lieferanten. Jederzeit änderbar.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {form.allocationSplits.map((split, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Select
                      value={split.target}
                      onValueChange={v => setSplitTarget(idx, v as CostAllocationTarget)}
                    >
                      <SelectTrigger className="h-7 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allocationTargetOptions.map(t => (
                          <SelectItem key={t} value={t} className="text-xs">
                            {ALLOCATION_TARGET_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      className="h-7 w-16 text-xs text-right"
                      value={split.pct}
                      onChange={e => setSplitPct(idx, e.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                    <button
                      type="button"
                      className="text-red-400 hover:text-red-600"
                      onClick={() => removeSplitRow(idx)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between mt-1">
                  <button
                    type="button"
                    className="text-[10px] text-violet-600 hover:text-violet-800 underline"
                    onClick={addSplitRow}
                  >
                    + Zeile hinzufügen
                  </button>
                  <span className={cn(
                    'text-[10px] font-mono font-semibold',
                    splitTotal === 100 ? 'text-green-600' : 'text-amber-600',
                  )}>
                    Total: {splitTotal}% {splitTotal !== 100 && '(muss 100% sein)'}
                  </span>
                </div>
              </div>
            )}

            <p className="text-[10px] text-muted-foreground">
              Zuordnung für die Lunch-WES-Analyse. Hat keinen Einfluss auf Monatssummen oder Buchhaltungsvergleich.
            </p>
          </div>

          {error && (
            <Alert variant="destructive" className="text-sm py-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={onSave}>Speichern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lieferantenstamm-Verwaltung ──────────────────────────────────────────────

interface MasterFormState {
  id?: string;
  name: string;
  defaultCategory: DocumentCategory | '';
  defaultAccountNumber: string;
  note: string;
  isActive: boolean;
}

function emptyMasterForm(): MasterFormState {
  return { name: '', defaultCategory: '', defaultAccountNumber: '', note: '', isActive: true };
}

function SupplierMasterPanel({
  masters,
  accounts,
  onChanged,
}: {
  masters: SupplierMaster[];
  accounts: AccountMapping[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editForm, setEditForm]   = useState<MasterFormState | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm]     = useState<MasterFormState>(emptyMasterForm());
  const [newError, setNewError]   = useState('');

  const expenseAccounts = useMemo(
    () => accounts.filter(a => a.sign === 'expense').sort((a, b) =>
      a.accountNumber.localeCompare(b.accountNumber)),
    [accounts],
  );

  function handleSaveNew() {
    if (!newForm.name.trim()) { setNewError('Name ist erforderlich'); return; }
    upsertSupplierMaster({
      name:                 newForm.name,
      defaultCategory:      newForm.defaultCategory || undefined,
      defaultAccountNumber: newForm.defaultAccountNumber || undefined,
      note:                 newForm.note || undefined,
      isActive:             newForm.isActive,
    });
    toast.success(`Lieferant «${newForm.name}» wurde angelegt`);
    setNewForm(emptyMasterForm());
    setShowNewForm(false);
    setNewError('');
    onChanged();
  }

  function handleSaveEdit() {
    if (!editForm || !editForm.name.trim()) return;
    upsertSupplierMaster({
      id:                   editForm.id,
      name:                 editForm.name,
      defaultCategory:      editForm.defaultCategory || undefined,
      defaultAccountNumber: editForm.defaultAccountNumber || undefined,
      note:                 editForm.note || undefined,
      isActive:             editForm.isActive,
    });
    toast.success(`Lieferant «${editForm.name}» gespeichert`);
    setEditForm(null);
    onChanged();
  }

  function handleDelete(m: SupplierMaster) {
    if (!confirm(`Lieferant «${m.name}» wirklich löschen?`)) return;
    deleteSupplierMaster(m.id);
    toast.success('Lieferant gelöscht');
    onChanged();
  }

  function handleToggleActive(m: SupplierMaster) {
    upsertSupplierMaster({ ...m, isActive: !m.isActive });
    onChanged();
  }

  function MasterForm({ f, onChange, onSave, onCancel, saveLabel }: {
    f: MasterFormState;
    onChange: (f: MasterFormState) => void;
    onSave: () => void;
    onCancel: () => void;
    saveLabel: string;
  }) {
    return (
      <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Name *</Label>
            <Input className="h-8 text-sm" value={f.name} placeholder="Lieferantenname…"
              onChange={e => onChange({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Standard-Kategorie</Label>
            <Select value={f.defaultCategory} onValueChange={v => onChange({ ...f, defaultCategory: v as DocumentCategory | '' })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="(keine)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">keine</SelectItem>
                <SelectItem value="food">Küche / Food</SelectItem>
                <SelectItem value="beverage">Getränke / Bev.</SelectItem>
                <SelectItem value="other">Diverses</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Standard-Konto</Label>
            <Select value={f.defaultAccountNumber || '__none__'} onValueChange={v => onChange({ ...f, defaultAccountNumber: v === '__none__' ? '' : v })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="(kein)" /></SelectTrigger>
              <SelectContent className="max-h-48">
                <SelectItem value="__none__">kein Standard-Konto</SelectItem>
                {expenseAccounts.map(a => (
                  <SelectItem key={a.accountNumber} value={a.accountNumber}>
                    {a.accountNumber} – {a.accountName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Notiz</Label>
            <Input className="h-8 text-sm" value={f.note} placeholder="Kontaktdaten, etc."
              onChange={e => onChange({ ...f, note: e.target.value })} />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch checked={f.isActive} onCheckedChange={v => onChange({ ...f, isActive: v })} id="active-toggle" />
            <Label htmlFor="active-toggle" className="text-xs text-muted-foreground">Aktiv</Label>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>Abbrechen</Button>
            <Button size="sm" className="h-7 text-xs" onClick={onSave}>{saveLabel}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Lieferantenstamm
            <Badge variant="outline" className="text-[10px]">{masters.length} Lieferanten</Badge>
          </span>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardTitle>
      </CardHeader>

      {open && (
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Lieferanten-Stammdaten mit Standard-Kategorie und Standard-Konto. Diese Daten werden
            beim Belegerfassen automatisch vorbelegt.
          </p>

          {/* Tabelle bestehender Lieferanten */}
          {masters.length > 0 && (
            <div className="overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead className="py-2">Name</TableHead>
                    <TableHead className="py-2">Std. Kategorie</TableHead>
                    <TableHead className="py-2">Std. Konto</TableHead>
                    <TableHead className="py-2">Notiz</TableHead>
                    <TableHead className="py-2 w-28">Status</TableHead>
                    <TableHead className="py-2 w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {masters
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(m => (
                      editForm?.id === m.id ? (
                        <TableRow key={m.id}>
                          <TableCell colSpan={6} className="p-2">
                            <MasterForm
                              f={editForm}
                              onChange={setEditForm}
                              onSave={handleSaveEdit}
                              onCancel={() => setEditForm(null)}
                              saveLabel="Speichern"
                            />
                          </TableCell>
                        </TableRow>
                      ) : (
                        <TableRow key={m.id} className={cn(!m.isActive && 'opacity-50')}>
                          <TableCell className="text-sm font-medium py-2">{m.name}</TableCell>
                          <TableCell className="py-2">
                            {m.defaultCategory ? (
                              <CatBadge cat={m.defaultCategory} />
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">—</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2">
                            {m.defaultAccountNumber ? (
                              <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                                {m.defaultAccountNumber}
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground italic">—</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground max-w-[140px] truncate">
                            {m.note ?? '—'}
                          </TableCell>
                          <TableCell className="py-2">
                            <button
                              onClick={() => handleToggleActive(m)}
                              className={cn(
                                'text-[10px] px-2 py-0.5 rounded-full border font-medium',
                                m.isActive
                                  ? 'bg-green-50 text-green-700 border-green-200'
                                  : 'bg-gray-100 text-gray-500 border-gray-200',
                              )}
                            >
                              {m.isActive ? 'Aktiv' : 'Inaktiv'}
                            </button>
                          </TableCell>
                          <TableCell className="py-2">
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-6 w-6"
                                onClick={() => setEditForm({ id: m.id, name: m.name, defaultCategory: m.defaultCategory ?? '', defaultAccountNumber: m.defaultAccountNumber ?? '', note: m.note ?? '', isActive: m.isActive })}>
                                <Edit3 className="h-3 w-3" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500 hover:text-red-700 hover:bg-red-50"
                                onClick={() => handleDelete(m)}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Neuer Lieferant */}
          {showNewForm ? (
            <MasterForm
              f={newForm}
              onChange={setNewForm}
              onSave={handleSaveNew}
              onCancel={() => { setShowNewForm(false); setNewForm(emptyMasterForm()); setNewError(''); }}
              saveLabel="Anlegen"
            />
          ) : (
            <Button variant="outline" size="sm" className="gap-1 text-xs h-8"
              onClick={() => setShowNewForm(true)}>
              <Plus className="h-3.5 w-3.5" /> Neuen Lieferanten anlegen
            </Button>
          )}
          {newError && <p className="text-[11px] text-red-600">{newError}</p>}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

/**
 * Liest den kumulierten Ist-Umsatz (netto) aus dailyBudgets für einen Monat.
 * Brutto-Umsatz (actualRevenue) wird durch 1.081 geteilt (8.1% MwSt → netto).
 * Gibt null zurück wenn keine Daten vorhanden.
 */
function readCumulativeNetRevenue(
  tkFn: (key: string) => string,
  year: number,
  month: number,
): number | null {
  try {
    const raw = localStorage.getItem(tkFn('dailyBudgets'));
    if (!raw) return null;
    const all: Record<string, { actualRevenue?: number }> = JSON.parse(raw);
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    let total = 0;
    let hasData = false;
    for (const [dateKey, day] of Object.entries(all)) {
      if (dateKey.startsWith(prefix) && (day.actualRevenue ?? 0) > 0) {
        total += day.actualRevenue!;
        hasData = true;
      }
    }
    return hasData ? total / 1.081 : null;
  } catch {
    return null;
  }
}

export default function SupplierDocumentsPage() {
  const { isAdmin } = usePermissions();
  const { tenantKey } = useTenant();

  const [year, setYear]   = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(CURRENT_MONTH);

  const years = availableYears();

  // Inventur-relevante Artikel (aus Artikelstamm, einmalig geladen)
  const [kontrollartikel, setKontrollartikel] = useState<Artikel[]>([]);
  const [showKontrollartikel, setShowKontrollartikel] = useState(false);
  useEffect(() => {
    loadArtikelFromDB().then(store => {
      const relevant = store.articles.filter(a => a.inventurRelevant && a.active);
      setKontrollartikel(relevant.sort((a, b) => a.name.localeCompare(b.name, 'de')));
    }).catch(() => {});
  }, []);

  // Kontenplan (für Kontozuordnung im Formular)
  const accounts = useMemo(() => loadAllMappings(), []);

  // Lieferanten-Stammdaten
  const [supplierMasters, setSupplierMasters] = useState<SupplierMaster[]>(() =>
    loadSupplierMasters(),
  );

  function reloadMasters() {
    setSupplierMasters(loadSupplierMasters());
  }

  // Monatliche Dokumente
  const [docs, setDocs] = useState<SupplierDocument[]>(() =>
    loadDocumentsForMonth(CURRENT_YEAR, CURRENT_MONTH),
  );

  const summary    = useMemo(() => getMonthSummary(year, month),      [docs, year, month]);
  const comparison = useMemo(() => buildCostComparison(year, month),  [docs, year, month]);

  // Kumulierter Ist-Umsatz netto aus dailyBudgets (Brutto ÷ 1.081)
  const actualNetRevenue = useMemo(
    () => readCumulativeNetRevenue(tenantKey, year, month),
    [tenantKey, year, month, docs],
  );

  function reload(y: number, m: number) {
    setDocs(loadDocumentsForMonth(y, m));
  }

  function handleMonthChange(y: number, m: number) {
    setYear(y);
    setMonth(m);
    reload(y, m);
    setForecastRevenue(loadForecastRevenue(y, m));
  }

  // ── Forecast-Umsatz ─────────────────────────────────────────────────────────

  const [forecastRevenue, setForecastRevenue] = useState<number | null>(() =>
    loadForecastRevenue(CURRENT_YEAR, CURRENT_MONTH),
  );
  const [forecastTarget, setForecastTarget] = useState<number | null>(() =>
    loadForecastTarget(),
  );

  function handleForecastChange(v: number | null) {
    setForecastRevenue(v);
    saveForecastRevenue(year, month, v);
  }

  function handleTargetChange(v: number | null) {
    setForecastTarget(v);
    saveForecastTarget(v);
  }

  // ── Match-Vorschläge nach dem Speichern ─────────────────────────────────────

  const [matchSuggestions, setMatchSuggestions] = useState<{
    forDoc: SupplierDocument;
    candidates: MatchCandidate[];
  } | null>(null);

  function handleLinkDoc(docId: string, candidateId: string) {
    linkDocuments(docId, candidateId);
    reload(year, month);
    setMatchSuggestions(null);
    toast.success('Lieferschein und Rechnung verknüpft – Lieferschein wird nicht mehr doppelt gezählt');
  }

  function handleUnlinkDoc(docId: string) {
    unlinkDocuments(docId);
    reload(year, month);
    toast.success('Verknüpfung aufgehoben');
  }

  // ── Add-Dialog ──────────────────────────────────────────────────────────────

  const [showAdd, setShowAdd]   = useState(false);
  const [addForm, setAddForm]   = useState<FormState>(emptyForm);
  const [addError, setAddError] = useState('');

  function openAdd() {
    setAddForm({
      ...emptyForm(),
      date: `${year}-${String(month).padStart(2,'0')}-${new Date().getDate().toString().padStart(2,'0')}`,
    });
    setAddError('');
    setShowAdd(true);
  }

  function handleAdd() {
    if (!addForm.supplier.trim()) { setAddError('Lieferant ist erforderlich'); return; }
    const amt = parseFloat(addForm.amount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) { setAddError('Betrag muss eine positive Zahl sein (CHF)'); return; }

    const addSplits = addForm.useSplit && addForm.allocationSplits.length > 0
      ? addForm.allocationSplits : undefined;

    const saved = addDocument({
      supplier:         addForm.supplier,
      documentType:     addForm.documentType,
      date:             addForm.date,
      deliveryDate:     addForm.deliveryDate || undefined,
      category:         addForm.category,
      amount:           amt,
      accountNumber:    addForm.accountNumber || undefined,
      note:             addForm.note || undefined,
      referenceNumber:  addForm.referenceNumber || undefined,
      allocationTarget: addSplits ? undefined : (addForm.allocationTarget === 'unassigned' ? undefined : addForm.allocationTarget),
      allocationSplits: addSplits,
    });

    // Monatszuordnung anhand des effektiven Datums (Lieferdatum hat Vorrang)
    const eff = addForm.deliveryDate || addForm.date;
    const d = new Date(eff);
    reload(d.getFullYear(), d.getMonth() + 1);
    setShowAdd(false);
    toast.success(`Beleg von «${addForm.supplier}» wurde gespeichert`);

    // Duplikat-Prüfung: Gibt es ein passendes Gegenstück?
    const candidates = findMatchCandidates(saved);
    if (candidates.length > 0) {
      setMatchSuggestions({ forDoc: saved, candidates });
    }
  }

  // ── Edit-Dialog ─────────────────────────────────────────────────────────────

  const [editDoc, setEditDoc]   = useState<SupplierDocument | null>(null);
  const [editForm, setEditForm] = useState<FormState>(emptyForm);
  const [editError, setEditError] = useState('');

  function openEdit(doc: SupplierDocument) {
    const hasSplits = (doc.allocationSplits ?? []).length > 0;
    setEditForm({
      supplier:         doc.supplier,
      documentType:     doc.documentType,
      date:             doc.date,
      deliveryDate:     doc.deliveryDate ?? '',
      category:         doc.category,
      amount:           doc.amount.toFixed(2),
      accountNumber:    doc.accountNumber ?? '',
      note:             doc.note ?? '',
      referenceNumber:  doc.referenceNumber ?? '',
      allocationTarget: doc.allocationTarget ?? 'unassigned',
      allocationSplits: doc.allocationSplits ?? [],
      useSplit:         hasSplits,
    });
    setEditError('');
    setEditDoc(doc);
  }

  function handleEdit() {
    if (!editDoc) return;
    if (!editForm.supplier.trim()) { setEditError('Lieferant ist erforderlich'); return; }
    const amt = parseFloat(editForm.amount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) { setEditError('Betrag muss eine positive Zahl sein'); return; }

    const splits = editForm.useSplit && editForm.allocationSplits.length > 0
      ? editForm.allocationSplits : undefined;

    updateDocument(editDoc.id, {
      supplier:         editForm.supplier,
      documentType:     editForm.documentType,
      date:             editForm.date,
      deliveryDate:     editForm.deliveryDate || undefined,
      category:         editForm.category,
      amount:           amt,
      accountNumber:    editForm.accountNumber || undefined,
      note:             editForm.note || undefined,
      referenceNumber:  editForm.referenceNumber || undefined,
      allocationTarget: splits ? undefined : (editForm.allocationTarget === 'unassigned' ? undefined : editForm.allocationTarget),
      allocationSplits: splits,
    });
    reload(year, month);
    setEditDoc(null);
    toast.success('Beleg wurde aktualisiert');
  }

  // ── Löschen ─────────────────────────────────────────────────────────────────

  function handleDelete(doc: SupplierDocument) {
    if (!confirm(`Beleg von «${doc.supplier}» (${chf(doc.amount)}) wirklich löschen?`)) return;
    deleteDocument(doc.id);
    reload(year, month);
    toast.success('Beleg gelöscht');
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Kein Zugriff</p>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="h-6 w-6" />
            Lieferantendokumente
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Lieferscheine & Rechnungen · operative Warenkostenschätzung
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-purple-700 border-purple-300 bg-purple-50">Admin</Badge>
          <Link to="/lieferanten-vergleich">
            <Button variant="outline" size="sm" className="gap-1 text-xs">
              <Scale className="h-3.5 w-3.5" /> Vergleich / Kontrolle
            </Button>
          </Link>
          <Button onClick={openAdd} size="sm" className="gap-1">
            <Plus className="h-4 w-4" /> Beleg erfassen
          </Button>
        </div>
      </div>

      {/* Hinweis-Banner */}
      <Alert className="text-sm border-amber-200 bg-amber-50">
        <Info className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-amber-800">
          <strong>Operative Schätzwerte:</strong> Die hier erfassten Beträge sind laufende Schätzwerte
          aus Lieferscheinen und Rechnungen. Der offizielle Wareneinsatz kommt aus dem
          Buchhaltungsabschluss (PDF/CSV-Import) am Monatsende und hat immer Vorrang.
        </AlertDescription>
      </Alert>

      {/* Inventur-Kontrollartikel Panel */}
      {kontrollartikel.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-100/60 transition-colors"
            onClick={() => setShowKontrollartikel(v => !v)}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
              <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
              Inventur-Kontrollartikel ({kontrollartikel.length})
              <span className="font-normal text-amber-700 dark:text-amber-400">
                — Artikel mit besonderer Aufmerksamkeit bei Lieferungen
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 text-amber-600 transition-transform ${showKontrollartikel ? 'rotate-180' : ''}`} />
          </button>
          {showKontrollartikel && (
            <div className="border-t border-amber-200 dark:border-amber-800 px-4 py-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {kontrollartikel.map(a => (
                  <div
                    key={a.id}
                    className="flex items-start gap-2 rounded-md bg-white dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2"
                  >
                    <Star className="h-3 w-3 mt-0.5 shrink-0 fill-amber-400 text-amber-500" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        <span className={`text-[10px] px-1.5 py-px rounded font-medium ${
                          a.inventoryType === 'food'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-blue-100 text-blue-700'
                        }`}>
                          {a.inventoryType === 'food' ? 'Food' : 'Beverage'}
                        </span>
                        <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-px rounded">{a.unit}</span>
                        {a.accountingAccount && (
                          <span className="text-[10px] bg-violet-100 text-violet-700 border border-violet-200 px-1.5 py-px rounded font-mono">
                            {getFibuLabel(a.accountingAccount)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-3">
                Diese Artikel sind im Artikelstamm als «Inventur-relevant» markiert. Stelle sicher, dass Lieferungen für diese Artikel vollständig erfasst werden.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Monat-Selektor */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-muted-foreground">Zeitraum:</span>
            <Select value={String(year)} onValueChange={v => handleMonthChange(Number(v), month)}>
              <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(month)} onValueChange={v => handleMonthChange(year, Number(v))}>
              <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {summary.documentCount} {summary.documentCount === 1 ? 'Beleg' : 'Belege'} erfasst
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Zusammenfassungskarten */}
      <SummaryCards
        foodCost={summary.foodCost}
        beverageCost={summary.beverageCost}
        otherCost={summary.otherCost}
        totalCost={summary.totalCost}
        betriebsaufwandCost={summary.betriebsaufwandCost}
        docCount={summary.documentCount}
      />

      {/* Forecast-Karte */}
      <ForecastCard
        totalCost={summary.totalCost}
        forecastRevenue={forecastRevenue}
        onForecastChange={handleForecastChange}
        forecastTarget={forecastTarget}
        onTargetChange={handleTargetChange}
        actualNetRevenue={actualNetRevenue}
      />

      {/* ── Match-Vorschläge Panel ─────────────────────────────────────────── */}
      {matchSuggestions && (
        <div className="rounded-xl border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-violet-200 dark:border-violet-700 bg-violet-100/60 dark:bg-violet-900/20">
            <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">
              Mögliche Übereinstimmung gefunden
            </span>
            <span className="text-xs text-violet-600 dark:text-violet-400 ml-1">
              — Gehört dieser neue Beleg zu einem bereits erfassten Gegenstück?
            </span>
            <button
              className="ml-auto text-violet-500 hover:text-violet-800 dark:hover:text-violet-200 transition-colors"
              onClick={() => setMatchSuggestions(null)}
            >
              ×
            </button>
          </div>
          <div className="p-4 space-y-3">
            <div className="rounded-lg border border-violet-200 dark:border-violet-700 bg-white dark:bg-violet-950/20 px-3 py-2 text-xs text-violet-700 dark:text-violet-400 flex items-start gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                <strong>Neuer Beleg:</strong> {DOCUMENT_TYPE_LABELS[matchSuggestions.forDoc.documentType]} von «{matchSuggestions.forDoc.supplier}»
                {' '}· {chf(matchSuggestions.forDoc.amount)} · {new Date(matchSuggestions.forDoc.date).toLocaleDateString('de-CH')}
                <br />
                Wenn du unten «Verknüpfen» klickst, wird der <strong>Lieferschein</strong> aus der Monatssumme ausgeschlossen
                (die Rechnung zählt), um Doppelzählung zu vermeiden.
              </span>
            </div>

            <div className="space-y-2">
              {matchSuggestions.candidates.map(c => {
                const isLinkedDoc  = matchSuggestions.forDoc.documentType === 'invoice';
                const deliveryNote = isLinkedDoc ? c.document : matchSuggestions.forDoc;
                const invoice      = isLinkedDoc ? matchSuggestions.forDoc : c.document;
                return (
                  <div key={c.document.id}
                    className="flex items-center gap-3 rounded-lg border border-violet-200 dark:border-violet-700 bg-white dark:bg-violet-950/10 px-3 py-2.5">
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-700 dark:text-violet-400">
                          {DOCUMENT_TYPE_LABELS[c.document.documentType]}
                        </Badge>
                        <span className="text-sm font-medium">{c.document.supplier}</span>
                        <span className="text-xs font-mono font-semibold">{chf(c.document.amount)}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {new Date(c.document.date).toLocaleDateString('de-CH')}
                        </span>
                        {c.amountDiff > 0 && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">
                            Δ {chf(c.amountDiff)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {c.reasons.map(r => (
                          <span key={r} className="text-[10px] bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-700 px-1.5 py-0.5 rounded">
                            {r}
                          </span>
                        ))}
                        <span className="text-[10px] text-muted-foreground">Score: {c.score}</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="text-xs h-8 gap-1.5 bg-violet-600 hover:bg-violet-700 text-white shrink-0"
                      onClick={() => handleLinkDoc(deliveryNote.id, invoice.id)}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Verknüpfen
                    </Button>
                  </div>
                );
              })}
            </div>

            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground h-7" onClick={() => setMatchSuggestions(null)}>
              Nein, kein Duplikat – schliessen
            </Button>
          </div>
        </div>
      )}

      {/* Dokumententabelle */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Belege – {MONTHS[month - 1]} {year}</CardTitle>
          <Button variant="outline" size="sm" onClick={openAdd} className="h-8 text-xs gap-1">
            <Plus className="h-3.5 w-3.5" /> Hinzufügen
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {docs.length === 0 ? (
            <div className="py-14 text-center text-muted-foreground">
              <Truck className="h-10 w-10 mx-auto mb-3 opacity-25" />
              <p className="text-sm">Noch keine Belege für {MONTHS[month - 1]} {year}</p>
              <p className="text-xs mt-1">Klicken Sie auf «Beleg erfassen» um den ersten Eintrag hinzuzufügen</p>
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead title="Grün = Lieferdatum (massgeblich). Grau = Belegdatum.">Datum</TableHead>
                    <TableHead>Lieferant</TableHead>
                    <TableHead>Typ / Status</TableHead>
                    <TableHead>Kategorie</TableHead>
                    <TableHead>Konto</TableHead>
                    <TableHead className="text-right">Betrag CHF</TableHead>
                    <TableHead>Notiz / Ref.</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => {
                    const isLinked    = doc.matchStatus === 'linked';
                    const isSuggested = doc.matchStatus === 'suggested';
                    const isExcluded  = isLinked && doc.documentType === 'delivery_note';
                    const linkedDoc   = doc.linkedDocumentId ? docs.find(d => d.id === doc.linkedDocumentId) : null;

                    return (
                    <TableRow key={doc.id} className={cn(isExcluded && 'opacity-60 bg-muted/20')}>
                      <TableCell className="text-sm font-mono">
                        {doc.deliveryDate ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="text-emerald-700 font-semibold" title={`Lieferdatum: ${doc.deliveryDate} (massgeblich)`}>
                              {new Date(doc.deliveryDate).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })}
                            </span>
                            <span className="text-[10px] text-muted-foreground leading-none" title={`Belegdatum: ${doc.date}`}>
                              Beleg: {new Date(doc.date).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })}
                            </span>
                          </span>
                        ) : (
                          new Date(doc.date).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })
                        )}
                      </TableCell>
                      <TableCell className="text-sm font-medium">{doc.supplier}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline" className="text-[10px] font-normal w-fit">
                            {DOCUMENT_TYPE_LABELS[doc.documentType]}
                          </Badge>
                          {isLinked && (
                            <span className={cn(
                              'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border w-fit',
                              isExcluded
                                ? 'bg-gray-100 text-gray-500 border-gray-300 dark:bg-gray-800 dark:text-gray-400'
                                : 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400',
                            )}>
                              <Link2 className="h-2.5 w-2.5" />
                              {isExcluded ? 'Fakturiert (ausgeschlossen)' : 'Fakturiert'}
                            </span>
                          )}
                          {isSuggested && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-900/30 dark:text-violet-400 w-fit">
                              <Sparkles className="h-2.5 w-2.5" />
                              Vorgeschlagen
                            </span>
                          )}
                          {linkedDoc && (
                            <span className="text-[10px] text-muted-foreground">
                              ↔ {DOCUMENT_TYPE_LABELS[linkedDoc.documentType]} {new Date(linkedDoc.date).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell><CatBadge cat={doc.category} /></TableCell>
                      <TableCell>
                        {doc.accountNumber ? (
                          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border border-border">
                            {doc.accountNumber}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">—</span>
                        )}
                      </TableCell>
                      <TableCell className={cn(
                        'text-right font-mono text-sm font-medium',
                        isExcluded && 'line-through text-muted-foreground',
                      )}>
                        {chf(doc.amount)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[160px]">
                        {doc.referenceNumber && (
                          <span className="block font-mono text-[10px] text-foreground/70">#{doc.referenceNumber}</span>
                        )}
                        <span className="truncate block">{doc.note ?? '—'}</span>
                        {doc.allocationSplits && doc.allocationSplits.length > 0 ? (
                          <div className="mt-1 space-y-0.5">
                            <span className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">Zuordnung (Split):</span>
                            <div className="flex flex-wrap gap-0.5">
                              {doc.allocationSplits.map((s, i) => (
                                <span key={i} className="inline-flex items-center gap-0.5 text-[9px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 border border-violet-300 dark:border-violet-700 px-1.5 py-0.5 rounded">
                                  <Tag className="h-2 w-2" />
                                  <span className="font-bold">{s.pct}%</span>
                                  {' '}{ALLOCATION_TARGET_LABELS[s.target]}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : doc.allocationTarget && doc.allocationTarget !== 'unassigned' ? (
                          <div className="mt-1">
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 border border-violet-300 dark:border-violet-700 px-1.5 py-0.5 rounded">
                              <Tag className="h-2 w-2" />{ALLOCATION_TARGET_LABELS[doc.allocationTarget]}
                            </span>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {isLinked && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-amber-600"
                              title="Verknüpfung aufheben"
                              onClick={() => handleUnlinkDoc(doc.id)}
                            >
                              <Link2Off className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(doc)}>
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDelete(doc)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Buchhaltungsvergleich */}
      <ComparisonSection comp={comparison} />

      {/* Lieferantenstamm-Verwaltung */}
      <SupplierMasterPanel
        masters={supplierMasters}
        accounts={accounts}
        onChanged={reloadMasters}
      />

      {/* ── Add-Dialog ── */}
      <DocumentDialog
        open={showAdd}
        title="Beleg erfassen"
        form={addForm}
        error={addError}
        supplierMasters={supplierMasters}
        accounts={accounts}
        onFormChange={setAddForm}
        onSave={handleAdd}
        onClose={() => setShowAdd(false)}
        onSupplierMasterCreated={m => { reloadMasters(); }}
      />

      {/* ── Edit-Dialog ── */}
      <DocumentDialog
        open={!!editDoc}
        title="Beleg bearbeiten"
        form={editForm}
        error={editError}
        supplierMasters={supplierMasters}
        accounts={accounts}
        onFormChange={setEditForm}
        onSave={handleEdit}
        onClose={() => setEditDoc(null)}
        onSupplierMasterCreated={m => { reloadMasters(); }}
      />
    </div>
  );
}
