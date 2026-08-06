import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { saveMonth, clearManualUmsatzField } from '@/lib/reporting-store';
import { getLockStateStrict } from '@/lib/prior-year-lock';
import { toast } from 'sonner';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_DE } from '@/types/reporting';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, XCircle, Scale, ArrowRight, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// Zeilenstatus + Tagessumme: zentrale SSoT-Logik (auch von der Startseiten-
// Monatsübersicht read-only konsumiert) — hier KEINE eigene Zweitberechnung.
import { getUmsatzRowStatus } from '@/lib/umsatzabstimmung-status';
import { countVjDailyYear, loadVjDailyYear } from '@/lib/vj-daily-supabase';
import { ladeUmsatzTage, mwstDivisorTakeaway, type UmsatzTag } from '@/lib/umsatz';
import { useTenant, type TenantId } from '@/contexts/TenantContext';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

/**
 * System-/gn-Seite der Abstimmung: Brutto-Monatssummen des Jahres aus den
 * kanonischen Umsatz-Tagen (src/lib/umsatz.ts → ladeUmsatzTage, Replace-
 * Semantik der Tages-Z-Berichte). Tage ohne Import fehlen und werden NIE als 0
 * gezählt; ein Monat ohne jeden Import gilt als «keine Daten» (hasImport=false).
 */
interface GnMonthGross {
  /** Brutto-Summe (gesamtBrutto) der importierten Tage des Monats */
  gross: number;
  /** true, sobald mindestens ein Tages-Import im Monat existiert */
  hasImport: boolean;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Aggregiert eine (Monats-)Umsatz-Tage-Map zu Brutto-Summe + Import-Flag. */
function aggregateMonth(tage: Map<string, UmsatzTag>): GnMonthGross {
  let gross = 0, hasImport = false;
  for (const tag of tage.values()) {
    gross += tag.gesamtBrutto;
    hasImport = true;
  }
  return { gross, hasImport };
}

/**
 * Lädt die 12 Monats-Brutto-Summen des Jahres via ladeUmsatzTage — MONATSWEISE
 * (gleicher, bewährter Aufrufpfad wie Monatsreport/Personalkosten). Bewusst NICHT
 * als ein einziger Jahres-Aufruf: dessen grosser gn_discounts-`.in(...)`-Batch
 * kann fehlschlagen und ladeUmsatzTage eine LEERE Map liefern lassen — dann
 * fehlten fälschlich alle «Summe Tage». Pro Monat bleiben die id-Mengen klein.
 */
async function ladeGnMonate(tenantId: TenantId, year: number): Promise<GnMonthGross[]> {
  const perMonth = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const from = `${year}-${pad2(m)}-01`;
      const to = `${year}-${pad2(m)}-${pad2(new Date(year, m, 0).getDate())}`;
      return ladeUmsatzTage(tenantId, from, to).then(aggregateMonth);
    }),
  );
  return perMonth;
}

/** Herkunft der «Summe Tage»-Spalte. */
type DailySource = 'tage' | 'vj';

/**
 * FALLBACK für abgeschlossene Vorjahre: Monats-Brutto-Summen aus den
 * Jahres-Tageswerten (vj_daily, Jahres-Tagesimport/Umsatz-Excel, brutto
 * actualRevenue). Greift NUR, wenn der kanonische Tages-Store für das ganze
 * Jahr leer ist — so ist z. B. 2024/2025 abstimmbar, ohne Tages-Z-Berichte
 * nachzuladen. Mandantengetrennt (vj_daily-Keys sind tenant-präfixiert).
 * Tage ohne Wert fehlen weiterhin (nie 0); actualRevenue ≤ 0 zählt nicht als
 * Import («leer statt 0», gleiche Regel wie vjTagWerte).
 */
