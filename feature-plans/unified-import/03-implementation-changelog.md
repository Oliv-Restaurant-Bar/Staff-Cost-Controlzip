# Feature 2 — Unified Import — Implementation changelog

Status: **steps 1–8 done** (classifier, handover, flows wired, drop zone, «Einzelimporte» group, verification).
Only the CRM comment is left (draft below, needs confirmation). Nothing is committed.

## Principle (client direction)
The existing detectors and flows are the client's own logic and keep working unchanged. The unified import
sits on top: it recognises and hands over; the existing preview + confirm + save path stays. Contract tests
pin the client's conventions (`client-conventions.contract.test.ts`).

## Built (new files)
- `src/lib/unified-import/` — `types.ts`, `handlers.ts` (registry, 13 flows, role guards from `import-center.ts`),
  `probe.ts` (IO), `classify.ts` (pure), `pending-files.ts` (in-memory handover), `sales-upload-slots.ts`.
- `src/hooks/useIncomingImportFiles.ts` — lets an existing flow receive a handed-over file.
- Tests: contract (18), classifier (29), probe/handover/guards (13), sales-upload slots (11), hook (5) — 76 total.

## Changed in existing code (each is a few lines)
| File | Change |
|---|---|
| `tagesdaten-auto-import.ts` | `cellToString`: real Excel date cells become `TT.MM.` (before: timezone-dependent text, day columns unusable). Additive, no year in the value. |
| `ImportHub.tsx` | Hook in `TagesdatenImportSection` (file-chosen code extracted into `chooseFile`, used by the input and the hook; native field shows the file name), `AnnualRevenueImportSection`, `AnnualCostImportSection`, `AnnualPersonnelCostImportSection`. |
| `VerkaufsdatenImportSection.tsx` | Hook; `handleFiles` accepts `File[]` as well as `FileList`. |
| `VjDailyImportSection.tsx` | Hook. |
| `GastronoviZBerichtPage.tsx` | Hooks for Z-Bericht PDF and KPI files; the mode is switched first, files processed after the new mode renders (`incoming` state + effect). |
| `SalesUpload.tsx` | Files placed into the four slots by the client's file-name rule; non-matching files are reported (toast), never guessed. |
| `ReservationenImportPage.tsx`, `GaesteImportPage.tsx` | Hook (registered above the permission redirect, so hook order is unchanged). |
| `CSVImport.tsx` | Hook; file-kind derivation extracted into `fileKindFromName` (shared with `UploadZone`). |

## Deliberately NOT wired (navigate only)
- `ist-stunden` (Mirus xlsx) and `ist-stunden-csv`: the Mirus dialog asks for the import mode BEFORE the file
  and imports at once when all names are known; a pre-loaded file would skip the client's own mode step.
  The drop zone opens the section and lists the file as "navigate only".
- Warenrechnungen, WES, Budget: no file input flow to hook into yet (not in the handler registry).

## Verification (step 4)
- Unit: 76 new tests green; existing detector/parser tests green (194 in the 10 related files); a broader run of
  all import-related tests: 1,560 passed, 1 failed — `reservation-analytics` «berechnet Vorlaufzeiten»
  (expected 3 to be 4): a file and its imports untouched by this work.
- Mutation check: disabling two classifier rules failed exactly the two tests covering them.
- `npx tsc --noEmit -p tsconfig.app.json`: 219 errors = baseline, none in new/touched lines.
- ESLint on touched files: no new findings except +2 `react-hooks/rules-of-hooks` in `GastronoviZBerichtPage.tsx`
  (the `incoming` state/effect depend on `importType`, which that page declares below its existing early
  return — same pre-existing pattern as its other 56 findings).
