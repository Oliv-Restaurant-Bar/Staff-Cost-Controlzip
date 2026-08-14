/**
 * gaeste-derived.ts — «Gäste IN» ABGELEITET aus Umsatz ÷ Umsatz-pro-Person
 * =========================================================================
 * Spec 08/2026: Die getippte Personenzahl (Tisch-Eröffnung, gaeste-daily) ist
 * unzuverlässig (Beaulieu Aug 2026: 4'056 getippt vs. ~3'258 real, +24.5 %).
 * MASSGEBLICH für alle Kennzahlen ist deshalb die ABLEITUNG:
 *
 *   Gäste(Tag) = Brutto-Ist-Umsatz(Tag) ÷ UmsatzProPerson(Tag),
 *   kaufmännisch auf ganze Gäste gerundet.
 *
 * Schutzregeln (fix):
 *  - UmsatzProPerson(Tag) fehlt oder = 0 → Tag bleibt LEER (nie ÷ 0; ein Tag
 *    mit Umsatz, aber ohne pp, wird NICHT auf 0 gesetzt).
 *  - Fehlt die pp-Quelle ganz → «Gäste IN» bleibt leer; KEIN Rückfall auf den
 *    getippten Personen-Wert (gaeste-daily bleibt nur Referenz/Tooltip).
 *
 * Quellen:
 *  - umsatzprogast-daily (gaeste-store, tenant-präfixiert): CHF pro Person aus
 *    dem Gastronovi-Tagesexport «Durchschnitt» — NICHT der Durchschnittsbon!
 *  - IN-HOUSE-Brutto (Gesamt − Take Away): ladeInhouseBruttoTageJahr (laufendes Jahr aus
 *    dailyBudgets/umsatz-SSOT, abgeschlossene Jahre vj_daily).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { loadUmsatzProGastDaily } from '@/lib/gaeste-store';
import { ladeUmsatzTage } from '@/lib/umsatz';
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';

type KeyFn = (k: string) => string;

/**
 * IN-HOUSE-Brutto pro Tag eines Jahres: Gesamt-Brutto MINUS Take-Away-Brutto.
 * «Umsatz pro Person» ist eine In-House-Kennzahl — Take Away wird vor der
 * Gäste-Ableitung herausgerechnet (Beaulieu ohne TA: In-House = Total).
 * Laufendes Jahr aus dailyBudgets (umsatz-SSOT), Fallback vj_daily
 * (actualRevenue − takeawayRevenue) für abgeschlossene Jahre.
 */
export async function ladeInhouseBruttoTageJahr(
  tenantId: TenantId,
  year: number,
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  const tage = await ladeUmsatzTage(tenantId, `${year}-01-01`, `${year}-12-31`);
  for (const [date, tag] of tage) {
    const inhouse = tag.gesamtBrutto - (tag.takeAwayBrutto > 0 ? tag.takeAwayBrutto : 0);
    if (inhouse > 0) map[date] = inhouse;
  }
  if (Object.keys(map).length > 0) return map;
  const vj = await loadVjDailyYear(year, tenantId);
  for (const [date, rec] of Object.entries(vj)) {
    const g = Number(rec?.actualRevenue ?? 0) - Math.max(0, Number(rec?.takeawayRevenue ?? 0));
    if (g > 0) map[date] = g;
  }
  return map;
}

/**
 * Reine Ableitung: Tage mit pp>0 UND brutto>0 → round(brutto ÷ pp).
 * Alle anderen Tage fehlen im Ergebnis (leer statt 0).
 */
export function deriveGaesteDaily(
  ppDaily: Record<string, number>,
  bruttoDaily: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [date, pp] of Object.entries(ppDaily)) {
    if (!(pp > 0)) continue;
    const b = bruttoDaily[date] ?? 0;
    if (!(b > 0)) continue;
    const g = Math.round(b / pp);
    if (g > 0) out[date] = g;
  }
  return out;
}

/**
 * Lädt die ABGELEITETE Gäste-IN-Tagesreihe (Ersatz für loadGaesteDaily in
 * allen KPI-Konsumenten). Brutto wird nur für Jahre geladen, die pp-Daten
 * haben; Fehler eines Jahres lassen die übrigen Jahre intakt.
 */
export async function ladeGaesteInAbgeleitet(
  tenantId: TenantId,
  tenantKey: KeyFn,
): Promise<Record<string, number>> {
  let pp: Record<string, number> = {};
  try { pp = await loadUmsatzProGastDaily(tenantKey); } catch { return {}; }
  const years = [...new Set(Object.keys(pp).map(d => Number(d.slice(0, 4))))]
    .filter(y => Number.isFinite(y) && y > 2000);
  const out: Record<string, number> = {};
  for (const y of years.sort()) {
    try {
      const brutto = await ladeInhouseBruttoTageJahr(tenantId, y);
      const ppYear = Object.fromEntries(
        Object.entries(pp).filter(([d]) => d.startsWith(`${y}-`)));
      Object.assign(out, deriveGaesteDaily(ppYear, brutto));
    } catch { /* Jahr ohne lesbare Umsätze → dessen Tage bleiben leer */ }
  }
  return out;
}
