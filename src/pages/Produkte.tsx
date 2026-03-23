import { useState, useRef, useMemo, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import {
  Upload, Trash2, Package, TrendingUp, TrendingDown,
  Hash, RotateCcw, ChevronDown, X, Award, CalendarDays, LayoutGrid,
  AlertTriangle, CheckSquare, Utensils, Wine, Search, Settings2, Receipt, Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  parseProdukteExcel,
  loadProdukteData,
  saveProdukteData,
  loadIgnoredProducts,
  saveIgnoredProducts,
  mergeProdukteData,
  getTopProducts,
  getFlopProducts,
  getAvailableMonths,
  DEFAULT_IGNORE_TERMS,
  loadProductCosts,
  saveProductCosts,
  saveProductCostsToDB,
  loadProductCostsFromDB,
  saveProdukteDataToDB,
  loadProdukteDataFromDB,
  saveIgnoredProductsToDB,
  loadIgnoredProductsFromDB,
  mergeProductCosts,
  parseCostExcel,
  loadProductGroups,
  loadProductGroupsFromDB,
  type ProdukteData,
  type RankedProduct,
  type ProductCostEntry,
  type ProductGroup,
} from '@/lib/produkte-store';
import GruppenAnalyse from '@/components/produkte/GruppenAnalyse';
import { format, parse } from 'date-fns';
import { de } from 'date-fns/locale';

const formatCHF = (v: number) =>
  v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 2 });

const formatMonthLong = (ym: string) => {
  if (ym === 'alle') return 'Alle Monate';
  if (ym === 'gesamt') return 'Gesamtperiode';
  try { return format(parse(ym, 'yyyy-MM', new Date()), 'MMMM yyyy', { locale: de }); }
  catch { return ym; }
};

const formatMonthShort = (ym: string) => {
  if (ym === 'alle') return 'Alle';
  if (ym === 'gesamt') return 'Gesamt';
  try { return format(parse(ym, 'yyyy-MM', new Date()), 'MMM yy', { locale: de }); }
  catch { return ym; }
};

type ChartMode = 'top' | 'flop';
type ViewTab   = 'monat' | 'jahr' | 'gruppen';

const TOP_OPTIONS  = [10, 20, 50, 100, 9999];
const FLOP_OPTIONS = [10, 20, 50, 9999];
const ALL_SENTINEL = 9999;

