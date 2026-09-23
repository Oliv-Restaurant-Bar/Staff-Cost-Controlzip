# Project

Personal/Staff Cost Tracker for Oliv (restaurant & bar) and Beaulieu — a multi-tenant staff scheduling, payroll-cost, and P&L cockpit. Vite + React SPA (`vite_react_shadcn_ts`), Supabase (Postgres + Auth) backend, deployed as a static build (Replit deploy target — `VITE_PUBLIC_URL` in `.env` points at the `*.replit.app` domain). Originally generated with Lovable (`lovable-tagger` dev dependency still wired into `vite.config.ts`).

UI language is German throughout (labels, comments, toasts) — the client is German-speaking; this is not a partial translation, it's the intended language for both code comments and the live app.

## Code Style

- TypeScript, strict-ish. **`npm run typecheck` (bare `tsc --noEmit`) is a no-op — do not trust it.** The root `tsconfig.json` has `"files": []` with project references (`tsconfig.app.json`/`tsconfig.node.json`); running plain `tsc --noEmit` without `--build` checks zero files and always exits with no output, regardless of real errors (confirmed 2026-09-23 by deliberately introducing a type error and observing it produce no diagnostics). Use `npx tsc --noEmit -p tsconfig.app.json` instead — that one actually type-checks the app and currently reports ~252 pre-existing errors (baseline as of 2026-09-23; treat like the ESLint/test baselines below — check for *new* errors via a before/after diff, not an absolute zero).
- ESLint 9 flat config (`eslint.config.js`) — works, but currently reports ~2,376 pre-existing problems (~1,949 errors) across the repo, concentrated in `supabase/functions/*` (mostly `no-explicit-any`) and elsewhere. Not something to fix opportunistically — treat it as a pre-existing baseline, not a regression signal for new work.
- Components are large, single-file pages (`src/pages/*.tsx` routinely run 1,000–3,000+ lines) rather than heavily decomposed — match this pattern rather than introducing a different structure mid-file.
- shadcn/ui component library (`src/components/ui/*`) on top of Radix UI primitives + Tailwind CSS.
- State: no global store — React Context for auth/tenant/UI-preference concerns (`src/contexts/*`), TanStack Query for server-cache concerns, plain `useState`/`useRef` elsewhere.
- Data access: Supabase client (`src/integrations/supabase/client.ts`) wrapped by hand-written functions in `src/lib/*` (not a generic repository layer) — one or a few files per business concern (imports, exports, cost calculations, reconciliation).

## Commands

- `npm run dev` — Vite dev server (port 8080, falls back to next free port if taken).
- `npm run build` — production build; also copies `dist/index.html` → `dist/404.html` (SPA fallback for static hosting).
- `npm run build:dev` — dev-mode build.
- `npm run lint` — ESLint (works; see pre-existing problem count above).
- `npm run typecheck` — `tsc --noEmit`. **Broken/no-op — see Code Style above.** Use `npx tsc --noEmit -p tsconfig.app.json` for a real check.
- `npm run test` / `npm run test:watch` — Vitest. Currently 23 failing test files / 36 failing tests out of 300 files / 4,733 tests — the large majority passes; failures seen are pre-existing (e.g. a Swiss-apostrophe-vs-straight-quote formatting mismatch in a reconciliation table test), not something introduced by unrelated changes.

## Architecture

