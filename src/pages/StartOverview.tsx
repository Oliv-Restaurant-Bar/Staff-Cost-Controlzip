/**
 * StartOverview — Vereinfachte Start-/Übersichtsseite (Admin).
 * ============================================================
 * UX-Aufräumkonzept Phase 1: ruhige Karten statt Zahlen-Cockpit. Drei Bereiche:
 *   1. „Heute"          → 4 Statuskarten (Umsatzimport, Reservationen,
 *                          Dienstplan, Tagesabschluss)
 *   2. „Warnungen"      → NUR echte Handlungsbedarfe (Status `action`)
 *   3. „Schnellaktionen" → reine Links zu den bestehenden Detailseiten
 *
 * STRIKT READ-ONLY (Daten via useStartOverview). Das ausführliche Dashboard
 * bleibt unter /dashboard erreichbar. Gast-Sessions (isGuest) sehen die Seite
 * (PII-freie Aggregate), aber keine schreib-orientierten Schnellaktionen.
 */

import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Contact,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useStartOverview } from '@/hooks/useStartOverview';
import type { StartCard, StartCardStatus } from '@/lib/start-overview-utils';
import { cn } from '@/lib/utils';

// ─── Ruhige Status-Stile (Karten) ────────────────────────────────────────────

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

/** Import-/Schreibseiten, deren „Öffnen"-Link Gast-Sessions nicht angeboten wird. */
const GUEST_HIDDEN_CARD_ROUTES = new Set(['/gastronovi-import', '/foratable-import']);

function StatusCard({ card, isGuest }: { card: StartCard; isGuest: boolean }) {
  const hideLink = isGuest && GUEST_HIDDEN_CARD_ROUTES.has(card.route);
  return (
    <Card data-testid={`start-card-${card.id}`} className="flex flex-col">
      <CardHeader className="pb-2 space-y-0 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full flex-shrink-0', STATUS_DOT[card.status])} />
          {card.title}
        </CardTitle>
        <Badge variant="outline" className={cn('text-[11px] font-medium', STATUS_BADGE[card.status])}>
          {card.statusLabel}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3 pt-0">
        <p className="text-sm text-muted-foreground leading-snug">{card.detail}</p>
        {!hideLink && (
          <Link
            to={card.route}
            className="text-sm font-medium text-primary inline-flex items-center gap-1 hover:underline"
          >
            Öffnen <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Seite ───────────────────────────────────────────────────────────────────

export default function StartOverviewPage() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { state, refresh } = useStartOverview(isAdmin);

  const quickActions: Array<{
    label: string;
    description: string;
    route: string;
    icon: React.FC<{ className?: string }>;
    hidden?: boolean;
  }> = [
    {
      label: 'Umsatz importieren',
      description: 'Gastronovi Z-Bericht hochladen',
      route: '/gastronovi-import',
      icon: Upload,
      hidden: isGuest, // Schreibaktion — nicht für Gast-Sessions
    },
    {
      label: 'Tagesabschluss erfassen',
      description: 'Tagesabschlüsse prüfen und bestätigen',
      route: '/tagesabschluesse',
      icon: ClipboardCheck,
      hidden: isGuest, // Schreibaktion — nicht für Gast-Sessions
    },
    {
      label: 'Reservationen ansehen',
      description: 'Gäste-CRM und Reservationen',
      route: '/gaeste',
      icon: Contact,
      hidden: isGuest, // PII-Seite — für Gäste gesperrt
    },
    {
      label: 'Dienstplan öffnen',
      description: 'Wochenplanung im Dienstplaner',
      route: '/personal',
      icon: CalendarClock,
    },
  ];
  const visibleActions = quickActions.filter((a) => !a.hidden);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:py-8 space-y-8">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Start</h1>
          <p className="text-sm text-muted-foreground">
            {format(new Date(), 'EEEE, d. MMMM yyyy', { locale: de })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={state.status === 'loading'}
            aria-label="Aktualisieren"
          >
            <RefreshCw className={cn('h-4 w-4', state.status === 'loading' && 'animate-spin')} />
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard">
              <BarChart3 className="h-4 w-4 mr-1.5" />
              Ausführliches Dashboard
            </Link>
          </Button>
        </div>
      </div>

      {/* 1. Heute */}
      <section aria-labelledby="start-heute" className="space-y-3">
        <h2 id="start-heute" className="text-base font-semibold">
          Heute
        </h2>
        {state.status === 'loading' && (
          <div
            data-testid="start-loading"
            className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Status wird geladen …
          </div>
        )}
        {state.status === 'error' && (
          <div
            data-testid="start-error"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            <span>Übersicht konnte nicht geladen werden: {state.message}</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Erneut versuchen
            </Button>
          </div>
        )}
        {state.status === 'ready' && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {state.data.cards.map((card) => (
              <StatusCard key={card.id} card={card} isGuest={isGuest} />
            ))}
          </div>
        )}
      </section>

      {/* 2. Warnungen */}
      <section aria-labelledby="start-warnungen" className="space-y-3">
        <h2 id="start-warnungen" className="text-base font-semibold">
          Warnungen
        </h2>
        {state.status === 'ready' && state.data.warnings.length === 0 && (
          <div
            data-testid="start-no-warnings"
            className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
            Keine offenen Handlungsbedarfe.
          </div>
        )}
        {state.status === 'ready' && state.data.warnings.length > 0 && (
          <ul data-testid="start-warnings" className="space-y-2">
            {state.data.warnings.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950/40"
              >
                <span className="flex items-center gap-2 text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {w.text}
                </span>
                <Link
                  to={w.route}
                  className="text-sm font-medium text-red-700 dark:text-red-300 inline-flex items-center gap-1 hover:underline"
                >
                  Öffnen <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {state.status !== 'ready' && (
          <p className="text-sm text-muted-foreground">Warnungen erscheinen nach dem Laden.</p>
        )}
      </section>

      {/* 3. Schnellaktionen */}
      <section aria-labelledby="start-aktionen" className="space-y-3">
        <h2 id="start-aktionen" className="text-base font-semibold">
          Schnellaktionen
        </h2>
        <div data-testid="start-actions" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {visibleActions.map((action) => {
            const Icon = action.icon;
            return (
              <Button
                key={action.route}
                variant="outline"
                asChild
                className="h-auto justify-start p-4 text-left"
              >
                <Link to={action.route}>
                  <span className="flex items-start gap-3">
                    <Icon className="h-5 w-5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{action.label}</span>
                      <span className="block text-xs text-muted-foreground font-normal whitespace-normal">
                        {action.description}
                      </span>
                    </span>
                  </span>
                </Link>
              </Button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
