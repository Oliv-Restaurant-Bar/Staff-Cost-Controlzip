/**
 * Warenaufwand-Gruppierung — Single Source of Truth für die numerische
 * Range-Zuordnung der Warenaufwandskonten zu den beiden Zwischentotalen
 * der Erfolgsrechnung:
 *
 *   Direkter Warenaufwand: Konten 4000–4070 (inklusive)
 *   Übriger Warenaufwand:  Konten 4071–4900 (inklusive)
 *
 * Regeln (Spez.):
 * - Zuordnung erfolgt AUSSCHLIESSLICH numerisch über die Kontonummer —
 *   nie über Bezeichnung, Reihenfolge oder Position.
 * - Konten ausserhalb der Bereiche werden NICHT stillschweigend zugeordnet
 *   (→ null). Der Aufrufer entscheidet über Fallback + Datenqualitätshinweis.
 * - Kontonummern können als String oder Zahl vorliegen; Whitespace wird
 *   toleriert. 5-stellige Konten werden — wie überall in der App — auf die
 *   ersten 4 Stellen reduziert (z.B. «40201» → 4020).
 * - Ungültige Werte (leer, nicht-numerisch, Dezimalzahlen) → null.
 *
 * Reine Logik: kein DOM, kein Supabase, keine Seiteneffekte.
 */

export type WarenaufwandGruppe = 'direct' | 'uebrig';

/** Kontobereich Direkter Warenaufwand (inklusive Grenzen). */
export const WARENAUFWAND_DIRECT_MIN = 4000;
export const WARENAUFWAND_DIRECT_MAX = 4070;

/** Kontobereich Übriger Warenaufwand (inklusive Grenzen). */
export const WARENAUFWAND_UEBRIG_MIN = 4071;
export const WARENAUFWAND_UEBRIG_MAX = 4900;

/** Anzeige-Labels der Zwischentotale (identisch in UI, PDF und Excel). */
export const WARENAUFWAND_GRUPPE_LABEL: Record<WarenaufwandGruppe, string> = {
  direct: 'Direkter Warenaufwand',
  uebrig: 'Übriger Warenaufwand',
};

/**
 * Normalisiert eine Kontonummer für den Bereichsvergleich.
 * - String: trimmen; nur 3–5 zusammenhängende Ziffern gültig.
 * - 5-stellig → erste 4 Stellen (bestehende App-Konvention).
 * - Zahl: nur nicht-negative ganze Zahlen; ≥ 10000 → erste 4 Stellen.
 * - Alles andere → null (nie stillschweigend raten).
 */
export function normalizeWarenKonto(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return null;
    if (raw >= 100000) return null;
    if (raw >= 10000) return Math.floor(raw / 10);
    return raw;
  }
  const s = raw.trim();
  if (!/^\d{3,5}$/.test(s)) return null;
  const n = s.length > 4 ? parseInt(s.slice(0, 4), 10) : parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Klassifiziert eine Kontonummer:
 *   4000–4070 → 'direct'
 *   4071–4900 → 'uebrig'
 *   ausserhalb / ungültig → null
 */
export function classifyWarenaufwandKonto(
  raw: string | number | null | undefined,
): WarenaufwandGruppe | null {
  const n = normalizeWarenKonto(raw);
  if (n === null) return null;
  if (n >= WARENAUFWAND_DIRECT_MIN && n <= WARENAUFWAND_DIRECT_MAX) return 'direct';
  if (n >= WARENAUFWAND_UEBRIG_MIN && n <= WARENAUFWAND_UEBRIG_MAX) return 'uebrig';
  return null;
}

/** Ergebnis einer Konten-Gruppierung. */
export interface WarenaufwandGruppierung<T> {
  direct: T[];
  uebrig: T[];
  /** Einträge ohne gültige Range-Zuordnung — Aufrufer muss entscheiden (Fallback + Hinweis). */
  unzugeordnet: T[];
}

/**
 * Teilt beliebige Zeilen anhand ihrer Kontonummer in die beiden Gruppen.
 * Innerhalb einer Gruppe bleibt die Eingabereihenfolge erhalten
 * (Sortierung ist Sache des Aufrufers).
 */
export function gruppiereWarenaufwandKonten<T>(
  rows: readonly T[],
  getKonto: (row: T) => string | number | null | undefined,
): WarenaufwandGruppierung<T> {
  const out: WarenaufwandGruppierung<T> = { direct: [], uebrig: [], unzugeordnet: [] };
  for (const row of rows) {
    const g = classifyWarenaufwandKonto(getKonto(row));
    if (g === 'direct') out.direct.push(row);
    else if (g === 'uebrig') out.uebrig.push(row);
    else out.unzugeordnet.push(row);
  }
  return out;
}

/**
 * Null-bewusste Summe: `null`, wenn KEIN Wert vorhanden ist (fehlend ≠ 0).
 * Vorhandene Werte (auch 0) werden normal summiert.
 */
export function sumOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}
