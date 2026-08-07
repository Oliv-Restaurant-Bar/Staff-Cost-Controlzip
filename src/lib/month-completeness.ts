/**
 * Monats-Vollständigkeit für die Erfolgsrechnung (ER)
 * ====================================================
 *
 * REINE Logik — keine DOM-, Supabase- oder Storage-Zugriffe.
 *
 * Regel (Befehl 08/2026): Ein Monat zählt in Jahres-/Periodensummen,
 * Budget-Vergleich und Betriebsergebnis NUR, wenn BEIDE Seiten vorhanden
 * sind: Umsatz UND importierte Kosten. Monate mit nur einer Seite
 * (z. B. Umsatz ohne Kosten-Import — aktuell August 2026) gelten als
 * «unvollständig» und werden aus den Aggregaten ausgeklammert.
 * Monate ganz OHNE Daten bleiben wie bisher (tragen ohnehin keine
 * Ist-Werte bei; ihr Budget bleibt Teil des Jahresbudgets).
 *
 * Nachrichtliche Konten (Personal Aushilfe 5004/5005/5011): bleiben als
 * Zeile sichtbar, zählen aber NICHT in die Summen — sie sind nicht im
 * Infoniqa-Export enthalten und dürfen deshalb auch keinen Monat als
 * «Kosten vorhanden» qualifizieren.
 */

import type { MonthlyFinancialRecord } from '@/types/reporting';

/** Konten, die nur nachrichtlich geführt werden (nicht im Infoniqa-Export). */
export const NACHRICHTLICH_ACCOUNTS: ReadonlySet<string> = new Set(['5004', '5005', '5011']);

/** Normalisiert auf die kanonischen ersten 4 Stellen (App-Konvention). */
function norm4(acc: string | undefined): string {
  const s = (acc ?? '').trim();
  return s.length > 4 ? s.slice(0, 4) : s;
}

export function isNachrichtlichAccount(acc: string | undefined): boolean {
  return NACHRICHTLICH_ACCOUNTS.has(norm4(acc));
}

function accountNum(acc: string | undefined): number {
  return parseInt(norm4(acc));
}

export interface MonthCompleteness {
  /** Umsatz vorhanden (kanonischer revenueActual oder importierte 3xxx-Konten). */
  hasRevenue: boolean;
  /** Importierte Kosten vorhanden (Konten ≥ 4000, ohne nachrichtliche Konten). */
  hasCosts: boolean;
  /** Beide Seiten vorhanden. */
  complete: boolean;
  /** Genau EINE Seite vorhanden → «unvollständig» (grau, aus Summen ausgeklammert). */
  partial: boolean;
}

export function monthCompleteness(rec: MonthlyFinancialRecord | undefined): MonthCompleteness {
  const cats = rec?.expenseCategories ?? [];
  const hasRevenue =
    ((rec?.revenueActual ?? 0) !== 0) ||
    cats.some(c => {
      const n = accountNum(c.categoryId);
      return !isNaN(n) && n >= 3000 && n <= 3999 && (c.amount ?? 0) !== 0;
    });
  const hasCosts = cats.some(c => {
    const n = accountNum(c.categoryId);
    return !isNaN(n) && n >= 4000 && (c.amount ?? 0) !== 0 && !isNachrichtlichAccount(c.categoryId);
  });
  return {
    hasRevenue,
    hasCosts,
    complete: hasRevenue && hasCosts,
    partial: hasRevenue !== hasCosts,
  };
}
