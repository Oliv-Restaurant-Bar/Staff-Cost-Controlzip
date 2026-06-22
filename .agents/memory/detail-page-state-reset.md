---
name: Detail-page state reset on :id change
description: Per-:id detail pages that hold fetched record state must reset it when the id changes (and in fetch catch blocks), or React Router's component reuse leaks the previous record's data.
---

# Detail-page state reset on route :id change

A route component rendered at `/.../:id` is **reused** (same instance) when only the
`:id` param changes — React Router does not remount it. Any local state holding the
previously fetched record persists until the new fetch overwrites it.

**Rule:** In the page's `load()` (the effect keyed on the id), reset all fetched-record
state to its empty/default value *before* awaiting the new fetch, **and** reset it again
in any `catch` block. Do not rely on the success path alone to overwrite it.

**Why:** In `GaesteDetailPage` the manual CRM profile (`crmSaved`/`crmForm`) was only set
on success. When `fetchGuestCrmProfile` threw for guest B, the page kept showing guest A's
manual badges / birthday / company / allergies / notes — a cross-guest display of sensitive
CRM data (PII leak), not just stale UI. Editing was disabled via `crmLoadError`, but the
read-only header/overview still rendered from the stale state.

**How to apply:** Whenever you add or review a `/:id` detail page that fetches and displays
record data, check that switching ids (and a failed fetch) cannot surface the prior record.
The cheap guard is `setX(EMPTY)` at the top of `load()` plus `setX(EMPTY)` in the `catch`.
This is a component-lifecycle invariant, so it usually can't be unit-tested as a pure
function without extracting logic — verify it by reading `load()`.
