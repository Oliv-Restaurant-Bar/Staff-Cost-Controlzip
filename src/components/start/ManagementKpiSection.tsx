/**
 * ManagementKpiSection — Management-KPIs der Startseite (Ebene 1).
 * ================================================================
 * User-Vorgabe: 3-Ebenen-Architektur —
 *   Ebene 1 = diese Sektion (~16 feste KPIs aus dem KPI-Katalog),
 *   Ebene 2 = bestehende Analyse-Seiten (analyseRoute je KPI),
 *   Ebene 3 = bestehende Detail-/Beleg-Ebenen (detailRoute je KPI).
 *
 * Regeln:
 *  - Werte AUSSCHLIESSLICH über getKpiValues (kpi-catalog) — Registry-KPIs
 *    delegieren an die Financial-Metrics-Registry (EIN computePLForMonth).
 *  - Ampeln nur über getKpiToneWithTarget (bestehende zentrale Regeln;
 *    Betriebs-Zielwert = dokumentierte Ausnahme, s. kpi-targets.ts); fehlend =
 *    «—», NIE 0. Abw. Budget = reine Anzeige-Ableitung auf Rohwerten OHNE Ampel.
 *  - Monatswahl wirkt erkennbar auf ALLE Werte der Sektion.
 *  - Max. 4 sichtbare KPI-Karten (istKarte), Rest in der Tabelle (MoreKpis).
 *  - Gast-Sessions: keine Links auf gastgesperrte Flächen, keine Kommentare,
 *    keine Exporte (rein lesende Anzeige).
 *  - Export (Excel/PDF, Profile Geschäftsleitung/Bank/Investoren) lädt das
 *    Export-Modul dynamisch — jspdf/xlsx bleiben aus dem Start-Bundle.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Download, Loader2, Pencil, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { StatusPill } from '@/components/ui/status-pill';
import { InfoTip } from '@/components/ui/info-tip';
import { TONE_TEXT, type Tone } from '@/components/ui/tones';
import { useManagementKpis } from '@/hooks/useManagementKpis';
import { useTenant, TENANTS } from '@/contexts/TenantContext';
import {
  KPI_CATALOG,
  KPI_QUELLE_LABEL,
  KPI_TARGET_EXCLUDED,
  getKpiIncompleteHint,
  getKpiToneWithTarget,
  getKpiTrend,
  getKpiValues,
  getKpiZielRichtung,
  isRunningMonth,
  type KpiDefinition,
  type KpiId,
  type KpiTone,
  type KpiTrend,
} from '@/lib/kpi-catalog';
import { buildKpiDrilldownUrl } from '@/lib/monat-param';
import { getVisibleKpiComment } from '@/lib/kpi-comments';
import { getVisibleKpiTarget } from '@/lib/kpi-targets';
import { useStartPrefs } from '@/hooks/useStartPrefs';
import { MAX_KPI_CARDS, moveItem } from '@/lib/start-prefs';
import type { KpiExportProfile } from '@/lib/management-kpi-export';
import { cn } from '@/lib/utils';

const DASH = '—';

// ─── Formatierung (nur Anzeige; Rohwert entscheidet Ampeln) ─────────────────

const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtValue(def: KpiDefinition, v: number | null): string {
  if (v === null) return DASH;
  switch (def.einheit) {
    case 'chf': return `CHF ${nf0.format(v)}`;
    case 'pct': return `${v.toFixed(1)} %`;
    case 'anzahl': return nf0.format(v);
    case 'chf_pro_gast':
    case 'chf_pro_stunde': return `CHF ${nf2.format(v)}`;
  }
}

function fmtAbw(def: KpiDefinition, v: number | null): string {
  if (v === null) return DASH;
  const sign = v >= 0 ? '+' : '';
  if (def.einheit === 'pct') return `${sign}${v.toFixed(1)} pp`;
  if (def.einheit === 'anzahl') return `${sign}${nf0.format(v)}`;
  return `${sign}CHF ${nf0.format(v)}`;
}

/** Trend-Anzeige: pp bei Prozent-KPIs, sonst relative % — Rundung NUR hier. */
function fmtTrendLabel(t: KpiTrend): string {
  const sign = t.delta > 0 ? '+' : '';
  const unit = t.deltaKind === 'pp' ? 'pp' : '%';
  return `${sign}${t.delta.toFixed(1)} ${unit} vs. ${t.basis === 'budget' ? 'Budget' : 'VJ'}`;
}

