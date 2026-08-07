/**
 * Budget-Eingabe (Cockpit-KPI-Budget) — SEPARAT von budget_v1 (P&L)!
 *
 * Pro Jahr + Mandant: 12 Monatswerte je Cockpit-Position. Jahreswert →
 * pro rata verteilen: 'seasonal' (Vorjahres-Ist-Muster GENAU dieser Kennzahl,
 * Fallback Kalendertage mit Hinweis) oder 'even' (Kalendertage). Präzedenz:
 * expliziter Monat > Jahres-Verteilung; explizite Woche (ISO-KW-Override) >
 * Monats-Ableitung. Regeln: leer statt 0 · nie ÷ 0 · mandantengetrennt.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Target, RotateCcw, Save, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { useToast } from '@/hooks/use-toast';
import {
  COCKPIT_BUDGET_KPIS, cockpitBudgetKvKey, leereCockpitBudgetPosition,
  loadCockpitBudget, saveCockpitBudget, kalendertagGewichte, verteileJahreswert,
  ladeSaisonGewichte, type CockpitBudgetKpiDef, type TenantId,
} from '@/lib/cockpit-budget';
import type { CockpitBudgetPosition, CockpitBudgetYear, CockpitProrataMode } from '@/types/budget';

const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const r2 = (n: number) => Math.round(n * 100) / 100;

const EINHEIT: Record<string, string> = { chf: 'CHF', count: 'Anzahl', hours: 'Std', pct: '%' };

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Anzeige-Format (Tausendertrennung) für Zusammenfassungen. */
function fmtSum(v: number, unit: string): string {
  const s = v.toLocaleString('de-CH', { maximumFractionDigits: 2 });
  return `${s}${unit === 'pct' ? ' %' : ''}`;
}