- `src/pages/` — one file per route, wired in `src/App.tsx`'s `<Routes>`. Route access is gated inline per-route (`canAccessModule(...)`, `<RequireAdmin>`, or a raw `isAdmin`/`isBeaulieuManager` check) — there is no centralized route-permission table.
- `src/components/` — organized by feature area, not by type (`personalkosten/`, `schedule-planner/`, `waren/`, `op-liste/`, `reservations/`, `import-center/`, `dashboard/`, etc.), plus `components/ui/` (shadcn primitives) and `components/layout/` (page shell/nav).
- `src/lib/` — the real business-logic layer: ~340 files, mostly one concern per file (parsers for external formats — MIRUS, Adyen, Gastronovi, Foratable; PDF/Excel export builders; cost/social-charge calculations; reconciliation logic; per-feature Supabase read/write helpers like `supabase-db.ts`, `supabase-kv.ts`, `cockpit-budget.ts`). This is where to look first for "how does X get calculated/saved," not the components.
- `src/hooks/` — cross-cutting hooks (`useAuth`, `usePermissions`, `useTenant` accessor, `useSyncStore`, feature-specific data hooks like `usePersonnelData`).
- `src/contexts/` — `AuthContext` (Supabase auth + role), `TenantContext` (active tenant: `oliv` | `beaulieu`, plus tenant-lock for restricted roles), `StichtagContext`/`RevenueDisplayContext`/`PlanDisplayContext`/`MaisonContext` (cross-page UI/display preferences).
- `src/integrations/supabase/` — Supabase client + generated DB types.
- `src/types/` — shared domain types (contracts, positions, reporting, staffing, P&L, etc.) separate from component-local types.
- `src/data/` — static seed/reference data (default employee lists, prior-year daily figures) used as fallbacks/comparisons, not live data.
- `supabase/functions/` — Supabase Edge Functions (e.g. IMAP email fetch, reservation-email parsing, notification emails) — separate TS project from the Vite app, has its own ESLint findings.

## Important Notes

- **Multi-tenant, single deployment.** `TenantContext` holds the active tenant (`oliv` | `beaulieu`); most data hooks/queries take a `tenantId`. Certain roles (`beaulieu_manager`, `beaulieu_viewer`) are hard-locked to the Beaulieu tenant (`TenantLockEnforcer` in `App.tsx`) and blocked from Oliv-only routes.
- **Role model:** `admin`, `service_manager`, `kueche_manager`, `beaulieu_manager`, `beaulieu_viewer` (see `usePermissions.ts`). Route/module access is enforced per-route in `App.tsx`, not from one central permission table — check both the route element and the page's own internal gating when tracing what a role can do.
- **Device-vs-database save priority (Issue #5, largely fixed 2026-09-23):** most of the KV-layer save paths (`src/lib/supabase-kv.ts`'s `safeUpsertDailyBudgets`/`kvSetConfirmed`, `budget-store.ts`'s whole save chain, and ~15 other `src/lib/*-store.ts`/`*-db.ts` files) now write to Supabase first and only cache to `localStorage` after that write is confirmed — see `docs/personal-cost-tracker-issues.md` issue #5 for the full per-file list of what changed vs. what was deliberately left optimistic-local (mainly `reporting-store.ts`'s `saveMonth` family and a few explicitly-low-stakes settings stores). For **new** save-path code: default to the database-first pattern (`kvSetConfirmed()` in `supabase-kv.ts`, or the `queueBudgetsBackup`-style pattern in `budget-store.ts`), not the old local-first-then-best-effort-backup pattern — treat any new `localStorage.setItem` immediately followed by a fire-and-forget `kvSet(...)` as a regression, not something to copy.
- **Confirmed orphaned pages, not routed anywhere and not imported by any other file** (verified via repo-wide grep, not import-count alone): `src/pages/ArbeitszeitblaetterPage.tsx` (timesheet approval) and `src/pages/StundenimportPage.tsx` (Mirus hours import). Both are substantive, real features (not stubs) — they're either mid-migration or superseded by something else and simply never had their route wired/removed. Confirm with the client before reviving or deleting either.
- **`GaesteImportPage.tsx` and `ReservationenImportPage.tsx` look orphaned by the same grep but are not** — both are embedded directly inside `ForatableImportPage.tsx` (which *is* routed at `/foratable-import`), not standalone routes.
- **Ongoing reliability/fix tracking:** `docs/personal-cost-tracker-issues.md` (issue list with panel test steps) and `docs/personal-cost-tracker-changelog.md` (done/pending log) track a client-facing Phase 1 bug-fix effort — check these before assuming a listed issue is still open or already fixed.
