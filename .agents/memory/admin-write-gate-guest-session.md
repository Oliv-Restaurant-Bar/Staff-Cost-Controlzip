---
name: Admin write-gate must exclude guest sessions
description: usePermissions().isAdmin includes read-only guest sessions; write/edit gates must use isAdmin && !isGuest
---

`usePermissions()` computes `isAdmin = isAdminUser || isGuest`. Read-only guest-link
sessions (`GuestSessionContext`) therefore report `isAdmin === true`.

**Rule:** Any page/action that WRITES or EDITS data (CRM import, manual CRM edit, etc.)
must gate on `isAdmin && !isGuest` (pull `isGuest` from `useGuestSession()`), NOT bare
`isAdmin`. Bare `isAdmin` is acceptable only for read-only admin views.

**Why:** Guest links are intended to be strictly read-only. Gating a write flow on bare
`isAdmin` lets a guest session reach it. Caught in review of the Foratable guest-export
CRM import; the established precedent is `GaesteDetailPage`'s `canEditCrm = isAdmin && !isGuest`.

**How to apply:** When adding an admin-only page that can mutate data, import
`useGuestSession`, compute `const canWrite = isAdmin && !isGuest`, and use it for BOTH the
route guard and any save/commit buttons. Put the conditional `return <Navigate/>` AFTER all
hook calls to avoid "rendered more hooks" violations when permissions hydrate false→true.
Some read-only admin pages (e.g. ReservationenImportPage) still use bare `isAdmin` — that is
the existing pattern for non-destructive views only.
