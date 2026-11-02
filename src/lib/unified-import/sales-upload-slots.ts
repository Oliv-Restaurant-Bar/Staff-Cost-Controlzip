/**
 * sales-upload-slots.ts — which of the four Sales Upload slots a handed-over file belongs to.
 * ============================================================================================
 * The Sales Upload page is driven by the client's file names («Anzahl Food …csv», «Umsatz Beaulieu…»
 * style hints on the four drop fields). We use exactly that rule: the name must carry ONE of
 * anzahl/umsatz and ONE of food/beverage. The client's weekly exports are also named with two-letter codes
 * («FA KW38.csv», «FU», «BA», «BU» = Food/Beverage + Anzahl/Umsatz), accepted when the name carries exactly one.
 * Anything else is NOT placed (never guessed) and is reported.
 */

export type SalesUploadSlot = { category: 'food' | 'beverage'; kind: 'anzahl' | 'umsatz' };

const hasWord = (name: string, words: string[]): boolean =>
  words.some(w => new RegExp(`(^|[^a-zäöüß])${w}([^a-zäöüß]|$)`, 'iu').test(name));

const CODES: Record<string, SalesUploadSlot> = {
  fa: { category: 'food', kind: 'anzahl' },
  fu: { category: 'food', kind: 'umsatz' },
  ba: { category: 'beverage', kind: 'anzahl' },
  bu: { category: 'beverage', kind: 'umsatz' },
};

/** The client's two-letter code as a standalone token in the name (null when absent or ambiguous). */
function slotFromCode(n: string): SalesUploadSlot | null {
  const found = new Set((n.match(/(?<![a-zäöüß])(fa|fu|ba|bu)(?![a-zäöüß])/giu) ?? []).map(m => m.toLowerCase()));
  return found.size === 1 ? CODES[[...found][0]] : null;
}

export function salesUploadSlotFromName(fileName: string): SalesUploadSlot | null {
  const n = fileName.toLowerCase();
  const anzahl = hasWord(n, ['anzahl', 'menge', 'stück', 'stueck']);
  const umsatz = hasWord(n, ['umsatz']);
  const food = hasWord(n, ['food', 'speisen']);
  const beverage = hasWord(n, ['beverage', 'getränke', 'getraenke']);
  if (!anzahl && !umsatz && !food && !beverage) return slotFromCode(n); // the client's FA/FU/BA/BU names
  if (anzahl === umsatz) return null;      // neither or both
  if (food === beverage) return null;      // neither or both
  return { category: food ? 'food' : 'beverage', kind: anzahl ? 'anzahl' : 'umsatz' };
}