async function ladeVjMonate(tenantId: TenantId, year: number): Promise<GnMonthGross[]> {
  const recs = await loadVjDailyYear(year, tenantId);
  const months: GnMonthGross[] = Array.from({ length: 12 }, () => ({ gross: 0, hasImport: false }));
  for (const [date, rec] of Object.entries(recs)) {
    const gross = Number(rec?.actualRevenue ?? 0);
    if (!(gross > 0)) continue;
    const m = Number(date.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    months[m - 1].gross += gross;
    months[m - 1].hasImport = true;
  }
  return months;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(n);
}

function fmt2(n: number): string {
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtDiff(diff: number): string {
  return `${diff >= 0 ? '+' : ''}${fmt(diff)}`;
}

function parseInput(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/['']/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '—') return undefined;
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface UmsatzAbstimmungProps {
  year: number;
  months: MonthlyFinancialRecord[];
  dailyBudgetsKey: string;
  storeKey: string;
  onRefresh: () => void;
  maisonMonthlyNet?: number[];
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

type EditField = 'gross' | 'takeAway';

export function UmsatzAbstimmung({
  year, months, storeKey, onRefresh,
}: UmsatzAbstimmungProps) {
  const { tenantId } = useTenant();
  // Beaulieu: Abstimmung NUR «Bruttoumsatz (manuell)» vs «Summe Tage» —
  // keine Take-Away-Spalte (Header, Zellen, Total, Fusszeile). Oliv unverändert.
  const isBeaulieu = tenantId === 'beaulieu';
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving,  setSaving]  = useState<Record<string, boolean>>({});
  // Leeres Jahr: Tabelle erst nach explizitem Klick zeigen (kein irreführender
  // leerer Bericht, aber manuelle Ersterfassung bleibt möglich, T506).
  const [showEmptyTable, setShowEmptyTable] = useState(false);
  useEffect(() => { setShowEmptyTable(false); }, [year]);
  // T805: Im Leerzustand darauf hinweisen, wenn vj_daily-Tageswerte für das
  // Jahr existieren (read-only Count, Stale-Guard bei Jahr-/Tenant-Wechsel).
  const [vjDayCount, setVjDayCount] = useState<number | null>(null);
  useEffect(() => {
    let stale = false;
    setVjDayCount(null);
    countVjDailyYear(year, tenantId).then(n => { if (!stale) setVjDayCount(n); });
    return () => { stale = true; };
  }, [year, tenantId]);
  // System-/gn-Seite der Abstimmung: Brutto-Monatssummen des Jahres aus der
  // KANONISCHEN Umsatz-Quelle (src/lib/umsatz.ts → ladeUmsatzTage). Ersetzt die
  // frühere localStorage/vj_daily-IST-Quelle; Tage ohne Import fehlen (nie 0).
  // Stale-Guard bei Jahr-/Tenant-Wechsel.
  const [gnMonths, setGnMonths] = useState<GnMonthGross[]>(() =>
    Array.from({ length: 12 }, () => ({ gross: 0, hasImport: false })),
  );
  // Herkunft der «Summe Tage»-Werte: 'tage' = kanonischer Tages-Store,
  // 'vj' = Fallback Jahres-Tageswerte (vj_daily) für Vorjahre ohne Tagesimporte.
  const [dailySource, setDailySource] = useState<DailySource>('tage');
  // Generationszähler statt lokalem stale-Flag: auch überlappende Reloads
  // (store-synced) können so nie ein älteres Ergebnis über ein neueres schreiben.
  const gnLoadGen = useRef(0);
  const loadGnMonths = useCallback(() => {
    const gen = ++gnLoadGen.current;
    (async () => {
      let months = await ladeGnMonate(tenantId, year);
      let source: DailySource = 'tage';
      // Fallback NUR für Vorjahre und NUR wenn das ganze Jahr im Tages-Store
      // leer ist (kein Mischen der Quellen innerhalb eines Jahres).
      if (year < new Date().getFullYear() && !months.some(m => m.hasImport)) {
        const vj = await ladeVjMonate(tenantId, year);
        if (vj.some(m => m.hasImport)) { months = vj; source = 'vj'; }
      }
      if (gnLoadGen.current === gen) { setGnMonths(months); setDailySource(source); }
    })().catch(err => console.warn('[UMSATZABSTIMMUNG] Summe-Tage-Laden fehlgeschlagen:', err));
  }, [year, tenantId]);
  useEffect(() => {
    setGnMonths(Array.from({ length: 12 }, () => ({ gross: 0, hasImport: false })));
    setDailySource('tage');
    loadGnMonths();
    return () => { gnLoadGen.current++; };
  }, [loadGnMonths]);
  useEffect(() => {
    const refresh = () => loadGnMonths();
    window.addEventListener('store-synced', refresh);
    return () => window.removeEventListener('store-synced', refresh);
  }, [loadGnMonths]);

  const editKey = (month: number, field: EditField) => `${month}:${field}`;

  const handleBlur = useCallback(async (month: number, field: EditField) => {
    const key = editKey(month, field);
    const raw = editing[key];
    if (raw === undefined) return;
    setEditing(ed => { const n = { ...ed }; delete n[key]; return n; });

    const val = parseInput(raw);
    const rec = months.find(m => m.month === month);
    const existing = field === 'gross' ? rec?.grossRevenueManual : rec?.takeAwayGrossManual;
    if (val === existing) return;

    const saveKey = `${month}:${field}`;
    setSaving(s => ({ ...s, [saveKey]: true }));
    try {
      // Vorjahre sind KEINE Read-only-Hardzahlen für die manuelle Abstimmung —
      // nur ein ausdrücklich festgeschriebenes Jahr blockiert, mit klarer
      // Meldung. Lock IMMER frisch vor dem Write prüfen (fail-closed).
      if (year < new Date().getFullYear()) {
        try {
          const lock = await getLockStateStrict(tenantId, year);
          if (lock.locked) {
            toast.error(`Jahr ${year} ist festgeschrieben — zum Bearbeiten zuerst entsperren (Import-Center → Vorjahres-Sperre).`);
            return;
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Jahres-Sperre konnte nicht geprüft werden — nicht gespeichert.');
          return;
        }
      }
      const recField = field === 'gross' ? 'grossRevenueManual' as const : 'takeAwayGrossManual' as const;
      if (val === undefined) {
        // Leeres Feld = kein Wert (nie 0 erzwingen): Feld explizit löschen.
        clearManualUmsatzField(year, month, recField, storeKey);
      } else {
        saveMonth(
          { year, month, [recField]: val },
          'manual_entry',
          'update',
          { note: field === 'gross' ? 'Bruttoumsatz manuell' : 'Take Away Bruttoumsatz manuell' },
          storeKey,
        );
      }
      onRefresh();
    } finally {
      setSaving(s => { const n = { ...s }; delete n[saveKey]; return n; });
    }
  }, [editing, months, year, storeKey, onRefresh, tenantId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, month: number, field: EditField) => {
    const key = editKey(month, field);
    if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') setEditing(ed => { const n = { ...ed }; delete n[key]; return n; });
  };

  // System-/gn-Tageswerte (Brutto) pro Monat, direkt aus ladeUmsatzTage.
  const dailySums = gnMonths.map(g => g.gross);
  const hasGn     = gnMonths.some(g => g.hasImport);

  // Datenlage des Jahres — GN-Z-Berichte zählen mit (vorher wurde ein Jahr mit
  // NUR Gastronovi-Daten fälschlich als komplett leer behandelt).
  const hasAnyData = months.some(m =>
    (m.grossRevenueManual ?? 0) > 0 ||
    (m.takeAwayGrossManual ?? 0) > 0 ||
    gnMonths[m.month - 1]?.hasImport,
  ) || hasGn;

  // Kein stiller Leerzustand mehr (T506): Ohne jede Quelle zeigt die Seite
  // sichtbar an, WELCHE Datenquellen fehlen — inkl. Aktionen. Die manuelle
  // Eingabe bleibt per explizitem Klick möglich (kein Auto-Seeding: blosses
  // Öffnen/Anzeigen schreibt nichts, erst echte Eingaben speichern).
  if (!hasAnyData && !showEmptyTable) {
    return (
      <Card className="border-blue-200 dark:border-blue-800" data-testid="umsatzabstimmung-empty">
        <CardHeader className="pb-2 pt-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Monatsabstimmung Umsatz {year}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-sm text-muted-foreground">
            Für {year} liegen noch keine Abstimmungsdaten vor. Es fehlen alle drei Quellen:
          </p>
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Manuelle Monatswerte</strong> ({isBeaulieu ? 'Bruttoumsatz' : 'Bruttoumsatz / Take-Away'}) — hier unten erfassbar
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Tageseinträge</strong> aus der Tagesansicht —{' '}
                <Link to="/tagesansicht" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  Tagesansicht öffnen <ArrowRight className="h-3 w-3" />
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 flex-shrink-0" />
              <span>
                <strong>Gastronovi Z-Berichte</strong> —{' '}
                <Link to="/gastronovi-import" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  Z-Bericht importieren <ArrowRight className="h-3 w-3" />
                </Link>
              </span>
            </li>
          </ul>
          {(vjDayCount ?? 0) > 0 && (
            <p
              className="text-xs text-muted-foreground rounded border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/20 px-3 py-2"
              data-testid="umsatzabstimmung-vj-hint"
            >
              Hinweis: Für {year} sind <strong>{vjDayCount} Tageswerte aus dem Jahres-Tagesimport</strong>
              {' '}vorhanden — die Spalte «Summe Tage» fällt für Vorjahre automatisch auf diese
              Werte zurück, sobald die Abstimmung geöffnet wird. Die Jahres-Tageswerte können
              zudem im{' '}
              <Link to="/import" className="text-primary hover:underline inline-flex items-center gap-0.5">
                Import-Center <ArrowRight className="h-3 w-3" />
              </Link>{' '}
              unter «Vorjahres-Tagesumsatz» kontrolliert als Monats-Umsatz in die Erfolgsrechnung
              übernommen werden.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowEmptyTable(true)}
            data-testid="umsatzabstimmung-start-manual"
          >
            <PencilLine className="h-3.5 w-3.5 mr-1.5" />
            Manuelle Monatswerte für {year} erfassen
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Jahressummen — «Summe Tage» = System-/gn-Tageswerte (Brutto) aus ladeUmsatzTage.
  const totalManual   = months.reduce((s, m) => s + (m.grossRevenueManual   ?? 0), 0);
  const totalTakeAway = months.reduce((s, m) => s + (m.takeAwayGrossManual ?? 0), 0);
  const totalDaily    = dailySums.reduce((s, v) => s + v, 0);
  const totalDiff     = totalManual > 0 && totalDaily > 0 ? totalManual - totalDaily : undefined;

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Monatsabstimmung Umsatz {year}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {isBeaulieu
            ? 'Bruttoumsatz manuell eingeben und mit den Gastronovi-Tageswerten abgleichen. Differenz soll 0 sein.'
            : 'Bruttoumsatz (exkl. Maison) und Take-Away-Umsatz (2.6 % MwSt) manuell eingeben und mit den Gastronovi-Tageswerten abgleichen. Differenz soll 0 sein.'}
        </p>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className={cn('w-full text-xs border-collapse', isBeaulieu ? 'min-w-[500px]' : 'min-w-[620px]')}>
          <thead>
            <tr className="border-b-2 border-border text-muted-foreground">
              <th className="text-left py-2 px-2 font-semibold min-w-[68px]">Monat</th>
              <th className="text-right py-2 px-2 font-semibold min-w-[130px]">
                Bruttoumsatz
                <span className="block text-[10px] font-normal">manuell, exkl. Maison</span>
              </th>
              {!isBeaulieu && (
                <th className="text-right py-2 px-2 font-semibold min-w-[130px] text-orange-700 dark:text-orange-400">
                  Take Away
                  <span className="block text-[10px] font-normal">Brutto inkl. 2.6 % MwSt</span>
                </th>
              )}
              <th className="text-right py-2 px-2 font-semibold min-w-[120px] text-violet-700 dark:text-violet-400">
                Summe Tage
                <span className="block text-[10px] font-normal" data-testid="ua-daily-source-label">
                  {dailySource === 'vj' ? 'Jahres-Tageswerte (Vorjahr), Brutto' : 'Gastronovi Z-Bericht, Brutto'}
                </span>
              </th>
              <th className="text-right py-2 px-2 font-semibold min-w-[100px]">
                Differenz
                <span className="block text-[10px] font-normal">Manuell − Tage</span>
              </th>
              <th className="text-center py-2 px-2 font-semibold min-w-[50px]">OK?</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, idx) => {
              // «Summe Tage» = System-/gn-Tageswerte (Brutto) aus ladeUmsatzTage.
              // Monat ohne jeden Import → fehlt (nie 0 erfunden).
              const gnMonth     = gnMonths[m.month - 1];
              const hasDaily    = !!gnMonth?.hasImport;
              const daily       = hasDaily ? gnMonth.gross : 0;
              const manual      = m.grossRevenueManual;
              const takeAway    = m.takeAwayGrossManual;
              const hasManual   = (manual   ?? 0) > 0;
              const hasTakeAway = (takeAway ?? 0) > 0;

              // Take Away Netto & MwSt — Netto über die kanonische Konstante
              // (MWST_TAKEAWAY aus umsatz.ts), keine eigene /1.026-Rechnung.
              const taNet  = hasTakeAway ? (takeAway! / mwstDivisorTakeaway()) : 0;
              const taMwSt = hasTakeAway ? (takeAway! - taNet)         : 0;

              const status  = getUmsatzRowStatus(manual ?? undefined, daily);
              const diff    = hasManual && hasDaily ? (manual! - daily) : undefined;
              const diffPct = diff !== undefined && manual! > 0 ? Math.abs(diff) / manual! : undefined;

              const grossKey = editKey(m.month, 'gross');
              const taKey    = editKey(m.month, 'takeAway');
              const isEditingGross = editing[grossKey] !== undefined;
              const isEditingTA    = editing[taKey]    !== undefined;
              const isSavingGross  = !!saving[`${m.month}:gross`];
              const isSavingTA     = !!saving[`${m.month}:takeAway`];

              const grossInput = isEditingGross ? editing[grossKey] : (hasManual   ? fmt(manual!)   : '');
              const taInput    = isEditingTA    ? editing[taKey]    : (hasTakeAway ? fmt(takeAway!) : '');

              // WICHTIG: Auch Monate ohne jede Datenquelle bleiben EDITIERBAR
              // (manuelle Ersterfassung, insb. Vorjahre) — kein «keine Daten»-
              // Platzhalter mehr, der die Eingabe blockiert. Leere Monate sind
              // nur optisch gedimmt.
              const emptyRow = !hasManual && !hasTakeAway && !hasDaily;

              return (
                <tr
                  key={m.month}
                  className={cn(
                    'border-b border-border/40 hover:bg-muted/20',
                    idx % 2 === 1 && 'bg-muted/10',
                    emptyRow && 'opacity-60',
                  )}
                >
                  <td className="py-1.5 px-2 font-medium">{MONTH_NAMES_DE[m.month]}</td>

                  {/* Bruttoumsatz – editierbar */}
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      value={grossInput}
                      placeholder="eingeben…"
                      disabled={isSavingGross}
                      onFocus={e => setEditing(ed => ({ ...ed, [grossKey]: e.target.value }))}
                      onChange={e => setEditing(ed => ({ ...ed, [grossKey]: e.target.value }))}
                      onBlur={() => handleBlur(m.month, 'gross')}
                      onKeyDown={e => handleKeyDown(e, m.month, 'gross')}
                      className={cn(
                        'w-full text-right font-mono text-xs bg-transparent',
                        'border-b border-transparent hover:border-blue-300 dark:hover:border-blue-700',
                        'focus:border-blue-500 focus:outline-none px-1 py-0.5 rounded-sm',
                        'focus:bg-blue-50/80 dark:focus:bg-blue-950/30 transition-colors',
                        isSavingGross && 'opacity-40',
                        !hasManual && !isEditingGross && 'text-muted-foreground/50 italic',
                      )}
                    />
                  </td>

                  {/* Take Away – editierbar (nur Oliv; Beaulieu ohne Take-Away-Spalte) */}
                  {!isBeaulieu && (
                  <td className="py-1 px-2">
                    <input
                      type="text"
                      value={taInput}
                      placeholder="eingeben…"
                      disabled={isSavingTA}
                      onFocus={e => setEditing(ed => ({ ...ed, [taKey]: e.target.value }))}
                      onChange={e => setEditing(ed => ({ ...ed, [taKey]: e.target.value }))}
                      onBlur={() => handleBlur(m.month, 'takeAway')}
                      onKeyDown={e => handleKeyDown(e, m.month, 'takeAway')}
                      className={cn(
                        'w-full text-right font-mono text-xs bg-transparent',
                        'border-b border-transparent hover:border-orange-300 dark:hover:border-orange-700',
                        'focus:border-orange-500 focus:outline-none px-1 py-0.5 rounded-sm',
                        'focus:bg-orange-50/80 dark:focus:bg-orange-950/30 transition-colors',
                        isSavingTA && 'opacity-40',
                        !hasTakeAway && !isEditingTA && 'text-muted-foreground/50 italic',
                      )}
                    />
                    {hasTakeAway && (
                      <span className="block text-[10px] text-muted-foreground/50 text-right px-1 leading-tight">
                        Netto: {fmt2(taNet)} / MwSt: {fmt2(taMwSt)}
                      </span>
                    )}
                  </td>
                  )}

                  {/* Summe Tage Brutto = System-/gn-Tageswerte (ladeUmsatzTage) */}
                  <td className={cn(
                    'py-1.5 px-2 text-right font-mono text-violet-700 dark:text-violet-400',
                    !hasDaily && 'text-muted-foreground/40 italic',
                  )}>
                    {hasDaily ? fmt(daily) : '—'}
                  </td>

                  {/* Differenz Manuell − Tage */}
                  <td className={cn(
                    'py-1.5 px-2 text-right font-mono',
                    diff === undefined ? 'text-muted-foreground/30 italic' :
                    diffPct === undefined ? 'text-muted-foreground/30' :
                    diffPct < 0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                    diffPct < 0.01  ? 'text-emerald-600 dark:text-emerald-400' :
                    diffPct < 0.03  ? 'text-amber-600 dark:text-amber-400' :
                    'text-red-600',
                  )}>
                    {diff !== undefined ? (
                      <span>
                        {fmtDiff(diff)}
                        {diffPct !== undefined && diffPct > 0.001 && (
                          <span className="block text-[10px]">
                            {(diffPct * 100).toFixed(1)} %
                          </span>
                        )}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Status */}
                  <td className="py-1.5 px-2 text-center">
                    {status === 'ok'      && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mx-auto" title="Bruttoumsatz stimmt mit Tageseinträgen überein (< 1 % Diff.)" />}
                    {status === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mx-auto" title="Abweichung oder fehlende Eingabe" />}
                    {status === 'error'   && <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" title="Grosse Abweichung (> 3 %) — bitte prüfen" />}
                    {status === 'missing' && <span className="text-muted-foreground/30 text-[10px]">–</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>

          {/* Jahressummen-Zeile */}
          <tfoot>
            <tr className="border-t-2 border-border font-semibold bg-muted/30">
              <td className="py-2 px-2 text-xs">Total {year}</td>
              <td className="py-2 px-2 text-right font-mono text-xs">
                {totalManual > 0 ? fmt(totalManual) : '—'}
              </td>
              {!isBeaulieu && (
                <td className="py-2 px-2 text-right font-mono text-xs text-orange-700 dark:text-orange-400">
                  {totalTakeAway > 0 ? (
                    <span>
                      {fmt(totalTakeAway)}
                      <span className="block text-[10px] font-normal text-muted-foreground/50">
                        Netto: {fmt(totalTakeAway / mwstDivisorTakeaway())}
                      </span>
                    </span>
                  ) : '—'}
                </td>
              )}
              <td className="py-2 px-2 text-right font-mono text-xs text-violet-700 dark:text-violet-400">
                {totalDaily > 0 ? fmt(totalDaily) : '—'}
              </td>
              <td className={cn(
                'py-2 px-2 text-right font-mono text-xs',
                totalDiff === undefined ? 'text-muted-foreground/40' :
                Math.abs(totalDiff) / Math.max(totalManual, 1) < 0.01 ? 'text-emerald-600 dark:text-emerald-400' :
                Math.abs(totalDiff) / Math.max(totalManual, 1) < 0.03 ? 'text-amber-600 dark:text-amber-400' :
                'text-red-600',
              )}>
                {totalDiff !== undefined ? fmtDiff(totalDiff) : '—'}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="mt-2.5 px-1 flex flex-col gap-0.5 text-[10px] text-muted-foreground/60">
          <span><strong>Bruttoumsatz (manuell):</strong> Gesamtumsatz des Monats{isBeaulieu ? '' : ', exkl. Maison/Marketing'}, inkl. MwSt. Klick in Zelle zum Eingeben — in allen Jahren, auch Vorjahren. Leeres Feld = kein Wert.</span>
          {!isBeaulieu && (
            <span><strong>Take Away:</strong> Bruttoumsatz Takeaway, inkl. 2.6 % MwSt. Netto und MwSt-Betrag werden automatisch berechnet (÷ 1.026).</span>
          )}
          <span><strong>Summe Tage:</strong> Automatisch — Brutto-Summe der Tages-Z-Berichte des Monats (kanonische Umsatzquelle, Replace-Semantik). Für abgeschlossene Vorjahre ohne Tages-Z-Berichte wird automatisch auf die Jahres-Tageswerte (Jahres-Tagesimport/Umsatz-Excel) zurückgegriffen. Tage ohne Import werden nicht als 0 gewertet.</span>
          <span><strong>Differenz:</strong> Manuell minus Summe Tage — Ziel: 0. Grün &lt; 1 %, Gelb = 1–3 %, Rot &gt; 3 %.</span>
        </div>
      </CardContent>
    </Card>
  );
}
