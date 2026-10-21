# Overview — Oliv Staff Control (Personal & Kosten-Cockpit)

**Read this first.** This document is written for a developer who has never seen this codebase — likely because, like the person maintaining it today, you inherited it from the client with no handover documentation. Everything here was reverse-engineered from the code itself (most of it is unusually well-commented, in German) rather than from any design doc, because none exists.

## What this product actually is

This is a **staff scheduling, payroll-cost, and P&L cockpit for two restaurants**: "Oliv Restaurant & Bar" and "Restaurant Beaulieu," run as one shared deployment ("multi-tenant, single deployment" — see Architecture below). A restaurant manager or owner uses it to:

1. **Build and manage duty rosters** — who's working which shift, in which department (Service/kitchen), and what it costs (`/personal`).
2. **Track cost of goods** — supplier invoices, article/recipe cost data, reconciled against three independent sources (recipe-theoretical, supplier-document-operational, and official bookkeeping) (`/warenrechnungen`, `/wes-analyse`).
3. **Track and analyze sales/revenue** — imported from the restaurant's Gastronovi point-of-sale system, broken down by product/category/time period (`/produkt-analyse`, `/sales-upload`).
4. **Run the financial control tower** — a full P&L (income statement), budgets, and a 16-metric management KPI cockpit that rolls all of the above up into "is this month going well?" (`/`, `/startuebersicht`, `/erfolgsrechnung`).
5. **Manage guest relationships and reservations** — a CRM layer computed live from reservation data (`/gaeste`).
6. **Onboard new employees** in compliance with L-GAV (the Swiss hospitality collective labor agreement), including contract generation and Swiss authority (SEM) reporting (`/personaleintritt`).
7. **Import external data** — POS exports, staff-hours sheets (from a system called "Mirus"), and accounting CSVs/PDFs (`/import`, `/import-cockpit`).

If you're testing a bug fix and unsure which page to check, start from the [feature docs](#feature-domain-docs) below — each one lists every route in that domain with a one-line purpose and who can access it.

## Origin & maintenance context

This project was originally generated with **Lovable** (an AI app-builder — the `lovable-tagger` dev dependency in `package.json` and Lovable references in the old `README.md` are remnants of that), and the entire UI, plus most code comments, are in **German**, because the client is German-speaking. This is intentional, not a partial translation — don't "fix" it by translating UI strings.

This documentation set (this file plus everything under `docs/client/features/`) exists because the codebase was handed over for a bug-fix/audit engagement with **no existing handover documentation**. It's built to let any developer (regardless of German fluency) understand what a page does and manually verify a fix actually works, not just that it compiles. For the specific issues being tracked and fixed in that engagement, see `docs/dev/personal-cost-tracker-issues.md` (issue list + test steps) and `docs/dev/personal-cost-tracker-changelog.md` (what's been done).

## Tech stack

