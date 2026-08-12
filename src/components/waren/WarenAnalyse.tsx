/**
 * WarenAnalyse — umschaltbare Anomalie-Analyse der Warenrechnungen.
 * =================================================================
 * Ansichten nach Lieferant / Konto / Woche / Monat mit:
 *  - Kennzahlen-Kopf (Total, WKQ vs. Ziel mit Ampel, Food/Beverage-Anteil,
 *    Top-3-Kostentreiber)
 *  - Anomalie-Markierung (rot): deutlich über dem eigenen Vorwochen-Schnitt
 *    (> +30 %); Wochen über Ziel-WKQ rot / darunter grün
 *  - Top-Einzelrechnungen des Zeitraums
 *  - Drill-down: Klick auf eine Zeile zeigt die zugrunde liegenden Rechnungen
 * Reine Anzeige — alle Zahlenlogik in `waren-analyse` (pur, getestet).
 */

import { Fragment, useMemo, useState } from 'react';
import { listeUnkontierte, type UnkontiertePosition } from '@/lib/waren-unkontiert';
import type { InvoiceEntry, Warenkonto } from '@/lib/waren-db';
import {
  groupTotals, flagAnomalies, topInvoices, wochenWkq, analyseKpis, nurDirektAnteil,
  isoWeekKeyOf, kontoShares, supplierKeyOf,
  type AnalyseDim,
} from '@/lib/waren-analyse';
import { cn } from '@/lib/utils';
import { AlertTriangle, ChevronDown, Paperclip } from 'lucide-react';

const DIM_LABEL: Record<AnalyseDim, string> = {
  supplier: 'Lieferant', konto: 'Konto', week: 'Woche', month: 'Monat',
};

