# Issue #5 — App trusts the device more than the database

Design for `docs/personal-cost-tracker-issues.md` issue #5. This is a Phase 1
reliability fix on live production data (Oliv/Beaulieu), not a new feature —
it gets a `feature-plans/` folder anyway because the blast radius and the
design decisions are genuinely architectural (see "Blast radius" below), not
because it's introducing new product behavior.

## 1. Restating the problem

`docs/personal-cost-tracker-issues.md` #5 says saves are "done" once they
reach the device, before the database confirms them, and names this as the
root cause behind issues #1–#3 (already patched individually). Confirmed by
reading the actual code (not assumed):

- **`src/lib/supabase-kv.ts`** already evolved past naive `kvSet` in its three
  "safe" merge functions (`safeUpsertDailyBudgets`, `safeUpsertReportingMonth`,
  `safeDeleteReportingMonth`): they correctly treat Supabase as the *merge
  base* (read-merge-write, not blind overwrite). But even these still write
  `localStorage.setItem(...)` **before** attempting the Supabase write, and
  only wrap the Supabase call in try/catch to show a toast on failure — the
  local write already happened and is never rolled back. That's still
  "device confirms first."
- **`src/hooks/useSyncStore.ts`** runs `syncLocalToSupabase` before
  `syncSupabaseToLocal` on every tenant switch — local pushes up before the
  authoritative remote state comes down.
- **The pervasive raw pattern**, confirmed in `src/lib/reporting-store.ts`
  and repeated across the codebase: `localStorage.setItem(key, ...)`
  immediately, then `kvSet(key, ...).catch(err => console.error(...))` —
  fire-and-forget. The calling code (and therefore the UI) has already
  moved on and reported success before the Supabase write even resolves,
  success or failure.

**Blast radius** (grepped `kvSet\b|kvSetStrict\b|safeUpsertDailyBudgets|safeUpsertReportingMonth|syncLocalToSupabase|syncSupabaseToLocal|kvGet\b|kvGetStrict\b` across `src/`, non-test files): ~50 files in `src/lib/*-store.ts` / `src/lib/*.ts` and several pages/hooks call into this KV layer. Two distinct sub-populations exist and must be treated differently:

- **`src/lib/supabase-db.ts`** (direct Postgres tables — employees, schedule, actual hours, manual corrections, etc.) is **already DB-first**: every write is a real `await supabase.from(...).upsert/insert/update(...)` with the function only resolving after the DB confirms, no localStorage mirror. This layer is **out of scope** for #5 — it already has the property #5 wants. (Issue #3, employee records disappearing, was fixed here already.)
- **The KV-blob layer** (`supabase-kv.ts` + everything that calls `kvGet`/`kvSet`/`kvSetStrict`/the `safeUpsert*` functions) is where the device-first pattern actually lives. This is the real scope of #5.

## 2. What "database as source of truth" means here

Given offline support is explicitly out of scope for Phase 1, and the
acceptance test is specifically about a *save interrupted mid-flight*
(tab killed / network lost *before* the DB confirms) — not sustained
offline editing — the design does **not** need a full offline queue.
It needs: **never let localStorage hold a value the database hasn't
confirmed, without at least marking it as unconfirmed.**

Two options were weighed:

- **(A) Strict DB-first, synchronous:** attempt the Supabase write, await
  it, and only touch localStorage (and report success to the UI) after
  it resolves. On failure, localStorage keeps the last confirmed value;
  the error surfaces immediately (already have `notifyKVBackupProblem`
  for this).
- **(B) Optimistic-with-rollback:** update in-memory/UI state immediately
  for responsiveness, write localStorage provisionally tagged `pending`,
  fire the Supabase write, and reconcile (confirm or roll back + re-toast)
  when it settles.

