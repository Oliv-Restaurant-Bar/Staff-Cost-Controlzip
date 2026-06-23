---
name: Import-Historie logging design
description: Rules for the unified import_runs audit log shared by both Foratable imports
---

# Import-Historie (import_runs) design rules

Both Foratable import flows (Reservationen + Gästeexport/CRM) record every run into ONE
shared `import_runs` table. The logging layer is `import-runs-db.ts`; pure logic is
`import-runs.ts`.

## Rules to keep consistent
- **Logging is best-effort and MUST NEVER throw.** `logImportRun` swallows all errors and
  returns a boolean. A logging failure must never break or roll back a successful import.
  **Why:** the audit log is secondary; the actual import (`saveReservationImport` /
  `commitForatableGuestImport`) is authoritative and must stay untouched. Wire logging only
  at the page call sites, never inside the core DB write functions.
- **No guest PII in the log.** Store only aggregate counts, the file name, and the operator's
  auth UUID (`created_by`) — never guest email/phone/name. `stats_json` holds counts only.
- **Timestamp comes from the DB**, not the browser: `finished_at` uses `DEFAULT now()`;
  callers omit it. `started_at` may be browser time but the authoritative finish is DB-side.
- **Tenant safety** is via `restaurant_id` app-level filtering + RLS authenticated-only /
  anon-revoked (mirrors `20260621_reservations.sql`). Migration runs manually in the SQL
  editor (Mgmt API PAT 401 per `gn-rls-live-state.md`).
- "Latest per type" must use two type-filtered `limit:1` queries, not a slice of the newest N
  global rows (one type can flood out the other otherwise).
