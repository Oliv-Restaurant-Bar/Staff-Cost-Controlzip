# Guests, Reservations & the Import Center

This domain has two related but distinct halves:

1. **Guest CRM & reservation analytics** — everything under `/gaeste/*`. This is where the team looks up individual guests, spots regulars vs. at-risk/lapsed guests, runs return-campaigns, and analyzes reservation volume (by month, by weekday, vs. last year).
2. **The Import Center** — everything under `/import*`, `/csv-import`, `/gastronovi-import`, `/foratable-import`. This is where external data feeds get pulled into the app: POS daily-closing (Z-)reports, the reservation system's guest/booking exports, accounting ledgers (CSV/PDF), staff hours, and annual revenue/cost backfills. Nearly every number shown elsewhere in the app (KPIs, P&L, guest stats) ultimately originates from one of these import flows.

Both halves are admin-only by default; `beaulieu_manager` gets guest/reservation access (`canManageGuests`) but not most import screens, and `beaulieu_viewer` gets neither.

## Guest CRM & Reservations — pages

| Route | English name | Purpose | Role access |
|---|---|---|---|
| `/gaeste` | Guest CRM (list) | Searchable/sortable list of all guests for the active tenant, with automatic segmentation (VIP, at-risk, etc.), computed from reservation aggregates — there is **no separate CRM table**, it's all derived from `guest_profiles`/`reservation_records`. | `canManageGuests` (admin + `beaulieu_manager`); PII, no guest/read-only sessions |
| `/gaeste/auswertung` | Guests & Reservations report | Merged page (formerly two separate pages: "CRM Auswertung" + "Foratable Report"). Shows upcoming reservations as clickable KPI tiles with drill-down, a compact calendar, a day-detail popup, CRM tabs (overview / return-potential / campaigns), and a classic collapsible report (metrics, status, best times). | `canManageGuests`, gated on both the route and the data-loading effects |
| `/gaeste/analyse` | Reservation analysis (consolidated) | Merges the old "Month vs. prior year" and "By weekday" pages into one, with a global metric toggle (persons vs. reservations), date-range picker, and three tabs. Click a month → day-comparison popup; click a weekday → composition popup. | Admin only (not `beaulieu_manager`) |
| `/gaeste/wochentag` | Reservations by weekday | Deep-dive: which weekdays get the most/fewest reservations, including configurable "seasons" (e.g. winter season Oct–Dec) and holiday-period analysis. No nav entry — reached via links from `/gaeste/analyse`. | Admin only |
| `/gaeste/vorjahr` | Month actual vs. prior year | Month-by-month reservation/person counts vs. the same month last year, with day-level drill-down popup. No nav entry — reached via links from `/gaeste/analyse`. | Admin only |
| `/gaeste/duplikate` | Guest duplicates | Finds likely duplicate guest records by normalized phone number, lets an admin pick a "master" record and merge duplicates into it (reservations + manual CRM data move to the master; duplicates are deleted). | Admin only |
| `/gaeste/:guestId` | Guest detail (customer file) | Full record for one guest, two tabs: "Overview" (visit behavior, preferences, risk, CRM score — all computed live/read-only from `reservation_records`) and "CRM" (manually maintained fields/flags/notes in `guest_crm_profiles`, editable, and explicitly does **not** feed back into the computed segment/score). | `canManageGuests` |
| `/rezensionen` | Reviews (manual entry) | Manual logging of Google/TripAdvisor/Lunchgate reviews (date, star rating, optional screenshot, note) — **not** connected to any review-platform API, purely a manual back-office form. Also does weekly star-rating tracking (same view as shown in the cockpit). | View: admin (incl. read-only "guest" sessions) + `beaulieu_manager`; editing is gated inside the page itself |

## Import Center — pages

