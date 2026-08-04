/**
 * E009 — Reine Spalten-Logik für die Budget-P&L-Tabelle (Erfolgsrechnung).
 *
 * Zentrale, DOM- und Supabase-freie Ableitung der sichtbaren Spalten:
 * - Desktop: Sichtbarkeit rein aus dem Vergleichsmodus (unverändert zur bisherigen Logik).
 * - Mobil (reduzierte Tabelle): genau EINE Vergleichsbasis (Budget vor Vorjahr)
 *   und keine %-Spalten — keine horizontale Volltabelle.
 *
 * Reine Anzeige-Logik: es wird NICHTS berechnet, nur Sichtbarkeit abgeleitet (E011).
 */

export type BPLCompareMode = 'all' | 'ist_budget' | 'ist_vorjahr' | 'monat_vs_monat';
export type BPLPctMode = 'off' | 'normal' | 'subtle';

export interface BPLColumnVisibility {
  showBudget: boolean;
  showPrevYear: boolean;
  pctMode: BPLPctMode;
}

export function getBPLColumnVisibility(
  compareMode: BPLCompareMode,
  pctMode: BPLPctMode,
  isMobile: boolean,
): BPLColumnVisibility {
  const showBudget   = compareMode !== 'ist_vorjahr' && compareMode !== 'monat_vs_monat';
  const showPrevYear = compareMode !== 'ist_budget';

  if (!isMobile) {
    return { showBudget, showPrevYear, pctMode };
  }

  // Mobil: reduzierte Tabelle — Budget-Vergleich hat Vorrang; ist Budget
  // ausgeblendet (ist_vorjahr / monat_vs_monat), bleibt der Vorjahres-/
  // Monatsvergleich als einzige Vergleichsbasis erhalten.
  return {
    showBudget,
    showPrevYear: showBudget ? false : showPrevYear,
    pctMode: 'off',
  };
}