**Recommendation: (A) for the KV-blob layer, with in-memory optimistic UI
state left to each page/component as it already is today** (React state
updates instantly regardless of what the persistence layer does — that's
unrelated to this issue and doesn't need to change). Reasoning:

- The existing `kvSetStrict` / `notifyKVBackupProblem` / toast-with-retry
  machinery already assumes "the caller finds out when the write fails" —
  (A) just means callers must `await` before treating the localStorage
  cache as updated, not before updating their own component state.
- (B) requires a `pending`-write bookkeeping layer (what happens if the
  page reloads before reconciliation? that pending marker itself becomes
  a new source of "was this really saved?" ambiguity) — real complexity
  for a Phase 1 bug fix, for a benefit (feeling fast on a flaky connection)
  that isn't what issue #5 or its acceptance test asks for. If the client
  wants that later, it's the "offline capability" phase already tracked
  separately as depending on #5.
- (A) satisfies the acceptance test directly: kill the tab before the
  Supabase write resolves → localStorage was never updated → reload shows
  the last DB-confirmed state, not a phantom "saved" value.

## 3. Concrete change to `supabase-kv.ts`

Reorder the three "safe" merge functions and add one new primitive; **no
behavior change to their merge logic**, only to write ordering:

- `safeUpsertDailyBudgets`: currently writes `localStorage.setItem` (step 5)
  then attempts `kvSetStrict` (step 6, catch → toast). **Flip:** attempt
  `kvSetStrict(storageKey, merged)` first; only on success write
  `localStorage.setItem` + dispatch `store-synced`. On failure (both the
  "remote read failed" and "remote write failed" branches already present),
  do **not** touch localStorage at all — it still holds the last confirmed
  state, which is correct — and keep the existing toast+retry UX unchanged
  (the retry already re-runs the whole function).
- `safeUpsertReportingMonth` / `safeDeleteReportingMonth` (via the shared
  `mergeAndWriteReportingBlob`): same flip — currently writes
  `localStorage.setItem(storeKey, ...)` (step 5) right after the Supabase
  upsert succeeds (step 4) — **this one is actually already DB-first**
  (confirmed by re-reading: the `localStorage.setItem` call is *after* the
  `if (error) throw error` check, inside the same try block, so a failed
  Supabase write already throws before localStorage is touched). No change
  needed here — flag this in the changelog as "audited, already correct,"
  not "fixed."
- **New primitive, `kvSetConfirmed(key, value)`:** a drop-in replacement for
  the naive `localStorage.setItem(key, ...); kvSet(key, ...).catch(...)`
  fire-and-forget pattern seen in `reporting-store.ts` and elsewhere. It:
  1. Calls `kvSetStrict(key, value)` and awaits it.
  2. On success: `localStorage.setItem(key, JSON.stringify(value))`,
     dispatch `store-synced`, return.
  3. On failure: call `notifyKVBackupProblem(err, label, { retry: () =>
     kvSetConfirmed(key, value) })`, then re-throw so the caller's own
     error handling (if any) still fires — do **not** touch localStorage.
  This gives every remaining raw call site a one-line migration path
  without duplicating the confirm-then-cache logic per file.

## 4. `useSyncStore.ts` ordering

Flip pull before push: `syncSupabaseToLocal` first (bring the device up to
the authoritative remote state), **then** `syncLocalToSupabase` (which
already only pushes when remote is empty for that key, or merges for
`reporting_v1`/`dailyBudgets` — so pushing second doesn't lose anything
the pull just brought down; it only pushes local-only data that the pull
didn't already have). This directly matches the issue's own framing
("push-then-pull... part of what's making users see stale/lost data").

Risk check: does anything rely on the current push-first order (e.g.
first-ever-login local-only data needing to reach Supabase before the pull
"confirms" it back)? Re-read `syncLocalToSupabase`: for the "first
migration" branch (`!remoteIsEmpty` false → upload), the pulled-down value
would simply be the just-uploaded value, so order doesn't matter for that
case. For the merge branches (`reporting_v1`, `dailyBudgets`), merging
local into whatever's already remote is order-independent by construction.
So flipping the order is safe under the *current* merge logic — this is a
one-line change (swap the two `await` lines) with no other code path
depending on the old order (confirmed by reading the full function above,
not inferred).

## 5. Migration plan for the ~50 raw call sites

Do **not** attempt a big-bang rewrite of every call site — the codebase is
someone's live payroll/revenue data, and jumping into a well-tested,
narrow set of primitives is lower risk than touching 50 files in one PR.
Sequence:

1. **Land the primitive + ordering fixes** (Section 3 & 4) — this alone
   fixes the actual root-cause code paths named in the issue (`supabase-kv.ts`'s
   local-first write in `safeUpsertDailyBudgets`, and `useSyncStore`'s
   push-before-pull). This is the part that's genuinely "the root cause,"
   per the issue title.
2. **Migrate the highest financial-impact raw call sites** to
   `kvSetConfirmed` next, in this order (grep hits, prioritized by "would a
   silent loss here cost the client real money or a compliance headache"):
   `reporting-store.ts`, `budget-store.ts`, `cockpit-budget.ts`,
   `umsatz.ts`, `social-costs-db.ts` (despite the name, check whether it's
   KV-blob or direct-table before migrating), `account-mapping-store.ts`.
3. **Leave low-stakes settings as-is for now** (sort order, cell colors,
   overtime-disabled ids in `supabase-kv.ts` itself, `staff-portal-settings.ts`,
   `maison-store.ts`) — these already write localStorage first, which is
   fine for pure UI/display preferences where a lost write just means a
   re-click, not lost financial data. Note this explicitly in the
   changelog so it isn't mistaken for an oversight.
4. Each migrated file gets its own small PR/commit with the existing
   `__tests__` pattern extended (there's already
   `src/lib/__tests__/safeUpsertDailyBudgets.test.ts`,
   `safeUpsertReportingMonth.test.ts`, `kv-availability.test.ts` — follow
   that convention for `kvSetConfirmed` and each migrated call site) rather
   than one giant migration commit.

**Update (same day):** the user asked explicitly for the step-2–4 follow-up
to be done as well, not just planned. It was completed in the same session —
see `docs/personal-cost-tracker-issues.md` issue #5 and the 2026-09-23
changelog entry for the full per-file list of what was reordered, migrated
to `kvSetConfirmed()`, fixed for silent failures, or deliberately left as-is
with reasoning (synchronous high-blast-radius APIs, already-by-design local-
primary stores, and page-level files whose `localStorage` writes mirror
already-DB-confirmed table writes elsewhere).

## 6. Rollout / regression risk

- `kvSetStrict` (used by the new `kvSetConfirmed` and already used inside
  `safeUpsertDailyBudgets`) already exists and is exercised by existing
  tests — no new Supabase-facing code, only reordering of already-tested
  primitives.
- The riskiest change is the `useSyncStore` ordering flip, since it runs on
  every tenant switch for every user. Mitigate: add a regression test
  mirroring the existing `src/pages/__tests__/BudgetPage.app-multidevice.test.tsx`
  style (multi-device / tenant-switch scenario) asserting that after the
  flip, a device with local-only unsynced data still ends up with the
  union of local + remote after a tenant switch — not just remote.
- Manual panel retest per the issue's acceptance criterion (kill tab /
  drop network mid-save, reload, confirm no phantom "saved" state) is
  still required before closing #5, the same caveat pattern used for #4b.

## 7. Types / permissions / translations

Not applicable — this is a persistence-layer reliability fix with no new
UI, no new roles, and no new user-facing strings.

## Handoff

This design is scoped tightly enough (one new function + two ordering
flips in two files) that it can go straight to implementation rather than
through `planner` first — there's no multi-step sequencing ambiguity left
to resolve. Next: implement Section 3 (`supabase-kv.ts`) and Section 4
(`useSyncStore.ts`), add the regression test from Section 6, update
`docs/personal-cost-tracker-issues.md` / `docs/personal-cost-tracker-changelog.md`
per the existing #4b format, and explicitly log the Section 5 step 1-only
scope decision there so a future session doesn't assume all ~50 call sites
were migrated.