| Route | English name | Purpose | Role access |
|---|---|---|---|
| `/import` | Import Hub | The main import landing page — a large page bundling many import sections: daily revenue (VJ/prior-year), sales-data import, employee Excel import/export, annual revenue backfill, annual personnel-cost backfill, Sage PDF/CSV accounting import, actual-hours CSV import, and "prior year lock" controls (locking a year against further import once finalized). | Not separately guarded in `App.tsx` — page itself assumes admin-level use |
| `/import-cockpit` | Import Cockpit | Read-only overview of import health across four sections: "Today" (due tasks for the current month), "This Week" (weekly tasks/checks), "This Month" (progress + inventory checkboxes), "Data freshness" (per-source staleness status). Only *reads* import status; writes are limited to the cockpit's own settings/checklist blobs. | Admin only, no guest sessions |
| `/csv-import` | Accounting import (CSV/PDF) | Unified wizard for importing accounting ledgers from Banana, AbaNinja, Bexio, or Sage — either as CSV or as PDF "Kontoblatt" (account statement). Steps: upload+configure → preview matched/unmatched rows → confirm & save. | Admin only |
| `/gastronovi-import` | Gastronovi Z-report import | Imports daily closing (Z-)reports from the Gastronovi POS system, as PDF (standard + extended: daily revenue, payment types, time-of-day sections, customer cards, product line items) plus a separate "guests & average-check" PDF import (up to 3 PDFs at once). CSV import here is legacy — old CSV imports stay visible in history, but new imports go through PDF only. | Admin only |
| `/foratable-import` | Foratable import (reservations + guests) | A tabbed shell around two **embedded** page components — `ReservationenImportPage` and `GaesteImportPage` — plus a shared, DB-backed import-history tab. The active tab is controlled by `?tab=` (`reservationen` default, `gaeste`, `verlauf`), and both embedded pages stay mounted (`forceMount`) so in-progress upload state survives tab switches. **Important:** `ReservationenImportPage.tsx` and `GaesteImportPage.tsx` are not separate routes — confirmed by reading this file's imports (`import ReservationenImportPage from './ReservationenImportPage'` etc.) — they only render inside this page. | Admin only, no guest sessions |
| `/reservationen-import`, `/gaeste-import` | (redirects) | Both redirect to `/foratable-import` (with `?tab=gaeste` for the latter) — old direct routes kept as redirects so no link breaks. | — |
| `/foratable-report` | (redirect) | Redirects to `/gaeste/auswertung` — legacy route name. | — |

## Data flow

**Guest CRM/reservations:** pages read from the `reservation_records` and `guest_profiles` tables (tenant-scoped) via `src/lib/reservation-crm-db.ts` (`fetchGuestProfiles`, `fetchReservationsInRange`, `fetchCompletedVisitAggregates`, `fetchGuestById`, etc.), then run pure calculation/formatting logic in sibling files with no `-db` suffix:
- `src/lib/reservation-crm.ts` — segment classification, list metrics, return-risk ratio.
- `src/lib/reservation-dashboard.ts` — dashboard KPI/return-potential calculations (used by `/gaeste/auswertung`).
- `src/lib/reservation-yoy-utils.ts` — year-over-year comparison math (used by `/gaeste/analyse` and `/gaeste/vorjahr`), described in code comments as "pure, tested".
- `src/lib/reservation-weekday-analytics.ts` — weekday aggregation + season/holiday logic (used by `/gaeste/analyse` and `/gaeste/wochentag`).
- `src/lib/reservation-analyse-utils.ts` — the heatmap/matrix calculations behind the consolidated analysis page.
- `src/lib/reservation-guest-profile.ts` — per-guest CRM score, preferences, visit trend (used by `/gaeste/:guestId`).
- `src/lib/guest-crm-profile-db.ts` / `guest-crm-profile.ts` — the manually-edited CRM fields (`guest_crm_profiles` table), explicitly separate from computed metrics.
- `src/lib/guest-duplicates-db.ts` / `guest-duplicates.ts` — duplicate detection + merge logic for `/gaeste/duplikate`.
- `src/lib/crm-activities-db.ts` / `crm-activities.ts` — CRM follow-up activity log shown on the guest detail page.
- `src/lib/reservation-campaigns.ts` — the "campaigns" tab on `/gaeste/auswertung` (predefined guest-outreach segments).
- `src/lib/foratable-report-db.ts`, `foratable-future-db.ts`, `foratable-future.ts` — the legacy "Foratable Report" numbers now folded into `/gaeste/auswertung`.

**Reviews:** `/rezensionen` reads/writes via `src/lib/reviews-store.ts` (a tenant-prefixed KV blob `reviews_data:<tenant>` plus Supabase Storage for screenshots), with `src/lib/feedback-import.ts` handling bulk CSV import of external feedback exports.

