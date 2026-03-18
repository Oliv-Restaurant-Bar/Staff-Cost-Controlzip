/**
 * Budget-Seite – Admin-only (P&L Erfolgsrechnung)
 * =================================================
 *
 * Vollständige P&L-Hierarchie:
 *   Betriebsertrag → Warenaufwand → Bruttogewinn 1
 *   → Personal → Total Personal → Bruttogewinn 2
 *   → Raumaufwand → Unterhalt → Verwaltung → EBITDA
 *
 * Spalten: [Name/Konto (sticky)] | [Kumuliert] | Jan … Dez
 *   - Kumuliert = Jahressumme (für Positionen editierbar → verteilen)
 *   - Klick auf Monatszelle → Inline-Editor
 *   - «+» in der linken Spalte jeder Kategorie → Unterkonto hinzufügen
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import {
  BudgetYear, BudgetPLCategory, BudgetPLLineItem,
  BudgetRule, BudgetRuleType, BudgetPosition,
  BUDGET_MONTH_NAMES, BUDGET_MONTH_NAMES_FULL,
} from '@/types/budget';

import {
  loadBudgetWithPL, saveBudgetYear, availableBudgetYears,
  copyBudgetYear, applyRulesToBudget,
  addBudgetRule, removeBudgetRule, deleteBudgetYear,
  savePLLineItem, addCustomPLLineItem, removeCustomPLLineItem,
  computePLCategoryTotals, computePLResultTotals,
  restoreMissingDefaultPLItems,
} from '@/lib/budget-store';

import { Button }  from '@/components/ui/button';
import { Badge }   from '@/components/ui/badge';
import { Input }   from '@/components/ui/input';
import { Label }   from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Calculator, Copy, Plus, Trash2,
  AlertTriangle, CheckCircle2,
  RefreshCw, ChevronDown, ChevronRight, SplitSquareHorizontal,
} from 'lucide-react';

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

const CHF = (n: number) =>
  new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
const PCT = (n: number) => `${n.toFixed(1)} %`;

/**
 * Verteilt einen Jahresbetrag gleichmässig auf 12 Monate.
 * Der Rest (aus der Division) wird auf Januar addiert.
 */
function distributeYearly(yearly: number): number[] {
  const base  = Math.floor(yearly / 12);
  const extra = yearly - base * 12;
  return Array(12).fill(0).map((_, i) => (i === 0 ? base + extra : base));
}

// ─── Farbschema pro Kategorie ─────────────────────────────────────────────────

const CAT_STYLE: Record<string, {
  header: string; border: string; result: string; kum: string;
}> = {
  green:  { header: 'bg-green-50  dark:bg-green-950/30  text-green-900  dark:text-green-100',  border: 'border-l-green-500',  result: 'bg-green-100  dark:bg-green-900/40  text-green-900  dark:text-green-100  font-bold', kum: 'bg-green-100/80  dark:bg-green-900/30'  },
  orange: { header: 'bg-orange-50 dark:bg-orange-950/30 text-orange-900 dark:text-orange-100', border: 'border-l-orange-400', result: 'bg-orange-100 dark:bg-orange-900/40 text-orange-900 dark:text-orange-100 font-bold', kum: 'bg-orange-100/80 dark:bg-orange-900/30' },
  blue:   { header: 'bg-blue-50   dark:bg-blue-950/30   text-blue-900   dark:text-blue-100',   border: 'border-l-blue-500',   result: 'bg-blue-100   dark:bg-blue-900/40   text-blue-900   dark:text-blue-100   font-bold', kum: 'bg-blue-100/80   dark:bg-blue-900/30'   },
  gray:   { header: 'bg-gray-50   dark:bg-gray-900/60   text-gray-800   dark:text-gray-200',   border: 'border-l-gray-400',   result: 'bg-gray-100   dark:bg-gray-800/60   text-gray-800   dark:text-gray-200   font-bold', kum: 'bg-gray-100/80   dark:bg-gray-800/30'   },
  purple: { header: 'bg-violet-50 dark:bg-violet-950/30 text-violet-900 dark:text-violet-100', border: 'border-l-violet-500', result: 'bg-violet-100 dark:bg-violet-900/40 text-violet-900 dark:text-violet-100 font-bold text-[13px]', kum: 'bg-violet-100/80 dark:bg-violet-900/30' },
  amber:  { header: 'bg-amber-50  dark:bg-amber-950/30  text-amber-900  dark:text-amber-100',  border: 'border-l-amber-400',  result: 'bg-amber-100  dark:bg-amber-900/40  text-amber-900  dark:text-amber-100  font-bold', kum: 'bg-amber-100/80  dark:bg-amber-900/30'  },
  red:    { header: 'bg-red-50    dark:bg-red-950/30    text-red-900    dark:text-red-100',    border: 'border-l-red-400',    result: 'bg-red-100    dark:bg-red-900/40    text-red-900    dark:text-red-100    font-bold', kum: 'bg-red-100/80    dark:bg-red-900/30'    },
};

