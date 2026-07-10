/**
 * OP-Liste Kreditoren (Phase 1) — Übersicht + Vergleich zweier Stichtage.
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-only (doppelt gegated: Route-Guard in App.tsx + hier Guard VOR dem
 * Lade-Effekt). Gäste (isGuest) sehen alles rein lesend (kein Import).
 * Daten: creditor_op_imports / creditor_op_items via src/lib/op-liste-db.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { FileUp, Info, LayoutDashboard, Loader2, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OpImportDialog } from '@/components/op-liste/OpImportDialog';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { loadOpImports, loadOpItems } from '@/lib/op-liste-db';
import {
  buildAuthoritySummary, compareSnapshots, summarizeSnapshot, topSuppliers,
  COMPARE_STATUS_LABELS, type OpCompareItem, type OpCompareStatus,
} from '@/lib/op-liste-compare';
import { BUCKET_KEYS, BUCKET_LABELS } from '@/types/op-liste';
import type { OpImportRecord, OpItemRecord } from '@/types/op-liste';

const chf = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (iso: string | null) => {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/** Vorzeichenbehaftete Differenz (U+2212-Minus, Projektkonvention). */
const fmtDiff = (v: number) => (v > 0 ? `+${chf(v)}` : v < 0 ? `−${chf(Math.abs(v))}` : '±0.00');

const STATUS_STYLES: Record<OpCompareStatus, string> = {
  neu: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  gestiegen: 'bg-red-500/15 text-red-700 dark:text-red-400',
  gesunken: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  unveraendert: 'bg-muted text-muted-foreground',
  erledigt: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
};

function toCompareItems(items: OpItemRecord[]): OpCompareItem[] {
  return items.map(it => ({ supplierName: it.supplierName, openAmount: it.openAmount, buckets: it.buckets }));
}

