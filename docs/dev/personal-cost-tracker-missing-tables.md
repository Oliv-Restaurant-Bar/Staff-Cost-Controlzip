# Missing tables — confirmed absent from both staging and production

## How this was found

Applying the pending RLS migrations (`supabase/migrations_pending/`) failed on the first
statement: `relation "public.imap_email_settings" does not exist`. Pulled the full `public` table
list (`select table_name from information_schema.tables where table_schema = 'public'`) from
staging, then production — identical on both. Diffed against every `CREATE TABLE` in this repo's
migration history.

**19 tables this app's migration history creates don't exist in either database.** Staging is a
full copy of production, so this isn't a copy artifact — the production check confirms the gap is
real.

The 13 migration files that create these 19 tables have been moved into
`supabase/migrations_pending/missing_tables/`. They're not new — dated 2026-01-22 through
2026-05-28, part of the project's original history, simply never applied.

**Update 2026-10-01, after Tier 3 below was confirmed fully dead (frontend and backend, see
"Not fully closed" note):** of these 19, only 10 were still being applied at that point. 9 (the
Events/Reservations module + timesheet approval) were removed from the migration files entirely —
5 files moved to `missing_tables/not_applying_confirmed_dead/`, 1 file (`20260122162412_...sql`)
edited to drop just `fortelable_reservations`. The 2 RLS files that referenced those 9 were edited
to match (policy blocks removed — see inline comments at each removal site).

**Update 2026-10-14, after a closer check of the remaining 10:** 4 of those 10 — `articles`,
`daily_revenues`, `sales_upload_log`, `suppliers` — turned out to have **zero code references
anywhere**, frontend or backend, same as the 9 above, just missed in the first pass because they
shared a migration file with tables that genuinely are needed. Each file's own header documents
this: `20260323_artikel_master.sql` says outright it's a "Stage 2 migration" not yet implemented
(app still uses `app_settings`); `20260507_daily_revenues.sql` says it "replaces the `dailyBudgets`
JSON blob" (app never switched over); `suppliers` is an optional, never-populated FK target in
`20260325_food_cost_tracking.sql` (`src/lib/supplier-documents-store.ts` never references
`supplier_id`, only free-text `supplier_name`). All 3 files moved to
`not_applying_confirmed_dead/`; the 2 RLS files that referenced `suppliers` /
`daily_revenues`/`sales_upload_log` edited to match. **Real apply count now: 5 files, 6 tables.**
13 of the 19 tables are excluded in total. Full rationale:
`supabase/migrations_pending/missing_tables/not_applying_confirmed_dead/README.md`.

One of these 13, `20260325_food_cost_tracking.sql`, creates 8 tables in total; 7 of them
(`products`, `product_ingredients`, `cost_pools`, `product_costpool_mapping`, `supplier_documents`,
`supplier_document_splits`, `sales`) already exist live and aren't part of this gap — only its 8th
table, `suppliers`, is actually missing. **Update 2026-10-14:** `suppliers` turned out to have no
code reference anywhere either (see below) — the whole file is now excluded, in
`not_applying_confirmed_dead/`, rather than applied for a table nothing uses.

## Reachability

Each table's consumer was traced through the real import chain to an actual route, and checked
against the real navigation config (`src/components/AppNav.tsx`) — not just whether a route is
registered in `App.tsx`. A registered route with no nav entry is only reachable by direct URL, a
materially different claim from "reachable in the app." Three tiers came out of that.

### Tier 1 — reachable from the persistent nav, confirmed broken

| Table | Reached via | Created by | Date |
|---|---|---|---|
| `capacity_settings` | `/settings` (Admin nav group) → `CapacitySettingsCard` → `useCapacitySettings.ts`. **Confirmed broken** — network tab shows `PGRST205: Could not find the table 'public.capacity_settings'`. | `20260213104606_...sql` | 2026-02-13 |

