/**
 * StartOverview — Startübersicht als Tagesleitstand (Admin).
 * ==========================================================
 * UX-Priorität 1: In wenigen Sekunden beantworten „Was ist heute wichtig,
 * was fehlt, was ist mein nächster Schritt?". Reihenfolge:
 *   1. „Heute"          → 4 Statuskarten (Umsatzimport, Reservationen,
 *                          Dienstplan, Tagesabschluss)
 *   2. „Als Nächstes"   → max. 3 priorisierte Aufgaben mit Deep-Links
 *                          (SSoT-Priorisierung getTodayTasks, keine Zweitlogik)
 *   3. „Datenstand"     → kompakte Zeile pro Importtyp inkl. fehlender Tage
 *   4. „Schnellaktionen" → reine Links zu den bestehenden Detailseiten
 *
 * Die frühere „Warnungen"-Sektion entfällt: ihre Inhalte stecken 1:1 in den
 * Statuskarten (rot) und in «Als Nächstes» (keine doppelte Statuslogik, T409).
 *
 * STRIKT READ-ONLY (Daten via useStartOverview). Das ausführliche Dashboard
 * bleibt unter /dashboard erreichbar. Gast-Sessions (isGuest) sehen die Seite
 * (PII-freie Aggregate), aber keine schreib-orientierten Aktionen und keinen
 * Link auf die (gastgesperrte) Import-Checkliste.
 */

import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
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
import {
  buildDatenstandRows,
  buildNextActions,
  DATENSTAND_TONE,
  NEXT_ACTION_TONE,
  type NextAction,
  type StartCard,
  type StartCardStatus,
} from '@/lib/start-overview-utils';
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

/** Ton → Punkt-/Badge-Stile für «Als Nächstes» und Datenstand (zentrale Farbsemantik). */
const TONE_DOT: Record<'good' | 'warn' | 'neutral' | 'critical' | 'info', string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-400',
  neutral: 'bg-muted-foreground/40',
  critical: 'bg-red-500',
  info: 'bg-blue-500',
};

const TONE_BADGE: Record<'warn' | 'critical' | 'info', string> = {
  critical: STATUS_BADGE.action,
  warn: STATUS_BADGE.due_soon,
  info: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
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

function NextActionRow({ action }: { action: NextAction }) {
  const tone = NEXT_ACTION_TONE[action.urgency];
  return (
    <li data-testid={`start-next-${action.id}`}>
      <Link
        to={action.href}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className={cn('h-2 w-2 rounded-full flex-shrink-0', TONE_DOT[tone])} />
          <span className="min-w-0">
            <span className="block font-medium">{action.title}</span>
            <span className="block text-xs text-muted-foreground">{action.reason}</span>
          </span>
        </span>
        <span className="flex items-center gap-2">
          <Badge variant="outline" className={cn('text-[11px] font-medium', TONE_BADGE[tone])}>
            {action.urgencyLabel}
          </Badge>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </Link>
    </li>
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

  // Reine Ableitungen aus dem SSoT-Aufgabenstand (keine eigene Statuslogik).
  const nextActions =
    state.status === 'ready' && state.todayTasks && state.typeCompletions
      ? buildNextActions({
          todayTasks: state.todayTasks,
          typeCompletions: state.typeCompletions,
          cards: state.data.cards,
          isGuest,
        })
      : null;
  const datenstand =
    state.status === 'ready' && state.typeCompletions
      ? buildDatenstandRows(state.typeCompletions)
      : null;

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

      {/* 2. Als Nächstes */}
      <section aria-labelledby="start-naechstes" className="space-y-3">
        <h2 id="start-naechstes" className="text-base font-semibold">
          Als Nächstes
        </h2>
        {state.status !== 'ready' && (
          <p className="text-sm text-muted-foreground">Aufgaben erscheinen nach dem Laden.</p>
        )}
        {state.status === 'ready' && state.coverageError !== null && (
          <div
            data-testid="start-coverage-error"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          >
            <span>Aufgaben und Datenstand konnten nicht geladen werden.</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Erneut versuchen
            </Button>
          </div>
        )}
        {nextActions !== null && nextActions.length === 0 && (
          <div
            data-testid="start-next-empty"
            className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
            Für heute sind keine dringenden Aufgaben offen.
          </div>
        )}
        {nextActions !== null && nextActions.length > 0 && (
          <ul data-testid="start-next-actions" className="space-y-2">
            {nextActions.map((action) => (
              <NextActionRow key={action.id} action={action} />
            ))}
          </ul>
        )}
      </section>

      {/* 3. Datenstand */}
      <section aria-labelledby="start-datenstand" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="start-datenstand" className="text-base font-semibold">
            Datenstand
          </h2>
          {!isGuest && (
            <Link
              to="/import-cockpit"
              className="text-sm font-medium text-primary inline-flex items-center gap-1 hover:underline"
            >
              Import-Checkliste öffnen <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
        {state.status !== 'ready' && (
          <p className="text-sm text-muted-foreground">Datenstand erscheint nach dem Laden.</p>
        )}
        {state.status === 'ready' && datenstand === null && state.coverageError === null && (
          <p className="text-sm text-muted-foreground">Datenstand erscheint nach dem Laden.</p>
        )}
        {datenstand !== null && (
          <Card>
            <CardContent className="p-0" data-testid="start-datenstand">
              <ul className="divide-y">
                {datenstand.map((row) => (
                  <li
                    key={row.type}
                    data-testid={`start-datenstand-${row.type}`}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full flex-shrink-0',
                          TONE_DOT[DATENSTAND_TONE[row.status]],
                        )}
                      />
                      {row.label}
                    </span>
                    <span
                      className={cn(
                        'text-xs',
                        row.status === 'open' || row.status === 'error'
                          ? 'text-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      {row.text}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      {/* 4. Schnellaktionen */}
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
