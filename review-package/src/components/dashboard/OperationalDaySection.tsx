/**
 * OperationalDaySection — Operativer Tagesstand (Dashboard, Bereich 2).
 * =====================================================================
 * REIN LESEND und rein darstellend: alle Werte werden vom Dashboard aus den
 * BESTEHENDEN operativen Quellen übergeben — Tagesumsatz aus Z-Bericht/
 * Tageserfassung (dailyBudgets), Stunden aus Dienstplan/Mirus, Status-Karten
 * (Reservationen/Tagesabschluss) und offene Aufgaben aus useStartOverview
 * (dieselbe SSoT wie Startseite und Import-Cockpit — KEINE eigene Frische-
 * oder Statuslogik hier).
 *
 * Operative Werte sind KEIN Ersatz für finanzielle Registry-Werte; fehlend
 * bleibt „—" (fehlend ≠ 0).
 */

import { useNavigate } from 'react-router-dom';
import { KpiCard } from '@/components/ui/kpi-card';
import type { Tone } from '@/components/ui/tones';
import type { StartOverviewState } from '@/hooks/useStartOverview';
import type { StartCard, StartCardStatus } from '@/lib/start-overview-utils';

const DASH = '—';

function fmtCHF(v: number | null): string {
  if (v === null) return DASH;
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(v);
}

function fmtHours(v: number | null): string {
  if (v === null) return DASH;
  return `${v.toFixed(1)} h`;
}

/** Karten-Status (SSoT start-overview-utils) → zentraler Designsystem-Ton. */
const STATUS_TONE: Record<StartCardStatus, Tone> = {
  ok: 'good',
  due_soon: 'warn',
  action: 'critical',
  unknown: 'neutral',
};

export function OperationalDaySection({
  dayLabel,
  revenueToday,
  revenueBasisLabel,
  plannedHoursToday,
  actualHoursToday,
  plannedCostToday,
  todayInLoadedMonth,
  canSeeRevenue,
  canSeeCosts,
  overview,
}: {
  /** Anzeige-Label des heutigen Tags, z. B. „Mittwoch, 15. Juli 2026". */
  dayLabel: string;
  /** Heutiger Tagesumsatz (Z-Bericht/Tageserfassung, Anzeigebasis) — null = nicht erfasst. */
  revenueToday: number | null;
  /** „netto" | „brutto" — folgt dem globalen Umsatzbasis-Schalter. */
  revenueBasisLabel: string;
  /** Heutige Dienstplan-Stunden — null = Monat nicht geladen / keine Daten. */
  plannedHoursToday: number | null;
  /** Heutige Ist-Stunden (Mirus/Erfassung) — null = Monat nicht geladen / keine Daten. */
  actualHoursToday: number | null;
  /** Geplante Personalkosten heute gemäss Dienstplan (inkl. AG-Kosten) — null = nicht verfügbar. */
  plannedCostToday: number | null;
  /** false, wenn ein anderer Monat angezeigt wird (Stunden/Kosten dann nicht geladen). */
  todayInLoadedMonth: boolean;
  canSeeRevenue: boolean;
  canSeeCosts: boolean;
  /** Status aus useStartOverview (Admin) — null = für diese Rolle nicht geladen. */
  overview: StartOverviewState | null;
}) {
  const navigate = useNavigate();

  const loadingOverview = overview?.status === 'loading';
  const errorOverview = overview?.status === 'error';
  const ready = overview && overview.status === 'ready' ? overview : null;

  const card = (id: StartCard['id']): StartCard | null =>
    ready?.data.cards.find(c => c.id === id) ?? null;

  const reservationen = card('reservationen');
  const tagesabschluss = card('tagesabschluss');

  const openTasksCount = ready
    ? (ready.todayTasks === null ? null : ready.todayTasks.length)
    : null;

  const statusValue = (c: StartCard | null): string =>
    loadingOverview ? '…' : c ? c.statusLabel : DASH;
  const statusSub = (c: StartCard | null): string =>
    loadingOverview ? 'Status wird geladen …'
    : errorOverview ? 'Status nicht verfügbar'
    : c ? c.detail : 'Keine Daten';
  const statusTone = (c: StartCard | null): Tone =>
    c ? STATUS_TONE[c.status] : 'neutral';

  const hoursHint = todayInLoadedMonth
    ? 'Dienstplan / Mirus'
    : 'Anderer Monat angezeigt — heutige Daten nicht geladen';

  return (
    <section aria-label="Operativer Tagesstand" className="space-y-2" data-testid="operational-day-section">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Operativer Tagesstand · heute
        </h2>
        <p className="text-[11px] text-muted-foreground">{dayLabel}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {canSeeRevenue && (
          <KpiCard
            label="Tagesumsatz gemäss Z-Bericht"
            value={fmtCHF(revenueToday)}
            tone={revenueToday === null ? 'neutral' : 'good'}
            sub={`Tageserfassung · ${revenueBasisLabel}`}
            onClick={() => navigate('/tagesabschluesse')}
            data-testid="op-kpi-tagesumsatz"
          />
        )}

        {overview !== null && (
          <KpiCard
            label="Reservationen (Foratable)"
            value={statusValue(reservationen)}
            tone={statusTone(reservationen)}
            sub={statusSub(reservationen)}
            onClick={reservationen ? () => navigate(reservationen.route) : undefined}
            data-testid="op-kpi-reservationen"
          />
        )}

        <KpiCard
          label="Arbeitsstunden heute"
          value={fmtHours(actualHoursToday)}
          tone="info"
          sub={`Plan ${fmtHours(plannedHoursToday)} · ${hoursHint}`}
          onClick={() => navigate('/personal')}
          data-testid="op-kpi-stunden"
        />

        {canSeeCosts && (
          <KpiCard
            label="Geplante Personalkosten gemäss Dienstplan"
            value={fmtCHF(plannedCostToday)}
            tone={plannedCostToday === null ? 'neutral' : 'info'}
            sub={todayInLoadedMonth
              ? 'heute · inkl. AG-Kosten'
              : 'Anderer Monat angezeigt — heutige Daten nicht geladen'}
            onClick={() => navigate('/personal')}
            data-testid="op-kpi-plankosten"
          />
        )}

        {overview !== null && (
          <KpiCard
            label="Tagesabschluss / Adyen"
            value={statusValue(tagesabschluss)}
            tone={statusTone(tagesabschluss)}
            sub={statusSub(tagesabschluss)}
            onClick={() => navigate('/tagesabschluesse')}
            data-testid="op-kpi-tagesabschluss"
          />
        )}

        {overview !== null && (
          <KpiCard
            label="Offene Aufgaben"
            value={loadingOverview ? '…' : openTasksCount === null ? DASH : String(openTasksCount)}
            tone={
              loadingOverview ? 'neutral'
              : openTasksCount === null ? 'neutral'
              : openTasksCount === 0 ? 'good'
              : 'warn'
            }
            sub={
              loadingOverview ? 'Status wird geladen …'
              : errorOverview ? 'Status nicht verfügbar'
              : ready?.coverageError ? 'Aufgabenstand nicht verfügbar'
              : 'Import & Kontrollen heute'
            }
            onClick={() => navigate('/import')}
            data-testid="op-kpi-aufgaben"
          />
        )}
      </div>
    </section>
  );
}