- Browser (localhost:8080, logged-in admin, Oliv) with files handed over through the real handover module:
  Foratable Gäste CSV → existing preview; Foratable Reservationen CSV → existing preview incl. self-check;
  Verkaufsdaten .txt → waits while the section is collapsed, loads when opened («Food · Umsatz (CHF)»);
  Sales Upload → 2 of 3 files placed in the right slots, `export.csv` reported; Kontoblatt CSV → loaded;
  Tagesdaten xlsx (client's real case «Anzahl Oliv 07.2026.xlsx», plain 166/204/259) → type pre-selected
  «Gäste / Anzahl Personen», full preview with the client's overwrite warnings. **Nothing was saved** — every
  test preview was cancelled (the Tagesdaten test file overlaps real July data and was cancelled on purpose).
- Not yet exercised in the browser: Z-Bericht PDFs, the three annual sections, VJ daily (wired, same pattern,
  to be run with real sample files in step 7 through the finished drop zone).

## Findings to keep
- The `/import` page sections are collapsed accordions whose content is not mounted while closed. The hook
  delivers on mount, so a handover waits until the section opens — **the drop zone must open the target
  section** (`IMPORT_SECTION_OPEN_EVENT`) after `setPending`.
- On every `/import` load the Z-Bericht inbox card shows «2 zurückgestellt (Download-Fehler)» — existing
  behaviour of `ZberichtInboxCard`, unrelated to this feature, noted for the client.

## Steps 5–6: drop zone and «Einzelimporte»
- `src/components/import-center/UnifiedImportDropZone.tsx` at the top of `/import` (admin and Beaulieu card view):
  multi-file drop/pick → classifier → list (name, status badge, type picker limited to types the role may use,
  remove) → one button per type group «… öffnen». Opening = `setPending` (+ navigate for routes, or open
  section + scroll for inline sections). Nothing is saved by this layer; the existing flow shows its own preview.
- `queue-store.ts` (module level, memory only) keeps the list across the route change; `labels.ts` holds the
  German texts; `multiFile` flag on handlers: Verkaufsdaten, KPI, Sales Upload take the whole group, every other
  flow takes ONE file per run (the rest stay listed, toast says so).
- Permission: category rule of `import-center.ts` + inline sections are admin only. A tenant switch empties the list
  and the pending store (warning toast); the store also refuses to mix tenants.
- `ImportHub.tsx`: the 11 inline sections are wrapped in `EinzelimportGroup` («Einzelimporte», collapsed). Children
  stay mounted but hidden, so `IMPORT_SECTION_OPEN_EVENT` and `#anchor` links keep working; the group opens itself on
  the same signals. All old buttons and cards (Rhythm/Group cards) are unchanged.

## Final verification (step 7)
- Tests: 80 new (76 + 4 queue-store) green; 840 existing import-related tests green (49 files).
- `tsc -p tsconfig.app.json`: 219 = baseline. ESLint: new files 0 findings; `ImportHub.tsx` 2 warnings before and after.
- Browser, mixed drop (reservations CSV, unknown .txt, .png, Verkaufsdaten .txt): statuses Erkannt / Nicht erkannt /
  Nicht unterstützt / Erkannt; per-type buttons shown; unknown file offers a type picker.
- Verkaufsdaten: click → «Einzelimporte» opens, section opens, file loaded, «Vorschau erstellen» offered. Not clicked.
- Foratable Reservationen: route opens with the file already analysed (preview); back to `/import` → list kept,
  file marked «Übergeben», unknown file still waiting.
- Phone width (390 px iframe of the real page): no horizontal overflow from the drop zone; rows stack, long names cut.
- Earlier (step 4): Tagesdaten (client's «Anzahl» case → «Gäste»), Foratable Gäste, Sales Upload, Kontoblatt.
- Nothing was saved in any test.
- NOT verified: Beaulieu role/tenant view and the tenant-switch warning (needs a second login / tenant change;
  logic is unit-covered for the store, UI effect untested), Z-Bericht PDFs, annual sections and VJ daily with real files.

## Known limits
- Z-Bericht takes one PDF per run; the page's own «one file per KPI kind» limit is not enforced by the list.
- Mirus Ist-Stunden, Warenrechnungen, WES, Budget: open-only (see above).
- `.xls` (legacy) and scans cannot be read; reported with a German reason. `fallbackEligible` is the hook for Feature 3.
- Z-Bericht rules-of-hooks +2 (see step 4), pre-existing failing test `reservation-analytics`.

## Round 2 — «Wöchentlich — Cockpit-Bereitschaft» (client request from the meeting recording)
The client wants the unified import for the 8 weekly sources of that card. Gaps found and closed:

| Weekly source | Existing importer | Round 1 | Now |
|---|---|---|---|
| Umsatz / Gäste / Durchschnittsverkauf | Z-Bericht PDF, KPI PDF/CSV, daily-data xlsx | wired | unchanged; real Z-Bericht PDF verified in the browser |
| Verkaufsdaten / Sales | Verkaufsdaten, Sales Upload | wired | unchanged |
| Reservationen | Foratable CSV | wired | unchanged |
| **MIRUS Ist-Stunden** | **two** importers: Import-Center dialog (Ersetzen/Aktualisieren) and the schedule screen's Ist view (reconcile plan 1–5, backup, undo) | open-only | **both receive the file**; user picks (default: schedule screen) |
| **Rezensionen** | `/rezensionen` CSV | missing | new type `rezensionen` (recognised via the importer's own `parseFeedbackCsv`) |
| **Umsatzanalyse Kategorien** | Produktanalyse tab, xlsx | missing | new type `umsatzkategorien` («> Kategorie» rows + day columns) |

- **Mirus is .xls:** the probe used ExcelJS (xlsx only) and would have rejected the real Mirus export. Binary .xls is now
  read with SheetJS (the library the Mirus parser itself uses); only Mirus files are accepted from it, every other type
  still reports «legacy .xls» (types: `sheet.legacy`).
- **Schedule hand-over:** `SchedulePlanner` switches to the Ist view and to the month of the file (the reconcile import only
  writes the shown month), then gives the file to `MirusReconcileImportButton` (`incomingFile`), which runs its normal path
  (name matching → plan preview → «Bestätigen»). Waits until the planner has loaded its data.
- **Import-Center hand-over:** `ActualHoursImportButton` opens its dialog and HOLDS the file until the client's own mode
  choice (Ersetzen/Aktualisieren) is made, then «Mit gewähltem Modus fortfahren» runs the unchanged path.
- **Drop zone:** a «Wochenquellen in dieser Liste» strip shows which of the 8 sources the list covers
  (`weekly-sources.ts`, ids = `WEEKLY_SOURCES`).
- Refactors in old code are extraction only: `handleFileUpload`/`handleFile` → `processFile(file)` in both Mirus buttons.

Verification (round 2): 84 unified tests + 1,013 related tests green; `tsc` 219 = baseline; ESLint counts unchanged on all touched
old files (SchedulePlanner 18 = 18). Browser, nothing saved/confirmed: the repo's real Mirus test file (`Taegliche_Stunden.xls`)
→ «Erkannt», both targets offered; schedule target → Dienstplanung in Ist view on the file's month, client's name-matching
dialog open with the file (cancelled); Import-Center target → mode dialog with the held file (cancelled); feedback CSV →
`/rezensionen` import preview (cancelled); a real Gastronovi Z-Bericht PDF (from `attached_assets`) → recognised as Z-Bericht,
Z-Bericht page loaded it with plausibility checks and the client's own «bereits importiert» warning (not imported).
Not exercised in the browser: Umsatzanalyse Kategorien xlsx (unit-covered; no sample file), KPI PDFs, Beaulieu role.

### Round 2b — correction: the drop zone lives INSIDE «Wöchentlich — Cockpit-Bereitschaft»
Round 1/2 put the zone above the card and left the card's 8 per-row «Import» buttons in place; the client meant that card.
Now: the zone is embedded in `CockpitReadinessCard`, the 8 row buttons are removed, and every row shows a chip
(«In Liste» / «✓ Übergeben», `weeklyCoverage` in `weekly-sources.ts`). The standalone zone remains only for the non-admin card view.
The old per-source sections are still reachable under «Einzelimporte». Browser-checked: 0 row buttons, chips on the three
matching rows (Mirus, Reservationen, Rezensionen). tsc 219 = baseline.

### Round 3 — UI polish and language
- Restyled: drop area + file list + open buttons + weekly card rows/summary (2b), the shared name-matching dialog
  (`ImportMatchPreviewDialog`: alert is red only while names are unresolved, short option labels, one-line rows, wider dialog),
  and the held-file state of the Mirus mode dialog. Logic untouched.
- Not restyled (cannot be viewed without writing data): the Mirus reconcile plan preview and report dialogs — confirming the name
  dialog parks hours and saves name aliases.
- `UI_LANG` is back to `'de'` (commit state). All feature strings go through `tr()`; flip to `'en'` only while developing.

### Round 4 — re-open, duplicates, expiry (found while testing every file type end to end)
- **Bug:** after opening a file and coming back without importing, the file stayed in the list but its open button vanished.
  Now an opened file stays openable: its row has «Öffnen» / «Erneut öffnen», and a type with only opened files shows
  «<Typ> erneut öffnen» in the panel (`open-groups.ts`, pure + tested). Status text: «Geöffnet — noch nicht importiert».
- Dropping the same file twice is skipped with a message (same name, size and date).
- A hand-over nobody picked up expires after 2 minutes, so it cannot surprise a later manual visit to that screen.
- A tenant switched on another page while files waited now clears the list when /import is opened again (was only caught on /import).
- Gastronovi KPI CSVs (Anzahl Personen, Umsatz pro Person, Durchschnittsbon) are recognised via the import's own CSV parser.
- Verified in the browser per file type (Tagesdaten, KPI CSVs, Z-Bericht PDF, Reservationen, sales upload ×4, category analysis,
  Mirus, reviews): file arrives in the target screen; nothing imported.
- Weekly card chips: a Gastronovi KPI file now covers only the source it feeds (Anzahl Personen → Gäste/Anzahl, Durchschnittsbon →
  Durchschnittsverkauf, Umsatz pro Person → none of the 8). Before, any KPI file showed on both rows with «+2».
- File rows redesigned: icon + name + status | type dropdown (the app's own Select, fixed width) | Öffnen | remove, with no overlap;
  on narrow screens the dropdown takes its own line. Status texts shortened («Bitte den Typ selbst wählen.», no repeated «erkannt»).
- One action per thing: the panel «Bereit zum Öffnen» is the main way to open files. Rows get a small «Nur diese öffnen» button only when
  several files of the same type wait (so one of them can be picked); single-file types are opened from the panel only.
