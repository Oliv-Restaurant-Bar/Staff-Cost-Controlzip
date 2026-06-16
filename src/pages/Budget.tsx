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

import { useTenant } from '@/contexts/TenantContext';
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
  restoreMissingDefaultPLItems, resetPLToDefaults,
  syncBudgetFromSupabase,
  STORAGE_KEY as BUDGET_STORAGE_KEY,
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
  Pencil, ArrowRight, TrendingUp,
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
  const { isAdmin } = usePermissions();
  const { tenantId, tenantKey } = useTenant();
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [budget, setBudget]             = useState<BudgetYear>(() => loadBudgetWithPL(currentYear, tenantKey(BUDGET_STORAGE_KEY)));
  const [savedYears, setSavedYears]     = useState<number[]>(() => availableBudgetYears(tenantKey(BUDGET_STORAGE_KEY)));
  const [activeTab, setActiveTab]       = useState<'pl' | 'rules'>('pl');

  // Ausgeklappte / eingeklappte Kategorien (default: alles ausgeklappt)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string) =>
    setCollapsed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // Zellen-Bearbeitungsstatus
  const [editCell, setEditCell]           = useState<{ itemId: string; month: number } | null>(null);
  const [editKumuliert, setEditKumuliert] = useState<string | null>(null); // itemId

  // Dialoge
  const [copyDialog,     setCopyDialog]    = useState(false);
  const [ruleDialog,     setRuleDialog]    = useState(false);
  const [addItemDialog,  setAddItemDialog] = useState<{ categoryId: string } | null>(null);
  const [deleteDialog,   setDeleteDialog]  = useState(false);
  const [resetPLDialog,  setResetPLDialog] = useState(false);

  // Top-Down Budget-Eingabe (Zwischentotal → proportionale Verteilung)
  const [topDownDialog,  setTopDownDialog] = useState<{ cat: BudgetPLCategory; yearTotal: number } | null>(null);
  const [topDownMode,    setTopDownMode]   = useState<'chf' | 'pct'>('chf');
  const [topDownInput,   setTopDownInput]  = useState('');

  const [budgetHochInputs,     setBudgetHochInputs]     = useState<string[]>(() => Array(12).fill(''));
  const [budgetAnnualDistrib,  setBudgetAnnualDistrib]  = useState('');

  const reload = useCallback((year: number) => {
    setBudget(loadBudgetWithPL(year, tenantKey(BUDGET_STORAGE_KEY)));
    setSavedYears(availableBudgetYears(tenantKey(BUDGET_STORAGE_KEY)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => { reload(selectedYear); }, [selectedYear, reload]);

  // Mandantenwechsel: Daten neu laden + Check-Logs
  useEffect(() => {
    reload(selectedYear);
    if (tenantId === 'beaulieu') {
      const bud = loadBudgetWithPL(selectedYear, tenantKey(BUDGET_STORAGE_KEY));
      const rows = (bud.plLineItems ?? []).length;
      const hasErtragsKonto = (bud.plLineItems ?? []).some(i => i.id === 'pli_ertrag_a');
      console.log(`[BUDGET-CHECK] tenant: ${tenantId}`);
      console.log(`[BUDGET-CHECK] rows loaded: ${rows}`);
      console.log(`[BUDGET-CHECK] visible in budget module: ${rows > 0 ? 'yes' : 'no'}`);
      console.log(`[BUDGET-CHECK] Ertragskonto (pli_ertrag_a) present: ${hasErtragsKonto ? 'yes' : 'no'}`);
    }
    console.log(`[TENANT] Budget: Mandant "${tenantId}" – Budget neu geladen`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Supabase→localStorage Sync: Budget laden wenn localStorage leer ist.
  // Tritt auf wenn: neuer Browser, Cache geleert, oder seedBeaulieuBudget2026
  // in einem anderen Tab ausgeführt wurde.
  useEffect(() => {
    const storeKey = tenantKey(BUDGET_STORAGE_KEY);
    const hasData = budget.plLineItems?.some(i => i.monthlyValues.some(v => v !== 0));
    if (hasData) return;
    console.log(`[BUDGET-SYNC] localStorage leer für storeKey="${storeKey}" – versuche Supabase-Sync`);
    syncBudgetFromSupabase(selectedYear, storeKey).then(remoteBudget => {
      if (remoteBudget) {
        console.log(`[BUDGET-SYNC] Supabase-Daten geladen – Budget wird neu gerendert`);
        reload(selectedYear);
      } else {
        console.log(`[BUDGET-SYNC] Keine Daten in Supabase – Budget bleibt leer (seedBeaulieuBudget2026 ausführen)`);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, selectedYear]);

  // Nach Supabase-Sync Budget neu laden (beide Event-Namen abdecken)
  useEffect(() => {
    const handler = () => reload(selectedYear);
    window.addEventListener('store-synced', handler);
    window.addEventListener('supabase-kv-synced', handler);
    return () => {
      window.removeEventListener('store-synced', handler);
      window.removeEventListener('supabase-kv-synced', handler);
    };
  }, [selectedYear, reload]);

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
    setBudget(savePLLineItem(selectedYear, { ...item, monthlyValues: vals }, tenantKey(BUDGET_STORAGE_KEY)));
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
          setBudget(savePLLineItem(selectedYear, { ...item, monthlyValues: distributed }, tenantKey(BUDGET_STORAGE_KEY)));
          toast.success(`CHF ${CHF(yearly)} auf alle Monate verteilt`);
        },
      },
      cancel: { label: 'Abbrechen', onClick: () => {} },
      duration: 8000,
    });
  };

  // ── Top-Down: Zwischentotal → proportionale Verteilung ──────────────────────

  const openTopDown = (cat: BudgetPLCategory, yearTotal: number) => {
    setTopDownMode('chf');
    setTopDownInput(String(Math.round(yearTotal)));
    setTopDownDialog({ cat, yearTotal });
  };

  const parseTopDownInput = () =>
    parseFloat(topDownInput.replace(/['\u2019\s]/g, '').replace(',', '.')) || 0;

  const calcTopDownTargetCHF = () => {
    const val = parseTopDownInput();
    return topDownMode === 'pct' ? val / 100 * totalRevenue : val;
  };

  const applyTopDown = () => {
    if (!topDownDialog) return;
    const { cat } = topDownDialog;
    const targetCHF = calcTopDownTargetCHF();
    if (targetCHF <= 0) { toast.error('Bitte einen gültigen Wert (> 0) eingeben.'); return; }

    // Nur item-Kategorien (keine result-Kategorien) sind skalierbar
    const contribCatIds = (cat.resultFormula ?? [])
      .map(f => f.categoryId)
      .filter(catId => categories.find(c => c.id === catId)?.type === 'items');

    const affectedItems = lineItems.filter(
      i => contribCatIds.includes(i.categoryId) && !i.isHidden && !i.isInternal
    );

    if (affectedItems.length === 0) {
      toast.error('Keine anpassbaren Konten gefunden.');
      return;
    }

    const currentTotal = affectedItems.reduce((s, item) => s + itemYearly(item), 0);
    if (currentTotal === 0) {
      toast.error('Aktuelles Total ist 0 – bitte Konten zuerst manuell befüllen.');
      return;
    }

    const factor = targetCHF / currentTotal;

    // Jedes betroffene Konto skalieren (chained savePLLineItem – liest jedes Mal aus localStorage)
    let upd: BudgetYear = budget;
    for (const item of affectedItems) {
      const newVals = item.monthlyValues.map(v =>
        Math.round(v * factor)
      ) as BudgetPLLineItem['monthlyValues'];
      upd = savePLLineItem(selectedYear, { ...item, monthlyValues: newVals }, tenantKey(BUDGET_STORAGE_KEY));
    }
    setBudget(upd);
    setTopDownDialog(null);

    const pct = totalRevenue > 0 ? (targetCHF / totalRevenue * 100).toFixed(1) : null;
    toast.success(
      `${cat.label} auf CHF ${CHF(Math.round(targetCHF))}${pct ? ` (${pct}% des Umsatzes)` : ''} angepasst – ${affectedItems.length} Konten skaliert`
    );
  };

  const handleApplyRules = () => {
    if (budget.rules.length === 0) { toast.info('Keine Regeln definiert.'); return; }
    const upd = applyRulesToBudget(budget);
    saveBudgetYear(upd, tenantKey(BUDGET_STORAGE_KEY));
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

  const handleResetPL = () => {
    const upd = resetPLToDefaults(selectedYear);
    setBudget(upd);
    setResetPLDialog(false);
    toast.success('Konten wurden vollständig zurückgesetzt — Struktur entspricht jetzt 1:1 der Erfolgsrechnung.');
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
          <Button variant="outline" size="sm" onClick={() => setResetPLDialog(true)}
            className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
            title="Alle Konten löschen und 1:1 Struktur der Erfolgsrechnung wiederherstellen">
            <RefreshCw className="h-4 w-4" /> Konten zurücksetzen
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

      {/* ── Hochrechnung: Ziel-EBITDA → erforderlicher Nettoumsatz ─────────────── */}
      {(() => {
        const cogsMonths      = getMonthly('pl_goods_cost');
        const personnelMonths = getMonthly('pl_total_personnel');

        const handleDistribute = () => {
          const raw = budgetAnnualDistrib.trim().replace(/['''\s]/g, '').replace(',', '.');
          const annual = parseFloat(raw);
          if (isNaN(annual) || totalRevenue <= 0) return;
          const next = revenueByMonth.map(rev =>
            totalRevenue > 0 ? Math.round(annual * (rev / totalRevenue)) : Math.round(annual / 12)
          );
          setBudgetHochInputs(next.map(String));
        };

        type MonthCalc = {
          rev: number; ebitda: number; cogs: number; pers: number;
          targetEbitda: number | null; hasInput: boolean;
          cogsQuote: number | null; persQuote: number | null;
          canCompute: boolean; reqRev: number | null; factor: number | null;
          reqCogs: number | null; reqPers: number | null;
        };
        const months: MonthCalc[] = revenueByMonth.map((rev, i) => {
          const ebitda = ebitdaMonths[i] ?? 0;
          const cogs   = cogsMonths[i]  ?? 0;
          const pers   = personnelMonths[i] ?? 0;
          const cogsQuote = rev > 0 ? cogs / rev * 100 : null;
          const persQuote = rev > 0 ? pers / rev * 100 : null;
          const ebitPct = rev > 0 ? ebitda / rev : null;
          const raw = (budgetHochInputs[i] ?? '').trim().replace(/['''\s]/g, '').replace(',', '.');
          const targetEbitda = parseFloat(raw);
          const hasInput = raw !== '' && !isNaN(targetEbitda);
          const canCompute = hasInput && ebitPct !== null && Math.abs(ebitPct) > 0.0001 && rev > 0;
          const reqRev = canCompute ? targetEbitda / ebitPct! : null;
          const factor = (reqRev !== null && rev > 0) ? reqRev / rev : null;
          // Warenaufwand 1:1, Personalkosten 0.75× des Mehrumsatzes
          const reqCogs = factor !== null ? cogs * factor : null;
          const reqPers = factor !== null ? pers * (1 + 0.75 * (factor - 1)) : null;
          return { rev, ebitda, cogs, pers, cogsQuote, persQuote, targetEbitda: hasInput ? targetEbitda : null, hasInput, canCompute, reqRev, factor, reqCogs, reqPers };
        });

        const activeMonths = months.filter(m => m.canCompute);
        const totalTargetEbitda = months.filter(m => m.hasInput).reduce((s, m) => s + (m.targetEbitda ?? 0), 0);
        const totalReqRev       = activeMonths.reduce((s, m) => s + (m.reqRev ?? 0), 0);
        const totalReqCogs      = activeMonths.reduce((s, m) => s + (m.reqCogs ?? 0), 0);
        const totalReqPers      = activeMonths.reduce((s, m) => s + (m.reqPers ?? 0), 0);
        const totalPers         = activeMonths.reduce((s, m) => s + m.pers, 0);
        const hasAny            = months.some(m => m.hasInput);

        return (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/20 overflow-hidden shadow-sm">
            <div className="bg-indigo-700 text-white px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 shrink-0" />
                <div>
                  <h3 className="text-sm font-bold">Hochrechnung — Ziel-EBITDA auf Nettoumsatz</h3>
                  <p className="text-[11px] text-indigo-200">Ziel-EBITDA pro Monat eingeben → erforderlicher Umsatz bei gleicher Budgetstruktur</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-indigo-200 whitespace-nowrap">Jahreswert verteilen:</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="z.B. 300000"
                  value={budgetAnnualDistrib}
                  onChange={e => setBudgetAnnualDistrib(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleDistribute()}
                  className="h-7 w-32 border border-indigo-400 rounded px-2 text-xs text-right bg-white/10 text-white placeholder-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                />
                <button
                  onClick={handleDistribute}
                  className="h-7 px-2.5 rounded bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  Proportional verteilen
                </button>
                <button
                  disabled={!hasAny && budgetAnnualDistrib === ''}
                  onClick={() => { setBudgetHochInputs(Array(12).fill('')); setBudgetAnnualDistrib(''); }}
                  className="h-7 px-2 rounded border border-indigo-400 text-indigo-200 hover:text-white text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Zurücksetzen
                </button>
              </div>
            </div>

            {activeMonths.length > 0 && (
              <div className="bg-indigo-100 dark:bg-indigo-900/30 px-4 py-2 flex flex-wrap gap-x-6 gap-y-0.5 text-xs border-b border-indigo-200 dark:border-indigo-700">
                <span>
                  <span className="text-muted-foreground">Ziel-EBITDA ({activeMonths.length} Monate): </span>
                  <strong className="text-indigo-900 dark:text-indigo-200">CHF {Math.round(totalTargetEbitda).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">Ziel-Nettoumsatz: </span>
                  <strong className="text-indigo-900 dark:text-indigo-200">CHF {Math.round(totalReqRev).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">Ziel-Warenaufwand: </span>
                  <strong className="text-amber-800 dark:text-amber-300">CHF {Math.round(totalReqCogs).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">&Delta; Nettoumsatz: </span>
                  <strong className={totalReqRev >= totalRevenue ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>
                    {totalReqRev >= totalRevenue ? '+' : ''}{Math.round(totalReqRev - activeMonths.reduce((s, m) => s + m.rev, 0)).toLocaleString('de-CH')} CHF
                  </strong>
                </span>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="bg-indigo-100/80 dark:bg-indigo-900/20 border-b border-indigo-200 dark:border-indigo-700">
                    <td className="sticky left-0 bg-indigo-100/80 dark:bg-indigo-900/30 z-10 py-1.5 px-3 font-semibold text-indigo-800 dark:text-indigo-200 w-[160px] min-w-[160px] border-r border-indigo-200 dark:border-indigo-700"></td>
                    {BUDGET_MONTH_NAMES.map(m => (
                      <td key={m} className="py-1.5 px-2 text-center font-semibold text-indigo-800 dark:text-indigo-200 min-w-[72px]">{m}</td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-semibold text-indigo-800 dark:text-indigo-200 min-w-[80px]">Total</td>
                  </tr>
                </thead>
                <tbody>
                  {/* Zeile: Ziel EBITDA Eingabe */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800">
                    <td className="sticky left-0 bg-white dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-indigo-700 dark:text-indigo-300 font-medium border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">
                      Ziel EBITDA (CHF)
                    </td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1 px-1 text-center">
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder={m.rev > 0 ? String(Math.round(m.ebitda)) : ''}
                          value={budgetHochInputs[i] ?? ''}
                          onChange={e => { const next = [...budgetHochInputs]; next[i] = e.target.value; setBudgetHochInputs(next); }}
                          className="w-full h-6 border border-indigo-200 rounded px-1 text-right text-xs text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white dark:bg-indigo-950/30 dark:text-indigo-200"
                        />
                      </td>
                    ))}
                    <td className="py-1 px-2 text-center text-[11px] text-indigo-400">—</td>
                  </tr>
                  {/* Zeile: EBITDA Ist (Budget) */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/10">
                    <td className="sticky left-0 bg-indigo-50/80 dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-muted-foreground border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">EBITDA Budget</td>
                    {months.map((m, i) => (
                      <td key={i} className={cn('py-1.5 px-2 text-center', m.ebitda >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>
                        {m.rev > 0 ? Math.round(m.ebitda).toLocaleString('de-CH') : '—'}
                      </td>
                    ))}
                    <td className={cn('py-1.5 px-2 text-center font-semibold', ebitdaTotal >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>
                      {Math.round(ebitdaTotal).toLocaleString('de-CH')}
                    </td>
                  </tr>
                  {/* Zeile: Nettoumsatz Budget */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/10">
                    <td className="sticky left-0 bg-indigo-50/80 dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-muted-foreground border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">Nettoumsatz Budget</td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1.5 px-2 text-center text-gray-600 dark:text-gray-400">
                        {m.rev > 0 ? Math.round(m.rev).toLocaleString('de-CH') : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-semibold text-gray-700 dark:text-gray-300">
                      {Math.round(totalRevenue).toLocaleString('de-CH')}
                    </td>
                  </tr>
                  {/* Zeile: Erforderlicher Nettoumsatz */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800">
                    <td className="sticky left-0 bg-white dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-indigo-900 dark:text-indigo-100 font-bold border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">Nettoumsatz Ziel</td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1.5 px-2 text-center font-bold text-indigo-900 dark:text-indigo-100">
                        {m.canCompute && m.reqRev !== null ? Math.round(m.reqRev).toLocaleString('de-CH') : (m.hasInput && !m.canCompute ? <span className="text-amber-500 font-normal">n/a</span> : '—')}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-bold text-indigo-900 dark:text-indigo-100">
                      {activeMonths.length > 0 ? Math.round(totalReqRev).toLocaleString('de-CH') : '—'}
                    </td>
                  </tr>
                  {/* Zeile: Faktor */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/10">
                    <td className="sticky left-0 bg-indigo-50/80 dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-muted-foreground border-r border-indigo-100 dark:border-indigo-800">Faktor</td>
                    {months.map((m, i) => (
                      <td key={i} className={cn('py-1.5 px-2 text-center font-semibold', !m.canCompute ? 'text-muted-foreground' : m.factor! >= 1 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
                        {m.canCompute && m.factor !== null ? `${m.factor.toFixed(2)}×` : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center text-muted-foreground">—</td>
                  </tr>
                  {/* Zeile: Warenquote % */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-amber-50/40 dark:bg-amber-950/10">
                    <td className="sticky left-0 bg-amber-50/60 dark:bg-amber-950/20 z-10 py-1 px-3 text-amber-600 dark:text-amber-400 text-[11px] border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">
                      Warenquote <span className="text-muted-foreground">(1:1)</span>
                    </td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1 px-2 text-center text-[11px] text-amber-600 dark:text-amber-400">
                        {m.cogsQuote !== null ? `${m.cogsQuote.toFixed(1)} %` : '—'}
                      </td>
                    ))}
                    <td className="py-1 px-2 text-center text-[11px] text-amber-600 dark:text-amber-400">
                      {totalRevenue > 0 ? `${(months.reduce((s, m) => s + m.cogs, 0) / totalRevenue * 100).toFixed(1)} %` : '—'}
                    </td>
                  </tr>
                  {/* Zeile: Warenaufwand Ziel */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800">
                    <td className="sticky left-0 bg-white dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-amber-800 dark:text-amber-300 font-semibold border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">Warenaufwand Ziel</td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1.5 px-2 text-center text-amber-700 dark:text-amber-400 font-semibold">
                        {m.canCompute && m.reqCogs !== null ? Math.round(m.reqCogs).toLocaleString('de-CH') : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-bold text-amber-800 dark:text-amber-300">
                      {activeMonths.length > 0 ? Math.round(totalReqCogs).toLocaleString('de-CH') : '—'}
                    </td>
                  </tr>
                  {/* Zeile: Personalkosten Budget */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/10">
                    <td className="sticky left-0 bg-indigo-50/80 dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-muted-foreground border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">Personalkosten Budget</td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1.5 px-2 text-center text-gray-600 dark:text-gray-400">
                        {m.rev > 0 ? Math.round(m.pers).toLocaleString('de-CH') : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-semibold text-gray-700 dark:text-gray-300">
                      {Math.round(months.reduce((s, m) => s + m.pers, 0)).toLocaleString('de-CH')}
                    </td>
                  </tr>
                  {/* Zeile: Personalkostenquote % */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800 bg-blue-50/40 dark:bg-blue-950/10">
                    <td className="sticky left-0 bg-blue-50/60 dark:bg-blue-950/20 z-10 py-1 px-3 text-blue-600 dark:text-blue-400 text-[11px] border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">
                      Personalkostenquote <span className="text-muted-foreground">(0.75×)</span>
                    </td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1 px-2 text-center text-[11px] text-blue-600 dark:text-blue-400">
                        {m.persQuote !== null ? `${m.persQuote.toFixed(1)} %` : '—'}
                      </td>
                    ))}
                    <td className="py-1 px-2 text-center text-[11px] text-blue-600 dark:text-blue-400">
                      {totalRevenue > 0 ? `${(months.reduce((s, m) => s + m.pers, 0) / totalRevenue * 100).toFixed(1)} %` : '—'}
                    </td>
                  </tr>
                  {/* Zeile: Personalkosten Ziel */}
                  <tr className="border-b border-indigo-100 dark:border-indigo-800">
                    <td className="sticky left-0 bg-white dark:bg-indigo-950/30 z-10 py-1.5 px-3 text-blue-800 dark:text-blue-300 font-semibold border-r border-indigo-100 dark:border-indigo-800 whitespace-nowrap">Personalkosten Ziel <span className="font-normal text-[10px]">(0.75×)</span></td>
                    {months.map((m, i) => (
                      <td key={i} className="py-1.5 px-2 text-center text-blue-700 dark:text-blue-400 font-semibold">
                        {m.canCompute && m.reqPers !== null ? Math.round(m.reqPers).toLocaleString('de-CH') : '—'}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center font-bold text-blue-800 dark:text-blue-300">
                      {activeMonths.length > 0 ? Math.round(totalReqPers).toLocaleString('de-CH') : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="px-4 py-2 border-t border-indigo-100 dark:border-indigo-800">
              <p className="text-[11px] text-muted-foreground">
                Monate ohne Budget-Umsatz werden übersprungen. «n/a» = EBITDA-Quote nahe 0, Hochrechnung nicht sinnvoll.
                Placeholder-Werte (grau) = aktueller Budget-EBITDA des Monats.
              </p>
            </div>
          </div>
        );
      })()}

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
                  <th className="text-right py-2.5 px-2 font-bold text-xs bg-amber-50/80 dark:bg-amber-950/20 border-amber-300 min-w-[90px]">
                    Kumuliert
                  </th>
                  {/* % Anteil Umsatz */}
                  <th className="text-right py-2.5 px-2 font-bold text-xs bg-amber-50/80 dark:bg-amber-950/20 border-r-2 border-amber-300 min-w-[52px] text-amber-700">
                    %
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
                    const items     = lineItems.filter(i => i.categoryId === cat.id && !i.isHidden).sort((a, b) => a.sortOrder - b.sortOrder);
                    const monthly   = getMonthly(cat.id);
                    const yearTotal = monthly.reduce((s, v) => s + v, 0);
                    const isColl    = collapsed.has(cat.id);

                    // ── Zwischenergebnis-Zeile (type='result') ────────────────
                    if (cat.type === 'result') {
                      const catPct = totalRevenue > 0 ? yearTotal / totalRevenue * 100 : null;
                      // Top-Down editierbar wenn mind. eine beitragende Kategorie type='items' hat
                      const isTopDownable = isAdmin && (cat.resultFormula ?? []).some(
                        f => categories.find(c => c.id === f.categoryId)?.type === 'items'
                      );
                      return (
                        <tr key={cat.id} className={cn('border-t-2 border-b border-border', style.result)}>
                          <td className={cn('sticky left-0 z-10 py-2.5 px-4 font-bold text-sm border-r border-border', style.result)}>
                            <div className="flex items-center gap-2">
                              <span>{cat.label}</span>
                              {isTopDownable && (
                                <button
                                  title="Top-Down: Gesamtwert eingeben und proportional verteilen"
                                  className="opacity-0 group-hover:opacity-100 hover:opacity-100 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-opacity"
                                  onClick={() => openTopDown(cat, yearTotal)}
                                >
                                  <Pencil className="h-3 w-3 opacity-60" />
                                </button>
                              )}
                            </div>
                          </td>
                          {/* Kumuliert CHF – klickbar für Top-Down */}
                          <td
                            className={cn(
                              'text-right py-2.5 px-3 font-mono font-bold text-sm', style.kum,
                              yearTotal < 0 ? 'text-red-700 dark:text-red-400' : '',
                              isTopDownable ? 'cursor-pointer hover:ring-2 hover:ring-primary/40 hover:ring-inset rounded transition-all' : '',
                            )}
                            onClick={isTopDownable ? () => openTopDown(cat, yearTotal) : undefined}
                            title={isTopDownable ? 'Klicken: Gesamtwert eingeben und proportional auf alle Konten verteilen' : undefined}
                          >
                            <div className="flex items-center justify-end gap-1">
                              {CHF(yearTotal)}
                              {isTopDownable && <Pencil className="h-3 w-3 opacity-30 hover:opacity-70 flex-shrink-0" />}
                            </div>
                          </td>
                          {/* Kumuliert % – klickbar für Top-Down */}
                          <td
                            className={cn(
                              'text-right py-2.5 px-2 font-mono font-bold text-xs border-r-2 border-amber-300', style.kum,
                              catPct !== null && catPct < 0 ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400',
                              isTopDownable ? 'cursor-pointer hover:ring-2 hover:ring-amber-400/40 hover:ring-inset rounded transition-all' : '',
                            )}
                            onClick={isTopDownable ? () => { openTopDown(cat, yearTotal); setTopDownMode('pct'); setTopDownInput(catPct !== null ? catPct.toFixed(1) : '0'); } : undefined}
                            title={isTopDownable ? 'Klicken: %-Ziel eingeben und proportional auf alle Konten verteilen' : undefined}
                          >
                            {catPct !== null ? `${catPct.toFixed(1)}%` : '–'}
                          </td>
                          {monthly.map((v, m) => (
                            <td key={m} className={cn('text-right py-2.5 px-2 font-mono font-bold text-xs', style.result,
                              v < 0 ? 'text-red-700 dark:text-red-400' : '')}>
                              <div className="flex flex-col items-end leading-tight gap-px">
                                <span>{v !== 0 ? CHF(v) : '–'}</span>
                                {v !== 0 && revenueByMonth[m] > 0 && (
                                  <span className="text-[9px] font-normal opacity-55">{(v / revenueByMonth[m] * 100).toFixed(1)}%</span>
                                )}
                              </div>
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
                        {/* Kumuliert CHF: Kategoriesumme */}
                        <td className={cn('text-right py-2.5 px-3 font-mono font-bold text-xs', style.kum)}>
                          {yearTotal !== 0 ? CHF(yearTotal) : '–'}
                        </td>
                        {/* Kumuliert %: Anteil am Umsatz */}
                        <td className={cn('text-right py-2.5 px-2 font-mono font-bold text-xs border-r-2 border-amber-300 text-amber-700 dark:text-amber-400', style.kum)}>
                          {totalRevenue > 0 ? `${(yearTotal / totalRevenue * 100).toFixed(1)}%` : '–'}
                        </td>
                        {monthly.map((v, m) => (
                          <td key={m} className={cn('text-right py-2.5 px-2 font-mono font-semibold text-xs', style.header)}>
                            <div className="flex flex-col items-end leading-tight gap-px">
                              <span>{v !== 0 ? CHF(v) : '–'}</span>
                              {v !== 0 && revenueByMonth[m] > 0 && (
                                <span className="text-[9px] font-normal opacity-55">{(v / revenueByMonth[m] * 100).toFixed(1)}%</span>
                              )}
                            </div>
                          </td>
                        ))}
                        <td />
                      </tr>,

                      // ── Einzelpositionen (Unterkonten) ─────────────────────
                      ...(!isColl ? items.flatMap(item => {
                        const iyearly   = itemYearly(item);
                        const isEditKum = editKumuliert === item.id;

                        const itemRow = (
                          <tr key={item.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors group">
                            {/* Sticky linke Zelle */}
                            <td className="sticky left-0 bg-background z-10 py-1.5 pl-8 pr-2 border-r border-border">
                              <div className="flex items-center gap-1.5">
                                {/* %-Badge LINKS */}
                                <span className={cn('text-[9px] px-1 py-0 rounded border flex-shrink-0',
                                  item.valueType === 'percent'
                                    ? 'bg-blue-50 border-blue-200 text-blue-700'
                                    : 'bg-gray-50 border-gray-200 text-gray-600')}>
                                  {item.valueType === 'percent' ? '%' : 'CHF'}
                                </span>
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
                              </div>
                            </td>

                            {/* Kumuliert CHF (editierbar) */}
                            <td
                              className="text-right py-1.5 px-2 font-mono text-xs font-semibold bg-amber-50/40 dark:bg-amber-950/10 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition-colors"
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
                                item.valueType === 'percent'
                                  ? <span className="text-blue-700 dark:text-blue-300">{CHF(iyearly)}</span>
                                  : <span>{iyearly !== 0 ? CHF(iyearly) : <span className="text-muted-foreground/30">–</span>}</span>
                              )}
                            </td>
                            {/* Kumuliert % (Anteil am Jahresumsatz) */}
                            <td className="text-right py-1.5 px-2 font-mono text-xs border-r-2 border-amber-300 bg-amber-50/40 dark:bg-amber-950/10 text-amber-700 dark:text-amber-400">
                              {totalRevenue > 0 && iyearly !== 0
                                ? `${(iyearly / totalRevenue * 100).toFixed(1)}%`
                                : <span className="text-muted-foreground/30">–</span>}
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
                                    <div className="flex flex-col items-end leading-tight gap-px">
                                      {item.valueType === 'percent'
                                        ? <span className="text-blue-700 dark:text-blue-300">{PCT(val)}</span>
                                        : <span>{val !== 0 ? CHF(val) : <span className="text-muted-foreground/25">–</span>}</span>
                                      }
                                      {item.valueType === 'percent' && chfVal > 0 && (
                                        <span className="text-[9px] text-muted-foreground">{CHF(chfVal)}</span>
                                      )}
                                      {item.valueType !== 'percent' && val !== 0 && revenueByMonth[m] > 0 && (
                                        <span className="text-[9px] text-muted-foreground/60">{(val / revenueByMonth[m] * 100).toFixed(1)}%</span>
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

                        // ── Subtotal «Direkter Warenaufwand» nach Konto 4070 ──
                        if (cat.id === 'pl_goods_cost' && item.accountNumber === '4070') {
                          const direktAccounts = ['4020','4030','4040','4050','4060','4070'];
                          const direktItems = items.filter(i => direktAccounts.includes(i.accountNumber ?? ''));
                          const direktMonthly = Array.from({ length: 12 }, (_, m) =>
                            direktItems.reduce((s, i) => s + (i.valueType === 'percent'
                              ? Math.round(i.monthlyValues[m] / 100 * revenueByMonth[m])
                              : i.monthlyValues[m]
                            ), 0)
                          );
                          const direktYearly = direktMonthly.reduce((s, v) => s + v, 0);
                          const direktPct = totalRevenue > 0 ? direktYearly / totalRevenue * 100 : null;
                          const subtotalRow = (
                            <tr key="subtotal-direkter-warenaufwand" className="border-t border-b-2 border-orange-200 bg-orange-50/60 dark:bg-orange-950/20">
                              <td className="sticky left-0 z-10 py-1.5 pl-8 pr-2 border-r border-border bg-orange-50/60 dark:bg-orange-950/20">
                                <span className="font-bold italic text-[11px] text-orange-800 dark:text-orange-200 uppercase tracking-wide">
                                  Direkter Warenaufwand
                                </span>
                              </td>
                              <td className="text-right py-1.5 px-3 font-mono font-bold text-xs bg-amber-50/40 dark:bg-amber-950/10 text-orange-800 dark:text-orange-200">
                                {direktYearly !== 0 ? CHF(direktYearly) : '–'}
                              </td>
                              <td className="text-right py-1.5 px-2 font-mono font-bold text-xs border-r-2 border-amber-300 bg-amber-50/40 dark:bg-amber-950/10 text-amber-700 dark:text-amber-400">
                                {direktPct !== null ? `${direktPct.toFixed(1)}%` : '–'}
                              </td>
                              {direktMonthly.map((v, m) => (
                                <td key={m} className="text-right py-1.5 px-2 font-mono text-xs font-semibold text-orange-800 dark:text-orange-200">
                                  <div className="flex flex-col items-end leading-tight gap-px">
                                    <span>{v !== 0 ? CHF(v) : '–'}</span>
                                    {v !== 0 && revenueByMonth[m] > 0 && (
                                      <span className="text-[9px] font-normal opacity-55">{(v / revenueByMonth[m] * 100).toFixed(1)}%</span>
                                    )}
                                  </div>
                                </td>
                              ))}
                              <td />
                            </tr>
                          );
                          return [itemRow, subtotalRow];
                        }

                        return [itemRow];
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
          setSavedYears(availableBudgetYears(tenantKey(BUDGET_STORAGE_KEY)));
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
            setBudget(addCustomPLLineItem(selectedYear, item, tenantKey(BUDGET_STORAGE_KEY)));
            setAddItemDialog(null);
            toast.success('Unterkonto hinzugefügt');
          }}
        />
      )}

      {/* ── Top-Down Dialog: Zwischentotal → proportionale Verteilung ── */}
      <Dialog open={!!topDownDialog} onOpenChange={open => !open && setTopDownDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calculator className="h-4 w-4" />
              Top-Down: {topDownDialog?.cat.label}
            </DialogTitle>
          </DialogHeader>
          {topDownDialog && (() => {
            const contribCatIds = (topDownDialog.cat.resultFormula ?? [])
              .map(f => f.categoryId)
              .filter(catId => categories.find(c => c.id === catId)?.type === 'items');
            const affectedCats  = categories.filter(c => contribCatIds.includes(c.id));
            const affectedItems = lineItems.filter(i => contribCatIds.includes(i.categoryId) && !i.isHidden && !i.isInternal);
            const currentTotal  = affectedItems.reduce((s, item) => s + itemYearly(item), 0);
            const targetCHF     = calcTopDownTargetCHF();
            const factor        = currentTotal > 0 && targetCHF > 0 ? targetCHF / currentTotal : null;
            const targetPct     = totalRevenue > 0 && targetCHF > 0 ? targetCHF / totalRevenue * 100 : null;
            const canApply      = targetCHF > 0 && currentTotal > 0 && affectedItems.length > 0;

            return (
              <div className="space-y-4">
                {/* Aktueller Wert */}
                <div className="rounded-md bg-muted/50 px-3 py-2.5 text-sm">
                  <div className="text-muted-foreground text-xs mb-1">Aktueller Jahreswert</div>
                  <div className="font-mono font-bold text-base flex items-center gap-2">
                    CHF {CHF(Math.round(topDownDialog.yearTotal))}
                    {totalRevenue > 0 && topDownDialog.yearTotal !== 0 && (
                      <span className="text-amber-600 text-xs font-normal">
                        = {(topDownDialog.yearTotal / totalRevenue * 100).toFixed(1)}% des Umsatzes
                      </span>
                    )}
                  </div>
                </div>

                {/* Modus + Eingabe */}
                <div className="space-y-2">
                  <Label>Neuer Zielwert</Label>
                  <div className="flex gap-2 items-center">
                    <div className="flex border rounded-md overflow-hidden text-sm font-semibold flex-shrink-0">
                      <button
                        className={cn('px-3 py-1.5 transition-colors', topDownMode === 'chf' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                        onClick={() => {
                          setTopDownMode('chf');
                          if (topDownMode === 'pct') {
                            const pctVal = parseTopDownInput();
                            setTopDownInput(totalRevenue > 0 ? String(Math.round(pctVal / 100 * totalRevenue)) : topDownInput);
                          }
                        }}
                      >CHF</button>
                      <button
                        className={cn('px-3 py-1.5 transition-colors', topDownMode === 'pct' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                        onClick={() => {
                          setTopDownMode('pct');
                          if (topDownMode === 'chf') {
                            const chfVal = parseTopDownInput();
                            setTopDownInput(totalRevenue > 0 ? (chfVal / totalRevenue * 100).toFixed(1) : topDownInput);
                          }
                        }}
                      >%</button>
                    </div>
                    <Input
                      autoFocus
                      value={topDownInput}
                      onChange={e => setTopDownInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && canApply && applyTopDown()}
                      placeholder={topDownMode === 'chf' ? "z.B. 120000" : "z.B. 32.5"}
                      className="font-mono flex-1"
                    />
                    {topDownMode === 'pct' && (
                      <span className="text-sm text-muted-foreground flex-shrink-0">% des Umsatzes</span>
                    )}
                  </div>
                </div>

                {/* Vorschau */}
                {factor !== null && (
                  <div className="rounded-md border px-3 py-2.5 space-y-1.5 text-sm">
                    <div className="font-semibold text-xs text-muted-foreground uppercase tracking-wide mb-1">Vorschau</div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Neues Total</span>
                      <span className="font-mono font-bold">
                        CHF {CHF(Math.round(targetCHF))}
                        {targetPct !== null && <span className="text-amber-600 ml-1.5 font-normal text-xs">({targetPct.toFixed(1)}%)</span>}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Skalierungsfaktor</span>
                      <span className={cn('font-mono text-xs', factor > 1 ? 'text-green-600' : 'text-orange-600')}>
                        × {factor.toFixed(4)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Betroffene Konten</span>
                      <span className="font-mono text-xs">{affectedItems.length} in {affectedCats.length} Gruppen</span>
                    </div>
                    <div className="text-xs text-muted-foreground pt-0.5 border-t">
                      {affectedCats.map(c => c.label).join(' · ')}
                    </div>
                  </div>
                )}

                {currentTotal === 0 && affectedItems.length > 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Aktuelles Total ist 0 – bitte Konten zuerst manuell befüllen, dann skalieren.
                    </AlertDescription>
                  </Alert>
                )}
                {affectedItems.length === 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>Keine anpassbaren Konten gefunden.</AlertDescription>
                  </Alert>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopDownDialog(null)}>Abbrechen</Button>
            <Button
              onClick={applyTopDown}
              disabled={calcTopDownTargetCHF() <= 0}
              className="gap-1.5"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Proportional verteilen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              setSavedYears(availableBudgetYears(tenantKey(BUDGET_STORAGE_KEY)));
              reload(selectedYear);
              setDeleteDialog(false);
              toast.success(`Budget ${selectedYear} gelöscht`);
            }}>Löschen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Konten zurücksetzen ── */}
      <Dialog open={resetPLDialog} onOpenChange={setResetPLDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Konten zurücksetzen?</DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Alle P&amp;L-Konten und Budgetwerte für <strong>{selectedYear}</strong> werden gelöscht und durch die Standardstruktur der Erfolgsrechnung ersetzt (Konten 3000, 4000–4060, 5000–5890, 6000–6900). Eingegebene Budgetwerte gehen verloren.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPLDialog(false)}>Abbrechen</Button>
            <Button variant="destructive" onClick={handleResetPL}>
              Zurücksetzen
            </Button>
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
