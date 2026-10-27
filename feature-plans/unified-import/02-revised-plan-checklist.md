# Feature 2 — Unified Import — Implementation checklist

Based on `01-initial-plan.md` (option B, decisions in section 5). Delegation: **all steps inline** — every step
edits shared files in sequence and depends on the previous one; no independent chunk of ≥3 separate files.
Each step: re-read the target file before editing (line numbers in 01 come from a single read pass).

## Handover mechanism (the one real design decision)
The existing flows live in different places: inline sections on `/import` (`ImportHub.tsx`) and separate pages
(`/foratable-import`, `/gastronovi-import`, `/sales-upload`, `/csv-import`). Plan:
- `src/lib/unified-import/pending-files.ts` — module-level store: `setPending(handlerId, File[])`,
  `takePending(handlerId)`; no persistence, no DB (files never leave the browser until the existing flow saves).
- `src/hooks/useIncomingImportFile.ts` — `useIncomingImportFile(handlerId, onFiles)`: on mount and on a
  `unified-import:handover` window event, takes pending files and calls the existing "file chosen" handler
  of the section/page. This is the **only** edit inside each existing flow (a few lines each).
- Inline targets: scroll to the section anchor (reuse `IMPORT_SECTION_OPEN_EVENT`); route targets: `navigate()`.

## Steps

1. **[inline] Types + registry skeleton** — `src/lib/unified-import/types.ts`, `registry.ts`:
   `ImportHandler`, `ClassifyResult` (`type`, `confidence`, `reason`, `alternatives`), `fallbackHandler?` (unset).
   Reuse `ImportCategoryId`/`canAccess` from `src/lib/import-center.ts`. Done when: compiles, no UI.
2. **[inline] Classifier + tests (TDD)** — `src/lib/unified-import/classify.ts`. Stage 1 extension, stage 2 name,
   stage 3 content, calling existing detectors only (`suggestTagesdatenTyp`/`readFirstSheetRows`,
   `detectGnPdfReportKind` via `extractGnPdfTextItems`/`reconstructGnPdfLines`, `parseVerkaufsdatenFile` header,
   Foratable `buildHeaderMap`s — export them if currently private, no logic change). Ambiguous → `confirm` with
   alternatives; none → `unknown`. Tests in `src/lib/unified-import/__tests__/classify.test.ts` with small fixtures.
   Done when: `npx vitest run` on that file passes.
3. **[inline] Handover store + hook + tests** — `pending-files.ts`, `useIncomingImportFile.ts`.
4. **[inline] Wire handlers, one by one** (each: add hook call to the existing file-chosen handler, nothing else):
   a. `TagesdatenImportSection` (types 1; keep Datentyp confirm + year dropdown)
   b. `GastronoviZBerichtPage` (PDF/CSV, multiple)
   c. `VerkaufsdatenImportSection`
   d. `SalesUpload` (CSV pairs)
   e. `ForatableImportPage` tabs → `ReservationenImportPage` / `GaesteImportPage` (CSV; header mapping decides tab)
   f. `CSVImport` (Sage accounts), annual sections (`AnnualRevenue/Cost/PersonnelCost`, `VjDaily`),
      Ist-Stunden (`ActualHoursImportButton`/`HoursCSVImportButton`), Beaulieu sections.
   Warenrechnungen/WES/Budget: classified as "navigate only" (opens the page, no file handover) until their
   forms get a file hook — listed as such in the result row. Done when: each handler opens its existing preview
   with the file loaded.
5. **[inline] UI** — `src/components/import-center/UnifiedImportDropZone.tsx`, placed at the top of `/import`
   in `ImportHub.tsx` (admin view and the Beaulieu card view). Result list per file (name, type, confidence,
   status: Recognised / Please confirm / Not recognised / No permission / Error), type picker for ambiguous and
   unrecognised files (allowed types only), "Process" button, remove file. German UI strings, English comments.
   Mobile width check. Tenant switch discards the list with a warning.
6. **[inline] Collapse old entry points** — wrap the existing sections/cards under a collapsed "Einzelimporte"
   block; anchors must keep working (cards scroll to them and `IMPORT_SECTION_OPEN_EVENT` must open it).
7. **[inline] Verify** — `npx tsc --noEmit -p tsconfig.app.json` before/after (baseline 219), eslint on touched
   files only, vitest on new tests, browser run on `localhost:8080`: mixed drop (xlsx + csv + pdf), unknown file,
   ambiguous "Durchschnitt" file, tenant switch, Beaulieu role view, phone width.
8. **[inline] Changelog** — `03-implementation-changelog.md`; CRM comment draft for confirmation.

## Risks / watch-outs
- Each flow's file handler may assume an `<input>` event or a `File` from its own ref; the hook must call the
  same code path as a manual choice (verify in step 4 per target).
- PDF content detection needs pdf.js text extraction on the client; keep it lazy (dynamic import) like
  `waren-pdf-erkennung`.
- Z-Bericht allows max. 1 file per report kind — the bundler must not hand over duplicates; surface as "Error".
- Security audit pass: not warranted (no new DB paths, no SQL, no auth change) — to be re-checked if step 4 touches a save path.

## Progress (2026-10-27)
Steps 1–8 done, see `03-implementation-changelog.md` for what was built and what was verified. Deviations: no
`registry.ts` (the registry is `handlers.ts`), hook is `useIncomingImportFiles` (plural), Ist-Stunden and the
Beaulieu sections are open-only; queue and German texts live in `queue-store.ts` / `labels.ts`.
