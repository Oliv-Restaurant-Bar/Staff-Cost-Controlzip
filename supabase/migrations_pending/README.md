# Pending migrations — not yet applied to production

`supabase/migrations/` is the client's already-applied history — every file in there has already
been run against the live database. This folder is separate on purpose: everything here has been
written and reviewed but **not yet run against production**, so this folder is always the answer
to "what do we still need to apply."

## How to use this folder

1. **Applying to production:** run the files below in filename order (they build on each other —
   phase 2 reuses functions phase 1 defines) via the Supabase SQL Editor, same as every other
   migration in this project (no live CLI/DB access from this environment, manual-apply-only).
2. **After a file has been applied to production**, move it from here into `supabase/migrations/`
   (`git mv`) so the client's applied-history folder stays the source of truth for what's actually
   live. Don't leave an applied file behind in this folder — this folder should only ever contain
   migrations that still need to be run.
3. **New migrations written after this point** go here first, not directly into
   `supabase/migrations/` — move them over only once confirmed applied.

## Current contents, in apply order

1. `20260928_urgent_credential_and_profile_lockdown.sql` — locks down `user_profiles` and 3
   plaintext-credential tables (`imap_email_settings`, `external_api_settings`,
   `fortelable_settings`) to admin/Beaulieu-manager only.
2. `20260928b_rls_phase1_wages_financial.sql` — defines the shared predicate functions
   (`role_can_access_tenant`, `role_can_see_wages`, etc.) and applies them to `employee_wages`,
   `employees`, `schedule_extra_cost_people`, and the Warenrechnungen cluster (`suppliers`,
   `supplier_documents`, `supplier_document_splits`).
3. `20260929_urgent_password_and_stray_credential_lockdown.sql` — locks down the admin password
   in `app_settings`, `department_access_tokens`, and `app_kv_store`.
4. `20260929b_rls_phase2_hr_financial_operational.sql` — the wider second-pass audit: HR/
   onboarding, timesheet lifecycle, core scheduling, operational-config, accounts payable, daily
   revenue, statutory minimum wage, and the guest/reservation cluster (~30 tables total). Depends
   on predicate functions defined in file 2 above — must be applied after it.

All four were verified against this project's own database-setup history (every table confirmed
to belong to this project, not another one sharing the same Supabase instance) and against each
table's actual columns — see `docs/personal-cost-tracker-summary.md` for the plain-English
version of what each one does and `docs/personal-cost-tracker-issues.md` issue #7 for the full
technical audit.