Worth clicking through now — `/settings`, confirmed in `AppNav.tsx`'s nav list.

### Tier 2 — route exists, real code queries it, nothing in the nav leads there

| Table | What's there | Created by | Date |
|---|---|---|---|
| `group_reservations`, `email_imported_reservations`, `fortelable_settings` | `/overview` (`Index.tsx` → `RevenueTab` → `SimpleRevenueInput.tsx`, queries all three directly). **No `AppNav.tsx` entry, zero in-app `<Link>`/`navigate()` anywhere in `src/`** — the route itself is the only reference, commented `// Legacy`. Direct-URL-only, more isolated than the other Tier 2 rows below (those at least have a conditional in-app link). | `20260122162412_...sql` / `20260126093715_...sql` | 2026-01-22 / 2026-01-26 |
| `app_kv_store` | `/produkte` (`ProdukteSeite`). No nav entry. 4 in-app `<Link to="/produkte">` occurrences across 3 files exist, all conditional: 2 in `LunchTab.tsx` (an alert banner + an empty-state card, both gated on `!hasLunchProducts`), 1 in `TakeAwayTab.tsx` (empty-state card, gated `!hasTakeAwayProducts`), 1 in `WesMarginWidget.tsx` (footer link, whole widget returns `null` when `topRows.length === 0`). A working instance may trigger none of these. | `20260319_app_kv_store.sql` | 2026-03-19 |
| `product_sales_reset_log` | `/sales-upload` → `ResetProductMonthDialog` → `resetProductSalesMonth()`. No nav entry, no in-app link anywhere. Direct-URL-only. | `20260508_product_sales_reset_audit.sql` | 2026-05-08 |

All 3 rows here are just as broken as Tier 1 — same `PGRST205`-style error — but only hit via
direct URL, a shared link, or (for `/produkte`) one of the conditional states above. Normal
click-through won't surface any of them; test by navigating to the URL directly.

### Tier 3 — confirmed dead, zero importers anywhere in `src/`

