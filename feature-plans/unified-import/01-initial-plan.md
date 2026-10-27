# Feature 2 — One import area (Unified Import) — Draft

Status: **Draft for approval, no code.** CRM task 39927 (Phase 2). Feature 3 (photo/PDF import with AI fallback)
is out of scope, but the routing is designed so it can plug in later.

## 1. Current state (as of 2026-10-27; source code read, import lines traced with a script)

Reachability: (a) = clickable in the navigation · (b) = real route/code, but only via direct URL or a
conditional link · (c) = dead. Nav entries checked in `AppNav.tsx`, routes in `App.tsx`.

| # | Entry point | File(s) | Accepts | Detection today | After parsing | Reachable |
|---|---|---|---|---|---|---|
| 1 | Daily-data upload (revenue actual/prior year, guests, avg. receipt, revenue per guest, marketing) | `ImportHub.tsx` `TagesdatenImportSection` + `lib/tagesdaten-auto-import.ts` | .xlsx/.xls | **Auto-detection already exists** (filename first, then content), but only as a *suggestion*; the user must confirm the type; year comes from a dropdown | Preview → save (`commitGastronoviDays`, `saveGaesteDaily…`, `saveMaisonDailyMergeStrict`) | (a) `/import` |
| 2 | Z-Bericht / KPI PDF + CSV | `GastronoviZBerichtPage.tsx`, `gn-zbericht-pdf-parser`, `gn-kpi-pdf-parser`, `gn-kpi-csv-parser` | .pdf, .csv (multiple) | `detectGnPdfReportKind` (title line); CSV via KPI parser; max. 1 file per report kind | Wizard with conflict/overlap checks → `saveGnImport` | (b) `/gastronovi-import` (card in Import Center; nav entry not checked) |
| 3 | Z-Bericht inbox (e-mail) | `ZberichtInboxCard`, `zbericht-auto-import.ts` | server inbox | PDF kind detection | Auto-import, daily reports only | (a) on `/import` (admin only) |
| 4 | Sales data Food/Beverage | `VerkaufsdatenImportSection`, `verkaufsdaten-import.ts` | .txt/.tsv/.csv/.xls, multiple | `parseVerkaufsdatenFile` (total row → category) | Preview plan `buildVkPlan` → save | (a) `/import` |
| 5 | Product sales (Sales Upload) | `SalesUpload.tsx`, `gastronovi-csv-parser.ts` | .csv (count/revenue pairs, Food+Beverage) | Column structure (`parseWideFile`) | Batch, delete-before-insert per period, tenant-scoped | (a) `/sales-upload` (card; allowBeaulieu) |
| 6 | Prior-year revenue | `AnnualRevenueImportSection`, `annual-revenue-import.ts` | .xlsx | fixed | Per-year lock (`prior-year-lock`) | (a) `/import` |
| 7 | Prior-year costs | `AnnualCostImportSection`, `pdf-import-engine.ts` | .xlsx/.pdf (Sage account sheet) | file extension | `replaceAnnualCostYear` | (a) `/import` |
| 8 | Prior-year personnel costs | `AnnualPersonnelCostImportSection` | .xlsx | fixed | Per-year lock | (a) `/import` |
| 9 | Prior-year daily revenue | `VjDailyImportSection` | .xlsx | fixed | `vj-daily-supabase` | (a) `/import` |
| 10 | Actual hours (Mirus) | `IstStundenSection` → `ActualHoursImportButton`, `HoursCSVImportButton`, `OpenHoursSection` | .xls/.xlsx, .csv | extension/structure | Mirus reconciliation (`mirus-import-engine`), employee mapping, locked days skipped | (a) `/import` |
| 11 | Mirus preview page | `MirusImportPreview.tsx` | .xlsx | fixed | Preview | (b) route `/mirus-import-preview` (admin); link not checked |
| 12 | Cost / account-sheet import | `CSVImport.tsx` (`/csv-import`) | .csv/.pdf/.xlsx, **single file only** | extension → kind | Preview → `reporting-store` | (b) `/csv-import` (card) |
| 13 | Foratable reservations + guests | `ForatableImportPage` embeds `ReservationenImportPage` + `GaesteImportPage` | .csv | Header mapping by column name (`headerOk`, `headerMissing`) | Self-check → `import_runs` | (a) `/foratable-import` (card) |
| 14 | Goods: invoice PDFs, creditors, Feldschlösschen, Beaulieu PDF, manual bookings | `Warenrechnungen.tsx` + `components/waren/*`, `waren-pdf-erkennung.ts`, `profil-pdf-parse` | PDF/CSV | Supplier matching by name/alias, OCR fallback | **Saves only after user confirmation** in the form | (a) `/warenrechnungen` |
| 15 | OP list | `OpListe.tsx` → `OpImportDialog`, `op-liste-parser` | file | fixed | Dialog | (a) `/op-liste` |
| 16 | Schedule Excel + kitchen-plan PDF | `SchedulePlanner.tsx` ⋮ menu (`handleImportClick`, `KüchenplanImportDialog`), `MirusReconcileImportButton` | .xlsx / .pdf | fixed per menu item | Preview dialog, kitchen plan with undo | (a) `/personal` |
| 17 | Adyen reconciliation | `AdyenAbgleichSection` in `TagesabschluessePage` | .csv | fixed | Reconciliation | (a) `/tagesabschluesse` |
| 18 | Employee Excel, Beaulieu seeds | `EmployeeImportExportButtons`, `BeaulieuMitarbeiterSection`, `BeaulieuBudgetImportSection` | .xlsx | fixed | direct / Beaulieu only | Employee buttons only via `PersonnelTab` (see below); Beaulieu sections (a) `/import` when tenant is Beaulieu |
| 19 | Budget, reviews, staffing/control list | `Budget.tsx`, `Rezensionen.tsx` (`feedback-import`), `BesatzungProduktivitaetPage` (`control-list-import`) | .xlsx/.csv | fixed | own pages | (a) per nav entry |