export default function BudgetCockpitPage() {
  const { tenantId, tenantKey } = useTenant();
  const { rates } = useSocialCostRates();
  const { toast } = useToast();
  const curYear = new Date().getFullYear();
  const [year, setYear] = useState(curYear);
  const jahre = useMemo(
    () => Array.from({ length: 5 }, (_, i) => curYear - 2 + i),
    [curYear],
  );

  const [blob, setBlob] = useState<CockpitBudgetYear | null>(null);
  // Rückgängig: Snapshot des zuletzt GELADENEN/GESPEICHERTEN Standes.
  const [snapshot, setSnapshot] = useState<CockpitBudgetYear | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true); setDirty(false);
    loadCockpitBudget(tenantKey, year)
      .then(b => {
        if (!alive) return;
        const eff: CockpitBudgetYear = b ?? { year, positions: {}, updatedAt: '' };
        setBlob(eff);
        setSnapshot(JSON.parse(JSON.stringify(eff)));
      })
      .catch(e => {
        if (!alive) return;
        toast({ title: 'Laden fehlgeschlagen', description: String(e?.message ?? e), variant: 'destructive' });
        setBlob(null); setSnapshot(null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantKey, year, toast]);

  const getPos = useCallback((def: CockpitBudgetKpiDef): CockpitBudgetPosition =>
    blob?.positions[def.id] ?? leereCockpitBudgetPosition(def.id, def.unit),
    [blob]);

  const setPos = useCallback((id: string, next: CockpitBudgetPosition) => {
    setBlob(b => b ? { ...b, positions: { ...b.positions, [id]: next } } : b);
    setDirty(true);
  }, []);

  /** Jahreswert nach Modus verteilen (nur nicht-explizite Monate). */
  const verteilen = useCallback(async (def: CockpitBudgetKpiDef) => {
    const pos = getPos(def);
    if (pos.yearValue === null || !(pos.yearValue > 0)) {
      toast({ title: 'Kein Jahreswert', description: 'Bitte zuerst einen Jahreswert > 0 erfassen.' });
      return;
    }
    let weights = kalendertagGewichte(year);
    let hinweis: string | null = null;
    if (pos.prorataMode === 'seasonal') {
      const w = await ladeSaisonGewichte(tenantId as TenantId, tenantKey, year - 1, def.id, rates)
        .catch(() => null);
      if (w) weights = w;
      else hinweis = `Keine Vorjahres-Ist-Daten (${year - 1}) für «${def.label}» — nach Kalendertagen verteilt.`;
    }
    const mv = verteileJahreswert(pos.yearValue, weights, pos.monthlyValues, pos.monthlyExplicit);
    setPos(def.id, { ...pos, monthlyValues: mv });
    if (hinweis) toast({ title: 'Saisonal nicht möglich', description: hinweis });
  }, [getPos, setPos, tenantId, tenantKey, year, rates, toast]);

  const speichern = useCallback(async () => {
    if (!blob) return;
    setSaving(true);
    try {
      // Leere Positionen nicht mitspeichern (Blob klein halten).
      const positions = Object.fromEntries(Object.entries(blob.positions).filter(([, p]) =>
        p.yearValue !== null || p.monthlyValues.some(v => v !== null) || Object.keys(p.weekOverrides).length > 0));
      const next: CockpitBudgetYear = { ...blob, year, positions };
      await saveCockpitBudget(tenantKey, next);
      setBlob(next);
      setSnapshot(JSON.parse(JSON.stringify(next)));
      setDirty(false);
      toast({ title: 'Budget gespeichert', description: `Cockpit-Budget ${year} (${tenantId === 'oliv' ? 'Oliv' : 'Beaulieu'}).` });
    } catch (e) {
      toast({ title: 'Speichern fehlgeschlagen', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [blob, tenantKey, year, tenantId, toast]);

  const rueckgaengig = useCallback(() => {
    if (!snapshot) return;
    setBlob(JSON.parse(JSON.stringify(snapshot)));
    setDirty(false);
    toast({ title: 'Änderungen verworfen', description: 'Zurück auf den zuletzt gespeicherten Stand.' });
  }, [snapshot, toast]);

  return (
    <PageShell>
      <div className="space-y-4 max-w-5xl">
        <div className="flex items-center gap-3">
          <Target className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Budget-Eingabe (Cockpit)</h1>
            <p className="text-xs text-muted-foreground">
              Kennzahlen-Budgets fürs Cockpit — Jahr → Monate pro rata (saisonal
              nach Vorjahres-Ist oder gleichmässig nach Kalendertagen), Monate
              einzeln übersteuerbar, Wochen-Overrides je ISO-KW. Getrennt vom
              P&amp;L-Budget (ER).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="h-8 w-[110px] text-xs" data-testid="select-budget-jahr">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {jahre.map(j => <SelectItem key={j} value={String(j)}>{j}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={!dirty || saving}
            onClick={rueckgaengig} data-testid="button-budget-undo">
            <RotateCcw className="h-4 w-4" /> Rückgängig
          </Button>
          <Button size="sm" className="h-8 gap-1.5" disabled={!dirty || saving || !blob}
            onClick={speichern} data-testid="button-budget-save">
            <Save className="h-4 w-4" /> {saving ? 'Speichert …' : 'Speichern'}
          </Button>
        </div>

        {loading && <p className="text-sm text-muted-foreground py-8">Lade Budget …</p>}

        {!loading && blob && COCKPIT_BUDGET_KPIS.map(def => {
          const pos = getPos(def);
          const istOffen = open[def.id] ?? false;
          const summe = pos.monthlyValues.reduce<number>((s, v) => s + (v ?? 0), 0);
          const hatWerte = pos.monthlyValues.some(v => v !== null);
          return (
            <div key={def.id} className="rounded-xl border bg-card shadow-sm" data-testid={`budget-pos-${def.id}`}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
                onClick={() => setOpen(o => ({ ...o, [def.id]: !istOffen }))}
                data-testid={`budget-pos-toggle-${def.id}`}
              >
                {istOffen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className={cn('text-sm font-semibold', def.kind === 'ratio' && 'text-muted-foreground')}>
                  {def.label}
                </span>
                <span className="text-[10px] uppercase text-muted-foreground">{EINHEIT[def.unit]}</span>
                {def.kind === 'ratio' && (
                  <span className="text-[10px] text-muted-foreground">· abgeleitet, überschreibbar</span>
                )}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {hatWerte
                    ? (def.unit === 'pct' ? 'Monatswerte erfasst' : `Σ ${fmtSum(r2(summe), def.unit)}`)
                    : 'kein Budget'}
                </span>
              </button>

              {istOffen && (
                <div className="space-y-3 border-t px-4 py-3">
                  {def.hint && <p className="text-xs text-muted-foreground">Ableitung ohne Override: {def.hint}</p>}

                  {/* Jahreswert + Verteilung (für %-Positionen wenig sinnvoll → nur Monatseingabe) */}
                  {def.unit !== 'pct' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs font-medium">Jahreswert</label>
                      <Input
                        type="number" inputMode="decimal" className="h-8 w-36 text-right text-xs"
                        value={fmtNum(pos.yearValue)}
                        onChange={e => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          setPos(def.id, { ...pos, yearValue: v !== null && isFinite(v) ? v : null });
                        }}
                        placeholder="z.B. 120000"
                        data-testid={`input-jahreswert-${def.id}`}
                      />
                      <Select
                        value={pos.prorataMode}
                        onValueChange={v => setPos(def.id, { ...pos, prorataMode: v as CockpitProrataMode })}
                      >
                        <SelectTrigger className="h-8 w-[240px] text-xs" data-testid={`select-prorata-${def.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="seasonal">Saisonal (Vorjahres-Ist dieser Kennzahl)</SelectItem>
                          <SelectItem value="even">Gleichmässig (Kalendertage)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" className="h-8"
                        onClick={() => verteilen(def)} data-testid={`button-verteilen-${def.id}`}>
                        Auf Monate verteilen
                      </Button>
                      <span className="text-[10px] text-muted-foreground">
                        Manuell erfasste Monate bleiben stehen (Rest wird verteilt).
                      </span>
                    </div>
                  )}

                  {/* 12 Monats-Eingaben; Tippen ⇒ expliziter Monat (fett markiert) */}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                    {MONATE_KURZ.map((m, i) => (
                      <div key={m} className="space-y-0.5">
                        <label className={cn('block text-[10px]',
                          pos.monthlyExplicit[i] ? 'font-bold' : 'text-muted-foreground')}>
                          {m}{pos.monthlyExplicit[i] ? ' ·fix' : ''}
                        </label>
                        <Input
                          type="number" inputMode="decimal" className="h-8 text-right text-xs"
                          value={fmtNum(pos.monthlyValues[i])}
                          onChange={e => {
                            const raw = e.target.value;
                            const v = raw === '' ? null : Number(raw);
                            const mv = pos.monthlyValues.slice();
                            const me = pos.monthlyExplicit.slice();
                            mv[i] = v !== null && isFinite(v) ? v : null;
                            me[i] = mv[i] !== null; // löschen ⇒ wieder frei für Verteilung
                            setPos(def.id, { ...pos, monthlyValues: mv, monthlyExplicit: me });
                          }}
                          data-testid={`input-monat-${def.id}-${i + 1}`}
                        />
                      </div>
                    ))}
                  </div>

                  {/* Wochen-Overrides (ISO-KW). Für %-Positionen gilt der Wert ungekürzt. */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">Wochen-Overrides (ISO-KW, Vorrang vor Monatsableitung)</p>
                    {Object.entries(pos.weekOverrides).sort(([a], [b]) => a.localeCompare(b)).map(([wk, v]) => (
                      <div key={wk} className="flex items-center gap-2 text-xs">
                        <span className="w-24 tabular-nums">{wk}</span>
                        <span className="tabular-nums">{fmtSum(v, def.unit)}</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6"
                          onClick={() => {
                            const wo = { ...pos.weekOverrides };
                            delete wo[wk];
                            setPos(def.id, { ...pos, weekOverrides: wo });
                          }}
                          data-testid={`button-del-week-${def.id}-${wk}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <WeekOverrideForm
                      year={year}
                      unit={def.unit}
                      onAdd={(wk, v) =>
                        setPos(def.id, { ...pos, weekOverrides: { ...pos.weekOverrides, [wk]: v } })}
                      testid={def.id}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <p className="text-xs text-muted-foreground">
          Präzedenz: expliziter Monat &gt; Jahres-Verteilung · explizite Woche &gt;
          Monats-Ableitung · Woche ohne Override = Σ Tagesanteile (Monatswert ÷
          Kalendertage, über Monatsgrenzen) · Wochen-Override wird bei auf den
          Monat geklemmten Wochen anteilig (Tage ÷ 7) gerechnet, %-Werte ungekürzt ·
          Cockpit kappt Monats-/Jahresbudgets pro rata bis zum Stichtag · leere
          Felder = kein Budget (nie 0) · Mandanten getrennt (aktuell:
          {tenantId === 'oliv' ? ' Oliv' : ' Beaulieu'}).
        </p>
      </div>
    </PageShell>
  );
}

/** Kleine Eingabezeile «KW + Wert hinzufügen» für Wochen-Overrides. */
function WeekOverrideForm({ year, unit, onAdd, testid }: {
  year: number; unit: string;
  onAdd: (weekKey: string, value: number) => void;
  testid: string;
}) {
  const [kw, setKw] = useState('');
  const [wert, setWert] = useState('');
  const add = () => {
    const n = Number(kw), v = Number(wert);
    if (!Number.isInteger(n) || n < 1 || n > 53 || !isFinite(v)) return;
    // ISO-Wochenjahr = gewähltes Budget-Jahr (Grenzwochen: KW des Jahres wählen).
    onAdd(`${year}-W${String(n).padStart(2, '0')}`, v);
    setKw(''); setWert('');
  };
  return (
    <div className="flex items-center gap-2">
      <Input type="number" placeholder="KW" className="h-7 w-16 text-xs" value={kw}
        onChange={e => setKw(e.target.value)} data-testid={`input-week-kw-${testid}`} />
      <Input type="number" placeholder={`Wert (${unit === 'pct' ? '%' : 'Woche'})`} className="h-7 w-32 text-xs"
        value={wert} onChange={e => setWert(e.target.value)} data-testid={`input-week-val-${testid}`} />
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={add}
        data-testid={`button-add-week-${testid}`}>
        Hinzufügen
      </Button>
    </div>
  );
}
