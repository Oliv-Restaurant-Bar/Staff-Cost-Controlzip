# Finance, Cockpit & KPI Reporting

## What this is, from an owner/GM's perspective

This is the financial control center of the app: the set of pages a restaurant
owner or manager uses to answer "how is the month going financially, and
where do I need to look closer?" It's built around a deliberate **3-level
controlling model** (this is the mental model the whole domain is organized
around — worth understanding before touching any page here):

- **Level 1 — Management.** A compact catalog of ~16 KPIs (revenue, cost
  ratios, EBITDA, guest counts, etc.) that a manager can scan in under a
  minute. Lives on the startpage and in the Monthly Report.
- **Level 2 — Analysis.** Each Level-1 KPI links to an existing, deeper
  analysis page for that specific number (e.g. the P&L view for margin
  KPIs, the WES/COGS analysis page for the cost-of-goods ratio).
- **Level 3 — Detail / source document.** From the analysis page you can
  drill further into the actual source records (daily Z-report entries,
  individual supplier invoices, the staff schedule, a specific daily
  closing).

The rule that's enforced everywhere in this domain: **a missing value is
shown as "—", never as 0.** Treating a genuinely-missing data source as zero
would silently understate costs or revenue, so all the KPI/finance code
explicitly distinguishes "no data yet" from "value is zero."

## Pages in this domain

| Route | Page (German name) | English name | Purpose | Who can access it |
|---|---|---|---|---|
| `/` (for admin/beaulieu_manager) | Monatsreport | **Monthly Report** | Current home page for admins and the Beaulieu GM: a configurable, drag-to-reorder meeting cockpit table (metric \| Δ% \| actual \| prior year \| budget), with weekly-trend and year-comparison tabs, Excel export | admin, beaulieu_manager |
| `/monatsreport` | Monatsreport | Monthly Report (same page, stable URL) | Same as above | admin, beaulieu_manager (`RequireAdmin allowBeaulieu`) |
| `/startuebersicht` | StartOverview | **Executive Cockpit** | The original KPI startpage: the 16-KPI Level-1 catalog + "Today" status widgets, a risk/warning center, this week's revenue, data-freshness chips per import type, and a prioritized "next steps" action list. Strictly read-only. | admin, beaulieu_manager (`RequireAdmin allowBeaulieu`) |
| `/dashboard` | Dashboard | **Operations Dashboard** | Financial monthly overview (via the Financial Metrics Registry) plus an operational "today" snapshot; also the "/" landing page for service/kitchen managers | `canAccessModule('dashboard')`: admin, beaulieu_manager, service_manager, kueche_manager |
| `/budget-eingabe` | BudgetCockpitPage | **Cockpit Budget Entry** | Enter yearly/monthly budget targets for the Level-1 Cockpit KPIs (separate from the full P&L budget below) — supports seasonal or even distribution, CHF/% toggle, "take over actuals" auto-fill | admin, beaulieu_manager (`RequireAdmin allowBeaulieu`) |
| `/analyse` | SollIstAnalyse | **Plan vs. Actual Analysis** | Compares planned vs. actual hours, staff cost, revenue and cost ratio, filterable by day/week/month and department | admin (all departments), service_manager (service only), kueche_manager (kitchen only) — **not** available to beaulieu_manager |
| `/reporting` | Reporting | **Reporting / Analysis** | Deeper analysis page tightly coupled to the P&L (Erfolgsrechnung) — same data basis as PLView | admin only |
| `/kontenplan` | AccountMapping | **Chart of Accounts** | Central admin page for all 4-digit account numbers: import from the accounting system, auto-categorization (3xxx→revenue, 4xxx→COGS, etc.), match-testing | admin only |
| `/erfolgsrechnung` | PLView | **P&L (Income Statement)** | The full profit & loss statement: month view (actual/budget/prior-year/deltas) and a 12-month year overview; click any row to drill into source data | admin only |
| `/budget` | Budget | **Budget (full P&L)** | Full P&L budget hierarchy (revenue → COGS → gross profit 1 → payroll → gross profit 2 → EBITDA), editable per account/month | admin only |
| `/kennzahlen-bericht` | KennzahlenBerichtPage | **Management Report (KPI detail)** | Dashboard + Excel-style column report view, feeds Level-2/3 for several Level-1 KPIs (avg. check, revenue/guest, productivity) | admin, beaulieu_manager (`RequireAdmin allowBeaulieu`) |
| `/forecast` | ForecastPlanung | **Forecast & Next-Week Planning** | Projects next calendar week's planned staff cost, hours, and forecast staff-cost ratio, from the schedule + budget targets | admin, beaulieu_manager (`RequireAdmin allowBeaulieu`) |
| `/umsatzabstimmung` | UmsatzAbstimmungPage | **Revenue Reconciliation** | Per-year monthly reconciliation status view | anyone with `canManageOperationalData` |
| `/tagesabschluesse` | TagesabschluessePage | **Daily Closings** | Day-by-day confirmation of revenue closing (Z-report ↔ Adyen payment terminal reconciliation) | anyone with `canManageOperationalData` |
| `/op-liste` | OpListe | **Accounts Payable (OP list)** | Open supplier invoices/creditor balances, with two-snapshot comparison over time | admin only (double-gated: route guard + in-page guard) |