// ─── Inline-Editor für Monatszelle ────────────────────────────────────────────

function MonthCellEditor({
  value, valueType, revenueForMonth, onCommit, onCancel,
}: {
  value: number; valueType: 'chf' | 'percent';
  revenueForMonth: number;
  onCommit: (v: number) => void; onCancel: () => void;
}) {
  const [raw, setRaw] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const commit = () => {
    const n = parseFloat(raw.replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
    onCommit(n);
  };
  const chfPreview = valueType === 'percent' && revenueForMonth > 0
    ? Math.round((parseFloat(raw) || 0) / 100 * revenueForMonth) : null;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <input
        ref={ref} type="number"
        step={valueType === 'percent' ? 0.1 : 100}
        className="w-[72px] h-7 text-xs text-right font-mono rounded border border-primary bg-background px-1 focus:outline-none focus:ring-1 focus:ring-primary"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel(); }}
        onBlur={commit}
      />
      {chfPreview !== null && (
        <span className="text-[9px] text-muted-foreground">≈ {CHF(chfPreview)}</span>
      )}
    </div>
  );
}

// ─── Inline-Editor für Kumuliert-Spalte ──────────────────────────────────────

function KumuliertEditor({
  yearly, onCommit, onCancel,
}: {
  yearly: number; onCommit: (v: number) => void; onCancel: () => void;
}) {
  const [raw, setRaw] = useState(String(yearly));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const commit = () => {
    const n = parseFloat(raw.replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
    onCommit(n);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={ref} type="number" step={1000}
        className="w-[90px] h-7 text-xs text-right font-mono font-semibold rounded border border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-1 focus:outline-none focus:ring-1 focus:ring-amber-500"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel(); }}
        onBlur={commit}
      />
      <span className="text-[9px] text-amber-700 dark:text-amber-400 leading-none">Jahreswert</span>
    </div>
  );
}

// ─── Haupt-Export ──────────────────────────────────────────────────────────────

export default function BudgetPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <BudgetContent />;
}

// ─── Haupt-Inhalt ─────────────────────────────────────────────────────────────