export default function OpListe() {
  const { isAdmin, isBeaulieuManager, isGuest } = usePermissions();
  const { tenantId } = useTenant();

  const [imports, setImports] = useState<OpImportRecord[]>([]);
  const [tableMissing, setTableMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null);
  const [itemsCache, setItemsCache] = useState<Record<string, OpItemRecord[]>>({});
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const allowed = isAdmin && !isBeaulieuManager;

  const reload = useCallback(async () => {
    // Guard VOR dem Fetch (Effekt feuert vor <Navigate>)
    if (!allowed) return;
    setLoading(true);
    setLoadError(null);
    const res = await loadOpImports(tenantId);
    setImports(res.imports);
    setTableMissing(res.tableMissing);
    setLoadError(res.error);
    setItemsCache({});
    setSelectedId(res.imports[0]?.id ?? null);
    setCompareBaseId(res.imports[1]?.id ?? null);
    setLoading(false);
  }, [allowed, tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  // Items für Übersicht + Vergleich nachladen (cache pro Import-ID)
  useEffect(() => {
    if (!allowed) return;
    const wanted = [selectedId, compareBaseId].filter((id): id is string => !!id);
    for (const id of wanted) {
      if (itemsCache[id]) continue;
      loadOpItems(tenantId, id)
        .then(items => setItemsCache(prev => (prev[id] ? prev : { ...prev, [id]: items })))
        .catch(e => setItemsError(e instanceof Error ? e.message : String(e)));
    }
  }, [allowed, tenantId, selectedId, compareBaseId, itemsCache]);

  const selected = imports.find(i => i.id === selectedId) ?? null;
  const base = imports.find(i => i.id === compareBaseId) ?? null;
  const selectedItems = selectedId ? itemsCache[selectedId] : undefined;
  const baseItems = compareBaseId ? itemsCache[compareBaseId] : undefined;

  const summary = useMemo(
    () => (selectedItems ? summarizeSnapshot(toCompareItems(selectedItems)) : null),
    [selectedItems],
  );
  const top = useMemo(
    () => (selectedItems ? topSuppliers(toCompareItems(selectedItems), 10) : []),
    [selectedItems],
  );
  const comparison = useMemo(() => {
    if (!selectedItems || !baseItems || !base || !selected || base.id === selected.id) return null;
    return compareSnapshots(toCompareItems(baseItems), toCompareItems(selectedItems));
  }, [selectedItems, baseItems, base, selected]);
  const authorities = useMemo(() => {
    if (!selectedItems) return null;
    return buildAuthoritySummary(baseItems && comparison ? toCompareItems(baseItems) : [], toCompareItems(selectedItems));
  }, [selectedItems, baseItems, comparison]);

  if (isBeaulieuManager || !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-full px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Dashboard</span>
              </Button>
            </Link>
            <span className="text-muted-foreground text-xs">/</span>
            <h1 className="text-sm font-bold">OP-Liste Kreditoren</h1>
            <span
              title="Monatliche Kreditoren-OP-Liste (PDF) importieren, offene Posten pro Stichtag auswerten und zwei Stichtage vergleichen."
              className="text-muted-foreground cursor-help"
              data-testid="op-page-info"
            >
              <Info className="h-3.5 w-3.5" aria-label="Was diese Seite macht" />
            </span>
          </div>
          <div className="flex items-center gap-2">
            {imports.length > 0 && (
              <Select value={selectedId ?? ''} onValueChange={v => setSelectedId(v)}>
                <SelectTrigger className="h-8 w-40 text-xs" data-testid="op-stichtag-select">
                  <SelectValue placeholder="Stichtag" />
                </SelectTrigger>
                <SelectContent>
                  {imports.map(imp => (
                    <SelectItem key={imp.id} value={imp.id} className="text-xs">
                      {fmtDate(imp.snapshotDate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!isGuest && (
              <Button size="sm" className="h-8 text-xs" onClick={() => setImportOpen(true)} data-testid="op-import-button">
                <FileUp className="h-3.5 w-3.5 mr-1" /> PDF importieren
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-4 py-4 space-y-4">
        {loading && (
          <div className="flex items-center gap-2 py-10 justify-center text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lade OP-Listen …
          </div>
        )}

        {!loading && tableMissing && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-xs" data-testid="op-migration-hint">
            <p className="font-semibold text-amber-700 dark:text-amber-400">Datenbank-Tabellen fehlen noch</p>
            <p className="mt-1 text-muted-foreground">
              Bitte die Migration <code className="font-mono">supabase/migrations/20260708_creditor_op.sql</code> einmalig
              im Supabase SQL-Editor ausführen, danach diese Seite neu laden.
            </p>
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-xs text-destructive" data-testid="op-load-error">
            OP-Listen konnten nicht geladen werden: {loadError}
          </div>
        )}

        {!loading && !tableMissing && !loadError && imports.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground" data-testid="op-empty">
            <Scale className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p>Noch keine OP-Liste importiert.</p>
            {!isGuest && <p className="mt-1">Mit „PDF importieren" die erste Kreditoren-OP-Liste hochladen.</p>}
          </div>
        )}

        {itemsError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            Einzelposten konnten nicht geladen werden: {itemsError}
          </div>
        )}

        {/* ── Übersicht zum gewählten Stichtag ── */}
        {!loading && selected && (
          <section className="space-y-3" data-testid="op-overview">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Übersicht per {fmtDate(selected.snapshotDate)}
              {selected.sourceFilename && (
                <span className="ml-2 normal-case font-normal">({selected.sourceFilename})</span>
              )}
            </h2>
            {!summary ? (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lade Posten …
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="op-kpi-total">
                    <p className="text-[10px] text-muted-foreground">Total offen CHF</p>
                    <p className="text-base font-bold">{chf(summary.totalOpen)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="op-kpi-overdue">
                    <p className="text-[10px] text-muted-foreground">Davon überfällig CHF</p>
                    <p className="text-base font-bold text-red-600 dark:text-red-400">
                      {summary.overdueAmount !== null ? chf(summary.overdueAmount) : '–'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="op-kpi-items">
                    <p className="text-[10px] text-muted-foreground">Offene Posten</p>
                    <p className="text-base font-bold">{summary.itemCount}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="op-kpi-suppliers">
                    <p className="text-[10px] text-muted-foreground">Lieferanten</p>
                    <p className="text-base font-bold">{summary.supplierCount}</p>
                  </div>
                </div>

                {/* Fälligkeits-Buckets */}
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2" data-testid="op-buckets">
                  {BUCKET_KEYS.map(k => (
                    <div key={k} className="rounded-md border border-border bg-card px-2 py-1.5">
                      <p className="text-[10px] text-muted-foreground truncate">{BUCKET_LABELS[k]}</p>
                      <p className="text-xs font-semibold">
                        {summary.buckets[k] !== null ? chf(summary.buckets[k]!) : '–'}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Top-Lieferanten */}
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Top-Lieferanten</th>
                        <th className="text-right px-3 py-1.5 font-medium">Posten</th>
                        <th className="text-right px-3 py-1.5 font-medium">Offen CHF</th>
                        <th className="text-right px-3 py-1.5 font-medium">Anteil</th>
                      </tr>
                    </thead>
                    <tbody data-testid="op-top-suppliers">
                      {top.map(s => (
                        <tr key={s.matchKey} className="border-t border-border">
                          <td className="px-3 py-1.5">{s.name}</td>
                          <td className="px-3 py-1.5 text-right">{s.itemCount}</td>
                          <td className="px-3 py-1.5 text-right font-medium">{chf(s.amount)}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {summary.totalOpen !== 0 ? `${((s.amount / summary.totalOpen) * 100).toFixed(1)} %` : '–'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Vergleich zweier Stichtage ── */}
        {!loading && selected && imports.length >= 2 && (
          <section className="space-y-3" data-testid="op-compare">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Vergleich</h2>
              <Select value={compareBaseId ?? ''} onValueChange={v => setCompareBaseId(v)}>
                <SelectTrigger className="h-7 w-36 text-xs" data-testid="op-compare-base-select">
                  <SelectValue placeholder="Vorher-Stichtag" />
                </SelectTrigger>
                <SelectContent>
                  {imports.filter(i => i.id !== selectedId).map(imp => (
                    <SelectItem key={imp.id} value={imp.id} className="text-xs">
                      {fmtDate(imp.snapshotDate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">→ {fmtDate(selected.snapshotDate)}</span>
            </div>

            {!comparison || !base ? (
              <p className="text-xs text-muted-foreground">Zweiten Stichtag wählen, um zu vergleichen.</p>
            ) : (
              <>
                {/* Vergleichs-KPIs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="op-compare-kpis">
                  {([
                    ['Total offen CHF', comparison.totalOpen, chf],
                    ['Überfällig CHF', comparison.overdueAmount, chf],
                    ['Offene Posten', comparison.itemCount, (v: number) => String(v)],
                    ['Lieferanten', comparison.supplierCount, (v: number) => String(v)],
                  ] as const).map(([label, kpi, fmt]) => (
                    <div key={label} className="rounded-lg border border-border bg-card p-3">
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                      <p className="text-sm font-bold">
                        {kpi.before !== null ? fmt(kpi.before) : '–'}
                        <span className="text-muted-foreground font-normal mx-1">→</span>
                        {kpi.after !== null ? fmt(kpi.after) : '–'}
                      </p>
                      <p className={`text-xs font-medium ${kpi.diff !== null && kpi.diff > 0 ? 'text-red-600 dark:text-red-400' : kpi.diff !== null && kpi.diff < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {kpi.diff !== null ? fmtDiff(kpi.diff) : 'nicht vergleichbar'}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Behörden & Sozialabgaben */}
                {authorities && (
                  <div className="rounded-lg border border-border bg-card p-3" data-testid="op-authorities">
                    <p className="text-xs font-semibold mb-2">Behörden &amp; Sozialabgaben</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                      {authorities.map(a => (
                        <div key={a.key} className="flex items-center justify-between gap-2 text-xs py-0.5">
                          <span className="text-muted-foreground truncate">{a.label}</span>
                          <span className="font-medium whitespace-nowrap">
                            {a.before !== null ? chf(a.before) : '–'}
                            <span className="text-muted-foreground font-normal mx-1">→</span>
                            {a.after !== null ? chf(a.after) : '–'}
                            <span className={`ml-2 ${a.diff > 0 ? 'text-red-600 dark:text-red-400' : a.diff < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                              {fmtDiff(a.diff)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Lieferanten-Vergleich */}
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="max-h-[60vh] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Lieferant</th>
                          <th className="text-right px-3 py-1.5 font-medium">{fmtDate(base.snapshotDate)}</th>
                          <th className="text-right px-3 py-1.5 font-medium">{fmtDate(selected.snapshotDate)}</th>
                          <th className="text-right px-3 py-1.5 font-medium">Δ CHF</th>
                          <th className="text-right px-3 py-1.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody data-testid="op-compare-rows">
                        {comparison.rows.map(row => (
                          <tr key={row.matchKey} className="border-t border-border">
                            <td className="px-3 py-1.5">{row.name}</td>
                            <td className="px-3 py-1.5 text-right">{row.before !== null ? chf(row.before) : '–'}</td>
                            <td className="px-3 py-1.5 text-right">{row.after !== null ? chf(row.after) : '–'}</td>
                            <td className={`px-3 py-1.5 text-right font-medium ${row.diff > 0 ? 'text-red-600 dark:text-red-400' : row.diff < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                              {fmtDiff(row.diff)}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[row.status]}`}>
                                {COMPARE_STATUS_LABELS[row.status]}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </section>
        )}
      </main>

      <OpImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        tenantId={tenantId}
        tableMissing={tableMissing}
        onImported={() => void reload()}
      />
    </div>
  );
}