## The 16 Management KPIs at a glance

Defined in `src/lib/kpi-catalog.ts`, displayed on the startpage / Monthly
Report. Each KPI states its Level-2 (analysis) and Level-3 (detail) drill-down
route where one exists.

| # | KPI | Unit | Formula | Has budget/prior-year? | Traffic light rule |
|---|---|---|---|---|---|
| 1 | Net revenue | CHF | Sum of revenue accounts, net of VAT | ✓ | — |
| 2 | Cost of goods (COGS) | CHF | Direct + remaining COGS account ranges | ✓ | — |
| 3 | COGS ratio | % | COGS ÷ net revenue × 100 | ✓ | warn > 28%, critical > 33% |
| 4 | Gross profit 1 | CHF | Net revenue − COGS | ✓ | — |
| 5 | Payroll cost | CHF | Wages + employer social costs + other payroll | ✓ | — |
| 6 | Payroll ratio | % | Payroll cost ÷ net revenue × 100 | ✓ | vs. budget target (neutral if no target set) |
| 7 | EBITDA | CHF | Gross profit 2 − other operating expense | ✓ | — |
| 8 | EBITDA margin | % | EBITDA ÷ net revenue × 100 | ✓ | bank benchmark ≥ 15% (±1.0pp tolerance) |
| 9 | EBIT | CHF | EBITDA − depreciation | ✓ | — |
| 10 | EBIT margin | % | EBIT ÷ net revenue × 100 | ✓ | bank benchmark ≥ 10% (±1.0pp tolerance) |
| 11 | Guests | count | Sum of daily guest counts | prior-year only | — |
| 12 | Average check | CHF | Average of daily values in month | prior-year only | — |
| 13 | Revenue per guest | CHF/guest | Total revenue ÷ guest count | prior-year only | — |
| 14 | Sales-based COGS ratio | % | Σ(quantity × recipe cost) ÷ net revenue × 100 | — | — |
| 15 | Productivity | CHF/h | Net revenue ÷ productive actual hours (>0, excludes absences) | — | — |
| 16 | Daily closings verified | % | Confirmed ÷ recorded days (up to yesterday) × 100 | — | ≥80% good, ≥50% warn |

Export profiles (Excel + PDF, built from the same rows the UI shows — no
second calculation): **Geschäftsleitung/Management** = all 16 KPIs + monthly
comments; **Bank** = KPIs 1–10 (P&L core through EBIT margin); **Investoren**
= a compact subset (revenue + result KPIs 1, 7, 8, 9, 10).

## Data flow

Nearly every page in this domain ultimately reads through one of two "single
source of truth" layers rather than recalculating P&L numbers itself:

```
Page (e.g. PLView, StartOverview, MonatsreportPage, Dashboard)
   │
   ├─► src/lib/pl-engine.ts        computePLForMonth() — the ONE place P&L
   │                                 rows (actual/budget/prior-year) get computed
   │
   ├─► src/lib/financial-metrics.ts  Financial Metrics Registry — read-only
   │                                 wrapper around pl-engine output, exposes
   │                                 typed metric IDs (net_revenue, total_cogs, …)
   │
   ├─► src/lib/kpi-catalog.ts      The 16-KPI catalog — delegates all P&L KPIs
   │                                 1:1 to the Financial Metrics Registry;
   │                                 non-P&L KPIs (guests, productivity, …)
   │                                 read their own existing sources directly
   │
   └─► Supabase (via src/lib/supabase-db.ts, supabase-kv.ts, and feature-specific
       helpers like waren-db.ts, op-liste-db.ts, gn-*-db.ts)
```

Budget data has **two separate systems** that are easy to confuse:
`budget_v1` (the full P&L budget, edited on `/budget`, consumed by PLView/
Reporting) and the Cockpit KPI budget (edited on `/budget-eingabe`, only for
the Level-1 KPI catalog). They are intentionally not the same store.

