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
import { nurWarenAnteil, sumBetriebNet, DEFAULT_WARENKOSTEN_GRENZE } from '@/lib/waren-klassen';
import { zaehleUnkontierte, computeWarenkostenTotals, expandKontoSplits, warenkostenQuote, wkqFarbklasse } from '@/lib/warenkosten-quote';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { applyAliasGruppen, type AliasGruppe } from '@/lib/waren-alias-gruppen';
import { lieferantStatus, type LieferantAbgleichStatus } from '@/lib/waren-monatsabgleich';
import {
  aggregateBySupplier, sumInvoicesNet, warenkostenquote, monthDateRange,
  resolveKategorieWarenSoll,
} from '@/lib/waren-cockpit';
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


const WKQ_TEXT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'text-emerald-600 dark:text-emerald-400',
  yellow: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
};
const WKQ_DOT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500',
};

/** Eine Zeile im Ist/Soll-Block: Δ nur wenn beide Seiten vorhanden, WKQ nur bei Umsatz. */
function IstSollZeile({ label, ist, soll, umsatzNet, testId, indent }: {
  label: string; ist: number; soll: number | null; umsatzNet: number | null;
  testId: string; indent?: boolean;
}) {
  const delta = soll != null ? ist - soll : null;
  const deltaPct = delta != null && soll != null && soll > 0 ? (delta / soll) * 100 : null;
  const wkq = warenkostenQuote(ist, umsatzNet);
  const farbe = wkq != null ? wkqFarbklasse(wkq) : null;
  return (
    <tr className="border-b border-border/40" data-testid={testId}>
      <td className={cn('py-2 font-medium', indent && 'pl-4 text-muted-foreground')}>{label}</td>
      <td className="py-2 text-right tabular-nums font-semibold">{fmtChf(ist)}</td>
      <td className="py-2 text-right tabular-nums text-muted-foreground">
        {soll != null ? fmtChf(soll) : <span title="Kein Wareneinsatz-Budget erfasst">—</span>}
      </td>
      <td className="py-2 text-right">
        {delta != null ? (
          <span className="inline-flex flex-col items-end leading-tight">
            <span className={cn('tabular-nums font-semibold',
              delta > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
              {delta >= 0 ? '+' : ''}{fmtChf(delta)}
            </span>
            {deltaPct != null && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {deltaPct >= 0 ? '+' : ''}{deltaPct.toLocaleString('de-CH', { maximumFractionDigits: 1 })} %
              </span>
            )}
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 text-right">
        {wkq != null && farbe != null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full inline-block', WKQ_DOT[farbe])} />
            <span className={cn('tabular-nums font-semibold', WKQ_TEXT[farbe])}>{fmtPct(wkq)}</span>
          </span>
        ) : <span className="text-muted-foreground" title="Kein Netto-Umsatz für den Monat importiert">—</span>}
      </td>
    </tr>
  );
}

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
  const [umsatzFood, setUmsatzFood] = useState<number | null>(null);
  const [umsatzBev, setUmsatzBev] = useState<number | null>(null);
  const [zielPct, setZielPct] = useState<number>(DEFAULT_ZIEL_WARENQUOTE_PCT);
  const [zielEdit, setZielEdit] = useState<string | null>(null); // Eingabe-String im Edit-Modus
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);

  // Rechnungen + Umsatz des Cockpit-Monats laden (Tenant-Reset inklusive).
  useEffect(() => {
    let alive = true;
    setInvoices(null); setUmsatzNet(null); setUmsatzFood(null); setUmsatzBev(null); setOpenSupplier(null);
    const { from, to } = monthDateRange(year, month);
    loadMonthInvoices(tenantId, monthKey)
      .then(list => { if (alive) setInvoices(list); })
      .catch(() => { if (alive) setInvoices([]); });
    ladeUmsatzTage(tenantId, from, to)
      .then(map => {
        if (!alive) return;
        if (map.size === 0) {
          setUmsatzNet(null); setUmsatzFood(null); setUmsatzBev(null);
          return;
        }
        // Dieselbe kanonische Kategorie-Umsatzquelle wie Monatsreport und
        // Wochenübersicht (summiereUmsatz → foodBeverageSplit).
        const summe = summiereUmsatz(map.values());
        setUmsatzNet(summe.netto);
        setUmsatzFood(summe.food);
        setUmsatzBev(summe.beverage);
      })
      .catch(() => {
        if (alive) { setUmsatzNet(null); setUmsatzFood(null); setUmsatzBev(null); }
      });
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
  // Food/Beverage-Split NUR über relevanten Wareneinsatz: Betriebskosten-Anteile
  // (z.B. 4701 Betriebsmaterial) und Depot/Pfand sind bereits durch nurWarenAnteil
  // draussen; verbleibende «Sonstiges»-Einträge zählen ebenfalls NICHT in die Quote.
  const totals = useMemo(
    () => (warenInvoices ? computeWarenkostenTotals(expandKontoSplits(warenInvoices), warenGrenze) : null),
    [warenInvoices, warenGrenze],
  );
  // Hinweis-Betrag: alles ausserhalb der Quote (Betriebskosten-Anteile + Sonstiges).
  const betriebsNet = useMemo(
    () => (invoices ? sumBetriebNet(invoices, warenGrenze) + (totals?.sonstigeNet ?? 0) : 0),
    [invoices, warenGrenze, totals],
  );
  // Das bestehende Wareneinsatz-Gesamtbudget bleibt autoritativ. Food/Beverage
  // werden auf derselben kanonischen Kategorie-Umsatzbasis wie die Wochenansicht
  // proportional aufgeteilt; ohne absolutes Budget greift Ziel-WKQ × Umsatz.
  const budget = useBudgetMonth(year, month);
  const budgetTotal = budget.foodCostBudget > 0 || budget.beverageCostBudget > 0
    ? Math.round((Math.max(0, budget.foodCostBudget) + Math.max(0, budget.beverageCostBudget)) * 100) / 100
    : null;
  const soll = useMemo(() => resolveKategorieWarenSoll({
    totalSoll: budgetTotal,
    foodUmsatz: umsatzFood,
    beverageUmsatz: umsatzBev,
    zielPct,
  }), [budgetTotal, umsatzFood, umsatzBev, zielPct]);
  // Transparenz: unkontierte Einträge/Splits zählen als Warenkosten mit —
  // solange N > 0 ist die WKQ unscharf und wird sichtbar gekennzeichnet.
  const unkontiert = useMemo(() => (invoices ? zaehleUnkontierte(invoices) : 0), [invoices]);
  const supplierRows = useMemo(
    () => (warenInvoices ? aggregateBySupplier(applyAliasGruppen(warenInvoices, aliasGruppen)) : []),
    [warenInvoices, aliasGruppen],
  );
  // Lieferschein↔Monatsrechnungs-Status pro Lieferant (provisorisch /
  // abgeglichen / Differenz offen) — auf Alias-Namen aggregiert wie supplierRows.
  const supplierStatus = useMemo(() => {
    const map = new Map<string, InvoiceEntry[]>();
    for (const e of applyAliasGruppen(warenInvoices ?? [], aliasGruppen)) {
      const key = (e.supplierName || '—').trim() || '—';
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    const out = new Map<string, LieferantAbgleichStatus>();
    for (const [k, v] of map) out.set(k, lieferantStatus(v));
    return out;
  }, [warenInvoices, aliasGruppen]);
  const wkq = warenkostenquote(totalNet, umsatzNet ?? 0);
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
      {/* Kopf */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <ShoppingCart className="h-3.5 w-3.5 text-primary" /> Warenkosten
        </span>
        <span className="text-[11px] text-muted-foreground" data-testid="wk-kontext">
          netto · nur Wareneinsatz · Monat {String(month).padStart(2, '0')}/{year}
        </span>
        {unkontiert > 0 && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="wk-unkontiert-hinweis"
            title="Positionen ohne Warenkonto zählen bis zur Kontierung als Warenkosten — die Quote ist entsprechend unscharf.">
            enthält {unkontiert} unkontierte Position{unkontiert === 1 ? '' : 'en'}
          </span>
        )}
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

      {/* Ist vs. Wareneinsatz-Soll, Food/Beverage nach Kategorie-Umsatz getrennt */}
      <div className="px-4 py-3 border-b border-border" data-testid="wk-ist-soll-block">
        {invoices == null || totals == null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-1.5 font-medium"></th>
                  <th className="text-right py-1.5 font-medium">Ist (CHF)</th>
                  <th className="text-right py-1.5 font-medium" title="Gesamt-Soll aus der Budget-Eingabe; Food/Beverage proportional zum jeweiligen Netto-Umsatz (Fallback: Ziel-WKQ × Umsatz)">Soll (CHF)</th>
                  <th className="text-right py-1.5 font-medium">Δ</th>
                  <th className="text-right py-1.5 font-medium" title="Ist ÷ Netto-Umsatz · ≤30 % grün, 30–35 % gelb, >35 % rot">WKQ</th>
                </tr>
              </thead>
              <tbody>
                <IstSollZeile label="Warenkosten total" ist={totals.relevantNet} soll={soll.total}
                  umsatzNet={umsatzNet} testId="wk-zeile-total" />
                <IstSollZeile label="davon Food (Küche)" ist={totals.foodNet} soll={soll.food}
                  umsatzNet={umsatzFood} testId="wk-zeile-food" indent />
                <IstSollZeile label="davon Beverage (Bar)" ist={totals.beverageNet} soll={soll.beverage}
                  umsatzNet={umsatzBev} testId="wk-zeile-beverage" indent />
              </tbody>
            </table>
            {betriebsNet > 0.005 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="wk-betriebskosten-hinweis">
                Betriebskosten CHF {fmtChf(betriebsNet)}, nicht in Quote (z.B. Betriebsmaterial 4701, Gebinde/Pfand).
              </p>
            )}
          </>
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
                <th className="text-right py-1.5 font-medium" title="Lieferschein↔Monatsrechnung: provisorisch = nur Lieferscheine · abgeglichen = Monatsrechnung massgeblich · Differenz offen = Abgleich nicht übernommen">Status</th>
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
                      <td className="py-1.5 text-right" data-testid={`wk-status-${row.supplierName}`}>
                        {(() => {
                          const st = supplierStatus.get(row.supplierName) ?? 'provisorisch';
                          const cls = st === 'differenz_offen'
                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                            : st === 'abgeglichen'
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground';
                          const label = st === 'differenz_offen' ? 'Differenz offen' : st;
                          return <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', cls)}>{label}</span>;
                        })()}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-muted/20">
                        <td colSpan={5} className="py-1.5 pl-6 pr-2">
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
