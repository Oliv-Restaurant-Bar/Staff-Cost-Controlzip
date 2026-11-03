/**
 * schema.ts — shape of the JSON the AI returns for a scanned supplier invoice.
 * =============================================================================
 * The model output is UNTRUSTED. This schema is deliberately lenient on number
 * formats (the model may return "1'234.50" or "1.234,50" as text) but strict on
 * structure: anything that does not fit is rejected, never guessed.
 */
import { z } from 'zod';
import { parseBetrag } from '@/lib/profil-pdf-parse';

/** Number from a JSON number or a Swiss/German formatted string; anything else -> null. */
const zahl = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseBetrag(v);
  return null;
}, z.number().nullable());

const text = z.preprocess(
  (v) => (v === null || v === undefined ? null : String(v).trim() || null),
  z.string().nullable(),
);

/** Date as YYYY-MM-DD (also accepts DD.MM.YYYY); anything else -> null. */
const datum = z.preprocess((v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}, z.string().nullable());

export const DOKUMENTARTEN = ['rechnung', 'lieferschein', 'auftragsbestaetigung', 'offerte', 'bestellung', 'sonstiges'] as const;

export const KiPositionSchema = z.object({
  artNr: text.default(null),
  bezeichnung: z.preprocess((v) => (v == null ? '' : String(v).trim()), z.string()),
  menge: zahl.default(null),
  einheit: text.default(null),
  /** Unit price, net. */
  preis: zahl.default(null),
  /** Line total, net. */
  positionspreis: zahl.default(null),
  /** VAT rate in percent as printed (e.g. 2.6, 8.1, 0). */
  mwstSatz: zahl.default(null),
  /** Delivery note number / date when the invoice groups lines per delivery. */
  lieferscheinNr: text.default(null),
  lieferdatum: datum.default(null),
});

export const KiMwstKlasseSchema = z.object({
  satz: zahl.default(null),
  basis: zahl.default(null),
  betrag: zahl.default(null),
});

export const KiRechnungSchema = z.object({
  dokumentart: z.preprocess(
    (v) => (typeof v === 'string' && (DOKUMENTARTEN as readonly string[]).includes(v) ? v : 'sonstiges'),
    z.enum(DOKUMENTARTEN),
  ),
  lieferant: z.object({
    name: text.default(null),
    mwstNr: text.default(null),
    iban: text.default(null),
  }).default({ name: null, mwstNr: null, iban: null }),
  /** Recipient (the customer) as printed, used for the wrong-tenant check. */
  empfaenger: text.default(null),
  rechnungsNr: text.default(null),
  rechnungsdatum: datum.default(null),
  lieferdatum: datum.default(null),
  netto: zahl.default(null),
  mwst: zahl.default(null),
  brutto: zahl.default(null),
  mwstKlassen: z.array(KiMwstKlasseSchema).default([]),
  positionen: z.array(KiPositionSchema).default([]),
  /** Free text from the model when parts of the scan were unreadable. */
  lesehinweis: text.default(null),
});

export type KiRechnung = z.infer<typeof KiRechnungSchema>;
export type KiPosition = z.infer<typeof KiPositionSchema>;

/** Parse untrusted model output. Never throws. */
export function parseKiAntwort(raw: unknown):
  | { ok: true; daten: KiRechnung }
  | { ok: false; grund: string } {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { ok: false, grund: 'no-json' }; }
  }
  const res = KiRechnungSchema.safeParse(obj);
  if (!res.success) return { ok: false, grund: 'schema' };
  return { ok: true, daten: res.data };
}
