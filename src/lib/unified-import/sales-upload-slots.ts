/**
 * sales-upload-slots.ts — which of the four Sales Upload slots a handed-over file belongs to.
 * ============================================================================================
 * The Sales Upload page is driven by the client's file names («Anzahl Food …csv», «Umsatz Beaulieu…»
 * style hints on the four drop fields). We use exactly that rule: the name must carry ONE of
 * anzahl/umsatz and ONE of food/beverage. Anything else is NOT placed (never guessed) and is reported.
 */

export type SalesUploadSlot = { category: 'food' | 'beverage'; kind: 'anzahl' | 'umsatz' };

const hasWord = (name: string, words: string[]): boolean =>
  words.some(w => new RegExp(`(^|[^a-zäöüß])${w}([^a-zäöüß]|$)`, 'iu').test(name));

export function salesUploadSlotFromName(fileName: string): SalesUploadSlot | null {
  const n = fileName.toLowerCase();
  const anzahl = hasWord(n, ['anzahl', 'menge', 'stück', 'stueck']);
  const umsatz = hasWord(n, ['umsatz']);
  const food = hasWord(n, ['food', 'speisen']);
  const beverage = hasWord(n, ['beverage', 'getränke', 'getraenke']);
  if (anzahl === umsatz) return null;      // neither or both
  if (food === beverage) return null;      // neither or both
  return { category: food ? 'food' : 'beverage', kind: anzahl ? 'anzahl' : 'umsatz' };
}
