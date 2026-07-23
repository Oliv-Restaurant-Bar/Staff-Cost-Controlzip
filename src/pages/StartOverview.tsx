/**
 * StartOverview — Executive Cockpit (Startseite, Admin).
 * ======================================================
 * UX-Ziel: In wenigen Sekunden beantworten «Wie steht der Monat finanziell,
 * was ist heute wichtig, wo sind Risiken, was ist mein nächster Schritt?».
 * Bereiche (kompakt, Desktop möglichst ohne Scrollen):
 *   1. Management-KPIs   → ManagementKpiSection: fester KPI-Katalog (Ebene 1,
 *                          ~16 KPIs) mit Monatswahl, Ebene-2/3-Links, Monats-
 *                          kommentaren und Export-Profilen. P&L-Werte
 *                          AUSSCHLIESSLICH aus der Financial-Metrics-Registry
 *                          (EIN computePLForMonth) — fehlend = «—», NIE
 *                          operative Ersatzwerte.
 *   2. Heute             → personalisierbare Widgets (start-prefs): die 4
 *                          Statuskarten (buildStartOverview, Frische-SSoT)
 *                          plus Info-Widgets aus BESTEHENDEN Quellen
 *                          (start-widgets-Builder + useHeuteWidgets, keine
 *                          neuen Schwellen; fehlend = «—», nie 0).
 *   3. Risiken           → WarnCenter: rot/orange NUR aus bestehenden Regeln
 *                          (buildExecutiveWarnings, keine neuen Schwellen).
 *   4. Diese Woche       → Wochenumsatz (erfasste Tage), Dienstplan-Stand,
 *                          offene Importe — nur bestehende Werte.
 *   5. Datenstand (Monat)→ kompakte Chips pro Importtyp inkl. fehlender Tage
 *                          (Status weiterhin 1:1 aus buildDatenstandRows).
 *   6. Aktionen          → «Als Nächstes» (SSoT getTodayTasks, max. 3) +
 *                          Schnellaktionen.
 *
 * Die frühere Monatsübersichts-Karte (StartMonthOverview) entfällt auf der
 * Startseite — ihr Inhalt steckt im Finanzblock + Datenstand; die
 * Detail-Monatssicht bleibt über /umsatzabstimmung und /import-cockpit
 * erreichbar (bewusste Entscheidung dieser UX-Runde, keine Doppel-Statuslogik).
 *
 * STRIKT READ-ONLY (Daten via useStartOverview + useCockpitFinancials).
 * Gast-Sessions (isGuest) sehen die Seite (PII-freie Aggregate), aber keine
 * schreib-orientierten Aktionen/Links auf gastgesperrte Flächen.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, eachDayOfInterval, format, startOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Contact,
  Loader2,
  RefreshCw,
  Settings2,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useStartOverview } from '@/hooks/useStartOverview';
import { useCockpitFinancials } from '@/hooks/useCockpitFinancials';
import { useHeuteWidgets } from '@/hooks/useHeuteWidgets';
import { useStartPrefs } from '@/hooks/useStartPrefs';
import { ManagementKpiSection } from '@/components/start/ManagementKpiSection';
import { WarnCenter } from '@/components/start/WarnCenter';
import { WocheBlock } from '@/components/start/WocheBlock';
import { buildExecutiveWarnings, type ExecutiveWarningsResult } from '@/lib/executive-warnings';
import { getFinancialMetricValues } from '@/lib/financial-metrics';
import { sumDailyRevenue } from '@/lib/operational-day';
import {
  buildDatenstandRows,
  buildNextActions,
  DATENSTAND_TONE,
  NEXT_ACTION_TONE,
  type NextAction,
  type StartCardStatus,
} from '@/lib/start-overview-utils';
import { filterWidgetsForGuest, moveItem } from '@/lib/start-prefs';
import {
  buildKreditorenWidget,
  buildOffeneImporteWidget,
  buildPersonalausfaelleWidget,
  buildReservationenHeuteWidget,
  buildWarenrechnungenWidget,
  HEUTE_WIDGET_DEFS,
  widgetFromStartCard,
  type HeuteWidgetId,
  type HeuteWidgetView,
} from '@/lib/start-widgets';
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

/**
 * Einheitliche «Heute»-Widget-Karte:
 *  - Statuskarten-Widgets: Ampel-Punkt + Status-Badge (1:1 aus der StartCard).
 *  - Info-Widgets: grosse Kennzahl ohne Ampel (keine neuen Schwellen);
 *    Ladefehler sichtbar (nie stilles «—»).
 */
