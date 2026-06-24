---
name: Admin gate must exclude guest sessions (read AND write)
description: usePermissions().isAdmin includes read-only guest sessions; admin-only PII/write pages must gate isAdmin && !isGuest on both the route guard and the data-fetch effect
---

`usePermissions()` computes `isAdmin = isAdminUser || isGuest`. Read-only guest-link
sessions (`GuestSessionContext`) therefore report `isAdmin === true`. **`isGuest` is NOT
returned by `usePermissions()`** — read it from `useGuestSession()`
(`@/contexts/GuestSessionContext`) in the same component.

**Rule:** Any page that WRITES/EDITS data **or reads tenant guest/reservation PII**
must gate on `isAdmin && !isGuest`, NOT bare `isAdmin`. Do it in **two** places:
1. the route guard — `if (!isAdmin || isGuest) return <Navigate to="/" replace />` (place it AFTER all hook calls to avoid "rendered more hooks" when permissions hydrate false→true).
2. the data-fetch effect/callback — `if (!isAdmin || isGuest) { setLoading(false); return; }`, and add `isGuest` to its dependency array. Otherwise the fetch fires before the redirect commits and leaks PII.

**Why:** Guest links are meant to be strictly read-only AND must not browse the guest
CRM. Bare `isAdmin` silently grants guest sessions both write access and PII reads. This
recurred across ReservationenImportPage (write/import), GaesteCrmPage, GaesteDetailPage,
CrmAuswertungPage (PII reads). GaesteImportPage / ForatableReportPage already had the
correct pattern (`canImport`/`canView = isAdmin && !isGuest`); `GaesteDetailPage`'s
`canEditCrm = isAdmin && !isGuest` is the precedent for edit buttons.

**How to apply:** when adding any `/gaeste*`, `/foratable*`, CRM, or import page, grep the
new page for `if (!isAdmin)` and upgrade every occurrence (route guard, fetch guard, save
buttons) to `!isAdmin || isGuest`. The earlier "bare isAdmin is fine for read-only admin
views" guidance was WRONG for PII pages — that gap is what caused this fix.
