# NOT applying — confirmed dead or not-yet-built, both frontend and backend

**13 tables across 8 files, in two groups:**

## Group A — Events/Reservations module + timesheet approval (9 tables, confirmed dead)

5 files create 9 tables for the Events/Reservations settings module and the timesheet
approval page. **Do not apply these to production** unless the client decides to revive that
feature (see "Open decision" in `src/_deprecated/README.md`).

Confirmed dead on both sides, 2026-10-01:
- **Frontend:** zero importers anywhere in `src/`, not registered in `App.tsx`. Components moved
  to `src/_deprecated/`.
- **Backend:** 6 Supabase Edge Functions reference these tables in source
  (`fetch-imap-emails`, `send-event-notifications`, `sync-fortelable`, `send-department-notification`,
  `import-reservations`, `parse-reservation-email`) but the client confirmed no cron jobs or active
  Edge Function deployments exist — none of this runs server-side either.

| File | Tables created |
|---|---|
| `20260122173910_1621ec35-...sql` | `event_notification_settings`, `event_notifications_log` |
| `20260123102319_af9d3cca-...sql` | `department_notification_emails` |
| `20260126103206_8c6b8aba-...sql` | `imap_email_settings` |
| `20260126143829_a348d4ac-...sql` | `external_api_settings`, `external_api_import_log` |
| `20260528_timesheet_exclusions.sql` | `timesheet_month_exclusions`, `timesheet_month_inclusions` |

`fortelable_reservations` (the 9th dead table) isn't a separate file here — its `CREATE TABLE`
was removed directly from `../20260122162412_2c8c45cc-...sql`, which also creates
`group_reservations`/`fortelable_settings` (still live, needed by `/overview`). Stripped in place
rather than moved whole.

**If reviving:** move the relevant file(s) back to `../`, restore the corresponding RLS policy
blocks from git history (`git log -p` on the 2 edited RLS files, 2026-10-01 commit), restore
`fortelable_reservations`'s `CREATE TABLE` into `20260122162412_...sql`, and move the matching
components back out of `src/_deprecated/`.

## Group B — not-yet-built future stages (4 tables, no component to move)

3 more files, moved here 2026-10-14, create 4 tables that have **zero references anywhere** —
not just no frontend component (there's nothing to move to `src/_deprecated/`, since no component
ever existed), but no backend/Edge Function reference either, unlike Group A. Each file's own
header says explicitly it's for a future stage that was never implemented:

| File | Tables created | File's own header says |
|---|---|---|
| `20260323_artikel_master.sql` | `articles` | "Stage 2 migration... can be applied once Stage 2 is implemented. Stage 1 still uses `app_settings`." |
| `20260507_daily_revenues.sql` | `daily_revenues`, `sales_upload_log` | "Replaces the `dailyBudgets` JSON blob in `app_settings`" — app code never switched over. |
| `20260325_food_cost_tracking.sql` | `suppliers` (its other 7 tables — `products`, `product_ingredients`, `cost_pools`, `product_costpool_mapping`, `supplier_documents`, `supplier_document_splits`, `sales` — already exist live, so this file is otherwise a pure no-op) | N/A — `suppliers` is an optional FK target (`supplier_documents.supplier_id`, nullable, `ON DELETE SET NULL`); `src/lib/supplier-documents-store.ts` never references `supplier_id` at all, only free-text `supplier_name`. |

These are exactly the "half-built feature, not yet estimated" category the client's 2026-10-13
deployment plan said to defer — new-feature groundwork, not a currently-missing dependency of any
live page. Excluded on the same "only create what's necessary" basis as Group A.

The 2 top-level RLS files that referenced `suppliers` / `daily_revenues` / `sales_upload_log`
(`20260928b_rls_phase1_wages_financial.sql`, `20260929b_rls_phase2_hr_financial_operational.sql`)
were edited to drop those blocks — see the comments left at each removal site.

**If reviving:** move the file back to `../`, and — for `suppliers` / `daily_revenues` /
`sales_upload_log` — restore the corresponding RLS block from git history (`git log -p` on the
2 edited RLS files, 2026-10-14 commit).

---

**Combined: the 4 top-level RLS files in `supabase/migrations_pending/` were edited across both
groups** — their policies for all 13 excluded tables were removed (would otherwise fail with
"relation does not exist" against a table that never gets created). See
`docs/dev/personal-cost-tracker-changelog.md` for the full list of edits.
