# Pending migrations — not yet applied to production

`supabase/migrations/` is the client's already-applied history — every file in there has already
been run against the live database. This folder is separate on purpose: everything here has been
written and reviewed but **not yet run against production**, so this folder is always the answer
to "what do we still need to apply."

## How to use this folder

1. **Applying to production:** run `missing_tables/` first (see below), then the 4 RLS files in
   filename order at the top level (they build on each other — phase 2 reuses functions phase 1
   defines) via the Supabase SQL Editor, same as every other migration in this project (no live
   CLI/DB access from this environment, manual-apply-only).
2. **After a file has been applied to production**, move it into `supabase/migrations/` (`git mv`)
   so that folder stays the source of truth for what's actually live.
3. **New migrations go here first**, not directly into `supabase/migrations/` — move them over
   only once confirmed applied.

## `missing_tables/` — apply this subfolder FIRST

5 migration files (dated 2026-01-22 through 2026-05-08, **not written this week** — part of the
project's original history) that create 6 tables to apply now: `capacity_settings`,
`group_reservations`, `email_imported_reservations`, `fortelable_settings`, `app_kv_store`,
`product_sales_reset_log`.

**`missing_tables/not_applying_confirmed_dead/`** holds 8 more files (13 more tables) that are
**not** part of this apply, in two groups — see that folder's own README before touching it:
- **9 tables** (Events/Reservations module + timesheet approval): confirmed dead both frontend
  (zero importers, moved to `src/_deprecated/`) and backend (no active cron/Edge Function,
  confirmed with client). A 10th table in this group, `fortelable_reservations`, isn't a separate
  file — its `CREATE TABLE` was stripped directly out of `20260122162412_2c8c45cc-...sql`, which
  also creates two still-needed tables.
- **4 tables** (`articles`, `daily_revenues`, `sales_upload_log`, `suppliers`): zero code reference
  anywhere, frontend or backend — each is a not-yet-built future stage per its own migration
  file's header, not a currently-missing dependency. Found 2026-10-14 on a closer pass after the
  client confirmed scope should be "only what's necessary, defer half-built work."

Several of the 4 RLS files below reference the 6 tables being applied directly, so this subfolder
must go first. They were also edited to drop policies for the 13 tables not being created — see
each file's inline comments at the removal site. Full breakdown:
`docs/dev/personal-cost-tracker-missing-tables.md`. Found when the first RLS migration below failed on
`imap_email_settings` not existing — which, after this cleanup, is one of the tables no longer
being created at all (see `not_applying_confirmed_dead/`).

## Top-level files — apply after `missing_tables/`, in this order

1. `20260928_urgent_credential_and_profile_lockdown.sql` — locks down `user_profiles` and
   `fortelable_settings` (plaintext API key) to admin/Beaulieu-manager only. **Depends on
   `missing_tables/`** for `fortelable_settings`. (Originally also covered `imap_email_settings`/
   `external_api_settings` — those policy blocks were removed 2026-10-01, see inline comment in
   the file; neither table is being created.)
2. `20260928b_rls_phase1_wages_financial.sql` — defines the shared predicate functions
   (`role_can_access_tenant`, `role_can_see_wages`, etc.) and applies them to `employee_wages`,
   `employees`, `schedule_extra_cost_people`, and the Warenrechnungen cluster
   (`supplier_documents`, `supplier_document_splits`). (The `suppliers` policy block was removed
   2026-10-14 — see inline comment; `suppliers` is not being created.)
3. `20260929_urgent_password_and_stray_credential_lockdown.sql` — locks down the admin password
   in `app_settings`, `department_access_tokens`, and `app_kv_store`. **Depends on
   `missing_tables/`** for `app_kv_store`.
4. `20260929b_rls_phase2_hr_financial_operational.sql` — the wider second-pass audit: HR/
   onboarding, timesheet lifecycle, core scheduling, operational-config, accounts payable,
   statutory minimum wage, and the guest/reservation cluster (~30 tables total). Depends on
   predicate functions defined in file 2 above — must be applied after it. (`timesheet_month_exclusions`/
   `timesheet_month_inclusions` were removed 2026-10-01 from the dynamic table-name array this
   file uses for the timesheet cluster; the whole `daily_revenues`/`sales_upload_log` policy block
   was removed 2026-10-14 — see inline comments; none of these 4 tables is being created.)

All four were verified against this project's own database-setup history (every table confirmed
to belong to this project, not another one sharing the same Supabase instance) and against each
table's actual columns — see `docs/client/personal-cost-tracker-summary.md` for the plain-English
version of what each one does and `docs/dev/personal-cost-tracker-issues.md` issue #7 for the full
technical audit. That verification was against this repo's migration *history*, not the live
database's actual current state — which is what caught the `missing_tables/` gap above.
