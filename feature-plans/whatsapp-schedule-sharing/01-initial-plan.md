# WhatsApp schedule sharing — initial plan

CRM task: 39927 (feature 1 of 3). Client decision (2026-10-23): share **per department**, in a WhatsApp group; no per-person links, no phone numbers.

## Goal

Managers build the schedule in the app, press **Veröffentlichen**, and send a ready-made WhatsApp message with a link to the department's schedule. After later edits they re-publish; employees opening the same link always see the latest published state.

## Findings that shape the design

- A publish feature existed and was removed 2026-08-04 (`StaffSchedulePage.tsx`, `schedule-publish-store.ts`); migration `20260806_remove_guest_and_timesheet_confirmation.sql` dropped all anonymous access. Anonymous table reads must stay closed.
- Old weaknesses to avoid: guessable token (`oliv-service`), local-first write with fire-and-forget DB write (violates the database-first rule in CLAUDE.md), stale `localStorage` fallback on the employee page, publish logic embedded in the 7,000-line planner, anonymous read of a shared KV table.
- Reusable from the old code (git `75a0981a^`): payload shape, per-day change detection, shift-code lookup. `scheduleData` is keyed `${employeeId}-${yyyy-MM-dd}` with `früh`/`spät` slots and absences.
- Roles: `admin`, `service_manager` (Service), `kueche_manager` (Küche), `beaulieu_manager` (Beaulieu, locked tenant). Role source for SQL: `user_profiles.role` (same as the control-list RPC migration).

## Design

**Data (new migration, no anon table access)**
- `schedule_share_links (tenant_id, department, token, created_at, rotated_at)`, PK `(tenant_id, department)`, `token` unique, 128-bit random, stable until rotated.
- `published_schedule_weeks (tenant_id, department, week_start, payload jsonb, revision, published_at, published_by)`, PK `(tenant_id, department, week_start)`.
- RLS on, no policies for `authenticated`/`anon`; everything goes through `SECURITY DEFINER` functions with `search_path = public`:
  - `schedule_share_get_link(tenant, dept)` — creates the link on first use; authorised roles only.
  - `schedule_share_rotate_link(tenant, dept)` — new token, old one stops working.
  - `schedule_share_publish_week(tenant, dept, week_start, payload)` — upserts the week, bumps revision, size-checked; returns revision.
  - `schedule_share_get_week(tenant, dept, week_start)` — planner reads the last published payload (change preview, status).
  - `schedule_public_get(token)` — **only anon-callable function**; returns department label, `updated_at` and published weeks from last week onward. No wages, no employee ids beyond display.
- Authorisation: admin = all; `service_manager` = Oliv/service; `kueche_manager` = Oliv/kueche; `beaulieu_manager` = Beaulieu/any.

**Client**
- `src/lib/schedule-publish-payload.ts` — pure: build week payload from employees + scheduleData + shiftMap, diff vs previous payload, status (`draft | published | changed`), WhatsApp message + `wa.me` URL builder.
- `src/lib/schedule-publish-db.ts` — RPC wrappers, database-first (no localStorage), errors surfaced.
- `src/components/schedule-planner/PublishScheduleDialog.tsx` — department picker (restricted by role), per-week status, change summary, **Veröffentlichen**, then **Per WhatsApp teilen** / **Link kopieren** / **Link zurücksetzen**.
- `src/pages/StaffSchedulePage.tsx` — public, read-only, mobile-first: week navigator, per-day shifts for the whole department, changed days highlighted, "Aktualisiert am …", always fetches fresh (no stale cache; error state with retry; refetch on tab focus).
- Planner: one toolbar entry opening the dialog (planner file stays otherwise untouched). Public route `/staff-schedule/:token` outside the auth gate.

**Semantics**
- Employees see only what was explicitly published. Draft edits stay invisible until the next publish; planner shows "Änderungen seit Veröffentlichung".
- Month view publishes every ISO week in the visible range; week view publishes one week.
- Update message wording differs from first publish ("wurde aktualisiert").

## Out of scope
Phone numbers / per-person links, WhatsApp Business API (replies, automatic sending), push notifications, admin UI for link expiry.

## Risks
- Re-introduces one anonymous read path (token-checked). Mitigation: 128-bit token, rotation, no wages in payload, security review of the migration.
- A department link shows all colleagues' shifts and can be forwarded (client informed).
- Estimate 6–8 h likely exceeded; flag to client after build.
- Migration must be applied manually in each Supabase project (dev first).
