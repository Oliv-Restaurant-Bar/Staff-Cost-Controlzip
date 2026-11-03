// Prompt + JSON schema for AI invoice reading. The leading underscore keeps Vercel
// from exposing this file as a function. The browser validates the answer again
// (src/lib/invoice-ai/schema.ts) — the model output is never trusted.

const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;

export const INVOICE_JSON_SCHEMA = {
  name: 'supplier_invoice',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'dokumentart', 'lieferant', 'empfaenger', 'rechnungsNr', 'rechnungsdatum', 'lieferdatum',
      'netto', 'mwst', 'brutto', 'mwstKlassen', 'positionen', 'lesehinweis',
    ],
    properties: {
      dokumentart: {
        type: 'string',
        enum: ['rechnung', 'lieferschein', 'auftragsbestaetigung', 'offerte', 'bestellung', 'sonstiges'],
      },
      lieferant: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'mwstNr', 'iban'],
        properties: { name: nullableString, mwstNr: nullableString, iban: nullableString },
      },
      empfaenger: nullableString,
      rechnungsNr: nullableString,
      rechnungsdatum: nullableString,
      lieferdatum: nullableString,
      netto: nullableNumber,
      mwst: nullableNumber,
      brutto: nullableNumber,
      mwstKlassen: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['satz', 'basis', 'betrag'],
          properties: { satz: nullableNumber, basis: nullableNumber, betrag: nullableNumber },
        },
      },
      positionen: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['artNr', 'bezeichnung', 'menge', 'einheit', 'preis', 'positionspreis', 'mwstSatz', 'lieferscheinNr', 'lieferdatum'],
          properties: {
            artNr: nullableString,
            bezeichnung: { type: 'string' },
            menge: nullableNumber,
            einheit: nullableString,
            preis: nullableNumber,
            positionspreis: nullableNumber,
            mwstSatz: nullableNumber,
            lieferscheinNr: nullableString,
            lieferdatum: nullableString,
          },
        },
      },
      lesehinweis: nullableString,
    },
  },
} as const;

export const SYSTEM_PROMPT = `You read scanned or photographed supplier invoices of a Swiss restaurant (documents are mostly German, sometimes French/Italian). Return ONLY the JSON that matches the given schema.

Rules:
- Copy what is printed. NEVER guess, estimate or calculate a value that is not on the document: use null instead.
- Amounts are numbers in CHF without thousands separators (3'796.25 -> 3796.25). Dates are YYYY-MM-DD.
- dokumentart: "rechnung" only for an invoice (Rechnung/Faktura). Delivery note = "lieferschein", order confirmation = "auftragsbestaetigung", offer/quote = "offerte", order = "bestellung", anything else = "sonstiges".
- lieferant: the SENDER of the document (the supplier), not the recipient (Oliv / Beaulieu). mwstNr exactly as printed (e.g. CHE-123.456.789 MWST). iban only if printed.
- empfaenger: the name of the RECIPIENT (customer) exactly as printed in the address block, e.g. "Restaurant Beaulieu AG"; null if not printed.
- netto = total excluding VAT, mwst = total VAT amount, brutto = total payable, all as printed.
- mwstKlassen: the printed VAT summary, one entry per rate (satz in percent, basis = net amount of that rate, betrag = VAT amount).
- positionen: EVERY product line, in document order, including lines with 0 % VAT (deposits, bottles). menge = quantity, preis = unit price (net), positionspreis = line total (net), mwstSatz = rate in percent if printed per line or clearly implied by a printed code/column, else null. If the invoice groups lines per delivery note, fill lieferscheinNr and lieferdatum for each line, else null.
- Do not include subtotal, total, freight-summary or payment-term rows as product lines.
- If something is unreadable or cut off, leave the field null and describe the problem briefly in lesehinweis (English). Otherwise lesehinweis is null.`;
