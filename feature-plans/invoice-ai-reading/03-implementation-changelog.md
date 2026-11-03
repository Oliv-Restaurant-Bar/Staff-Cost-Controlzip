# Invoice AI reading — implementation changelog

CRM task 40310 (project 655), feature 3. Status: implemented and tested on dev, nothing committed yet.

## What was built

A "Mit KI lesen" button for scanned or photographed supplier invoices (PDF without text layer, JPG, PNG, HEIC). The result fills the same import preview that an original PDF produces: supplier, invoice number, dates, net/VAT/gross and every product line with its price (feeds the price history). Nothing is saved until the user confirms.

## Files

New
- `api/read-invoice.ts` — Vercel function: Supabase JWT + `get_my_role` (admin, beaulieu_manager), page/size limits, 20 reads per user per hour, one retry, one log line per call (no image data).
- `api/_invoice-schema.ts` — system prompt and strict JSON schema.
- `src/lib/invoice-ai/schema.ts` — zod validation of the untrusted model output.
- `src/lib/invoice-ai/map.ts` — maps the output to `ProfilPdfErgebnis` / `WarenPosition`, supplier lookup, arithmetic checks.
- `src/lib/invoice-ai/prepare.ts` — page rendering and shrinking (1600 px, JPEG 0.85, max 6 pages), EXIF orientation, HEIC fallback.
- `src/lib/invoice-ai/client.ts` — browser call with German error messages.
- `src/lib/invoice-ai/__tests__/map.test.ts` — 18 tests.

Changed
- `src/components/waren/BeaulieuPdfImport.tsx` — row building extracted, `KiLesungBox` (summary, findings, line table), wider/less congested row layout, spinner fix.
- `src/pages/Warenrechnungen.tsx` — entry point, image input, `handleKiLesen`, wider popup (`max-w-6xl`).
- `src/lib/profil-pdf-parse.ts` — `perKi` flag.
- `vite.config.ts` — dev-only plugin that serves `/api/read-invoice` locally.
- `package.json` / `package-lock.json` — `heic2any@0.0.4` (MIT, last release 2023, lazy-loaded only for HEIC).
- `CLAUDE.md` — language rule (client strings German, everything else English).

## Deviations from the plan

- `WarenUniversalUpload` turned out to be unrendered; the real entry point is "Manuell erfassen → PDF-Rechnung erkennen".
- Added `empfaenger` (recipient) so the wrong-tenant check also works for AI reads.
- `reasoning.effort = 'low'` (env override `OPENROUTER_REASONING_EFFORT`): default reasoning cost ~9k tokens / 40 s; low is ~2k tokens / 18 s / about $0.005.
- Monthly-invoice suppliers (Spahni, Gourmador, Bohnenblust, or `belegtyp = monatsrechnung`) are marked provisional/final by the existing reconciliation rule, not auto-final.
- After an AI read the OCR-prefilled manual form is reset so no stale values remain.

## Test results (dev, model `google/gemini-2.5-flash`)

- Correct: multi-page PDF, French, Italian, phone photo, PNG, HEIC.
- Locked as designed: credit note, order confirmation. Rejected: non-document.
- Arithmetic checks caught real misreads (quantity, VAT basis); the model is non-deterministic even at temperature 0, so checks plus user review are essential.
- Full import on dev (Obrist, 4 lines): booking created with receipt, account 4020, CHF 1'197.00. A second Obrist invoice with changed prices produced the expected price changes (Dôle +6.0 %, Prosecco +4.1 %) in the Preisänderungen tab. All test data was removed afterwards.
- Bug found by the user and fixed: during import every button showed a spinner. Now only the clicked import button does (`importing` state).
- Cost about $0.004–0.009 per document, 4–26 s per read.
- Checks: `tsc -p tsconfig.app.json` 219 (baseline), `tsc -p api/tsconfig.json` 0, vitest new tests pass.

## Open items

- Test with real client scans; compare models.
- Production: set `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (and optionally `OPENROUTER_REASONING_EFFORT`) as Vercel env vars. The client should set a spending limit and a data-retention preference on OpenRouter.
- Credit notes are locked (manual entry needed).
- Untested: 403 for other roles, Beaulieu positive case, rate-limit and missing-key paths.
- Nothing committed or pushed.
