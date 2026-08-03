/**
 * vj-overlay.ts — Dynamische Vorjahres-Überlagerung (FELDWEISER Merge)
 * =====================================================================
 * Ist-Tage des Jahres −1 (umsatz.ts-SSOT, dailyBudgets) überlagern die
 * vj_daily-Records PRO FELD: hat das Jahr-−1-Ist für Food/Beverage/Take-Away
 * einen echten Wert (> 0), gewinnt er; fehlt er (0/leer/nicht erfasst),
 * bleibt der vj_daily-Wert des Tages erhalten. Ein blosser Gesamt-
 * Tagesumsatz überlagert/nullt die Kategorien-Werte also NIE.
 *
 * Nur mit gesamtBrutto > 0 aufrufen (sonst gar keine Überlagerung — der
 * unveränderte vj_daily-Record bleibt massgeblich). Reines Modul ohne
 * IO-Abhängigkeiten (testbar ohne Mocks).
 */

import type { UmsatzTag } from '@/lib/umsatz';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

export function istAlsVjRecord(
  date: string,
  tag: UmsatzTag,
  prev?: VjDayRecord,
): VjDayRecord {
  return {
    date,
    year: Number(date.slice(0, 4)),
    actualRevenue: tag.gesamtBrutto,
    ...(tag.foodBrutto > 0 ? { foodRevenue: tag.foodBrutto }
      : (prev?.foodRevenue ?? 0) > 0 ? { foodRevenue: prev!.foodRevenue } : {}),
    ...(tag.beverageBrutto > 0 ? { beverageRevenue: tag.beverageBrutto }
      : (prev?.beverageRevenue ?? 0) > 0 ? { beverageRevenue: prev!.beverageRevenue } : {}),
    ...(tag.takeAwayBrutto > 0 ? { takeawayRevenue: tag.takeAwayBrutto }
      : (prev?.takeawayRevenue ?? 0) > 0 ? { takeawayRevenue: prev!.takeawayRevenue } : {}),
    source: 'ist_vorjahr_dynamisch',
  };
}
