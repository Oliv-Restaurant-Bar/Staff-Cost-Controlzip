---
name: Safe ?from= return URL + useSearchParams loop-safe sync
description: Conventions for context-aware back navigation (open-redirect defense) and mirroring page view-state to the URL without infinite loops.
---

# Safe `?from=` return URLs

When a page links into a detail page and wants a "back to where I came from"
button, pass the return target as an encoded `?from=` param and **validate it
strictly before navigating** — never `navigate(rawFromParam)` directly.

**Why:** an unvalidated `from`/`redirect`/`next` param is a classic open-redirect.
A user-controlled value like `//evil.com` or `https://evil.com/...` would let an
attacker craft a link that bounces the victim off-site.

**How to apply:** parse the raw value with `new URL(raw, syntheticBase)` where
`syntheticBase` is a throwaway origin (e.g. `https://crm.local.invalid`). Accept
ONLY if `url.origin === syntheticBase` (i.e. it resolved as internal/relative)
AND `url.pathname` exactly equals the allow-listed internal route (no subpaths).
Return only `url.pathname + url.search`. Pre-reject backslashes/control chars
(`/[\\\x00-\x1f]/`) since URL normalization treats `\` like `/`. Reference impl:
`src/lib/crm-auswertung-url.ts` (`parseFromParam`), tested in
`src/lib/__tests__/crm-auswertung-url.test.ts`.

# Mirroring page view-state to the URL (loop-safe)

To make a page refresh-safe / shareable and to build an exact return URL, mirror
the view-state (active tab, selected tile, filters, …) into `useSearchParams`.

**Why:** writing to `setSearchParams` inside a `useEffect` that also depends on
`searchParams` will infinite-loop unless guarded.

**How to apply:**
- Read the initial state ONCE via a `useRef` (`if (ref.current === null) ref.current = parse(searchParams)`), then drive everything from `useState` seeded from it.
- For controlled components (e.g. shadcn `Tabs`), seed `value` from the URL on the FIRST render so it's controlled from the start — avoids the React "uncontrolled→controlled" warning.
- Sync effect: compute `next = toParams(state)`, and only call
  `setSearchParams(next, { replace: true })` when
  `next.toString() !== searchParams.toString()`. The string-equality guard breaks
  the loop and `replace:true` keeps history clean. Foreign params get dropped on
  first write and then stabilize (no loop).
- Keep parse/serialize in a pure, supabase/DOM-free module so it's unit-testable
  (omit defaults from the URL for clean links; round-trip `parse(serialize(x))===x`).