function BudgetContent() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [budget, setBudget]             = useState<BudgetYear>(() => loadBudgetWithPL(currentYear));
  const [savedYears, setSavedYears]     = useState<number[]>(() => availableBudgetYears());
  const [activeTab, setActiveTab]       = useState<'pl' | 'rules'>('pl');

  // Ausgeklappte / eingeklappte Kategorien (default: alles ausgeklappt)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string) =>
    setCollapsed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // Zellen-Bearbeitungsstatus
  const [editCell, setEditCell]           = useState<{ itemId: string; month: number } | null>(null);
  const [editKumuliert, setEditKumuliert] = useState<string | null>(null); // itemId

  // Dialoge
  const [copyDialog,    setCopyDialog]    = useState(false);
  const [ruleDialog,    setRuleDialog]    = useState(false);
  const [addItemDialog, setAddItemDialog] = useState<{ categoryId: string } | null>(null);
  const [deleteDialog,  setDeleteDialog]  = useState(false);

  const reload = useCallback((year: number) => {
    setBudget(loadBudgetWithPL(year));
    setSavedYears(availableBudgetYears());
  }, []);

  useEffect(() => { reload(selectedYear); }, [selectedYear, reload]);

  // ── Berechnungen ─────────────────────────────────────────────────────────────

  const categories  = budget.plCategories ?? [];
  const lineItems   = budget.plLineItems   ?? [];

  const categoryTotals = useMemo(() => computePLCategoryTotals(lineItems), [lineItems]);
  const resultTotals   = useMemo(() => computePLResultTotals(categories, categoryTotals), [categories, categoryTotals]);
  const revenueByMonth = useMemo(() => categoryTotals['pl_revenue'] ?? Array(12).fill(0), [categoryTotals]);

  // Jahres-KPIs
  const totalRevenue  = revenueByMonth.reduce((s, v) => s + v, 0);
  const ebitdaMonths  = resultTotals['pl_ebitda'] ?? Array(12).fill(0);
  const ebitdaTotal   = ebitdaMonths.reduce((s, v) => s + v, 0);
  const personnelTot  = (resultTotals['pl_total_personnel'] ?? Array(12).fill(0)).reduce((s, v) => s + v, 0);
  const personnelRatio = totalRevenue > 0 ? personnelTot / totalRevenue * 100 : null;

  // Monatliche Totals einer Kategorie (Items + Result-Zeilen)
  const getMonthly = (catId: string): number[] =>
    resultTotals[catId] ?? categoryTotals[catId] ?? Array(12).fill(0);

  // Jahressumme für eine Lineitem (CHF – %-Positionen werden aufgelöst)
  const itemYearly = (item: BudgetPLLineItem): number =>
    item.monthlyValues.reduce((s, v, m) =>
      s + (item.valueType === 'percent' ? Math.round(v / 100 * revenueByMonth[m]) : v), 0);

  // ── Speichern / Bearbeitung ──────────────────────────────────────────────────

  const commitMonth = (itemId: string, month: number, newVal: number) => {
    const item = lineItems.find(i => i.id === itemId);
    if (!item) return;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[month] = newVal;
    setBudget(savePLLineItem(selectedYear, { ...item, monthlyValues: vals }));
    setEditCell(null);
  };

  const commitKumuliert = (itemId: string, yearly: number) => {
    setEditKumuliert(null);
    const item = lineItems.find(i => i.id === itemId);
    if (!item) return;

    // Wenn %-Position: nicht verteilen (% machen keinen Sinn als Jahresbetrag in CHF)
    if (item.valueType === 'percent') {
      toast.info('%-Positionen können nicht als Jahres-CHF verteilt werden. Bitte die Monatszellen direkt bearbeiten.');
      return;
    }

    const distributed = distributeYearly(yearly) as BudgetPLLineItem['monthlyValues'];

    // Toast mit Bestätigungs-Action
    toast('Jahreswert gleichmässig auf Jan–Dez verteilen?', {
      description: `CHF ${CHF(yearly)} ÷ 12 = CHF ${CHF(Math.floor(yearly / 12))} pro Monat`,
      action: {
        label: 'Gleichmässig verteilen',
        onClick: () => {
          setBudget(savePLLineItem(selectedYear, { ...item, monthlyValues: distributed }));
          toast.success(`CHF ${CHF(yearly)} auf alle Monate verteilt`);
        },
      },
      cancel: { label: 'Abbrechen', onClick: () => {} },
      duration: 8000,
    });
  };

  const handleApplyRules = () => {
    if (budget.rules.length === 0) { toast.info('Keine Regeln definiert.'); return; }
    const upd = applyRulesToBudget(budget);
    saveBudgetYear(upd);
    setBudget(upd);
    toast.success(`${budget.rules.length} Regel(n) angewendet`);
  };

  const handleRestoreDefaults = () => {
    const { budget: upd, added } = restoreMissingDefaultPLItems(selectedYear);
    setBudget(upd);
    if (added === 0) {
      toast.info('Alle Standardkonten sind bereits vorhanden.');
    } else {
      toast.success(`${added} fehlende Standardkonto${added !== 1 ? 'en' : ''} hinzugefügt.`);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 max-w-[1700px] mx-auto space-y-5">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calculator className="h-6 w-6 text-primary" />
            Budget-Planung
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Jahresbudget · Erfolgsrechnung · Unterkonten · CHF und %-Positionen
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(y => (
                <SelectItem key={y} value={String(y)}>{y} {savedYears.includes(y) ? '✓' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setCopyDialog(true)} className="gap-1.5">
            <Copy className="h-4 w-4" /> Jahr kopieren
          </Button>
          <Button variant="outline" size="sm" onClick={handleRestoreDefaults} className="gap-1.5" title="Fehlende Standardkonten (Oliv-Kontenplan) hinzufügen">
            <CheckCircle2 className="h-4 w-4" /> Standardkonten
          </Button>
          <Button variant="outline" size="sm" onClick={handleApplyRules} className="gap-1.5">
            <RefreshCw className="h-4 w-4" /> Regeln anwenden
          </Button>
          {savedYears.includes(selectedYear) && (
            <Button variant="outline" size="sm" onClick={() => setDeleteDialog(true)}
              className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ── Jahres-KPIs ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label={`Umsatz Budget ${selectedYear}`} value={`CHF ${CHF(totalRevenue)}`} color="green" />
        <KpiCard
          label="Personalkosten Budget"
          value={`CHF ${CHF(personnelTot)}`}
          sub={personnelRatio !== null ? `${PCT(personnelRatio)} des Umsatzes` : undefined}
          color="blue"
        />
        <KpiCard
          label="EBITDA Budget"
          value={`${ebitdaTotal >= 0 ? '+' : ''}CHF ${CHF(ebitdaTotal)}`}
          color={ebitdaTotal >= 0 ? 'green' : 'red'}
        />
        <KpiCard
          label="Positionen / Regeln"
          value={`${lineItems.length} / ${budget.rules.length}`}
          sub="Unterkonten / Anpassungsregeln"
        />
      </div>

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'pl' | 'rules')}>
        <TabsList>
          <TabsTrigger value="pl">Budgetplanung (P&amp;L)</TabsTrigger>
          <TabsTrigger value="rules">
            Anpassungsregeln
            {budget.rules.length > 0 && <Badge className="ml-1.5 h-4 px-1 text-xs">{budget.rules.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: P&L Tabelle ── */}
        <TabsContent value="pl" className="mt-4">

          {/* Legende */}
          <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 border border-amber-400" />
              Kumuliert = Jahreswert (anklicken → Jahresbetrag eingeben → auf Monate verteilen)
            </span>
            <span className="flex items-center gap-1">
              <span className="text-blue-600 font-medium">Blau = %-Position</span>
              (Anteil am Jahresumsatz)
            </span>
            <span className="flex items-center gap-1">
              <Plus className="h-3 w-3" /> = Unterkonto hinzufügen
            </span>
          </div>

          <div className="rounded-lg border overflow-auto shadow-sm">
            <table className="w-full text-sm border-collapse" style={{ minWidth: '1200px' }}>
              <thead>
                <tr className="bg-muted/80 border-b-2 border-border">
                  {/* Sticky linke Spalte: Konto / Bezeichnung */}
                  <th className="sticky left-0 bg-muted/80 z-20 text-left py-2.5 px-3 w-[280px] min-w-[280px] font-semibold text-xs uppercase tracking-wide border-r border-border">
                    Konto / Bezeichnung
                  </th>
                  {/* Kumuliert (Jahressumme) */}
                  <th className="text-right py-2.5 px-2 font-bold text-xs bg-amber-50/80 dark:bg-amber-950/20 border-r-2 border-amber-300 min-w-[100px]">
                    Kumuliert
                  </th>
                  {/* Monatsspalten */}
                  {BUDGET_MONTH_NAMES.map(m => (
                    <th key={m} className="text-right py-2.5 px-2 font-semibold text-xs min-w-[78px]">{m}</th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {categories
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map(cat => {
                    const style     = CAT_STYLE[cat.color] ?? CAT_STYLE.gray;
                    const items     = lineItems.filter(i => i.categoryId === cat.id).sort((a, b) => a.sortOrder - b.sortOrder);
                    const monthly   = getMonthly(cat.id);
                    const yearTotal = monthly.reduce((s, v) => s + v, 0);
                    const isColl    = collapsed.has(cat.id);

                    // ── Zwischenergebnis-Zeile (type='result') ────────────────
                    if (cat.type === 'result') {
                      return (
                        <tr key={cat.id} className={cn('border-t-2 border-b border-border', style.result)}>
                          <td className={cn('sticky left-0 z-10 py-2.5 px-4 font-bold text-sm border-r border-border', style.result)}>
                            {cat.label}
                          </td>
                          {/* Kumuliert: Jahressumme */}
                          <td className={cn('text-right py-2.5 px-3 font-mono font-bold text-sm border-r-2 border-amber-300', style.kum,
                            yearTotal < 0 ? 'text-red-700 dark:text-red-400' : '')}>
                            {CHF(yearTotal)}
                          </td>
                          {monthly.map((v, m) => (
                            <td key={m} className={cn('text-right py-2.5 px-2 font-mono font-bold text-xs', style.result,
                              v < 0 ? 'text-red-700 dark:text-red-400' : '')}>
                              {v !== 0 ? CHF(v) : '–'}
                            </td>
                          ))}
                          <td />
                        </tr>
                      );
                    }

                    // ── Kategorie-Kopfzeile (type='items') ───────────────────
                    return [
                      <tr
                        key={`${cat.id}-hdr`}
                        className={cn('border-t-2 border-border border-l-4 select-none', style.header, style.border)}
                      >
                        {/* Sticky: Kategoriename + Plus-Button */}
                        <td
                          className={cn(
                            'sticky left-0 z-10 py-2.5 px-3 border-r border-border border-l-4 cursor-pointer',
                            style.header, style.border,
                          )}
                          onClick={() => toggleCollapsed(cat.id)}
                        >
                          <div className="flex items-center gap-2">
                            {isColl
                              ? <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                              : <ChevronDown  className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
                            }
                            <span className="font-bold text-[13px]">{cat.label}</span>
                            <span className="text-[10px] font-normal opacity-50 ml-1">({items.length})</span>
                            {/* Plus-Button: immer sichtbar im linken Bereich */}
                            <button
                              title={`Unterkonto zu «${cat.label}» hinzufügen`}
                              className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border border-current/30 hover:bg-black/10 dark:hover:bg-white/10 transition-colors opacity-80 hover:opacity-100 flex-shrink-0"
                              onClick={e => { e.stopPropagation(); setAddItemDialog({ categoryId: cat.id }); }}
                            >
                              <Plus className="h-3 w-3" />
                              Konto
                            </button>
                          </div>
                        </td>
                        {/* Kumuliert: Kategoriesumme */}
                        <td className={cn('text-right py-2.5 px-3 font-mono font-bold text-xs border-r-2 border-amber-300', style.kum)}>
                          {yearTotal !== 0 ? CHF(yearTotal) : '–'}
                        </td>
                        {monthly.map((v, m) => (
                          <td key={m} className={cn('text-right py-2.5 px-2 font-mono font-semibold text-xs', style.header)}>
                            {v !== 0 ? CHF(v) : '–'}
                          </td>
                        ))}
                        <td />
                      </tr>,

                      // ── Einzelpositionen (Unterkonten) ─────────────────────
                      ...(!isColl ? items.map(item => {
                        const iyearly   = itemYearly(item);
                        const isEditKum = editKumuliert === item.id;

                        return (
                          <tr key={item.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors group">
                            {/* Sticky linke Zelle */}
                            <td className="sticky left-0 bg-background z-10 py-1.5 pl-8 pr-2 border-r border-border">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] font-mono text-muted-foreground w-9 flex-shrink-0 tabular-nums">
                                  {item.accountNumber}
                                </span>
                                <span className="text-xs">{item.label}</span>
                                {item.department && (
                                  <span className={cn('text-[9px] px-1 py-0 rounded border flex-shrink-0',
                                    item.department === 'küche'    ? 'bg-orange-50 border-orange-200 text-orange-700' :
                                    item.department === 'service'  ? 'bg-blue-50   border-blue-200   text-blue-700'   :
                                    'bg-gray-50 border-gray-200 text-gray-600')}>
                                    {item.department}
                                  </span>
                                )}
                                <span className={cn('text-[9px] px-1 py-0 rounded border flex-shrink-0 ml-auto',
                                  item.valueType === 'percent'
                                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                                    : 'bg-gray-50 border-gray-200 text-gray-600')}>
                                  {item.valueType === 'percent' ? '%' : 'CHF'}
                                </span>
                              </div>
                            </td>

                            {/* Kumuliert-Zelle (editierbar → Jahreswert eingeben → verteilen) */}
                            <td
                              className="text-right py-1.5 px-2 font-mono text-xs font-semibold border-r-2 border-amber-300 bg-amber-50/40 dark:bg-amber-950/10 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition-colors"
                              onClick={() => !isEditKum && item.valueType !== 'percent' && setEditKumuliert(item.id)}
                              title={item.valueType === 'percent' ? '%-Positionen: Monate direkt bearbeiten' : 'Jahreswert eingeben → gleichmässig verteilen'}
                            >
                              {isEditKum ? (
                                <KumuliertEditor
                                  yearly={iyearly}
                                  onCommit={v => commitKumuliert(item.id, v)}
                                  onCancel={() => setEditKumuliert(null)}
                                />
                              ) : (
                                <div className="flex flex-col items-end">
                                  {item.valueType === 'percent'
                                    ? <span className="text-blue-700 dark:text-blue-300 flex items-center gap-1">
                                        {CHF(iyearly)}
                                        <span className="text-[9px] opacity-60">(CHF)</span>
                                      </span>
                                    : <span className="flex items-center gap-1">
                                        {iyearly !== 0 ? CHF(iyearly) : <span className="text-muted-foreground/30">–</span>}
                                        {iyearly !== 0 && (
                                          <SplitSquareHorizontal className="h-3 w-3 text-amber-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        )}
                                      </span>
                                  }
                                </div>
                              )}
                            </td>

                            {/* Monatszellen (inline-editierbar) */}
                            {item.monthlyValues.map((val, m) => {
                              const isEdit = editCell?.itemId === item.id && editCell?.month === m;
                              const chfVal = item.valueType === 'percent'
                                ? Math.round(val / 100 * revenueByMonth[m]) : val;

                              return (
                                <td
                                  key={m}
                                  className="text-right py-1.5 px-1 font-mono text-xs cursor-pointer hover:bg-primary/5 rounded transition-colors"
                                  onClick={() => !isEdit && setEditCell({ itemId: item.id, month: m })}
                                >
                                  {isEdit ? (
                                    <MonthCellEditor
                                      value={val}
                                      valueType={item.valueType}
                                      revenueForMonth={revenueByMonth[m]}
                                      onCommit={v => commitMonth(item.id, m, v)}
                                      onCancel={() => setEditCell(null)}
                                    />
                                  ) : (
                                    <div className="flex flex-col items-end leading-tight">
                                      {item.valueType === 'percent'
                                        ? <span className="text-blue-700 dark:text-blue-300">{PCT(val)}</span>
                                        : <span>{val !== 0 ? CHF(val) : <span className="text-muted-foreground/25">–</span>}</span>
                                      }
                                      {item.valueType === 'percent' && chfVal > 0 && (
                                        <span className="text-[9px] text-muted-foreground">{CHF(chfVal)}</span>
                                      )}
                                    </div>
                                  )}
                                </td>
                              );
                            })}

                            {/* Löschen (nur benutzerdefinierte Positionen) */}
                            <td className="text-right pr-1">
                              {!item.isDefault && (
                                <button
                                  className="h-6 w-6 rounded hover:bg-red-100 flex items-center justify-center text-muted-foreground hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                                  title="Position löschen"
                                  onClick={() => {
                                    try {
                                      setBudget(removeCustomPLLineItem(selectedYear, item.id));
                                      toast.success('Position entfernt');
                                    } catch { toast.error('Standard-Positionen können nicht gelöscht werden'); }
                                  }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      }) : []),
                    ];
                  })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1 flex-wrap">
            <span>Klick auf Monatszelle → direkt bearbeiten</span>
            <span className="text-muted-foreground/40">·</span>
            <span>Klick auf <strong className="text-amber-700">Kumuliert</strong> → Jahresbetrag eingeben → gleichmässig auf Monate verteilen</span>
            <span className="text-muted-foreground/40">·</span>
            <span>«<strong>+ Konto</strong>» → Unterkategorie hinzufügen</span>
          </p>
        </TabsContent>

        {/* ── TAB: Regeln ── */}
        <TabsContent value="rules" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground max-w-xl">
              Regeln ermöglichen automatische Anpassungen beim Jahr-Kopieren
              (z.B. Umsatz +5 %, Personalkosten-Quote 32 %).
            </p>
            <Button size="sm" onClick={() => setRuleDialog(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> Neue Regel
            </Button>
          </div>

          {budget.rules.length === 0 ? (
            <Alert><AlertDescription>
              Keine Regeln definiert. Erstelle eine Regel um das Budget automatisch anzupassen.
            </AlertDescription></Alert>
          ) : (
            <div className="space-y-2">
              {budget.rules.map(rule => {
                const pos = budget.positions.find(p => p.id === rule.positionId);
                return (
                  <div key={rule.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                    <div>
                      <p className="text-sm font-medium">{rule.description}</p>
                      <p className="text-xs text-muted-foreground">
                        Position: {pos?.label ?? rule.positionId}
                        {rule.month && ` · Monat: ${BUDGET_MONTH_NAMES_FULL[rule.month - 1]}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">
                        {rule.type === 'monthly_fixed_override' ? `CHF ${CHF(rule.value)}` : `${rule.value}%`}
                      </Badge>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:bg-red-50"
                        onClick={() => { setBudget(removeBudgetRule(selectedYear, rule.id)); toast.success('Regel entfernt'); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {budget.wasAutoCalculated && (
            <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-700 dark:text-green-300">
                Dieses Budget enthält automatisch berechnete Werte.
              </AlertDescription>
            </Alert>
          )}

          <Button onClick={handleApplyRules} className="gap-2" disabled={budget.rules.length === 0}>
            <RefreshCw className="h-4 w-4" /> Regeln jetzt anwenden
          </Button>
        </TabsContent>
      </Tabs>

      {/* ── Dialoge ── */}
      <CopyYearDialog
        open={copyDialog} onClose={() => setCopyDialog(false)}
        currentYear={selectedYear} savedYears={savedYears}
        onCopy={(from, to, ar) => {
          copyBudgetYear(from, to, ar);
          setSavedYears(availableBudgetYears());
          setSelectedYear(to); reload(to);
          setCopyDialog(false);
          toast.success(`Budget ${from} → ${to} kopiert`);
        }}
      />

      <AddRuleDialog
        open={ruleDialog} onClose={() => setRuleDialog(false)}
        positions={budget.positions}
        onAdd={rule => { setBudget(addBudgetRule(selectedYear, rule)); setRuleDialog(false); toast.success('Regel hinzugefügt'); }}
      />

      {addItemDialog && (
        <AddLineItemDialog
          open categoryId={addItemDialog.categoryId}
          categories={categories}
          onClose={() => setAddItemDialog(null)}
          onAdd={item => {
            setBudget(addCustomPLLineItem(selectedYear, item));
            setAddItemDialog(null);
            toast.success('Unterkonto hinzugefügt');
          }}
        />
      )}

      <Dialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Budget {selectedYear} löschen?</DialogTitle></DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Das Budget {selectedYear} wird vollständig gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(false)}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => {
              deleteBudgetYear(selectedYear);
              setSavedYears(availableBudgetYears());
              reload(selectedYear);
              setDeleteDialog(false);
              toast.success(`Budget ${selectedYear} gelöscht`);
            }}>Löschen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color = 'default' }: {
  label: string; value: string; sub?: string;
  color?: 'green' | 'blue' | 'red' | 'default';
}) {
  const bg = color === 'green' ? 'bg-green-50 dark:bg-green-950/20'
           : color === 'blue'  ? 'bg-blue-50  dark:bg-blue-950/20'
           : color === 'red'   ? 'bg-red-50   dark:bg-red-950/20'
           : 'bg-muted/30';
  const tc = color === 'green' ? 'text-green-700 dark:text-green-300'
           : color === 'blue'  ? 'text-blue-700  dark:text-blue-300'
           : color === 'red'   ? 'text-red-700   dark:text-red-300'
           : '';
  return (
    <div className={cn('rounded-lg border p-3', bg)}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-lg font-bold', tc)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Dialog: Unterkonto hinzufügen ────────────────────────────────────────────

function AddLineItemDialog({ open, categoryId, categories, onClose, onAdd }: {
  open: boolean; categoryId: string; categories: BudgetPLCategory[];
  onClose: () => void;
  onAdd: (item: Omit<BudgetPLLineItem, 'id' | 'isDefault'>) => void;
}) {
  const [label, setLabel] = useState('');
  const [accNr, setAccNr] = useState('');
  const [vType, setVType] = useState<'chf' | 'percent'>('chf');
  const [dept,  setDept]  = useState<'küche' | 'service' | 'allgemein' | ''>('');
  const [catId, setCatId] = useState(categoryId);

  const itemCats = categories.filter(c => c.type === 'items');

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" /> Unterkonto hinzufügen
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Kontonummer (4-stellig) *</Label>
              <Input
                placeholder="z.B. 3500"
                value={accNr} maxLength={4}
                onChange={e => setAccNr(e.target.value.replace(/\D/g, ''))}
              />
              <p className="text-xs text-muted-foreground">3xxx = Ertrag · 4xxx = Waren · 5xxx = Personal · 6xxx = Aufwand</p>
            </div>
            <div className="space-y-1.5">
              <Label>Bezeichnung *</Label>
              <Input placeholder="z.B. Softdrinks" value={label} onChange={e => setLabel(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Übergeordnete Kategorie</Label>
            <Select value={catId} onValueChange={setCatId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {itemCats.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Typ</Label>
              <Select value={vType} onValueChange={v => setVType(v as 'chf' | 'percent')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="chf">CHF – fixer Betrag</SelectItem>
                  <SelectItem value="percent">% – Anteil am Umsatz</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Abteilung (optional)</Label>
              <Select value={dept || 'none'} onValueChange={v => setDept(v === 'none' ? '' : v as 'küche' | 'service' | 'allgemein')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">– Keine –</SelectItem>
                  <SelectItem value="küche">Küche</SelectItem>
                  <SelectItem value="service">Service</SelectItem>
                  <SelectItem value="allgemein">Allgemein</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Alert>
            <AlertDescription className="text-sm">
              Das neue Unterkonto erscheint sofort in der P&L-Tabelle.
              CHF-Positionen können per Kumuliert-Spalte auf Monate verteilt werden.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={() => {
            if (!label.trim()) { toast.error('Name darf nicht leer sein'); return; }
            if (!accNr.match(/^\d{4}$/)) { toast.error('Kontonummer muss 4-stellig sein'); return; }
            onAdd({
              categoryId: catId, accountNumber: accNr, label: label.trim(),
              valueType: vType, department: dept || undefined,
              monthlyValues: [0,0,0,0,0,0,0,0,0,0,0,0], sortOrder: 999,
            });
          }} className="gap-1.5">
            <Plus className="h-4 w-4" /> Hinzufügen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dialog: Jahr kopieren ────────────────────────────────────────────────────

function CopyYearDialog({ open, onClose, currentYear, savedYears, onCopy }: {
  open: boolean; onClose: () => void; currentYear: number; savedYears: number[];
  onCopy: (from: number, to: number, applyRules: boolean) => void;
}) {
  const [fromYear,   setFromYear]   = useState(currentYear);
  const [toYear,     setToYear]     = useState(currentYear + 1);
  const [applyRules, setApplyRules] = useState(true);
  const sourceYears = savedYears.length > 0 ? savedYears : [currentYear];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Copy className="h-5 w-5" /> Budget-Jahr kopieren</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Von Jahr (Quelle)</Label>
              <Select value={String(fromYear)} onValueChange={v => setFromYear(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{sourceYears.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>In Jahr (Ziel)</Label>
              <Input type="number" value={toYear} onChange={e => setToYear(Number(e.target.value))} />
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
            <input type="checkbox" id="ar" checked={applyRules} onChange={e => setApplyRules(e.target.checked)} className="mt-0.5" />
            <label htmlFor="ar" className="text-sm cursor-pointer">
              <span className="font-medium">Regeln automatisch anwenden</span>
              <br />
              <span className="text-xs text-muted-foreground">Anpassungsregeln des Quell-Jahres werden auf das neue Budget angewendet.</span>
            </label>
          </div>
          <Alert>
            <AlertDescription className="text-sm">
              Budget <strong>{fromYear}</strong> → <strong>{toYear}</strong> kopieren. Das Quell-Budget bleibt unverändert.
            </AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={() => onCopy(fromYear, toYear, applyRules)} className="gap-1.5">
            <Copy className="h-4 w-4" /> Kopieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dialog: Anpassungsregel ──────────────────────────────────────────────────

const RULE_LABELS: Record<BudgetRuleType, string> = {
  increase_revenue_by_pct: 'Umsatz erhöhen um %',
  set_cost_ratio:          'Kosten-Quote setzen (%)',
  reduce_cost_by_pct:      'Kosten reduzieren um %',
  monthly_factor:          'Monat-Faktor',
  monthly_fixed_override:  'Monat-CHF-Override',
};

function AddRuleDialog({ open, onClose, positions, onAdd }: {
  open: boolean; onClose: () => void; positions: BudgetPosition[];
  onAdd: (rule: Omit<BudgetRule, 'id' | 'createdAt'>) => void;
}) {
  const [ruleType,   setRuleType]   = useState<BudgetRuleType>('increase_revenue_by_pct');
  const [positionId, setPositionId] = useState(positions[0]?.id ?? '');
  const [value,      setValue]      = useState<number>(5);
  const [month,      setMonth]      = useState<number | undefined>(undefined);

  const buildDesc = (): string => {
    const pos  = positions.find(p => p.id === positionId)?.label ?? positionId;
    const mStr = month ? ` (${BUDGET_MONTH_NAMES_FULL[month - 1]})` : '';
    switch (ruleType) {
      case 'increase_revenue_by_pct': return `${pos} um ${value} % erhöhen${mStr}`;
      case 'set_cost_ratio':          return `${pos} auf ${value} % des Umsatzes setzen${mStr}`;
      case 'reduce_cost_by_pct':      return `${pos} um ${value} % reduzieren${mStr}`;
      case 'monthly_factor':          return `${pos}${mStr}: Faktor ${value}`;
      case 'monthly_fixed_override':  return `${pos}${mStr}: fix CHF ${value}`;
    }
  };

  const needsMonth = ruleType === 'monthly_factor' || ruleType === 'monthly_fixed_override';
  const isPercent  = ruleType !== 'monthly_fixed_override';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5" /> Neue Anpassungsregel</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Regeltyp</Label>
            <Select value={ruleType} onValueChange={v => setRuleType(v as BudgetRuleType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(RULE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Betrifft Position (Hauptkategorie)</Label>
            <Select value={positionId} onValueChange={setPositionId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{positions.map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{isPercent ? 'Prozentwert' : 'CHF-Betrag'}</Label>
              <Input type="number" step="0.5" value={value} onChange={e => setValue(parseFloat(e.target.value) || 0)} />
              <p className="text-xs text-muted-foreground">{isPercent ? 'z.B. 5 für +5 %' : 'CHF-Betrag'}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Monat (optional)</Label>
              <Select value={month ? String(month) : 'all'} onValueChange={v => setMonth(v === 'all' ? undefined : Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Monate</SelectItem>
                  {BUDGET_MONTH_NAMES_FULL.map((name, i) => <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {needsMonth && month === undefined && (
            <Alert><AlertDescription className="text-sm">Dieser Regeltyp benötigt einen spezifischen Monat.</AlertDescription></Alert>
          )}
          <div className="rounded-lg border p-3 bg-muted/30">
            <p className="text-xs text-muted-foreground mb-0.5">Vorschau:</p>
            <p className="text-sm font-medium">{buildDesc()}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button
            onClick={() => onAdd({ type: ruleType, positionId, value, month: needsMonth ? month : (month ?? undefined), description: buildDesc() })}
            disabled={needsMonth && month === undefined}
          >
            Regel hinzufügen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
