/**
 * BuchhaltungsExportSection.tsx — Buchhaltungs-Export-Assistent (/tagesabschluesse).
 * ==================================================================================
 * Eigener Abschnitt UNTERHALB der Monatsübersicht (Spec §1). Orchestriert:
 * Export-Gate per Checkliste (§2), Monatsprüfung (§3), Buchungsvorschau ohne
 * Dateierzeugung (§4), CSV-Export im Tabelle2-Format (§6, nur bei erfüllter
 * Checkliste + vollständigem Konto-Mapping), Export-Historie/-Protokoll mit
 * Versionierung (§7/§8), PDF-Monatsabschluss (§9) und die deutliche
 * „Export veraltet"-Warnung (§10). Reine Logik in `src/lib/buchhaltungs-export.ts`
 * und `src/lib/monatsabschluss-pdf.ts` — hier nur Darstellung + Handler.
 *
 * Persistenz: Export-Protokolle sind write-once-Records im bestehenden Blob
 * `tagesabschluss_v1` (KEINE Migration). Mutationen laufen über den vom Parent
 * gereichten `persist` (merge-on-save); der Record wird auf einem FRISCH aus
 * localStorage geladenen Blob erzeugt, damit parallele Edits nicht verdrängt
 * werden. Gäste (readOnly) sehen alles, können aber weder exportieren noch
 * Einstellungen ändern.
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Download, FileText, Settings2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TENANTS, type TenantId } from '@/contexts/TenantContext';
import {
  buildExportChecklist,
  buildMonatspruefung,
  createExportRecord,
  addExportRecord,
  deriveExportStatus,
  exportChecklistOk,
  exportsForMonth,
  nextExportVersion,
  summarizeBuchungsvorschau,
  EXPORT_STATUS_LABEL,
  type BuchhaltungsExportStatus,
} from '@/lib/buchhaltungs-export';
import {
  defaultExportSettings,
  type GnDayClosing,
  type TagesabschlussBlob,
  type TagesabschlussMonth,
} from '@/lib/tagesabschluss';
import { loadTagesabschlussLocal } from '@/lib/tagesabschluss-db';
import { buildTabelle2Rows, tabelle2ToExportTable } from '@/lib/tagesabschluss-export';
import { downloadCsv } from '@/lib/table-export';
import { fmtChf, fmtDiffChf } from './adyen-ui';
import { formatClosedStamp } from './TagesabschlussTable';

const STATUS_STYLE: Record<BuchhaltungsExportStatus, string> = {
  offen: 'bg-muted text-muted-foreground',
  bereit: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  exportiert: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  veraltet: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

interface BuchhaltungsExportSectionProps {
  tenantId: TenantId;
  year: number;
  month: number;
  monthKey: string;
  monthData: TagesabschlussMonth;
  closings: Record<string, GnDayClosing>;
  blob: TagesabschlussBlob;
  readOnly: boolean;
  currentUser: string;
  persist: (next: TagesabschlussBlob) => Promise<void>;
  /** Öffnet den Konto-Mapping-Dialog (TagesabschlussExportDialog) des Parents. */
  onOpenMapping: () => void;
}

