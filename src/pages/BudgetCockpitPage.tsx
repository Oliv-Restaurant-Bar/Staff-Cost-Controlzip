/**
 * Budget-Eingabe (Cockpit-KPI-Budget) — SEPARAT von budget_v1 (P&L)!
 *
 * Pro Jahr + Mandant: 12 Monatswerte je Cockpit-Position. Jahreswert →
 * pro rata verteilen: 'seasonal' (Vorjahres-Ist-Muster GENAU dieser Kennzahl,
 * Fallback Kalendertage mit Hinweis) oder 'even' (Kalendertage). Präzedenz:
 * expliziter Monat > Jahres-Verteilung; explizite Woche (ISO-KW-Override) >
 * Monats-Ableitung. Regeln: leer statt 0 · nie ÷ 0 · mandantengetrennt.
 *
 * Zusätzlich (Budget-Autofill-Spec):
 *  - CHF/%-Umschalter je Position: %-Eingabe = % vom Umsatz-Budget (TA auf
 *    Brutto, sonst Netto); Monats-CHF werden materialisiert, beide Richtungen
 *    umschaltbar (CHF→%: Σ Monate ÷ Σ Basis).
 *  - Auto-Befüllung «Run-Rate + 10 % besser»: laufendes Jahr aufs Jahr
 *    hochgerechnet (saisonales VJ-Muster); Leistungszahlen ×1.10, Quoten ×0.90.
 *    Nur ein VORSCHLAG — alles bleibt editierbar. Brutto/Netto werden beim
 *    Gesamt-Befüllen NIE überschrieben (Basis aller %-Rechnungen).
 *  - Ableitungen: Gäste IN = Restaurant-Netto-Budget ÷ Ø-Verkauf-Ziel;
 *    Produktive Stunden = Netto-Budget ÷ Ziel-Produktivität.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Target, RotateCcw, Save, ChevronDown, ChevronRight, Trash2, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { useToast } from '@/hooks/use-toast';
import {
  COCKPIT_BUDGET_KPIS, leereCockpitBudgetPosition,
  loadCockpitBudget, saveCockpitBudget, kalendertagGewichte, verteileJahreswert,
  ladeSaisonGewichte, runRateJahr, runRateQuote, AUTOFILL_FAKTOR,
  pctBasisId, pctAufMonate, type CockpitBudgetKpiDef, type TenantId,
} from '@/lib/cockpit-budget';
import { mwstDivisorTakeaway } from '@/lib/mwst';
import type { CockpitBudgetPosition, CockpitBudgetYear, CockpitProrataMode } from '@/types/budget';

const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const r2 = (n: number) => Math.round(n * 100) / 100;

const EINHEIT: Record<string, string> = { chf: 'CHF', count: 'Anzahl', hours: 'Std', pct: '%' };

/** Positionen mit CHF/%-Umschalter (% vom Umsatz-Budget). Brutto/Netto sind
 *  die BASIS der %-Rechnung und bleiben reine CHF-Eingaben. BEWUSST nur die
 *  CHF-Kostenzeilen: für Anzahl- (Gäste), Stunden- und Quoten-Zeilen ist
 *  «% vom Netto» semantisch sinnlos — die Spec sieht dort Direkteingabe bzw.
 *  eigene Ableitungen vor (Gäste via Ø-Verkauf-Ziel, Stunden via Ziel-Produktivität). */
