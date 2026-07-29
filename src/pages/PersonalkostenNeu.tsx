/**
 * PersonalkostenNeu — «NEU – Prüfung»
 * Prüfansicht, die AUSSCHLIESSLICH die zentrale Berechnungsquelle
 * src/lib/personalkosten.ts nutzt (Etappe 1). Bestehende Ansichten bleiben
 * unverändert; diese Seite dient dem Zahlen-Abgleich vor der Umstellung.
 */
import { useEffect, useMemo, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { ChevronLeft, ChevronRight, ChevronDown, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import {
  ladePersonalkostenDaten, fixKosten, flexKostenProTag, personalkosten,
  budget, umsatz, personalquote, letzterVergangenerTag, budgetZielQuote,
  type PersonalkostenDaten,
} from '@/lib/personalkosten';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';

const fmtCHF = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtCHF2 = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number | null) => (v == null ? '–' : `${(v * 100).toFixed(1)} %`);
const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function Kachel({ title, value, sub, tone }: {
  title: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm flex flex-col gap-1">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      <p className={cn('text-2xl font-bold tracking-tight',
        tone === 'good' && 'text-emerald-600', tone === 'bad' && 'text-red-600')}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function PersonalkostenNeu() {
  const { tenantId, tenantKey } = useTenant();
  const { rates, loading: ratesLoading } = useSocialCostRates();
  const now = new Date();
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [daten, setDaten] = useState<PersonalkostenDaten | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  useEffect(() => {
    if (ratesLoading) return;
    let alive = true;
    setLoading(true);
    setError(null);
    ladePersonalkostenDaten(year, month, tenantId, tenantKey, rates)
      .then(d => { if (alive) setDaten(d); })
      .catch(e => { if (alive) { setDaten(null); setError(String(e?.message ?? e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, tenantId, ratesLoading]);

  const berechnung = useMemo(() => {
    if (!daten) return null;
    const stichtag = letzterVergangenerTag(year, month);
    const fix   = fixKosten(daten, { stichtag });
    const fixHr = fixKosten(daten);
    const tage  = flexKostenProTag(daten, { stichtag });
    const kIst  = personalkosten(daten, 'istBisHeute',  { stichtag });
    const kHr   = personalkosten(daten, 'hochrechnung', { stichtag });
    const bud   = budget(year, month, daten.gewichte, daten.pkBudgetMonat);
    const ums   = umsatz(daten, { stichtag });
    const pkq   = personalquote(daten, { stichtag });
    const zielQuote = budgetZielQuote(daten);
    const istTageBisStichtag = tage.filter(t => parseInt(t.date.slice(-2), 10) <= stichtag && t.istTag).length;
    // Flex getrennt: Ist-Anteil (Ist-Tage) und Plan-Anteil (übrige Tage) der Hochrechnung
    const flexIstAnteil  = tage.reduce((s, t) => s + (t.istTag ? t.istKosten : 0), 0);
    const flexPlanAnteil = tage.reduce((s, t) => s + (t.istTag ? 0 : t.planKosten), 0);
    return { stichtag, fix, fixHr, tage, kIst, kHr, bud, ums, pkq, zielQuote, istTageBisStichtag, flexIstAnteil, flexPlanAnteil };
  }, [daten, year, month]);

  const prev = () => { if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); };

  const stichtagDate = berechnung && berechnung.stichtag > 0
    ? `${year}-${String(month).padStart(2, '0')}-${String(berechnung.stichtag).padStart(2, '0')}`
    : null;

  let kumuliert = 0;

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Personalkosten</h1>
              <span className="text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                NEU – Prüfung
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Zentrale Berechnungsquelle (personalkosten.ts) — Zahlen-Abgleich vor der Umstellung der bestehenden Ansichten.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={prev} className="p-2 rounded-lg border hover:bg-muted"><ChevronLeft className="h-4 w-4" /></button>
            <span className="font-semibold min-w-[10rem] text-center">{MONATE[month - 1]} {year}</span>
            <button onClick={next} className="p-2 rounded-lg border hover:bg-muted"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" /> Daten konnten nicht geladen werden: {error}
          </div>
        )}
        {(loading || ratesLoading) && <p className="text-sm text-muted-foreground">Lade Daten …</p>}

        {!loading && !ratesLoading && berechnung && daten && (
          <>
            {/* ── Kacheln ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kachel
                title="Personalkosten Hochrechnung"
                value={`CHF ${fmtCHF(berechnung.kHr.total)}`}
                sub={`Fix ${fmtCHF(berechnung.kHr.fix)} + Flex ${fmtCHF(berechnung.kHr.flex)}`}
              />
              <Kachel
                title="Budget"
                value={berechnung.bud ? `CHF ${fmtCHF(berechnung.bud.total)}` : '—'}
                sub={berechnung.bud
                  ? `aus Budget-Planung ${MONATE[month - 1]} ${year}`
                  : `Kein PK-Budget in der Budget-Planung ${MONATE[month - 1]} ${year} hinterlegt`}
              />
              <Kachel
                title="Abweichung (HR − Budget)"
                value={berechnung.bud
                  ? `${berechnung.kHr.total - berechnung.bud.total >= 0 ? '+' : '−'}CHF ${fmtCHF(Math.abs(berechnung.kHr.total - berechnung.bud.total))}`
                  : '—'}
                tone={berechnung.bud
                  ? (berechnung.kHr.total <= berechnung.bud.total ? 'good' : 'bad')
                  : 'neutral'}
              />
              <Kachel
                title="PKQ Hochrechnung"
                value={fmtPct(berechnung.pkq.pkqHochrechnung)}
                sub={berechnung.zielQuote != null
                  ? `Umsatz HR: CHF ${fmtCHF(berechnung.ums.hochrechnung)} · Ziel ${fmtPct(berechnung.zielQuote)}`
                  : `Umsatz HR: CHF ${fmtCHF(berechnung.ums.hochrechnung)}`}
                tone={berechnung.pkq.pkqHochrechnung != null && berechnung.zielQuote != null
                  ? (berechnung.pkq.pkqHochrechnung <= berechnung.zielQuote ? 'good' : 'bad') : 'neutral'}
              />
            </div>

            {/* ── Ist bis heute ────────────────────────────────────────── */}
            <div className="rounded-xl border bg-card p-4 shadow-sm space-y-2">
              <p className="text-sm font-semibold">
                Ist bis heute{stichtagDate ? ` (${fmtDate(stichtagDate)})` : ''}
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Kosten Ist</p>
                  <p className="font-bold">CHF {fmtCHF(berechnung.kIst.total)}</p>
                  <p className="text-xs text-muted-foreground">Fix {fmtCHF(berechnung.kIst.fix)} + Flex {fmtCHF(berechnung.kIst.flex)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Umsatz Ist</p>
                  <p className="font-bold">CHF {fmtCHF(berechnung.ums.istBisHeute)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">PKQ Ist</p>
                  <p className="font-bold">{fmtPct(berechnung.pkq.pkqIst)}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Stand: {berechnung.istTageBisStichtag} von {berechnung.stichtag} vergangenen Tagen als Ist erfasst
                (Monat: {daten.daysInMonth} Tage).
              </p>
            </div>

            {/* ── Aufschlüsselung ──────────────────────────────────────── */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-sm font-semibold mb-2">Aufschlüsselung (Hochrechnung)</p>
              <table className="text-sm w-full max-w-md">
                <tbody>
                  <tr><td className="py-1 text-muted-foreground">Fix-Total ({daten.fixEmployees.length} MA, voller Monat)</td>
                    <td className="py-1 text-right font-mono">CHF {fmtCHF2(berechnung.fixHr.totalMonat)}</td></tr>
                  <tr><td className="py-1 text-muted-foreground">Flex Ist-Anteil (Ist-Tage)</td>
                    <td className="py-1 text-right font-mono">CHF {fmtCHF2(berechnung.flexIstAnteil)}</td></tr>
                  <tr><td className="py-1 text-muted-foreground">Flex Plan-Anteil (übrige Tage)</td>
                    <td className="py-1 text-right font-mono">CHF {fmtCHF2(berechnung.flexPlanAnteil)}</td></tr>
                  <tr className="border-t font-semibold"><td className="py-1">Gesamttotal</td>
                    <td className="py-1 text-right font-mono">CHF {fmtCHF2(berechnung.kHr.total)}</td></tr>
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">
                Ohne Ferienabbau, Kranken-/Unfallkosten und Überstunden/Zusatzkosten (separate Info).
              </p>
            </div>

            {/* ── Debug-Tabelle Tag für Tag ────────────────────────────── */}
            <Collapsible open={debugOpen} onOpenChange={setDebugOpen}>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-semibold">
                <ChevronDown className={cn('h-4 w-4 transition-transform', !debugOpen && '-rotate-90')} />
                Debug: Flex-Kosten Tag für Tag
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 rounded-xl border bg-card shadow-sm overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b bg-muted/50 text-left">
                        <th className="p-2">Datum</th>
                        <th className="p-2">Quelle</th>
                        <th className="p-2 text-right">Plan-Std</th>
                        <th className="p-2 text-right">Ist-Std</th>
                        <th className="p-2 text-right">Plan CHF</th>
                        <th className="p-2 text-right">Ist CHF</th>
                        <th className="p-2 text-right">Effektiv CHF</th>
                        <th className="p-2 text-right">Kumuliert CHF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {berechnung.tage.map(t => {
                        kumuliert += t.effektivKosten;
                        const planStd = Object.values(t.proMa).reduce((s, z) => s + z.planStd, 0);
                        const istStd  = Object.values(t.proMa).reduce((s, z) => s + (z.istStd ?? 0), 0);
                        return (
                          <tr key={t.date} className={cn('border-b last:border-0', t.istTag && 'bg-emerald-50/50 dark:bg-emerald-950/20')}>
                            <td className="p-2 font-mono">{fmtDate(t.date)}</td>
                            <td className="p-2">
                              <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold',
                                t.istTag ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                         : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300')}>
                                {t.istTag ? 'IST' : 'PLAN'}
                              </span>
                            </td>
                            <td className="p-2 text-right font-mono">{planStd.toFixed(2)}</td>
                            <td className="p-2 text-right font-mono">{istStd > 0 ? istStd.toFixed(2) : '–'}</td>
                            <td className="p-2 text-right font-mono">{fmtCHF2(t.planKosten)}</td>
                            <td className="p-2 text-right font-mono">{t.istKosten > 0 ? fmtCHF2(t.istKosten) : '–'}</td>
                            <td className="p-2 text-right font-mono font-semibold">{fmtCHF2(t.effektivKosten)}</td>
                            <td className="p-2 text-right font-mono">{fmtCHF2(kumuliert)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Fix-MA Detail */}
                <div className="mt-3 rounded-xl border bg-card shadow-sm overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b bg-muted/50 text-left">
                        <th className="p-2">Fix-MA</th>
                        <th className="p-2 text-right">Total AG/Mt</th>
                        <th className="p-2 text-right">Bis Stichtag</th>
                        <th className="p-2">Hinweis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {berechnung.fix.zeilen.map(z => (
                        <tr key={z.empId} className="border-b last:border-0">
                          <td className="p-2">{z.name}</td>
                          <td className="p-2 text-right font-mono">{fmtCHF2(z.kostenMonat)}</td>
                          <td className="p-2 text-right font-mono">{fmtCHF2(z.kostenBisStichtag)}</td>
                          <td className="p-2 text-muted-foreground">{z.label ?? ''}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold">
                        <td className="p-2">Total</td>
                        <td className="p-2 text-right font-mono">{fmtCHF2(berechnung.fix.totalMonat)}</td>
                        <td className="p-2 text-right font-mono">{fmtCHF2(berechnung.fix.totalBisStichtag)}</td>
                        <td className="p-2" />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </div>
    </PageShell>
  );
}
