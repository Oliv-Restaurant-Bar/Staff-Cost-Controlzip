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
 *  - Die UMSATZ-Positionen (Brutto/Netto) wurden ENTFERNT: das Umsatz-Budget
 *    kommt aus dem ER-/P&L-Budget (budget_v1) und wird dort erfasst.
 *  - CHF/%-Umschalter je Position: %-Eingabe = % vom ER-NETTO-Umsatz-Budget
 *    des Monats; Monats-CHF werden materialisiert, beide Richtungen
 *    umschaltbar (CHF→%: Σ Monate ÷ Σ Basis).
 *  - Auto-Befüllung «Ist-Werte übernehmen» (Startpunkt «Stand der Dinge»):
 *    abgeschlossene Monate = ECHTER Ist-Monatswert, unvollständige/zukünftige
 *    Monate = Durchschnitt der abgeschlossenen. Gilt für JEDE Position.
 *    KEIN automatisches ±10 % — Steigerung nur per separatem Button
 *    (+X % / +X CHF, manuell).
 *  - Ableitungen: Gäste IN = (ER-Netto − TA-Budget) ÷ Ø-Verkauf-Ziel;
 *    Produktive Stunden = ER-Netto-Budget ÷ Ziel-Produktivität.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Target, RotateCcw, Save, ChevronDown, ChevronRight, Trash2, Wand2, Upload } from 'lucide-react';
import { loadWeqKalk, saveWeqKalk, parseWeqExport } from '@/lib/weq-kalkuliert';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { useToast } from '@/hooks/use-toast';
import {
  COCKPIT_BUDGET_KPIS, leereCockpitBudgetPosition,
  loadCockpitBudget, saveCockpitBudget, kalendertagGewichte, verteileJahreswert,
  ladeSaisonGewichte, istMonatswerteAlle, abgeschlosseneMonate,
  kalkulierteWeqMonate, bedarfSollStundenMonate,
  erNettoBudgetMonate, type CockpitBudgetKpiDef, type TenantId,
} from '@/lib/cockpit-budget';
import type { CockpitBudgetPosition, CockpitBudgetYear, CockpitProrataMode } from '@/types/budget';

const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const r2 = (n: number) => Math.round(n * 100) / 100;

const EINHEIT: Record<string, string> = { chf: 'CHF', count: 'Anzahl', hours: 'Std', pct: '%' };

/** Positionen mit Ist-Autofill (Ziel-Quoten, die aus dem Ist geseedet werden).
 *  Alle übrigen Zeilen sind ZIEL-/ABLEITUNGS-Zeilen (Spec 08/2026):
 *  Wareneinsatz = kalkulierte WEQ (Gastronovi) bzw. Ziel-% × ER-Netto ·
 *  TA-CHF = TA-Anteil-% × ER-Netto (read-only) · Gäste = Restaurant-Netto ÷
 *  Ø-Verkauf-Ziel · Prod. Stunden = Personalbedarf-Soll · Personalkosten &
 *  Personalquote = EINE Zielquote (Default 40 %). */
