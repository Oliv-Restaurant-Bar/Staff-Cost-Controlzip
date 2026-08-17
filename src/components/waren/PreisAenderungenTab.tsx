/**
 * Tab «Preisänderungen» — persistente Preishistorie je Produkt/Lieferant
 * =====================================================================
 * Zeigt die beim Import PERSISTIERTEN Preisänderungen (waren_preishinweise_*,
 * SSOT-Erkennung = berechnePreisAenderungen) dauerhaft an — filter- und
 * sortierbar, auch Tage/Monate nach dem Import. Zeitraum kommt von der
 * gemeinsamen ZeitraumSteuerung der Seite (von/bis + Monats-Keys).
 * «Leer statt 0»: fehlende Mengen/Prozente → «–». Mandantengetrennt.
 */

import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Download, FileSpreadsheet, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { TenantId } from '@/contexts/TenantContext';
import {
  ladePreisAenderungen, filtereUndSortiere,
  type PreisAenderungRow, type PreisRichtung,
} from '@/lib/preisaenderungen';
import { downloadCsv, downloadXlsx } from '@/lib/table-export';
import { isoToDate, type ExportTable } from '@/lib/export-cell';

const fmtChf = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDatum = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–');
const fmtMenge = (n: number) => n.toLocaleString('de-CH', { maximumFractionDigits: 2 });

interface Props {
  tenantId: TenantId;
  /** Zu ladende Monate (YYYY-MM) des gewählten Zeitraums. */
  monthKeys: string[];
  /** Zeitraum-Grenzen (inklusive) für Zeilen-Filterung UND Mengen-Basis (Woche!). */
  von: string;
  bis: string;
  /** Export-Berechtigung der Seite (CSV/Excel nur wenn true). */
  canExport: boolean;
}