**Moved to `src/_deprecated/` on 2026-10-01** (components only — the tables themselves obviously
can't move). Verified safe: `tsc --noEmit -p tsconfig.app.json` after the move shows the same 219
pre-existing errors (zero new), `npm run build` succeeds with no new warnings. Full file list and
rationale: `src/_deprecated/README.md`.

| Table | Only referenced by | Status |
|---|---|---|
| `articles` | `/artikel` and `/artikel-tracking` (both live, hidden-but-routed per `AppNav.tsx`'s own header comment) sound like they'd use this table, but they actually store their data via `loadArtikelFromDB()`/`kvGet`/`kvSet` in `src/lib/artikel-store.ts`, which goes through the generic KV wrapper (`src/lib/supabase-kv.ts` → `appSettingsTable()` → hardcoded `.from('app_settings')`, confirmed by reading `src/lib/app-settings-table.ts`) under key `artikel_master_v1` — a table that already exists live. Zero `.from('articles')` anywhere in `src/` or `supabase/functions/`. These two pages are not broken by this table gap, and `articles` has no component to move — it's just an unused table, no frontend code at all. Its migration file's own header calls it a "Stage 2 migration" not yet implemented. **Moved to `not_applying_confirmed_dead/` 2026-10-14** (whole file `20260323_artikel_master.sql`). |
| `fortelable_reservations` | `src/_deprecated/components/ReservationsOverview.tsx`, `ReservationsBudgetCalculator.tsx` | Zero importers anywhere — unreachable from any route. These two files don't import each other or anything else in `_deprecated/` — two separate orphaned files, not one cluster. |
| `imap_email_settings`, `external_api_settings`, `external_api_import_log`, `department_notification_emails`, `event_notification_settings`, `event_notifications_log` | `src/_deprecated/components/events/*.tsx` + `components/tabs/EventsTab.tsx` | A separate orphaned tree from `ReservationsOverview.tsx` above (re-checked: `EventsTab.tsx` isn't imported by it — an earlier version of this doc wrongly implied they were one cluster based on a comment that merely *mentions* "EventsTab" in passing, not an import). `EventsTab.tsx` itself has zero importers anywhere. The entire Events/Reservations settings module (calendar, IMAP import, external API import, Fortelable sync, notifications, department email, file import) is dead code, not a live screen. |
| `timesheet_month_exclusions`, `timesheet_month_inclusions` | `src/_deprecated/lib/timesheet-exclusions-store.ts` → `src/_deprecated/pages/ArbeitszeitblaetterPage.tsx` | Not registered in `App.tsx` — matches this project's `CLAUDE.md`, already documented as orphaned. |
| `daily_revenues`, `sales_upload_log` | None | Meant to replace the `dailyBudgets` JSON blob in `app_settings` (per the migration's own header) — app code never switched over. Written, never shipped. `sales_upload_log` is its unused audit log. No component to move — pure unused tables. **Moved to `not_applying_confirmed_dead/` 2026-10-14** (file `20260507_daily_revenues.sql`), the two RLS files that referenced them edited to match. |
| `suppliers` | None (optional FK target of `supplier_documents.supplier_id`, nullable, `ON DELETE SET NULL`) | `src/lib/supplier-documents-store.ts` never references `supplier_id` — only free-text `supplier_name`. No component to move. **Moved to `not_applying_confirmed_dead/` 2026-10-14** (whole file `20260325_food_cost_tracking.sql` — its other 7 tables already exist live, so excluding it is a pure no-op for them), one RLS file edited to drop the `suppliers` policy block. |

**Resolved 2026-10-01 — backend checked too, not just frontend:** 6 Supabase Edge Functions
(`fetch-imap-emails`, `send-event-notifications`, `sync-fortelable`, `send-department-notification`,
`import-reservations`, `parse-reservation-email`) reference 10 of the 19 tables directly in source,
all configured `verify_jwt = false` (the pattern for unattended/cron/webhook invocation). `pg_cron`
is enabled in this project but no `cron.schedule(...)` call is tracked in any applied migration —
if a schedule existed it'd have been set up outside this repo's history, so static source alone
couldn't resolve this. **Client confirmed directly: no cron jobs or active Edge Function
deployments exist.** Tier 3 is fully dead, frontend and backend — the migration changes above
(tables removed from what gets applied) reflect that confirmation.

## Why this matters

Tier 1 and Tier 2 both hit a real Postgres failure in production, not a cosmetic bug — just
reached differently (normal click-through vs. direct URL/dead link/conditional link). Tier 3 needs
no UI testing; the open question is whether to finish it or delete it, not whether to fix a broken
screen.

## Next steps

1. ~~Confirm against production~~ — done, identical to staging.
2. ~~Check Edge Function/cron status~~ — done, client confirmed none active.
3. ~~Apply the 5 files in `missing_tables/` + the 4 RLS migrations~~ — **done on staging, 2026-10-14**
   (after fixing two missing-function gaps — `update_updated_at_column()`,
   `current_user_role()` — found while applying, see `personal-cost-tracker-changelog.md`).
   **Still pending on production** — same 9 files, same order, manual Supabase SQL Editor apply.
4. Check Tier 1 normally: `/settings`.
5. Check Tier 2 by direct URL: `/overview`, `/produkte`, `/sales-upload` — watch the network tab
   for `PGRST205`. (`/artikel` and `/artikel-tracking` don't need checking for this gap — they
   don't query the missing `articles` table, see Tier 3.)
6. **Still open, not a migration-blocking question:** delete the Tier 3 code permanently (it's in
   `src/_deprecated/`, confirmed dead both sides) or keep it there as reference in case the Events/
   Reservations module gets revived later? No longer gates applying the migrations above either
   way — resolved by excluding its tables, not by this decision.
