/**
 * ForatableReportPage — Foratable Report (`/foratable-report`)
 * ===========================================================
 * Zwei Blickrichtungen auf bereits importierte Reservationen (DB, mandanten-
 * gefiltert) für einen frei wählbaren Zeitraum — kein Upload, kein Import:
 *
 *  1. ZUKUNFT (oben): Zukunftsübersicht + kompakte Kalenderübersicht ab heute.
 *     Werte identisch zur CRM-Auswertung (zentrale Logik in foratable-future.ts
 *     bzw. reservation-dashboard.ts: countInRange/aggregateReservationsByDay).
 *  2. REPORT (unten): bestehende Auswertung (Kennzahlen, Status, beste Zeiten).
 *     Identisch zur CSV-Vorschau im Import (`ReservationSummary`).
 *
 * Datenschutz: Reservationen enthalten personenbezogene Daten — Zugriff nur für
 * eingeloggte Admins (RLS auf `authenticated`; Gäste ausgeschlossen). Sowohl
 * Report als auch Kalender-Popup zeigen ausschliesslich Aggregate, keine
 * Einzelgast-Daten.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart2, CalendarRange, Loader2, Printer, FileDown, AlertTriangle, Clock, ChevronDown,
} from 'lucide-react';
import { Navigate, Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  ReservationSummary, fdate, NUM0, NUM1, STATUS_LABEL,
} from '@/components/reservations/ReservationSummary';
import {
  FutureReservationsOverview, FutureCalendarSection,
} from '@/components/foratable/FutureReservationsSection';
import { loadForatableReport } from '@/lib/foratable-report-db';
import { loadFutureReservationRows } from '@/lib/foratable-future-db';
import type { ForatableReport } from '@/lib/foratable-report';
import {
  futureQuickRange, buildFutureOverview,
  type FutureRange, type FutureRangeKind, type FutureMetric,
} from '@/lib/foratable-future';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';
import { sortTimeSlots, topTimeSlots } from '@/lib/reservation-time-analysis';
import type { TimeSortKey } from '@/lib/reservation-time-analysis';

const QUICK_RANGES: Array<{ kind: Exclude<FutureRangeKind, 'custom'>; label: string }> = [
  { kind: 'current-month', label: 'Aktueller Monat' },
  { kind: 'next-7',  label: 'Nächste 7 Tage' },
  { kind: 'next-14', label: 'Nächste 14 Tage' },
  { kind: 'next-30', label: 'Nächste 30 Tage' },
];

const PCT = new Intl.NumberFormat('de-CH', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });

/** Lokales Heute als „yyyy-MM-dd" (nicht UTC — Schweizer Zeitzone). */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ForatableReportPage() {
  const { tenantId, tenant } = useTenant();
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  // usePermissions().isAdmin schliesst Gast-Sessions ein — hier explizit ausschliessen
  // (read-only Gäste-Links dürfen keine Reservationsdaten abfragen).
  const canView = isAdmin && !isGuest;

  const [today] = useState(todayIso);
  const [applied, setApplied] = useState<FutureRange>(() => futureQuickRange('current-month', todayIso()));
  const [from, setFrom] = useState(() => applied.from);
  const [to, setTo] = useState(() => applied.to);

  const [report, setReport] = useState<ForatableReport | null>(null);
  const [futureRows, setFutureRows] = useState<ReservationDetailRow[]>([]);
  const [metric, setMetric] = useState<FutureMetric>('persons');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(true);
  // „Beste Reservationszeiten": Sortierung (Anzahl/Personen) + Top 10 / Alle Zeiten.
  const [timeSort, setTimeSort] = useState<TimeSortKey>('count');
  const [showAllTimes, setShowAllTimes] = useState(false);

  const runReport = useCallback(async (range: FutureRange) => {
    if (!canView) return; // niemals Daten für nicht berechtigte Sessions laden
    if (range.from > range.to) {
      setError('Das Von-Datum darf nicht nach dem Bis-Datum liegen.');
      return;
    }
    setLoading(true);
    setError(null);
    setApplied(range);
    try {
      // Report (voller Bereich) + Zukunfts-Rohzeilen (ab heute) parallel laden.
      const [rep, fRows] = await Promise.all([
        loadForatableReport(tenantId, { from: range.from, to: range.to }),
        loadFutureReservationRows(tenantId, today, range.to),
      ]);
      setReport(rep);
      setFutureRows(fRows);
      setShowAllTimes(false); // neuer Zeitraum → wieder Top 10 zeigen
    } catch (e) {
      setReport(null);
      setFutureRows([]);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error('Report konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, canView, today]);

  // Initial + bei Mandantenwechsel den aktuell gewählten Zeitraum laden.
  useEffect(() => {
    if (!canView) return; // kein DB-Zugriff vor dem Redirect für nicht berechtigte Nutzer
    runReport(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, canView]);

  // Zukunftsübersicht + Kalender aus den (ab heute geladenen) Rohzeilen — rein,
  // reagiert auf Kennzahl-Umschalter ohne Neuladen.
  const overview = useMemo(
    () => buildFutureOverview(futureRows, applied, today, metric),
    [futureRows, applied, today, metric],
  );

  const applyQuick = (kind: Exclude<FutureRangeKind, 'custom'>) => {
    const range = futureQuickRange(kind, today);
    setFrom(range.from);
    setTo(range.to);
    runReport(range);
  };

  const applyCustom = () => runReport({ kind: 'custom', from, to });

  const handlePrint = () => window.print();

  // Anzeige-Zeitfenster: sortiert nach aktiver Kennzahl, optional auf Top 10 begrenzt.
  const displayedTimeSlots = useMemo(() => {
    if (!report) return [];
    const sorted = sortTimeSlots(report.timeAnalysis.slots, timeSort);
    return showAllTimes ? sorted : topTimeSlots(sorted, 10);
  }, [report, timeSort, showAllTimes]);
  const maxTimeMetric = displayedTimeSlots.length > 0
    ? (timeSort === 'persons' ? displayedTimeSlots[0].persons : displayedTimeSlots[0].count)
    : 0;

  const handlePdf = () => {
    if (!report) return;
    const { stats } = report;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Foratable Report', 14, 18);
    doc.setFontSize(10);
    doc.text(tenant.name, 14, 25);
    doc.text(`Zeitraum: ${fdate(report.range.from)} – ${fdate(report.range.to)}`, 14, 31);

    autoTable(doc, {
      startY: 37,
      head: [['Kennzahl', 'Wert']],
      body: [
        ['Reservationen', NUM0.format(stats.reservationCount)],
        ['Personen', NUM0.format(stats.totalPersons)],
        ['Ø Gruppengrösse', stats.avgPartySize !== null ? NUM1.format(stats.avgPartySize) : '—'],
        ['Abgeschlossen', NUM0.format(stats.completedCount)],
        ['Storniert', NUM0.format(stats.cancelledCount)],
        ['No-Show', NUM0.format(stats.noshowCount)],
        ['Neue Gäste', NUM0.format(report.newGuests)],
        ['Wiederkehrende Gäste', NUM0.format(report.returningGuests)],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });

    const nextY = () => (doc as any).lastAutoTable.finalY + 6;

    if (stats.statusDistribution.length > 0) {
      autoTable(doc, {
        startY: nextY(),
        head: [['Status', 'Bezeichnung', 'Anzahl']],
        body: stats.statusDistribution.map((s) => [STATUS_LABEL[s.normalized], s.status, NUM0.format(s.count)]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 41, 59] },
      });
    }
    const pdfTimes = topTimeSlots(sortTimeSlots(report.timeAnalysis.slots, 'count'), 10);
    if (pdfTimes.length > 0) {
      autoTable(doc, {
        startY: nextY(),
        head: [['Zeit', 'Reservationen', 'Personen', '% Res.', '% Pers.']],
        body: pdfTimes.map((t) => [
          t.time, NUM0.format(t.count), NUM0.format(t.persons),
          PCT.format(t.shareCount), PCT.format(t.sharePersons),
        ]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 41, 59] },
      });
    }
    if (stats.rooms.length > 0) {
      autoTable(doc, {
        startY: nextY(),
        head: [['Raum', 'Anzahl']],
        body: stats.rooms.map((r) => [r.name, NUM0.format(r.count)]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 41, 59] },
      });
    }
    if (stats.areas.length > 0) {
      autoTable(doc, {
        startY: nextY(),
        head: [['Bereich', 'Anzahl']],
        body: stats.areas.map((a) => [a.name, NUM0.format(a.count)]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 41, 59] },
      });
    }

    doc.save(`foratable-report-${report.range.from}_${report.range.to}.pdf`);
  };

  if (!canView) return <Navigate to="/" replace />;

  return (
    <PageShell
      width="default"
      header={
        <PageHeader
          icon={<BarChart2 />}
          title="Foratable Report"
          info="Auswertung bereits importierter Reservationen für einen frei wählbaren Zeitraum — mit Ausblick auf zukünftige Reservationen. Zeigt nur Aggregate, keine Einzelgast-Daten."
          meta={`${tenant.name} · ${fdate(applied.from)} – ${fdate(applied.to)}`}
          actions={
            <>
              {report && (
                <>
                  <Button variant="outline" size="sm" onClick={handlePrint} className="print:hidden">
                    <Printer className="h-4 w-4 mr-1.5" /> Drucken
                  </Button>
                  <Button variant="outline" size="sm" onClick={handlePdf} className="print:hidden">
                    <FileDown className="h-4 w-4 mr-1.5" /> PDF
                  </Button>
                </>
              )}
              <Link
                to="/foratable-import"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/60 print:hidden"
              >
                <CalendarRange className="h-4 w-4" />
                Zum Import
              </Link>
            </>
          }
        />
      }
    >
      {/* (B) Zukunftsübersicht */}
      <FutureReservationsOverview overview={overview} metric={metric} onMetricChange={setMetric} />

      {/* (C) Zeitraumauswahl */}
      <div className="rounded-lg border border-border bg-card p-3 space-y-3 print:hidden">
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map((q) => (
            <Button
              key={q.kind}
              variant={applied.kind === q.kind ? 'default' : 'secondary'}
              size="sm"
              onClick={() => applyQuick(q.kind)}
              disabled={loading}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="report-from">Von</Label>
            <Input
              id="report-from" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-[160px]"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to">Bis</Label>
            <Input
              id="report-to" type="date" value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-[160px]"
            />
          </div>
          <Button onClick={applyCustom} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Individuell anzeigen
          </Button>
        </div>
      </div>

      {/* (D) Kalenderübersicht (einklappbar, default zu) */}
      <FutureCalendarSection overview={overview} metric={metric} detailRows={futureRows} />

      {/* Fehler */}
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Ladezustand */}
      {loading && !report && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Report wird geladen …
        </div>
      )}

      {/* (E–G) Bestehender Report (einklappbar, Logik unverändert) */}
      {report && (
        <Collapsible open={reportOpen} onOpenChange={setReportOpen} className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">
                Report · {fdate(report.range.from)} – {fdate(report.range.to)}
              </span>
            </div>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground print:hidden"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', reportOpen && 'rotate-180')} />
                {reportOpen ? 'Report einklappen' : 'Report anzeigen'}
              </button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="space-y-4">
            {report.stats.reservationCount === 0 ? (
              <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                Keine importierten Reservationen in diesem Zeitraum.
              </div>
            ) : (
              <ReservationSummary
                stats={report.stats}
                newGuests={report.newGuests}
                returningGuests={report.returningGuests}
                hideTopTimes
              />
            )}

            {report.stats.reservationCount > 0 && (
              <section className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Clock className="h-5 w-5 text-primary" /> Beste Reservationszeiten
                  </h2>
                  <div className="flex items-center gap-2 print:hidden">
                    <div className="inline-flex rounded-lg border border-border overflow-hidden text-sm">
                      <button
                        type="button"
                        onClick={() => setTimeSort('count')}
                        aria-pressed={timeSort === 'count'}
                        className={cn(
                          'px-3 py-1.5 transition-colors',
                          timeSort === 'count' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60',
                        )}
                      >
                        Reservationen
                      </button>
                      <button
                        type="button"
                        onClick={() => setTimeSort('persons')}
                        aria-pressed={timeSort === 'persons'}
                        className={cn(
                          'px-3 py-1.5 border-l border-border transition-colors',
                          timeSort === 'persons' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60',
                        )}
                      >
                        Personen
                      </button>
                    </div>
                    {report.timeAnalysis.slots.length > 10 && (
                      <Button variant="outline" size="sm" onClick={() => setShowAllTimes((s) => !s)}>
                        {showAllTimes ? 'Top 10' : 'Alle Zeiten'}
                      </Button>
                    )}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Reservationen mit Uhrzeit, ohne Stornos &amp; No-Shows
                  {` · ${NUM0.format(report.timeAnalysis.totalReservations)} Reservationen · ${NUM0.format(report.timeAnalysis.totalPersons)} Personen`}
                  {report.timeAnalysis.ignoredNoTime > 0 &&
                    ` · ${NUM0.format(report.timeAnalysis.ignoredNoTime)} ohne Uhrzeit nicht berücksichtigt`}
                </p>

                {displayedTimeSlots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Keine Reservationszeiten im gewählten Zeitraum.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                          <th className="py-2 pr-3 text-left font-medium">Zeit</th>
                          <th className="py-2 px-3 text-right font-medium">Reservationen</th>
                          <th className="py-2 px-3 text-right font-medium">Personen</th>
                          <th className="py-2 px-3 text-right font-medium">% Res.</th>
                          <th className="py-2 pl-3 text-right font-medium">% Pers.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedTimeSlots.map((slot, i) => {
                          const metricVal = timeSort === 'persons' ? slot.persons : slot.count;
                          const barPct = maxTimeMetric > 0 ? (metricVal / maxTimeMetric) * 100 : 0;
                          const strongest = i === 0;
                          return (
                            <tr
                              key={slot.time}
                              className={cn('border-b border-border/60 last:border-0', strongest && 'bg-primary/5')}
                            >
                              <td className="py-2 pr-3 align-top">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium tabular-nums">{slot.time}</span>
                                  {strongest && (
                                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary print:hidden">
                                      Spitze
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 h-1.5 w-full min-w-[80px] overflow-hidden rounded-full bg-muted print:hidden">
                                  <div
                                    className={cn('h-full rounded-full', strongest ? 'bg-primary' : 'bg-primary/40')}
                                    style={{ width: `${barPct}%` }}
                                  />
                                </div>
                              </td>
                              <td className={cn('py-2 px-3 text-right tabular-nums', timeSort === 'count' && 'font-semibold')}>
                                {NUM0.format(slot.count)}
                              </td>
                              <td className={cn('py-2 px-3 text-right tabular-nums', timeSort === 'persons' && 'font-semibold')}>
                                {NUM0.format(slot.persons)}
                              </td>
                              <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                                {PCT.format(slot.shareCount)}
                              </td>
                              <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">
                                {PCT.format(slot.sharePersons)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </PageShell>
  );
}
