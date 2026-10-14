# Phase 1 — Fixes Summary (short version)

Quick-reference list of what was broken and what was fixed, for client/status updates.
Each entry: the problem in plain terms, the fix, and how to verify it yourself in the app.
For full technical detail see `personal-cost-tracker-issues.md` (issue list) and
`personal-cost-tracker-changelog.md` (dated change log).

---

## 1. Shifts/edits could silently not save ("false success" bug)

**Problem:** In several places, the app showed a success message (or closed the dialog) even
when the save to the database had not actually finished or had failed — so the screen looked
right, but the data wasn't saved, and the next page refresh would show the old data again.
Found in: schedule templates, bulk shift actions, days-off config, actual-hours entries,
employee edit form, recipe/base-component costing, product groups, import settings.

**Fix:** Every one of these now waits for the database write to confirm before showing success
or closing the dialog. If the write fails, you now get a clear error message instead of a
false "saved" message.

**How to test:** Pick any of the above (e.g. apply a schedule template, edit a day-off config,
save a recipe cost). Turn off your internet connection, try to save, and confirm you now get
an error toast instead of the dialog just closing as if it worked. Turn internet back on,
retry, confirm it saves and a real success message appears. Reload the page afterward to
confirm the data is actually there.

## 2. Nine more unprotected pages

**Problem:** Nine pages (Import, Produkte, Artikel-Tracking, Sales-Upload, Produkt-Analyse x2,
Produkt-Stamm, Lieferanten, Lieferanten-Vergleich) had no access check — anyone with a login
link could open them regardless of role, the same class of bug as 4 pages fixed the day before.

**Fix:** Added the same role/permission checks already used elsewhere in the app to all nine
pages.

**How to test:** Log in as a non-admin role (e.g. `service_manager` or `kueche_manager`) and
try to navigate directly to each of the nine page URLs above — confirm you're blocked/redirected
instead of the page loading.

## 3. Database access gaps (RLS) — ~30+ tables

**Problem:** A wider audit found roughly 30 database tables where any logged-in user could read
or write rows regardless of role or which restaurant (Oliv/Beaulieu) they belonged to — wages,
HR/onboarding data, guest data, timesheets, scheduling data, and more.