const AUTOFILL_IDS = new Set(['take_away_anteil', 'avg_verkauf_gast', 'produktivitaet']);
/** TA-CHF wird aus dem Anteil abgeleitet — keine eigene Erfassung mehr. */
const READONLY_IDS = new Set(['take_away_umsatz']);

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


  useEffect(() => {
    let alive = true;
    setLoading(true); setDirty(false);
    loadCockpitBudget(tenantKey, year)
      .then(b => {
        if (!alive) return;
        // taNetto: neuer Blob ist per Definition netto — Marker sofort setzen,
        // sonst würde der nächste Load die frischen Netto-Werte nochmals teilen.
        const eff: CockpitBudgetYear = b ?? { year, positions: {}, updatedAt: '', taNetto: true };
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

  /** ER-Netto-Umsatz-Budget je Monat (budget_v1 — Basis aller %-Rechnungen
   *  und Ableitungen; die Umsatz-Positionen wurden hier entfernt). */
  const erNetto = useMemo(
    () => erNettoBudgetMonate(year, tenantKey('budget_v1')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, tenantKey, loading],
  );

  // Kontext-Wache für async Aktionen: Mandant/Jahr-Wechsel invalidiert
  // laufende Resets (nie einen alten Kontext zurückschreiben).
  const ctxRef = useRef('');
  ctxRef.current = tenantKey(String(year));

  /**
   * Einzelmonat «Zurück auf abgeleitet»: hebt den manuellen Override auf.
   * %-Positionen (unit 'pct') → null (Resolver leitet wieder ab) ·
   * CHF-Positionen im %-Modus → Quote × ER-Netto (Wareneinsatz: hinterlegte
   * Netto-WEQ des Monats vor Positions-Quote) · CHF-Modus → null (frei).
   * Race-sicher: die (nur für Wareneinsatz nötige) Quote wird ZUERST geladen,
   * dann funktional gegen den AKTUELLEN Blob-Stand angewendet — nie ein vor
   * dem await eingefrorener Positions-Snapshot zurückgeschrieben.
   */
  const monatReset = useCallback(async (def: CockpitBudgetKpiDef, i: number) => {
    const ctx = ctxRef.current;
    let weqQuote: number | null = null;
    if (def.id === 'wareneinsatz') {
      const wb = await loadWeqKalk(tenantKey, year).catch(() => null);
      weqQuote = wb?.weqNettoMonate?.[i] ?? null;
    }
    if (ctxRef.current !== ctx) return; // Mandant/Jahr gewechselt → verwerfen
    const erN = erNetto[i];
    setBlob(b => {
      if (!b) return b;
      const cur = b.positions[def.id] ?? leereCockpitBudgetPosition(def.id, def.unit);
      const mv = cur.monthlyValues.slice();
      const me = cur.monthlyExplicit.slice();
      if (def.unit === 'pct' || (cur.inputMode ?? 'chf') !== 'pct') {
        mv[i] = null; // leer statt 0 — Ableitung/Verteilung übernimmt wieder
      } else {
        const q = weqQuote ?? cur.pctValue ?? null;
        mv[i] = q !== null && typeof erN === 'number' ? r2(erN * (q / 100)) : null;
      }
      me[i] = false;
      return { ...b, positions: { ...b.positions, [def.id]: { ...cur, monthlyValues: mv, monthlyExplicit: me } } };
    });
    setDirty(true);
  }, [tenantKey, year, erNetto]);

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

  // ── Ziel-/Ableitungslogik (Spec 08/2026) ──────────────────────────────────

  const erNettoFehlt = useCallback((zweck: string): boolean => {
    if (erNetto.some(v => v !== null)) return false;
    toast({
      title: 'Kein ER-Netto-Budget',
      description: `Für ${year} ist im Budget-Modul (ER) kein Netto-Umsatz-Budget erfasst — ${zweck} rechnet auf dessen Monatswerten.`,
    });
    return true;
  }, [erNetto, year, toast]);

  /** Fehlende ER-Monate als Toast melden (diese Monate bleiben leer). */
  const meldeLeereErMonate = useCallback((mv: (number | null)[]) => {
    const fehlend = mv.map((v, i) => (v === null ? MONATE_KURZ[i] : null)).filter(Boolean);
    if (fehlend.length > 0) {
      toast({
        title: 'ER-Netto-Budget fehlt teilweise',
        description: `${fehlend.join(', ')}: kein Netto-Umsatz-Budget im Budget-Modul (ER) — diese Monate bleiben leer.`,
      });
    }
  }, [toast]);

  /**
   * WARENEINSATZ: je Monat kalkulierte WEQ aus dem Gastronovi-Verkaufsdaten-
   * Import (wo vorhanden), sonst Ziel-% (Default 22) — × ER-Netto-Monat.
   */
  const weqAnwenden = useCallback(async () => {
    const ziel = Number(pctInput['wareneinsatz'] ?? '22');
    if (!isFinite(ziel) || ziel <= 0) {
      toast({ title: 'Ziel-Quote', description: 'Bitte eine Wareneinsatzquote > 0 % erfassen.' });
      return;
    }
    if (erNettoFehlt('die Wareneinsatz-Ableitung')) return;
    setBusy('wareneinsatz');
    try {
      const def = COCKPIT_BUDGET_KPIS.find(d => d.id === 'wareneinsatz')!;
      const pos = getPos(def);
      // 1) Importierte WEQ-Quelle (Kassen-Export, kalkulierter Wareneinsatz
      //    CHF je Monat) hat VORRANG: Monate mit Daten = CHF direkt als
      //    Budget; Netto-WEQ (CHF ÷ Netto-Ist, umsatz-SSOT) nur informativ
      //    bzw. als Ø-Näherung für die übrigen Monate — NIE die Brutto-
      //    Kassenquote 1:1.
      const importBlob = await loadWeqKalk(tenantKey, year)
        .catch(e => { console.error('[CK-BUDGET] WEQ-Import-Blob laden fehlgeschlagen:', e); return null; });
      // 0) Direkt hinterlegte NETTO-WEQ-Quoten je Monat (höchste Präzedenz):
      //    Budget = Quote × ER-Netto-Budget des Monats (leer statt 0, nie ÷0).
      const weqQuoten = importBlob?.weqNettoMonate;
      if (weqQuoten?.some(v => v !== null)) {
        const naeherung = importBlob?.naeherungMonate ?? Array(12).fill(false);
        const mv = erNetto.map((n, i) =>
          typeof n === 'number' && weqQuoten[i] !== null
            ? r2(n * (weqQuoten[i]! / 100)) : null);
        const belegt = weqQuoten.filter((v): v is number => v !== null);
        const avg = belegt.length ? r2(belegt.reduce((a, b) => a + b, 0) / belegt.length) : r2(ziel);
        setPos('wareneinsatz', {
          ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
          inputMode: 'pct', pctValue: avg,
          yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
        });
        const liste = weqQuoten
          .map((q, i) => (q !== null ? `${MONATE_KURZ[i]} ${q}%${naeherung[i] ? '*' : ''}` : null))
          .filter(Boolean);
        toast({
          title: 'Wareneinsatz-Budget aus hinterlegter Netto-WEQ',
          description: `${liste.join(', ')} — × ER-Netto je Monat (* = Näherung), editierbar.`,
        });
        meldeLeereErMonate(mv);
        return;
      }
      const kalkChf = importBlob?.chfMonate ?? Array(12).fill(null) as (number | null)[];
      if (kalkChf.some(v => v !== null)) {
        const nettoIst = await ladeSaisonGewichte(tenantId as TenantId, tenantKey, year, 'netto_umsatz', rates ?? null)
          .catch(e => { console.error('[CK-BUDGET] Netto-Ist für WEQ fehlgeschlagen:', e); return null; });
        const weqNetto = kalkChf.map((chf, i) =>
          chf !== null && nettoIst && nettoIst[i] > 0 ? r2((chf / nettoIst[i]) * 100) : null);
        const vorhanden = weqNetto.filter((v): v is number => v !== null);
        const avg = vorhanden.length
          ? r2(vorhanden.reduce((a, b) => a + b, 0) / vorhanden.length) : r2(ziel);
        const mv = erNetto.map((n, i) =>
          kalkChf[i] !== null
            ? r2(kalkChf[i]!)
            : (typeof n === 'number' ? r2(n * (avg / 100)) : null));
        setPos('wareneinsatz', {
          ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
          inputMode: 'pct', pctValue: avg,
          yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
        });
        const mitDaten = kalkChf
          .map((v, i) => (v !== null ? `${MONATE_KURZ[i]}${weqNetto[i] !== null ? ` ${weqNetto[i]}%` : ''}` : null))
          .filter(Boolean);
        const naeherung = kalkChf.map((v, i) => (v === null ? MONATE_KURZ[i] : null)).filter(Boolean);
        toast({
          title: 'Wareneinsatz-Budget aus WEQ-Import',
          description: `Kalkulierter Wareneinsatz übernommen (Netto-WEQ): ${mitDaten.join(', ')}`
            + (naeherung.length ? ` · Näherung Ø ${avg} % × ER-Netto: ${naeherung.join(', ')}` : '') + ' — editierbar.',
        });
        meldeLeereErMonate(mv);
        return;
      }
      // 2) Fallback: kalkulierte WEQ aus Verkaufsdaten (product_sales), sonst Ziel-%.
      const weq = await kalkulierteWeqMonate(tenantId as TenantId, year)
        .catch(e => { console.error('[CK-BUDGET] kalkulierte WEQ fehlgeschlagen:', e); return Array(12).fill(null) as (number | null)[]; });
      const mv = erNetto.map((n, i) =>
        typeof n === 'number' ? r2(n * ((weq[i] ?? ziel) / 100)) : null);
      setPos('wareneinsatz', {
        ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
        inputMode: 'pct', pctValue: r2(ziel),
        yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
      });
      const kalk = weq.map((w, i) => (w !== null && erNetto[i] !== null ? `${MONATE_KURZ[i]} ${w}%` : null))
        .filter(Boolean);
      toast({
        title: 'Wareneinsatz-Budget abgeleitet',
        description: kalk.length
          ? `Kalkulierte WEQ aus Verkaufsdaten: ${kalk.join(', ')} · übrige Monate Ziel ${ziel} % — × ER-Netto, editierbar.`
          : `Keine kalkulierte WEQ aus Verkaufsdaten — alle Monate Ziel ${ziel} % × ER-Netto (editierbar).`,
      });
      meldeLeereErMonate(mv);
    } finally { setBusy(null); }
  }, [pctInput, erNettoFehlt, tenantId, tenantKey, rates, year, erNetto, getPos, setPos, meldeLeereErMonate, toast]);

  // ── WEQ-Quelle importieren (Kassen-Exporte: CHF-Datei + optionale %-Datei) ──
  const weqImportRef = useRef<HTMLInputElement | null>(null);
  const weqDateienImportieren = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy('wareneinsatz');
    try {
      let chf: (number | null)[] | null = null;
      let tage: number[] = Array(12).fill(0);
      const namen: string[] = [];
      const meldungen: string[] = [];
      for (const f of Array.from(files)) {
        const erg = parseWeqExport(await f.arrayBuffer(), f.name);
        meldungen.push(erg.debug);
        if (erg.typ === 'chf') { chf = erg.chfMonate; tage = erg.tageMonate; namen.push(f.name); }
      }
      if (!chf || !chf.some(v => v !== null)) {
        toast({
          title: 'Keine WEQ-Datenbasis erkannt',
          description: `Es braucht die CHF-Datei (Zeile «Gesamt» mit Tageswerten). ${meldungen.join(' · ')}`,
          variant: 'destructive',
        });
        return;
      }
      await saveWeqKalk(tenantKey, { year, chfMonate: chf, tageMonate: tage, quelleDateien: namen, updatedAt: '' });
      const monate = chf.map((v, i) => (v !== null ? `${MONATE_KURZ[i]} ${v!.toLocaleString('de-CH')}` : null)).filter(Boolean);
      toast({
        title: `WEQ-Quelle importiert (${year})`,
        description: `${meldungen.join(' · ')} — ${monate.join(', ')}. Jetzt «Quote anwenden» drücken, um das Budget abzuleiten.`,
      });
    } catch (e) {
      toast({ title: 'WEQ-Import fehlgeschlagen', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(null);
      if (weqImportRef.current) weqImportRef.current.value = '';
    }
  }, [tenantKey, year, toast]);

  /**
   * TAKE-AWAY: EINE Eingabe = Anteil-%. Materialisiert die Anteil-Monate UND
   * das (read-only) TA-Umsatz-netto-Budget = Anteil × ER-Netto je Monat.
   */
  const taAnteilAnwenden = useCallback(() => {
    const anteil = Number(pctInput['take_away_anteil'] ?? '');
    if (!isFinite(anteil) || anteil <= 0 || anteil >= 100) {
      toast({ title: 'TA-Anteil', description: 'Bitte einen Anteil zwischen 0 und 100 % erfassen.' });
      return;
    }
    if (erNettoFehlt('die Take-Away-Ableitung')) return;
    const pq = r2(anteil);
    const anteilDef = COCKPIT_BUDGET_KPIS.find(d => d.id === 'take_away_anteil')!;
    const anteilPos = getPos(anteilDef);
    const anteilMv = erNetto.map(n => (typeof n === 'number' ? pq : null));
    const taDef = COCKPIT_BUDGET_KPIS.find(d => d.id === 'take_away_umsatz')!;
    const taPos = getPos(taDef);
    const taMv = erNetto.map(n => (typeof n === 'number' ? r2(n * pq / 100) : null));
    setPos('take_away_anteil', {
      ...anteilPos, monthlyValues: anteilMv, monthlyExplicit: Array(12).fill(false),
      inputMode: 'pct', pctValue: pq, yearValue: null,
    });
    setPos('take_away_umsatz', {
      ...taPos, monthlyValues: taMv, monthlyExplicit: Array(12).fill(false),
      inputMode: 'pct', pctValue: pq,
      yearValue: r2(taMv.reduce<number>((s, v) => s + (v ?? 0), 0)),
      // read-only-Zeile: alte Wochen-Overrides würden die Anteil-Ableitung
      // in der Wochenauflösung übersteuern → beim Anwenden entfernen.
      weekOverrides: {},
    });
    toast({
      title: 'Take-Away abgeleitet',
      description: `Anteil ${pq} % auf alle ER-Monate; TA-Umsatz (netto) = Anteil × ER-Netto (read-only).`,
    });
    meldeLeereErMonate(taMv);
  }, [pctInput, erNettoFehlt, erNetto, getPos, setPos, meldeLeereErMonate, toast]);

  /**
   * PERSONALKOSTEN + PERSONALQUOTE zusammengelegt: EINE Zielquote (Default
   * 40 %) setzt beide — PK-CHF = Quote × ER-Netto je Monat, Quote-Zeile = Quote.
   */
  const pkQuoteAnwenden = useCallback(() => {
    const q = Number(pctInput['personalquote'] ?? '40');
    if (!isFinite(q) || q <= 0 || q >= 100) {
      toast({ title: 'Personal-Zielquote', description: 'Bitte eine Quote zwischen 0 und 100 % erfassen.' });
      return;
    }
    if (erNettoFehlt('die Personalkosten-Ableitung')) return;
    const pq = r2(q);
    const pkDef = COCKPIT_BUDGET_KPIS.find(d => d.id === 'personalkosten')!;
    const pkPos = getPos(pkDef);
    const pkMv = erNetto.map(n => (typeof n === 'number' ? r2(n * pq / 100) : null));
    const pqDef = COCKPIT_BUDGET_KPIS.find(d => d.id === 'personalquote')!;
    const pqPos = getPos(pqDef);
    setPos('personalkosten', {
      ...pkPos, monthlyValues: pkMv, monthlyExplicit: Array(12).fill(false),
      inputMode: 'pct', pctValue: pq,
      yearValue: r2(pkMv.reduce<number>((s, v) => s + (v ?? 0), 0)),
    });
    setPos('personalquote', {
      ...pqPos, monthlyValues: erNetto.map(n => (typeof n === 'number' ? pq : null)),
      monthlyExplicit: Array(12).fill(false), inputMode: 'pct', pctValue: pq, yearValue: null,
    });
    setPctInput(s => ({ ...s, personalquote: String(pq) }));
    toast({
      title: 'Personal-Budget abgeleitet',
      description: `Zielquote ${pq} %: Personalkosten = ${pq} % × ER-Netto je Monat, Personalquote = ${pq} % (beide editierbar).`,
    });
    meldeLeereErMonate(pkMv);
  }, [pctInput, erNettoFehlt, erNetto, getPos, setPos, meldeLeereErMonate, toast]);

  /**
   * PRODUKTIVE STUNDEN: Budget = Personalbedarf-SOLL (netto, pro Tag definiert),
   * je Monat aggregiert. Kein Bedarf hinterlegt → leer + Hinweis (nie 0).
   */
  const stundenAusBedarf = useCallback(async () => {
    setBusy('prod_stunden');
    try {
      const mv = await bedarfSollStundenMonate(tenantId as TenantId, year);
      if (!mv.some(v => v !== null)) {
        toast({
          title: 'Kein Personalbedarf hinterlegt',
          description: `Für ${tenantId === 'oliv' ? 'Oliv' : 'Beaulieu'} sind keine Soll-Schichten (Personalbedarf) erfasst — das Stunden-Budget bleibt leer (nie 0).`,
        });
        return;
      }
      const def = COCKPIT_BUDGET_KPIS.find(d => d.id === 'prod_stunden')!;
      const pos = getPos(def);
      setPos('prod_stunden', {
        ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
        inputMode: 'chf', pctValue: null,
        yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
      });
      const leer = mv.map((v, i) => (v === null ? MONATE_KURZ[i] : null)).filter(Boolean);
      toast({
        title: 'Planstunden aus Personalbedarf',
        description: leer.length
          ? `Soll-Stunden je Monat übernommen; ohne Bedarf: ${leer.join(', ')} (leer).`
          : 'Soll-Stunden des Personalbedarfs je Monat übernommen (editierbar).',
      });
    } catch (e) {
      console.error('[CK-BUDGET] Personalbedarf-Ladung fehlgeschlagen:', e);
      toast({ title: 'Personalbedarf nicht ladbar', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally { setBusy(null); }
  }, [tenantId, year, getPos, setPos, toast]);

  // ── Auto-Befüllung: Ist-Werte des gewählten Jahres («Stand der Dinge») ───

  /**
   * Eine Position aus vorab geladenen Ist-Monatswerten befüllen:
   *  - abgeschlossene Monate mit Daten → echter Ist-Wert des Jahres;
   *  - alle übrigen Monate (laufender Teilmonat/zukünftig/ohne Daten) →
   *    der echte VORJAHRESWERT desselben Monats (saisonal, KEIN Schnitt;
   *    der laufende Teilmonat nimmt den vollen Vorjahresmonat statt des
   *    Teilwerts);
   *  - fehlt auch das Vorjahr → Monat bleibt LEER (nie 0) mit Hinweis.
   * Liefert eine Meldung (fehlende Quelle/Lücken), sonst null.
   */
  const fuellePosition = useCallback((
    def: CockpitBudgetKpiDef,
    ist: (number | null)[] | null,
    vj: (number | null)[] | null,
  ): string | null => {
    // BEWUSST kein setPos, wenn GAR keine Quelle lieferte: eine still
    // fehlgeschlagene Ladung (istMonatswerteAlle → null) darf bestehende
    // Budgetwerte nie mit Leere überschreiben (Fehler ≠ «keine Daten»).
    if (!ist && !vj) return `Keine ${year}- oder ${year - 1}-Ist-Daten für «${def.label}» — bestehende Werte unverändert.`;
    const closed = new Set(abgeschlosseneMonate(year));
    const runde = def.unit === 'count'
      ? (v: number) => Math.round(v)
      : (v: number) => r2(v);
    const luecken: number[] = [];
    const mv = Array.from({ length: 12 }, (_, i) => {
      const eig = closed.has(i + 1) ? ist?.[i] ?? null : null; // Teilmonat zählt NICHT
      if (eig !== null) return runde(eig);
      const vw = vj?.[i] ?? null;                              // Vorjahresmonat
      if (vw !== null) return runde(vw);
      luecken.push(i + 1);
      return null;                                             // leer statt 0
    });
    if (!mv.some(v => v !== null)) {
      return `Keine ${year}-Ist- und keine ${year - 1}-Vorjahreswerte für «${def.label}» — bestehende Werte unverändert.`;
    }
    const pos = getPos(def);
    setPos(def.id, {
      ...pos, monthlyValues: mv,
      monthlyExplicit: Array(12).fill(false),
      inputMode: 'chf', pctValue: null,
      yearValue: def.unit === 'pct' ? null : r2(mv.reduce((s, v) => s + (v ?? 0), 0)),
    });
    return luecken.length
      ? `«${def.label}»: Monat(e) ${luecken.join(', ')} ohne ${year}-Ist und ohne ${year - 1}-Vorjahreswert — leer gelassen.`
      : null;
  }, [year, getPos, setPos]);

  const autofillEine = useCallback(async (def: CockpitBudgetKpiDef) => {
    setBusy(def.id);
    try {
      const [alle, vjAlle] = await Promise.all([
        istMonatswerteAlle(tenantId as TenantId, tenantKey, year, rates),
        istMonatswerteAlle(tenantId as TenantId, tenantKey, year - 1, rates),
      ]);
      const msg = fuellePosition(def, alle[def.id] ?? null, vjAlle[def.id] ?? null);
      if (msg) toast({ title: 'Autofill', description: msg });
      else toast({
        title: 'Ist-Werte übernommen',
        description: `«${def.label}»: abgeschlossene ${year}-Monate = Ist, Rest = Vorjahr ${year - 1} — editierbar.`,
      });
    } catch (e) {
      console.error('[CK-AUTOFILL] fehlgeschlagen:', e);
      toast({ title: 'Autofill fehlgeschlagen', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally { setBusy(null); }
  }, [tenantId, tenantKey, year, rates, fuellePosition, toast]);

  /** Gesamt-Befüllung: JEDE Position aus den Ist-Werten (Quellen 1× geladen). */
  const autofillAlle = useCallback(async () => {
    setBusy('*');
    try {
      const [alle, vjAlle] = await Promise.all([
        istMonatswerteAlle(tenantId as TenantId, tenantKey, year, rates),
        istMonatswerteAlle(tenantId as TenantId, tenantKey, year - 1, rates),
      ]);
      const meldungen: string[] = [];
      for (const def of COCKPIT_BUDGET_KPIS.filter(d => AUTOFILL_IDS.has(d.id))) {
        const msg = fuellePosition(def, alle[def.id] ?? null, vjAlle[def.id] ?? null);
        if (msg) meldungen.push(msg);
      }
      toast({
        title: 'Autofill abgeschlossen',
        description: meldungen.length
          ? meldungen.slice(0, 3).join(' ')
          : `Ziel-Quoten (TA-Anteil, Ø-Verkauf, Produktivität) aus Ist geseedet: abgeschlossene ${year}-Monate = Ist, übrige = Vorjahr ${year - 1} (saisonal). Kosten/Stunden/Gäste per Ableitung.`,
      });
    } catch (e) {
      console.error('[CK-AUTOFILL] fehlgeschlagen:', e);
      toast({ title: 'Autofill fehlgeschlagen', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally { setBusy(null); }
  }, [tenantId, tenantKey, year, rates, fuellePosition, toast]);

  /**
   * Manuelle Steigerung (+X % oder +X CHF) auf die BEFÜLLTEN Monate einer
   * Position anwenden — bewusst separater Schritt (kein Auto-±10 % mehr).
   */
  const steigerungAnwenden = useCallback((def: CockpitBudgetKpiDef) => {
    const x = Number(steigWert);
    if (!isFinite(x) || x === 0) {
      toast({ title: 'Steigerung', description: 'Bitte einen Wert ≠ 0 erfassen (+ erhöht, − senkt).' });
      return;
    }
    const pos = getPos(def);
    if (!pos.monthlyValues.some(v => v !== null)) {
      toast({ title: 'Steigerung', description: 'Keine Monatswerte vorhanden — zuerst befüllen.' });
      return;
    }
    const runde = def.unit === 'count' ? (v: number) => Math.round(v) : (v: number) => r2(v);
    const mv = pos.monthlyValues.map(v => v === null ? null
      : runde(steigArt === 'pct' ? v * (1 + x / 100) : v + x));
    setPos(def.id, {
      ...pos, monthlyValues: mv, inputMode: 'chf', pctValue: null,
      yearValue: def.unit === 'pct' ? pos.yearValue
        : r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
    });
    toast({
      title: 'Steigerung angewendet',
      description: `«${def.label}»: ${steigArt === 'pct' ? `${x > 0 ? '+' : ''}${x} %` : `${x > 0 ? '+' : ''}${x} CHF/Einheit`} auf alle befüllten Monate.`,
    });
  }, [steigArt, steigWert, getPos, setPos, toast]);

  // ── Ableitungen (Gäste aus Ø-Verkauf-Ziel · Stunden aus Ziel-Produktivität) ─

  /** Restaurant-Netto-Budget je Monat: ER-Netto − TA-Budget (TA ist bereits
   *  NETTO; Oliv — Beaulieu ohne TA). */
  const restaurantNettoMonat = useCallback((i: number): number | null => {
    const netto = erNetto[i];
    if (typeof netto !== 'number') return null;
    if (tenantId !== 'oliv') return netto;
    const ta = getPosById('take_away_umsatz')?.monthlyValues[i];
    return netto - (typeof ta === 'number' ? ta : 0);
  }, [erNetto, getPosById, tenantId]);

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
      toast({ title: 'ER-Netto-Budget fehlt', description: `Gäste-Ableitung braucht das Netto-Umsatz-Budget ${year} aus dem Budget-Modul (ER).` });
      return;
    }
    setPos('gaeste_in', {
      ...pos, monthlyValues: mv, monthlyExplicit: Array(12).fill(false),
      yearValue: r2(mv.reduce<number>((s, v) => s + (v ?? 0), 0)),
    });
    toast({ title: 'Gäste-Budget abgeleitet', description: 'Restaurant-Netto-Budget ÷ Ø-Verkauf-Ziel, je Monat (editierbar).' });
  }, [getPos, getPosById, restaurantNettoMonat, year, setPos, toast]);

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
            {busy === '*' ? 'Befüllt …' : `Ziel-Quoten aus ${year}-Ist seeden`}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            nur Ziel-Quoten (TA-Anteil, Ø-Verkauf/Gast, Produktivität) · abgeschlossene Monate = {year}-Ist, übrige = Vorjahr {year - 1} · überschreibt (Rückgängig möglich)
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
          const imPctModus = (pos.inputMode ?? 'chf') === 'pct';
          const hatAutofill = AUTOFILL_IDS.has(def.id);
          const readOnly = READONLY_IDS.has(def.id);
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
                {readOnly && (
                  <span className="text-[10px] text-muted-foreground">· abgeleitet aus TA-Anteil % (read-only)</span>
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
                        {busy === def.id ? 'Befüllt …' : `Ist-Werte ${year} übernehmen`}
                      </Button>
                    )}
                    {/* Manuelle Steigerung — bewusst separater Schritt (kein Auto-±10 %). */}
                    {!readOnly && <div className="flex items-center gap-1.5 text-xs">
                      <Input type="number" className="h-7 w-16 text-right text-xs" value={steigWert}
                        onChange={e => setSteigWert(e.target.value)} data-testid={`input-steigerung-wert-${def.id}`} />
                      <Select value={steigArt} onValueChange={v => setSteigArt(v as 'pct' | 'chf')}>
                        <SelectTrigger className="h-7 w-[90px] text-xs" data-testid={`select-steigerung-art-${def.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pct">± %</SelectItem>
                          <SelectItem value="chf">± CHF</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" className="h-7 text-xs"
                        onClick={() => steigerungAnwenden(def)}
                        data-testid={`button-steigerung-${def.id}`}>
                        Steigerung anwenden
                      </Button>
                    </div>}
                    {def.id === 'wareneinsatz' && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Ziel-WEQ %:</span>
                        <Input type="number" inputMode="decimal" className="h-7 w-20 text-right text-xs"
                          value={pctInput['wareneinsatz'] ?? '22'}
                          onChange={e => setPctInput(s => ({ ...s, wareneinsatz: e.target.value }))}
                          data-testid="input-pct-wareneinsatz" />
                        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null}
                          onClick={weqAnwenden} data-testid="button-weq-anwenden">
                          {busy === 'wareneinsatz' ? 'Leitet ab …' : 'Quote anwenden'}
                        </Button>
                        <input
                          ref={weqImportRef} type="file" multiple accept=".xlsx,.xls" className="hidden"
                          onChange={e => weqDateienImportieren(e.target.files)}
                          data-testid="input-weq-import-files"
                        />
                        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={busy !== null}
                          onClick={() => weqImportRef.current?.click()} data-testid="button-weq-import">
                          <Upload className="h-3.5 w-3.5" /> WEQ-Dateien importieren
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          Import (kalk. Wareneinsatz CHF) vor Verkaufsdaten vor Ziel-% — Näherungs-Monate Ø der vorhandenen
                        </span>
                      </div>
                    )}
                    {def.id === 'take_away_anteil' && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Anteil %:</span>
                        <Input type="number" inputMode="decimal" className="h-7 w-20 text-right text-xs"
                          value={pctInput['take_away_anteil'] ?? ''}
                          onChange={e => setPctInput(s => ({ ...s, take_away_anteil: e.target.value }))}
                          placeholder="z.B. 8"
                          data-testid="input-pct-take_away_anteil" />
                        <Button variant="outline" size="sm" className="h-7 text-xs"
                          onClick={taAnteilAnwenden} data-testid="button-ta-anteil-anwenden">
                          Anteil anwenden
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          setzt Anteil-Monate UND das TA-Umsatz-Budget (netto, read-only)
                        </span>
                      </div>
                    )}
                    {(def.id === 'personalkosten' || def.id === 'personalquote') && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Zielquote %:</span>
                        <Input type="number" inputMode="decimal" className="h-7 w-20 text-right text-xs"
                          value={pctInput['personalquote'] ?? '40'}
                          onChange={e => setPctInput(s => ({ ...s, personalquote: e.target.value }))}
                          data-testid={`input-pct-personal-${def.id}`} />
                        <Button variant="outline" size="sm" className="h-7 text-xs"
                          onClick={pkQuoteAnwenden} data-testid={`button-pk-quote-${def.id}`}>
                          Zielquote anwenden
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          EINE Quote steuert Personalkosten-CHF UND Personalquote (Default 40 %)
                        </span>
                      </div>
                    )}
                    {def.id === 'gaeste_in' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs"
                        onClick={gaesteAbleiten} data-testid="button-gaeste-ableiten">
                        Aus Ø-Verkauf-Ziel ableiten
                      </Button>
                    )}
                    {def.id === 'prod_stunden' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy !== null}
                        onClick={stundenAusBedarf} data-testid="button-stunden-bedarf">
                        {busy === 'prod_stunden' ? 'Leitet ab …' : 'Aus Personalbedarf (Soll) übernehmen'}
                      </Button>
                    )}
                  </div>

                  {/* Jahreswert + Verteilung (für %-Positionen wenig sinnvoll → nur Monatseingabe) */}
                  {def.unit !== 'pct' && !imPctModus && !readOnly && (
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

                  {/* 12 Monats-Eingaben; Tippen ⇒ expliziter Monat («manuell»).
                      CHF-Position im %-Modus: die Felder sind PROZENT-Eingaben —
                      der Monats-CHF wird sofort = % × ER-Netto-Budget des Monats
                      gerechnet (nur dieser Monat, Modus bleibt %).
                      %-Positionen (Quoten): Felder sind direkt %-Werte.
                      CHF-Direktmodus: unverändert CHF; Editieren im %-Modus
                      findet nicht mehr statt (kein Rückfall auf CHF). */}
                  {(() => {
                    const pctProMonat = imPctModus && def.unit !== 'pct' && !readOnly;
                    const pctVonChf = (i: number): number | null => {
                      const n = erNetto[i]; const v = pos.monthlyValues[i];
                      return typeof n === 'number' && n > 0 && v !== null ? r2((v / n) * 100) : null;
                    };
                    return (
                  <div className="space-y-1">
                    {pctProMonat && (
                      <p className="text-[10px] text-muted-foreground">
                        %-Modus: Monatsfelder = <b>% vom Netto-Umsatz-Budget</b> des Monats (CHF wird automatisch gerechnet).
                      </p>
                    )}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                    {MONATE_KURZ.map((m, i) => (
                      <div key={m} className="space-y-0.5">
                        <label className={cn('flex items-center gap-1 text-[10px]',
                          pos.monthlyExplicit[i] ? 'font-bold' : 'text-muted-foreground')}>
                          {m}{pos.monthlyExplicit[i] ? ' ·manuell' : ''}
                          {pos.monthlyExplicit[i] && !readOnly && (
                            <button
                              type="button" className="text-muted-foreground hover:text-foreground"
                              title="Zurück auf abgeleitet/importiert"
                              onClick={() => monatReset(def, i)}
                              data-testid={`button-monat-reset-${def.id}-${i + 1}`}
                            >
                              <RotateCcw className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </label>
                        <Input
                          type="number" inputMode="decimal" className="h-8 text-right text-xs"
                          value={pctProMonat ? fmtNum(pctVonChf(i)) : fmtNum(pos.monthlyValues[i])}
                          disabled={readOnly}
                          placeholder={pctProMonat ? '%' : undefined}
                          onChange={e => {
                            if (readOnly) return;
                            const raw = e.target.value;
                            const v = raw === '' ? null : Number(raw);
                            if (v !== null && !isFinite(v)) return;
                            const mv = pos.monthlyValues.slice();
                            const me = pos.monthlyExplicit.slice();
                            if (pctProMonat) {
                              // %-Eingabe → CHF dieses Monats = % × ER-Netto (nie ÷0).
                              const n = erNetto[i];
                              if (v !== null && typeof n !== 'number') {
                                toast({
                                  title: 'ER-Netto-Budget fehlt',
                                  description: `${MONATE_KURZ[i]} ${year}: ohne Netto-Umsatz-Budget kann kein %-Wert gerechnet werden.`,
                                  variant: 'destructive',
                                });
                                return;
                              }
                              mv[i] = v !== null ? r2((n as number) * (v / 100)) : null;
                              me[i] = v !== null;
                              setPos(def.id, { ...pos, monthlyValues: mv, monthlyExplicit: me });
                              return;
                            }
                            mv[i] = v;
                            me[i] = mv[i] !== null; // löschen ⇒ wieder frei für Verteilung
                            setPos(def.id, {
                              ...pos, monthlyValues: mv, monthlyExplicit: me,
                              // CHF-Tipperei verlässt den %-Modus nur bei CHF-Positionen;
                              // Quoten-Positionen (unit 'pct') bleiben Quoten.
                              inputMode: def.unit === 'pct' ? pos.inputMode : 'chf',
                            });
                          }}
                          data-testid={`input-monat-${def.id}-${i + 1}`}
                        />
                      </div>
                    ))}
                  </div>
                  </div>
                    );
                  })()}

                  {/* Wochen-Overrides (ISO-KW). Für %-Positionen gilt der Wert ungekürzt.
                      Read-only-Zeilen (TA-CHF): keine Overrides — die Wochen-
                      Auflösung folgt der Anteil-Ableitung (Override hätte Vorrang). */}
                  {!readOnly && <div className="space-y-1.5">
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
                  </div>}
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
          Umsatz-Budget = ER-/P&amp;L-Budget (Budget-Modul) — alle Ableitungen
          rechnen auf dessen Netto-Monatswerten · Ziel-/Ableitungslogik:
          Wareneinsatz = kalkulierte WEQ (Verkaufsdaten) bzw. Ziel-% × ER-Netto ·
          Take-Away: nur der Anteil-% wird erfasst, TA-CHF (netto) = Anteil ×
          ER-Netto (read-only) · Gäste = Restaurant-Netto ÷ Ø-Verkauf-Ziel ·
          Produktive Stunden = Personalbedarf-Soll je Monat · Personalkosten &amp;
          Personalquote = EINE Zielquote (Default 40 %) · Autofill seedet nur
          die Ziel-Quoten (abgeschlossene Monate = {year}-Ist, übrige = Vorjahr
          {year - 1}); jede abgeleitete Zeile bleibt editierbar;
          Steigerung nur manuell per Button ·
          leere Felder = kein Budget (nie 0)
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