export function BuchhaltungsExportSection({
  tenantId, year, month, monthKey, monthData, closings, blob,
  readOnly, currentUser, persist, onOpenMapping,
}: BuchhaltungsExportSectionProps) {
  const [pdfBusy, setPdfBusy] = useState(false);

  const checklist = useMemo(
    () => buildExportChecklist(monthData, blob, monthKey),
    [monthData, blob, monthKey],
  );
  const gateOk = exportChecklistOk(checklist);
  const status = useMemo(() => deriveExportStatus(blob, monthKey), [blob, monthKey]);
  const pruefung = useMemo(() => buildMonatspruefung(monthData), [monthData]);

  /** Tabelle2-Zeilen gegen die GESPEICHERTEN Einstellungen (kein Draft). */
  const tabelle2 = useMemo(
    () => buildTabelle2Rows(
      monthData.rows, closings, blob,
      blob.exportSettings ?? defaultExportSettings(new Date(0).toISOString()),
    ),
    [monthData.rows, closings, blob],
  );
  const vorschau = useMemo(
    () => summarizeBuchungsvorschau(tabelle2.rows),
    [tabelle2.rows],
  );
  const historie = useMemo(
    () => [...exportsForMonth(blob, monthKey)].reverse(),
    [blob, monthKey],
  );

  const exportDisabled = readOnly || !gateOk || tabelle2.errors.length > 0 || tabelle2.rows.length === 0;

  /** CSV erzeugen + Export-Protokoll (write-once) auf FRISCHEM Blob anlegen. */
  const handleExportCsv = () => {
    if (exportDisabled) return;
    const fresh = loadTagesabschlussLocal(tenantId);
    const version = nextExportVersion(fresh, monthKey);
    downloadCsv(tabelle2ToExportTable(tabelle2.rows, `buchhaltungs-export-${monthKey}-v${version}`));
    // Fingerprint über den GERENDERTEN Blob (= Datenstand der exportierten CSV):
    // hat ein anderes Tab zwischenzeitlich mutiert, zeigt der Status danach
    // korrekt „Export veraltet" statt die Änderung zu maskieren. Persistiert
    // wird der Record auf dem FRISCHEN Blob (Frisch-Mutation-Pflicht).
    const record = createExportRecord({
      blob,
      monthKey,
      user: currentUser,
      now: new Date().toISOString(),
      anzahlBuchungen: tabelle2.rows.length,
      kassensaldoEnde: monthData.endSaldo,
    });
    void persist(addExportRecord(fresh, record));
    toast.success(`Buchhaltungs-Export ${version} erstellt (${tabelle2.rows.length} Buchungen).`);
  };

  /** PDF-Monatsabschluss (§9) — jsPDF wird erst beim Klick geladen. */
  const handlePdf = async () => {
    if (readOnly || pdfBusy) return;
    setPdfBusy(true);
    try {
      const mod = await import('@/lib/monatsabschluss-pdf');
      const restaurantName = TENANTS[tenantId].name;
      const doc = mod.buildMonatsabschlussPdf({
        monthKey,
        restaurantName,
        month: monthData,
        blob,
        checklist,
        generatedBy: currentUser,
        generatedAt: new Date().toISOString(),
      });
      doc.save(mod.monatsabschlussPdfFilename(monthKey, restaurantName));
      toast.success('Monatsabschluss-PDF erstellt.');
    } catch (e) {
      console.error('[Buchhaltungs-Export] PDF fehlgeschlagen:', e);
      toast.error('PDF konnte nicht erstellt werden.');
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <Card className="mt-4" data-testid="bx-section">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base">
            Buchhaltungs-Export — {MONTH_NAMES[month - 1]} {year}
          </CardTitle>
          <span
            className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
            data-testid="bx-status"
          >
            {EXPORT_STATUS_LABEL[status]}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* ── §10: deutlicher Veraltet-Hinweis ── */}
        {status === 'veraltet' && (
          <div
            className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2"
            data-testid="bx-veraltet-banner"
          >
            <p className="flex items-center gap-1.5 text-xs font-medium text-red-800 dark:text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Der Monat wurde nach dem letzten Export geändert. Bitte neuen Export erstellen.
            </p>
          </div>
        )}

        {/* ── §2: Export-Voraussetzungen (Checkliste) ── */}
        <section data-testid="bx-checklist">
          <p className="text-xs font-semibold mb-1.5">
            {gateOk
              ? 'Alle Export-Voraussetzungen erfüllt'
              : 'Folgende Punkte müssen vor dem Export erledigt werden'}
          </p>
          <ul className="space-y-1">
            {checklist.map(item => (
              <li key={item.key} className="flex items-start gap-1.5 text-[11px]"
                data-testid={`bx-check-${item.key}`}>
                {item.ok
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0 mt-px" aria-hidden="true" />
                  : <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0 mt-px" aria-hidden="true" />}
                <span className={item.ok ? '' : 'text-red-700 dark:text-red-400'}>
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground"> — {item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── §3: Monatsprüfung — alle Totale ── */}
        <section data-testid="bx-pruefung">
          <p className="text-xs font-semibold mb-1.5">Monatsprüfung</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {pruefung.map(item => (
              <div key={item.key} className="rounded-md border border-border px-3 py-2"
                data-testid={`bx-pruefung-${item.key}`}>
                <p className="text-[10px] text-muted-foreground">{item.label}</p>
                <p className="text-sm font-semibold tabular-nums">
                  {item.value === null
                    ? <span className="text-muted-foreground font-normal">—</span>
                    : <>CHF {fmtChf(item.value)}</>}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── §4: Buchungsvorschau — es wird KEINE Datei erzeugt ── */}
        <section data-testid="bx-vorschau">
          <p className="text-xs font-semibold mb-1.5">Buchungsvorschau</p>
          {tabelle2.errors.length > 0 ? (
            <div className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1"
              data-testid="bx-mapping-errors">
              <p className="flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Vorschau/Export blockiert — Konto-Mapping unvollständig:
              </p>
              {tabelle2.errors.map((e, i) => (
                <p key={i} className="text-[11px] text-amber-800 dark:text-amber-300">• {e}</p>
              ))}
              {!readOnly && (
                <Button size="sm" variant="outline" className="h-7 text-xs mt-1"
                  onClick={onOpenMapping} data-testid="bx-open-mapping">
                  <Settings2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                  Konto-Mapping öffnen
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1 pr-2 font-medium">Bereich</th>
                    <th className="text-right py-1 px-2 font-medium">Buchungen</th>
                    <th className="text-right py-1 px-2 font-medium">Netto</th>
                    <th className="text-right py-1 px-2 font-medium">MwSt</th>
                    <th className="text-right py-1 pl-2 font-medium">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {vorschau.gruppen.filter(g => g.anzahl > 0).map(g => (
                    <tr key={g.kategorie} className="border-b border-border/50"
                      data-testid={`bx-vorschau-${g.kategorie}`}>
                      <td className="py-1 pr-2">{g.label}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{g.anzahl}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{fmtChf(g.netto)}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{fmtChf(g.steuer)}</td>
                      <td className="py-1 pl-2 text-right tabular-nums">{fmtChf(g.brutto)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold" data-testid="bx-vorschau-total">
                    <td className="py-1 pr-2">Gesamt Buchungszeilen: {vorschau.anzahlBuchungen}</td>
                    <td className="py-1 px-2" />
                    <td className="py-1 px-2 text-right tabular-nums">{fmtChf(vorschau.nettoTotal)}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{fmtChf(vorschau.mwstTotal)}</td>
                    <td className="py-1 pl-2 text-right tabular-nums">{fmtChf(vorschau.bruttoTotal)}</td>
                  </tr>
                </tfoot>
              </table>
              {tabelle2.warnings.length > 0 && (
                <div className="rounded border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 p-2 mt-2 space-y-0.5"
                  data-testid="bx-warnings">
                  <p className="flex items-center gap-1 text-[11px] font-medium text-orange-800 dark:text-orange-300">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Korrekturen sind NICHT im Export enthalten (manuell nachbuchen):
                  </p>
                  {tabelle2.warnings.map((w, i) => (
                    <p key={i} className="text-[11px] text-orange-800 dark:text-orange-300">• {w}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Aktionen: CSV (§6) + PDF (§9) ── */}
        {!readOnly && (
          <div className="flex items-center gap-2 flex-wrap border-t border-border pt-3">
            <Button size="sm" className="h-8 text-xs"
              disabled={exportDisabled}
              title={gateOk
                ? (tabelle2.errors.length > 0
                  ? 'Konto-Mapping unvollständig — zuerst Mapping vervollständigen.'
                  : `CSV im Tabelle2-Format erstellen (${tabelle2.rows.length} Buchungen)`)
                : 'Export gesperrt — zuerst alle Checklisten-Punkte erledigen.'}
              onClick={handleExportCsv}
              data-testid="bx-export-csv">
              <Download className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Buchhaltungs-CSV exportieren ({tabelle2.rows.length} Buchungen)
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs"
              disabled={pdfBusy}
              onClick={() => { void handlePdf(); }}
              data-testid="bx-export-pdf">
              <FileText className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              {pdfBusy ? 'PDF wird erstellt…' : 'Monatsabschluss PDF'}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs"
              onClick={onOpenMapping} data-testid="bx-mapping">
              <Settings2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Konto-Mapping
            </Button>
          </div>
        )}

        {/* ── §7/§8: Export-Historie + Protokoll ── */}
        <section data-testid="bx-historie">
          <p className="text-xs font-semibold mb-1.5">Export-Historie</p>
          {historie.length === 0 ? (
            <p className="text-[11px] text-muted-foreground" data-testid="bx-historie-leer">
              Noch kein Export für diesen Monat erstellt.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1 pr-2 font-medium">Version</th>
                    <th className="text-left py-1 px-2 font-medium">Datum / Uhrzeit</th>
                    <th className="text-left py-1 px-2 font-medium">Benutzer</th>
                    <th className="text-right py-1 px-2 font-medium">Buchungen</th>
                    <th className="text-right py-1 px-2 font-medium">Kassensaldo Ende</th>
                    <th className="text-left py-1 pl-2 font-medium">Export-ID</th>
                  </tr>
                </thead>
                <tbody>
                  {historie.map((rec, idx) => (
                    <tr key={rec.id} className="border-b border-border/50"
                      data-testid={`bx-export-v${rec.version}`}>
                      <td className="py-1 pr-2">
                        <span className="font-medium">Export {rec.version}</span>
                        {idx === 0 && (
                          <span className={`ml-1.5 inline-block rounded px-1 py-px text-[10px] font-medium ${
                            status === 'veraltet'
                              ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                              : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                          }`}>
                            {status === 'veraltet' ? 'veraltet' : 'aktuell'}
                          </span>
                        )}
                      </td>
                      <td className="py-1 px-2 whitespace-nowrap">{formatClosedStamp(rec.exportedAt)}</td>
                      <td className="py-1 px-2">{rec.exportedBy}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{rec.anzahlBuchungen}</td>
                      <td className="py-1 px-2 text-right tabular-nums">
                        {rec.kassensaldoEnde === null ? '—' : fmtDiffChf(rec.kassensaldoEnde)}
                      </td>
                      <td className="py-1 pl-2 font-mono text-[10px] text-muted-foreground">{rec.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