export function PreisAenderungenTab({ tenantId, monthKeys, von, bis, canExport }: Props) {
  const [rows, setRows] = useState<PreisAenderungRow[] | null>(null);
  const [lieferant, setLieferant] = useState('');
  const [warengruppe, setWarengruppe] = useState('');
  const [nurStark, setNurStark] = useState(false);
  const [richtung, setRichtung] = useState<PreisRichtung>('alle');
  const [verlaufKey, setVerlaufKey] = useState<string | null>(null);

  const monateSig = monthKeys.join(',');
  useEffect(() => {
    let alive = true;
    setRows(null);
    void ladePreisAenderungen(tenantId, monthKeys, { von, bis })
      .then(r => { if (alive) setRows(r); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, monateSig, von, bis]);

  const gefiltert = useMemo(() => rows === null ? [] : filtereUndSortiere(rows, {
    von, bis, lieferant, warengruppe, nurStark, richtung,
  }), [rows, von, bis, lieferant, warengruppe, nurStark, richtung]);

  const lieferanten = useMemo(() => rows === null ? [] :
    [...new Set(rows.map(r => r.lieferant).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [rows]);
  const warengruppen = useMemo(() => rows === null ? [] :
    [...new Set(rows.map(r => r.warengruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')), [rows]);

  const summeMehraufwand = useMemo(() => {
    const werte = gefiltert.map(r => r.mehraufwand).filter((v): v is number => v !== null);
    return werte.length ? werte.reduce((s, v) => s + v, 0) : null;
  }, [gefiltert]);

  // Preisverlauf eines Produkts: alle Änderungs-Schritte im geladenen Bereich.
  const verlauf = useMemo(() => {
    if (!verlaufKey || rows === null) return [];
    return rows.filter(r => r.key === verlaufKey)
      .sort((a, b) => (a.datum || `${a.monat}-01`).localeCompare(b.datum || `${b.monat}-01`));
  }, [verlaufKey, rows]);

  const exportTable = (): ExportTable => ({
    filename: `preisaenderungen_${von}_${bis}`,
    sheetName: 'Preisänderungen',
    headers: ['Datum', 'Produkt', 'Art.-Nr.', 'Lieferant', 'Warengruppe', 'Konto',
      'Alt CHF', 'Neu CHF', 'Δ CHF', 'Δ %', 'Seit', 'Menge seit Änderung', 'Mehraufwand CHF'],
    rows: gefiltert.map(r => [
      isoToDate(r.datum), r.artikel, r.artNr || null, r.lieferant, r.warengruppe || null,
      r.konto, r.alt, r.neu, r.diffAbs, r.diffPct, isoToDate(r.seit),
      r.mengeSeit, r.mehraufwand,
    ]),
  });

  const selectCls = 'h-8 rounded-md border border-border bg-background px-2 text-xs';

  return (
    <div className="space-y-3" data-testid="tab-preisaenderungen">
      {/* Filterzeile */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={lieferant} onChange={e => setLieferant(e.target.value)}
          className={selectCls} data-testid="filter-lieferant">
          <option value="">Alle Lieferanten</option>
          {lieferanten.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={warengruppe} onChange={e => setWarengruppe(e.target.value)}
          className={selectCls} data-testid="filter-warengruppe">
          <option value="">Alle Warengruppen</option>
          {warengruppen.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <select value={richtung} onChange={e => setRichtung(e.target.value as PreisRichtung)}
          className={selectCls} data-testid="filter-richtung">
          <option value="alle">Erhöhungen + Senkungen</option>
          <option value="erhoehung">Nur Erhöhungen</option>
          <option value="senkung">Nur Senkungen</option>
        </select>
        <select value={nurStark ? 'stark' : 'alle'} onChange={e => setNurStark(e.target.value === 'stark')}
          className={selectCls} data-testid="filter-schwelle">
          <option value="alle">Alle Änderungen</option>
          <option value="stark">Nur deutliche (≥ Schwelle, Std. 10 %)</option>
        </select>
        <div className="flex-1" />
        {canExport && (<>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
          onClick={() => downloadCsv(exportTable())} disabled={gefiltert.length === 0}
          data-testid="export-csv">
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
          onClick={() => void downloadXlsx(exportTable())} disabled={gefiltert.length === 0}
          data-testid="export-xlsx">
          <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
        </Button>
        </>)}
      </div>

      {/* Kopf-Zusammenfassung */}
      <div className="text-xs text-muted-foreground">
        {rows === null ? 'Wird geladen…' : (
          <>
            {gefiltert.length} Preisänderung{gefiltert.length === 1 ? '' : 'en'} im Zeitraum
            {summeMehraufwand !== null && (
              <> · kumulierter Mehraufwand{' '}
                <span className={cn('font-medium', summeMehraufwand > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  CHF {fmtChf(summeMehraufwand)}
                </span>
              </>
            )}
          </>
        )}
      </div>

      {/* Tabelle */}
      {rows !== null && gefiltert.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Keine Preisänderungen im gewählten Zeitraum.
          <div className="mt-1 text-xs">Erkannte Änderungen werden bei jedem Import automatisch gespeichert.</div>
        </div>
      ) : rows !== null && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Datum</th>
                <th className="px-3 py-2 font-medium">Produkt</th>
                <th className="px-3 py-2 font-medium">Lieferant</th>
                <th className="px-3 py-2 font-medium">Warengruppe</th>
                <th className="px-3 py-2 font-medium">Konto</th>
                <th className="px-3 py-2 font-medium text-right">Alt → Neu</th>
                <th className="px-3 py-2 font-medium text-right">Δ CHF</th>
                <th className="px-3 py-2 font-medium text-right">Δ %</th>
                <th className="px-3 py-2 font-medium">Seit</th>
                <th className="px-3 py-2 font-medium text-right">Menge seit</th>
                <th className="px-3 py-2 font-medium text-right">Mehraufwand</th>
              </tr>
            </thead>
            <tbody>
              {gefiltert.map((r, i) => (
                <tr key={`${r.key}|${r.datum}|${r.monat}|${i}`}
                  className="border-b border-border/50 last:border-0 hover:bg-muted/30 cursor-pointer"
                  onClick={() => setVerlaufKey(r.key)}
                  data-testid={`preisrow-${i}`}>
                  <td className="px-3 py-2 whitespace-nowrap font-mono">{fmtDatum(r.datum) === '–' ? r.monat : fmtDatum(r.datum)}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.artikel}</span>
                    {r.artNr && <span className="ml-1.5 text-muted-foreground">#{r.artNr}</span>}
                  </td>
                  <td className="px-3 py-2">{r.lieferant}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.warengruppe || '–'}</td>
                  <td className="px-3 py-2 font-mono">{r.konto ?? '–'}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {fmtChf(r.alt)} → {fmtChf(r.neu)}
                  </td>
                  <td className={cn('px-3 py-2 text-right font-mono whitespace-nowrap',
                    r.erhoehung ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                    {r.diffAbs > 0 ? '+' : ''}{fmtChf(r.diffAbs)}
                  </td>
                  <td className={cn('px-3 py-2 text-right font-mono whitespace-nowrap font-medium',
                    r.erhoehung ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                    <span className="inline-flex items-center gap-1">
                      {r.erhoehung ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {r.diffPct !== null ? `${r.diffPct > 0 ? '+' : ''}${r.diffPct.toFixed(1)} %` : '–'}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDatum(r.seit)}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.mengeSeit !== null ? fmtMenge(r.mengeSeit) : '–'}</td>
                  <td className={cn('px-3 py-2 text-right font-mono whitespace-nowrap',
                    r.mehraufwand !== null && r.mehraufwand > 0 && 'text-red-600 dark:text-red-400 font-medium')}>
                    {r.mehraufwand !== null ? `CHF ${fmtChf(r.mehraufwand)}` : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Preisverlauf-Dialog (alle Schritte des Produkts im geladenen Bereich) */}
      <Dialog open={verlaufKey !== null} onOpenChange={o => { if (!o) setVerlaufKey(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4" />
              Preisverlauf · {verlauf[0]?.artikel ?? ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 text-xs">
            {verlauf.length === 0 && <div className="text-muted-foreground">Keine Einträge.</div>}
            {verlauf.map((v, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                <span className="font-mono text-muted-foreground">{fmtDatum(v.datum) === '–' ? v.monat : fmtDatum(v.datum)}</span>
                <span className="font-mono">{fmtChf(v.alt)} → {fmtChf(v.neu)}</span>
                <span className={cn('font-mono font-medium',
                  v.erhoehung ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {v.diffPct !== null ? `${v.diffPct > 0 ? '+' : ''}${v.diffPct.toFixed(1)} %` : '–'}
                </span>
              </div>
            ))}
            <div className="pt-1 text-muted-foreground">
              Verlauf = persistierte Änderungs-Schritte im geladenen Zeitraum ({verlauf[0]?.lieferant ?? ''}).
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
