---
name: Admin-only pages must exclude guest sessions
description: usePermissions().isAdmin is true for read-only guest links; gate admin-only data pages with isAdmin && !isGuest AND guard fetch side-effects.
---

`usePermissions()` computes `isAdmin = isAdminUser || isGuest`, so a **read-only guest-link session counts as admin**.

**Rule:** Any admin-only page that reads sensitive data (reservations, guest PII) must gate with `const canView = isAdmin && !isGuest` (`isGuest` from `useGuestSession()` in `@/contexts/GuestSessionContext`), never bare `isAdmin`.

**Why:** Guest links are meant to be read-only shares of a single session; they must not reach CRM/reservation data. Bare `isAdmin` silently lets them through.

**How to apply:**
- Render gate: `if (!canView) return <Navigate to="/" replace />;`
- Side-effect gate: a `useEffect`/`useCallback` that fetches data still RUNS on the render that returns `<Navigate>` — the redirect only changes what is rendered, not whether effects fire. So also guard the fetch itself (`if (!canView) return;` at the top of the effect AND the fetch callback). Otherwise a disallowed user triggers a DB read before the redirect happens.