## Key files

| File | Purpose |
|---|---|
| `src/lib/pl-engine.ts` | The actual P&L calculation engine (`computePLForMonth`) — the single source of truth for actual/budget/prior-year P&L rows |
| `src/lib/financial-metrics.ts` | Read-only registry exposing typed financial metrics, built on top of `pl-engine` output |
| `src/lib/financial-metrics-input.ts` | IO layer that builds the input for the registry from stored data |
| `src/lib/kpi-catalog.ts` | The 16-KPI Level-1 catalog definition; pure logic, no DOM/Supabase access |
| `src/lib/monatsreport.ts` / `monatsreport-export.ts` | Data loading + Excel export for the Monthly Report page |
| `src/lib/cockpit-budget.ts` | Cockpit KPI budget store (distinct from `budget_v1`) |
| `src/lib/budget-store.ts` | Full P&L budget (`budget_v1`) store, used by `/budget` and PLView |
| `src/lib/account-mapping-store.ts` | Chart-of-accounts data, powers `/kontenplan` and account categorization used throughout P&L |
| `src/lib/reporting-store.ts` | Monthly financial record store consumed by Dashboard, Reporting, UmsatzAbstimmung |
| `src/lib/umsatz.ts` | Revenue loading/aggregation from daily Z-report imports (`gn_imports`) |
| `src/lib/warenaufwand-gruppierung.ts` | Groups COGS accounts for display/calculation |
| `src/lib/op-liste-db.ts` / `op-liste-compare.ts` | Accounts-payable data + snapshot comparison logic |
| `src/lib/monat-param.ts` | Parses/validates the `?monat=YYYY-MM` deep-link param shared across several of these pages |

## Non-obvious rules and gotchas

- **"—" not 0.** Every KPI/finance calculation treats a genuinely missing
  data source as `null` → displayed as "—", never as 0. If you see a KPI
  showing 0 where you'd expect a dash, that's very likely a bug, not
  intended behavior.
- **`safeQuote()` guard in Reporting/PLView**: a ratio (e.g. COGS %) is only
  computed if revenue is ≥ CHF 1'000 for the period; below that it returns
  `null` rather than showing a nonsense percentage like 3297%.
- **No second P&L engine, ever.** If you're extending a page and tempted to
  compute an actual/budget/prior-year P&L value locally instead of calling
  `computePLForMonth` / the Financial Metrics Registry, that's against the
  codebase's own explicit convention (stated repeatedly in file headers) and
  will likely produce numbers that silently diverge from the P&L page.
- **Two budget systems** — see Data Flow above. Don't assume `/budget` and
  `/budget-eingabe` edit the same numbers.
- **VAT/MwSt handling**: revenue figures throughout this domain are net of
  VAT (`Netto`); the configurable VAT rates are loaded app-wide at boot by
  `MwstRatesGate` in `App.tsx` before any calculation page renders (falls
  back to defaults 8.1% / 2.6% if the load times out — never blocking).
- **Tenant scoping**: budget and reporting data is stored per-tenant via
  `tenantKey()` from `TenantContext` (Oliv keeps legacy unprefixed keys for
  backward compatibility; Beaulieu keys are prefixed `beaulieu:`). A page
  showing empty/wrong data after a tenant switch is often a scoping bug in
  whichever `src/lib/*-store.ts` it uses, not a data problem.
- **`beaulieu_manager` is explicitly locked out of `/budget` and
  `/erfolgsrechnung`** even though most other cockpit/reporting pages allow
  them (`allowBeaulieu` on the route guard) — this is intentional business
  logic (full P&L/budget editing stays admin-only), not an oversight to
  "fix."
- **`/analyse` (Soll/Ist)** is the one page in this domain **not** available
  to beaulieu_manager at all — it's scoped to admin + department managers
  only.

## Confidence notes

This document was built by reading page headers, `@/lib` import lists, and
the pre-existing `docs/kpi-inventar.md` / `docs/navigations-inventar.md`
planning docs, not a full line-by-line read of every page (several of these
files are 1,000–4,800 lines). The route/role table and the 16-KPI table are
high-confidence (sourced directly from `App.tsx` and `kpi-inventar.md`). The
"Data flow" and "Key files" sections are based on import analysis and file
header comments — accurate as an architectural map, but individual function
names inside `pl-engine.ts` / `financial-metrics.ts` were not exhaustively
verified beyond their headers.
