import { useState, useRef, useMemo } from 'react';
import {
  Upload, Trash2, Package, TrendingUp, TrendingDown,
  Hash, RotateCcw, ChevronDown, X, Award, ChevronRight, ArrowLeft,
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

const TOP_OPTIONS  = [10, 20, 50, 100];
const FLOP_OPTIONS = [10, 20, 50];
const PM_OPTIONS   = [3, 5, 10];

// ── Kompakte Monatskarte (Übersicht) ────────────────────────────────────────
function MonthCard({
  month, entries, ignoredByUser, sortBy, mode, n, onSelect, onIgnore,
}: {
  month: string;
  entries: Parameters<typeof getTopProducts>[0];
  ignoredByUser: string[];
  sortBy: 'count' | 'revenue';
  mode: ChartMode;
  n: number;
  onSelect: () => void;
  onIgnore: (name: string) => void;
}) {
  const ranked = useMemo(
    () => mode === 'top'
      ? getTopProducts(entries, month, sortBy, n, ignoredByUser)
      : getFlopProducts(entries, month, sortBy, n, ignoredByUser),
    [entries, month, sortBy, mode, n, ignoredByUser],
  );

  const maxVal = ranked.length > 0
    ? Math.max(...ranked.map(r => sortBy === 'count' ? r.count : r.revenue))
    : 1;

  const isFlop = mode === 'flop';

  return (
    <div
      className={cn(
        'rounded-xl border bg-card overflow-hidden cursor-pointer group transition-all hover:shadow-md hover:-translate-y-0.5',
        isFlop ? 'border-red-200 dark:border-red-900 hover:border-red-400' : 'border-border hover:border-primary/50',
      )}
      onClick={onSelect}
    >
      {/* Karten-Header */}
      <div className={cn(
        'px-3 py-2.5 border-b flex items-center justify-between',
        isFlop
          ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20'
          : 'border-border bg-muted/40',
      )}>
        <span className="text-sm font-bold">{formatMonthLong(month)}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">
            {isFlop ? 'Flop' : 'Top'} {Math.min(n, ranked.length)}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        </div>
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
                  <span className={cn(
                    'text-xs tabular-nums shrink-0',
                    isFlop ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                  )}>
                    {sortBy === 'count'
                      ? `${r.count.toLocaleString('de-CH')}×`
                      : formatCHF(r.revenue)}
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

      <div className={cn(
        'px-3 py-2 border-t text-center text-[10px] font-medium transition-colors',
        isFlop
          ? 'border-red-100 dark:border-red-900/40 text-red-400 group-hover:text-red-600'
          : 'border-border/40 text-muted-foreground group-hover:text-primary',
      )}>
        Vollständige Rangliste anzeigen →
      </div>
    </div>
  );
}

// ── Haupt-Komponente ─────────────────────────────────────────────────────────
export default function ProdukteSeite() {
  const [data, setData]               = useState<ProdukteData | null>(() => loadProdukteData());
  const [ignoredByUser, setIgnored]   = useState<string[]>(() => loadIgnoredProducts());
  const [sortBy, setSortBy]           = useState<'count' | 'revenue'>('count');
  const [mode, setMode]               = useState<ChartMode>('top');
  const [topN, setTopN]               = useState(20);
  const [flopN, setFlopN]             = useState(10);
  const [pmN, setPmN]                 = useState(5);
  const [detailMonth, setDetailMonth] = useState<string | null>(null); // null = Übersicht
  const [importing, setImporting]     = useState<'anzahl' | 'umsatz' | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  const anzahlRef = useRef<HTMLInputElement>(null);
  const umsatzRef = useRef<HTMLInputElement>(null);

  const monthsOnly = useMemo(
    () => getAvailableMonths(data?.entries ?? []),
    [data],
  );

  const isFlop   = mode === 'flop';
  const limit    = isFlop ? flopN : topN;
  const nOptions = isFlop ? FLOP_OPTIONS : TOP_OPTIONS;
  const currentN = limit;
  const setN     = isFlop ? setFlopN : setTopN;

  // Detail-Rangliste (wenn ein Monat ausgewählt)
  const detailRanked: RankedProduct[] = useMemo(() => {
    if (!detailMonth) return [];
    const entries = data?.entries ?? [];
    return isFlop
      ? getFlopProducts(entries, detailMonth, sortBy, limit, ignoredByUser)
      : getTopProducts(entries, detailMonth, sortBy, limit, ignoredByUser);
  }, [data, detailMonth, sortBy, mode, limit, ignoredByUser]);

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
      const merged  = mergeProdukteData(data?.entries ?? [], parsed, type);
      const newData: ProdukteData = {
        entries: merged, importedAt: new Date().toISOString(), source: 'combined',
      };
      saveProdukteData(newData);
      setData(newData);
      toast.success(`${type === 'anzahl' ? 'Anzahl' : 'Umsatz'}-Daten importiert`, {
        description: `${parsed.length} Einträge aus ${file.name}`,
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
    setDetailMonth(null);
    toast.info('Alle Produktdaten gelöscht');
  };

  const maxDetailVal = detailRanked.length > 0
    ? Math.max(...detailRanked.map(r => sortBy === 'count' ? r.count : r.revenue))
    : 1;

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">

            {/* Titel / Breadcrumb */}
            <div className="flex items-center gap-2">
              {detailMonth && (
                <button
                  onClick={() => setDetailMonth(null)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Alle Monate
                </button>
              )}
              <Package className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">
                  {detailMonth ? formatMonthLong(detailMonth) : 'Produkte'}
                </h1>
                <p className="text-xs text-muted-foreground">
                  {detailMonth ? 'Vollständige Rangliste' : 'Monatsübersicht – Monat anklicken für Details'}
                </p>
              </div>
            </div>

            {/* Rechts: Filter + Import */}
            <div className="flex items-center gap-2 flex-wrap">

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

              {/* N-Auswahl */}
              {detailMonth ? (
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                  {nOptions.map(n => (
                    <button key={n} onClick={() => setN(n)}
                      className={cn('px-2 py-1 text-xs font-medium rounded-md transition-all',
                        currentN === n ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      {n}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                  {PM_OPTIONS.map(n => (
                    <button key={n} onClick={() => setPmN(n)}
                      className={cn('px-2 py-1 text-xs font-medium rounded-md transition-all',
                        pmN === n ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      {n}
                    </button>
                  ))}
                </div>
              )}

              {/* Sortierung */}
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                <button onClick={() => setSortBy('count')}
                  className={cn('flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                    sortBy === 'count' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <Hash className="h-3 w-3" /> Anzahl
                </button>
                <button onClick={() => setSortBy('revenue')}
                  className={cn('flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-all',
                    sortBy === 'revenue' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  <TrendingUp className="h-3 w-3" /> Umsatz
                </button>
              </div>

              {/* Import */}
              <input ref={anzahlRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => handleImport(e, 'anzahl')} />
              <input ref={umsatzRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => handleImport(e, 'umsatz')} />
              <Button variant="outline" size="sm" className="h-8"
                onClick={() => anzahlRef.current?.click()} disabled={importing !== null}>
                {importing === 'anzahl'
                  ? <span className="h-3 w-3 mr-1 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" />
                  : <Upload className="h-3 w-3 mr-1" />}
                <Hash className="h-3 w-3" />
              </Button>
              <Button variant="outline" size="sm" className="h-8"
                onClick={() => umsatzRef.current?.click()} disabled={importing !== null}>
                {importing === 'umsatz'
                  ? <span className="h-3 w-3 mr-1 animate-spin border-2 border-current border-t-transparent rounded-full inline-block" />
                  : <Upload className="h-3 w-3 mr-1" />}
                <TrendingUp className="h-3 w-3" />
              </Button>
              {data && (
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" onClick={clearAllData}>
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 pb-24 space-y-4">

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

        {/* ══ ÜBERSICHT: Alle Monate als Karten ═══════════════════════════════ */}
        {data && !detailMonth && (
          <>
            {monthsOnly.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-muted-foreground">Keine Monatsdaten vorhanden. Importiere zuerst Daten.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {[...monthsOnly].reverse().map(m => (
                  <MonthCard
                    key={m}
                    month={m}
                    entries={data.entries}
                    ignoredByUser={ignoredByUser}
                    sortBy={sortBy}
                    mode={mode}
                    n={pmN}
                    onSelect={() => setDetailMonth(m)}
                    onIgnore={ignoreProduct}
                  />
                ))}
              </div>
            )}

            {/* Ignorier-Liste */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-1.5 mt-4">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Automatisch ignorierte Begriffe ({DEFAULT_IGNORE_TERMS.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_IGNORE_TERMS.map(t => (
                  <Badge key={t} variant="outline" className="text-[10px] py-0 px-1.5 text-muted-foreground">{t}</Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ══ DETAIL: Vollständige Rangliste für gewählten Monat ══════════════ */}
        {data && detailMonth && (
          <>
            {/* Monats-Tabs (Schnellwechsel) */}
            <div className="flex flex-wrap gap-2">
              {[...monthsOnly].reverse().map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDetailMonth(m)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                    detailMonth === m
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                      : 'bg-card text-foreground border-border hover:bg-muted',
                  )}
                >
                  {formatMonthShort(m)}
                </button>
              ))}
            </div>

            {/* Titel */}
            <div className="flex items-center gap-2 flex-wrap">
              {isFlop
                ? <TrendingDown className="h-4 w-4 text-red-500" />
                : <Award className="h-4 w-4 text-primary" />}
              <span className="text-sm font-semibold">
                {isFlop ? 'Flop' : 'Top'} {Math.min(currentN, detailRanked.length)} Produkte
              </span>
              <span className="text-xs text-muted-foreground">
                · {sortBy === 'count' ? 'Nach Anzahl' : 'Nach Umsatz'}
              </span>
              {isFlop && (
                <Badge variant="outline" className="text-xs text-red-600 border-red-300 bg-red-50 dark:bg-red-950/20">
                  Schlechteste Produkte
                </Badge>
              )}
            </div>

            {detailRanked.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Keine Daten für diesen Monat.</p>
              </div>
            )}

            {detailRanked.length > 0 && (
              <div className={cn('rounded-xl border overflow-hidden',
                isFlop ? 'border-red-200 dark:border-red-900' : 'border-border')}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={cn('border-b',
                      isFlop
                        ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20'
                        : 'border-border bg-muted/40')}>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-24">Anzahl</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground w-28">Umsatz</th>
                      <th className="px-2 py-2.5 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {detailRanked.map(r => {
                      const val      = sortBy === 'count' ? r.count : r.revenue;
                      const barWidth = maxDetailVal > 0 ? (val / maxDetailVal) * 100 : 0;
                      const barColor = isFlop
                        ? 'bg-red-400 dark:bg-red-600'
                        : sortBy === 'count' ? 'bg-blue-500' : 'bg-emerald-500';
                      const valueColor = isFlop
                        ? 'text-red-600 dark:text-red-400'
                        : sortBy === 'count' ? 'text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400';

                      return (
                        <tr key={r.name}
                          className={cn('border-b last:border-0 transition-colors group',
                            isFlop
                              ? 'border-red-100 dark:border-red-900/40 hover:bg-red-50/40 dark:hover:bg-red-950/10'
                              : 'border-border/50 hover:bg-muted/30')}>
                          <td className="px-3 py-2.5 text-center">
                            <span className="text-xs font-medium tabular-nums text-muted-foreground">{r.rank}</span>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="space-y-1">
                              <span className="font-medium">{r.name}</span>
                              <div className="h-1.5 rounded-full bg-muted overflow-hidden max-w-xs">
                                <div className={cn('h-full rounded-full transition-all', barColor)}
                                  style={{ width: `${barWidth}%` }} />
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

            {/* Entfernte Produkte */}
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
                    <div className="flex flex-wrap gap-2">
                      {ignoredByUser.map(name => (
                        <div key={name}
                          className="flex items-center gap-1.5 bg-background border border-border rounded-full px-3 py-1 text-xs">
                          <span className="text-muted-foreground line-through">{name}</span>
                          <button onClick={() => restoreProduct(name)}
                            className="text-primary hover:text-primary/80 font-medium">
                            ↺ Wiederherstellen
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {data.importedAt && (
              <div className="text-[10px] text-muted-foreground text-right">
                Zuletzt importiert: {format(new Date(data.importedAt), 'dd.MM.yyyy HH:mm', { locale: de })} ·{' '}
                {data.entries.length} Einträge
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
