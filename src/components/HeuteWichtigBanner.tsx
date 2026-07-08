/**
 * HeuteWichtigBanner — Kompakte Warnleiste „Heute wichtig" für das Dashboard.
 * ===========================================================================
 * UX-Vereinfachung Phase 2: Zeigt NUR echte Handlungsbedarfe (Status `action`
 * aus `useStartOverview` — dieselbe Single Source of Truth wie Startseite und
 * Import-Cockpit, KEINE eigenen Frische-Regeln) plus vier Schnellaktionen.
 *
 * STRIKT READ-ONLY und rein additiv: keine Berechnung, kein Schreibpfad.
 * Gast-Sessions sehen keine schreib-/PII-orientierten Schnellaktionen
 * (gleiche Regeln wie StartOverview).
 */

import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Contact,
  Loader2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useStartOverview } from '@/hooks/useStartOverview';

interface QuickAction {
  label: string;
  route: string;
  icon: React.FC<{ className?: string }>;
  /** Für Gast-Sessions ausblenden (Schreibaktion oder PII-Seite). */
  hiddenForGuest?: boolean;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Import starten', route: '/import', icon: Upload, hiddenForGuest: true },
  { label: 'Tagesabschluss öffnen', route: '/tagesabschluesse', icon: ClipboardCheck, hiddenForGuest: true },
  { label: 'Dienstplan öffnen', route: '/personal', icon: CalendarClock },
  { label: 'Reservationen öffnen', route: '/gaeste', icon: Contact, hiddenForGuest: true },
];

export function HeuteWichtigBanner() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { state } = useStartOverview(isAdmin);

  // Nur für Admins (inkl. Gast-Lesezugriff) — Manager sehen das Dashboard ohne Banner.
  if (!isAdmin) return null;

  const actions = QUICK_ACTIONS.filter((a) => !(isGuest && a.hiddenForGuest));

  return (
    <section aria-label="Heute wichtig" className="space-y-2" data-testid="heute-wichtig">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Heute wichtig
        </h2>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="heute-wichtig-actions">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Button key={action.route} variant="outline" size="sm" className="h-7 text-xs" asChild>
                <Link to={action.route}>
                  <Icon className="h-3.5 w-3.5 mr-1.5" />
                  {action.label}
                </Link>
              </Button>
            );
          })}
        </div>
      </div>

      {state.status === 'loading' && (
        <div
          data-testid="heute-wichtig-loading"
          className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Status wird geladen …
        </div>
      )}

      {state.status === 'error' && (
        <div
          data-testid="heute-wichtig-error"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          Statusübersicht konnte nicht geladen werden: {state.message}
        </div>
      )}

      {state.status === 'ready' && state.data.warnings.length === 0 && (
        <div
          data-testid="heute-wichtig-ok"
          className="flex items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
          Keine offenen Handlungsbedarfe.
        </div>
      )}

      {state.status === 'ready' && state.data.warnings.length > 0 && (
        <ul data-testid="heute-wichtig-warnings" className="space-y-1.5">
          {state.data.warnings.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs dark:border-red-800 dark:bg-red-950/40"
            >
              <span className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                {w.text}
              </span>
              <Link
                to={w.route}
                className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:underline dark:text-red-300"
              >
                Öffnen <ArrowRight className="h-3 w-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
