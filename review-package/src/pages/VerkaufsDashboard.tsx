/**
 * VerkaufsDashboard – Minimal & stabil
 * =====================================
 * Nur product_sales. Keine externe Abhängigkeit.
 * Aggregation nach source (Food / Beverage / Manual).
 * Altbestand (source IS NULL) wird ignoriert.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Package, TrendingUp, DollarSign, ShoppingCart,
  AlertTriangle, RefreshCw, Filter, Archive, Star,
  FileDown, FileText,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { verkaufsWesQuote } from '@/lib/warenkosten-quote';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  loadProductSalesRows,
  loadAltbestandCount,
  loadProductWesMap,
  loadProductCategoryMap,
  sourceLabel,
  type ProductSalesRow,
} from '@/lib/sales-db';
import {
  loadProductCostsFromDB,
  saveProductCostsToDB,
  mergeProductCosts,
  type ProductCostEntry,
} from '@/lib/produkte-store';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useTenant } from '@/contexts/TenantContext';
import { grossToNet } from '@/types/personnel';

const MONTH_NAMES = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ─── Formatierung ─────────────────────────────────────────────────────────────

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

const SOURCE_COLORS: Record<string, string> = {
  food_csv_export:     '#6366f1',
  beverage_csv_export: '#10b981',
  manual_test:         '#f59e0b',
  __other__:           '#94a3b8',
};

function srcColor(source: string | null): string {
  if (!source) return SOURCE_COLORS.__other__;
  return SOURCE_COLORS[source] ?? SOURCE_COLORS.__other__;
}

// ─── Typen ────────────────────────────────────────────────────────────────────

type SourceRow = {
  source:   string | null;
  label:    string;
  qty:      number;
  revenue:  number;
  wes:      number;
  products: number;
};

type TopProduct = {
  product_name: string;
  source:       string | null;
  qty:          number;
  revenue:      number;
  wes:          number;
};

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregate(
  rows: ProductSalesRow[],
  topLimit: number,
  wesMap: Map<string, number>,
) {
  let totalQty     = 0;
  let totalRevenue = 0;
  let totalWes     = 0;
  const allProducts = new Set<string>();

  const srcMap  = new Map<string, SourceRow>();
  const prodMap = new Map<string, TopProduct>();

  for (const r of rows) {
    const qty      = Number(r.quantity ?? 0);
    const rev      = Number(r.revenue  ?? 0);
    const src      = r.source ?? null;
    const key      = src ?? '__null__';
    const nameKey  = (r.product_name ?? '').trim().toLowerCase();
    const wesUnit  = wesMap.get(nameKey) ?? 0;
    const wesRow   = qty * wesUnit;

    totalQty     += qty;
    totalRevenue += rev;
    totalWes     += wesRow;
    if (r.product_name) allProducts.add(r.product_name);

    // Nach Source aggregieren
    if (!srcMap.has(key)) {
      srcMap.set(key, { source: src, label: sourceLabel(src), qty: 0, revenue: 0, wes: 0, products: 0 });
    }
    const s = srcMap.get(key)!;
    s.qty     += qty;
    s.revenue += rev;
    s.wes     += wesRow;

    // Pro Produkt aggregieren
    const pKey = r.product_name ?? '(unbekannt)';
    if (!prodMap.has(pKey)) {
      prodMap.set(pKey, { product_name: pKey, source: src, qty: 0, revenue: 0, wes: 0 });
    }
    const p = prodMap.get(pKey)!;
    p.qty     += qty;
    p.revenue += rev;
    p.wes     += wesRow;
  }

  // Distinct Produkte pro Source
  const srcProducts = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.product_name) continue;
    const key = r.source ?? '__null__';
    if (!srcProducts.has(key)) srcProducts.set(key, new Set());
    srcProducts.get(key)!.add(r.product_name);
  }
  for (const [key, s] of srcMap) {
    s.products = srcProducts.get(key)?.size ?? 0;
  }

  const bySource = Array.from(srcMap.values()).sort((a, b) => b.revenue - a.revenue);
  const topProducts = Array.from(prodMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topLimit);

  return { totalQty, totalRevenue, totalWes, totalProducts: allProducts.size, bySource, topProducts };
}

// ─── WES-Ampel ────────────────────────────────────────────────────────────────

function WesAmpel({ wesP }: { wesP: number | null }) {
  if (wesP === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap">
        <span className="h-2 w-2 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
        kein WES
      </span>
    );
  }
  const isGreen  = wesP <= 25;
  const isYellow = wesP > 25 && wesP <= 30;
  return isGreen ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap">
      <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
      {wesP.toFixed(1)} %
    </span>
  ) : isYellow ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-400 border border-yellow-300 dark:border-yellow-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap">
      <span className="h-2 w-2 rounded-full bg-yellow-500 shrink-0" />
      {wesP.toFixed(1)} %
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 border border-red-300 dark:border-red-700 px-2 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap">
      <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
      {wesP.toFixed(1)} %
    </span>
  );
}

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, icon: Icon, sub, color = 'default',
}: {
  label: string;
  value: string;
  icon: React.FC<{ className?: string }>;
  sub?: string;
  color?: 'default' | 'green' | 'violet' | 'muted';
}) {
  const cls = {
    default: 'text-primary',
    green:   'text-emerald-600 dark:text-emerald-400',
    violet:  'text-violet-600 dark:text-violet-400',
    muted:   'text-muted-foreground',
  }[color];
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className="rounded-lg bg-muted/60 p-2.5 shrink-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function VerkaufsDashboard() {
  const { showNetRevenue } = useRevenueDisplay();
  const { tenantId } = useTenant();
  const now = new Date();
  const [loading,         setLoading]         = useState(true);
  const [dbError,         setDbError]         = useState<string | null>(null);
  const [rawRows,         setRawRows]         = useState<ProductSalesRow[]>([]);
  const [altbestandCount, setAltbestandCount] = useState<number>(0);
  const [wesMap,          setWesMap]          = useState<Map<string, number>>(new Map());
  const [categoryMap,     setCategoryMap]     = useState<Map<string, string>>(new Map());

  // ── WES-Pflege Modal ─────────────────────────────────────────────────────────
  type WesModalProduct = { product_name: string; category: string; source: string | null };
  const [wesModal,        setWesModal]        = useState<WesModalProduct | null>(null);
  const [wesInputChf,     setWesInputChf]     = useState('');
  const [wesInputPct,     setWesInputPct]     = useState('');
  const [wesSaving,       setWesSaving]       = useState(false);
  const [wesSaveError,    setWesSaveError]    = useState<string | null>(null);

  const [srcFilter,       setSrcFilter]       = useState<string>('all');
  const [batchFilter,     setBatchFilter]     = useState<string>('all');
  const [topSearch,       setTopSearch]       = useState('');

  // ── Zeitraum & Kategorie-Filter ─────────────────────────────────────────────
  type ZeitraumTyp = 'monat' | 'mehrere' | 'jahr' | 'ytd' | 'benutzerdefiniert';
  const [zeitraumTyp,      setZeitraumTyp]      = useState<ZeitraumTyp>('monat');
  const [selectedMonth,    setSelectedMonth]    = useState<number>(now.getMonth() + 1);
  const [selectedYear,     setSelectedYear]     = useState<number>(now.getFullYear());
  const [startMonth,       setStartMonth]       = useState<number>(1);
  const [endMonth,         setEndMonth]         = useState<number>(now.getMonth() + 1);
  const [vonDatum,         setVonDatum]         = useState<string>(`${now.getFullYear()}-01-01`);
  const [bisDatum,         setBisDatum]         = useState<string>(now.toISOString().slice(0, 10));
  const [selectedCategory, setSelectedCategory] = useState<string>('Alle');

  const load = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [rows, altCount, wMap, catMap] = await Promise.all([
        loadProductSalesRows(tenantId),
        loadAltbestandCount(tenantId),
        loadProductWesMap(),
        loadProductCategoryMap(),
      ]);
      setRawRows(rows);
      setAltbestandCount(altCount);
      setWesMap(wMap);
      setCategoryMap(catMap);

      // Mapping-Statistik
      const distinctNames = new Set(rows.map(r => (r.product_name ?? '').trim().toLowerCase()));
      const matched = [...distinctNames].filter(n => wMap.has(n) && (wMap.get(n) ?? 0) > 0);
      console.log(`[VerkaufsDashboard] WES-Mapping: ${matched.length} / ${distinctNames.size} Produkte gemappt (${wMap.size} in WES-DB)`);
      console.log(`[VerkaufsDashboard] Kategorie-Map: ${catMap.size} Einträge geladen`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VerkaufsDashboard] load error:', msg);
      setDbError(msg);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  // Erstladen + Reaktion auf neuen Import aus SalesUpload
  useEffect(() => {
    load();
    window.addEventListener('product_sales_updated', load);
    return () => window.removeEventListener('product_sales_updated', load);
  }, [load]);

  // ── WES-Pflege: Speichern ────────────────────────────────────────────────────

  const handleSaveWes = useCallback(async () => {
    if (!wesModal) return;
    const wes = parseFloat(wesInputChf.replace(',', '.'));
    if (!Number.isFinite(wes) || wes <= 0) {
      setWesSaveError('Bitte einen gültigen WES-Wert > 0 eingeben.');
      return;
    }
    const wesQ = wesInputPct.trim()
      ? parseFloat(wesInputPct.replace(',', '.'))
      : 0;

    // Kategorie aus source ableiten (food_csv_export → food, beverage_csv_export → beverage)
    const srcLower = (wesModal.source ?? '').toLowerCase();
    const catFromSource: 'food' | 'beverage' =
      srcLower.includes('bev') ? 'beverage' : 'food';
    const catFromMap = (wesModal.category ?? '').toLowerCase();
    const category: 'food' | 'beverage' =
      catFromMap === 'beverage' ? 'beverage'
      : catFromMap === 'food'   ? 'food'
      : catFromSource;

    setWesSaving(true);
    setWesSaveError(null);
    try {
      const existing = await loadProductCostsFromDB();
      const entry: ProductCostEntry = {
        name:        wesModal.product_name,
        category,
        bruttoPrice: 0,
        nettoPrice:  0,
        wes,
        wesQ:        Number.isFinite(wesQ) && wesQ > 0 ? wesQ : 0,
      };
      const merged = mergeProductCosts(existing, [entry]);
      await saveProductCostsToDB(merged);
      // WES-Map neu laden damit das Produkt sofort aus der Liste verschwindet
      const freshMap = await loadProductWesMap();
      setWesMap(freshMap);
      setWesModal(null);
      setWesInputChf('');
      setWesInputPct('');
    } catch (err) {
      setWesSaveError(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      setWesSaving(false);
    }
  }, [wesModal, wesInputChf, wesInputPct]);

  // ── Filter-Optionen ────────────────────────────────────────────────────────

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.source ?? '__null__');
    return Array.from(set).sort();
  }, [rawRows]);

  const availableBatches = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) if (r.import_batch) set.add(r.import_batch);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [rawRows]);

  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const r of rawRows) {
      if (r.sale_date && r.sale_date.length >= 4) {
        const y = parseInt(r.sale_date.substring(0, 4), 10);
        if (!isNaN(y)) set.add(y);
      }
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [rawRows]);

  // ── Zeitraum-Berechnung ────────────────────────────────────────────────────

  const { dateFrom, dateTo, ytdStichtag } = useMemo(() => {
    const yyyy = String(selectedYear);
    const pad = (n: number) => String(n).padStart(2, '0');

    if (zeitraumTyp === 'monat') {
      const mm = pad(selectedMonth);
      return { dateFrom: `${yyyy}-${mm}-01`, dateTo: `${yyyy}-${mm}-31`, ytdStichtag: null };
    }
    if (zeitraumTyp === 'mehrere') {
      const smm = pad(Math.min(startMonth, endMonth));
      const emm = pad(Math.max(startMonth, endMonth));
      return { dateFrom: `${yyyy}-${smm}-01`, dateTo: `${yyyy}-${emm}-31`, ytdStichtag: null };
    }
    if (zeitraumTyp === 'jahr') {
      return { dateFrom: `${yyyy}-01-01`, dateTo: `${yyyy}-12-31`, ytdStichtag: null };
    }
    if (zeitraumTyp === 'ytd') {
      // Letzter vorhandener sale_date im gewählten Jahr
      const maxDate = rawRows
        .filter(r => r.sale_date?.startsWith(yyyy))
        .reduce<string>((max, r) => (r.sale_date! > max ? r.sale_date! : max), `${yyyy}-01-01`);
      return { dateFrom: `${yyyy}-01-01`, dateTo: maxDate, ytdStichtag: maxDate };
    }
    // benutzerdefiniert
    return { dateFrom: vonDatum, dateTo: bisDatum, ytdStichtag: null };
  }, [zeitraumTyp, selectedMonth, selectedYear, startMonth, endMonth, vonDatum, bisDatum, rawRows]);

  // ── Zeitraum-Label für Anzeige ─────────────────────────────────────────────

  const zeitraumLabel = useMemo(() => {
    if (zeitraumTyp === 'monat') return `${MONTH_NAMES[selectedMonth]} ${selectedYear}`;
    if (zeitraumTyp === 'mehrere') {
      const s = Math.min(startMonth, endMonth);
      const e = Math.max(startMonth, endMonth);
      return `${MONTH_NAMES[s]}–${MONTH_NAMES[e]} ${selectedYear}`;
    }
    if (zeitraumTyp === 'jahr') return `Jahr ${selectedYear}`;
    if (zeitraumTyp === 'ytd') {
      const d = ytdStichtag ? new Date(ytdStichtag).toLocaleDateString('de-CH') : '?';
      return `YTD bis ${d}`;
    }
    // benutzerdefiniert
    const vf = vonDatum ? new Date(vonDatum).toLocaleDateString('de-CH') : '?';
    const bf = bisDatum ? new Date(bisDatum).toLocaleDateString('de-CH') : '?';
    return `${vf} – ${bf}`;
  }, [zeitraumTyp, selectedMonth, selectedYear, startMonth, endMonth, ytdStichtag, vonDatum, bisDatum]);

  // ── Gefilterte Zeilen ──────────────────────────────────────────────────────

  const filteredRows = useMemo(() => {
    let rows = rawRows;

    // Datumsfilter
    rows = rows.filter(r => {
      if (!r.sale_date || r.sale_date.length < 10) return false;
      return r.sale_date >= dateFrom && r.sale_date <= dateTo;
    });

    // Debug-Logs
    console.log(`[DASHBOARD] zeitraumtyp: ${zeitraumTyp}`);
    console.log(`[DASHBOARD] datum von: ${dateFrom}`);
    console.log(`[DASHBOARD] datum bis: ${dateTo}`);
    console.log(`[DASHBOARD] rows after date filter: ${rows.length}`);

    // Kategorie-Filter
    if (selectedCategory !== 'Alle') {
      rows = rows.filter(r => {
        const nameKey = (r.product_name ?? '').trim().toLowerCase();
        const cat = categoryMap.get(nameKey) ?? '';
        return cat.toLowerCase() === selectedCategory.toLowerCase();
      });
    }

    // Quelle + Batch
    if (srcFilter !== 'all') {
      const matchNull = srcFilter === '__null__';
      rows = rows.filter(r => matchNull ? !r.source : r.source === srcFilter);
    }
    if (batchFilter !== 'all') {
      rows = rows.filter(r => r.import_batch === batchFilter);
    }
    return rows;
  }, [rawRows, dateFrom, dateTo, zeitraumTyp, selectedCategory, categoryMap, srcFilter, batchFilter]);

  // ── Aggregation ─────────────────────────────────────────────────────────────

  const { totalQty, totalRevenue, totalWes, totalProducts, bySource, topProducts } = useMemo(
    () => aggregate(filteredRows, 50, wesMap),
    [filteredRows, wesMap],
  );

  const totalRevenueB    = showNetRevenue ? grossToNet(totalRevenue) : totalRevenue;
  // Verkaufsbasierte WES-Quote — zentrale Funktion (verkaufsWesQuote), null statt 0 bei fehlender Basis
  const wesPercent       = verkaufsWesQuote(totalWes, totalRevenueB);
  const deckungsbeitrag  = totalRevenueB - totalWes;
  const hasWes           = totalWes > 0;

  const filteredTop = useMemo(() =>
    topProducts.filter(p =>
      p.product_name.toLowerCase().includes(topSearch.toLowerCase())
    ), [topProducts, topSearch]);

  // ── Totals für Top-Produkte-Tabelle ────────────────────────────────────────

  const topTotals = useMemo(() => {
    const qty     = filteredTop.reduce((s, p) => s + p.qty, 0);
    const revenue = filteredTop.reduce((s, p) => s + p.revenue, 0);
    const wes     = filteredTop.reduce((s, p) => s + p.wes, 0);
    const wesP    = verkaufsWesQuote(wes, revenue);
    return { qty, revenue, wes, wesP };
  }, [filteredTop]);

  // ── Produkte ohne WES (im aktuellen Filterkontext) ──────────────────────────

  const missingWesProducts = useMemo(() => {
    const prodMap = new Map<string, {
      product_name: string;
      category:     string;
      source:       string | null;
      qty:          number;
      revenue:      number;
    }>();
    for (const r of filteredRows) {
      const nameKey = (r.product_name ?? '').trim().toLowerCase();
      if ((wesMap.get(nameKey) ?? 0) > 0) continue; // hat WES → überspringen
      const pKey = r.product_name ?? '(unbekannt)';
      if (!prodMap.has(pKey)) {
        prodMap.set(pKey, {
          product_name: pKey,
          category:     categoryMap.get(nameKey) ?? '',
          source:       r.source ?? null,
          qty:          0,
          revenue:      0,
        });
      }
      const p = prodMap.get(pKey)!;
      p.qty     += Number(r.quantity ?? 0);
      p.revenue += Number(r.revenue  ?? 0);
    }
    return Array.from(prodMap.values()).sort((a, b) => b.revenue - a.revenue);
  }, [filteredRows, wesMap, categoryMap]);

  const missingWesRevenue         = missingWesProducts.reduce((s, p) => s + p.revenue, 0);
  const missingWesRevenueSharePct = totalRevenue > 0 ? (missingWesRevenue / totalRevenue) * 100 : 0;

  // ── Export-Funktionen ──────────────────────────────────────────────────────

  function buildExportRows() {
    const header = ['#', 'Produkt', 'Quelle', 'Absatz', 'Umsatz CHF', ...(hasWes ? ['WES CHF', 'WES %'] : [])];
    const data = filteredTop.map((p, i) => {
      const wesP = verkaufsWesQuote(p.wes, p.revenue);
      return [
        i + 1,
        p.product_name,
        sourceLabel(p.source),
        p.qty,
        p.revenue,
        ...(hasWes ? [p.wes, wesP ?? '–'] : []),
      ];
    });
    const total = [
      'Total',
      `${filteredTop.length} Produkte`,
      '–',
      topTotals.qty,
      topTotals.revenue,
      ...(hasWes ? [topTotals.wes, topTotals.wesP ?? '–'] : []),
    ];
    return { header, data, total };
  }

  function exportToExcel() {
    const { header, data, total } = buildExportRows();
    const ws = XLSX.utils.aoa_to_sheet([header, total, ...data]);

    // Spaltenbreiten
    ws['!cols'] = [
      { wch: 5 }, { wch: 40 }, { wch: 14 }, { wch: 12 },
      { wch: 16 }, ...(hasWes ? [{ wch: 16 }, { wch: 10 }] : []),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Top Produkte');
    XLSX.writeFile(wb, `VerkaufsDashboard_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function exportToPdf() {
    const { header, data, total } = buildExportRows();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFontSize(14);
    doc.text('Verkaufs-Dashboard – Top Produkte', 14, 16);
    doc.setFontSize(9);
    doc.text(`Exportiert am ${new Date().toLocaleDateString('de-CH')}`, 14, 22);

    // Zahlen-Columns formatieren
    const numCols = hasWes ? [3, 4, 5, 6] : [3, 4];
    const fmtCell = (val: unknown, colIdx: number) => {
      if (!numCols.includes(colIdx) || typeof val !== 'number') return String(val);
      if (colIdx === 3) return val.toLocaleString('de-CH');
      if (header[colIdx]?.includes('%')) return `${val.toFixed(1)} %`;
      return new Intl.NumberFormat('de-CH', {
        style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
      }).format(val);
    };

    const fmtRow = (row: unknown[]) => row.map((v, i) => fmtCell(v, i));

    autoTable(doc, {
      head: [header],
      body: [fmtRow(total), ...data.map(fmtRow)],
      startY: 27,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
      bodyStyles: { textColor: 40 },
      didParseCell(hookData) {
        // Total-Zeile fett
        if (hookData.row.index === 0) {
          hookData.cell.styles.fontStyle = 'bold';
          hookData.cell.styles.fillColor = [237, 233, 254];
        }
      },
      columnStyles: {
        0: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        ...(hasWes ? { 5: { halign: 'right' }, 6: { halign: 'right' } } : {}),
      },
    });

    doc.save(`VerkaufsDashboard_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  // ── Skeleton ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-7 w-48 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-violet-100 dark:bg-violet-950/40 p-2">
            <TrendingUp className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Verkaufs-Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Produktumsatz aus Importdaten
              {rawRows.length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground/70">
                  ({fmtNum(rawRows.length)} Datensätze)
                </span>
              )}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Aktualisieren
        </Button>
      </div>

      {/* ── DB-Fehler ─────────────────────────────────────────────────────────── */}
      {dbError && (
        <Card className="border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30">
          <CardContent className="py-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <div className="space-y-2 min-w-0">
                <p className="font-semibold text-red-700 dark:text-red-400">Datenbankfehler beim Laden</p>
                <p className="text-sm text-red-600 dark:text-red-300 font-mono break-all">{dbError}</p>
                <Button size="sm" variant="outline" onClick={load}>Nochmals versuchen</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Altbestand-Info ───────────────────────────────────────────────────── */}
      {altbestandCount > 0 && (
        <Card className="border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3">
              <Archive className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-sm text-amber-700 dark:text-amber-400 flex-1">
                <strong className="text-amber-800 dark:text-amber-300">Altbestand:</strong>{' '}
                {fmtNum(altbestandCount)} Datensätze ohne Quellangabe werden nicht berücksichtigt.
              </span>
              <Badge variant="outline" className="shrink-0 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400">
                {fmtNum(rawRows.length)} sauber / {fmtNum(rawRows.length + altbestandCount)} total
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Keine Daten ──────────────────────────────────────────────────────── */}
      {!dbError && filteredRows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">
              {rawRows.length > 0
                ? 'Keine Daten für die gewählten Filter'
                : 'Noch keine Verkaufsdaten vorhanden'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {rawRows.length > 0
                ? 'Filter zurücksetzen.'
                : 'Importiere Verkaufsdaten über «Verkaufsdaten Upload».'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── KPI-Karten ───────────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <div className={`grid gap-3 md:gap-4 ${hasWes ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-3'}`}>
          <KpiCard
            label={`Gesamtumsatz${showNetRevenue ? ' (Netto)' : ''}`}
            value={fmtChf(totalRevenueB)}
            icon={DollarSign}
            color="green"
            sub={showNetRevenue ? 'exkl. MWST' : 'inkl. MWST'}
          />
          <KpiCard
            label="Gesamtabsatz"
            value={fmtNum(totalQty)}
            icon={ShoppingCart}
          />
          <KpiCard
            label="Produkte (distinct)"
            value={fmtNum(totalProducts)}
            icon={Package}
            color="violet"
          />
          {hasWes && !showNetRevenue && (
            <div className="col-span-full flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              <span className="shrink-0 mt-0.5">⚠</span>
              <span>
                <span className="font-semibold">Kontrollansicht (Bruttoumsatz):</span> WES % und Deckungsbeitrag-Marge werden tiefer dargestellt, da der Umsatz inkl. MWST ist. WES-Kosten bleiben unverändert. Für Controlling-Vergleiche <span className="font-semibold">Netto</span> verwenden.
              </span>
            </div>
          )}
          {hasWes && (
            <>
              <KpiCard
                label="Gesamt WES CHF"
                value={fmtChf(totalWes)}
                icon={DollarSign}
                color="muted"
              />
              <KpiCard
                label="WES %"
                value={wesPercent !== null ? `${wesPercent.toFixed(1)} %` : '–'}
                icon={TrendingUp}
                sub={`von ${fmtChf(totalRevenueB)} Umsatz`}
                color={wesPercent !== null && wesPercent > 35 ? 'muted' : 'default'}
              />
              <KpiCard
                label="Deckungsbeitrag CHF"
                value={fmtChf(deckungsbeitrag)}
                icon={TrendingUp}
                sub={totalRevenueB > 0 ? `${((deckungsbeitrag / totalRevenueB) * 100).toFixed(1)} % Marge` : undefined}
                color={deckungsbeitrag >= 0 ? 'green' : 'muted'}
              />
            </>
          )}
        </div>
      )}

      {/* ── Zeitraum + Kategorie Filter ──────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <Card className="bg-muted/40 border-primary/20">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-3.5 w-3.5 text-primary/70 shrink-0" />

              {/* Zeitraumtyp */}
              <span className="text-xs font-medium text-muted-foreground">Zeitraum:</span>
              <Select value={zeitraumTyp} onValueChange={v => setZeitraumTyp(v as typeof zeitraumTyp)}>
                <SelectTrigger className="h-8 w-44 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monat">Monat</SelectItem>
                  <SelectItem value="mehrere">Mehrere Monate</SelectItem>
                  <SelectItem value="jahr">Jahr</SelectItem>
                  <SelectItem value="ytd">YTD</SelectItem>
                  <SelectItem value="benutzerdefiniert">Benutzerdefiniert</SelectItem>
                </SelectContent>
              </Select>

              {/* Monat */}
              {zeitraumTyp === 'monat' && (
                <>
                  <Select value={String(selectedMonth)} onValueChange={v => setSelectedMonth(Number(v))}>
                    <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
                    <SelectTrigger className="h-8 w-24 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(availableYears.length > 0 ? availableYears : [now.getFullYear()]).map(y => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}

              {/* Mehrere Monate */}
              {zeitraumTyp === 'mehrere' && (
                <>
                  <span className="text-xs text-muted-foreground">Von</span>
                  <Select value={String(startMonth)} onValueChange={v => setStartMonth(Number(v))}>
                    <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">bis</span>
                  <Select value={String(endMonth)} onValueChange={v => setEndMonth(Number(v))}>
                    <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
                    <SelectTrigger className="h-8 w-24 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(availableYears.length > 0 ? availableYears : [now.getFullYear()]).map(y => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}

              {/* Jahr */}
              {zeitraumTyp === 'jahr' && (
                <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
                  <SelectTrigger className="h-8 w-24 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(availableYears.length > 0 ? availableYears : [now.getFullYear()]).map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* YTD */}
              {zeitraumTyp === 'ytd' && (
                <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
                  <SelectTrigger className="h-8 w-24 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(availableYears.length > 0 ? availableYears : [now.getFullYear()]).map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Benutzerdefiniert */}
              {zeitraumTyp === 'benutzerdefiniert' && (
                <>
                  <span className="text-xs text-muted-foreground">Von</span>
                  <Input
                    type="date" value={vonDatum}
                    onChange={e => setVonDatum(e.target.value)}
                    className="h-8 w-36 text-sm px-2"
                  />
                  <span className="text-xs text-muted-foreground">bis</span>
                  <Input
                    type="date" value={bisDatum}
                    onChange={e => setBisDatum(e.target.value)}
                    className="h-8 w-36 text-sm px-2"
                  />
                </>
              )}

              {/* Kategorie */}
              <span className="text-xs font-medium text-muted-foreground">Kategorie:</span>
              <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Alle">Alle</SelectItem>
                  <SelectItem value="Food">Food</SelectItem>
                  <SelectItem value="Beverage">Beverage</SelectItem>
                </SelectContent>
              </Select>

              {/* Zeitraum-Zusammenfassung */}
              <span className="ml-auto text-xs font-medium text-primary/80 tabular-nums">
                Zeitraum: {zeitraumLabel}
                {selectedCategory !== 'Alle' && ` · ${selectedCategory}`}
                {' '}· {fmtNum(filteredRows.length)} Zeilen
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Filter-Leiste ────────────────────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">Quelle:</span>

              <Select value={srcFilter} onValueChange={setSrcFilter}>
                <SelectTrigger className="h-8 w-44 text-sm">
                  <SelectValue placeholder="Alle Quellen" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Quellen</SelectItem>
                  {availableSources.map(s => (
                    <SelectItem key={s} value={s}>
                      {sourceLabel(s === '__null__' ? null : s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-xs text-muted-foreground">Batch:</span>

              <Select value={batchFilter} onValueChange={setBatchFilter}>
                <SelectTrigger className="h-8 w-56 text-sm">
                  <SelectValue placeholder="Alle Batches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Batches</SelectItem>
                  {availableBatches.map(b => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {(srcFilter !== 'all' || batchFilter !== 'all') && (
                <Button
                  variant="ghost" size="sm"
                  onClick={() => { setSrcFilter('all'); setBatchFilter('all'); }}
                  className="h-8 text-xs text-muted-foreground"
                >
                  Zurücksetzen
                </Button>
              )}

              <span className="ml-auto text-xs text-muted-foreground">
                {fmtNum(filteredRows.length)} von {fmtNum(rawRows.length)} Zeilen
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Umsatz + Absatz nach Source ──────────────────────────────────────── */}
      {bySource.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Umsatz nach Quelle (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={bySource} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(v: number) => [fmtChf(v), 'Umsatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                    {bySource.map((s, i) => (
                      <Cell key={i} fill={srcColor(s.source)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Absatz nach Quelle (Stück)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={bySource} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number) => [fmtNum(v), 'Absatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="qty" radius={[4, 4, 0, 0]}>
                    {bySource.map((s, i) => (
                      <Cell key={i} fill={srcColor(s.source)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Tabelle: Umsatz nach Quelle ──────────────────────────────────────── */}
      {bySource.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Übersicht nach Quelle</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkte</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                  {hasWes && <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES CHF</th>}
                  {hasWes && <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES %</th>}
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Anteil</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {bySource.map(s => {
                  const share    = totalRevenueB > 0 ? (s.revenue / totalRevenueB) * 100 : 0;
                  const srcWesP  = verkaufsWesQuote(s.wes, s.revenue);
                  return (
                    <tr key={s.label} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: srcColor(s.source) }}
                          />
                          <span className="font-medium">{s.label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{s.products}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(s.qty)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(s.revenue)}</td>
                      {hasWes && <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{s.wes > 0 ? fmtChf(s.wes) : '–'}</td>}
                      {hasWes && (
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                          {srcWesP !== null ? `${srcWesP.toFixed(1)} %` : '–'}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                        {share.toFixed(1)} %
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ── Top Produkte nach Umsatz ──────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                Top Produkte nach Umsatz
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  placeholder="Produkt suchen…"
                  value={topSearch}
                  onChange={e => setTopSearch(e.target.value)}
                  className="h-8 w-44 text-sm"
                />
                <Button
                  size="sm" variant="outline"
                  className="h-8 text-xs gap-1.5"
                  onClick={exportToExcel}
                  disabled={filteredTop.length === 0}
                  title="Als Excel exportieren"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Excel
                </Button>
                <Button
                  size="sm" variant="outline"
                  className="h-8 text-xs gap-1.5"
                  onClick={exportToPdf}
                  disabled={filteredTop.length === 0}
                  title="Als PDF exportieren"
                >
                  <FileText className="h-3.5 w-3.5" />
                  PDF
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {filteredTop.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Keine Produkte gefunden
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">#</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkt</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                      {hasWes && <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES CHF</th>}
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES-Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {/* ── Totalzeile ── */}
                    {filteredTop.length > 0 && (
                      <tr className="bg-indigo-50/70 dark:bg-indigo-950/30 border-b-2 border-indigo-200 dark:border-indigo-800 font-semibold">
                        <td className="px-4 py-2.5 text-xs text-indigo-600 dark:text-indigo-400 font-bold">∑</td>
                        <td className="px-4 py-2.5 text-indigo-700 dark:text-indigo-300">
                          {filteredTop.length} Produkte
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs">–</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(topTotals.qty)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtChf(topTotals.revenue)}</td>
                        {hasWes && (
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {topTotals.wes > 0 ? fmtChf(topTotals.wes) : '–'}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-right">
                          {topTotals.wes > 0
                            ? <WesAmpel wesP={topTotals.wesP} />
                            : <span className="text-xs text-muted-foreground">–</span>
                          }
                        </td>
                      </tr>
                    )}
                    {filteredTop.map((p, i) => {
                      const pWesP = verkaufsWesQuote(p.wes, p.revenue);
                      return (
                        <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                          <td className="px-4 py-2 font-medium max-w-[220px] truncate">{p.product_name}</td>
                          <td className="px-4 py-2">
                            <Badge variant="outline" className="text-[10px] font-normal">
                              {sourceLabel(p.source)}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(p.qty)}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtChf(p.revenue)}</td>
                          {hasWes && (
                            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                              {p.wes > 0 ? fmtChf(p.wes) : '–'}
                            </td>
                          )}
                          <td className="px-4 py-2 text-right">
                            <WesAmpel wesP={pWesP} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Produkte ohne WES ─────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3 pt-4 px-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Produkte ohne WES
              </CardTitle>
              {missingWesProducts.length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 border border-amber-300 dark:border-amber-700 px-2.5 py-0.5 text-xs font-semibold">
                    {missingWesProducts.length} Produkte ohne WES
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtChf(missingWesRevenue)} · {missingWesRevenueSharePct.toFixed(1)} % des Gesamtumsatzes
                  </span>
                </div>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 border border-emerald-300 px-2.5 py-0.5 text-xs font-semibold">
                  ✓ Alle Produkte haben WES
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Verkaufte Produkte im gewählten Zeitraum ohne hinterlegten WES-Wert · reagiert auf alle aktiven Filter
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {missingWesProducts.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-3xl mb-2">✓</p>
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  Alle Produkte im gewählten Zeitraum haben einen WES-Wert
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">#</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkt</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategorie</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Anteil</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Aktion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {/* Totalzeile */}
                    <tr className="bg-amber-50/60 dark:bg-amber-950/20 border-b-2 border-amber-200 dark:border-amber-800 font-semibold">
                      <td className="px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400 font-bold">∑</td>
                      <td className="px-4 py-2.5 text-amber-700 dark:text-amber-300">{missingWesProducts.length} Produkte</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">–</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">–</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {fmtNum(missingWesProducts.reduce((s, p) => s + p.qty, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtChf(missingWesRevenue)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-xs font-semibold text-amber-700 dark:text-amber-400">
                        {missingWesRevenueSharePct.toFixed(1)} %
                      </td>
                      <td className="px-4 py-2.5" />
                    </tr>
                    {missingWesProducts.map((p, i) => {
                      const share = totalRevenue > 0 ? (p.revenue / totalRevenue) * 100 : 0;
                      return (
                        <tr key={p.product_name} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                          <td className="px-4 py-2 font-medium max-w-[220px] truncate" title={p.product_name}>
                            {p.product_name}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground text-xs">{p.category || '–'}</td>
                          <td className="px-4 py-2">
                            <Badge variant="outline" className="text-[10px] font-normal">
                              {sourceLabel(p.source)}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(p.qty)}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtChf(p.revenue)}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{share.toFixed(1)} %</td>
                          <td className="px-4 py-2 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/30"
                              onClick={() => {
                                setWesModal({ product_name: p.product_name, category: p.category, source: p.source });
                                setWesInputChf('');
                                setWesInputPct('');
                                setWesSaveError(null);
                              }}
                            >
                              WES erfassen
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── WES-Pflege Modal ────────────────────────────────────────────────────── */}
      <Dialog
        open={wesModal !== null}
        onOpenChange={(open) => {
          if (!open && !wesSaving) {
            setWesModal(null);
            setWesInputChf('');
            setWesInputPct('');
            setWesSaveError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              WES erfassen
            </DialogTitle>
          </DialogHeader>
          {wesModal && (
            <div className="space-y-4 py-2">
              {/* Produktinfo */}
              <div className="rounded-md bg-muted/50 px-4 py-3 space-y-1">
                <p className="text-sm font-semibold">{wesModal.product_name}</p>
                {wesModal.category && (
                  <p className="text-xs text-muted-foreground capitalize">{wesModal.category}</p>
                )}
              </div>

              {/* WES CHF */}
              <div className="space-y-1.5">
                <Label htmlFor="wes-chf" className="text-sm font-medium">
                  WES CHF / Stück <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="wes-chf"
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 3.50"
                  value={wesInputChf}
                  onChange={e => { setWesInputChf(e.target.value); setWesSaveError(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveWes(); }}
                  autoFocus
                  disabled={wesSaving}
                />
              </div>

              {/* WES % optional */}
              <div className="space-y-1.5">
                <Label htmlFor="wes-pct" className="text-sm font-medium text-muted-foreground">
                  WES % <span className="text-xs font-normal">(optional – wird berechnet wenn leer)</span>
                </Label>
                <Input
                  id="wes-pct"
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 28.5"
                  value={wesInputPct}
                  onChange={e => setWesInputPct(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveWes(); }}
                  disabled={wesSaving}
                />
              </div>

              {/* Fehlermeldung */}
              {wesSaveError && (
                <p className="text-xs text-destructive font-medium">{wesSaveError}</p>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setWesModal(null);
                setWesInputChf('');
                setWesInputPct('');
                setWesSaveError(null);
              }}
              disabled={wesSaving}
            >
              Abbrechen
            </Button>
            <Button
              size="sm"
              onClick={handleSaveWes}
              disabled={wesSaving || !wesInputChf.trim()}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {wesSaving ? 'Speichern…' : 'Speichern'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