// ── Kompakte Monatskarte ─────────────────────────────────────────────────────
function MonthCard({
  month, entries, ignoredByUser, sortBy, mode, n, category,
}: {
  month: string;
  entries: Parameters<typeof getTopProducts>[0];
  ignoredByUser: string[];
  sortBy: 'count' | 'revenue';
  mode: ChartMode;
  n: number;
  category: 'food' | 'beverage';
}) {
  const ranked = useMemo(
    () => mode === 'top'
      ? getTopProducts(entries, month, sortBy, n, ignoredByUser, category)
      : getFlopProducts(entries, month, sortBy, n, ignoredByUser, category),
    [entries, month, sortBy, mode, n, ignoredByUser, category],
  );
  const maxVal = ranked.length > 0
    ? Math.max(...ranked.map(r => sortBy === 'count' ? r.count : r.revenue)) : 1;
  const isFlop = mode === 'flop';

  return (
    <div className={cn(
      'rounded-xl border bg-card overflow-hidden',
      isFlop ? 'border-red-200 dark:border-red-900' : 'border-border',
    )}>
      <div className={cn(
        'px-3 py-2.5 border-b flex items-center justify-between',
        isFlop ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20' : 'border-border bg-muted/40',
      )}>
        <span className="text-sm font-bold">{formatMonthLong(month)}</span>
        <span className="text-[10px] text-muted-foreground">{isFlop ? 'Flop' : 'Top'} {Math.min(n, ranked.length)}</span>
      </div>
      {ranked.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">Keine Daten</div>
      ) : (
        <div className="divide-y divide-border/40">
          {ranked.map(r => {
            const val    = sortBy === 'count' ? r.count : r.revenue;
            const barPct = maxVal > 0 ? (val / maxVal) * 100 : 0;
            const barColor = isFlop ? 'bg-red-400 dark:bg-red-600'
              : sortBy === 'count' ? 'bg-blue-500' : 'bg-emerald-500';
            return (
              <div key={r.name} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground tabular-nums w-4 shrink-0 text-center">{r.rank}</span>
                  <span className="text-xs font-medium truncate flex-1 min-w-0">{r.name}</span>
                  <span className={cn('text-xs tabular-nums shrink-0',
                    isFlop ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                    {sortBy === 'count' ? `${r.count.toLocaleString('de-CH')}×` : formatCHF(r.revenue)}
                  </span>
                </div>
                <div className="mt-1 ml-6 h-1 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full', barColor)} style={{ width: `${barPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Haupt-Komponente ─────────────────────────────────────────────────────────
export default function ProdukteSeite() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/personal" replace />;

  const [data, setData]               = useState<ProdukteData | null>(() => loadProdukteData());
  const [ignoredByUser, setIgnored]   = useState<string[]>(() => loadIgnoredProducts());
  const [sortBy, setSortBy]           = useState<'count' | 'revenue'>('count');
  const [mode, setMode]               = useState<ChartMode>('top');
  const [view, setView]               = useState<ViewTab>('monat');
  const [topN, setTopN]               = useState(20);
  const [flopN, setFlopN]             = useState(10);
  const [selectedMonth, setMonth]     = useState<string>('');
  const [importing, setImporting]     = useState<'anzahl' | 'umsatz' | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [category, setCategory]       = useState<'food' | 'beverage'>('food');
  const [pendingImport, setPendingImport] = useState<{
    type: 'anzahl' | 'umsatz';
    category: 'food' | 'beverage';
    parsed: import('@/lib/produkte-store').ProductEntry[];
    overlappingMonths: string[];
    fileName: string;
  } | null>(null);

  const [costs,  setCosts]  = useState<ProductCostEntry[]>(() => loadProductCosts());
  const [groups, setGroups] = useState<ProductGroup[]>(() => loadProductGroups());
  const [importingCost, setImportingCost] = useState(false);

  // Beim Start: alle Daten aus Supabase laden (domain-unabhängig)
  useEffect(() => {
    loadProdukteDataFromDB().then(dbData => {
      if (dbData) {
        console.log('[Produkte] DB-Daten geladen:', dbData.entries?.length, 'Einträge');
        setData(dbData);
      } else {
        console.log('[Produkte] Keine DB-Daten, localStorage-Fallback aktiv');
      }
    });
    loadIgnoredProductsFromDB().then(dbIgnored => {
      if (dbIgnored.length > 0) setIgnored(dbIgnored);
    });
    loadProductCostsFromDB().then(dbCosts => {
      if (dbCosts.length > 0) setCosts(dbCosts);
    });
    loadProductGroupsFromDB().then(dbGroups => {
      if (dbGroups.length > 0) setGroups(dbGroups);
    });
  }, []);
  const [editingCost, setEditingCost] = useState<{
    name: string; field: 'brutto' | 'netto' | 'wes' | 'wesQ';
  } | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const anzahlRef = useRef<HTMLInputElement>(null);
  const umsatzRef = useRef<HTMLInputElement>(null);
  const costRef   = useRef<HTMLInputElement>(null);
  const costEditRef = useRef<HTMLInputElement>(null);

  // Schnelle Name→Kosten Lookup-Map (gefiltert nach aktiver Kategorie)
  const costMap = useMemo(() => {
    const m = new Map<string, ProductCostEntry>();
    for (const c of costs) {
      if (c.category === category) m.set(c.name.toLowerCase(), c);
    }
    return m;
  }, [costs, category]);

  // ── Inline-Bearbeitung WES-Zellen ─────────────────────────────────────────
  const startCostEdit = (
    name: string,
    field: 'brutto' | 'netto' | 'wes' | 'wesQ',
    currentVal: number,
  ) => {
    setEditingCost({ name, field });
    setEditingValue(currentVal > 0 ? String(currentVal) : '');
    setTimeout(() => costEditRef.current?.select(), 30);
  };

  const commitCostEdit = () => {
    if (!editingCost) return;
    const raw = editingValue.replace(/[^0-9.,]/g, '').replace(',', '.');
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) { setEditingCost(null); return; }

    const updated = costs.map(c => {
      if (c.name.toLowerCase() !== editingCost.name.toLowerCase() || c.category !== category) return c;
      const patch: Partial<ProductCostEntry> = {};
      if (editingCost.field === 'brutto') patch.bruttoPrice = val;
      if (editingCost.field === 'netto')  patch.nettoPrice  = val;
      if (editingCost.field === 'wes')    patch.wes         = val;
      if (editingCost.field === 'wesQ')   patch.wesQ        = val;
      return { ...c, ...patch };
    });

    // Wenn Produkt noch kein Cost-Entry hat → neu anlegen
    const exists = updated.some(
      c => c.name.toLowerCase() === editingCost.name.toLowerCase() && c.category === category,
    );
    if (!exists) {
      const newEntry: ProductCostEntry = {
        name: editingCost.name,
        category,
        bruttoPrice: editingCost.field === 'brutto' ? val : 0,
        nettoPrice:  editingCost.field === 'netto'  ? val : 0,
        wes:         editingCost.field === 'wes'    ? val : 0,
        wesQ:        editingCost.field === 'wesQ'   ? val : 0,
      };
      updated.push(newEntry);
    }

    saveProductCostsToDB(updated);
    setCosts(updated);
    setEditingCost(null);
  };

  // Varianten für Produktdatenbank-Dialog (arbeiten mit expliziter Kategorie)
  const startCostEditForCategory = (
    name: string,
    cat: 'food' | 'beverage',
    field: 'brutto' | 'netto' | 'wes' | 'wesQ',
    currentVal: number,
  ) => {
    setEditingCost({ name, field });
    setEditingValue(currentVal > 0 ? String(currentVal) : '');
    setTimeout(() => costEditRef.current?.select(), 30);
  };

  const commitCostEditForCategory = (name: string, cat: 'food' | 'beverage') => {
    if (!editingCost) return;
    const raw = editingValue.replace(/[^0-9.,]/g, '').replace(',', '.');
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) { setEditingCost(null); return; }

    const updated = costs.map(c => {
      if (c.name.toLowerCase() !== name.toLowerCase() || c.category !== cat) return c;
      const patch: Partial<ProductCostEntry> = {};
      if (editingCost.field === 'brutto') patch.bruttoPrice = val;
      if (editingCost.field === 'netto')  patch.nettoPrice  = val;
      if (editingCost.field === 'wes')    patch.wes         = val;
      if (editingCost.field === 'wesQ')   patch.wesQ        = val;
      return { ...c, ...patch };
    });

    const exists = updated.some(c => c.name.toLowerCase() === name.toLowerCase() && c.category === cat);
    if (!exists) {
      updated.push({
        name,
        category: cat,
        bruttoPrice: editingCost.field === 'brutto' ? val : 0,
        nettoPrice:  editingCost.field === 'netto'  ? val : 0,
        wes:         editingCost.field === 'wes'    ? val : 0,
        wesQ:        editingCost.field === 'wesQ'   ? val : 0,
      });
    }
    saveProductCostsToDB(updated);
    setCosts(updated);
    setEditingCost(null);
  };

  const monthsOnly = useMemo(() => getAvailableMonths(data?.entries ?? [], category), [data, category]);

  // Setze letzten Monat als Standard wenn noch keiner gewählt oder nicht in dieser Kategorie vorhanden
  const activeMonth = (monthsOnly.includes(selectedMonth) ? selectedMonth : '') || monthsOnly[monthsOnly.length - 1] || '';

  const isFlop   = mode === 'flop';
  const limit    = isFlop ? flopN : topN;
  const nOptions = isFlop ? FLOP_OPTIONS : TOP_OPTIONS;
  const currentN = limit;
  const setN     = isFlop ? setFlopN : setTopN;

  const ranked: RankedProduct[] = useMemo(() => {
    if (view !== 'monat' || !activeMonth) return [];
    const entries = data?.entries ?? [];
    return isFlop
      ? getFlopProducts(entries, activeMonth, sortBy, limit, ignoredByUser, category)
      : getTopProducts(entries, activeMonth, sortBy, limit, ignoredByUser, category);
  }, [data, activeMonth, sortBy, mode, limit, ignoredByUser, view, category]);

  const totalRanked: RankedProduct[] = useMemo(() => {
    if (view !== 'jahr') return [];
    const entries = data?.entries ?? [];
    return isFlop
      ? getFlopProducts(entries, 'alle', sortBy, limit, ignoredByUser, category)
      : getTopProducts(entries, 'alle', sortBy, limit, ignoredByUser, category);
  }, [data, sortBy, mode, limit, ignoredByUser, view, category]);

  const maxVal = ranked.length > 0
    ? Math.max(...ranked.map(r => sortBy === 'count' ? r.count : r.revenue)) : 1;

  // ── Import Handler ───────────────────────────────────────────────────────────
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>, type: 'anzahl' | 'umsatz') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(type);
    try {
      const parsed = await parseProdukteExcel(file, type, category);
      if (parsed.length === 0) {
        toast.error('Keine Produktdaten gefunden', {
          description: 'Bitte prüfe das Dateiformat (Gastronovi Rezept-Export)',
        });
        return;
      }

      // Prüfe ob Monate dieser Kategorie + dieses Typs bereits vorhanden sind
      // Anzahl und Umsatz sind SEPARATE Daten — jeder Typ hat eigene Duplikat-Prüfung
      const existingMonths = new Set(
        (data?.entries ?? [])
          .filter(e => {
            if ((e.category ?? 'food') !== category) return false;
            return type === 'anzahl' ? e.count > 0 : e.revenue > 0;
          })
          .map(e => e.month)
      );
      const newMonths = [...new Set(parsed.map(e => e.month))];
      const overlappingMonths = newMonths.filter(m => existingMonths.has(m));

      if (overlappingMonths.length > 0) {
        setPendingImport({ type, category, parsed, overlappingMonths, fileName: file.name });
        return;
      }

      applyImport(parsed, type, file.name);
    } catch (err) {
      toast.error('Import fehlgeschlagen', { description: String(err) });
    } finally {
      setImporting(null);
      e.target.value = '';
    }
  };

  const applyImport = (
    parsed: import('@/lib/produkte-store').ProductEntry[],
    type: 'anzahl' | 'umsatz',
    fileName: string,
  ) => {
    const merged = mergeProdukteData(data?.entries ?? [], parsed, type);
    const newData: ProdukteData = { entries: merged, importedAt: new Date().toISOString(), source: 'combined' };
    saveProdukteDataToDB(newData);
    setData(newData);
    toast.success(`${type === 'anzahl' ? 'Anzahl' : 'Umsatz'}-Daten importiert`, {
      description: `${parsed.length} Einträge aus ${fileName}`,
    });
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    applyImport(pendingImport.parsed, pendingImport.type, pendingImport.fileName);
    setPendingImport(null);
  };

  const cancelImport = () => {
    setPendingImport(null);
    toast.info('Import abgebrochen');
  };

  const handleCostImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingCost(true);
    try {
      const parsed = await parseCostExcel(file);
      if (parsed.length === 0) {
        toast.error('Keine WES-Daten gefunden', {
          description: 'Erwartet: Excel mit Sheet "Food"/"Beverage", Spalten A=Kategorie, B=Titel, C=Brutto, D=Netto, E=WES, F=WES-Q',
        });
        return;
      }
      const merged = mergeProductCosts(costs, parsed);
      saveProductCostsToDB(merged);
      setCosts(merged);
      const foodCount = parsed.filter(p => p.category === 'food').length;
      const bevCount  = parsed.filter(p => p.category === 'beverage').length;
      const parts = [];
      if (foodCount > 0) parts.push(`${foodCount} Food`);
      if (bevCount  > 0) parts.push(`${bevCount} Beverage`);
      toast.success(`WES-Daten importiert`, {
        description: `${parts.join(' · ')} aus ${file.name}`,
      });
    } catch (err) {
      toast.error('WES-Import fehlgeschlagen', { description: String(err) });
    } finally {
      setImportingCost(false);
      e.target.value = '';
    }
  };

  const ignoreProduct = (name: string) => {
    const updated = [...ignoredByUser, name];
    setIgnored(updated);
    saveIgnoredProductsToDB(updated);
    toast.info(`«${name}» aus Rangliste entfernt`);
  };

  const restoreProduct = (name: string) => {
    const updated = ignoredByUser.filter(n => n !== name);
    setIgnored(updated);
    saveIgnoredProductsToDB(updated);
    toast.success(`«${name}» wieder in Rangliste`);
  };

  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetCat, setResetCat] = useState<'food' | 'beverage' | 'all'>('all');
  const [resetMonth, setResetMonth] = useState<string>('all');
  const [showProductManager, setShowProductManager] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [productFilterCat, setProductFilterCat] = useState<'all' | 'food' | 'beverage'>('all');
  const [productFilterWes, setProductFilterWes] = useState<'all' | 'missing'>('all');

  // Alle vorhandenen Monate (beide Kategorien, für Reset-Dialog)
  const allMonthsForReset = useMemo(() => {
    const set = new Set((data?.entries ?? []).map(e => e.month).filter(m => m !== 'gesamt'));
    return Array.from(set).sort();
  }, [data]);

  // Alle eindeutigen Produktnamen aus importierten Daten (für Produkt-Manager)
  const allProductNames = useMemo(() => {
    const entries = data?.entries ?? [];
    const map = new Map<string, 'food' | 'beverage'>();
    for (const e of entries) {
      if (!map.has(e.name)) map.set(e.name, e.category ?? 'food');
    }
    return Array.from(map.entries())
      .map(([name, cat]) => ({ name, category: cat }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [data]);

  const doReset = () => {
    if (!data) return;
    let remaining = data.entries;

    if (resetCat !== 'all' && resetMonth !== 'all') {
      // Bestimmte Kategorie + bestimmter Monat
      remaining = remaining.filter(e =>
        !((e.category ?? 'food') === resetCat && e.month === resetMonth)
      );
    } else if (resetCat !== 'all') {
      // Bestimmte Kategorie, alle Monate
      remaining = remaining.filter(e => (e.category ?? 'food') !== resetCat);
    } else if (resetMonth !== 'all') {
      // Alle Kategorien, bestimmter Monat
      remaining = remaining.filter(e => e.month !== resetMonth);
    } else {
      // Alles löschen
      remaining = [];
    }

    if (remaining.length === 0) {
      localStorage.removeItem('produkte_data_v2');
      localStorage.removeItem('produkte_ignored_v1');
      // Auch aus Supabase löschen
      import('@/integrations/supabase/client').then(({ supabase }) => {
        supabase.from('app_kv_store').delete().in('key', ['produkte_data_v2', 'produkte_ignored_v1']).then(() => {});
      });
      setData(null);
      setIgnored([]);
    } else {
      const newData = { ...data, entries: remaining, importedAt: new Date().toISOString() };
      saveProdukteDataToDB(newData);
      setData(newData);
    }
    setShowResetDialog(false);
    toast.info('Daten gelöscht');
  };

  const clearAllData = () => {
    // kept for compatibility — now just opens the dialog
    setShowResetDialog(true);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 space-y-2">

          {/* Zeile 1: Titel + Kategorie + Import */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">Produkte</h1>
                <p className="text-xs text-muted-foreground">Ranglisten nach Anzahl & Umsatz</p>
              </div>
            </div>

            {/* Food / Beverage Toggle */}
            <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
              <button onClick={() => setCategory('food')}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                  category === 'food' ? 'bg-orange-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                <Utensils className="h-3 w-3" /> Food
              </button>
              <button onClick={() => setCategory('beverage')}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                  category === 'beverage' ? 'bg-blue-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                <Wine className="h-3 w-3" /> Beverage
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input ref={anzahlRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => handleImport(e, 'anzahl')} />
              <input ref={umsatzRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => handleImport(e, 'umsatz')} />
              <input ref={costRef}   type="file" accept=".xlsx,.xls" className="hidden" onChange={handleCostImport} />
              <Button variant="outline" size="sm" className="h-8" onClick={() => anzahlRef.current?.click()} disabled={importing !== null}>
                {importing === 'anzahl' ? <span className="h-3 w-3 mr-1 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" /> : <Upload className="h-3 w-3 mr-1" />}
                <Hash className="h-3 w-3 mr-1" /> Anzahl
              </Button>
              <Button variant="outline" size="sm" className="h-8" onClick={() => umsatzRef.current?.click()} disabled={importing !== null}>
                {importing === 'umsatz' ? <span className="h-3 w-3 mr-1 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" /> : <Upload className="h-3 w-3 mr-1" />}
                <TrendingUp className="h-3 w-3 mr-1" /> Umsatz
              </Button>
              <Button variant="outline" size="sm" className={cn('h-8', costs.length > 0 && 'border-purple-400 text-purple-700 dark:text-purple-300')}
                onClick={() => costRef.current?.click()} disabled={importingCost}>
                {importingCost ? <span className="h-3 w-3 mr-1 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" /> : <Receipt className="h-3 w-3 mr-1" />}
                WES {costMap.size > 0 && <Badge className="ml-1 text-[9px] py-0 px-1 bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300 border-0">{costMap.size}</Badge>}
              </Button>
              {data && (
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" onClick={clearAllData}>
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Zeile 2: Tabs + Filter */}
          {data && (
            <div className="flex items-center gap-3 flex-wrap border-t border-border/60 pt-2">

              {/* Ansicht-Tabs */}
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                <button onClick={() => setView('monat')}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                    view === 'monat' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <CalendarDays className="h-3 w-3" /> Monatsansicht
                </button>
                <button onClick={() => setView('jahr')}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                    view === 'jahr' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <LayoutGrid className="h-3 w-3" /> Jahresansicht
                </button>
                <button onClick={() => setView('gruppen')}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                    view === 'gruppen' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <Award className="h-3 w-3" /> Gruppen & Margen
                </button>
              </div>

              {/* Monats-Dropdown — nur in Monatsansicht */}
              {view === 'monat' && monthsOnly.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground font-medium">Monat:</span>
                  <select
                    value={activeMonth}
                    onChange={e => setMonth(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                  >
                    {[...monthsOnly].reverse().map(m => (
                      <option key={m} value={m}>{formatMonthLong(m)}</option>
                    ))}
                  </select>
                </div>
              )}

              {view !== 'gruppen' && (
                <>
                  {/* N-Auswahl */}
                  <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                    {nOptions.map(n => (
                      <button key={n}
                        onClick={() => setN(n)}
                        className={cn('px-2 py-1 text-xs font-medium rounded-md transition-all',
                          currentN === n
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground')}>
                        {n === ALL_SENTINEL ? 'Alle' : `${isFlop ? 'Flop' : 'Top'} ${n}`}
                      </button>
                    ))}
                  </div>

                  {/* Top / Flop */}
                  <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                    <button onClick={() => setMode('top')}
                      className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                        mode === 'top' ? 'bg-emerald-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      <TrendingUp className="h-3 w-3" /> Top
                    </button>
                    <button onClick={() => setMode('flop')}
                      className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                        mode === 'flop' ? 'bg-red-500 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      <TrendingDown className="h-3 w-3" /> Flop
                    </button>
                  </div>

                  {/* Sortierung */}
                  <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5 ml-auto">
                    <button onClick={() => setSortBy('count')}
                      className={cn('flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                        sortBy === 'count' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      <Hash className="h-3 w-3" /> Nach Anzahl
                    </button>
                    <button onClick={() => setSortBy('revenue')}
                      className={cn('flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                        sortBy === 'revenue' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      <TrendingUp className="h-3 w-3" /> Nach Umsatz
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 pb-24 space-y-4">

        {/* ── Kein Daten-State ───────────────────────────────────────────────── */}
        {!data && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="rounded-full bg-muted p-5"><Package className="h-10 w-10 text-muted-foreground" /></div>
            <div>
              <p className="text-base font-semibold">Noch keine Produktdaten importiert</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Importiere die Gastronovi-Exporte «Anzahl Rezepte» und «Umsatz Rezepte» oben rechts.
              </p>
            </div>
            <div className="flex gap-3 mt-2">
              <Button onClick={() => anzahlRef.current?.click()} variant="outline"><Hash className="h-4 w-4 mr-2" /> Anzahl Rezepte</Button>
              <Button onClick={() => umsatzRef.current?.click()} variant="outline"><TrendingUp className="h-4 w-4 mr-2" /> Umsatz Rezepte</Button>
            </div>
          </div>
        )}

        {/* ══ MONATSANSICHT ════════════════════════════════════════════════════ */}
        {data && view === 'monat' && (
          <>
            {/* Aktiver Monat — gross & klar sichtbar */}
            <div className={cn(
              'rounded-xl border px-5 py-4 flex items-center justify-between flex-wrap gap-3',
              isFlop ? 'border-red-200 bg-red-50/40 dark:border-red-900 dark:bg-red-950/10'
                     : 'border-primary/20 bg-primary/5',
            )}>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
                  Ausgewählter Zeitraum
                </p>
                <p className={cn('text-2xl font-bold', isFlop ? 'text-red-600 dark:text-red-400' : 'text-primary')}>
                  {formatMonthLong(activeMonth)}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {isFlop ? <TrendingDown className="h-4 w-4 text-red-500" /> : <Award className="h-4 w-4 text-primary" />}
                <span className="font-semibold text-foreground">
                  {currentN === ALL_SENTINEL ? 'Alle' : `${isFlop ? 'Flop' : 'Top'} ${Math.min(currentN, ranked.length)}`}
                </span>
                <span>· {sortBy === 'count' ? 'Nach Anzahl' : 'Nach Umsatz'}</span>
                {isFlop && <Badge variant="outline" className="text-xs text-red-600 border-red-300 bg-red-50 dark:bg-red-950/20">Schlechteste Produkte</Badge>}
              </div>
            </div>

            {ranked.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Keine Daten für diesen Monat.</p>
              </div>
            )}

            {ranked.length > 0 && (
              <div className={cn('rounded-xl border overflow-hidden',
                isFlop ? 'border-red-200 dark:border-red-900' : 'border-border')}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn('border-b',
                      isFlop ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20' : 'border-border bg-muted/40')}>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-24">Anzahl</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-28">Umsatz</th>
                      {costs.length > 0 && <>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-24">WES/Stk.</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-28">Warenaufw.</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-20">WES-Q %</th>
                      </>}
                      <th className="px-2 py-2.5 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map(r => {
                      const val      = sortBy === 'count' ? r.count : r.revenue;
                      const barWidth = maxVal > 0 ? (val / maxVal) * 100 : 0;
                      const barColor = isFlop ? 'bg-red-400 dark:bg-red-600'
                        : sortBy === 'count' ? 'bg-blue-500' : 'bg-emerald-500';
                      const valueColor = isFlop ? 'text-red-600 dark:text-red-400'
                        : sortBy === 'count' ? 'text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400';
                      const cost = costMap.get(r.name.toLowerCase());
                      const warenaufwand = cost && r.count > 0 ? cost.wes * r.count : 0;
                      // WES-Q berechnen: Warenaufwand / Umsatz × 100
                      const wesQEffektiv = cost && r.revenue > 0 && warenaufwand > 0
                        ? (warenaufwand / r.revenue) * 100
                        : (cost?.wesQ ?? 0);
                      return (
                        <tr key={r.name}
                          className={cn('border-b last:border-0 transition-colors group',
                            isFlop ? 'border-red-100 dark:border-red-900/40 hover:bg-red-50/40' : 'border-border/50 hover:bg-muted/30')}>
                          <td className="px-3 py-2.5 text-center">
                            <span className="text-xs font-medium tabular-nums text-muted-foreground">{r.rank}</span>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="space-y-1">
                              <span className="font-medium">{r.name}</span>
                              <div className="h-1.5 rounded-full bg-muted overflow-hidden max-w-xs">
                                <div className={cn('h-full rounded-full', barColor)} style={{ width: `${barWidth}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {r.count > 0
                              ? <span className={cn('font-medium', sortBy === 'count' ? valueColor : '')}>{r.count.toLocaleString('de-CH')}×</span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {r.revenue > 0
                              ? <span className={cn('font-medium', sortBy === 'revenue' ? valueColor : '')}>{formatCHF(r.revenue)}</span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                          {costs.length > 0 && (() => {
                            const isEditingWes  = editingCost?.name.toLowerCase() === r.name.toLowerCase() && editingCost.field === 'wes';
                            const isEditingWesQ = editingCost?.name.toLowerCase() === r.name.toLowerCase() && editingCost.field === 'wesQ';

                            const cellBase = 'px-1 py-1.5 text-right tabular-nums text-xs cursor-pointer select-none group/cell';
                            const inputCls = 'w-20 text-right text-xs bg-purple-50 dark:bg-purple-950/50 border border-purple-400 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-purple-500 tabular-nums';

                            return <>
                              {/* WES/Stk. — editierbar */}
                              <td className={cellBase} onClick={() => startCostEdit(r.name, 'wes', cost?.wes ?? 0)}>
                                {isEditingWes
                                  ? <input ref={costEditRef} className={inputCls} value={editingValue}
                                      onChange={e => setEditingValue(e.target.value)}
                                      onBlur={commitCostEdit}
                                      onKeyDown={e => { if (e.key === 'Enter') commitCostEdit(); if (e.key === 'Escape') setEditingCost(null); }}
                                      onClick={e => e.stopPropagation()} autoFocus />
                                  : <span className={cn('flex items-center justify-end gap-1',
                                      cost?.wes ? 'text-purple-700 dark:text-purple-300' : 'text-muted-foreground')}>
                                      {cost?.wes ? formatCHF(cost.wes) : '–'}
                                      <Pencil className="h-2.5 w-2.5 opacity-0 group-hover/cell:opacity-40 shrink-0" />
                                    </span>}
                              </td>

                              {/* Warenaufwand — berechnet, nicht editierbar */}
                              <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                                {warenaufwand > 0
                                  ? <span className="font-medium text-purple-700 dark:text-purple-300">{formatCHF(warenaufwand)}</span>
                                  : <span className="text-muted-foreground">–</span>}
                              </td>

                              {/* WES-Q % — editierbar */}
                              <td className={cellBase} onClick={() => startCostEdit(r.name, 'wesQ', cost?.wesQ ?? 0)}>
                                {isEditingWesQ
                                  ? <input ref={costEditRef} className={inputCls} value={editingValue}
                                      onChange={e => setEditingValue(e.target.value)}
                                      onBlur={commitCostEdit}
                                      onKeyDown={e => { if (e.key === 'Enter') commitCostEdit(); if (e.key === 'Escape') setEditingCost(null); }}
                                      onClick={e => e.stopPropagation()} autoFocus />
                                  : <span className={cn('flex items-center justify-end gap-1',
                                      wesQEffektiv > 0
                                        ? wesQEffektiv > 35 ? 'text-red-600 dark:text-red-400'
                                          : wesQEffektiv > 25 ? 'text-amber-600 dark:text-amber-400'
                                          : 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-muted-foreground')}>
                                      {wesQEffektiv > 0 ? `${wesQEffektiv.toFixed(1)}%` : '–'}
                                      <Pencil className="h-2.5 w-2.5 opacity-0 group-hover/cell:opacity-40 shrink-0" />
                                    </span>}
                              </td>
                            </>;
                          })()}
                          <td className="px-2 py-2.5">
                            <button onClick={() => ignoreProduct(r.name)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Entfernte Produkte */}
            {ignoredByUser.length > 0 && (
              <div className="space-y-2">
                <button onClick={() => setShowIgnored(s => !s)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showIgnored ? 'rotate-180' : '')} />
                  {ignoredByUser.length} manuell entfernte Produkte
                </button>
                {showIgnored && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-wrap gap-2">
                    {ignoredByUser.map(name => (
                      <div key={name} className="flex items-center gap-1.5 bg-background border border-border rounded-full px-3 py-1 text-xs">
                        <span className="text-muted-foreground line-through">{name}</span>
                        <button onClick={() => restoreProduct(name)} className="text-primary hover:text-primary/80 font-medium">↺</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ══ JAHRESANSICHT ════════════════════════════════════════════════════ */}
        {data && view === 'jahr' && (
          <>
            <div className="flex items-center gap-2">
              <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">
                {currentN === ALL_SENTINEL ? 'Alle' : `${isFlop ? 'Flop' : 'Top'} ${currentN}`} pro Monat
              </span>
              <span className="text-xs text-muted-foreground">
                · {sortBy === 'count' ? 'Nach Anzahl' : 'Nach Umsatz'} · {monthsOnly.length} Monate
              </span>
            </div>
            {monthsOnly.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">Keine Monatsdaten vorhanden.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {/* Kumuliertes Total (alle Monate) — ganz links */}
                <div className={cn(
                  'rounded-xl border overflow-hidden',
                  isFlop ? 'border-red-300 dark:border-red-800 bg-red-50/40 dark:bg-red-950/10'
                         : 'border-primary/30 bg-primary/5',
                )}>
                  <div className={cn(
                    'px-3 py-2.5 border-b flex items-center justify-between',
                    isFlop ? 'border-red-200 dark:border-red-800 bg-red-100/60 dark:bg-red-900/20'
                           : 'border-primary/20 bg-primary/10',
                  )}>
                    <span className="text-sm font-bold">
                      {isFlop ? '🔴' : '⭐'} Kumuliert gesamt
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {currentN === ALL_SENTINEL ? 'Alle' : `${isFlop ? 'Flop' : 'Top'} ${Math.min(currentN, totalRanked.length)}`} · alle Monate
                    </span>
                  </div>
                  {totalRanked.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground">Keine Daten</div>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {totalRanked.map(r => {
                        const val = sortBy === 'count' ? r.count : r.revenue;
                        const maxTotalVal = Math.max(...totalRanked.map(x => sortBy === 'count' ? x.count : x.revenue));
                        const barPct = maxTotalVal > 0 ? (val / maxTotalVal) * 100 : 0;
                        const barColor = isFlop ? 'bg-red-400 dark:bg-red-600'
                          : sortBy === 'count' ? 'bg-blue-500' : 'bg-emerald-500';
                        return (
                          <div key={r.name} className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground tabular-nums w-4 shrink-0 text-center">{r.rank}</span>
                              <span className="text-xs font-medium truncate flex-1 min-w-0">{r.name}</span>
                              <span className={cn('text-xs tabular-nums shrink-0',
                                isFlop ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                                {sortBy === 'count' ? `${r.count.toLocaleString('de-CH')}×` : formatCHF(r.revenue)}
                              </span>
                            </div>
                            <div className="mt-1 ml-6 h-1 rounded-full bg-muted overflow-hidden">
                              <div className={cn('h-full rounded-full', barColor)} style={{ width: `${barPct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Monatskarten (neueste zuerst) */}
                {[...monthsOnly].reverse().map(m => (
                  <MonthCard
                    key={m}
                    month={m}
                    entries={data.entries}
                    ignoredByUser={ignoredByUser}
                    sortBy={sortBy}
                    mode={mode}
                    n={currentN}
                    category={category}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ══ GRUPPEN & MARGEN ════════════════════════════════════════════════ */}
        {data && view === 'gruppen' && (
          <GruppenAnalyse
            entries={data.entries}
            costs={costs}
            groups={groups}
            onGroupsChange={setGroups}
            month={activeMonth || 'alle'}
            category={category}
            ignoredByUser={ignoredByUser}
            availableMonths={monthsOnly}
            onMonthChange={setMonth}
          />
        )}

        {/* Ignorier-Liste (beide Ansichten) */}
        {data && view !== 'gruppen' && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Automatisch ignorierte Begriffe ({DEFAULT_IGNORE_TERMS.length})
              </p>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5"
                onClick={() => { setProductSearch(''); setProductFilterCat('all'); setShowProductManager(true); }}>
                <Settings2 className="h-3 w-3" />
                Produkte verwalten ({allProductNames.length})
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_IGNORE_TERMS.map(t => (
                <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">{t}</Badge>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ── Produktdatenbank ─────────────────────────────────────────────────── */}
      {showProductManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-5xl flex flex-col" style={{ maxHeight: '88vh' }}>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="text-sm font-bold flex items-center gap-2">
                  <Package className="h-4 w-4 text-primary" />
                  Produktdatenbank
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Zentrale WES-Werte — Änderungen gelten für alle Monate und Auswertungen
                </p>
              </div>
              <button onClick={() => { setShowProductManager(false); setEditingCost(null); }}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Suche + Filter */}
            <div className="px-5 py-3 border-b border-border/60 shrink-0 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input type="text" placeholder="Produkt suchen…" value={productSearch}
                  onChange={e => setProductSearch(e.target.value)}
                  className="w-full h-8 rounded-md border border-border bg-background pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                {(['all', 'food', 'beverage'] as const).map(c => (
                  <button key={c} onClick={() => setProductFilterCat(c)}
                    className={cn('flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-all',
                      productFilterCat === c ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {c === 'food' && <Utensils className="h-3 w-3" />}
                    {c === 'beverage' && <Wine className="h-3 w-3" />}
                    {c === 'all' ? 'Alle' : c === 'food' ? 'Food' : 'Beverage'}
                  </button>
                ))}
              </div>
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5 text-xs">
                <button onClick={() => setProductFilterWes('all')}
                  className={cn('px-2.5 py-1 rounded-md font-medium transition-all',
                    productFilterWes === 'all' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  Alle
                </button>
                <button onClick={() => setProductFilterWes('missing')}
                  className={cn('px-2.5 py-1 rounded-md font-medium transition-all',
                    productFilterWes === 'missing' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  Ohne WES
                </button>
              </div>
            </div>

            {/* Tabelle */}
            <div className="overflow-y-auto flex-1">
              {(() => {
                const q = productSearch.toLowerCase();
                const filtered = allProductNames.filter(p => {
                  if (productFilterCat !== 'all' && p.category !== productFilterCat) return false;
                  if (q && !p.name.toLowerCase().includes(q)) return false;
                  if (productFilterWes === 'missing') {
                    const c = costs.find(cc => cc.name.toLowerCase() === p.name.toLowerCase() && cc.category === p.category);
                    if (c && c.wes > 0) return false;
                  }
                  return true;
                });
                if (filtered.length === 0) {
                  return <p className="text-center text-xs text-muted-foreground py-12">Keine Produkte gefunden</p>;
                }
                return (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="border-b border-border bg-muted/50">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground w-8">
                          <CheckSquare className="h-3.5 w-3.5" />
                        </th>
                        <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
                        <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground w-20">Kat.</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-28">Brutto</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-28">Netto</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-28">WES/Stk.</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-purple-600 dark:text-purple-400 w-24">WES-Q %</th>
                        <th className="px-3 py-2.5 w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(({ name, category: pCat }) => {
                        const isAutoIgnored = DEFAULT_IGNORE_TERMS.some(t => name.toLowerCase().includes(t));
                        const isManualIgnored = ignoredByUser.includes(name);
                        const isIgnored = isAutoIgnored || isManualIgnored;
                        const cost = costs.find(c => c.name.toLowerCase() === name.toLowerCase() && c.category === pCat);
                        const hasWes = cost && cost.wes > 0;

                        const mkField = (field: 'brutto' | 'netto' | 'wes' | 'wesQ') => {
                          const isEditing = editingCost?.name.toLowerCase() === name.toLowerCase() && editingCost.field === field;
                          const val = field === 'brutto' ? (cost?.bruttoPrice ?? 0)
                                    : field === 'netto'  ? (cost?.nettoPrice  ?? 0)
                                    : field === 'wes'    ? (cost?.wes         ?? 0)
                                    :                      (cost?.wesQ        ?? 0);
                          const display = field === 'wesQ'
                            ? (val > 0 ? `${val.toFixed(1)}%` : '–')
                            : (val > 0 ? formatCHF(val) : '–');
                          const colorCls = field === 'wesQ' && val > 0
                            ? val > 35 ? 'text-red-600 dark:text-red-400'
                              : val > 25 ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                            : 'text-purple-700 dark:text-purple-300';
                          return (
                            <td key={field}
                              className="px-1 py-1.5 text-right tabular-nums text-xs cursor-pointer group/cell"
                              onClick={() => startCostEditForCategory(name, pCat, field, val)}>
                              {isEditing
                                ? <input ref={costEditRef}
                                    className="w-20 text-right text-xs bg-purple-50 dark:bg-purple-950/50 border border-purple-400 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-purple-500 tabular-nums"
                                    value={editingValue}
                                    onChange={e => setEditingValue(e.target.value)}
                                    onBlur={() => commitCostEditForCategory(name, pCat)}
                                    onKeyDown={e => { if (e.key === 'Enter') commitCostEditForCategory(name, pCat); if (e.key === 'Escape') setEditingCost(null); }}
                                    onClick={e => e.stopPropagation()} autoFocus />
                                : <span className={cn('flex items-center justify-end gap-1',
                                    val > 0 ? colorCls : 'text-muted-foreground')}>
                                    {display}
                                    <Pencil className="h-2.5 w-2.5 opacity-0 group-hover/cell:opacity-40 shrink-0" />
                                  </span>}
                            </td>
                          );
                        };

                        return (
                          <tr key={`${pCat}-${name}`}
                            className={cn('border-b border-border/40 hover:bg-muted/30 transition-colors group',
                              isIgnored && 'opacity-40')}>
                            {/* Sichtbarkeit-Toggle */}
                            <td className="px-4 py-2.5">
                              <button disabled={isAutoIgnored}
                                onClick={() => isManualIgnored ? restoreProduct(name) : ignoreProduct(name)}
                                className={cn('w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0',
                                  isIgnored ? 'bg-muted border-border text-muted-foreground' : 'border-primary bg-primary text-primary-foreground',
                                  isAutoIgnored && 'cursor-not-allowed')}
                                title={isAutoIgnored ? 'System' : isManualIgnored ? 'Wiederherstellen' : 'Ausblenden'}>
                                {isIgnored && <X className="h-2.5 w-2.5" />}
                              </button>
                            </td>
                            {/* Name */}
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className={cn('text-xs font-medium truncate max-w-xs', isIgnored && 'line-through text-muted-foreground')}>
                                  {name}
                                </span>
                                {!hasWes && !isIgnored && (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 shrink-0">
                                    Kein WES
                                  </span>
                                )}
                                {isAutoIgnored && <span className="text-[9px] text-muted-foreground shrink-0">System</span>}
                              </div>
                            </td>
                            {/* Kategorie */}
                            <td className="px-3 py-2.5 text-center">
                              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                                pCat === 'food'
                                  ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                                  : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300')}>
                                {pCat === 'food' ? 'Food' : 'Bev.'}
                              </span>
                            </td>
                            {/* WES-Felder (alle 4 editierbar) */}
                            {mkField('brutto')}
                            {mkField('netto')}
                            {mkField('wes')}
                            {mkField('wesQ')}
                            {/* Löschen-Knopf für WES */}
                            <td className="px-2 py-2.5">
                              {hasWes && (
                                <button
                                  onClick={() => {
                                    const updated = costs.map(c =>
                                      c.name.toLowerCase() === name.toLowerCase() && c.category === pCat
                                        ? { ...c, bruttoPrice: 0, nettoPrice: 0, wes: 0, wesQ: 0 }
                                        : c
                                    );
                                    saveProductCostsToDB(updated);
                                    setCosts(updated);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                                  title="WES-Werte löschen">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {costs.filter(c => c.wes > 0).length} mit WES ·{' '}
                {allProductNames.length - costs.filter(c => c.wes > 0).length} ohne ·{' '}
                {ignoredByUser.length} ausgeblendet
              </span>
              <Button size="sm" variant="outline" className="h-7"
                onClick={() => { setShowProductManager(false); setEditingCost(null); }}>
                Schliessen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset-Dialog ─────────────────────────────────────────────────────── */}
      {showResetDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm p-6 space-y-5">
            <div className="flex items-start gap-3">
              <Trash2 className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-bold">Daten löschen</h2>
                <p className="text-xs text-muted-foreground mt-1">Wähle aus, welche Daten gelöscht werden sollen.</p>
              </div>
            </div>

            {/* Kategorie */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground">Kategorie</p>
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                {(['all', 'food', 'beverage'] as const).map(c => (
                  <button key={c} onClick={() => setResetCat(c)}
                    className={cn('flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium flex-1 justify-center transition-all',
                      resetCat === c ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {c === 'food' && <Utensils className="h-3 w-3" />}
                    {c === 'beverage' && <Wine className="h-3 w-3" />}
                    {c === 'all' ? 'Alle' : c === 'food' ? 'Food' : 'Beverage'}
                  </button>
                ))}
              </div>
            </div>

            {/* Monat */}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground">Monat</p>
              <select
                value={resetMonth}
                onChange={e => setResetMonth(e.target.value)}
                className="w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">Alle Monate</option>
                {allMonthsForReset.map(m => (
                  <option key={m} value={m}>{formatMonthLong(m)}</option>
                ))}
              </select>
            </div>

            {/* Vorschau was gelöscht wird */}
            <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              Löscht: <span className="font-semibold">
                {resetCat === 'all' ? 'Food + Beverage' : resetCat === 'food' ? 'Food' : 'Beverage'}
                {' · '}
                {resetMonth === 'all' ? 'Alle Monate' : formatMonthLong(resetMonth)}
              </span>
            </div>

            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowResetDialog(false)}>Abbrechen</Button>
              <Button size="sm" variant="destructive" onClick={doReset}>Löschen</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplikat-Bestätigung ──────────────────────────────────────────────── */}
      {pendingImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-bold">Daten bereits vorhanden</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Die Datei <span className="font-medium text-foreground">«{pendingImport.fileName}»</span> enthält
                  Monate, die bereits importiert wurden:
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
              <ul className="space-y-1">
                {pendingImport.overlappingMonths.map(m => (
                  <li key={m} className="flex items-center gap-2 text-xs">
                    <CheckSquare className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    <span className="font-medium text-amber-800 dark:text-amber-200">
                      {formatMonthLong(m)}
                    </span>
                    <span className="text-amber-600 dark:text-amber-400">wird überschrieben</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">
              Willst du die bestehenden Daten für diese Monate durch die neuen Werte aus der Datei ersetzen?
            </p>

            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" onClick={cancelImport}>
                Abbrechen
              </Button>
              <Button size="sm" className="bg-amber-500 hover:bg-amber-600 text-white" onClick={confirmImport}>
                Trotzdem importieren & überschreiben
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
