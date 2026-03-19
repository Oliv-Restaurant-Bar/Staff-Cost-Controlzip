import { useState, useRef, useMemo } from 'react';
import {
  Upload, Trash2, Package, TrendingUp, TrendingDown,
  Hash, RotateCcw, ChevronDown, X, Award,
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
  type ProdukteData,
  type RankedProduct,
} from '@/lib/produkte-store';
import { format, parse } from 'date-fns';
import { de } from 'date-fns/locale';

const formatCHF = (v: number) =>
  v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 2 });

const formatMonth = (ym: string) => {
  if (ym === 'alle') return 'Alle';
  if (ym === 'gesamt') return 'Gesamt';
  try {
    return format(parse(ym, 'yyyy-MM', new Date()), 'MMM yy', { locale: de });
  } catch { return ym; }
};

const formatMonthLong = (ym: string) => {
  if (ym === 'alle') return 'Alle Monate';
  if (ym === 'gesamt') return 'Gesamtperiode';
  try {
    return format(parse(ym, 'yyyy-MM', new Date()), 'MMMM yyyy', { locale: de });
  } catch { return ym; }
};

type ChartMode = 'top' | 'flop';

const TOP_OPTIONS  = [10, 20, 50, 100];
const FLOP_OPTIONS = [10, 20, 50];

