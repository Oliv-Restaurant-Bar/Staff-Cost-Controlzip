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
import { supabase } from '@/integrations/supabase/client';

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

// ── Ø-Bon Restaurant (ohne Take Away) — nur Mandanten MIT TA (Oliv) ──────────

export interface RestaurantBonStats {
  /** Gepaarte Tage (wie BonStats.tage). */
  tage: number;
  /** Σ Bons − Σ TA-Artikel (1 TA-Artikel = 1 Bon = 1 Gast). */
  restBons: number;
  /** Σ Umsatz «Gesamt» − Σ TA-Umsatz über die gepaarten Tage. */
  restBrutto: number;
  /** Gewichtet: restBrutto ÷ restBons; null wenn nicht berechenbar (nie ÷0). */
  avgBonRest: number | null;
}

/**
 * Restaurant-Ø-Bon ohne Take Away, GEWICHTET über die gepaarten Tage
 * (dieselbe Paarung wie berechneBonStats):
 *   (Σ Brutto − Σ TA-Umsatz) ÷ (Σ Bons − Σ TA-Artikel)
 * TA-Artikel-Regel: 1 Artikel = 1 Bon = 1 Gast. Ohne TA-Artikel-Daten im
 * Zeitraum → null (leer statt 0, nie durch 0).
 */
export function berechneRestaurantBonStats(
  avgDaily: Record<string, number>,
  bruttoDaily: Record<string, number>,
  taUmsatzDaily: Record<string, number>,
  taBonsDaily: Record<string, number>,
  fromIso: string,
  toIso: string,
): RestaurantBonStats {
  let tage = 0, bons = 0, brutto = 0, taU = 0, taB = 0, hatTaBons = false;
  for (const [date, avg] of Object.entries(avgDaily)) {
    if (date < fromIso || date > toIso || !(avg > 0)) continue;
    const g = bruttoDaily[date] ?? 0;
    if (!(g > 0)) continue;
    tage++;
    bons += Math.round(g / avg);
    brutto += g;
    const u = taUmsatzDaily[date] ?? 0;
    if (u > 0) taU += u;
    const b = taBonsDaily[date] ?? 0;
    if (b > 0) { taB += b; hatTaBons = true; }
  }
  const restBons = bons - taB;
  const restBrutto = r2(brutto - taU);
  // Ohne TA-Artikel-Daten wäre das Resultat identisch mit dem Gesamt-Ø-Bon
  // abzüglich TA-Umsatz — irreführend. Dann leer lassen.
  const avgBonRest = hatTaBons && restBons > 0 && restBrutto > 0
    ? r2(restBrutto / restBons)
    : null;
  return { tage, restBons, restBrutto, avgBonRest };
}

/** TA-Artikel-Erkennung: Name endet auf « TA» oder enthält Take Away/TakeAway. */
export function isTaArtikel(name: string): boolean {
  return name.endsWith(' TA') || /take\s*-?\s*away/i.test(name);
}

/**
 * TA-Umsatz («Take Away»-Zeile) je Tag eines Zeitraums, mandantengetrennt —
 * aus dem Ist-Store (dailyBudgets via ladeUmsatzTage).
 */
export async function ladeTaUmsatzTage(
  tenantId: TenantId,
  fromIso: string,
  toIso: string,
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const tage = await ladeUmsatzTage(tenantId, fromIso, toIso);
  for (const [date, tag] of tage) {
    if (tag.takeAwayBrutto > 0) map[date] = tag.takeAwayBrutto;
  }
  return map;
}

/**
 * TA-Artikelmengen je Tag aus product_sales (Verkaufsdaten-Import),
 * mandantengetrennt. 1 Artikel = 1 Bon = 1 Gast. Server-seitig vorgefiltert
 * (Namensmuster), client-seitig exakt via isTaArtikel; paginiert (PostgREST
 * kappt unsortierte Abfragen bei ~1000 Zeilen).
 */
export async function ladeTaBonsTage(
  tenantId: TenantId,
  fromIso: string,
  toIso: string,
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('product_sales')
      .select('sale_date, quantity, product_name')
      .eq('restaurant_id', tenantId)
      .gte('sale_date', fromIso)
      .lte('sale_date', toIso)
      // «*take*away*» ist bewusst BREITER als isTaArtikel (beliebige Zeichen
      // dazwischen) — der exakte Client-Filter engt ein. Nie umgekehrt!
      .or('product_name.like."* TA",product_name.ilike.*take*away*')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`TA-Artikel laden fehlgeschlagen: ${error.message}`);
    for (const row of data ?? []) {
      const name = String(row.product_name ?? '');
      const qty = Number(row.quantity ?? 0);
      const date = String(row.sale_date ?? '');
      if (!date || !(qty > 0) || !isTaArtikel(name)) continue;
      map[date] = (map[date] ?? 0) + qty;
    }
    if (!data || data.length < PAGE) break;
  }
  return map;
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
