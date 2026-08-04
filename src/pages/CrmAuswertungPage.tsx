/**
 * CrmAuswertungPage — „Gäste & Reservationen" (`/gaeste/auswertung`)
 * ==================================================================
 * Zusammengeführte Admin-Seite aus der früheren „CRM Auswertung" und dem
 * „Foratable Report". Aufbau von oben nach unten:
 *
 *  A) Seitenkopf (PageShell/PageHeader) mit Drucken/PDF/„Zum Import".
 *  B) Zukünftige Reservationen — 4 klickbare KPI-Karten (Drilldown-Dialoge).
 *  C) Zeitraum-Auswahl (Aktueller Monat / Nächste 7/14/30 Tage / Individuell).
 *  D) Kompakte Kalenderübersicht (einklappbar, default zu).
 *  E) Tages-Popup mit (admin-gegateter) Reservationsliste + Status-Filtern
 *     sowie ein Zeitraum-Popup für die Summen-Karten.
 *  F) CRM-Reiter: Überblick (Gäste-Kennzahlen) / Rückkehrpotenzial / Kampagnen.
 *  G) Klassischer Report (einklappbar): Kennzahlen, Status, beste Zeiten.
 *
 * Datenschutz: Reservationen enthalten PII — Zugriff nur für eingeloggte Admins
 * (`isAdmin`), gegatet auf Route-Guard UND in beiden Lade-Effekten.
 * Liest ausschliesslich aus bestehenden Tabellen — keine Migration, keine
 * Schreibzugriffe, keine Änderung an Import-/CRM-Logik. Zahlen aus der zentralen
 * Logik (reservation-dashboard.ts / foratable-future.ts) — Single Source of Truth.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Users, RotateCcw, Megaphone, BarChart3, Hourglass, AlertTriangle,
  Eye, ArrowLeft, CalendarRange,
  Loader2, Printer, Clock, ChevronDown,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useNavigate, Navigate, useSearchParams, Link } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { UnifiedExportButton } from '@/components/UnifiedExportButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { DIALOG_LG } from '@/components/ui/dialog-size';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { HintBox } from '@/components/ui/hint-box';
import {
  TABLE, TABLE_SCROLL, TABLE_WRAP, TH, TH_NUM, TH_STICKY, TD, TD_NUM, ROW_CLICKABLE,
} from '@/components/ui/table-style';

import { SegmentBadge } from '@/components/crm/SegmentBadge';
import { ReservationDetailList } from '@/components/crm/ReservationDetailList';
import { GuestProfileLink } from '@/components/crm/GuestProfileLink';
import {
  ReservationSummary, STATUS_LABEL,
} from '@/components/reservations/ReservationSummary';
import {
  FutureReservationsOverview, FutureCalendarSection, DayReservationsDialog,
} from '@/components/foratable/FutureReservationsSection';

import {
  fetchGuestProfiles, fetchCompletedVisitAggregates, fetchNoShowCountsByGuest,
} from '@/lib/reservation-crm-db';
import { fetchGuestCrmProfilesByIds } from '@/lib/guest-crm-profile-db';
import type { GuestCrmProfile } from '@/lib/guest-crm-profile';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import {
  guestListMetrics, SEGMENT_LABEL, type CompletedVisitAgg,
} from '@/lib/reservation-crm';
import {
  guestDashboardKpis,
  returnPotentialKpis, buildReturnPotentialList,
  RETURN_POTENTIAL_HEADERS, returnPotentialRowToCells,
  filterReservationDetails, isActiveStatus,
  type ReservationDetailRow,
} from '@/lib/reservation-dashboard';
import {
  CAMPAIGNS, CAMPAIGN_BY_ID, summarizeCampaigns, filterCampaign,
  buildCampaignCsv, campaignCsvFilename, campaignExportTable,
  type CampaignDef, type CampaignId,
} from '@/lib/reservation-campaigns';
import { downloadCsv, downloadXlsx } from '@/lib/table-export';
import {
  parseCrmViewState, crmViewStateToParams, crmReturnUrl, buildGuestHref,
  type CrmTab, type CrmViewState,
} from '@/lib/crm-auswertung-url';

import { loadForatableReport } from '@/lib/foratable-report-db';
import { loadFutureReservationRows } from '@/lib/foratable-future-db';
import type { ForatableReport } from '@/lib/foratable-report';
import {
  futureQuickRange, buildFutureOverview,
  type FutureRange, type FutureRangeKind, type FutureMetric,
} from '@/lib/foratable-future';
import { sortTimeSlots, topTimeSlots, type TimeSortKey } from '@/lib/reservation-time-analysis';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat('de-CH', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${NUM0.format(n)} %`;
}

function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const v = Math.round(n);
  return `${NUM0.format(v)} ${v === 1 ? 'Tag' : 'Tage'}`;
}

// Überfälligkeit aufrunden, damit ein tatsächlich überfälliger Gast (>0) nie als
// „0 Tage" erscheint.
function overdueDays(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const v = Math.ceil(n);
  return `${NUM0.format(v)} ${v === 1 ? 'Tag' : 'Tage'}`;
}

const QUICK_RANGES: Array<{ kind: Exclude<FutureRangeKind, 'custom'>; label: string }> = [
  { kind: 'current-month', label: 'Aktueller Monat' },
  { kind: 'next-7',  label: 'Nächste 7 Tage' },
  { kind: 'next-14', label: 'Nächste 14 Tage' },
  { kind: 'next-30', label: 'Nächste 30 Tage' },
];

/** Lokales Heute als „yyyy-MM-dd" (nicht UTC — Schweizer Zeitzone). */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function CrmAuswertungPage() {
  const { tenantId, tenant } = useTenant();
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const canView = isAdmin;

  const [today] = useState(todayIso);

  // Anzeigezustand EINMALIG aus der URL lesen (refresh-fest + Rückkehr aus dem
  // Gästeprofil stellt denselben Zustand wieder her).
  const initialViewRef = useRef<CrmViewState | null>(null);
  if (initialViewRef.current === null) initialViewRef.current = parseCrmViewState(searchParams);
  const initialView = initialViewRef.current;

  const [tab, setTab] = useState<CrmTab>(initialView.tab);

  // ── CRM-Datendomäne (mandantenweit, einmal je Mandant geladen) ──────────────
  const [crmLoading, setCrmLoading] = useState(true);
  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof fetchGuestProfiles>>>([]);
  const [visitAggs, setVisitAggs] = useState<Map<string, CompletedVisitAgg>>(new Map());
  const [noShowCounts, setNoShowCounts] = useState<Map<string, number>>(new Map());
  const [crmProfiles, setCrmProfiles] = useState<Map<string, GuestCrmProfile>>(new Map());
  const [crmError, setCrmError] = useState(false);

  // ── Foratable-Zeitraum-Domäne (bei Zeitraumwechsel neu geladen) ─────────────
  const initialRange = useMemo<FutureRange>(() => {
    if (initialView.rangeKind === 'custom' && initialView.rangeFrom && initialView.rangeTo) {
      return { kind: 'custom', from: initialView.rangeFrom, to: initialView.rangeTo };
    }
    const kind = initialView.rangeKind === 'custom' ? 'current-month' : initialView.rangeKind;
    return futureQuickRange(kind, today);
  }, [initialView, today]);

  const [applied, setApplied] = useState<FutureRange>(initialRange);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [report, setReport] = useState<ForatableReport | null>(null);
  const [futureRows, setFutureRows] = useState<ReservationDetailRow[]>([]);
  const [metric, setMetric] = useState<FutureMetric>('persons');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(true);
  const [timeSort, setTimeSort] = useState<TimeSortKey>('count');
  const [showAllTimes, setShowAllTimes] = useState(false);

  // ── Drilldown-Dialoge (die Seite besitzt genau EINEN Tages- + Summen-Dialog) ─
  const [dayDate, setDayDate] = useState<string | null>(null);
  const [totalsOpen, setTotalsOpen] = useState(false);

  // ── Kampagnen ────────────────────────────────────────────────────────────────
  const [activeCampaign, setActiveCampaign] = useState<CampaignId | null>(
    initialView.campaign && CAMPAIGN_BY_ID[initialView.campaign as CampaignId]
      ? (initialView.campaign as CampaignId)
      : null,
  );

  // ── CRM laden ────────────────────────────────────────────────────────────────
  const loadCrm = useCallback(async () => {
    if (!canView) { setCrmLoading(false); return; }
    setCrmLoading(true);
    const ok = await checkReservationTablesExist();
    setTablesOk(ok);
    if (ok) {
      const [ps, aggs, ns] = await Promise.all([
        fetchGuestProfiles(tenantId),
        fetchCompletedVisitAggregates(tenantId),
        fetchNoShowCountsByGuest(tenantId),
      ]);
      setProfiles(ps);
      setVisitAggs(aggs);
      setNoShowCounts(ns);
      try {
        setCrmProfiles(await fetchGuestCrmProfilesByIds(ps.map(p => p.id)));
        setCrmError(false);
      } catch {
        setCrmProfiles(new Map());
        setCrmError(true);
      }
    } else {
      setProfiles([]);
      setVisitAggs(new Map());
      setNoShowCounts(new Map());
      setCrmProfiles(new Map());
      setCrmError(false);
    }
    setCrmLoading(false);
  }, [tenantId, canView]);

  useEffect(() => { void loadCrm(); }, [loadCrm]);

  // ── Foratable-Report + Zukunfts-Rohzeilen laden ─────────────────────────────
  const runReport = useCallback(async (range: FutureRange) => {
    if (!canView) return;
    if (range.from > range.to) {
      setReportError('Das Von-Datum darf nicht nach dem Bis-Datum liegen.');
      return;
    }
    setReportLoading(true);
    setReportError(null);
    setApplied(range);
    try {
      const [rep, fRows] = await Promise.all([
        loadForatableReport(tenantId, { from: range.from, to: range.to }),
        loadFutureReservationRows(tenantId, today, range.to),
      ]);
      setReport(rep);
      setFutureRows(fRows);
      setShowAllTimes(false);
    } catch (e) {
      setReport(null);
      setFutureRows([]);
      setReportError(e instanceof Error ? e.message : String(e));
      toast.error('Report konnte nicht geladen werden.');
    } finally {
      setReportLoading(false);
    }
  }, [tenantId, canView, today]);

  // Initial + bei Mandantenwechsel den aktuell gewählten Zeitraum laden.
  useEffect(() => {
    if (!canView) return;
    void runReport(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, canView]);

  // ── Abgeleitete CRM-Kennzahlen ──────────────────────────────────────────────
  const metrics = useMemo(
    () => profiles.map(p => guestListMetrics(
      p, visitAggs.get(p.id), today, noShowCounts.get(p.id) ?? 0, crmProfiles.get(p.id) ?? null,
    )),
    [profiles, visitAggs, noShowCounts, today, crmProfiles],
  );
  const guestKpis = useMemo(() => guestDashboardKpis(metrics, noShowCounts, today), [metrics, noShowCounts, today]);
  const returnPotential = useMemo(() => returnPotentialKpis(metrics), [metrics]);
  const overdueList = useMemo(() => buildReturnPotentialList(metrics), [metrics]);
  const campaignSummaries = useMemo(() => summarizeCampaigns(metrics, today), [metrics, today]);
  const campaignDef = useMemo<CampaignDef | null>(
    () => CAMPAIGNS.find(c => c.id === activeCampaign) ?? null,
    [activeCampaign],
  );
  const campaignRows = useMemo(
    () => (campaignDef ? filterCampaign(metrics, campaignDef, today) : []),
    [campaignDef, metrics, today],
  );

  // ── Abgeleitete Zukunfts-/Report-Werte ──────────────────────────────────────
  const overview = useMemo(
    () => buildFutureOverview(futureRows, applied, today, metric),
    [futureRows, applied, today, metric],
  );

  // Aktive Reservationen des Zukunftszeitraums (Summen-Drilldown) — dieselbe
  // Filterlogik wie die Summen-Kacheln (Single Source of Truth).
  const totalsRows = useMemo(
    () => (overview.empty ? [] : filterReservationDetails(futureRows, overview.effectiveFrom, overview.effectiveTo, isActiveStatus)),
    [overview, futureRows],
  );

  const displayedTimeSlots = useMemo(() => {
    if (!report) return [];
    const sorted = sortTimeSlots(report.timeAnalysis.slots, timeSort);
    return showAllTimes ? sorted : topTimeSlots(sorted, 10);
  }, [report, timeSort, showAllTimes]);
  const maxTimeMetric = displayedTimeSlots.length > 0
    ? (timeSort === 'persons' ? displayedTimeSlots[0].persons : displayedTimeSlots[0].count)
    : 0;

  // ── URL-Spiegelung ───────────────────────────────────────────────────────────
  const viewState = useMemo<CrmViewState>(() => ({
    tab,
    rangeKind: applied.kind,
    rangeFrom: applied.kind === 'custom' ? applied.from : null,
    rangeTo: applied.kind === 'custom' ? applied.to : null,
    campaign: activeCampaign,
  }), [tab, applied, activeCampaign]);

  useEffect(() => {
    const next = crmViewStateToParams(viewState);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [viewState, searchParams, setSearchParams]);

  // Rückkehrziel + Sprung ins Gästeprofil (mit ?from=… zum Wiederherstellen).
  const returnUrl = useMemo(() => crmReturnUrl(viewState), [viewState]);
  const goToGuest = useCallback(
    (guestId: string) => navigate(buildGuestHref(guestId, returnUrl)),
    [navigate, returnUrl],
  );

  // ── Zeitraum-Handler ─────────────────────────────────────────────────────────
  const applyQuick = (kind: Exclude<FutureRangeKind, 'custom'>) => {
    const range = futureQuickRange(kind, today);
    setFrom(range.from);
    setTo(range.to);
    void runReport(range);
  };
  const applyCustom = () => void runReport({ kind: 'custom', from, to });

  // ── Export-Helfer (CRM) ──────────────────────────────────────────────────────
  const exportCampaignCsv = useCallback((def: CampaignDef) => {
    const csv = buildCampaignCsv(filterCampaign(metrics, def, today));
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = campaignCsvFilename(def);
    a.click();
    URL.revokeObjectURL(url);
  }, [metrics, today]);
  const exportCampaignXlsx = useCallback((def: CampaignDef) => {
    void downloadXlsx(campaignExportTable(def, filterCampaign(metrics, def, today)));
  }, [metrics, today]);
  const overdueExportTable = useCallback(() => ({
    filename: 'crm-rueckkehrpotenzial',
    sheetName: 'Rückkehrpotenzial',
    headers: RETURN_POTENTIAL_HEADERS,
    rows: overdueList.map(r => returnPotentialRowToCells(r, s => SEGMENT_LABEL[s])),
  }), [overdueList]);

  // ── Report-Aktionen (Drucken/PDF) ────────────────────────────────────────────
  const handlePrint = () => window.print();
  const handlePdf = () => {
    if (!report) return;
    const { stats } = report;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Gäste & Reservationen — Report', 14, 18);
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
    doc.save(`gaeste-reservationen-report-${report.range.from}_${report.range.to}.pdf`);
  };

  if (!canView) return <Navigate to="/" replace />;

  return (
    <PageShell
      width="default"
      header={
        <PageHeader
          icon={<Users />}
          title="Gäste & Reservationen"
          info="Gäste-Kennzahlen und Reservationen (vergangen wie zukünftig) für einen frei wählbaren Zeitraum — berechnet aus den importierten Reservationen. Zeigt Aggregate; personenbezogene Detaillisten nur für Admins."
          meta={`${tenant.name} · ${fdate(applied.from)} – ${fdate(applied.to)}`}
          actions={
            <>
              {report && (
                <>
                  <Button variant="outline" size="sm" onClick={handlePrint} className="print:hidden">
                    <Printer className="mr-1.5 h-4 w-4" /> Drucken
                  </Button>
                  <UnifiedExportButton
                    className="print:hidden"
                    data-testid="crm-report-export"
                    actions={[
                      { key: 'pdf', label: 'Report (PDF)', kind: 'pdf', onSelect: handlePdf },
                    ]}
                  />
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
      {tablesOk === false && (
        <HintBox tone="warn">
          Die Reservationstabellen existieren noch nicht. Bitte zuerst die
          Migration ausführen und Reservationen importieren.
        </HintBox>
      )}

      {/* ── (B) Zukünftige Reservationen ──────────────────────────────────── */}
      <FutureReservationsOverview
        overview={overview}
        metric={metric}
        onMetricChange={setMetric}
        onOpenTotals={() => setTotalsOpen(true)}
        onOpenDay={(d) => setDayDate(d)}
      />

      {/* ── (C) Zeitraum-Auswahl ──────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-3 print:hidden">
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map((q) => (
            <Button
              key={q.kind}
              variant={applied.kind === q.kind ? 'default' : 'secondary'}
              size="sm"
              onClick={() => applyQuick(q.kind)}
              disabled={reportLoading}
            >
              {q.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="report-from">Von</Label>
            <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[160px]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to">Bis</Label>
            <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[160px]" />
          </div>
          <Button onClick={applyCustom} disabled={reportLoading}>
            {reportLoading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Individuell anzeigen
          </Button>
        </div>
      </div>

      {/* ── (D) Kalenderübersicht ─────────────────────────────────────────── */}
      <FutureCalendarSection overview={overview} metric={metric} onDayClick={(d) => setDayDate(d)} />

      {reportError && (
        <HintBox tone="critical">{reportError}</HintBox>
      )}

      {/* ── (E) Tages-Popup (PII, admin-gegatet) + Summen-Popup ───────────── */}
      <DayReservationsDialog
        date={dayDate}
        detailRows={futureRows}
        onClose={() => setDayDate(null)}
        showPii
        onSelectGuest={goToGuest}
      />

      <Dialog open={totalsOpen} onOpenChange={setTotalsOpen}>
        <DialogContent className={DIALOG_LG}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarRange className="h-5 w-5 text-primary" />
              Aktive Reservationen im Zeitraum
            </DialogTitle>
            <DialogDescription>
              {overview.empty
                ? 'Der gewählte Zeitraum liegt vollständig in der Vergangenheit.'
                : `${fdate(overview.effectiveFrom)} – ${fdate(overview.effectiveTo)} · ${NUM0.format(overview.totals.reservations)} Reservationen · ${NUM0.format(overview.totals.persons)} Personen`}
            </DialogDescription>
          </DialogHeader>
          {!overview.empty && (
            <div className="max-h-[75vh] overflow-auto">
              <ReservationDetailList
                title="Aktive Reservationen"
                rows={totalsRows}
                persons={overview.totals.persons}
                onSelectGuest={goToGuest}
                showResNr
                showTyp
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── (F) CRM-Reiter ────────────────────────────────────────────────── */}
      {crmLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Auswertung wird geladen…
        </div>
      ) : tablesOk ? (
        <>
          {crmError && (
            <HintBox tone="warn">
              Die manuellen CRM-Profile konnten nicht geladen werden. Die manuellen
              CRM-Kampagnen (manuelle VIP/Stammgäste, Firmenkunden usw.) werden ohne
              diese Merkmale ausgewertet und können daher leer erscheinen.
            </HintBox>
          )}

          <Tabs value={tab} onValueChange={(v) => setTab(v as CrmTab)} className="space-y-4">
            <TabsList>
              <TabsTrigger value="overview" className="gap-1.5">
                <BarChart3 className="h-4 w-4" />
                Überblick
              </TabsTrigger>
              <TabsTrigger value="return" className="gap-1.5">
                <RotateCcw className="h-4 w-4" />
                Rückkehrpotenzial
              </TabsTrigger>
              <TabsTrigger value="campaigns" className="gap-1.5">
                <Megaphone className="h-4 w-4" />
                Kampagnen
              </TabsTrigger>
            </TabsList>

            {/* ── Reiter „Überblick" (Gäste-Kennzahlen) ─────────────────── */}
            <TabsContent value="overview" className="space-y-3">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Users className="h-5 w-5 text-primary" />
                Gäste-Überblick
              </h2>
              <KpiGrid>
                <KpiCard label="Gäste total" value={NUM0.format(guestKpis.totalGuests)} />
                <KpiCard label="Aktiv (≤ 90 Tage)" value={NUM0.format(guestKpis.activeGuests)} tone="good" />
                <KpiCard label="Inaktiv (> 90 Tage)" value={NUM0.format(guestKpis.inactiveGuests)} tone="critical" />
                <KpiCard label="Wiederkehrerquote" value={pct(guestKpis.repeatRatePct)} sub="≥ 2 Besuche / ≥ 1 Besuch" tone="info" />
              </KpiGrid>
              <MoreKpis storageKey="crm-guest-more-kpis">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  <KpiCard label="Neu (letzte 30 Tage)" value={NUM0.format(guestKpis.newGuests30)} tone="good" />
                  <KpiCard label="VIP" value={NUM0.format(guestKpis.vipGuests)} tone="warn" />
                  <KpiCard label="Stammgäste" value={NUM0.format(guestKpis.stammgaeste)} tone="info" />
                  <KpiCard label="Ohne Besuch" value={NUM0.format(guestKpis.guestsWithoutVisit)} />
                  <KpiCard label="No-Show-Risiko (≥ 2)" value={NUM0.format(guestKpis.noShowRiskGuests)} sub="Gäste mit ≥ 2 No-Shows" tone="warn" />
                  <KpiCard label="Rückkehrpotenzial" value={NUM0.format(guestKpis.returnRiskGuests)} sub="überfällige Stammgäste" tone="warn" />
                </div>
              </MoreKpis>
            </TabsContent>

            {/* ── Reiter „Rückkehrpotenzial" ────────────────────────────── */}
            <TabsContent value="return" className="space-y-4">
              <div className="space-y-2">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <RotateCcw className="h-5 w-5 text-primary" />
                  Rückkehrpotenzial &amp; gefährdete Stammgäste
                </h2>
                <p className="text-xs text-muted-foreground">
                  Überfällig = Tage seit letztem Besuch &gt; Ø-Besuchsintervall × 1,5
                  (benötigt mindestens zwei Besuche). Gefährdet = Stammgast oder VIP
                  (nach Besuchszahl), der seit mehr als 90 Tagen nicht mehr da war.
                </p>
                <KpiGrid className="lg:grid-cols-3">
                  <KpiCard label="Überfällige Gäste" value={NUM0.format(returnPotential.overdueGuests)} sub="über dem gewohnten Intervall" tone="warn" />
                  <KpiCard label="Gefährdete Stammgäste" value={NUM0.format(returnPotential.atRiskStammgaeste)} sub="> 90 Tage kein Besuch" tone="warn" />
                  <KpiCard label="Gefährdete VIP-Gäste" value={NUM0.format(returnPotential.atRiskVips)} sub="> 90 Tage kein Besuch" tone="warn" />
                </KpiGrid>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Hourglass className="h-5 w-5 text-primary" />
                    Überfällige Gäste
                  </h2>
                  {overdueList.length > 0 && (
                    <UnifiedExportButton
                      data-testid="overdue-export"
                      actions={[
                        { key: 'csv', label: 'Überfällige Gäste (CSV)', kind: 'csv', onSelect: () => downloadCsv(overdueExportTable()) },
                        { key: 'excel', label: 'Überfällige Gäste (Excel)', kind: 'excel', onSelect: () => { void downloadXlsx(overdueExportTable()); } },
                      ]}
                    />
                  )}
                </div>
                {overdueList.length === 0 ? (
                  <HintBox tone="good">Aktuell sind keine Gäste überfällig.</HintBox>
                ) : (
                  <div className={TABLE_WRAP}>
                    <div className={TABLE_SCROLL}>
                      <table className={TABLE}>
                        <thead>
                          <tr>
                            <th className={cn(TH, TH_STICKY)}>Gast</th>
                            <th className={cn(TH, TH_STICKY)}>Segment</th>
                            <th className={cn(TH, TH_STICKY, TH_NUM)}>Besuche</th>
                            <th className={cn(TH, TH_STICKY, TH_NUM)}>Ø Intervall</th>
                            <th className={cn(TH, TH_STICKY)}>Letzter Besuch</th>
                            <th className={cn(TH, TH_STICKY, TH_NUM)}>Tage seit letztem</th>
                            <th className={cn(TH, TH_STICKY, TH_NUM)}>Überfällig seit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overdueList.map(r => (
                            <tr key={r.id} onClick={() => goToGuest(r.id)} className={ROW_CLICKABLE}>
                              <td className={TD}>
                                <GuestProfileLink name={r.displayName} guestId={r.id} onSelect={goToGuest} stopPropagation />
                              </td>
                              <td className={TD}><SegmentBadge segment={r.segment} /></td>
                              <td className={cn(TD, TD_NUM)}>{NUM0.format(r.visits)}</td>
                              <td className={cn(TD, TD_NUM)}>{days(r.avgDaysBetweenVisits)}</td>
                              <td className={cn(TD, 'tabular-nums')}>{fdate(r.lastVisit)}</td>
                              <td className={cn(TD, TD_NUM)}>{days(r.daysSinceLastVisit)}</td>
                              <td className={cn(TD, TD_NUM, 'font-semibold text-orange-600 dark:text-orange-400')}>
                                {overdueDays(r.overdueByDays)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ── Reiter „Kampagnen" ────────────────────────────────────── */}
            <TabsContent value="campaigns" className="space-y-4">
              {campaignDef ? (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <button
                        onClick={() => setActiveCampaign(null)}
                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Zurück zu den Kampagnen
                      </button>
                      <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Megaphone className="h-5 w-5 text-primary" />
                        {campaignDef.label}
                        <span className="rounded-full bg-muted px-2 py-0.5 text-sm font-medium tabular-nums text-muted-foreground">
                          {NUM0.format(campaignRows.length)}
                        </span>
                      </h2>
                      <p className="max-w-3xl text-xs text-muted-foreground">{campaignDef.description}</p>
                    </div>
                    <UnifiedExportButton
                      data-testid="campaign-export"
                      disabled={campaignRows.length === 0}
                      actions={[
                        { key: 'csv', label: 'Kampagnen-Gäste (CSV)', kind: 'csv', onSelect: () => exportCampaignCsv(campaignDef) },
                        { key: 'excel', label: 'Kampagnen-Gäste (Excel)', kind: 'excel', onSelect: () => exportCampaignXlsx(campaignDef) },
                      ]}
                    />
                  </div>

                  {campaignRows.length === 0 ? (
                    <HintBox tone="neutral">Für diese Kampagne gibt es aktuell keine passenden Gäste.</HintBox>
                  ) : (
                    <div className={TABLE_WRAP}>
                      <div className={TABLE_SCROLL}>
                        <table className={TABLE}>
                          <thead>
                            <tr>
                              <th className={cn(TH, TH_STICKY)}>Name</th>
                              <th className={cn(TH, TH_STICKY)}>E-Mail</th>
                              <th className={cn(TH, TH_STICKY)}>Telefon</th>
                              <th className={cn(TH, TH_STICKY)}>Segment</th>
                              <th className={cn(TH, TH_STICKY, TH_NUM)}>Besuche</th>
                              <th className={cn(TH, TH_STICKY)}>Letzter Besuch</th>
                              <th className={cn(TH, TH_STICKY, TH_NUM)}>Tage seit letztem</th>
                              <th className={cn(TH, TH_STICKY, TH_NUM)}>Ø Intervall</th>
                              <th className={cn(TH, TH_STICKY, TH_NUM)}>No Shows</th>
                            </tr>
                          </thead>
                          <tbody>
                            {campaignRows.map(r => (
                              <tr key={r.id} onClick={() => goToGuest(r.id)} className={ROW_CLICKABLE}>
                                <td className={TD}>
                                  <GuestProfileLink name={r.displayName} guestId={r.id} onSelect={goToGuest} stopPropagation />
                                </td>
                                <td className={cn(TD, 'text-muted-foreground')}>{r.email ?? '—'}</td>
                                <td className={cn(TD, 'tabular-nums text-muted-foreground')}>{r.mobile ?? '—'}</td>
                                <td className={TD}><SegmentBadge segment={r.segment} /></td>
                                <td className={cn(TD, TD_NUM)}>{NUM0.format(r.visits)}</td>
                                <td className={cn(TD, 'tabular-nums')}>{fdate(r.lastVisit)}</td>
                                <td className={cn(TD, TD_NUM)}>{days(r.daysSinceLastVisit)}</td>
                                <td className={cn(TD, TD_NUM)}>{days(r.avgDaysBetweenVisits)}</td>
                                <td className={cn(TD, TD_NUM)}>{NUM0.format(r.noShowCount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>
              ) : (
                <section className="space-y-3">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Megaphone className="h-5 w-5 text-primary" />
                    Kampagnenlisten
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Vordefinierte Listen aus den bestehenden CRM-Daten. „Anzeigen"
                    öffnet die Detailliste, „CSV/Excel" lädt nur die jeweils
                    gefilterte Liste als Datei herunter.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {campaignSummaries.map(({ def, count }) => (
                      <div key={def.id} className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-semibold leading-tight text-foreground">{def.label}</h3>
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-sm font-bold tabular-nums text-foreground">
                              {NUM0.format(count)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">{def.description}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" className="flex-1" onClick={() => setActiveCampaign(def.id)} disabled={count === 0}>
                            <Eye className="mr-1.5 h-4 w-4" /> Anzeigen
                          </Button>
                          <UnifiedExportButton
                            className="flex-1 gap-1.5"
                            data-testid={`campaign-card-export-${def.id}`}
                            disabled={count === 0}
                            actions={[
                              { key: 'csv', label: 'CSV', kind: 'csv', onSelect: () => exportCampaignCsv(def) },
                              { key: 'excel', label: 'Excel', kind: 'excel', onSelect: () => exportCampaignXlsx(def) },
                            ]}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </TabsContent>
          </Tabs>
        </>
      ) : null}

      {/* ── (G) Klassischer Report (einklappbar) ──────────────────────────── */}
      {reportLoading && !report && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Report wird geladen …
        </div>
      )}

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
              <section className="space-y-3 rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Clock className="h-5 w-5 text-primary" /> Beste Reservationszeiten
                  </h2>
                  <div className="flex items-center gap-2 print:hidden">
                    <div className="inline-flex overflow-hidden rounded-lg border border-border text-sm">
                      <button
                        type="button"
                        onClick={() => setTimeSort('count')}
                        aria-pressed={timeSort === 'count'}
                        className={cn('px-3 py-1.5 transition-colors', timeSort === 'count' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60')}
                      >
                        Reservationen
                      </button>
                      <button
                        type="button"
                        onClick={() => setTimeSort('persons')}
                        aria-pressed={timeSort === 'persons'}
                        className={cn('border-l border-border px-3 py-1.5 transition-colors', timeSort === 'persons' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60')}
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
                        <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
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
                            <tr key={slot.time} className={cn('border-b border-border/60 last:border-0', strongest && 'bg-primary/5')}>
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