**Import Center:** each import screen has its own parser + persistence pair, e.g.:
- `src/lib/gn-zbericht-pdf-parser.ts` / `gn-zbericht-db.ts` — Gastronovi Z-report PDF parsing and storage, plus `gn-kpi-pdf-parser.ts` (guests/average-check PDFs) and `gn-personen-db.ts`.
- `src/lib/csv-import-engine.ts` / `pdf-import-engine.ts` — the generic accounting CSV/PDF matching engine behind `/csv-import`, writing through `src/lib/reporting-store.ts` (`saveMonth`, `saveJournalEntries`).
- `src/lib/import-runs-db.ts` / `import-runs.ts` — the shared import-history log shown in the Foratable import "history" tab and elsewhere.
- `src/lib/import-cockpit-db.ts`, `import-tasks-db.ts`, `import-settings-db.ts`, `import-cockpit-checks-db.ts` — the data behind `/import-cockpit`'s freshness signals, task coverage, and manual checklist completions.
- `src/lib/annual-revenue-import.ts`, `annual-personnel-cost-import.ts` — one-off annual backfill parsers used from the Import Hub.
- `src/lib/prior-year-lock.ts` — locks a fiscal year against further edits once it's been finalized/imported.

## Key files

| File | Purpose |
|---|---|
| `src/lib/reservation-crm-db.ts` | Supabase reads for guest/reservation data (the read layer both CRM pages and analysis pages share) |
| `src/lib/reservation-crm.ts` | Pure guest segmentation & list-metric logic |
| `src/lib/reservation-yoy-utils.ts` | Pure year-over-year comparison math, reused by 3 pages |
| `src/lib/reservation-weekday-analytics.ts` | Weekday/season/holiday aggregation, reused by 2 pages |
| `src/lib/guest-crm-profile-db.ts` | Manually-edited CRM fields (separate from computed metrics) |
| `src/lib/guest-duplicates-db.ts` | Duplicate detection + safe merge |
| `src/lib/gn-zbericht-pdf-parser.ts` | Gastronovi POS Z-report PDF parser |
| `src/lib/csv-import-engine.ts` | Generic accounting CSV import/matching engine |
| `src/lib/reporting-store.ts` | Where imported accounting data ultimately lands (`saveMonth`/`saveJournalEntries`) |
| `src/lib/import-cockpit.ts`, `import-cockpit-db.ts` | Freshness/status computation behind the Import Cockpit |

## Non-obvious gotchas

- **No separate CRM table.** Everything shown on `/gaeste` and the guest detail page's "Overview" tab is computed live from `reservation_records` (and its aggregates) — there is no `guest_crm` table backing the numbers. Only the "CRM" tab fields (notes, manual flags) are persisted separately in `guest_crm_profiles`, and by design they never feed back into the computed segment/score/campaign logic. If a number looks wrong, check the reservation data, not a CRM record.
- **PII double-gating.** Every guest/reservation page gates access twice: once via the route guard in `App.tsx` (`RequireAdmin allowBeaulieu`, or `canManageGuests`), and again inside the page's own data-loading effect (so an unauthorized session doesn't even fire the guest-data fetch before the redirect kicks in). If you're testing access control, check both layers.
- **Admin "guest sessions" are a special read-only mode** that hides links to PII surfaces (`/gaeste`, `/gaeste/auswertung`) — mentioned in `docs/kpi-inventar.md`'s footnote. Don't be surprised if an "admin" test account doesn't see guest links; check whether it's flagged as a guest session.
- **Redirect chains exist for legacy URLs**: `/foratable-report` → `/gaeste/auswertung`; `/reservationen-import` and `/gaeste-import` → `/foratable-import` (with a `?tab=` param). These are intentional, not broken links — old bookmarks/emails may still use them.
- **`ForatableImportPage` is a tab shell, not two routes.** `ReservationenImportPage.tsx` and `GaesteImportPage.tsx` exist as files under `src/pages/` but are never routed directly in `App.tsx` — they're always rendered as tabs inside `/foratable-import`. If you're tracing "what renders at `/gaeste-import`", the answer is the embedded `GaesteImportPage` component inside `ForatableImportPage`, not a standalone route.
- **Tenant scoping.** All queries are tenant-filtered (`fetchReservationsInRange`, etc., take/derive `tenantId`); reviews use a tenant-prefixed KV key (`reviews_data:<tenant>`). `beaulieu_manager` is hard-locked to the Beaulieu tenant so this is mostly transparent for that role, but if testing as admin, double-check which tenant is active before concluding data is missing.
- **Reviews are entirely manual** — `/rezensionen` has no API connection to Google/TripAdvisor/Lunchgate; someone types in the star rating and optional screenshot by hand. Don't expect automatic sync.
- **CSV import at `/gastronovi-import` is legacy-only** — old CSV-imported data stays visible, but new imports must go through the PDF flow. If a fix touches Gastronovi import, confirm which path (PDF vs. legacy CSV) the bug actually affects.

No pages in this domain were found to be dead/orphaned — everything listed above is reachable from `App.tsx`'s route table, either directly or via the `/foratable-import` tab shell.
