/**
 * Tabellen-Standards (Design-System Phase 3.1) — Klassen-Konstanten statt
 * schwerer Tabellen-Abstraktion, damit bestehende (auch handgerollte)
 * Tabellen schrittweise angeglichen werden können.
 *
 * Regeln:
 *  - Zahlen IMMER rechtsbündig + tabular-nums (TD_NUM / TH_NUM).
 *  - Sticky-Kopf wo sinnvoll (TH_STICKY); Hintergrund MUSS OPAK sein
 *    (bg-muted-Token ist im Light- und Dark-Mode opak — keine /40-Alpha-
 *    Varianten, sonst scheinen Zeilen beim Scrollen durch).
 *  - Haupttabelle möglichst ohne Seiten-Scrollen: Scroll-Container
 *    TABLE_SCROLL (max-h) statt endloser Seite.
 */

/** Rahmen um die Tabelle (Karte). */
export const TABLE_WRAP = 'rounded-lg border border-border bg-card overflow-hidden';

/** Scroll-Container in der Karte — Kopf bleibt via TH_STICKY sichtbar. */
export const TABLE_SCROLL = 'max-h-[70vh] overflow-auto';

/** <table>-Basis. */
export const TABLE = 'w-full border-collapse text-sm';

/** Kopfzelle. */
export const TH =
  'px-3 py-2 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap';

/** Kopfzelle für Zahlenspalten. */
export const TH_NUM = 'text-right';

/** Sticky-Kopf: OPAKER Hintergrund (Token bg-muted ist opak, auch im Dark-Mode). */
export const TH_STICKY = 'sticky top-0 z-10 bg-muted';

/** Datenzelle. */
export const TD = 'px-3 py-1.5 align-middle border-b border-border/50';

/** Datenzelle für Zahlen: rechtsbündig, gleichbreite Ziffern. */
export const TD_NUM = 'text-right tabular-nums whitespace-nowrap';

/** Klickbare Zeile — einheitliche Affordanz. */
export const ROW_CLICKABLE = 'cursor-pointer transition-colors hover:bg-muted/50';

/** Zebra-Streifen (optional, für dichte Tabellen). */
export const ROW_ZEBRA = 'odd:bg-muted/20';
