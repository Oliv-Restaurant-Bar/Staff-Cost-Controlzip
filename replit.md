# Personalkostentracker
An internal reporting tool for revenue, personnel costs, schedules, and KPIs, supporting multiple restaurant tenants.

## Run & Operate
- **Run:** `npm run dev`
- **Build:** `npm run build`
- **Required Env Vars:** Supabase URL and Anon Key (see `src/integrations/supabase/client.ts`)

## Stack
- **Frameworks:** React, TypeScript, Shadcn UI, Tailwind CSS
- **Runtime:** Node.js (via Vite)
- **Database/ORM:** Supabase (Auth, Postgres DB, KV Store)
- **Date Handling:** `date-fns`
- **Charting:** `recharts`

## Where things live
- **Core Application:** `src/App.tsx`
- **Tenant Management:** `src/contexts/TenantContext.tsx`, `src/components/TenantSwitcher.tsx`, `src/lib/tenant-utils.ts`
- **Supabase Integration:** `src/integrations/supabase/client.ts`, `src/lib/supabase-db.ts`, `src/lib/supabase-kv.ts`
- **Database Schema:** `supabase/setup_new_project.sql` (and migration scripts in `supabase/migrations/`)
- **Authentication & Permissions:** `src/contexts/AuthContext.tsx`, `src/hooks/usePermissions.ts`
- **Routing:** Defined in `src/App.tsx`
- **UI Components:** `src/components/`
- **Pages:** `src/pages/`
- **Reporting & Financials:** `src/types/reporting.ts`, `src/lib/reporting-store.ts`, `src/types/pl.ts`, `src/lib/pl-engine.ts`, `src/pages/PLView.tsx`
- **Budgeting:** `src/types/budget.ts`, `src/lib/budget-store.ts`, `src/pages/Budget.tsx`
- **Product & Inventory:** `src/pages/Artikel.tsx`, `src/lib/artikel-store.ts`, `src/pages/ProduktStamm.tsx`, `src/lib/produkt-stamm-db.ts`, `src/pages/WesAnalyse.tsx`, `src/pages/ArtikelTracking.tsx`, `src/lib/artikel-tracking-store.ts`
- **Schedule Planner:** `src/pages/SchedulePlanner.tsx`, `src/lib/pattern-warnings.ts`
- **CSV/PDF Import:** `src/lib/csv-import-engine.ts`, `src/lib/pdf-import-engine.ts`, `src/pages/CSVImport.tsx`
- **Supplier Documents:** `src/types/supplier-documents.ts`, `src/lib/supplier-documents-store.ts`, `src/pages/SupplierDocuments.tsx`, `src/pages/SupplierComparison.tsx`
- **Onboarding Flow:** `src/pages/OnboardingPage.tsx`, `src/components/onboarding/`

## Architecture decisions
- **Multi-tenancy:** Implemented via ID prefixes (`b-` for Beaulieu) in Supabase `employees` and `app_settings` keys, avoiding a dedicated `restaurant_id` column for simplicity and backwards compatibility.
- **Data Persistence Strategy:** LocalStorage is used as the primary, fast data store, with Supabase `app_settings` serving as a secondary, persistent backup, especially for financial and budget data. A sync hook (`useSyncStore`) handles this.
- **Authorization:** A centralized `usePermissions` hook enforces role-based access control, defined in `src/hooks/usePermissions.ts`, for granular control over features and data visibility.
- **Onboarding Flow:** Supports both existing employees completing details via a tokenized link and new self-registrations creating `pending_review` employee records for admin approval.
- **Time-based Reporting:** A global "Stichtag" (cut-off date) filter (`StichtagContext`) allows historical reporting and period closing, impacting various financial views.

## Product
- **Dashboard:** Overview of KPIs, revenue, costs, pro-rata personnel costs.
- **Schedule Planning:** Plan and actual shift schedules.
- **Target/Actual Analysis:** Comparison of planned vs. actual performance.
- **Personnel Master Data:** Employee data management (admin only).
- **Reporting/Financial Module:** Comprehensive financial data including prior year comparisons (P&L, budget).
- **Fixed Personnel Costs:** Overview of monthly salaries including 13th month salary by department.
- **Multi-Tenant Support:** Manage data for multiple restaurants (Oliv, Beaulieu) with tenant-specific data isolation.
- **Role-Based Access:** Different user roles (admin, service_manager, kueche_manager) have varying data access and permissions.
- **Onboarding System:** Facilitates employee data collection and self-registration.
- **Guest Link System:** Allows admins to generate temporary, password-protected read-only links for sharing sessions.
- **Pattern Warnings:** Identifies operational risks in schedules (e.g., consecutive days, short recovery times).
- **Product Master Data:** Centralized database for food/beverage articles, WES (cost of goods sold) per product, and tracking.
- **WES Analysis:** Compares WES from recipes, suppliers, and accounting for cost control.

## User preferences
_Populate as you build_

## Gotchas
- **Supabase Migrations:** All SQL migration scripts in `supabase/migrations/` **must** be executed sequentially in the Supabase SQL Editor.
- **Tenant Filtering:** Data for Beaulieu is filtered by `id LIKE 'b-%'` and for Oliv by `id NOT LIKE 'b-%'`; there is no explicit `restaurant_id` column.
- **Mirus Name Mapping:** Manual mapping might be required for Mirus imports to correctly link employee names.
- **Default Budget Seed:** The 2026 budget is seeded automatically upon first load if no `plLineItems` exist for that year.

## Pointers
- **Supabase Documentation:** [https://supabase.com/docs](https://supabase.com/docs)
- **React Documentation:** [https://react.dev/](https://react.dev/)
- **Tailwind CSS Documentation:** [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
- **Shadcn UI Documentation:** [https://ui.shadcn.com/docs](https://ui.shadcn.com/docs)
- **Vite Documentation:** [https://vitejs.dev/guide/](https://vitejs.dev/guide/)