**Fix:** Two migration files add real per-role, per-restaurant access rules at the database
level for all of them, on top of the first batch fixed the day before (wages, employees,
supplier invoices). Every table these migrations touch was individually confirmed to belong to
this project (cross-checked against this project's own database setup history) — see
"Database verification" below for why this matters.

**How to test:** Not testable in the browser — this is enforced in the database itself. Can be
confirmed in the Supabase dashboard after a migration is applied (table → RLS policies tab)
once applied.

## 4. Two urgent credential/password gaps

**Problem:** The stored admin password and some third-party access tokens could be read by any
logged-in user, not just admins.

**Fix:** Locked both down to admin-only (and admin/Beaulieu-manager where relevant) at the
database level.

**How to test:** Same as #3 — database-level, confirmed via Supabase dashboard once applied.

## 5. Login button could get stuck after a network error

**Problem:** If the login request failed at the network level (not just wrong password — an
actual connection failure), the loading spinner never stopped and the login button stayed
disabled, with no error shown.

**Fix:** Added proper error handling so any login failure — wrong password or network issue —
now shows a message and re-enables the button.

**How to test:** Turn off your internet, try to log in, confirm you get an error message and
the button becomes clickable again (rather than staying stuck spinning).

## 6. Budget/reporting data was being cached on devices that shouldn't see it

**Problem:** Financial/reporting data was being synced to every logged-in user's browser
storage on login, even roles whose screens don't show that data at all (e.g. kitchen managers).

**Fix:** That sync now only happens for roles that actually have finance access (admin,
Beaulieu manager).

**How to test:** Log in as a non-finance role, open browser dev tools → Application →
Local Storage, confirm the finance-related keys (`reporting_v1`, `budget_v1`, etc.) are no
longer being written for that account.

---

## Database verification (for peace of mind — shared database)

Since this Supabase database is also used by other projects, every table referenced across all
four new migration files was individually checked against this project's own database setup
history (not just what the live app currently queries) before being included — confirming each
one genuinely belongs to this project, not another one sharing the same database. Every access
rule was also checked against that table's actual columns to confirm it will apply cleanly. No
tables outside this project's own schema were touched.

## Code verification

- Type-check (`npx tsc --noEmit -p tsconfig.app.json`) and the automated test suite
  (`npx vitest run`) both started at a known pre-existing baseline (252 type errors; 23 failed
  test files / 36 failed tests out of 300 files / 4,733 tests), confirmed byte-for-byte identical
  to the state before any of this work by diffing against the last commit with everything
  stashed out — so none of it was caused by this batch of fixes.
- That baseline wasn't just left alone, though — see "Pre-existing issues fixed in passing" below.

## Pre-existing issues fixed in passing

While verifying the baseline wasn't masking anything, a few of the errors in it turned out to be
real, worth fixing on their own:

- **Swiss number formatting (`1'000.00` vs `1'000.00`):** the app's number formatting relies on
  the browser/Node's own locale data for the thousands-separator character, which isn't
  guaranteed consistent across environments — so the exact separator a user saw could silently
  vary by browser. Fixed by forcing the correct character everywhere it's used, instead of
  trusting the runtime. This alone cleared 18 of the 36 known test failures.
- **CSV hours-import button showed "undefined undefined" for every employee name** — a live,
  admin-facing feature (`/import`) was built against employee first/last-name fields that don't
  exist in this app's data model (employees only ever have one combined `name` field). In
  practice this meant the downloadable CSV template had a useless placeholder name on every row,
  and no uploaded CSV could ever match an employee by name. Fixed to use the real field; matching
  logic preserved (still handles "Last First" vs "First Last" order in the CSV).
- **Vehicle-cost accounts (6200–6299, "Fahrzeugaufwand") could disappear from the P&L** — these
  accounts were set up as a real cost category but the category itself was never added to the
  type that tracks valid P&L categories, and in 3 of 4 places that route a categorized
  transaction to its P&L line, a missing category meant the amount was dropped entirely instead
  of showing under operating costs. Fixed.
- **A few `"manual_entry"` vs `"manual"` mismatches** in the P&L page's manual-entry save calls —
  cosmetic at the type level, but worth using the one value consistently rather than two
  near-identical ones. Fixed (8 call sites + matching test fixtures).

**Flagged, not fixed — needs a decision, not a guess:** one test (`pl-account-classification`)
asserts that account 4800 counts as "Betriebskosten," but the actual code deliberately treats
4800 as a neutral deposit/Pfand account (per an explicit code comment dated 2026-08) and excludes
it from both cost buckets. Functionally this doesn't change the Warenkosten-Quote either way, but
it touches real cost classification, so it's flagged for a decision rather than guessed at. See
issue tracker.

## New finding — 19 database tables were never created in production

Applying the 4 RLS migration files failed immediately: a table it expected (`imap_email_settings`)
doesn't exist. Checking further found **19 tables this app's own code depends on were never
actually created in the live database** — some as far back as January 2026. This is a separate,
pre-existing gap, unrelated to the RLS/permissions work; it just happened to surface while
applying those migrations.

Of those 19, 6 are genuinely broken right now, in two groups:

- **1 table shows up on a page reachable from the normal menu**: `capacity_settings` (Settings
  page).
- **5 tables are on pages that technically exist but have no menu entry pointing to them at
  all** — `app_kv_store` (Produkte), `product_sales_reset_log` (Sales-Upload), and three tables
  behind an old revenue-entry screen (`group_reservations`, `email_imported_reservations`,
  `fortelable_settings` — superseded by the current home page, marked "Legacy" in code, zero links
  anywhere in the app). Just as broken, but only reachable by typing the URL directly, not by
  clicking around the app normally.

(Artikel-Tracking and Artikel pages were checked too — they don't touch any of the 19 missing
tables, they use a different, already-live storage mechanism. Not broken by this gap.)

The other 13 are tables behind part of the Events/Reservations area that was built but never
wired up to any page, plus a couple of other written-but-never-shipped tables — not a currently-
broken screen, just unfinished work sitting dormant. Full breakdown and exact pages affected:
`docs/personal-cost-tracker-missing-tables.md` (issue #11).

**Update (2026-10-01):** checked both sides before deciding what to actually create — not just
whether a page links to this code (frontend), but whether anything server-side still touches it
(backend). 6 background jobs reference 10 of these 19 tables in their code, but you confirmed none
of those jobs are actually scheduled or running. So of the 19 at that point: 10 looked like they
were being created, 9 were not (the fully-dead Events/Reservations tables) — moved out of what
gets applied.

**Update (2026-10-14), after the client meeting confirmed scope — add only what's necessary, defer
new/half-built work:** a closer look at those "10 being created" found 4 more with zero code
reference anywhere, frontend or backend — `articles`, `daily_revenues`, `sales_upload_log`,
`suppliers` — each one explicitly a not-yet-built future stage per its own migration file's
header (e.g. "Stage 2 migration," "replaces the dailyBudgets JSON blob"), not something any live
page currently needs. **Real count: 6 tables are being created, 13 are not.** Nothing user-facing
changes from this; it only trims what gets built today to exactly what's load-bearing.

## Still pending (not part of this batch)

- **Applying to production.** The 6 still-needed missing tables (5 migration files in
  `supabase/migrations_pending/missing_tables/` — the 13 confirmed-dead/not-yet-built ones excluded
  to that folder's `not_applying_confirmed_dead/` subfolder) plus the 4 RLS migration files were
  applied and verified successfully on staging on 2026-10-14. Production has not been run yet —
  same 9 files, same order, still a manual step in the Supabase dashboard.
- A column-level fix to fully hide wage amounts from roles that can see the rest of an
  employee's row (currently those rows are correctly restricted by restaurant, but the wage
  columns aren't separately hidden within a row the role can otherwise see).
- Three remaining access-design decisions flagged for a product call, not a code question (see
  `personal-cost-tracker-issues.md` issue #7): the Gastronovi import-data tables, three
  reservation tables with no restaurant tagging at all, and whether the shared product catalog
  should be split per restaurant.
- Client clarification on where exactly "stale dashboard data" (issue #8) is being seen.
