/**
 * Konsistente Farben für FIX / FLEX / Budget über alle neuen Personalkosten-
 * Darstellungen (Balken, PKQ-Brücke, Verlaufsgrafik). Eine Definition = ein Ort.
 */
export const PK_COLORS = {
  /** FIX = Monatslöhne (stehen fest) — ruhiges Blau. */
  fix: 'hsl(217, 91%, 60%)',
  /** FLEX = Stundenlöhne — Teal/Grün-Blau. */
  flex: 'hsl(173, 58%, 45%)',
  /** Budget-Marker / Budget-Linie — Amber. */
  budget: 'hsl(38, 92%, 50%)',
  /** Ist-Linie (durchgezogen) — Primär/Indigo. */
  ist: 'hsl(243, 75%, 59%)',
  /** Plan-Hochrechnung (gestrichelt) — gedämpftes Grau-Blau. */
  plan: 'hsl(220, 15%, 55%)',
  good: 'hsl(142, 72%, 40%)',
  warn: 'hsl(38, 92%, 50%)',
  critical: 'hsl(0, 72%, 51%)',
} as const;
