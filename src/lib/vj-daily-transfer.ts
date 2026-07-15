/**
 * vj-daily-transfer.ts
 * ====================
 * REINE Logik für die kontrollierte Übernahme von vj_daily-Tageswerten
 * (Gastronovi-Bruttoumsätze pro Tag) in die Erfolgsrechnungs-Monate
 * (reporting_v1) — DOM- und Supabase-frei, nur Typ-Importe.
 *
 * Fachliches Mapping (fixiert):
 *   grossRevenueManual = Σ Tagesbrutto des Monats (präziser Rohwert)
 *   revenueActual      = grossToNet(Σ Brutto, 0)  → ÷ 1.081 (Standard-MwSt)
 *   takeAwayGrossManual bleibt UNBERÜHRT (kein Take-Away-Split in vj_daily)
 *
 * grossToNet ist linear bei takeaway=0, daher ist grossToNet(Σ) identisch
 * mit Σ grossToNet(Tag) — dieselbe Basis wie computeMonthlyVjNet.
 *
 * Grundsätze:
 *   - fehlend ≠ 0: Monate ohne Tageswerte (oder mit Summe 0) werden NIE
 *     angelegt/überschrieben — sie erscheinen als nicht übertragbar.
 *   - kein stilles Überschreiben: Monate mit bereits erfasstem Umsatz
 *     (grossRevenueManual ODER revenueActual gesetzt) sind Konflikte und
 *     werden nur nach expliziter Bestätigung überschrieben.
 *   - Rundung nur bei der Anzeige — hier ausschliesslich Rohwerte.
 */

import { grossToNet } from '@/types/personnel';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface VjTransferMonthPlan {
  /** 1–12 */
  month: number;
  /** "YYYY-MM" */
  monthId: string;
  /** Anzahl Tage mit vj_daily-Datensatz in diesem Monat */
  dayCount: number;
  /** Σ Tagesbrutto (Rohwert, CHF inkl. MwSt) */
  grossTotal: number;
  /** grossToNet(grossTotal, 0) — Rohwert (CHF exkl. MwSt) */
  netTotal: number;
  /** true = Monat hat Tage UND Summe > 0 → Übernahme-Kandidat */
  transferable: boolean;
  /** true = Zielmonat hat bereits Umsatzwerte (nur mit Bestätigung überschreiben) */
  conflict: boolean;
  /** Bestehender manueller Bruttoumsatz des Zielmonats (falls gesetzt) */
  existingGross?: number;
  /** Bestehender Netto-Umsatz (revenueActual) des Zielmonats (falls gesetzt) */
  existingNet?: number;
}

export interface VjTransferPayload {
  year: number;
  month: number;
  grossRevenueManual: number;
  revenueActual: number;
}

// ── Plan-Aufbau ───────────────────────────────────────────────────────────────

/**
 * Baut den Übernahme-Plan: aggregiert die vj_daily-Tageswerte des Jahres pro
 * Monat und gleicht sie gegen die bestehenden Erfolgsrechnungs-Monate ab.
 *
 * @param year           Zieljahr (z. B. 2024)
 * @param vjDays         vj_daily-Datensätze { "YYYY-MM-DD": VjDayRecord }
 * @param existingMonths bestehende reporting-Monate des Jahres (z. B. loadYear);
 *                       leere Monate (alles undefined) gelten als konfliktfrei
 * @returns 12 Einträge (Januar–Dezember), auch für Monate ohne Tageswerte
 */
export function buildVjTransferPlan(
  year: number,
  vjDays: Record<string, VjDayRecord>,
  existingMonths: Pick<MonthlyFinancialRecord, 'month' | 'grossRevenueManual' | 'revenueActual'>[],
): VjTransferMonthPlan[] {
  // Tageswerte pro Monat aggregieren — nur Schlüssel des Zieljahres
  const byMonth = new Map<number, { dayCount: number; grossTotal: number }>();
  for (const [date, rec] of Object.entries(vjDays)) {
    if (!date.startsWith(`${year}-`)) continue;
    const m = parseInt(date.slice(5, 7), 10);
    if (!(m >= 1 && m <= 12)) continue;
    const agg = byMonth.get(m) ?? { dayCount: 0, grossTotal: 0 };
    agg.dayCount += 1;
    agg.grossTotal += typeof rec.actualRevenue === 'number' && isFinite(rec.actualRevenue)
      ? rec.actualRevenue
      : 0;
    byMonth.set(m, agg);
  }

  const existingByMonth = new Map<number, Pick<MonthlyFinancialRecord, 'month' | 'grossRevenueManual' | 'revenueActual'>>();
  for (const rec of existingMonths) existingByMonth.set(rec.month, rec);

  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const agg = byMonth.get(month) ?? { dayCount: 0, grossTotal: 0 };
    const existing = existingByMonth.get(month);
    const existingGross = existing?.grossRevenueManual;
    const existingNet   = existing?.revenueActual;
    const conflict = existingGross !== undefined || existingNet !== undefined;
    return {
      month,
      monthId: `${year}-${String(month).padStart(2, '0')}`,
      dayCount: agg.dayCount,
      grossTotal: agg.grossTotal,
      netTotal: grossToNet(agg.grossTotal, 0),
      // fehlend ≠ 0: ohne Tage oder mit Summe 0 wird der Monat NIE angelegt
      transferable: agg.dayCount > 0 && agg.grossTotal > 0,
      conflict,
      ...(existingGross !== undefined ? { existingGross } : {}),
      ...(existingNet   !== undefined ? { existingNet }   : {}),
    };
  });
}

/**
 * Payload für saveMonth(…, 'vj_daily_transfer', 'update', …):
 * nur Umsatzfelder — alle anderen Monatsfelder bleiben durch den
 * update-Merge unangetastet (undefined wird ignoriert).
 */
export function buildVjTransferPayload(year: number, plan: VjTransferMonthPlan): VjTransferPayload {
  return {
    year,
    month: plan.month,
    grossRevenueManual: plan.grossTotal,
    revenueActual: plan.netTotal,
  };
}

/**
 * Auswahl-Logik für die Bestätigung: übertragen wird ein Monat, wenn er
 * übertragbar ist UND (kein Konflikt ODER explizit zum Überschreiben markiert).
 */
export function selectTransferMonths(
  plans: VjTransferMonthPlan[],
  overwriteMonths: ReadonlySet<number>,
): VjTransferMonthPlan[] {
  return plans.filter(p => p.transferable && (!p.conflict || overwriteMonths.has(p.month)));
}
