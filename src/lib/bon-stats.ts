/**
 * bon-stats.ts — Anzahl Bons & gewichteter Ø-Bon aus Durchschnittsbon-Tageswerten
 * ===============================================================================
 * Quellen (beide bestehen bereits, hier wird NUR abgeleitet — kein eigener Store):
 *   - avgcheck-daily (gaeste-store): Durchschnittsbon CHF pro Tag (Gastronovi-
 *     «Durchschnitt»-Export, brutto pro Bon)
 *   - Umsatz «Gesamt» brutto pro Tag: laufendes Jahr aus dailyBudgets
 *     (ladeUmsatzTage), abgeschlossene Jahre aus vj_daily (actualRevenue)
 *
 * Regeln (fix):
 *   - anzahl_bons(Tag) = round(UmsatzBrutto(Tag) ÷ durchschnittsbon(Tag)),
 *     NUR wenn beide Werte > 0 — nie durch 0, leer statt 0.
 *   - Jahres-Ø-Bon = Σ UmsatzBrutto(gepaarte Tage) ÷ Σ anzahl_bons — GEWICHTET,
 *     nie der Mittelwert der Tageswerte.
 *   - Sehr hohe Tages-Ø-Bons (Einzelrechnung/Event) sind KEIN Fehler — sie
 *     werden nur gekennzeichnet (markiert ab AUSREISSER_FAKTOR × Jahres-Ø).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { ladeUmsatzTage } from '@/lib/umsatz';
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Tages-Ø ab diesem Vielfachen des Jahres-Ø als «Event/Einzelbon» kennzeichnen. */
export const AUSREISSER_FAKTOR = 4;

export interface BonStats {
  /** Tage mit Durchschnittsbon UND Tagesumsatz (nur diese zählen). */
  tage: number;
  /** Σ anzahl_bons über die gepaarten Tage. */
  bons: number;
  /** Σ UmsatzBrutto der gepaarten Tage. */
  brutto: number;
  /** Gewichteter Ø-Bon = brutto ÷ bons; null wenn keine Bons (nie 0/÷0). */
  avgBon: number | null;
  /** Tage mit Durchschnittsbon, aber OHNE Tagesumsatz im Bestand (unpaarbar). */
  ohneUmsatz: number;
  /** Gekennzeichnete Ausreisser-Tage (Event/Einzelbon) — KEIN Fehler. */
  events: Array<{ date: string; avg: number }>;
}

/**
 * Bon-Statistik über einen Zeitraum: paart Durchschnittsbon-Tageswerte mit
 * Brutto-Tagesumsätzen. Leere/0-Werte werden übersprungen (nie durch 0 teilen,
 * nie 0 erfinden).
 */
export function berechneBonStats(
  avgDaily: Record<string, number>,
  bruttoDaily: Record<string, number>,
  fromIso: string,
  toIso: string,
): BonStats {
  let tage = 0, bons = 0, brutto = 0, ohneUmsatz = 0;
  const paare: Array<{ date: string; avg: number }> = [];
  for (const [date, avg] of Object.entries(avgDaily)) {
    if (date < fromIso || date > toIso || !(avg > 0)) continue;
    const g = bruttoDaily[date] ?? 0;
    if (!(g > 0)) { ohneUmsatz++; continue; }
    tage++;
    bons += Math.round(g / avg);
    brutto += g;
    paare.push({ date, avg });
  }
  const avgBon = bons > 0 ? r2(brutto / bons) : null;
  const events = avgBon != null
    ? paare.filter(p => p.avg >= avgBon * AUSREISSER_FAKTOR)
        .sort((a, b) => b.avg - a.avg)
    : [];
  return { tage, bons, brutto: r2(brutto), avgBon, ohneUmsatz, events };
}

/**
 * Brutto-Tagesumsätze («Gesamt»-Zeile) eines Jahres, mandantengetrennt.
 * Primär der kanonische Ist-Store (dailyBudgets via ladeUmsatzTage); ist er
 * fürs GANZE Jahr leer (abgeschlossene Jahre wie 2024/2025), Fallback auf
 * vj_daily.actualRevenue — dieselbe Kein-Mischen-Regel wie Cockpit/UA.
 */
export async function ladeBruttoTageJahr(
  tenantId: TenantId,
  year: number,
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const tage = await ladeUmsatzTage(tenantId, `${year}-01-01`, `${year}-12-31`);
  for (const [date, tag] of tage) {
    if (tag.gesamtBrutto > 0) map[date] = tag.gesamtBrutto;
  }
  if (Object.keys(map).length > 0) return map;
  const vj = await loadVjDailyYear(year, tenantId);
  for (const [date, rec] of Object.entries(vj)) {
    const g = Number(rec?.actualRevenue ?? 0);
    if (g > 0) map[date] = g;
  }
  return map;
}