const PCT_TOGGLE_IDS = new Set(['wareneinsatz', 'take_away_umsatz', 'personalkosten']);

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
  /** Laufende Auto-Aktion (Positions-ID oder '*' für «alle»). */
  const [busy, setBusy] = useState<string | null>(null);
  /** %-Eingabefelder je Position (nur Anzeige-State; massgeblich sind Monate). */
  const [pctInput, setPctInput] = useState<Record<string, string>>({});
  /** Ø-Verkauf-Steigerung: '+X %' oder '+X CHF' auf die Run-Rate (Default +10 %). */
  const [steigArt, setSteigArt] = useState<'pct' | 'chf'>('pct');
  const [steigWert, setSteigWert] = useState('10');
  /** Ziel-Produktivität (Umsatz/Std) für die Stunden-Ableitung. */
  const [zielProd, setZielProd] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true); setDirty(false);
    loadCockpitBudget(tenantKey, year)
      .then(b => {
        if (!alive) return;
        const eff: CockpitBudgetYear = b ?? { year, positions: {}, updatedAt: '' };
        setBlob(eff);
        setSnapshot(JSON.parse(JSON.stringify(eff)));
        setPctInput(Object.fromEntries(Object.entries(eff.positions)
          .filter(([, p]) => p.inputMode === 'pct' && p.pctValue != null)
          .map(([id, p]) => [id, String(p.pctValue)])));
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

  const getPosById = useCallback((id: string): CockpitBudgetPosition | undefined =>
    blob?.positions[id], [blob]);

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

  // ── CHF/%-Umschalter ───────────────────────────────────────────────────────

  /** %-Satz auf die Basis-Monatsbudgets anwenden (Monate materialisieren). */
  const pctAnwenden = useCallback((def: CockpitBudgetKpiDef, pct: number) => {
    const basisId = pctBasisId(def.id);
    const basis = getPosById(basisId);
    if (!basis || !basis.monthlyValues.some(v => v !== null)) {
      toast({
        title: 'Kein Umsatz-Budget',
        description: `Bitte zuerst «${basisId === 'brutto_umsatz' ? 'Brutto' : 'Netto'} Umsatz» budgetieren — die %-Eingabe rechnet darauf.`,
      });
      return false;
    }
    const pos = getPos(def);
    setPos(def.id, {
      ...pos, inputMode: 'pct', pctValue: pct,
      monthlyValues: pctAufMonate(pct, basis),
      monthlyExplicit: Array(12).fill(false),
      yearValue: null,
    });
    return true;
  }, [getPos, getPosById, setPos, toast]);

  /** Modus umschalten: CHF→% rechnet den konsistenten %-Satz aus den Monaten. */
  const modusWechseln = useCallback((def: CockpitBudgetKpiDef, modus: 'chf' | 'pct') => {
    const pos = getPos(def);
    if (modus === (pos.inputMode ?? 'chf')) return;
    if (modus === 'chf') {
      setPos(def.id, { ...pos, inputMode: 'chf' }); // Monats-CHF bleiben stehen
      return;
    }
    const basis = getPosById(pctBasisId(def.id));
    let pct: number | null = pos.pctValue ?? null;
    if (basis) {
      let sumV = 0, sumB = 0;
      pos.monthlyValues.forEach((v, i) => {
        const b = basis.monthlyValues[i];
        if (v !== null && typeof b === 'number' && b > 0) { sumV += v; sumB += b; }
      });
      if (sumB > 0) pct = r2((sumV / sumB) * 100);
    }
    setPos(def.id, { ...pos, inputMode: 'pct', pctValue: pct });
    if (pct !== null) setPctInput(s => ({ ...s, [def.id]: String(pct) }));
  }, [getPos, getPosById, setPos]);

  // ── Auto-Befüllung «Run-Rate + 10 % besser» ───────────────────────────────

  /** Basisjahr der Run-Rate = laufendes Jahr (bzw. Budget-Jahr, falls älter). */
  const basisJahr = Math.min(year, curYear);

  /** Konstanten %-/Quotenwert in alle 12 Monate schreiben (nicht «fix»). */
  const monateKonstant = useCallback((def: CockpitBudgetKpiDef, wert: number) => {
    const pos = getPos(def);
    setPos(def.id, {
      ...pos, monthlyValues: Array(12).fill(r2(wert)),
      monthlyExplicit: Array(12).fill(false),
    });
  }, [getPos, setPos]);

  /**
   * Eine Position aus der Run-Rate befüllen. Liefert eine Meldung (oder null
   * bei Erfolg ohne Besonderheit); wirft nie.
   */
  const autofillPosition = useCallback(async (def: CockpitBudgetKpiDef): Promise<string | null> => {
    const faktor = AUTOFILL_FAKTOR[def.id];
    if (faktor === undefined || def.id === 'prod_stunden') return `«${def.label}» hat keinen direkten Autofill.`;
    const tid = tenantId as TenantId;

    // Quoten-Zeilen: konstante Quote (Run-Rate × Faktor) in alle Monate.
    if (def.id === 'personalquote' || def.id === 'take_away_anteil' || def.id === 'produktivitaet') {
      const q = await runRateQuote(tid, tenantKey, basisJahr, def.id, rates).catch(() => null);
      if (q === null) return `Keine ${basisJahr}-Ist-Daten für «${def.label}».`;
      monateKonstant(def, q * faktor);
      return null;
    }

    // Ø-Verkauf pro Gast: Run-Rate + wählbare Steigerung (+X % oder +X CHF).
    if (def.id === 'avg_verkauf_gast') {
      const q = await runRateQuote(tid, tenantKey, basisJahr, def.id, rates).catch(() => null);
      if (q === null) return `Keine ${basisJahr}-Ist-Daten für «${def.label}».`;
      const x = Number(steigWert);
      const ziel = !isFinite(x) ? q * 1.10
        : steigArt === 'pct' ? q * (1 + x / 100) : q + x;
      monateKonstant(def, ziel);
      return `Ø-Verkauf: Run-Rate ${r2(q).toFixed(2)} → Ziel ${r2(ziel).toFixed(2)} CHF/Gast.`;
    }

    // Personalkosten/Wareneinsatz: als Quote ×0.9 auf das Netto-Budget.
    if (def.id === 'personalkosten' || def.id === 'wareneinsatz') {
      const quoteId = def.id === 'personalkosten' ? 'personalquote' : 'wareneinsatz_quote';
      const q = await runRateQuote(tid, tenantKey, basisJahr, quoteId, rates).catch(() => null);
      if (q === null) return `Keine ${basisJahr}-Ist-Quote für «${def.label}».`;
      const pct = r2(q * faktor);
      if (!pctAnwenden(def, pct)) return `«${def.label}»: Netto-Umsatz-Budget fehlt (Basis der %-Rechnung).`;
      setPctInput(s => ({ ...s, [def.id]: String(pct) }));
      return `${def.label}: Ist-Quote ${r2(q)} % → Budget-Quote ${pct} % vom Netto-Budget.`;
    }

    // Basis-Kennzahlen (Umsätze, Gäste): Jahres-Run-Rate × Faktor, saisonal verteilt.
    const rr = await runRateJahr(tid, tenantKey, basisJahr, def.id, rates).catch(() => null);
    if (!rr) return `Keine ${basisJahr}-Ist-Daten für «${def.label}».`;
    const jahreswert = r2(rr.value * faktor);
    let weights = kalendertagGewichte(year);
    const w = await ladeSaisonGewichte(tid, tenantKey, year - 1, def.id, rates).catch(() => null);
    if (w) weights = w;
    const pos = getPos(def);
    setPos(def.id, {
      ...pos, yearValue: jahreswert, inputMode: 'chf', pctValue: null,
      monthlyValues: verteileJahreswert(jahreswert, weights, Array(12).fill(null), Array(12).fill(false)),
      monthlyExplicit: Array(12).fill(false),
    });
    return null;
  }, [tenantId, tenantKey, basisJahr, year, rates, steigArt, steigWert,
      monateKonstant, pctAnwenden, getPos, setPos]);

  const autofillEine = useCallback(async (def: CockpitBudgetKpiDef) => {
    setBusy(def.id);
    try {
      const msg = await autofillPosition(def);
      if (msg) toast({ title: 'Autofill', description: msg });
      else toast({ title: 'Vorschlag eingefüllt', description: `«${def.label}» aus ${basisJahr}-Run-Rate — editierbar.` });
    } finally { setBusy(null); }
  }, [autofillPosition, basisJahr, toast]);

  /** Gesamt-Befüllung: NUR leere Positionen; Brutto/Netto NIE anfassen. */
  const autofillAlle = useCallback(async () => {
    setBusy('*');
    try {
      const meldungen: string[] = [];
      for (const def of COCKPIT_BUDGET_KPIS) {
        if (def.id === 'brutto_umsatz' || def.id === 'netto_umsatz' || def.id === 'prod_stunden') continue;
        const pos = getPos(def);
        if (pos.yearValue !== null || pos.monthlyValues.some(v => v !== null)) continue; // nichts überschreiben
        const msg = await autofillPosition(def);
        if (msg) meldungen.push(msg);
      }
      toast({
        title: 'Autofill abgeschlossen',
        description: meldungen.length
          ? meldungen.slice(0, 3).join(' ')
          : 'Alle leeren Positionen aus der Run-Rate befüllt (Brutto/Netto unangetastet).',
      });
    } finally { setBusy(null); }
  }, [autofillPosition, getPos, toast]);

  // ── Ableitungen (Gäste aus Ø-Verkauf-Ziel · Stunden aus Ziel-Produktivität) ─

  /** Restaurant-Netto-Budget je Monat: Netto − TA-Netto (Oliv; Beaulieu ohne TA). */
  const restaurantNettoMonat = useCallback((i: number): number | null => {
    const netto = getPosById('netto_umsatz')?.monthlyValues[i];
    if (typeof netto !== 'number') return null;
    if (tenantId !== 'oliv') return netto;
    const ta = getPosById('take_away_umsatz')?.monthlyValues[i];
    return netto - (typeof ta === 'number' ? ta / mwstDivisorTakeaway() : 0);
  }, [getPosById, tenantId]);

  const gaesteAbleiten = useCallback(() => {
    const avg = getPosById('avg_verkauf_gast');
    if (!avg || !avg.monthlyValues.some(v => v !== null && v > 0)) {
      toast({ title: 'Ø-Verkauf-Ziel fehlt', description: 'Bitte zuerst «Ø-Verkauf pro Gast» budgetieren (z.B. per Autofill) — das Ziel treibt das Gäste-Budget.' });
      return;
    }
    const def = COCKPIT_BUDGET_KPIS.find(d => d.id === 'gaeste_in')!;
    const pos = getPos(def);
    const mv = Array.from({ length: 12 }, (_, i) => {
      const rn = restaurantNettoMonat(i);
      const z = avg.monthlyValues[i];
      return rn !== null && typeof z === 'number' && z > 0 ? Math.round(rn / z) : null;
    });
    if (!mv.some(v => v !== null)) {
      toast({ title: 'Netto-Budget fehlt', description: 'Gäste-Ableitung braucht das Netto-Umsatz-Budget der Monate.' });
      return;
    }
    setPos('gaeste_in', {
      ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
      yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
    });
    toast({ title: 'Gäste-Budget abgeleitet', description: 'Restaurant-Netto-Budget ÷ Ø-Verkauf-Ziel, je Monat (editierbar).' });
  }, [getPos, getPosById, restaurantNettoMonat, setPos, toast]);

  /** Vorschlag Ziel-Produktivität: Mittel der budgetierten Produktivitäts-Monate. */
  const zielProdVorschlag = useMemo(() => {
    const p = getPosById('produktivitaet');
    const vals = (p?.monthlyValues ?? []).filter((v): v is number => typeof v === 'number' && v > 0);
    return vals.length ? r2(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }, [getPosById]);

  const stundenAbleiten = useCallback(() => {
    const ziel = zielProd !== '' ? Number(zielProd) : zielProdVorschlag;
    if (!ziel || !isFinite(ziel) || ziel <= 0) {
      toast({ title: 'Ziel-Produktivität fehlt', description: 'Bitte Umsatz/Std erfassen (oder zuerst «Produktivität» budgetieren).' });
      return;
    }
    const netto = getPosById('netto_umsatz');
    if (!netto || !netto.monthlyValues.some(v => v !== null)) {
      toast({ title: 'Netto-Budget fehlt', description: 'Stunden-Ableitung braucht das Netto-Umsatz-Budget der Monate.' });
      return;
    }
    const def = COCKPIT_BUDGET_KPIS.find(d => d.id === 'prod_stunden')!;
    const pos = getPos(def);
    const mv = netto.monthlyValues.map(v => (typeof v === 'number' ? r2(v / ziel) : null));
    setPos('prod_stunden', {
      ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
      yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
    });
    toast({ title: 'Planstunden abgeleitet', description: `Netto-Budget ÷ ${ziel} CHF/Std, je Monat (editierbar).` });
  }, [zielProd, zielProdVorschlag, getPos, getPosById, setPos, toast]);

  // ── Speichern / Rückgängig ────────────────────────────────────────────────

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
          <Button variant="outline" size="sm" className="h-8 gap-1.5"
            disabled={busy !== null || loading}
            onClick={autofillAlle} data-testid="button-autofill-alle">
            <Wand2 className="h-4 w-4" />
            {busy === '*' ? 'Befüllt …' : `Alle befüllen (${basisJahr}-Run-Rate, ±10 %)`}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            nur leere Positionen · Brutto/Netto nie
          </span>
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
          const imPctModus = PCT_TOGGLE_IDS.has(def.id) && (pos.inputMode ?? 'chf') === 'pct';
          const hatAutofill = AUTOFILL_FAKTOR[def.id] !== undefined
            && def.id !== 'brutto_umsatz' && def.id !== 'netto_umsatz';
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
                {imPctModus && pos.pctValue != null && (
                  <span className="text-[10px] text-muted-foreground">· {pos.pctValue} % vom Umsatz-Budget</span>
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

                  {/* Werkzeuge: Autofill · CHF/%-Umschalter · Ableitungen */}
                  <div className="flex flex-wrap items-center gap-2">
                    {hatAutofill && (
                      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs"
                        disabled={busy !== null}
                        onClick={() => autofillEine(def)} data-testid={`button-autofill-${def.id}`}>
                        <Wand2 className="h-3.5 w-3.5" />
                        {busy === def.id ? 'Befüllt …'
                          : `Autofill (${basisJahr}-Run-Rate ${AUTOFILL_FAKTOR[def.id] >= 1
                              ? `+${Math.round((AUTOFILL_FAKTOR[def.id] - 1) * 100)}`
                              : `−${Math.round((1 - AUTOFILL_FAKTOR[def.id]) * 100)}`} %)`}
                      </Button>
                    )}
                    {def.id === 'avg_verkauf_gast' && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Steigerung:</span>
                        <Input type="number" className="h-7 w-16 text-right text-xs" value={steigWert}
                          onChange={e => setSteigWert(e.target.value)} data-testid="input-steigerung-wert" />
                        <Select value={steigArt} onValueChange={v => setSteigArt(v as 'pct' | 'chf')}>
                          <SelectTrigger className="h-7 w-[90px] text-xs" data-testid="select-steigerung-art">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pct">+ %</SelectItem>
                            <SelectItem value="chf">+ CHF</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {PCT_TOGGLE_IDS.has(def.id) && (
                      <div className="flex items-center gap-1.5">
                        <div className="flex overflow-hidden rounded-md border">
                          {(['chf', 'pct'] as const).map(m => (
                            <button key={m} type="button"
                              className={cn('px-2 py-1 text-[11px]',
                                (pos.inputMode ?? 'chf') === m ? 'bg-primary text-primary-foreground' : 'bg-background')}
                              onClick={() => modusWechseln(def, m)}
                              data-testid={`button-modus-${m}-${def.id}`}>
                              {m === 'chf' ? 'CHF' : '%'}
                            </button>
                          ))}
                        </div>
                        {imPctModus && (
                          <>
                            <Input type="number" inputMode="decimal" placeholder="%"
                              className="h-7 w-20 text-right text-xs"
                              value={pctInput[def.id] ?? ''}
                              onChange={e => setPctInput(s => ({ ...s, [def.id]: e.target.value }))}
                              data-testid={`input-pct-${def.id}`} />
                            <Button variant="outline" size="sm" className="h-7 text-xs"
                              onClick={() => {
                                const p = Number(pctInput[def.id]);
                                if (isFinite(p)) pctAnwenden(def, r2(p));
                              }}
                              data-testid={`button-pct-anwenden-${def.id}`}>
                              % anwenden
                            </Button>
                            <span className="text-[10px] text-muted-foreground">
                              % vom {pctBasisId(def.id) === 'brutto_umsatz' ? 'Brutto' : 'Netto'}-Umsatz-Budget je Monat
                            </span>
                          </>
                        )}
                      </div>
                    )}
                    {def.id === 'gaeste_in' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs"
                        onClick={gaesteAbleiten} data-testid="button-gaeste-ableiten">
                        Aus Ø-Verkauf-Ziel ableiten
                      </Button>
                    )}
                    {def.id === 'prod_stunden' && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Ziel-Produktivität (Umsatz/Std):</span>
                        <Input type="number" inputMode="decimal" className="h-7 w-24 text-right text-xs"
                          value={zielProd} onChange={e => setZielProd(e.target.value)}
                          placeholder={zielProdVorschlag != null ? String(zielProdVorschlag) : 'z.B. 95'}
                          data-testid="input-ziel-produktivitaet" />
                        <Button variant="outline" size="sm" className="h-7 text-xs"
                          onClick={stundenAbleiten} data-testid="button-stunden-ableiten">
                          Planstunden ableiten
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Jahreswert + Verteilung (für %-Positionen wenig sinnvoll → nur Monatseingabe) */}
                  {def.unit !== 'pct' && !imPctModus && (
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

                  {/* 12 Monats-Eingaben; Tippen ⇒ expliziter Monat (fett markiert).
                      Im %-Modus sind die Monate materialisierte CHF — Editieren
                      schaltet die Position zurück auf CHF-Direkteingabe. */}
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
                            setPos(def.id, {
                              ...pos, monthlyValues: mv, monthlyExplicit: me,
                              inputMode: 'chf', // manuelle Monats-Eingabe verlässt den %-Modus
                            });
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
          Cockpit kappt Monats-/Jahresbudgets pro rata bis zum Stichtag ·
          %-Eingaben rechnen auf dem Umsatz-Budget je Monat (TA: Brutto, sonst
          Netto) · Autofill = Vorschlag aus der {basisJahr}-Run-Rate (saisonales
          Vorjahresmuster), immer editierbar · leere Felder = kein Budget (nie 0)
          · Mandanten getrennt (aktuell:
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
