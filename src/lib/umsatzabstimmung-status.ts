/**
 * umsatzabstimmung-status.ts — Reine Statuslogik der Monatsabstimmung Umsatz.
 * ===========================================================================
 * SSoT-UMZUG (keine neue Berechnung): `getUmsatzRowStatus` und die
 * Tagessummen-Berechnung stammen 1:1 aus UmsatzAbstimmung.tsx und werden von
 * dort weiterhin konsumiert. Zusätzlich nutzt die Startseiten-Monatsübersicht
 * dieselbe Logik REIN LESEND (T507) — keine zweite Abstimmungsberechnung.
 *
 * DOM-/Supabase-frei: Blobs werden als bereits geparste Records übergeben.
 */

export type UmsatzRowStatus = 'ok' | 'warning' | 'error' | 'missing';

/**
 * Zeilenstatus der Monatsabstimmung (unverändert aus UmsatzAbstimmung.tsx):
 * kein manueller Wert → warning (Tage vorhanden) bzw. missing (nichts),
 * keine Tagessumme → warning, sonst Differenz-Ampel <1 % ok / <3 % warning /
 * sonst error.
 */
export function getUmsatzRowStatus(manual: number | undefined, daily: number): UmsatzRowStatus {
  if (!manual || manual <= 0) return daily > 0 ? 'warning' : 'missing';
  if (daily <= 0) return 'warning';
  const pct = Math.abs(manual - daily) / manual;
  if (pct < 0.01) return 'ok';
  if (pct < 0.03) return 'warning';
  return 'error';
}

/**
 * Brutto-Tagessumme eines Monats aus dem (geparsten) dailyBudgets-Blob.
 * Identische Semantik wie die bisherige localStorage-Leselogik der
 * Abstimmungstabelle: nur Schlüssel `yyyy-MM-…` des Zielmonats, Summe der
 * `actualRevenue`-Werte. Keine Einträge → 0 (der AUFRUFER unterscheidet
 * «keine Einträge» sichtbar von einer echten 0 — fehlend ≠ 0).
 */
export function sumDailyGrossForMonth(
  blob: Record<string, unknown>,
  year: number,
  month: number,
): number {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return Object.entries(blob)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((sum, [, v]) => {
      const rev = (v as { actualRevenue?: unknown } | null)?.actualRevenue;
      return sum + (typeof rev === 'number' ? rev : 0);
    }, 0);
}

// ── Jahresauswahl + Deep-Link (reine Helfer der Umsatzabstimmungs-Seite) ─────

/**
 * Deep-Link ?year=YYYY: nur plausible vierstellige Jahre (2000–2100)
 * akzeptieren, alles andere ignorieren (null → Aufrufer nutzt Default).
 */
export function parseUmsatzYearParam(raw: string | null): number | null {
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  return y >= 2000 && y <= 2100 ? y : null;
}

/**
 * Jahresfenster der Umsatzabstimmung: Jahre mit Daten ∪ [aktuelles Jahr … −2]
 * ∪ aktuell gewähltes Jahr, absteigend sortiert. Damit ist 2024 (aktuelles
 * Jahr −2) auch OHNE vorhandene Daten wählbar — leere Jahre zeigen den
 * sichtbaren Leerzustand statt gar nicht zu erscheinen (fehlend ≠ 0).
 */
export function buildUmsatzYearOptions(
  yearsWithData: readonly number[],
  currentYear: number,
  selectedYear: number,
): number[] {
  return Array.from(
    new Set([...yearsWithData, currentYear, currentYear - 1, currentYear - 2, selectedYear]),
  ).sort((a, b) => b - a);
}

// ── Monats-Kurzstatus für die Startseiten-Monatsübersicht (read-only) ────────

export type UmsatzMonthStatus = UmsatzRowStatus | 'not_due';

export interface UmsatzMonthSummary {
  status: UmsatzMonthStatus;
  /** Kurzer deutscher Anzeigetext für die Monatsübersicht. */
  text: string;
}

/** Ton je Monats-Kurzstatus — kompatibel zur zentralen Farbsemantik. */
export const UMSATZ_MONTH_TONE: Record<UmsatzMonthStatus, 'good' | 'warn' | 'neutral' | 'critical'> = {
  ok: 'good',
  warning: 'warn',
  error: 'critical',
  missing: 'neutral',
  not_due: 'neutral',
};

/**
 * Kurzbeschreibung eines Abstimmungsmonats — reine Umformatierung des
 * bestehenden Zeilenstatus (getUmsatzRowStatus), KEINE eigene Schwellenlogik.
 * Zukunftsmonate werden nie als fehlend bewertet («Noch nicht fällig»).
 */
export function describeUmsatzMonth(
  manual: number | undefined,
  daily: number,
  isFutureMonth: boolean,
): UmsatzMonthSummary {
  if (isFutureMonth) return { status: 'not_due', text: 'Noch nicht fällig' };
  const status = getUmsatzRowStatus(manual, daily);
  const hasManual = (manual ?? 0) > 0;
  switch (status) {
    case 'ok':
      return { status, text: 'Abgestimmt (Differenz < 1 %)' };
    case 'error':
      return { status, text: 'Abweichung > 3 % — prüfen' };
    case 'missing':
      return { status, text: 'Quelldaten fehlen' };
    case 'warning':
    default:
      if (!hasManual) return { status: 'warning', text: 'Abstimmung noch nicht durchgeführt' };
      if (daily <= 0) return { status: 'warning', text: 'Tageseinträge fehlen' };
      return { status: 'warning', text: 'Abweichung 1–3 % — prüfen' };
  }
}
