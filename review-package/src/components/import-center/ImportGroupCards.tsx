/**
 * ImportGroupCards — Die 4 Importarten-Gruppen oben im Import-Center (/import).
 * =============================================================================
 * Zeigt pro Gruppe (Umsatz/Z-Bericht · Reservationen · Arbeitszeiten/AZB ·
 * Tagesabschluss/Kennzahlen) den letzten Import, den Status (worst-of aller
 * Mitglieder, 1:1 aus computeSourceStatus) und eine „Import starten"-Aktion.
 * Read-only: nutzt fetchCockpitSignals; keine eigenen Frische-Regeln, keine
 * Schreiboperationen. Nur für Admin-Sessions gedacht (Gating macht die Seite).
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronDown, Loader2, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';
import { buildImportGroupOverviews, type ImportGroupOverview } from '@/lib/import-groups';
import type { StartCardStatus } from '@/lib/start-overview-utils';

const STATUS_DOT: Record<StartCardStatus, string> = {
  ok: 'bg-emerald-500',
  due_soon: 'bg-amber-400',
  action: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
};

const STATUS_BADGE: Record<StartCardStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  due_soon:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  action: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  unknown: 'bg-muted text-muted-foreground border-border',
};

/** Event, mit dem eine Inline-Sektion auf /import aufgeklappt wird. */
export const IMPORT_SECTION_OPEN_EVENT = 'import-section-open';

function openSection(anchor: string) {
  window.dispatchEvent(new CustomEvent(IMPORT_SECTION_OPEN_EVENT, { detail: anchor }));
  // Nach dem Aufklappen zum Element scrollen (nächster Frame, damit es gerendert ist).
  requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; groups: ImportGroupOverview[] };

const GroupCard = ({ group }: { group: ImportGroupOverview }) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { def } = group;
  return (
    <Card data-testid={`import-group-${def.id}`} className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <span className={cn('h-2 w-2 rounded-full flex-shrink-0', STATUS_DOT[group.status])} />
            {def.title}
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{def.subtitle}</p>
        </div>
        <Badge variant="outline" className={cn('flex-shrink-0 text-[11px] font-medium', STATUS_BADGE[group.status])}>
          {group.statusLabel}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-2 pt-0">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Letzter Import:{' '}
            <span className="font-medium tabular-nums text-foreground">
              {group.lastImportText ?? 'Noch nie'}
            </span>
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{group.detail}</p>
          {group.members.length > 1 && (
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              data-testid={`import-group-${def.id}-toggle`}
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', !detailsOpen && '-rotate-90')} />
              Einzelne Quellen
            </button>
          )}
          {detailsOpen && (
            <ul className="space-y-1 pl-1" data-testid={`import-group-${def.id}-members`}>
              {group.members.map((m) => (
                <li key={m.sourceId} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                  <span className={cn('mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full', STATUS_DOT[m.status])} />
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{m.label}</span> — {m.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {def.startRoute ? (
          <Link to={def.startRoute} className="w-full">
            <Button size="sm" className="h-8 w-full gap-1.5 text-xs">
              <Upload className="h-3.5 w-3.5" />
              {def.startLabel}
            </Button>
          </Link>
        ) : (
          <Button
            size="sm"
            className="h-8 w-full gap-1.5 text-xs"
            onClick={() => def.startAnchor && openSection(def.startAnchor)}
          >
            <Upload className="h-3.5 w-3.5" />
            {def.startLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
};

export const ImportGroupCards = () => {
  const { tenantId, tenantKey } = useTenant();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const signals = await fetchCockpitSignals({ tenantId, tenantKey });
      setState({ status: 'ready', groups: buildImportGroupOverviews(signals, new Date()) });
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Status konnte nicht geladen werden',
      });
    }
  }, [tenantId, tenantKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground"
        data-testid="import-groups-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Import-Status wird geladen …
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
        data-testid="import-groups-error"
      >
        <span className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Import-Status konnte nicht geladen werden: {state.message}
        </span>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void load()}>
          Erneut versuchen
        </Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="import-groups">
      {state.groups.map((g) => (
        <GroupCard key={g.def.id} group={g} />
      ))}
    </div>
  );
};
