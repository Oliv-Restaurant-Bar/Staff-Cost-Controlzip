# Invoice AI reading (Feature 3) — initial plan

Status: **Draft for approval, no code.** CRM task 39927 (Phase 2), feature 3. Date: 2026-11-02.
Client choice from the Phase 2 scope: "Option C" — normal PDFs keep the free recognition; AI only for documents the free recognition cannot read.

## 1. Intent

The client scans paper supplier invoices with his phone (PDF scan or photo). Today the goods-invoice upload cannot read them (photos are refused; image-only PDFs go through Tesseract OCR, which is weak on phone scans), so he types the invoice in by hand. Goal: after one click, the AI reads the scan and fills the **same preview** an original PDF produces — supplier, invoice number, dates, totals and **every product line with price** (the price history depends on lines). He checks and confirms; nothing is saved by the AI.

## 2. Goals / non-goals / anti-goals

**Goals**
- Photos (JPG/PNG/HEIC) and image-only PDFs of supplier invoices can be read by AI on explicit request.
- Result lands in the existing goods-invoice preview (`ParsedCsvRechnung` + header fields), so confirm, sum checks, supplier assignment and price history work unchanged.
- Model is a setting (OpenRouter model id), switchable without code changes.
- Misreads are visible: the lines are checked against the printed totals and a clear warning is shown when they do not match.

**Non-goals**
- Weekly-sheet sources (Z-Bericht, KPI, Mirus, …) — they already work from files; no AI there.
- Replacing the free text-based parsers for original PDFs (they stay first and untouched).
- Automatic AI on every upload; batch/background processing; training or fine-tuning.
- Saving anything without the user's confirmation; new database tables (v1).

**Anti-goals (failure even if it "works")**
- A wrong price silently entering the price history.
- The API key reachable from the browser.
- Invoice images sent to the AI without the user having clicked the button.
- Costs that surprise the client.

## 3. Decisions

Decided by the user: OpenRouter (no direct OpenAI/Anthropic SDK) · button-triggered ("Mit KI lesen") · product lines required · **B + C**: the AI returns structured data directly (not text for the old parsers), then the existing supplier lookup (VAT number / name / IBAN) assigns the supplier · runs in a **Vercel function** in `api/`.

Approaches considered: (A) AI as OCR feeding the existing text parsers — rejected: those parsers are layout-specific per supplier, photo text loses table structure; (B) structured output — chosen; (C) supplier lookup on the AI header values — folded into B. Edge Function instead of Vercel function — rejected: second place for secrets and manual per-project deploys; dev and prod are both on Vercel.

**Builder's calls (mine, adjustable)**
- Default model: a vision-capable model via OpenRouter, id read from env `OPENROUTER_MODEL`; the exact default is chosen in step 1 of the build by testing 2–3 candidates on the client's real scans (accuracy first, cost second). Not guessed here.
- Images are shrunk in the browser (long edge 1600 px, JPEG 0.85) before sending; PDFs are rendered page by page with pdfjs (already a dependency) to the same format, max 6 pages. Keeps requests under Vercel's 4.5 MB body limit and cuts cost.
- HEIC: converted in the browser to JPEG (`heic2any`-style library or canvas decode where the browser supports it); if it cannot be decoded the user gets a clear message ("bitte als JPG/PDF teilen").
- No DB table for AI usage in v1: the function writes one structured log line per call (user id, tenant, model, tokens, ok/failed, no image data) to Vercel logs; OpenRouter's own activity page shows spend per key. A table can follow if the client wants a report.
- Rate limit: max 20 AI reads per user per hour (best-effort, in-memory per function instance) plus a hard monthly spending limit set on the OpenRouter key by the client.

## 4. Flow

1. Goods-invoice upload accepts images in addition to csv/txt/zip/pdf.
2. Classification as today. A file with no readable text (image, or PDF whose OCR fails or gives no supplier) is listed as "Kein Text lesbar — manuelle Prüfung" **plus a button "Mit KI lesen"** (per file).
3. Click → browser prepares pages (shrink/render) → `POST /api/read-invoice` with the Supabase access token and the pages as base64 JPEGs.
4. Function: verify the token against Supabase (`get_my_role` with the user's JWT; allowed: admin, beaulieu_manager — same as `warenrechnungenPerms.canCreate`), check size/page limits, call OpenRouter with a strict JSON schema (structured output) and a German system prompt, return the parsed JSON. Key is `OPENROUTER_API_KEY`, server-side only.
5. Browser: validate the JSON (zod), convert to `ProfilPdfErgebnis`/`ParsedCsvRechnung` (header fields, `positionen` with `artNr`, `bezeichnung`, `menge`, `einheit`, `preis`, `positionspreis`, VAT), run `findeProfilImText`-style supplier assignment on the returned VAT number / name / IBAN (C). Unknown supplier = existing "Lieferant offen" with manual assignment.
6. Checks (reuse existing where present): Σ line totals vs net total, VAT classes vs printed VAT, gross = net + VAT, `qty × unit price ≈ line total`. Any mismatch → warning banner on the preview, affected lines marked; the user can edit or discard. Documents that are not invoices (order confirmation, offer, delivery note) keep the existing "never booked" lock.
7. Preview/confirm/save unchanged. Entries created from AI reading carry a marker ("per KI gelesen") in the preview.

## 5. Constraints and risks

| Risk | Handling |
|---|---|
| Misread digits in prices | Arithmetic checks + warning + nothing saved unasked; marker on AI-read documents; spot-test with the client's real scans before release |
| Data leaves the system | Button only; client informed; OpenRouter setting to deny training on prompts / provider data-retention policy to be configured by the client and noted in the docs |
| Cost | Image shrinking, page cap, rate limit, key spending limit, model switchable |
| Vercel body limit (4.5 MB) | Client-side shrinking; function rejects larger bodies with a clear message |
| Function timeout on slow models | Set `maxDuration` of the function generously (300 s default on Fluid) and show progress; one retry on a transient OpenRouter error |
| Model returns invalid JSON | Structured output + zod validation; failure shows "KI konnte den Beleg nicht lesen" and falls back to manual entry |
| Key leaks | Server env var only, never `VITE_`-prefixed; never logged |

## 6. Build order (for the next step, `writing-plans`)

1. Spike on real scans (offline script, not shipped): compare 2–3 models via OpenRouter on 5–10 of the client's scanned invoices; fix the default model and the prompt/schema.
2. `api/read-invoice.ts` (auth, limits, OpenRouter call, logging) + env vars on dev.
3. Pure TS module: schema (zod), mapping to the existing invoice structures, arithmetic checks — with unit tests including bad/partial model output.
4. Browser: image/PDF preparation (shrink, render, HEIC), upload field accepts images, "Mit KI lesen" button, progress and error states, preview marker.
5. Test on dev with the client's scans; verify price history entry after confirm; changelog; client demo.

## 7. Known technical unknown (check at the start of build step 4)

`BeaulieuPdfImport` (the profile-PDF import in `Warenrechnungen.tsx`, fed through `externalFilesRef`) parses the PDF text itself. The AI path produces an already-parsed result, so that component needs one extra entry point that accepts a pre-parsed document (plus the "per KI gelesen" marker) and continues with its existing preview/confirm. Not yet read in detail; scope of that change is confirmed when step 4 starts.

## 8. Open items that need the client

- OpenRouter account + API key with prepaid balance and a spending limit; the key is added by the client (or us together) as an environment variable in the Vercel project — it should not be pasted into chat.
- 5–10 real scanned/photographed invoices from different suppliers (for the model test and for acceptance).
- Agreement that invoice images are sent to an AI provider through OpenRouter.
