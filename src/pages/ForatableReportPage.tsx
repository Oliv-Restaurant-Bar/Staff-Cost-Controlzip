/**
 * ForatableReportPage — Foratable Report (`/foratable-report`)
 * ===========================================================
 * Wertet BEREITS importierte Reservationen (DB, mandantengefiltert) für einen
 * frei wählbaren Zeitraum aus — kein Upload, kein Import.  Die Kennzahlen sind
 * identisch zur CSV-Vorschau im Reservationen-Import, da dieselbe Logik
 * (`computeReservationStats`) und dieselbe Darstellung (`ReservationSummary`)
 * wiederverwendet werden.
 *
 * Datenschutz: Reservationen enthalten personenbezogene Daten — Zugriff nur für
 * eingeloggte Admins (RLS auf `authenticated`).  Der Report selbst zeigt nur
 * Aggregate, keine Einzelgast-Daten.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart2, CalendarRange, Loader2, Printer, FileDown, AlertTriangle,
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
  ReservationSummary, fdate, NUM0, NUM1, STATUS_LABEL,
} from '@/components/reservations/ReservationSummary';
import { loadForatableReport } from '@/lib/foratable-report-db';
import { quickRange } from '@/lib/foratable-report';
import type { ForatableReport, ReportRange, QuickRangeKind } from '@/lib/foratable-report';

const QUICK_RANGES: Array<{ kind: QuickRangeKind; label: string }> = [
  { kind: 'current-month', label: 'Aktueller Monat' },
  { kind: 'last-month',    label: 'Letzter Monat' },
  { kind: 'current-year',  label: 'Aktuelles Jahr' },
  { kind: 'last-year',     label: 'Letztes Jahr' },
];

export default function ForatableReportPage() {
  const { tenantId, tenant } = useTenant();
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  // usePermissions().isAdmin schliesst Gast-Sessions ein — hier explizit ausschliessen
  // (read-only Gäste-Links dürfen keine Reservationsdaten abfragen).
  const canView = isAdmin && !isGuest;

  const initial = quickRange('current-month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<ForatableReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runReport = useCallback(async (range: ReportRange) => {
    if (!canView) return; // niemals Daten für nicht berechtigte Sessions laden
    if (range.from > range.to) {
      setError('Das Von-Datum darf nicht nach dem Bis-Datum liegen.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await loadForatableReport(tenantId, range);
      setReport(r);
    } catch (e) {
      setReport(null);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error('Report konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, canView]);

  // Initial + bei Mandantenwechsel den aktuell gewählten Zeitraum laden.
  useEffect(() => {
    if (!canView) return; // kein DB-Zugriff vor dem Redirect für nicht berechtigte Nutzer
    runReport({ from, to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, canView]);

  const applyQuick = (kind: QuickRangeKind) => {
    const range = quickRange(kind);
    setFrom(range.from);
    setTo(range.to);
    runReport(range);
  };

  const handlePrint = () => window.print();

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
    if (stats.topTimes.length > 0) {
      autoTable(doc, {
        startY: nextY(),
        head: [['Zeit', 'Reservationen', 'Personen']],
        body: stats.topTimes.map((t) => [t.time, NUM0.format(t.count), NUM0.format(t.persons)]),
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
    <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-5">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart2 className="h-6 w-6 text-primary" />
            Foratable Report
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Auswertung bereits importierter Reservationen für einen frei wählbaren Zeitraum.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/60 print:hidden"
          >
            <CalendarRange className="h-4 w-4" />
            Zum Import
          </Link>
        </div>
      </div>

      {/* Filterleiste */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3 print:hidden">
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
          <Button onClick={() => runReport({ from, to })} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Report anzeigen
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map((q) => (
            <Button
              key={q.kind} variant="secondary" size="sm"
              onClick={() => applyQuick(q.kind)} disabled={loading}
            >
              {q.label}
            </Button>
          ))}
        </div>
      </div>

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

      {/* Report */}
      {report && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-sm">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {tenant.name} · {fdate(report.range.from)} – {fdate(report.range.to)}
            </span>
          </div>

          {report.stats.reservationCount === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Keine importierten Reservationen in diesem Zeitraum.
            </div>
          ) : (
            <ReservationSummary
              stats={report.stats}
              newGuests={report.newGuests}
              returningGuests={report.returningGuests}
            />
          )}
        </div>
      )}
    </div>
  );
}