function HeuteWidgetCard({ widget }: { widget: HeuteWidgetView }) {
  return (
    <Card data-testid={`start-card-${widget.id}`} className="flex flex-col">
      <CardHeader className="pb-1 pt-3 space-y-0 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {widget.status !== null && (
            <span className={cn('h-2 w-2 rounded-full flex-shrink-0', STATUS_DOT[widget.status])} />
          )}
          {widget.title}
        </CardTitle>
        {widget.status !== null && widget.statusLabel && (
          <Badge variant="outline" className={cn('text-[11px] font-medium', STATUS_BADGE[widget.status])}>
            {widget.statusLabel}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-1.5 pb-3 pt-0">
        <div className="min-w-0">
          {widget.value !== null && (
            <p className="text-xl font-semibold tabular-nums leading-tight">{widget.value}</p>
          )}
          <p className="text-sm text-muted-foreground leading-snug">{widget.detail}</p>
          {widget.error && (
            <p className="text-xs text-red-600 dark:text-red-400" data-testid={`start-card-${widget.id}-error`}>
              {widget.error}
            </p>
          )}
        </div>
        {widget.route && (
          <Link
            to={widget.route}
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
  // Finanz-/Umsatzdaten des laufenden Monats — read-only, Registry-Wiring.
  const fin = useCockpitFinancials(isAdmin);

  // ── «Heute»-Widgets (personalisierbar; Gast = Defaults ohne Import-Widgets) ──
  const { prefs, canCustomize, savePrefs } = useStartPrefs();
  const visibleWidgetIds = useMemo(
    () => filterWidgetsForGuest(prefs.heuteWidgets, isGuest),
    [prefs.heuteWidgets, isGuest],
  );
  const widgetData = useHeuteWidgets(isAdmin, visibleWidgetIds);

  const [widgetsOpen, setWidgetsOpen] = useState(false);
  const [draftWidgets, setDraftWidgets] = useState<HeuteWidgetId[]>([]);
  const [widgetsError, setWidgetsError] = useState<string | null>(null);

  const openWidgetsDialog = () => {
    setDraftWidgets(filterWidgetsForGuest(prefs.heuteWidgets, isGuest));
    setWidgetsError(null);
    setWidgetsOpen(true);
  };
  const toggleDraftWidget = (id: HeuteWidgetId) => {
    setDraftWidgets(cur => (cur.includes(id) ? cur.filter(w => w !== id) : [...cur, id]));
  };
  const saveWidgets = () => {
    if (draftWidgets.length === 0) {
      setWidgetsError('Mindestens ein Widget auswählen.');
      return;
    }
    savePrefs({ heuteWidgets: draftWidgets });
    setWidgetsOpen(false);
  };

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
  // Datenstand zeigt IMMER den aktuellen Monat (useStartOverview lädt dessen
  // Coverage) — der Monats-Kontext dient nur den advisory Deep-Link-Params.
  const now = new Date();
  const datenstand =
    state.status === 'ready' && state.typeCompletions
      ? buildDatenstandRows(state.typeCompletions, {
          period: { year: now.getFullYear(), month: now.getMonth() + 1 },
          isGuest,
        })
      : null;

  // ── Registry-Quoten (IST) für das Warncenter — dieselben Rohwerte wie der
  //    Finanzblock, KEINE Zweitberechnung.
  const cogsRatioActual = fin.financialInput
    ? getFinancialMetricValues('cogs_ratio', fin.financialInput).actual
    : null;
  const personnelRatioActual = fin.financialInput
    ? getFinancialMetricValues('personnel_ratio', fin.financialInput).actual
    : null;

  // ── Warncenter: NUR bestehende Regeln bündeln (reine Logik). ──
  const warnResult: ExecutiveWarningsResult | null =
    state.status === 'ready'
      ? buildExecutiveWarnings({
          cards: state.data.cards,
          typeCompletions: state.typeCompletions,
          coverageError: state.coverageError,
          cogsRatioActual,
          personnelRatioActual,
          personnelRatioTarget: fin.personnelRatioTarget,
        })
      : null;

  // ── Diese Woche: Mo…heute, nur erfasste Tageswerte (fehlend ≠ 0). ──
  const week = useMemo(() => {
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const weekEnd = addDays(weekStart, 6);
    const days = eachDayOfInterval({ start: weekStart, end: now }).map((d) =>
      format(d, 'yyyy-MM-dd'),
    );
    const hasAny = days.some((d) => typeof fin.dailyBudgets[d]?.actualRevenue === 'number');
    return {
      label: `KW ${format(now, 'I', { locale: de })} · ${format(weekStart, 'd.M.', { locale: de })}–${format(weekEnd, 'd.M.yyyy', { locale: de })}`,
      revenue: hasAny ? sumDailyRevenue(fin.dailyBudgets, days, 'actualRevenue') : null,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fin.dailyBudgets]);

  // ── Widget-Views in der gewählten Reihenfolge (reine Builder, keine
  //    eigene Statuslogik; Statuskarten 1:1 aus buildStartOverview). ──
  const monthLabel = format(now, 'MMMM yyyy', { locale: de });
  const widgetViews: HeuteWidgetView[] | null =
    state.status === 'ready'
      ? visibleWidgetIds
          .map((id): HeuteWidgetView | null => {
            switch (id) {
              case 'umsatz':
              case 'reservationen':
              case 'dienstplan':
              case 'tagesabschluss': {
                const card = state.data.cards.find((c) => c.id === id);
                return card
                  ? widgetFromStartCard(card, {
                      hideRoute: isGuest && GUEST_HIDDEN_CARD_ROUTES.has(card.route),
                    })
                  : null;
              }
              case 'offene_importe':
                return buildOffeneImporteWidget(state.typeCompletions, state.coverageError);
              case 'reservationen_heute':
                return buildReservationenHeuteWidget(
                  widgetData.reservationenHeute.data,
                  widgetData.reservationenHeute.error,
                  isGuest,
                );
              case 'personalausfaelle':
                return buildPersonalausfaelleWidget(
                  widgetData.personalausfaelle.data,
                  widgetData.personalausfaelle.error,
                );
              case 'warenrechnungen':
                return buildWarenrechnungenWidget(
                  widgetData.warenrechnungen.data,
                  widgetData.warenrechnungen.error,
                  monthLabel,
                );
              case 'kreditoren':
                return buildKreditorenWidget(widgetData.kreditoren.data, widgetData.kreditoren.error);
            }
          })
          .filter((w): w is HeuteWidgetView => w !== null)
      : null;

  const dienstplanDetail =
    state.status === 'ready'
      ? (state.data.cards.find((c) => c.id === 'dienstplan')?.detail ?? null)
      : null;
  const openImports =
    state.status === 'ready' && state.typeCompletions
      ? state.typeCompletions.filter((t) => t.status === 'open' || t.status === 'error').length
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 md:py-6 space-y-6">
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

      {/* Lade-/Fehlerzustand der Übersicht */}
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

      {/* 1. Management-KPIs (Monatswahl) — Werte NUR über den KPI-Katalog
          (Registry-KPIs: EIN computePLForMonth; operative KPIs: bestehende
          Quellen). Ersetzt den früheren CockpitFinanzBlock — dessen 5 Finanz-
          zeilen sind Teil des Katalogs (keine Doppel-Anzeige). */}
      <ManagementKpiSection enabled={isAdmin} isGuest={isGuest} />

      {/* 2.+3. Heute + Risiken nebeneinander (Desktop) */}
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="start-heute" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="start-heute" className="flex items-center gap-2 text-base font-semibold">
              Heute
              {widgetData.loading && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </h2>
            {canCustomize && (
              <Button
                variant="ghost"
                size="sm"
                onClick={openWidgetsDialog}
                data-testid="start-widgets-customize-btn"
              >
                <Settings2 className="mr-1.5 h-4 w-4" />
                Anpassen
              </Button>
            )}
          </div>
          {widgetViews === null && (
            <p className="text-sm text-muted-foreground">Status erscheint nach dem Laden.</p>
          )}
          {widgetViews !== null && (
            <div className="grid gap-3 sm:grid-cols-2">
              {widgetViews.map((widget) => (
                <HeuteWidgetCard key={widget.id} widget={widget} />
              ))}
            </div>
          )}
        </section>

        <WarnCenter result={warnResult} isGuest={isGuest} />
      </div>

      {/* 4.+5. Diese Woche + Datenstand nebeneinander (Desktop) */}
      <div className="grid gap-6 xl:grid-cols-2">
        <WocheBlock
          weekLabel={week.label}
          weekRevenue={week.revenue}
          dienstplanDetail={dienstplanDetail}
          openImports={openImports}
          isGuest={isGuest}
        />

        <section aria-labelledby="start-datenstand" className="space-y-2">
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
            // Kompakte Chips: ein Chip pro Importtyp (Status 1:1 aus
            // buildDatenstandRows, ganze Fläche = Deep-Link wo vorhanden).
            <ul className="flex flex-wrap gap-1.5" data-testid="start-datenstand">
              {datenstand.map((row) => {
                const chipClass = cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                  row.status === 'open' || row.status === 'error'
                    ? 'border-border bg-card text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground',
                );
                const content = (
                  <>
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full flex-shrink-0',
                        TONE_DOT[DATENSTAND_TONE[row.status]],
                      )}
                    />
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="truncate">{row.text}</span>
                    {row.href && (
                      <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    )}
                  </>
                );
                return (
                  <li key={row.type} data-testid={`start-datenstand-${row.type}`} className="max-w-full">
                    {row.href ? (
                      <Link
                        to={row.href}
                        title={`${row.label}: ${row.text}`}
                        className={cn(
                          chipClass,
                          'transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        )}
                      >
                        {content}
                      </Link>
                    ) : (
                      <span title={`${row.label}: ${row.text}`} className={chipClass}>
                        {content}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* 6. Aktionen: Als Nächstes + Schnellaktionen */}
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="start-naechstes" className="space-y-2">
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

        <section aria-labelledby="start-aktionen" className="space-y-2">
          <h2 id="start-aktionen" className="text-base font-semibold">
            Schnellaktionen
          </h2>
          <div data-testid="start-actions" className="grid gap-3 sm:grid-cols-2">
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

      {/* Anpassen-Dialog «Heute»-Widgets (Auswahl + Reihenfolge, nur echte Quellen) */}
      <Dialog open={widgetsOpen} onOpenChange={(open) => !open && setWidgetsOpen(false)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bereich «Heute» anpassen</DialogTitle>
            <DialogDescription>
              Widgets wählen und ordnen. Angeboten werden nur Widgets mit echter Datenquelle —
              Google-Bewertungen und Inventur fehlen bewusst (keine Anbindung bzw. kein Datenmodell).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-0.5">
            {draftWidgets.map((id, idx) => {
              const def = HEUTE_WIDGET_DEFS.find((d) => d.id === id);
              if (!def) return null;
              return (
                <div
                  key={id}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
                  data-testid={`start-widget-pick-${id}`}
                >
                  <Checkbox checked onCheckedChange={() => toggleDraftWidget(id)} id={`widget-${id}`} />
                  <label htmlFor={`widget-${id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-xs font-medium">
                      {idx + 1}. {def.title}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {def.beschreibung}
                    </span>
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === 0}
                    onClick={() => setDraftWidgets((c) => moveItem(c, idx, -1))}
                    aria-label={`${def.title} nach oben`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === draftWidgets.length - 1}
                    onClick={() => setDraftWidgets((c) => moveItem(c, idx, 1))}
                    aria-label={`${def.title} nach unten`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
            <div className="pt-1">
              {HEUTE_WIDGET_DEFS.filter(
                (d) => !draftWidgets.includes(d.id) && !(isGuest && d.guestHidden),
              ).map((def) => (
                <div key={def.id} className="flex items-center gap-2 px-2 py-1">
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => toggleDraftWidget(def.id)}
                    id={`widget-${def.id}`}
                  />
                  <label htmlFor={`widget-${def.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-xs">{def.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {def.beschreibung}
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>
          {widgetsError && <p className="text-xs text-red-600">{widgetsError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWidgetsOpen(false)}>
              Abbrechen
            </Button>
            <Button onClick={saveWidgets} data-testid="start-widgets-save">
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
