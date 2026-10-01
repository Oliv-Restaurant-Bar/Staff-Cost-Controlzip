# Waren & Verkauf (Cost-of-Goods and Sales/Revenue)

This document covers two related but distinct sub-areas of the app, both reachable from the "Waren" (goods) and "Verkauf" (sales) sections of the navigation:

1. **Cost-of-goods tracking** — recording what the restaurant spends on food/beverage supplies (supplier invoices, article master data, purchase tracking) and reconciling it against both a theoretical recipe-based cost and the official bookkeeping import.
2. **Sales/revenue analysis** — importing daily point-of-sale export data (from the Gastronovi POS system) and breaking it down by product, category, time period, and comparing it to prior-year and budget figures.

Both feed into the **WES ratio** ("Wareneinsatz" — cost-of-goods-sold as a percentage of revenue), which is one of the core KPIs on the management cockpit (see `docs/kpi-inventar.md`, KPIs #2 "Warenaufwand", #3 "Warenquote", #14 "Wareneinsatz (verkaufsbasiert)").

## Mental model: three parallel sources of truth for cost-of-goods

A recurring theme across this whole domain is that there are **three independent ways to arrive at a cost-of-goods figure**, and the app deliberately keeps them separate rather than merging them, so they can be compared against each other:

1. **Recipe-based (theoretical)** — `Rezeptur` × units sold. What the cost *should* be if recipes are followed exactly.
2. **Supplier-document-based (operational)** — `Lieferantendokumente` / `Warenrechnungen`, entered by staff from delivery notes and invoices. These are explicitly documented as **estimates** ("Lieferantendokumente sind SCHÄTZWERTE. Sie ersetzen NIEMALS die offiziellen Buchhaltungswerte") — fast to get but not authoritative.
3. **Bookkeeping-based (official)** — the Sage accounting import (accounts 4020–4070; account 4090 "Diverses" is shown for reference but does **not** count toward WES — this matches the P&L "Direkter Warenaufwand" and the Warenkostenquote KPI). This is always the authoritative number once available.

The `/wes-analyse` page exists specifically to show all three side by side. Don't treat the supplier-document numbers as final — they're a faster, less accurate proxy while waiting for the monthly accounting close.

## Pages

| Route | File | English name | Purpose | Access |
|---|---|---|---|---|
| `/produkte` | `Produkte.tsx` | Products | Product/recipe base data management (components, recipes) | all authenticated |
| `/artikel` | `Artikel.tsx` | Articles (Stage 1) | Central F&B article database — the basis for recipe costs, supplier invoices, inventory, and theoretical stock | all authenticated |
| `/artikel-tracking` | `ArtikelTracking.tsx` | Article Tracking | Per-article purchase & consumption analysis: quantity/cost purchased per month, order frequency, theoretical consumption (recipe × sales) vs. actual purchases, and the delta between them | all authenticated |
| `/warenrechnungen` | `Warenrechnungen.tsx` | Supplier Invoices | The main goods-cost entry & control module (very large file, ~7,900 lines). Two tabs: **Erfassung** (entry — KPI boxes, quick entry, recent entries) and **Analyse** (supplier overview, cumulative trend). Tenant-aware (Oliv/Beaulieu via TenantContext) | `canAccessModule('warenrechnungen')`: admin, beaulieu_manager (full), beaulieu_viewer (view/export only) — see fine-grained `warenrechnungenPerms` below |
| `/wes-analyse` | `WesAnalyse.tsx` | WES Analysis | Compares the three cost-of-goods sources described above (recipe / supplier-document / bookkeeping) | all authenticated |
| `/lieferanten` | `SupplierDocuments.tsx` | Supplier Documents | Admin-only. Supplier master data (incl. default account + default category), invoice/delivery-note entry with account mapping, and a reconciliation view (operational vs. official closing figures). Explicitly documents its own numbers as estimates, never a replacement for the PDF/CSV accounting import | admin only |
| `/lieferanten-vergleich` | `SupplierComparison.tsx` | Supplier Comparison | Admin-only. Compares operational supplier documents against official bookkeeping values (CSV/PDF import) | admin only |
| `/tagesansicht` | `TagesansichtPage.tsx` | Daily View | The single surface for entering/reviewing daily revenue: day-by-day comparison of actual vs. prior-year vs. budget, plus a cumulative running total. Prior-year logic: same calendar day, year−1, falling back from imported `previousYearRevenue` to the actual prior-year daily record | admin only (per header comment "Nav: Verkauf → Tagesansicht (adminOnly)") |
| `/tages-controlling` | `TagesControllingPage.tsx` | Daily Controlling | Operational daily personnel-cost & WES controlling. Per-day columns: revenue, planned vs. actual personnel cost (CHF and %), WES CHF/%. Supports Week/Month/Year period modes. Pulls personnel-plan from `schedule-v2-YYYY-MM`, personnel-actuals from `timeEntries`, WES from supplier documents or bookkeeping | admin only |
| `/verkauf-dashboard` | `VerkaufsDashboard.tsx` | Sales Dashboard | Deliberately minimal — reads only from the `product_sales` table (no external dependency), aggregated by source (Food/Beverage/Manual). Legacy rows with `source IS NULL` are ignored | admin (+ Beaulieu, per navigations-inventar.md — secondary nav item, behind "Mehr") |
| `/sales-upload` | `SalesUpload.tsx` | Sales Upload | The production Gastronovi CSV import flow: select files (count + revenue, per Food/Beverage) → enter metadata (year required) → parse & match by product name → preview with stats → import into `product_sales` → update import history | admin |
| `/produkt-analyse` | `ProduktAnalyse.tsx` | Product Analysis | Consolidated tabbed container (Overview / Products / Categories / Lunch / Take-away) — replaces the older separate `/lunch-analyse`, `/takeaway-analyse`, `/kategorien` routes, which now redirect here as tabs. Loads `product_sales` rows once and shares them across tabs; filter state is mirrored into the URL for bookmarking/back-forward | all authenticated |
| `/produkt-analyse/produkt` | `ProduktDetail.tsx` | Product Detail | Drill-down for a single product (via `?name=&period=` query params), showing revenue/count breakdown by day/week/month/year depending on the selected period | all authenticated |
| `/produkt-stamm` | `ProduktStamm.tsx` | Product Master Data | Manages WES-per-unit cost data in the `produkte_kosten` Supabase table (name, category, WES). Includes "populate from sales data" to backfill product names from `product_sales` | all authenticated |

## Data flow

- **Sales ingestion:** `SalesUpload.tsx` → `gastronovi-csv-parser.ts` (parsing/matching) → `sales-db.ts` (writes to `product_sales`).
- **Sales analysis:** `ProduktAnalyse.tsx` / `ProduktDetail.tsx` → `sales-db.ts` (reads `product_sales`) → `product-analytics.ts` / `produkt-zeitraum.ts` / `zeitraum.ts` (period aggregation logic) / `produkt-quellen.ts` / `gn-zbericht-db.ts`.
- **Cost-of-goods entry:** `Warenrechnungen.tsx` is the hub — it touches roughly 25 `src/lib/waren-*.ts` files (invoice DB, reconciliation/`waren-abgleich`, deduplication/`waren-dubletten`, category mapping/`waren-klassen`, PDF-recognition/`waren-pdf-erkennung`, monthly reconciliation, FIBU (bookkeeping) matching/take-over, cost export, target-ratio, etc.) plus `lieferanten-profile.ts`, `pl-engine.ts` (P&L engine), `reporting-store.ts`, `supabase-kv.ts`, `journal-dedupe.ts`, `umsatz.ts`.
- **WES comparison:** `WesAnalyse.tsx` → `wes-month.ts` (month-level WES aggregation) + `reporting-store.ts` (bookkeeping) + `supplier-documents-store.ts` (operational) + `produkte-store.ts` (recipe-based) + `monat-param.ts` (URL month param handling).
- **Article/recipe base data:** `Artikel.tsx` → `artikel-store.ts`; `ArtikelTracking.tsx` → `artikel-tracking-store.ts` + `artikel-store.ts` + `produkte-store.ts` + `rezeptur-store.ts`; `Produkte.tsx` → `produkte-store.ts`, `basiskomponenten-store.ts`, `rezeptur-store.ts`.
- **Supplier documents:** `SupplierDocuments.tsx` / `SupplierComparison.tsx` → `supplier-documents-store.ts` + `account-mapping-store.ts` (chart-of-accounts mapping).
- **Daily revenue/controlling:** `TagesansichtPage.tsx` → `budget-day.ts`, `vj-daily-supabase.ts` (prior-year), `reporting-store.ts`, `umsatz.ts`, `supabase-kv.ts`, `maison-store.ts` (tenant/property config). `TagesControllingPage.tsx` → `wage-history.ts`, `waren-db.ts`, `supabase-db.ts`, `supabase-kv.ts`, `umsatz.ts`, `maison-store.ts`.

## Key files (src/lib)

| File | Purpose |
|---|---|
| `waren-db.ts` | Core Warenrechnungen (supplier invoice) data access |
| `waren-analyse.ts` / `waren-cockpit.ts` | Aggregation/analysis views over goods-cost data |
| `waren-abgleich.ts` / `waren-abgleich-ignoriert.ts` | Reconciliation between operational and bookkeeping figures, with an ignore-list for known non-matches |
| `waren-fibu-matches.ts` / `waren-fibu-uebernahme.ts` | Matching and taking over bookkeeping ("FIBU") entries |
| `waren-monatsabgleich.ts` | Monthly reconciliation |
| `waren-dubletten.ts` | Duplicate detection for invoice entries |
| `waren-pdf-erkennung.ts` / `profil-pdf-parse.ts` | PDF invoice recognition/parsing |
| `ziel-warenquote.ts` / `warenkosten-quote.ts` | Target and actual cost-of-goods ratio calculations |
| `wes-month.ts` | Month-level WES (cost-of-goods-sold) aggregation, the SSoT consumed by both `/wes-analyse` and KPI #14 |
| `sales-db.ts` | Core `product_sales` data access |
| `gastronovi-csv-parser.ts` | Parses the Gastronovi POS CSV export format |
| `product-analytics.ts` | Aggregation logic for the product analysis tabs (SSoT — "no new calculation logic" per the `ProduktAnalyse.tsx` header comment) |
| `produkt-stamm-db.ts` | `produkte_kosten` table access (WES-per-unit master data) |
| `supplier-documents-store.ts` | Supplier + supplier-document data access |
| `account-mapping-store.ts` | Chart-of-accounts (Kontenplan) mapping used by supplier document entry |

## Gotchas / non-obvious rules

- **`WarenrechnungenPerms` is independently granular**, not a single on/off module flag (`src/hooks/usePermissions.ts`): `canView`, `canCreate`, `canEdit`, `canDelete`, `canExport` are each computed separately. `admin`/`beaulieu_manager` get all five; `beaulieu_viewer` gets only `canView` + `canExport` (export is itself gated by a `VIEWER_CAN_EXPORT` constant, currently `true`); every other role gets none. When testing a fix here, check which specific permission your test role has — "can access the page" doesn't mean "can edit".
- **`product_sales` vs. `gn_*` tables are different data sources**, per `docs/navigations-inventar.md`: `/verkauf-dashboard` and `/produkt-analyse` read `product_sales` (from the Gastronovi CSV upload flow), while the KPI catalog's guest/average-check KPIs (#11–13) read `gn_person_metrics`. Don't assume these two feeds are reconciled with each other — the overlap between `/verkauf-dashboard` and `/produkt-analyse` is called out in navigations-inventar.md as intentional, not a duplicate to merge.
- **Legacy rows with `source IS NULL`** in `product_sales` are silently ignored by `VerkaufsDashboard.tsx`'s aggregation — if a test import looks "missing" data, check whether the `source` column was populated.
- **Supplier-document figures are estimates, never authoritative** — both `SupplierDocuments.tsx` and `SupplierComparison.tsx` state this explicitly in their header comments. Any fix that touches cost-of-goods numbers should be verified against the bookkeeping import path too, not just the supplier-document path.
- **Account 4090 ("Diverses") is excluded from WES** even though it's a goods-related account — it's shown for reference in `WesAnalyse.tsx` but intentionally not summed into the ratio, to stay consistent with the P&L "Direkter Warenaufwand" definition and the Warenkostenquote KPI.
- **`Warenrechnungen.tsx` is tenant-aware** via `TenantContext` — verify test data/fixes against both the Oliv and Beaulieu tenants, since `beaulieu_manager`/`beaulieu_viewer` roles are locked to Beaulieu and see a filtered dataset.
- **`/produkt-analyse` consolidates several old routes** (`/lunch-analyse`, `/takeaway-analyse`, `/kategorien`) as redirects into tabs of one page — if you're tracing an old bug report that mentions one of those URLs, the actual code now lives in `ProduktAnalyse.tsx`'s tab components, not a standalone page.
- **`/tagesansicht` is described in its own header as the sole revenue-entry surface** — other pages (like `/tages-controlling`) read the same `dailyBudgets` data but don't provide their own entry UI for it.

## Not independently verified

This research was done by reading file header comments and import lists, not by running the app or reading every function body in depth (`Warenrechnungen.tsx` in particular is ~7,900 lines — only its header and lib-import list were reviewed, not its internals). Treat the "Data flow" section as a reliable map of *which* files are involved, but verify exact function names/behavior by reading the specific file before relying on it for a fix.