**Special case `/overview`:** `Index.tsx` → `PersonnelTab`/`RevenueTab`/`ScheduleTab` carries `SmartImportButton`,
`PlannedHoursImportButton`, `RevenueImportButton`, `HourlyRevenueImport`, `EmployeeImportExportButtons`.
The chain is traced up to `Index.tsx` (its only importer) → route `/overview`, which per CLAUDE.md has no nav
entry → **(b), not in scope** (do not touch or extend). `excel-type-detector.ts` has `SmartImportButton` as its
only importer, so it is also reachable only via `/overview`.

**Not yet traced to the nav:** nav entries for `/gastronovi-import`, `/csv-import`, `/foratable-import`
(the Import Center cards are confirmed, the nav is not). `MirusParserTest`/`MirusExcelTest` are test routes
(admin) and out of scope.

## 2. Findings that shape the design

1. **A mini version of this feature already exists** (#1). Deliberate decisions of the existing code:
   auto-detection is only a *suggestion*, saving needs user confirmation, the year never comes from the file.
   We keep these guardrails.
2. The parsers have **no common interface**: each import ties parsing, preview UI and saving together in one
   large component (`ImportHub.tsx` is 4,639 lines). "Reuse the existing processing" therefore means
   **handing the file over** to the existing flow, not calling parsers and saving ourselves.
3. Several types are **ambiguous at file level** (e.g. "Durchschnitt": average per receipt vs. per person;
   daily xlsx data needs a year; Z-Bericht day vs. period). Pure auto-detection would be unsafe here.
4. Roles/tenants: `/import` is admin-only (Beaulieu roles see cards); data paths are tenant-scoped via
   `useTenant()`; some types are Oliv-only or Beaulieu-only.

## 3. Recommended design — "recognise and hand over" (option B)

**One drop zone at the top of the Import Center (`/import`)**, multi-file drop of mixed files
(.xlsx .xls .csv .pdf .txt .tsv).

### Flow
1. **Classify** (pure function `classifyImportFile(file) → {type, confidence, reason, alternatives[]}` in
   `src/lib/unified-import/`): stages file extension → file name → content (header row / first cells / PDF
   title line). It **calls the existing detectors** instead of copying them: `suggestTagesdatenTyp`,
   `detectGnPdfReportKind`, the `parseVerkaufsdatenFile` header check, Foratable `buildHeaderMap`, goods PDF detection.
2. **Result list per file** (name, detected type, confidence, status): `Recognised` · `Please confirm`
   (ambiguous, type picker) · `Not recognised` · `No permission` · `Error`.
3. **Hand over:** "Process" opens the **existing flow** for each recognised type with the file pre-loaded
   (preview → confirm → save, as today, database-first). Files of the same type are bundled
   (e.g. several Z-Berichte, count+revenue CSV pairs).
4. **Nothing is saved silently.** Auto-import without a preview exists only where it already does today
   (Z-Bericht inbox).

### Technical core: handler registry
`ImportHandler = { id, label, accepts(file), classify(file), canAccess(ctx), route/anchor, takeFile(files[]) }`.
A new type (and later the AI fallback) is just another entry. **Feature 3 hook:** `classify` may return
`type: 'unknown'`; the router passes such files to an optional `fallbackHandler`
(unset today → status "Not recognised"; later AI/OCR).

### Unrecognised files
They stay in the list with a reason ("No known header row") and a manual type picker limited to the allowed
types; nothing is lost, nothing is guessed.

### Tenant & role
The active tenant (`useTenant`) applies to all files in the drop. Types the role/tenant may not use
(`canAccess` from `import-center.ts`) are listed as "No permission", not hidden. Switching tenant with an open
list discards the list (with a warning).

### Old buttons
They stay for now (cards/sections) and are collapsed under "Einzelimporte" in a second step. Removing them is
a client decision.

## 4. Alternatives
- **A — Only extend the daily-data zone:** small, but does not solve "7+ buttons"; PDFs and the other CSV types stay outside.
- **B — Recognise + hand over (recommended):** low risk, no parser or save path rewritten, a single place for detection.
- **C — Process everything inline in one wizard:** nicest UX, but the sections are 4,600-line single files with
  preview/save logic built in → high rework and regression risk; breaks "do not rewrite the parsers".

## 5. Decisions (2026-10-27)
1. **Always preview + confirm.** No direct save of recognised files.
2. **Old single buttons are collapsed** (under "Einzelimporte"), not removed.
3. **Scope: everything on `/import` for now** — the 9 categories in `import-center.ts` (cards and inline sections).
   Not in scope yet: schedule Excel / kitchen-plan PDF (planner), OP list, Adyen, `/overview`.
4. **Year dropdown stays** for daily data.
5. **Active tenant only** — no mixed Oliv/Beaulieu drop.

### Original open questions (answered above)
1. May clearly recognised files be saved directly **without a preview**, or always preview + confirm? (Recommendation: always confirm.)
2. Should the old single buttons disappear or stay collapsed?
3. Which types belong in the drop zone? (Proposal: everything on `/import` plus Foratable, sales data and goods PDFs;
   schedule Excel/kitchen-plan PDF stay in the planner because they need the week context.)
4. Year for daily data: keep the dropdown, or should the zone ask?
5. Mixed tenants in one drop (Oliv and Beaulieu files together)? Recommendation: no, active tenant only.

## 6. Non-goals
Rewriting parsers · `/overview` imports · `src/_deprecated/` · Feature 1 · AI detection (Feature 3) · new DB tables.

## 7. Conventions for the implementation
Code comments, docs and changelogs in English; only strings visible to the client in the app are German.

## 8. Detector audit (2026-10-27)

Each finding below was reproduced with a scratch test (deleted afterwards); the existing detector tests
(104 tests in 5 files) all pass today, so none of these cases is covered. Severity = what happens in the live
flow today. "Suggestion only" means the user still confirms the type, so nothing is saved silently.

| # | Detector | Weakness (reproduced) | Severity | Proposed fix |
|---|---|---|---|---|
| D1 | `tagesdaten-auto-import` `hasChfValue` | Any digit counts as money: a guest count file *without* "P." suffix (`Gesamt 300 280 310`) is detected as **umsatz** | High (wrong type suggested; saved as revenue if the user does not look) | A value is CHF only with a `CHF`/`Fr.` prefix/suffix or a decimal part; bare integers are "unknown" → no suggestion |
| D2 | `scanRows` label match | `l.includes('gesamt')`/`'total'`: "Gesamtanzahl Mitarbeiter" and "Zwischentotal Food" are detected as **umsatz** | High | Exact label match (`gesamt`, `total`, `gesamt - …` with a known category), not substring |
| D3 | `suggestTypFromFileName` | Substring matches: "Personenkosten Juli" → gäste, "Anzahl Bons" → gäste, "Umsatz Anzahl" → gäste, "Gaeste-Umsatz" → gäste. Name beats content (`suggestTagesdatenTyp`) | Medium (suggestion only, but it overrides correct content detection) | Word-boundary matches; when name and content disagree → no suggestion + "please confirm" with both candidates |
| D4 | `analyzeWertemuster` + `istHartBlockiert` | Revenue file with whole-CHF integers ≤ 5000 (`1200 1100 1300`) is classed "anzahl" and **hard-blocked** as umsatz | Medium (false block, not a wrong save; user is stuck) | Keep the hard block (safe direction) but only when the file has no CHF signal in label/header; otherwise warn instead of block. Needs your OK — this loosens a safety gate |
| D5 | `readFirstSheetRows` / `cellToString` | Real Excel **date** header cells become `"Wed Jul 01 2026 05:30:00 GMT+0530 (…)"` (timezone-dependent), so day columns are invalid | Medium | Format `Date` cells as `DD.MM.` (UTC) in `cellToString` |
| D6 | `readFirstSheetRows` | ExcelJS reads only real `.xlsx`; the drop zones accept `.xls` too and a legacy `.xls` throws "Can't find end of central directory…" | Medium | Detect the OLE header (`D0 CF 11 E0`) and return a clear classification reason "legacy .xls not supported — save as .xlsx" (classifier); parser behaviour unchanged |
| D7 | `detectGnPdfReportKind` | Body fallback: a KPI report whose first 30 lines merely mention "Z-Bericht" is classed **zbericht** (priority order, no title) | Medium | Body fallback may only return `unbekannt`/KPI kinds when the title line is missing; "z-bericht" in the body is not enough → `unbekannt` |
| D8 | `parseVerkaufsdatenFile` | Category regex `/food|speisen/` matches "Foodcost"; `hasChf = any cell contains CHF` also matches a label cell ("… ohne CHF Artikel" → umsatz) | Medium | Anchor category words (`\bfood\b`), check CHF only in value cells |
| D9 | all | Detectors return a bare type or `null`, no confidence/reason | Low (blocks the classifier) | New wrapper layer `classify.ts` returns `{type, confidence, reason, alternatives}`; existing function signatures stay unchanged |

Not yet audited (read at implementation time): Foratable guest/reservation header detection (only
`Res.Nr.` is required — a different CSV that happens to contain that column would pass), Sage account-sheet
`kind` detection by extension only, `profil-pdf-parse`/goods-PDF detection.

### Regression protection
- New test file per fixed detector with the exact reproduced cases above (red first, then green).
- A small **fixture corpus** `src/lib/unified-import/__tests__/fixtures/` (one minimal file per supported type,
  in-memory built, no real client data) and a table-driven test: each fixture must classify to exactly one
  type; every ambiguous fixture must classify to `confirm`; unknown fixtures to `unknown`.
- Existing 104 detector tests stay green; run them before/after each fix.

## 8a. Guiding rule (client direction, 2026-10-27) — supersedes the "proposed fix" column above

The existing detectors encode the **client's own conventions** (file-name keywords such as «Anzahl»/«Umsatz»/
«Maison», the «P.» suffix on guest counts, revenue with or without «CHF», Gastronovi PDF titles). The unified
import is built **on top of** them. Therefore:

1. **The existing detectors do not change behaviour for the client's conventions.** No tightening inside
   `tagesdaten-auto-import.ts`, `verkaufsdaten-import.ts` or `gn-pdf-lines.ts`. Protected by
   `src/lib/unified-import/__tests__/client-conventions.contract.test.ts` (18 tests, green on untouched code).
2. **Strictness lives in the new classifier layer.** It calls the old detectors, keeps their answer as the
   suggestion, and *lowers confidence* (status "Please confirm") when the evidence is weak. It never
   overrides the client's answer and never auto-processes: preview + confirm stays (decision 1).
3. Only pure **bug fixes with no effect on conventions** are made inside old code.

| # | Disposition |
|---|---|
| D1 bare integers read as CHF | **Not changed** — the revenue parser itself accepts amounts without «CHF» (`22331,80`, `1'234.50`); tightening would break real revenue files. Classifier: a type reached only through bare numbers → "Please confirm". |
| D2 `gesamt`/`total` substring labels | **Not changed in old code.** Classifier: label match not exact (`Gesamtanzahl …`, `Zwischentotal …`) → "Please confirm". |
| D3 file-name keywords | **Not changed** (client's naming is the rule). Classifier: name and content disagree → "Please confirm" showing both candidates; name still wins as the pre-selection, as today. |
| D4 hard block of whole-franc revenue | **Not changed** — the client's explicit rule («dürfen NIE als Umsatz gespeichert werden», real case 166/204/259 is a contract test). Dropped from the proposal. |
| D5 Date header cells | **Fix in old code** (additive): format `Date` cells as `DD.MM.`; today they are unusable, so nobody can depend on them. |
| D6 legacy `.xls` | **Classifier only**: clear reason «.xls is not supported, save as .xlsx». Old parsers untouched. |
| D7 PDF body mentions «Z-Bericht» | **Classifier only**: title wins as today; a kind found only in the body → "Please confirm". |
| D8 Verkaufsdaten `Foodcost`/«CHF» in label | **Classifier only**: weak category evidence → "Please confirm". |
| D9 no confidence/reason | New `classify.ts` wrapper. |
