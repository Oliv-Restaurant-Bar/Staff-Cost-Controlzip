/**
 * vj-daily-transfer.ts
 * ====================
 * REINE Logik für die kontrollierte Übernahme von vj_daily-Tageswerten
 * (Gastronovi-Bruttoumsätze pro Tag) in die Erfolgsrechnungs-Monate
 * (reporting_v1) — DOM- und Supabase-frei, nur Typ-Importe.
 *
 * Fachliches Mapping (fixiert):
 *   grossRevenueManual = Σ Tagesbrutto des Monats (präziser Rohwert)
 *   revenueActual      = MwSt-Split: Take-Away-Brutto ÷ 1.026 (2.6 %),
 *                        übriger Umsatz ÷ 1.081 (8.1 %) — via grossToNet
 *                        (Sätze konfigurierbar, mwst.ts).
 *   Hat ein Monat KEINE Take-Away-Daten (kein Tag mit takeawayRevenue-Feld),
 *   wird 8.1 % pauschal gerechnet und der Monat als taSplit=false markiert —
 *   die UI kennzeichnet das sichtbar («ohne TA-Split, 8.1 % pauschal»).
 *   Beaulieu hat kein Take Away → dort greift dadurch durchgehend 8.1 %.
 *   takeAwayGrossManual bleibt UNBERÜHRT.
 *
 * grossToNet ist linear in beiden Anteilen, daher ist grossToNet(Σ, ΣTA)
 * identisch mit Σ grossToNet(Tag, TA-Tag) — dieselbe Basis wie umsatz.ts.
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
  /** Σ Take-Away-Brutto des Monats (0 wenn keine TA-Daten) */
  takeawayTotal: number;
  /** true = mind. ein Tag des Monats hat Take-Away-Daten → Netto mit TA-Split (2.6 %/8.1 %); false = 8.1 % pauschal */
  taSplit: boolean;
  /** Anzahl Tage mit Take-Away-Daten (taDayCount < dayCount ⇒ Split unvollständig — Tage ohne Feld zählen als Standard-Umsatz) */
  taDayCount: number;
  /** Netto-Rohwert (CHF exkl. MwSt): grossToNet(grossTotal, takeawayTotal) bzw. pauschal bei taSplit=false */
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
  const byMonth = new Map<number, { dayCount: number; grossTotal: number; takeawayTotal: number; taDayCount: number }>();
  for (const [date, rec] of Object.entries(vjDays)) {
    if (!date.startsWith(`${year}-`)) continue;
    const m = parseInt(date.slice(5, 7), 10);
    if (!(m >= 1 && m <= 12)) continue;
    const agg = byMonth.get(m) ?? { dayCount: 0, grossTotal: 0, takeawayTotal: 0, taDayCount: 0 };
    agg.dayCount += 1;
    agg.grossTotal += typeof rec.actualRevenue === 'number' && isFinite(rec.actualRevenue)
      ? rec.actualRevenue
      : 0;
    // Take-Away-Split: nur Tage mit vorhandenem, endlichem takeawayRevenue-Feld
    // zählen als TA-Daten (alte Records ohne Feld = keine Aufteilung bekannt).
    if (typeof rec.takeawayRevenue === 'number' && isFinite(rec.takeawayRevenue) && rec.takeawayRevenue >= 0) {
      agg.taDayCount += 1;
      agg.takeawayTotal += rec.takeawayRevenue;
    }
    byMonth.set(m, agg);
  }

  const existingByMonth = new Map<number, Pick<MonthlyFinancialRecord, 'month' | 'grossRevenueManual' | 'revenueActual'>>();
  for (const rec of existingMonths) existingByMonth.set(rec.month, rec);

  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const agg = byMonth.get(month) ?? { dayCount: 0, grossTotal: 0, takeawayTotal: 0, taDayCount: 0 };
    const existing = existingByMonth.get(month);
    const existingGross = existing?.grossRevenueManual;
    const existingNet   = existing?.revenueActual;
    const conflict = existingGross !== undefined || existingNet !== undefined;
    // TA-Split nur wenn der Monat TA-Daten hat; TA nie grösser als Gesamt.
    const taSplit = agg.taDayCount > 0;
    const taForNet = taSplit ? Math.min(agg.takeawayTotal, agg.grossTotal) : 0;
    return {
      month,
      monthId: `${year}-${String(month).padStart(2, '0')}`,
      dayCount: agg.dayCount,
      grossTotal: agg.grossTotal,
      takeawayTotal: agg.takeawayTotal,
      taSplit,
      taDayCount: agg.taDayCount,
      netTotal: grossToNet(agg.grossTotal, taForNet),
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
