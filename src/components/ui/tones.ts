/**
 * Design-System Phase 3.1 — zentrale Farbtöne (Ampel-Semantik).
 *
 * Appweite Regel:
 *   good     = Grün   (alles in Ordnung / Ziel erreicht)
 *   warn     = Orange (Achtung / Abweichung, noch nicht kritisch)
 *   critical = Rot    (kritisch / Handlungsbedarf)
 *   info     = Blau   (neutraler Hinweis)
 *   neutral  = Grau   (keine Bewertung / keine Daten)
 *
 * Alle Bausteine (StatusPill, KpiCard, HintBox, …) nutzen dieselben Maps —
 * KEINE eigenen Farbklassen mehr in Seiten. Dark-Mode-Klassen sind überall
 * enthalten; Flächen mit Sticky-Verhalten müssen OPAKE Farben nutzen.
 */

export type Tone = 'good' | 'warn' | 'critical' | 'info' | 'neutral';

/** Kleiner Status-Punkt (Ampel). */
export const TONE_DOT: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500',
  info: 'bg-sky-500',
  neutral: 'bg-muted-foreground/40',
};

/** Textfarbe in Ton-Semantik (z. B. Differenzwerte). */
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  critical: 'text-red-700 dark:text-red-300',
  info: 'text-sky-700 dark:text-sky-300',
  neutral: 'text-muted-foreground',
};

/** Pill/Badge-Fläche (Rand + Hintergrund + Text). */
export const TONE_PILL: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  warn: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  critical:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  info: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  neutral: 'bg-muted text-muted-foreground border-border',
};

/** Hinweis-/Warnbox-Fläche (weicher Hintergrund). */
export const TONE_BOX: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200',
  warn: 'border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200',
  critical:
    'border-red-200 bg-red-50/60 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200',
  info: 'border-sky-200 bg-sky-50/60 text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200',
  neutral: 'border-border bg-muted/40 text-foreground',
};