export default function ProdukteSeite() {
  const [data, setData]              = useState<ProdukteData | null>(() => loadProdukteData());
  const [ignoredByUser, setIgnored]  = useState<string[]>(() => loadIgnoredProducts());
  const [sortBy, setSortBy]          = useState<'count' | 'revenue'>('count');
  const [mode, setMode]              = useState<ChartMode>('top');
  const [topN, setTopN]              = useState(20);
  const [flopN, setFlopN]            = useState(10);
  const [selectedMonth, setMonth]    = useState<string>('alle');
  const [importing, setImporting]    = useState<'anzahl' | 'umsatz' | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  const anzahlRef = useRef<HTMLInputElement>(null);
  const umsatzRef = useRef<HTMLInputElement>(null);

  const months = useMemo(
    () => ['alle', ...getAvailableMonths(data?.entries ?? [])],
    [data],
  );

  const limit = mode === 'top' ? topN : flopN;

  const ranked: RankedProduct[] = useMemo(() => {
    const entries = data?.entries ?? [];
    return mode === 'top'
      ? getTopProducts(entries, selectedMonth, sortBy, limit, ignoredByUser)
      : getFlopProducts(entries, selectedMonth, sortBy, limit, ignoredByUser);
  }, [data, selectedMonth, sortBy, mode, limit, ignoredByUser]);

  // ── Import Handler ───────────────────────────────────────────────────────────
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>, type: 'anzahl' | 'umsatz') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(type);
    try {
      const parsed = await parseProdukteExcel(file, type);
      if (parsed.length === 0) {
        toast.error('Keine Produktdaten gefunden', {
          description: 'Bitte prüfe das Dateiformat (Gastronovi Rezept-Export)',
        });
        return;
      }
      const existing = data?.entries ?? [];
      const merged   = mergeProdukteData(existing, parsed, type);
      const newData: ProdukteData = {
        entries: merged,
        importedAt: new Date().toISOString(),
        source: 'combined',
      };
      saveProdukteData(newData);
      setData(newData);

      const newMonths = getAvailableMonths(merged);
      if (newMonths.length > 0 && selectedMonth === 'alle') {
        setMonth(newMonths[newMonths.length - 1]);
      }

      toast.success(`${type === 'anzahl' ? 'Anzahl' : 'Umsatz'}-Daten importiert`, {
        description: `${parsed.length} Produkt-Einträge aus ${file.name}`,
      });
    } catch (err) {
      toast.error('Import fehlgeschlagen', { description: String(err) });
    } finally {
      setImporting(null);
      e.target.value = '';
    }
  };

  const ignoreProduct = (name: string) => {
    const updated = [...ignoredByUser, name];
    setIgnored(updated);
    saveIgnoredProducts(updated);
    toast.info(`«${name}» aus Rangliste entfernt`);
  };

  const restoreProduct = (name: string) => {
    const updated = ignoredByUser.filter(n => n !== name);
    setIgnored(updated);
    saveIgnoredProducts(updated);
    toast.success(`«${name}» wieder in Rangliste`);
  };

  const clearAllData = () => {
    localStorage.removeItem('produkte_data_v2');
    localStorage.removeItem('produkte_ignored_v1');
    setData(null);
    setIgnored([]);
    toast.info('Alle Produktdaten gelöscht');
  };

  // ── Rang-Symbol ──────────────────────────────────────────────────────────────
  const RankBadge = ({ rank }: { rank: number }) => {
    if (mode === 'top') {
      if (rank === 1) return <span className="text-lg leading-none">🥇</span>;
      if (rank === 2) return <span className="text-lg leading-none">🥈</span>;
      if (rank === 3) return <span className="text-lg leading-none">🥉</span>;
    } else {
      if (rank === 1) return <span className="text-lg leading-none">💀</span>;
      if (rank === 2) return <span className="text-lg leading-none">😬</span>;
      if (rank === 3) return <span className="text-lg leading-none">😕</span>;
    }
    return (
      <span className="text-xs font-bold tabular-nums w-6 text-center inline-block text-muted-foreground">
        {rank}
      </span>
    );
  };

  const maxVal = ranked.length > 0
    ? Math.max(...ranked.map(r => sortBy === 'count' ? r.count : r.revenue))
    : 1;

  const isFlop = mode === 'flop';
  const nOptions = isFlop ? FLOP_OPTIONS : TOP_OPTIONS;
  const currentN = isFlop ? flopN : topN;
  const setN = isFlop ? setFlopN : setTopN;

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 space-y-2">

          {/* Zeile 1: Titel + Import-Buttons */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">Produkte</h1>
                <p className="text-xs text-muted-foreground">Ranglisten nach Anzahl & Umsatz</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <input ref={anzahlRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={e => handleImport(e, 'anzahl')} />
              <input ref={umsatzRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={e => handleImport(e, 'umsatz')} />

              <Button variant="outline" size="sm" className="h-8"
                onClick={() => anzahlRef.current?.click()} disabled={importing !== null}>
                {importing === 'anzahl'
                  ? <span className="h-3 w-3 mr-1.5 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" />
                  : <Upload className="h-3 w-3 mr-1.5" />}
                <Hash className="h-3 w-3 mr-1" /> Anzahl
              </Button>

              <Button variant="outline" size="sm" className="h-8"
                onClick={() => umsatzRef.current?.click()} disabled={importing !== null}>
                {importing === 'umsatz'
                  ? <span className="h-3 w-3 mr-1.5 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" />
                  : <Upload className="h-3 w-3 mr-1.5" />}
                <TrendingUp className="h-3 w-3 mr-1" /> Umsatz
              </Button>

              {data && (
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive"
                  onClick={clearAllData}>
                  <RotateCcw className="h-3 w-3 mr-1.5" /> Reset
                </Button>
              )}
            </div>
          </div>

          {/* Zeile 2: Filter-Controls (nur wenn Daten vorhanden) */}
          {data && (
            <div className="border-t border-border/60 pt-2 space-y-2">

              {/* Monat-Pills */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs text-muted-foreground font-medium mr-1 shrink-0">Monat:</span>
                {months.map(m => (
                  <button
                    key={m}
                    onClick={() => setMonth(m)}
                    className={cn(
                      'px-2.5 py-0.5 rounded-full text-xs font-medium border transition-all',
                      selectedMonth === m
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground',
                    )}
                  >
                    {formatMonth(m)}
                  </button>
                ))}
              </div>

              {/* Zweite Zeile: Top/Flop + N + Sortierung */}
              <div className="flex items-center gap-2 flex-wrap">

                {/* Top / Flop Umschalter */}
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                  <button
                    onClick={() => setMode('top')}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                      mode === 'top'
                        ? 'bg-emerald-500 text-white shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <TrendingUp className="h-3 w-3" /> Top
                  </button>
                  <button
                    onClick={() => setMode('flop')}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                      mode === 'flop'
                        ? 'bg-red-500 text-white shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <TrendingDown className="h-3 w-3" /> Flop
                  </button>
                </div>

                {/* N-Auswahl */}
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                  {nOptions.map(n => (
                    <button
                      key={n}
                      onClick={() => setN(n)}
                      className={cn(
                        'px-2 py-1 text-xs font-medium rounded-md transition-all',
                        currentN === n
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {isFlop ? 'Flop' : 'Top'} {n}
                    </button>
                  ))}
                </div>

                {/* Sortierung */}
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5 ml-auto">
                  <button
                    onClick={() => setSortBy('count')}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                      sortBy === 'count'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Hash className="h-3 w-3" /> Nach Anzahl
                  </button>
                  <button
                    onClick={() => setSortBy('revenue')}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                      sortBy === 'revenue'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <TrendingUp className="h-3 w-3" /> Nach Umsatz
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 pb-24 space-y-4">

        {/* ── Kein Daten-State ────────────────────────────────────────────────── */}
        {!data && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="rounded-full bg-muted p-5">
              <Package className="h-10 w-10 text-muted-foreground" />
            </div>
            <div>
              <p className="text-base font-semibold">Noch keine Produktdaten importiert</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Importiere die Gastronovi-Exporte «Anzahl Rezepte» und «Umsatz Rezepte»
                über die Schaltflächen oben rechts.
              </p>
            </div>
            <div className="flex gap-3 mt-2">
              <Button onClick={() => anzahlRef.current?.click()} variant="outline">
                <Hash className="h-4 w-4 mr-2" /> Anzahl Rezepte
              </Button>
              <Button onClick={() => umsatzRef.current?.click()} variant="outline">
                <TrendingUp className="h-4 w-4 mr-2" /> Umsatz Rezepte
              </Button>
            </div>
          </div>
        )}

        {/* ── Rangliste ───────────────────────────────────────────────────────── */}
        {data && (
          <>
            {/* Titel */}
            <div className="flex items-center gap-2 flex-wrap">
              {isFlop
                ? <TrendingDown className="h-4 w-4 text-red-500" />
                : <Award className="h-4 w-4 text-primary" />}
              <span className="text-sm font-semibold">
                {isFlop ? 'Flop' : 'Top'} {Math.min(currentN, ranked.length)} Produkte
              </span>
              <span className="text-xs text-muted-foreground">
                · {formatMonthLong(selectedMonth)}
                · {sortBy === 'count' ? 'Nach Anzahl' : 'Nach Umsatz'}
              </span>
              {isFlop && (
                <Badge variant="outline" className="text-xs text-red-600 border-red-300 bg-red-50 dark:bg-red-950/20">
                  Schlechteste Produkte
                </Badge>
              )}
            </div>

            {ranked.length === 0 && (
              <div className="flex items-center justify-center py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  Keine Daten für diesen Zeitraum. Importiere zuerst die entsprechenden Dateien.
                </p>
              </div>
            )}

            {/* Tabelle */}
            {ranked.length > 0 && (
              <div className={cn(
                'rounded-xl border overflow-hidden',
                isFlop ? 'border-red-200 dark:border-red-900' : 'border-border',
              )}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn(
                      'border-b',
                      isFlop
                        ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20'
                        : 'border-border bg-muted/40',
                    )}>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-24">Anzahl</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-28">Umsatz</th>
                      <th className="px-2 py-2.5 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map(r => {
                      const val      = sortBy === 'count' ? r.count : r.revenue;
                      const barWidth = maxVal > 0 ? (val / maxVal) * 100 : 0;
                      const barColor = isFlop
                        ? 'bg-red-400 dark:bg-red-600'
                        : sortBy === 'count' ? 'bg-blue-500' : 'bg-emerald-500';
                      const valueColor = isFlop
                        ? 'text-red-600 dark:text-red-400'
                        : sortBy === 'count'
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-emerald-600 dark:text-emerald-400';

                      return (
                        <tr key={r.name}
                          className={cn(
                            'border-b last:border-0 transition-colors group',
                            isFlop
                              ? 'border-red-100 dark:border-red-900/40 hover:bg-red-50/40 dark:hover:bg-red-950/10'
                              : 'border-border/50 hover:bg-muted/30',
                          )}
                        >
                          <td className="px-3 py-2.5 text-center">
                            <RankBadge rank={r.rank} />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="space-y-1">
                              <span className={cn(
                                'font-medium',
                                isFlop
                                  ? r.rank <= 3 ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                                  : r.rank <= 3 ? (['text-yellow-500', 'text-slate-400', 'text-amber-600'] as const)[r.rank - 1] : 'text-foreground',
                              )}>
                                {r.name}
                              </span>
                              <div className="h-1.5 rounded-full bg-muted overflow-hidden max-w-xs">
                                <div
                                  className={cn('h-full rounded-full transition-all', barColor)}
                                  style={{ width: `${barWidth}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {r.count > 0
                              ? <span className={cn('font-medium', sortBy === 'count' ? valueColor : '')}>
                                  {r.count.toLocaleString('de-CH')}×
                                </span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {r.revenue > 0
                              ? <span className={cn('font-medium', sortBy === 'revenue' ? valueColor : '')}>
                                  {formatCHF(r.revenue)}
                                </span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                          <td className="px-2 py-2.5">
                            <button
                              onClick={() => ignoreProduct(r.name)}
                              title="Aus Rangliste entfernen"
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                            >
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

            {/* ── Entfernte Produkte ─────────────────────────────────────────── */}
            {ignoredByUser.length > 0 && (
              <div className="space-y-2">
                <button
                  onClick={() => setShowIgnored(s => !s)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showIgnored ? 'rotate-180' : '')} />
                  {ignoredByUser.length} manuell entfernte Produkte
                </button>
                {showIgnored && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground mb-2">
                      Diese Produkte wurden manuell entfernt. «Wiederherstellen» nimmt sie zurück in die Rangliste.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {ignoredByUser.map(name => (
                        <div key={name}
                          className="flex items-center gap-1.5 bg-background border border-border rounded-full px-3 py-1 text-xs"
                        >
                          <span className="text-muted-foreground line-through">{name}</span>
                          <button
                            onClick={() => restoreProduct(name)}
                            className="text-primary hover:text-primary/80 font-medium"
                          >
                            ↺ Wiederherstellen
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Ignorier-Liste ─────────────────────────────────────────────── */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Automatisch ignorierte Begriffe ({DEFAULT_IGNORE_TERMS.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_IGNORE_TERMS.map(t => (
                  <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Info-Footer */}
            <div className="text-[10px] text-muted-foreground text-right">
              {data.importedAt && (
                <>Zuletzt importiert: {format(new Date(data.importedAt), 'dd.MM.yyyy HH:mm', { locale: de })} · </>
              )}
              {data.entries.length} Einträge gespeichert
            </div>
          </>
        )}
      </main>
    </div>
  );
}