- **Frontend:** Vite + React 18 + TypeScript, using the `vite_react_shadcn_ts` template — a single-page app (SPA), not Next.js/server-rendered.
- **UI:** shadcn/ui components on top of Radix UI primitives, styled with Tailwind CSS.
- **Backend:** Supabase (hosted Postgres + Auth). The client is initialized in `src/integrations/supabase/client.ts` from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` environment variables — set those in a local `.env` (not committed) before running the app; ask the client or check the deployment platform for the actual values, don't guess them.
- **State:** no global store (no Redux/Zustand) — React Context for auth/tenant/UI-preference concerns (`src/contexts/`), TanStack Query for server-cache concerns, and a large amount of hand-written `localStorage` + Supabase-KV caching in `src/lib/*-store.ts` files (a "device-vs-database" pattern that was itself the subject of a recent bug-fix pass — see this repo's `CLAUDE.md` "Important Notes").
- **Deployment:** deployed on Vercel for both dev and production (`VITE_PUBLIC_URL` points at the deployed Vercel domain).

## Running it locally

```sh
npm i
npm run dev        # Vite dev server, port 8080 (auto-falls-back if taken)
```

You'll need a `.env` file with at minimum `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` pointing at the project's Supabase instance — get these from whoever holds the client's Supabase project access, they are not in the repo.

Other commands (see `CLAUDE.md` for full detail and known caveats):
- `npm run build` — production build (also copies `dist/index.html` → `dist/404.html` for SPA routing on static hosting).
- `npm run lint` — ESLint (currently has a large pre-existing baseline of findings — not a regression signal, see `CLAUDE.md`).
- `npx tsc --noEmit -p tsconfig.app.json` — the *real* type-check. **`npm run typecheck` is broken/a no-op** — don't trust it (see `CLAUDE.md`).
- `npm run test` — Vitest (4,700+ tests, most pass; a known small set of pre-existing failures, see `CLAUDE.md`).

## Architecture: tenants, roles, and how to reason about "who sees what"

### Multi-tenant model

One deployment serves **two tenants**: `oliv` and `beaulieu` (`src/contexts/TenantContext.tsx`). The active tenant is held in state + `localStorage`, and most data-access functions take a `tenantId` or use `tenantKey(key)` to prefix their storage key (Oliv keeps unprefixed keys for backward compatibility; Beaulieu keys get a `beaulieu:` prefix). When testing a fix, **always check whether the bug is tenant-specific** — a fix that works on Oliv's data might behave differently on Beaulieu's, or vice versa, especially for anything using `localStorage`.

Two roles are **hard-locked to the Beaulieu tenant** and cannot switch: `beaulieu_manager` and `beaulieu_viewer`. This is enforced by `TenantLockEnforcer` in `src/App.tsx`.

### Role model

Five roles (`src/contexts/AuthContext.tsx`'s `UserRole` type):

| Role | Summary |
|---|---|
| `admin` | Sees and can edit everything, both tenants |
| `service_manager` | Duty-roster + plan-vs-actual analysis, Service department only |
| `kueche_manager` | Duty-roster + plan-vs-actual analysis, Küche (kitchen) department only |
| `beaulieu_manager` | Broad operational access (scheduling, cost tracking, guests) for Beaulieu only — explicitly **no** Finanzen (finance), no cockpit exports, no system administration |
| `beaulieu_viewer` | Read-only access to Beaulieu data, mainly Warenrechnungen (supplier invoices) view+export |

Route access is **not** centralized — it's checked inline, per-route, in `src/App.tsx`, using either `canAccessModule('module_name')` (from `src/hooks/usePermissions.ts`) or the shared `<RequireAdmin allowBeaulieu>` guard component. When tracing what a given role can actually do, you generally need to check **both** the route element in `App.tsx` and the page component's own internal gating (many pages double-gate, checking permissions again in their own load effect as defense-in-depth) — see each feature doc's "Access" column as a starting point, but verify against the actual route/page for anything security-sensitive.

`usePermissions.ts` also exposes fine-grained flags beyond simple module access worth knowing about: `canSeeHourlyWages` (individual salary visibility — admin/beaulieu_manager only), `canSeePersonnelCostTotals` (aggregate cost — everyone), `allowedDepartment`/`canSeeDepartment` (department-based data filtering within a module, not just module-level access), and module-specific granular permission sets like `warenrechnungenPerms` (view/create/edit/delete/export computed independently).

### Recurring conventions worth knowing before you read any page

- **"Missing data shows as a dash (—), never 0."** This rule appears constantly across the KPI cockpit, reporting, and cost-tracking pages. A fix that causes a `0` to appear where data is genuinely absent is very likely a regression of this convention, not a fix.
- **Single sources of truth are taken seriously.** The P&L/KPI numbers all route through one "Financial-Metrics-Registry" (`src/lib/pl-engine.ts`, its `computePLForMonth` function) rather than being recalculated per-page. If you find a page computing its own P&L totals from raw data instead of calling into this, flag it rather than copying the pattern.
- **Three independent cost-of-goods sources are deliberately kept separate** (recipe-theoretical, supplier-document-operational, official-bookkeeping) so they can be cross-checked, not merged.
- **Device-vs-database save ordering matters.** Most write paths now save to Supabase first, then cache to `localStorage` only after confirmation (`kvSetConfirmed()` pattern) — this was a real, recently-fixed bug class (see `CLAUDE.md` "Device-vs-database save priority"). Any new write-path code should follow that pattern, not the older local-first-then-best-effort-backup one.

## Where to start reading code

1. **`src/App.tsx`** — the full route table with inline access-control comments (mostly in German, but the route paths and component names are self-explanatory). This is the fastest way to see every page in the app and who can reach it.
2. **`src/hooks/usePermissions.ts`** — the entire permission model in one file, with a role×module matrix in its own header comment.
3. **A feature doc below** matching whatever you're actually fixing — each one traces the real `src/lib` data-flow for its pages, not just the UI.

## Feature domain docs

| Doc | Covers |
|---|---|
| [`features/personal-scheduling.md`](./features/personal-scheduling.md) | Duty rosters, employee master data, employee onboarding (L-GAV/PII), staffing requirements, overtime, personnel-cost engine. **Start here** — this is the operational core of the app. |
| [`features/finance-cockpit.md`](./features/finance-cockpit.md) | P&L, budgets, the 16-KPI management cockpit (full KPI table + formulas), revenue reconciliation, daily closing, accounting import. |
| [`features/waren-sales.md`](./features/waren-sales.md) | Cost-of-goods tracking (supplier invoices, articles/recipes) and sales/revenue analysis (Gastronovi POS import, product analysis). |
| [`features/guests-import.md`](./features/guests-import.md) | Guest CRM & reservations analytics, plus the general Import Center (Foratable, Gastronovi, Mirus staff-hours pipelines). |
| [`features/admin-tools.md`](./features/admin-tools.md) | System settings/backup, business-entity ("Betriebe") management, data-integrity tooling, MIRUS debug/test pages, the legacy overview page, and orphaned pages. |

## Other docs in this repo worth knowing about

- `docs/client/kpi-inventar.md` — the canonical (German) reference for the 16-KPI management cockpit's exact formulas, tone/color rules, and export profiles. `features/finance-cockpit.md` summarizes it in English but this is the source of truth for exact calculation rules.
- `docs/client/navigations-inventar.md` — a (German) inventory of every KPI/dashboard page's navigation classification (stays in nav / drilldown-only / removed), from a past navigation-consolidation pass.
- `docs/dev/personal-cost-tracker-issues.md` / `docs/dev/personal-cost-tracker-changelog.md` — the live bug-fix tracking for the current client engagement (issue list with test steps, and a done/pending log). Check these before assuming a known issue is still open or already fixed.

## What this documentation could not verify

This whole set of docs was built by reading source files (header comments, imports, and selected function signatures) — not by running the app end-to-end or exercising every page in a browser. Each feature doc ends with its own "Not independently verified" note listing what was and wasn't confirmed. Treat the route tables and access rules as reliable (they're grep/read-confirmed against `App.tsx` and `usePermissions.ts`), but verify exact runtime behavior directly before relying on a described data flow for a non-trivial fix.