/** Zielwert-Eingabe (de-CH: Komma oder Punkt) → Rohwert; ''/ungültig = null. */
function parseTargetInput(raw: string): number | null | 'invalid' {
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s.replace(/['\u2019\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 'invalid';
}

/** KpiTone → Design-System-Tone (identische Namen, nur Typ-Brücke). */
const toTone = (t: KpiTone): Tone => t;

// ─── Monatsauswahl ──────────────────────────────────────────────────────────

/** Wählbare Monate: laufender Monat zurück bis Januar (aktuelles Jahr − 2). */
function buildMonthOptions(now: Date): { key: string; label: string }[] {
  const options: { key: string; label: string }[] = [];
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  const min = new Date(now.getFullYear() - 2, 0, 1);
  for (let d = cur; d >= min; d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
    options.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: format(d, 'LLLL yyyy', { locale: de }),
    });
  }
  return options;
}

// ─── Sektion ────────────────────────────────────────────────────────────────

export function ManagementKpiSection({
  enabled,
  isGuest,
}: {
  /** Nur für Admin-Sessions laden (Route ist admin-gated; doppelt hält besser). */
  enabled: boolean;
  /** Gast-Sessions: rein lesend, keine gesperrten Links/Exporte/Kommentare. */
  isGuest: boolean;
}) {
  const { tenantId } = useTenant();
  const navigate = useNavigate();
  const now = useMemo(() => new Date(), []);
  const monthOptions = useMemo(() => buildMonthOptions(now), [now]);
  const [monthSel, setMonthSel] = useState(monthOptions[0].key);
  const [selYear, selMonth] = monthSel.split('-').map(Number);

  const kpis = useManagementKpis(enabled, selYear, selMonth);
  const monthLabel = format(new Date(selYear, selMonth - 1, 1), 'LLLL yyyy', { locale: de });

  // Laufender Monat: kein anteiliges Budget (bewusst keine Hochrechnung) —
  // vollständiges Monatsbudget bleibt sichtbar, aber klar gekennzeichnet.
  const runningMonth = isRunningMonth(selYear, selMonth, now);
  const runningMonthNote = runningMonth
    ? `Laufender Monat – Vergleich mit vollständigem Monatsbudget · IST = Stand ${format(now, 'dd.MM.yyyy')}`
    : null;

  const [defsOpen, setDefsOpen] = useState(false);
  const [commentDef, setCommentDef] = useState<KpiDefinition | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Personalisierte Karten (max. 4) — alle übrigen KPIs bleiben in der Tabelle.
  const { prefs, canCustomize, savePrefs } = useStartPrefs();
  const cards = useMemo(
    () =>
      prefs.kpiCards
        .map(id => KPI_CATALOG.find(d => d.id === id))
        .filter((d): d is KpiDefinition => d !== undefined),
    [prefs.kpiCards],
  );
  const tableDefs = useMemo(() => {
    const cardIds = new Set(cards.map(d => d.id));
    return KPI_CATALOG.filter(d => !cardIds.has(d.id));
  }, [cards]);

  // ── Anpassen-Dialog (Karten-Auswahl + eigene Zielwerte) ───────────────────
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draftCards, setDraftCards] = useState<KpiId[]>([]);
  const [draftTargets, setDraftTargets] = useState<Record<string, string>>({});
  const [customizeSaving, setCustomizeSaving] = useState(false);
  const [customizeError, setCustomizeError] = useState<string | null>(null);

  const openCustomize = () => {
    setDraftCards([...prefs.kpiCards]);
    const t: Record<string, string> = {};
    for (const def of KPI_CATALOG) {
      if (KPI_TARGET_EXCLUDED.has(def.id)) continue;
      const target = getVisibleKpiTarget(kpis.targets, def.id);
      t[def.id] = target !== null ? String(target.value) : '';
    }
    setDraftTargets(t);
    setCustomizeError(null);
    setCustomizeOpen(true);
  };

  const toggleDraftCard = (id: KpiId) => {
    setDraftCards(cur =>
      cur.includes(id)
        ? cur.filter(c => c !== id)
        : cur.length >= MAX_KPI_CARDS
          ? cur
          : [...cur, id],
    );
  };

  const saveCustomize = async () => {
    if (draftCards.length === 0) {
      setCustomizeError('Mindestens eine KPI-Karte auswählen.');
      return;
    }
    // Zielwerte zuerst vollständig validieren — kein Teil-Speichern.
    const parsed: Array<[KpiId, number | null]> = [];
    for (const def of KPI_CATALOG) {
      if (KPI_TARGET_EXCLUDED.has(def.id)) continue;
      const p = parseTargetInput(draftTargets[def.id] ?? '');
      if (p === 'invalid') {
        setCustomizeError(`Ungültiger Zielwert bei «${def.name}» — Zahl erwartet (z. B. 28.5).`);
        return;
      }
      parsed.push([def.id, p]);
    }
    setCustomizeSaving(true);
    setCustomizeError(null);
    try {
      savePrefs({ kpiCards: draftCards });
      for (const [id, value] of parsed) {
        // Sequentiell (KV-Backup-Regel §2); Dirty-Check macht Unverändertes zum No-op.
        await kpis.saveTarget(id, value);
      }
      setCustomizeOpen(false);
    } catch (err) {
      setCustomizeError(
        err instanceof Error ? err.message : 'Zielwerte konnten nicht gesichert werden.',
      );
    } finally {
      setCustomizeSaving(false);
    }
  };

  const openComment = (def: KpiDefinition) => {
    setCommentDef(def);
    setCommentDraft(getVisibleKpiComment(kpis.comments, kpis.monthKey, def.id)?.text ?? '');
    setCommentError(null);
  };

  const saveComment = async () => {
    if (!commentDef) return;
    setCommentSaving(true);
    setCommentError(null);
    try {
      await kpis.saveComment(commentDef.id, commentDraft.trim());
      setCommentDef(null);
    } catch (err) {
      setCommentError(
        err instanceof Error ? err.message : 'Kommentar konnte nicht gesichert werden.',
      );
    } finally {
      setCommentSaving(false);
    }
  };

  const runExport = async (kind: 'excel' | 'pdf', profile: KpiExportProfile) => {
    setExporting(true);
    try {
      const mod = await import('@/lib/management-kpi-export');
      const rows = mod.buildManagementKpiRows(kpis.input, kpis.comments, kpis.monthKey);
      const restaurantName = TENANTS[tenantId].name;
      if (kind === 'excel') mod.exportManagementKpisToExcel(rows, profile, monthLabel, restaurantName, runningMonthNote);
      else mod.exportManagementKpisToPDF(rows, profile, monthLabel, restaurantName, runningMonthNote);
    } finally {
      setExporting(false);
    }
  };

  /** Gast-Sessions: gesperrte Zielrouten weder verlinken noch klickbar machen. */
  const routeAllowed = (def: KpiDefinition, route: string | undefined): route is string =>
    !!route && !(isGuest && (def.guestHiddenRoutes ?? []).includes(route));

  /** Drilldown-Ziel inkl. gewähltem Monats-Kontext (?monat=YYYY-MM bzw. ?year=). */
  const drilldownUrl = (route: string) => buildKpiDrilldownUrl(route, selYear, selMonth);

  const linkCell = (def: KpiDefinition) => {
    const links: { label: string; route: string }[] = [];
    if (def.analyseRoute && def.analyseLabel) links.push({ label: 'Analyse', route: def.analyseRoute });
    if (def.detailRoute && def.detailLabel) links.push({ label: 'Detail', route: def.detailRoute });
    return links
      .filter(l => routeAllowed(def, l.route))
      .map(l => (
        <Link
          key={l.route + l.label}
          to={drilldownUrl(l.route)}
          className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-primary hover:underline"
        >
          {l.label}
          <ArrowRight className="h-3 w-3" />
        </Link>
      ));
  };

  return (
    <section aria-labelledby="mgmt-kpis" className="space-y-3" data-testid="mgmt-kpi-section">
      {/* Toolbar: Titel · Monatswahl · Definitionen · Export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="mgmt-kpis" className="text-base font-semibold">
            Management-KPIs
          </h2>
          <Select value={monthSel} onValueChange={setMonthSel}>
            <SelectTrigger className="h-8 w-[180px] text-xs" data-testid="mgmt-kpi-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map(o => (
                <SelectItem key={o.key} value={o.key} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runningMonth && (
            <span className="inline-flex items-center gap-1" data-testid="mgmt-kpi-running-month">
              <StatusPill tone="info" size="xs">Laufender Monat</StatusPill>
              <InfoTip
                text={`${runningMonthNote}. Es findet KEINE anteilige Budget-Hochrechnung statt — Budget und Vorjahr zeigen den vollständigen Monat.`}
              />
            </span>
          )}
          {kpis.loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-2">
          {canCustomize && (
            <Button variant="ghost" size="sm" onClick={openCustomize} data-testid="mgmt-kpi-customize-btn">
              <Settings2 className="mr-1.5 h-4 w-4" />
              Anpassen
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDefsOpen(true)} data-testid="mgmt-kpi-defs-btn">
            <BookOpen className="mr-1.5 h-4 w-4" />
            Definitionen
          </Button>
          {!isGuest && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={exporting} data-testid="mgmt-kpi-export-btn">
                  {exporting ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-1.5 h-4 w-4" />
                  )}
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Excel</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void runExport('excel', 'geschaeftsleitung')}>
                  Geschäftsleitung (alle KPIs + Kommentare)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runExport('excel', 'bank')}>Bank</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runExport('excel', 'investoren')}>Investoren</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>PDF</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void runExport('pdf', 'geschaeftsleitung')}>
                  Geschäftsleitung (alle KPIs + Kommentare)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runExport('pdf', 'bank')}>Bank</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runExport('pdf', 'investoren')}>Investoren</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Sichtbarer Teilfehler der Gäste-Kennzahlen (Registry-KPIs bleiben nutzbar) */}
      {kpis.loadError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span>Gäste-Kennzahlen konnten nicht geladen werden: {kpis.loadError}</span>
          <Button variant="outline" size="sm" onClick={kpis.retry}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {/* Personalisierte KPI-Karten (max. 4) mit Trend + Info-Tooltip */}
      <KpiGrid>
        {cards.map(def => {
          const v = getKpiValues(def.id, kpis.input);
          const userTarget = KPI_TARGET_EXCLUDED.has(def.id)
            ? null
            : (getVisibleKpiTarget(kpis.targets, def.id)?.value ?? null);
          const tone = getKpiToneWithTarget(def.id, v.actual, kpis.input, userTarget);
          const trend = getKpiTrend(def.id, v);
          const cardTarget = routeAllowed(def, def.analyseRoute) ? drilldownUrl(def.analyseRoute) : null;
          const incompleteHint = v.actual === null ? getKpiIncompleteHint(def.id, kpis.input) : null;
          const info = [
            def.beschreibung,
            trend
              ? `Trend ${fmtTrendLabel(trend)} (Anzeige-Ableitung auf Rohwerten).`
              : 'Kein Trend: Budget- und Vorjahreswert fehlen.',
            userTarget !== null
              ? `Betriebs-Zielwert: ${getKpiZielRichtung(def.id) === 'mindestens' ? 'mind.' : 'max.'} ${fmtValue(def, userTarget)} — Ampel: erreicht = grün, verfehlt = orange.`
              : null,
            incompleteHint ? `Unvollständig: ${incompleteHint}` : null,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <KpiCard
              key={def.id}
              label={def.name}
              value={
                incompleteHint ? (
                  <span title={incompleteHint} data-testid={`mgmt-kpi-card-${def.id}-incomplete`}>
                    {DASH}
                  </span>
                ) : (
                  fmtValue(def, v.actual)
                )
              }
              tone={toTone(tone)}
              trend={
                trend
                  ? { direction: trend.direction, tone: trend.tone, label: fmtTrendLabel(trend) }
                  : undefined
              }
              info={info}
              onClick={cardTarget ? () => navigate(cardTarget) : undefined}
              sub={
                def.hatBudgetVj
                  ? `Budget ${fmtValue(def, v.budget)} · VJ ${fmtValue(def, v.priorYear)}`
                  : `VJ ${fmtValue(def, v.priorYear)}`
              }
              data-testid={`mgmt-kpi-card-${def.id}`}
            />
          );
        })}
      </KpiGrid>

      {/* Alle weiteren KPIs — Tabelle IST/Budget/VJ/Abw./Quelle/Links/Kommentar */}
      <MoreKpis label="Alle Management-KPIs" storageKey="mgmtKpiTableOpen">
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">KPI</th>
                <th className="px-3 py-1.5 text-right font-medium">IST</th>
                <th className="px-3 py-1.5 text-right font-medium">Budget</th>
                <th className="px-3 py-1.5 text-right font-medium">Vorjahr</th>
                <th className="px-3 py-1.5 text-right font-medium">Abw. Budget</th>
                <th className="px-3 py-1.5 text-left font-medium">Quelle</th>
                <th className="px-3 py-1.5 text-left font-medium">Vertiefung</th>
                <th className="px-3 py-1.5 text-left font-medium">Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {[...cards, ...tableDefs].map(def => {
                const v = getKpiValues(def.id, kpis.input);
                const userTarget = KPI_TARGET_EXCLUDED.has(def.id)
                  ? null
                  : (getVisibleKpiTarget(kpis.targets, def.id)?.value ?? null);
                const tone = getKpiToneWithTarget(def.id, v.actual, kpis.input, userTarget);
                const abw = v.actual !== null && v.budget !== null ? v.actual - v.budget : null;
                const comment = getVisibleKpiComment(kpis.comments, kpis.monthKey, def.id);
                const incompleteHint = v.actual === null ? getKpiIncompleteHint(def.id, kpis.input) : null;
                return (
                  <tr
                    key={def.id}
                    className="border-b border-border/60 last:border-0 align-top"
                    data-testid={`mgmt-kpi-row-${def.id}`}
                  >
                    <td className="px-3 py-1.5 text-left font-medium">{def.name}</td>
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right font-medium tabular-nums',
                        tone !== 'neutral' && tone !== 'good' && TONE_TEXT[toTone(tone)],
                      )}
                      title={incompleteHint ?? undefined}
                      data-testid={`mgmt-kpi-${def.id}-actual`}
                    >
                      {fmtValue(def, v.actual)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {def.hatBudgetVj ? fmtValue(def, v.budget) : DASH}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtValue(def, v.priorYear)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {def.hatBudgetVj ? fmtAbw(def, abw) : DASH}
                    </td>
                    <td className="px-3 py-1.5 text-left text-muted-foreground">
                      {KPI_QUELLE_LABEL[def.quelle]}
                    </td>
                    <td className="px-3 py-1.5 text-left">
                      <div className="flex flex-wrap gap-2">{linkCell(def)}</div>
                    </td>
                    <td className="px-3 py-1.5 text-left">
                      <div className="flex items-start gap-1.5">
                        {comment?.text && (
                          <span className="max-w-[220px] whitespace-pre-line text-muted-foreground">
                            {comment.text}
                          </span>
                        )}
                        {!isGuest && (
                          <button
                            type="button"
                            onClick={() => openComment(def)}
                            className="text-muted-foreground transition-colors hover:text-primary"
                            aria-label={`Kommentar zu ${def.name}`}
                            data-testid={`mgmt-kpi-comment-btn-${def.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </MoreKpis>

      {/* Definitionen-Dialog (fester KPI-Katalog, docs/kpi-inventar.md) */}
      <Dialog open={defsOpen} onOpenChange={setDefsOpen}>
        <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>KPI-Definitionen</DialogTitle>
            <DialogDescription>
              Fester KPI-Katalog (Ebene 1) — je Kennzahl GENAU EINE Definition und Quelle.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {KPI_CATALOG.map(def => (
              <div key={def.id} className="rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{def.name}</p>
                <p className="text-xs text-muted-foreground">{def.beschreibung}</p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Formel</dt>
                    <dd className="text-muted-foreground">{def.formel}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Datenquelle</dt>
                    <dd className="text-muted-foreground">{def.datenquelle}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Aktualisierung</dt>
                    <dd className="text-muted-foreground">{def.aktualisierung}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Verantwortlich</dt>
                    <dd className="text-muted-foreground">{def.verantwortlich}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Ziel / Warnung / Kritisch</dt>
                    <dd className="text-muted-foreground">
                      {def.zielText ?? DASH} / {def.warnText ?? DASH} / {def.kritischText ?? DASH}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Kommentar-Dialog (Monat × KPI; leer speichern = Kommentar entfernen) */}
      <Dialog open={commentDef !== null} onOpenChange={open => !open && setCommentDef(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Kommentar · {commentDef?.name} · {monthLabel}
            </DialogTitle>
            <DialogDescription>
              Monatskommentar zur Kennzahl (erscheint im Geschäftsleitungs-Export). Leer speichern
              entfernt den Kommentar.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={commentDraft}
            onChange={e => setCommentDraft(e.target.value)}
            rows={4}
            placeholder="z. B. Umsatzrückgang wegen Betriebsferien KW 29 …"
            data-testid="mgmt-kpi-comment-input"
          />
          {commentError && <p className="text-xs text-red-600">{commentError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommentDef(null)} disabled={commentSaving}>
              Abbrechen
            </Button>
            <Button onClick={() => void saveComment()} disabled={commentSaving} data-testid="mgmt-kpi-comment-save">
              {commentSaving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Anpassen-Dialog: KPI-Karten (max. 4, Reihenfolge) + Betriebs-Zielwerte */}
      <Dialog open={customizeOpen} onOpenChange={open => !open && setCustomizeOpen(false)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Management-KPIs anpassen</DialogTitle>
            <DialogDescription>
              Bis zu {MAX_KPI_CARDS} KPI-Karten wählen — alle übrigen KPIs bleiben in der Tabelle
              «Alle Management-KPIs». Zielwerte gelten für den ganzen Betrieb und wirken nur auf
              die Ampel (erreicht = grün, verfehlt = orange); leer = Standard-Ampel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div>
              <p className="mb-1.5 text-sm font-semibold">
                KPI-Karten ({draftCards.length}/{MAX_KPI_CARDS})
              </p>
              <div className="space-y-0.5">
                {draftCards.map((id, idx) => {
                  const def = KPI_CATALOG.find(d => d.id === id);
                  if (!def) return null;
                  return (
                    <div
                      key={id}
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1"
                      data-testid={`kpi-card-pick-${id}`}
                    >
                      <Checkbox checked onCheckedChange={() => toggleDraftCard(id)} id={`card-${id}`} />
                      <label htmlFor={`card-${id}`} className="flex-1 cursor-pointer text-xs font-medium">
                        {idx + 1}. {def.name}
                      </label>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={idx === 0}
                        onClick={() => setDraftCards(c => moveItem(c, idx, -1))}
                        aria-label={`${def.name} nach oben`}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={idx === draftCards.length - 1}
                        onClick={() => setDraftCards(c => moveItem(c, idx, 1))}
                        aria-label={`${def.name} nach unten`}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
                <div className="grid gap-x-4 pt-1 sm:grid-cols-2">
                  {KPI_CATALOG.filter(d => !draftCards.includes(d.id)).map(def => (
                    <div key={def.id} className="flex items-center gap-2 px-2 py-0.5">
                      <Checkbox
                        checked={false}
                        disabled={draftCards.length >= MAX_KPI_CARDS}
                        onCheckedChange={() => toggleDraftCard(def.id)}
                        id={`card-${def.id}`}
                      />
                      <label
                        htmlFor={`card-${def.id}`}
                        className={cn(
                          'flex-1 cursor-pointer text-xs',
                          draftCards.length >= MAX_KPI_CARDS && 'cursor-default text-muted-foreground',
                        )}
                      >
                        {def.name}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Zielwerte (für den ganzen Betrieb)</p>
              <p className="mb-2 text-xs text-muted-foreground">
                Rohwert in der Einheit der KPI (CHF, %, Anzahl); gilt für alle Benutzer dieses
                Betriebs. Die Ziel-Personalquote wird weiterhin zentral im Budget gepflegt und
                ist hier bewusst nicht änderbar.
              </p>
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {KPI_CATALOG.filter(d => !KPI_TARGET_EXCLUDED.has(d.id)).map(def => (
                  <div key={def.id} className="flex items-center gap-2">
                    <span className="w-40 shrink-0 truncate text-xs" title={def.name}>
                      {def.name}
                    </span>
                    <span className="w-9 shrink-0 text-right text-[10px] text-muted-foreground">
                      {getKpiZielRichtung(def.id) === 'mindestens' ? 'mind.' : 'max.'}
                    </span>
                    <Input
                      value={draftTargets[def.id] ?? ''}
                      onChange={e => setDraftTargets(t => ({ ...t, [def.id]: e.target.value }))}
                      className="h-7 text-right text-xs tabular-nums"
                      placeholder={def.einheit === 'pct' ? '%' : def.einheit === 'anzahl' ? 'Anzahl' : 'CHF'}
                      inputMode="decimal"
                      data-testid={`kpi-target-input-${def.id}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          {customizeError && <p className="text-xs text-red-600">{customizeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomizeOpen(false)} disabled={customizeSaving}>
              Abbrechen
            </Button>
            <Button
              onClick={() => void saveCustomize()}
              disabled={customizeSaving}
              data-testid="mgmt-kpi-customize-save"
            >
              {customizeSaving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
