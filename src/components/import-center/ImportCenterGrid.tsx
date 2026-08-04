/**
 * ImportCenterGrid — the card grid at the top of the Import Center (/import).
 * ==========================================================================
 * One card per import category the current role may use. Route-backed cards
 * navigate to the existing import page; the two inline-only imports
 * (Mitarbeitende, Vorjahreswerte) scroll to their section further down THIS page.
 *
 * All descriptor/permission/status logic is pure and lives in
 * `@/lib/import-center`; the read-only status fetch lives in
 * `@/lib/import-center-db`. This component only renders + wires navigation.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Upload, FileText, ShoppingCart, Receipt, TrendingDown, BookOpen,
  Wallet, Users, History, CalendarClock, ArrowRight, ChevronDown,
  CheckCircle2, Circle, Loader2, RefreshCw,
} from 'lucide-react';
import {
  visibleCategories,
  STATUS_LABEL,
  STATUS_BADGE_CLASS,
  EMPTY_STATUS,
  UNKNOWN_STATUS,
  type ImportCategory,
  type ImportCategoryId,
  type ImportStatus,
  type ImportStatusSource,
} from '@/lib/import-center';
import { loadImportCenterStatuses, type ImportStatusMap } from '@/lib/import-center-db';

const ICON_MAP: Record<ImportCategoryId, React.FC<{ className?: string }>> = {
  foratable:       CalendarClock,
  gastronovi:      FileText,
  produktumsaetze: ShoppingCart,
  warenrechnungen: Receipt,
  wes:             TrendingDown,
  erfolgsrechnung: BookOpen,
  budget:          Wallet,
  mitarbeitende:   Users,
  vorjahreswerte:  History,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only show an operator if it's human-readable (UUIDs are noise to users). */
function displayOperator(by: string | null): string | null {
  if (!by) return null;
  const t = by.trim();
  if (!t || UUID_RE.test(t)) return null;
  return t;
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return format(parseISO(iso), 'dd.MM.yyyy · HH:mm', { locale: de });
  } catch {
    return iso;
  }
}

function scrollToAnchor(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-xl', 'transition-shadow');
  window.setTimeout(() => {
    el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2');
  }, 1800);
}

/** Resolve the status to display for a category given the fetched map + loading. */
function statusFor(cat: ImportCategory, map: ImportStatusMap, loading: boolean): ImportStatus | 'loading' {
  const fetched = map[cat.id];
  if (fetched) return fetched;
  if (cat.statusSource === 'none') return UNKNOWN_STATUS; // no central log for this type
  if (loading) return 'loading';
  return UNKNOWN_STATUS; // had a source but the fetch degraded
}

export function ImportCenterGrid() {
  const { tenantId } = useTenant();
  const { isAdmin, isBeaulieuManager, isBeaulieuViewer } = usePermissions();
  const [statuses, setStatuses] = useState<ImportStatusMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const cats = visibleCategories({ isAdmin, isBeaulieuManager, isBeaulieuViewer });
  // Only fetch the status sources the VISIBLE cards actually need — a role that
  // cannot see a Foratable/Gastronovi/Produktumsatz card must not trigger that
  // source's metadata read. Stable string key avoids an effect refetch loop.
  const sourcesKey = Array.from(new Set(cats.map((c) => c.statusSource))).sort().join(',');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const sources = new Set(
      (sourcesKey ? sourcesKey.split(',') : []) as ImportStatusSource[],
    );
    loadImportCenterStatuses(tenantId, sources)
      .then((m) => { if (alive) setStatuses(m); })
      .catch(() => { if (alive) setStatuses({}); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, refreshKey, sourcesKey]);

  if (cats.length === 0) return null;

  const doneCount = cats.filter((c) => {
    const s = statusFor(c, statuses, loading);
    return s !== 'loading' && s.state === 'imported';
  }).length;

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Import-Bereiche</h2>
            <span className="text-xs text-muted-foreground">
              {doneCount}/{cats.length} importiert
            </span>
          </div>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Status aktualisieren"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {cats.map((cat) => {
            const Icon = ICON_MAP[cat.id];
            const s = statusFor(cat, statuses, loading);
            const isLoading = s === 'loading';
            const state = isLoading ? 'none' : s.state;
            const ts = isLoading ? null : formatTs(s.lastImportedAt);
            const by = isLoading ? null : displayOperator(s.lastImportedBy);
            const done = !isLoading && s.state === 'imported';

            return (
              <div
                key={cat.id}
                className="flex flex-col rounded-lg border border-border/70 bg-muted/10 p-3.5 hover:border-border hover:shadow-sm transition-all"
              >
                {/* Header: icon + title + checklist */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="flex-none flex h-8 w-8 items-center justify-center rounded-md bg-background border border-border/60 text-muted-foreground">
                      <Icon className="h-4 w-4" />
                    </span>
                    <h3 className="text-sm font-semibold leading-tight">{cat.label}</h3>
                  </div>
                  {done ? (
                    <CheckCircle2 className="flex-none h-4 w-4 text-emerald-500" aria-label="Erledigt" />
                  ) : (
                    <Circle className="flex-none h-4 w-4 text-muted-foreground/40" aria-label="Offen" />
                  )}
                </div>

                {/* Description */}
                <p className="text-xs text-muted-foreground leading-snug mb-2.5 min-h-[2rem]">
                  {cat.description}
                </p>

                {/* Status + last-import meta */}
                <div className="mt-auto space-y-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        STATUS_BADGE_CLASS[state],
                      )}
                    >
                      {isLoading ? 'Lädt…' : STATUS_LABEL[s.state]}
                    </span>
                  </div>

                  <p className="text-[11px] text-muted-foreground leading-tight min-h-[1.5rem]">
                    {isLoading ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> Status wird geladen…
                      </span>
                    ) : ts ? (
                      <>
                        Zuletzt: {ts}
                        {by && <span className="block">von {by}</span>}
                      </>
                    ) : s.state === 'unknown' ? (
                      'Kein zentrales Importprotokoll'
                    ) : (
                      'Noch kein Import erfasst'
                    )}
                  </p>

                  {/* Action */}
                  {cat.kind === 'route' ? (
                    <Button asChild size="sm" variant="outline" className="w-full h-8 justify-between">
                      <Link to={cat.route!}>
                        Import öffnen
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-8 justify-between"
                      onClick={() => scrollToAnchor(cat.anchor!)}
                    >
                      Bereich anzeigen
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
