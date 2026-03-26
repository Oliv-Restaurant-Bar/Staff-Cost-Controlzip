/**
 * ProduktAnalyse – BCG Matrix Produktübersicht
 * ==============================================
 * Datenquelle: product_matrix View
 * Filter: Kategorie, Matrix-Kategorie, Produktname
 */

import { useState, useEffect, useMemo } from 'react';
import { Search, Star, DollarSign, HelpCircle, TrendingDown, RefreshCw, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { fetchProductMatrix, type ProductMatrixRow } from '@/lib/sales-db';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtChf(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '–';
  return `${Number(v).toFixed(1)} %`;
}

// ─── Matrix-Konfiguration ─────────────────────────────────────────────────────

interface MatrixConfig {
  label: string;
  icon: React.FC<{ className?: string }>;
  cls: string;           // Badge-Klassen
  rowCls: string;        // Zeilen-Highlight
  description: string;
}

const MATRIX_CONFIG: Record<string, MatrixConfig> = {
  star: {
    label: 'Star',
    icon: Star,
    cls: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
    rowCls: 'bg-green-50/30 dark:bg-green-950/10',
    description: 'Hoher Umsatz, niedriger WES – Bestseller mit guten Margen',
  },
  cash_cow: {
    label: 'Cash Cow',
    icon: DollarSign,
    cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800',
    rowCls: 'bg-amber-50/30 dark:bg-amber-950/10',
    description: 'Stabiler Umsatz, mittlerer WES – zuverlässige Performer',
  },
  puzzle: {
    label: 'Puzzle',
    icon: HelpCircle,
    cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800',
    rowCls: 'bg-blue-50/30 dark:bg-blue-950/10',
    description: 'Hoher WES, tiefe Menge – Potenzial vorhanden, aber Optimierungsbedarf',
  },
  dog: {
    label: 'Dog',
    icon: TrendingDown,
    cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
    rowCls: 'bg-red-50/30 dark:bg-red-950/10',
    description: 'Tiefer Umsatz, hoher WES – Überprüfen oder aus Karte streichen',
  },
};

// ─── Legende ─────────────────────────────────────────────────────────────────

function MatrixLegend() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {Object.entries(MATRIX_CONFIG).map(([key, cfg]) => {
        const Icon = cfg.icon;
        return (
          <div key={key} className={`rounded-lg border p-3 ${cfg.rowCls}`}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className="h-3.5 w-3.5" />
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${cfg.cls}`}>
                {cfg.label}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-tight">{cfg.description}</p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Zusammenfassungs-Karten ──────────────────────────────────────────────────

function SummaryBar({ rows }: { rows: ProductMatrixRow[] }) {
  const totalRevenue = rows.reduce((s, r) => s + (r.total_revenue ?? 0), 0);
  const totalQty     = rows.reduce((s, r) => s + (r.total_qty ?? 0), 0);

  return (
    <div className="grid grid-cols-3 gap-3">
      <Card>
        <CardContent className="py-3 px-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Gefilterte Produkte</p>
          <p className="text-2xl font-bold tabular-nums">{rows.length}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3 px-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Gesamtumsatz</p>
          <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtChf(totalRevenue)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3 px-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Gesamtabsatz</p>
          <p className="text-2xl font-bold tabular-nums">{fmtNum(totalQty)}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function ProduktAnalyse() {
  const [loading, setLoading]       = useState(true);
  const [rows, setRows]             = useState<ProductMatrixRow[]>([]);
  const [search, setSearch]         = useState('');
  const [catFilter, setCatFilter]   = useState('all');
  const [matFilter, setMatFilter]   = useState('all');
  const [sortCol, setSortCol]       = useState<keyof ProductMatrixRow>('total_revenue');
  const [sortAsc, setSortAsc]       = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await fetchProductMatrix();
    setRows(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Einzigartige Kategorien für Filter
  const categories = useMemo(() =>
    [...new Set(rows.map(r => r.category).filter(Boolean))].sort(),
    [rows]);

  const matrixCategories = useMemo(() =>
    [...new Set(rows.map(r => r.matrix_category).filter(Boolean))].sort(),
    [rows]);

  // Gefilterte + sortierte Zeilen
  const filtered = useMemo(() => {
    let r = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(row => row.name?.toLowerCase().includes(q) || row.category?.toLowerCase().includes(q));
    }
    if (catFilter !== 'all') r = r.filter(row => row.category === catFilter);
    if (matFilter !== 'all') r = r.filter(row => row.matrix_category === matFilter);

    return [...r].sort((a, b) => {
      const av = (a[sortCol] ?? 0) as number;
      const bv = (b[sortCol] ?? 0) as number;
      if (typeof av === 'string') return sortAsc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
      return sortAsc ? av - bv : bv - av;
    });
  }, [rows, search, catFilter, matFilter, sortCol, sortAsc]);

  function toggleSort(col: keyof ProductMatrixRow) {
    if (sortCol === col) setSortAsc(p => !p);
    else { setSortCol(col); setSortAsc(false); }
  }

  function SortHeader({ col, label, right = true }: {
    col: keyof ProductMatrixRow; label: string; right?: boolean;
  }) {
    const active = sortCol === col;
    return (
      <th
        className={`px-4 py-2.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors ${right ? 'text-right' : 'text-left'}`}
        onClick={() => toggleSort(col)}
      >
        {label} {active ? (sortAsc ? '↑' : '↓') : ''}
      </th>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-7xl mx-auto">
        <div className="h-8 w-48 rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
        <div className="h-96 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-blue-100 dark:bg-blue-950/40 p-2">
            <Layers className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Produktanalyse</h1>
            <p className="text-sm text-muted-foreground">BCG Matrix – Umsatz, WES & Produktstrategie</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Aktualisieren
        </Button>
      </div>

      {/* Legende */}
      <MatrixLegend />

      {/* Zusammenfassung */}
      <SummaryBar rows={filtered} />

      {/* Filter */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Produkt suchen..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 pl-8 w-48 text-sm"
          />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="h-8 w-40 text-sm">
            <SelectValue placeholder="Kategorie" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Kategorien</SelectItem>
            {categories.map(c => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={matFilter} onValueChange={setMatFilter}>
          <SelectTrigger className="h-8 w-40 text-sm">
            <SelectValue placeholder="Matrix" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Matrix-Typen</SelectItem>
            {matrixCategories.map(m => (
              <SelectItem key={m} value={m}>
                {MATRIX_CONFIG[m.toLowerCase()]?.label ?? m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || catFilter !== 'all' || matFilter !== 'all') && (
          <Button
            variant="ghost" size="sm"
            onClick={() => { setSearch(''); setCatFilter('all'); setMatFilter('all'); }}
            className="h-8 text-xs text-muted-foreground"
          >
            Filter zurücksetzen
          </Button>
        )}
      </div>

      {/* Tabelle */}
      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'Noch keine Produktdaten vorhanden' : 'Keine Produkte entsprechen den Filterkriterien'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <SortHeader col="name"             label="Produkt"   right={false} />
                    <SortHeader col="category"         label="Kategorie" right={false} />
                    <SortHeader col="total_qty"        label="Absatz"                  />
                    <SortHeader col="total_revenue"    label="Umsatz CHF"              />
                    <SortHeader col="wes_percent_fixed" label="WES %"                  />
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Matrix</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filtered.map((row, i) => {
                    const mc = row.matrix_category?.toLowerCase() ?? 'dog';
                    const cfg = MATRIX_CONFIG[mc] ?? MATRIX_CONFIG.dog;
                    return (
                      <tr key={`${row.name}-${i}`} className={`hover:bg-muted/30 transition-colors ${cfg.rowCls}`}>
                        <td className="px-4 py-2.5 font-medium">{row.name || '–'}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant="outline" className="text-[10px] font-normal">{row.category || '–'}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {fmtNum(row.total_qty)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                          {fmtChf(row.total_revenue)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          <span className={
                            !row.wes_percent_fixed ? 'text-muted-foreground'
                            : row.wes_percent_fixed <= 25 ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : row.wes_percent_fixed <= 30 ? 'text-amber-600 dark:text-amber-400 font-semibold'
                            : 'text-red-600 dark:text-red-400 font-semibold'
                          }>
                            {fmtPct(row.wes_percent_fixed)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${cfg.cls}`}>
                            {cfg.label}
                          </span>
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

    </div>
  );
}