function fmtChf(v: number): string {
  return v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Props {
  entries: InvoiceEntry[];
  /** ISO-Datum → Netto-Umsatz des Tages (für WKQ je Woche + Gesamt-WKQ). */
  revenueByDate: Record<string, number>;
  konten: Warenkonto[];
  zielPct: number;
  periodLabel: string;
  onOpenReceipt?: (path: string) => void;
  /**
   * Konto direkt zuweisen (unkontierte Positionen). Rückgabe false = Fehler,
   * Auswahl bleibt offen. Fehlt der Handler, bleibt der Hinweis reiner Text.
   */
  onAssignKonto?: (pos: UnkontiertePosition, konto: string) => Promise<boolean>;
}

export function WarenAnalyseBlock({ entries, revenueByDate, konten, zielPct, periodLabel, onOpenReceipt, onAssignKonto }: Props) {
  const [dim, setDim] = useState<AnalyseDim>('supplier');
  const [drill, setDrill] = useState<string | null>(null);
  const [unkontiertOffen, setUnkontiertOffen] = useState(false);
  const [zuweisungLaeuft, setZuweisungLaeuft] = useState<string | null>(null);
  const unkontiertListe = useMemo(() => listeUnkontierte(entries), [entries]);
  // Dropdown: alle Warenkonten des Mandanten + 4701 (Betrieb) + 4800 (Pfand/Depot).
  const kontoOptionen = useMemo(() => {
    const opts = konten.map(k => ({ value: k.value, label: `${k.value} ${k.label}` }));
    if (!opts.some(o => o.value === '4701')) opts.push({ value: '4701', label: '4701 Betriebsmaterial' });
    if (!opts.some(o => o.value === '4800')) opts.push({ value: '4800', label: '4800 Pfand/Depot/Gebinde' });
    return opts;
  }, [konten]);

  // ALLE Sichten dieses Blocks auf der EINEN Definition: direkter
  // Warenaufwand 4020–4070 (Splits anteilig, Depot/übrige Konten raus).
  const direktEntries = useMemo(() => nurDirektAnteil(entries), [entries]);
  const rows = useMemo(
    () => flagAnomalies(groupTotals(direktEntries, dim, konten), direktEntries, dim),
    [direktEntries, dim, konten],
  );
  const kpis = useMemo(() => analyseKpis(entries), [entries]);
  const tops = useMemo(() => topInvoices(direktEntries, 8), [direktEntries]);
  const wkqRows = useMemo(
    () => wochenWkq(entries, revenueByDate, zielPct),
    [entries, revenueByDate, zielPct],
  );
  const totalRevenue = useMemo(
    () => Object.values(revenueByDate).reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0),
    [revenueByDate],
  );
  // WKQ auf dem DIREKTEN Warenaufwand (Konten 4020–4070 = Erfolgsrechnung) —
  // Betriebs-/übrige Konten und Unkontiertes zählen NIE in die Quote.
  const gesamtWkq = totalRevenue > 0 && kpis.relevantNet > 0 ? (kpis.relevantNet / totalRevenue) * 100 : null;
  const foodWkq = totalRevenue > 0 && kpis.foodNet > 0 ? (kpis.foodNet / totalRevenue) * 100 : null;
  const bevWkq = totalRevenue > 0 && kpis.beverageNet > 0 ? (kpis.beverageNet / totalRevenue) * 100 : null;
  /** Quote einer Zeile auf den Perioden-Umsatz (nie durch 0 teilen). */
  const quoteOf = (net: number): number | null =>
    totalRevenue > 0 && net > 0 ? (net / totalRevenue) * 100 : null;

  const drillEntries = useMemo(() => {
    if (!drill) return [];
    // Drilldown auf derselben Basis wie die Gruppen (direkte Anteile).
    return direktEntries
      .filter(e => {
        if (dim === 'supplier') return supplierKeyOf(e) === drill;
        if (dim === 'konto') return kontoShares(e).some(s => s.konto === drill);
        if (dim === 'week') return isoWeekKeyOf(e.date) === drill;
        return e.date.slice(0, 7) === drill;
      })
      .sort((a, b) => b.amountNet - a.amountNet);
  }, [direktEntries, dim, drill]);

  const anomalien = rows.filter(r => r.flagged);

  if (entries.length === 0) return null;

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden" data-testid="waren-analyse-block">
      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          Anomalie-Analyse · {periodLabel}
          {anomalien.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {anomalien.length} auffällig
            </span>
          )}
        </h2>
        {/* Ansicht umschalten */}
        <div className="flex rounded-md overflow-hidden border border-border h-8 text-xs font-medium">
          {(Object.keys(DIM_LABEL) as AnalyseDim[]).map(k => (
            <button
              key={k} type="button"
              data-testid={`analyse-dim-${k}`}
              onClick={() => { setDim(k); setDrill(null); }}
              className={cn(
                'px-3 transition-colors border-l border-border first:border-l-0',
                dim === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
              )}
            >{DIM_LABEL[k]}</button>
          ))}
        </div>
      </div>

      {/* Kennzahlen-Kopf */}
      <div className="px-5 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 border-b border-border/50 text-xs">
        <div>
          <div className="text-muted-foreground">Direkter Warenaufwand (4020–4070)</div>
          <div className="text-sm font-bold tabular-nums">CHF {fmtChf(kpis.totalNet)}</div>
          {(kpis.uebrigNet > 0 || kpis.unkontiertNet !== 0) && (
            <div className="text-[10px] text-muted-foreground" data-testid="direkt-hinweis">
              nicht enthalten:{kpis.uebrigNet > 0 ? ` Betriebs-/übrige Konten CHF ${fmtChf(kpis.uebrigNet)}` : ''}
              {kpis.uebrigNet > 0 && kpis.unkontiertNet !== 0 ? ' ·' : ''}
              {kpis.unkontiertNet !== 0 ? ` unkontiert CHF ${fmtChf(kpis.unkontiertNet)}` : ''}
            </div>
          )}
        </div>
        <div>
          <div className="text-muted-foreground">WKQ vs. Ziel {zielPct.toFixed(0)} %</div>
          <div className={cn('text-sm font-bold tabular-nums',
            gesamtWkq === null ? 'text-muted-foreground/40'
              : gesamtWkq > zielPct ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
            {gesamtWkq === null ? '–' : `${gesamtWkq.toFixed(1)} %`}
          </div>
          {kpis.unkontiert > 0 && (
            onAssignKonto ? (
              <button
                type="button"
                onClick={() => setUnkontiertOffen(o => !o)}
                className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-amber-700 cursor-pointer"
                data-testid="wkq-unkontiert-hinweis"
                title="Klicken: Positionen anzeigen und direkt kontieren"
              >
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {kpis.unkontiert} unkontierte Position{kpis.unkontiert === 1 ? '' : 'en'} — nicht in der Quote
              </button>
            ) : (
              <div className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="wkq-unkontiert-hinweis">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {kpis.unkontiert} unkontierte Position{kpis.unkontiert === 1 ? '' : 'en'} — nicht in der Quote
              </div>
            )
          )}
        </div>
        <div>
          <div className="text-muted-foreground">Anteil Food / Beverage</div>
          <div className="text-sm font-bold tabular-nums">
            {kpis.foodSharePct === null ? '–' : `${kpis.foodSharePct.toFixed(1)} % / ${(kpis.beverageSharePct ?? 0).toFixed(1)} %`}
          </div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            WKQ {foodWkq === null ? '–' : `${foodWkq.toFixed(1)} %`} / {bevWkq === null ? '–' : `${bevWkq.toFixed(1)} %`} vom Umsatz
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Top-3-Kostentreiber</div>
          <div className="text-[11px] font-medium leading-tight">
            {kpis.top3.length === 0 ? '–' : kpis.top3.map(t => t.label).join(' · ')}
          </div>
        </div>
      </div>

      {/* ── Unkontierte Positionen: Liste + Direkt-Kontierung ─────────── */}
      {unkontiertOffen && onAssignKonto && unkontiertListe.length > 0 && (
        <div className="px-5 py-3 border-b border-border/50 bg-amber-50/40 dark:bg-amber-950/10 text-xs" data-testid="unkontiert-panel">
          <p className="font-medium mb-1.5">
            Unkontierte Positionen — Konto zuweisen, damit sie in die Quote einfliessen.
            Bei eindeutiger Artikel-Identität wird die Zuordnung als Artikel→Konto-Regel gemerkt und gilt künftig automatisch.
          </p>
          <table className="w-full">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="font-normal pr-2 py-0.5">Datum</th>
                <th className="font-normal pr-2">Lieferant</th>
                <th className="font-normal pr-2">Beleg-Nr.</th>
                <th className="font-normal pr-2">Artikel / Warengruppe</th>
                <th className="font-normal text-right pr-3">Netto</th>
                <th className="font-normal">Konto zuweisen</th>
              </tr>
            </thead>
            <tbody>
              {unkontiertListe.map(pos => {
                const rowKey = `${pos.entryId}:${pos.splitIndex ?? 'e'}`;
                return (
                  <tr key={rowKey} className="border-t border-border/30" data-testid={`unkontiert-zeile-${rowKey}`}>
                    <td className="pr-2 py-1 tabular-nums whitespace-nowrap">{pos.datum.split('-').reverse().join('.')}</td>
                    <td className="pr-2 font-medium">{pos.lieferant}</td>
                    <td className="pr-2 tabular-nums">{pos.beleg ?? '—'}</td>
                    <td className="pr-2">{pos.bezeichnung ?? '—'}</td>
                    <td className="text-right tabular-nums pr-3 whitespace-nowrap">CHF {fmtChf(pos.betragNet)}</td>
                    <td className="py-0.5">
                      <select
                        className="h-7 rounded border border-border bg-background px-1.5 text-xs min-w-[160px] disabled:opacity-50"
                        defaultValue=""
                        disabled={zuweisungLaeuft === rowKey}
                        data-testid={`unkontiert-konto-${rowKey}`}
                        onChange={async ev => {
                          const konto = ev.target.value;
                          if (!konto) return;
                          setZuweisungLaeuft(rowKey);
                          try {
                            const ok = await onAssignKonto(pos, konto);
                            if (!ok) ev.target.value = '';
                          } finally {
                            setZuweisungLaeuft(null);
                          }
                        }}
                      >
                        <option value="" disabled>Konto wählen…</option>
                        {kontoOptionen.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-0 lg:divide-x divide-border/50">
        {/* Gruppen-Tabelle mit Anomalie-Markierung + Drilldown */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">{DIM_LABEL[dim]}</th>
                <th className="px-4 py-2 text-right font-medium">Netto CHF</th>
                {dim === 'supplier' && <th className="px-4 py-2 text-right font-medium">Anteil</th>}
                <th className="px-4 py-2 text-right font-medium">Rechn.</th>
                <th className="px-4 py-2 text-right font-medium">{dim === 'week' ? 'WKQ' : 'Quote'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const wkq = dim === 'week' ? wkqRows.find(w => w.weekKey === r.key) : undefined;
                return (
                  <Fragment key={r.key}>
                    <tr
                      data-testid={`analyse-row-${r.key}`}
                      onClick={() => setDrill(d => (d === r.key ? null : r.key))}
                      className={cn(
                        'border-b border-border/40 cursor-pointer hover:bg-muted/20 transition-colors',
                        r.flagged && 'bg-red-50 dark:bg-red-950/20',
                      )}
                    >
                      <td className="px-4 py-2 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <ChevronDown className={cn('h-3 w-3 text-muted-foreground/50 transition-transform', drill === r.key && 'rotate-180')} />
                          {r.label}
                          {r.flagged && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                              <AlertTriangle className="h-3 w-3" />
                              {r.deltaPct !== null ? `+${r.deltaPct} % über Schnitt` : 'über Schnitt'}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={cn('px-4 py-2 text-right tabular-nums font-semibold', r.flagged && 'text-red-600 dark:text-red-400')}>
                        {fmtChf(r.totalNet)}
                      </td>
                      {dim === 'supplier' && (
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {kpis.totalNet > 0 ? `${((r.totalNet / kpis.totalNet) * 100).toFixed(1)} %` : '–'}
                        </td>
                      )}
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{r.count}</td>
                      {dim === 'week' ? (
                        <td className={cn('px-4 py-2 text-right tabular-nums text-xs font-semibold',
                          !wkq || wkq.wkqPct === null ? 'text-muted-foreground/40'
                            : wkq.ampel === 'red' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                          {wkq && wkq.wkqPct !== null ? `${wkq.wkqPct.toFixed(1)} %` : '–'}
                        </td>
                      ) : (
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {quoteOf(r.totalNet) !== null ? `${quoteOf(r.totalNet)!.toFixed(1)} %` : '–'}
                        </td>
                      )}
                    </tr>
                    {drill === r.key && drillEntries.map(e => (
                      <tr key={e.id} className="border-b border-border/30 bg-muted/10 text-xs">
                        <td className="pl-10 pr-4 py-1.5 text-muted-foreground">
                          {e.date} · {dim === 'supplier' ? (e.warenkonto ?? e.kontoSplits?.map(s => s.warenkonto).join('/') ?? '—') : e.supplierName}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtChf(e.amountNet)}</td>
                        <td className="px-4 py-1.5 text-right" colSpan={dim === 'supplier' ? 3 : 2}>
                          {e.receiptPath && onOpenReceipt && (
                            <button type="button" className="text-primary hover:underline inline-flex items-center gap-0.5"
                              onClick={ev => { ev.stopPropagation(); onOpenReceipt(e.receiptPath!); }}>
                              <Paperclip className="h-3 w-3" /> Beleg
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[10px] text-muted-foreground/60">
            Rot = deutlich über dem eigenen Schnitt der Vorwochen (&gt; +30 %){dim === 'week' ? ' · WKQ rot = über Ziel-Quote' : ''}. Klick auf eine Zeile zeigt die Rechnungen.
          </p>
        </div>

        {/* Top-Einzelrechnungen */}
        <div className="overflow-x-auto border-t lg:border-t-0 border-border/50">
          <div className="px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/10 border-b border-border">
            Grösste Einzelrechnungen
          </div>
          <table className="w-full text-sm">
            <tbody>
              {tops.map((e, i) => (
                <tr key={e.id} className="border-b border-border/40" data-testid={`top-invoice-${i}`}>
                  <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums w-8">{i + 1}.</td>
                  <td className="px-4 py-2 font-medium text-xs">
                    {e.supplierName}
                    <span className="text-muted-foreground/60 ml-1.5">{e.date}</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-xs">CHF {fmtChf(e.amountNet)}</td>
                  <td className="px-2 py-2 w-8">
                    {e.receiptPath && onOpenReceipt && (
                      <button type="button" className="text-primary" onClick={() => onOpenReceipt(e.receiptPath!)}>
                        <Paperclip className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
