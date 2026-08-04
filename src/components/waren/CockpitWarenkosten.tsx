/**
 * CockpitWarenkosten — Warenkosten-Block im Meeting-Cockpit.
 * ==========================================================
 * Für den im Cockpit gewählten Monat (folgt year/month-Props):
 *  - Warenkosten (CHF netto) = Summe der erfassten Warenrechnungen
 *  - WKQ = Warenkosten ÷ Netto-Umsatz (Umsatz-SSOT umsatz.ts), Ampel gegen die
 *    konfigurierbare Ziel-Warenkostenquote (pro Mandant), Abweichung in pp
 *  - optional WKQ Vorjahr aus der Buchhaltung (nur wenn Daten vorhanden)
 *  - Lieferantenübersicht (Betrag, Anteil %, Anzahl) mit Drilldown pro Lieferant
 *  - unten Abgleich: erfasste Rechnungen vs. Buchhaltung/ER (total_cogs) — reine Anzeige
 *
 * Rein lesend für Gäste/Viewer; die Zielquote dürfen nur Admin (nicht Gast)
 * bzw. Beaulieu-Geschäftsführung anpassen. Mandantengetrennt über tenantId.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { TenantId } from '@/contexts/TenantContext';
import { ShoppingCart, ChevronDown, ChevronRight, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { loadMonthInvoices, loadAliasGruppen, loadWarenkostenGrenze, type InvoiceEntry } from '@/lib/waren-db';
import { nurWarenAnteil, DEFAULT_WARENKOSTEN_GRENZE } from '@/lib/waren-klassen';
import { applyAliasGruppen, type AliasGruppe } from '@/lib/waren-alias-gruppen';
import { aggregateBySupplier, sumInvoicesNet, warenkostenquote, wkqAmpel, monthDateRange } from '@/lib/waren-cockpit';
import {
  loadZielWarenquote, saveZielWarenquote, normalizeZielWarenquotePct,
  DEFAULT_ZIEL_WARENQUOTE_PCT,
} from '@/lib/ziel-warenquote';
import { ladeUmsatzTage, summiereUmsatz } from '@/lib/umsatz';
import { loadMonth as loadReportingMonth, STORAGE_KEY as REPORTING_KEY } from '@/lib/reporting-store';
import { computePLForMonth } from '@/lib/pl-engine';
import { tenantKey as makeTenantKey } from '@/lib/tenant-utils';
import { cn } from '@/lib/utils';

const fmtChf = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) =>
  `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

/** Buchhaltungs-Warenaufwand (total_cogs, Ist) eines Monats; null wenn keine Daten. */
function buchhaltungCogs(tenantId: TenantId, year: number, month: number): number | null {
  try {
    const record = loadReportingMonth(year, month, makeTenantKey(tenantId, REPORTING_KEY));
    const pl = computePLForMonth(record);
    const v = pl.rows.find(r => r.def.id === 'total_cogs')?.values.actual;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** WKQ Vorjahr aus der Buchhaltung (total_cogs ÷ revenue_total, Ist); null wenn unvollständig. */
function vorjahrWkq(tenantId: TenantId, year: number, month: number): number | null {
  try {
    const record = loadReportingMonth(year - 1, month, makeTenantKey(tenantId, REPORTING_KEY));
    const pl = computePLForMonth(record);
    const cogs = pl.rows.find(r => r.def.id === 'total_cogs')?.values.actual;
    const rev = pl.rows.find(r => r.def.id === 'revenue_total')?.values.actual;
    if (typeof cogs !== 'number' || typeof rev !== 'number' || !(rev > 0) || cogs === 0) return null;
    return (Math.abs(cogs) / rev) * 100;
  } catch {
    return null;
  }
}

export function CockpitWarenkosten({ year, month }: { year: number; month: number }) {
  const { tenantId } = useTenant();
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const canEditZiel = isAdmin || isBeaulieuManager;

  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const [invoices, setInvoices] = useState<InvoiceEntry[] | null>(null);
  const [umsatzNet, setUmsatzNet] = useState<number | null>(null);
  const [zielPct, setZielPct] = useState<number>(DEFAULT_ZIEL_WARENQUOTE_PCT);
  const [zielEdit, setZielEdit] = useState<string | null>(null); // Eingabe-String im Edit-Modus
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);

  // Rechnungen + Umsatz des Cockpit-Monats laden (Tenant-Reset inklusive).
  useEffect(() => {
    let alive = true;
    setInvoices(null); setUmsatzNet(null); setOpenSupplier(null);
    const { from, to } = monthDateRange(year, month);
    loadMonthInvoices(tenantId, monthKey)
      .then(list => { if (alive) setInvoices(list); })
      .catch(() => { if (alive) setInvoices([]); });
    ladeUmsatzTage(tenantId, from, to)
      .then(map => { if (alive) setUmsatzNet(map.size > 0 ? summiereUmsatz(map.values()).netto : null); })
      .catch(() => { if (alive) setUmsatzNet(null); });
    return () => { alive = false; };
  }, [tenantId, monthKey]);

  // Zielquote laden (pro Mandant).
  useEffect(() => {
    let alive = true;
    setZielPct(DEFAULT_ZIEL_WARENQUOTE_PCT); setZielEdit(null);
    loadZielWarenquote(tenantId).then(b => { if (alive) setZielPct(b.pct); }).catch(() => undefined);
    return () => { alive = false; };
  }, [tenantId]);

  // Lieferanten-Alias-Gruppen (mandantengetrennt): nur für die Lieferanten-
  // Gruppierung — Totale/WKQ bleiben unverändert.
  const [aliasGruppen, setAliasGruppen] = useState<AliasGruppe[]>([]);
  useEffect(() => {
    let alive = true;
    setAliasGruppen([]);
    loadAliasGruppen(tenantId).then(g => { if (alive) setAliasGruppen(g); }).catch(() => undefined);
    return () => { alive = false; };
  }, [tenantId]);

  // Kontoklassen: Total/WKQ/Lieferanten-Zeilen nur aus Warenkosten-Anteilen
  // (4000–Grenze) — Betriebskosten-/Depot-Anteile fliessen NIE in die WKQ
  // (gleiche Basis wie Warenrechnungen-Seite und Monatsreport).
  const [warenGrenze, setWarenGrenze] = useState<number>(DEFAULT_WARENKOSTEN_GRENZE);
  useEffect(() => {
    let alive = true;
    setWarenGrenze(DEFAULT_WARENKOSTEN_GRENZE);
    loadWarenkostenGrenze(tenantId).then(g => { if (alive) setWarenGrenze(g); }).catch(() => undefined);
    return () => { alive = false; };
  }, [tenantId]);
  const warenInvoices = useMemo(
    () => (invoices ? nurWarenAnteil(invoices, warenGrenze) : null),
    [invoices, warenGrenze],
  );
  const totalNet = useMemo(() => (warenInvoices ? sumInvoicesNet(warenInvoices) : 0), [warenInvoices]);
  const supplierRows = useMemo(
    () => (warenInvoices ? aggregateBySupplier(applyAliasGruppen(warenInvoices, aliasGruppen)) : []),
    [warenInvoices, aliasGruppen],
  );
  const wkq = warenkostenquote(totalNet, umsatzNet ?? 0);
  const ampel = wkqAmpel(wkq, zielPct);
  const buchhaltung = useMemo(() => buchhaltungCogs(tenantId, year, month), [tenantId, year, month]);
  const wkqVorjahr = useMemo(() => vorjahrWkq(tenantId, year, month), [tenantId, year, month]);
  const buchhaltungAbs = buchhaltung != null ? Math.abs(buchhaltung) : null;

  async function saveZiel() {
    if (zielEdit == null) return;
    const pct = normalizeZielWarenquotePct(zielEdit);
    setZielPct(pct); setZielEdit(null);
    try { await saveZielWarenquote(tenantId, pct); } catch { /* localStorage bleibt primär */ }
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm" data-testid="cockpit-warenkosten">
      {/* Kopf + KPI */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <ShoppingCart className="h-3.5 w-3.5 text-primary" /> Warenkosten
        </span>
        <span className="inline-flex items-baseline gap-1.5" data-testid="wk-total">
          <span className="text-xs text-muted-foreground">CHF</span>
          <span className="text-lg font-bold tabular-nums">{invoices ? fmtChf(totalNet) : '…'}</span>
        </span>
        <span className="inline-flex items-center gap-1.5" data-testid="wk-quote">
          <span className="text-xs text-muted-foreground">WKQ</span>
          {wkq != null ? (
            <>
              <span className={cn('h-2.5 w-2.5 rounded-full inline-block',
                ampel === 'green' ? 'bg-emerald-500' : 'bg-red-500')} />
              <span className={cn('text-lg font-bold tabular-nums',
                ampel === 'green' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                {fmtPct(wkq)}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                ({wkq - zielPct >= 0 ? '+' : ''}{(wkq - zielPct).toLocaleString('de-CH', { maximumFractionDigits: 1 })} pp)
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground" title="Kein Netto-Umsatz für den Monat importiert">—</span>
          )}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="wk-ziel">
          Ziel
          {zielEdit != null ? (
            <span className="inline-flex items-center gap-1">
              <Input value={zielEdit} onChange={e => setZielEdit(e.target.value)}
                className="h-6 w-16 text-xs px-1.5" data-testid="input-wk-ziel"
                onKeyDown={e => { if (e.key === 'Enter') void saveZiel(); if (e.key === 'Escape') setZielEdit(null); }} />
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void saveZiel()} data-testid="button-wk-ziel-save"><Check className="h-3 w-3" /></Button>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setZielEdit(null)}><X className="h-3 w-3" /></Button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="font-semibold text-foreground tabular-nums">{fmtPct(zielPct)}</span>
              {canEditZiel && (
                <Button size="icon" variant="ghost" className="h-5 w-5" title="Zielquote anpassen"
                  onClick={() => setZielEdit(String(zielPct))} data-testid="button-wk-ziel-edit">
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </span>
          )}
        </span>
        {wkqVorjahr != null && (
          <span className="text-[11px] text-muted-foreground whitespace-nowrap" data-testid="wk-vorjahr">
            WKQ Vorjahr (Buchhaltung): <span className="tabular-nums font-medium">{fmtPct(wkqVorjahr)}</span>
          </span>
        )}
      </div>

      {/* Lieferantenübersicht */}
      <div className="px-4 py-3">
        {invoices && invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine Warenrechnungen für diesen Monat erfasst.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-1.5 font-medium">Lieferant</th>
                <th className="text-right py-1.5 font-medium">Betrag (CHF netto)</th>
                <th className="text-right py-1.5 font-medium" title="Lieferant ÷ Netto-Umsatz des Monats — die Anteile summieren sich zur Gesamt-WKQ">Anteil Umsatz</th>
                <th className="text-right py-1.5 font-medium">Rechnungen</th>
              </tr>
            </thead>
            <tbody>
              {supplierRows.map(row => {
                const open = openSupplier === row.supplierName;
                const details = open
                  ? (invoices ?? []).filter(e => (e.supplierName || '—').trim() === row.supplierName || e.supplierName === row.supplierName)
                      .sort((a, b) => a.date.localeCompare(b.date))
                  : [];
                return (
                  <Fragment key={row.supplierName}>
                    <tr
                      className="border-b border-border/40 hover:bg-muted/40 cursor-pointer"
                      data-testid={`wk-supplier-${row.supplierName}`}
                      onClick={() => setOpenSupplier(open ? null : row.supplierName)}>
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1 font-medium">
                          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {row.supplierName}
                        </span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{fmtChf(row.totalNet)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {umsatzNet != null && umsatzNet > 0 ? fmtPct((row.totalNet / umsatzNet) * 100) : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{row.count}</td>
                    </tr>
                    {open && (
                      <tr className="bg-muted/20">
                        <td colSpan={4} className="py-1.5 pl-6 pr-2">
                          <table className="w-full text-[11px]">
                            <tbody>
                              {details.map(e => (
                                <tr key={e.id} className="text-muted-foreground">
                                  <td className="py-0.5 font-mono">{e.date}</td>
                                  <td className="py-0.5">{e.kategorie ?? ''}</td>
                                  <td className="py-0.5 truncate max-w-[200px]">{e.reference ?? e.note ?? ''}</td>
                                  <td className="py-0.5 text-right tabular-nums text-foreground">{fmtChf(e.amountNet)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right tabular-nums" data-testid="wk-table-total">{fmtChf(totalNet)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {wkq != null ? fmtPct(wkq) : '—'}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{invoices?.length ?? 0}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Buchhaltungs-Abgleich (reine Anzeige) */}
      <div className="px-4 py-2.5 border-t border-border bg-muted/20 text-xs flex flex-wrap gap-x-5 gap-y-1"
        data-testid="wk-abgleich">
        <span>Warenrechnungen erfasst: <span className="font-semibold tabular-nums">CHF {fmtChf(totalNet)}</span></span>
        <span>Buchhaltung/ER: {buchhaltungAbs != null
          ? <span className="font-semibold tabular-nums">CHF {fmtChf(buchhaltungAbs)}</span>
          : <span className="text-muted-foreground">keine Daten</span>}
        </span>
        {buchhaltungAbs != null && (
          <span>Differenz: <span className={cn('font-semibold tabular-nums',
            Math.abs(buchhaltungAbs - totalNet) < 0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
            CHF {fmtChf(buchhaltungAbs - totalNet)}
          </span></span>
        )}
      </div>
    </div>
  );
}
