/**
 * CrmAuswertungPage — Gäste-CRM (Auswertung / Dashboard)
 * =======================================================
 * Admin-only Auswertungsseite mit drei Blöcken:
 *  1. Gäste-Überblick (aktiv/inaktiv/neu/Wiederkehrerquote/Segmente/No-Show-Risiko)
 *  2. Zukunftsreservationen (laufender/nächster Monat, nächste 30/60/90 Tage,
 *     offene/nicht beantwortete separat)
 *  3. Individueller Zeitraum (Anzahl Reservationen + Personen)
 *
 * Liest ausschliesslich aus den bestehenden Tabellen `guest_profiles` und
 * `reservation_records` (keine neue Migration, keine Schreibzugriffe, keine
 * Änderung an der Import-Logik).  Kennzahlen werden in der App berechnet
 * (siehe reservation-dashboard.ts).  Keine PII-Anzeige/-Logs.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart3, Loader2, Database, ArrowLeft, Users, UserCheck, UserX,
  UserPlus, Repeat, Star, Crown, CircleSlash, Ban, CalendarClock,
  CalendarDays, CalendarRange, CalendarSearch, HelpCircle,
} from 'lucide-react';
import {
  format as fmtDate, endOfMonth, startOfMonth, addMonths, addDays,
} from 'date-fns';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import {
  fetchGuestProfiles, fetchCompletedVisitAggregates, fetchNoShowCountsByGuest,
  fetchFutureReservations, fetchReservationsInRange,
} from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import {
  guestListMetrics, type CompletedVisitAgg,
} from '@/lib/reservation-crm';
import {
  guestDashboardKpis, futureReservationKpis, countInRange,
  isActiveStatus, isOpenStatus,
  type ReservationAggRow, type RangeCount, type FutureBoundaries,
} from '@/lib/reservation-dashboard';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)} %`;
}

function persons(n: number): string {
  return `${NUM0.format(n)} ${n === 1 ? 'Person' : 'Personen'}`;
}

// ── Kachel ────────────────────────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, sub, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', accent)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.FC<{ className?: string }>; children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
      <Icon className="h-5 w-5 text-primary" />
      {children}
    </h2>
  );
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function CrmAuswertungPage() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof fetchGuestProfiles>>>([]);
  const [visitAggs, setVisitAggs] = useState<Map<string, CompletedVisitAgg>>(new Map());
  const [noShowCounts, setNoShowCounts] = useState<Map<string, number>>(new Map());
  const [futureRows, setFutureRows] = useState<ReservationAggRow[]>([]);

  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => fmtDate(today, 'yyyy-MM-dd'), [today]);

  const boundaries = useMemo<FutureBoundaries>(() => ({
    today:          todayStr,
    endOfMonth:     fmtDate(endOfMonth(today), 'yyyy-MM-dd'),
    startNextMonth: fmtDate(startOfMonth(addMonths(today, 1)), 'yyyy-MM-dd'),
    endNextMonth:   fmtDate(endOfMonth(addMonths(today, 1)), 'yyyy-MM-dd'),
    plus30:         fmtDate(addDays(today, 30), 'yyyy-MM-dd'),
    plus60:         fmtDate(addDays(today, 60), 'yyyy-MM-dd'),
    plus90:         fmtDate(addDays(today, 90), 'yyyy-MM-dd'),
  }), [today, todayStr]);

  // ── Individueller Zeitraum ───────────────────────────────────────────────────
  const [rangeFrom, setRangeFrom] = useState(todayStr);
  const [rangeTo, setRangeTo] = useState(() => fmtDate(addDays(new Date(), 30), 'yyyy-MM-dd'));
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeResult, setRangeResult] = useState<{ active: RangeCount; open: RangeCount; from: string; to: string } | null>(null);
  const rangeEmpty = !rangeFrom || !rangeTo;
  const rangeInvalid = rangeEmpty || rangeFrom > rangeTo;

  const load = useCallback(async () => {
    if (!isAdmin) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins
    setLoading(true);
    const ok = await checkReservationTablesExist();
    setTablesOk(ok);
    if (ok) {
      const [ps, aggs, ns, fut] = await Promise.all([
        fetchGuestProfiles(tenantId),
        fetchCompletedVisitAggregates(tenantId),
        fetchNoShowCountsByGuest(tenantId),
        fetchFutureReservations(tenantId, todayStr),
      ]);
      setProfiles(ps);
      setVisitAggs(aggs);
      setNoShowCounts(ns);
      setFutureRows(fut);
    } else {
      setProfiles([]);
      setVisitAggs(new Map());
      setNoShowCounts(new Map());
      setFutureRows([]);
    }
    setLoading(false);
  }, [tenantId, isAdmin, todayStr]);

  useEffect(() => { void load(); }, [load]);

  const guestKpis = useMemo(() => {
    const metrics = profiles.map(p => guestListMetrics(p, visitAggs.get(p.id), todayStr));
    return guestDashboardKpis(metrics, noShowCounts, todayStr);
  }, [profiles, visitAggs, noShowCounts, todayStr]);

  const futureKpis = useMemo(
    () => futureReservationKpis(futureRows, boundaries),
    [futureRows, boundaries],
  );

  const runRange = useCallback(async () => {
    if (rangeInvalid) return;
    setRangeLoading(true);
    const rows = await fetchReservationsInRange(tenantId, rangeFrom, rangeTo);
    setRangeResult({
      active: countInRange(rows, rangeFrom, rangeTo, isActiveStatus),
      open:   countInRange(rows, rangeFrom, rangeTo, isOpenStatus),
      from:   rangeFrom,
      to:     rangeTo,
    });
    setRangeLoading(false);
  }, [tenantId, rangeFrom, rangeTo, rangeInvalid]);

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      {/* Kopf */}
      <div className="space-y-2">
        <button
          onClick={() => navigate('/gaeste')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Zurück zur Gästeliste
        </button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <BarChart3 className="h-6 w-6 text-primary" />
            CRM Auswertung
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gäste-Kennzahlen und Zukunftsreservationen — berechnet aus den
            importierten Reservationen ({tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv'}).
          </p>
        </div>
      </div>

      {tablesOk === false && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <Database className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Die Reservationstabellen existieren noch nicht. Bitte zuerst die
            Migration ausführen und Reservationen importieren.
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Auswertung wird geladen…
        </div>
      ) : tablesOk ? (
        <>
          {/* 1. Gäste-Überblick */}
          <section>
            <SectionTitle icon={Users}>Gäste-Überblick</SectionTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Kpi icon={Users} label="Gäste total" value={NUM0.format(guestKpis.totalGuests)} />
              <Kpi icon={UserCheck} label="Aktiv (≤ 90 Tage)" value={NUM0.format(guestKpis.activeGuests)} accent="text-emerald-600 dark:text-emerald-400" />
              <Kpi icon={UserX} label="Inaktiv (> 90 Tage)" value={NUM0.format(guestKpis.inactiveGuests)} accent="text-red-600 dark:text-red-400" />
              <Kpi icon={UserPlus} label="Neu (letzte 30 Tage)" value={NUM0.format(guestKpis.newGuests30)} accent="text-emerald-600 dark:text-emerald-400" />
              <Kpi icon={Repeat} label="Wiederkehrerquote" value={pct(guestKpis.repeatRatePct)} sub="≥ 2 Besuche / ≥ 1 Besuch" />
              <Kpi icon={Crown} label="VIP" value={NUM0.format(guestKpis.vipGuests)} accent="text-amber-600 dark:text-amber-400" />
              <Kpi icon={Star} label="Stammgäste" value={NUM0.format(guestKpis.stammgaeste)} accent="text-violet-600 dark:text-violet-400" />
              <Kpi icon={CircleSlash} label="Ohne Besuch" value={NUM0.format(guestKpis.guestsWithoutVisit)} />
              <Kpi icon={Ban} label="No-Show-Risiko (≥ 2)" value={NUM0.format(guestKpis.noShowRiskGuests)} accent="text-orange-600 dark:text-orange-400" sub="Gäste mit ≥ 2 No-Shows" />
            </div>
          </section>

          {/* 2. Zukunftsreservationen */}
          <section>
            <SectionTitle icon={CalendarClock}>Zukünftige Reservationen</SectionTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Aktive Reservationen = bestätigt oder abgeschlossen. Stornos und
              No-Shows zählen nicht. Offene / nicht beantwortete werden separat
              ausgewiesen.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Kpi icon={CalendarDays} label="Laufender Monat" value={NUM0.format(futureKpis.currentMonth.reservations)} sub={persons(futureKpis.currentMonth.persons)} accent="text-primary" />
              <Kpi icon={CalendarDays} label="Nächster Monat" value={NUM0.format(futureKpis.nextMonth.reservations)} sub={persons(futureKpis.nextMonth.persons)} />
              <Kpi icon={CalendarRange} label="Nächste 30 Tage" value={NUM0.format(futureKpis.next30.reservations)} sub={persons(futureKpis.next30.persons)} />
              <Kpi icon={CalendarRange} label="Nächste 60 Tage" value={NUM0.format(futureKpis.next60.reservations)} sub={persons(futureKpis.next60.persons)} />
              <Kpi icon={CalendarRange} label="Nächste 90 Tage" value={NUM0.format(futureKpis.next90.reservations)} sub={persons(futureKpis.next90.persons)} />
              <Kpi icon={HelpCircle} label="Offen / unbeantwortet (90 T.)" value={NUM0.format(futureKpis.openNext90.reservations)} sub={persons(futureKpis.openNext90.persons)} accent="text-slate-500 dark:text-slate-400" />
            </div>
          </section>

          {/* 3. Individueller Zeitraum */}
          <section>
            <SectionTitle icon={CalendarSearch}>Individueller Zeitraum</SectionTitle>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Von
                  <input
                    type="date"
                    value={rangeFrom}
                    onChange={e => setRangeFrom(e.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Bis
                  <input
                    type="date"
                    value={rangeTo}
                    onChange={e => setRangeTo(e.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <button
                  onClick={() => void runRange()}
                  disabled={rangeInvalid || rangeLoading}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rangeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarSearch className="h-4 w-4" />}
                  Auswerten
                </button>
              </div>

              {rangeInvalid && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                  {rangeEmpty
                    ? 'Bitte „Von“ und „Bis“ auswählen.'
                    : '„Von“ darf nicht nach „Bis“ liegen.'}
                </p>
              )}

              {rangeResult && !rangeInvalid && (
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Kpi icon={CalendarRange} label="Aktive Reservationen" value={NUM0.format(rangeResult.active.reservations)} accent="text-primary" />
                  <Kpi icon={Users} label="Personen (aktiv)" value={NUM0.format(rangeResult.active.persons)} />
                  <Kpi icon={HelpCircle} label="Offen / unbeantwortet" value={NUM0.format(rangeResult.open.reservations)} accent="text-slate-500 dark:text-slate-400" />
                  <Kpi icon={Users} label="Personen (offen)" value={NUM0.format(rangeResult.open.persons)} />
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
