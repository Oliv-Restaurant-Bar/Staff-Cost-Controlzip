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
- **Reservations Import (Foratable):** `src/pages/ReservationenImportPage.tsx`, `src/lib/reservation-import-parser.ts`, `src/lib/reservation-analytics.ts`, `src/lib/reservation-import-db.ts`, `supabase/migrations/20260621_reservations.sql` (tables `reservation_imports`, `guest_profiles`, `reservation_records`). Separate from Gastronovi (`gn_*`) imports.
- **Gäste-CRM:** `src/pages/GaesteCrmPage.tsx` (list+search+segments), `src/pages/GaesteDetailPage.tsx` (per-guest chronology), `src/lib/reservation-crm.ts` (segment/metric logic, single source of truth), `src/lib/reservation-crm-db.ts` (read-only CRM reads). Metrics/segments are computed live in TS over `guest_profiles`/`reservation_records` (no dedicated tables). Optional read-only SQL view `guest_statistics` in `supabase/migrations/20260622_guest_statistics_view.sql` mirrors the exact `reservation-crm.ts` semantics for direct Supabase querying.

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
- **Reservations Import:** Imports Foratable reservation-tool CSV exports (admin only) with upload→preview→save wizard and per-file history; recognizes returning guests (email→mobile→name) for guest/behavior analytics.
- **Gäste-CRM:** Admin-only guest list with search (name/email/phone), visit count, first/last visit, average visit interval, and auto-segmentation (VIP ≥20 / Stammgast 8–19 / Wiederkehrend 3–7 / Neukunde 1–2 / Inaktiv >90d / Ohne Besuch). Per-guest detail page lists all reservations chronologically. A visit = a completed reservation. Optional `guest_statistics` SQL view exposes the same KPIs directly in Supabase.

## User preferences

### Datenintegrität — verbindliche Entwicklervorgabe
- **Umsatzdaten dürfen niemals per localStorage-Overwrite oder naivem Blob-Write gespeichert werden.**
- Jeder Schreibpfad für `dailyBudgets` / `beaulieu:dailyBudgets` muss `safeUpsertDailyBudgets()` verwenden.
- `safeUpsertDailyBudgets` liest immer zuerst den aktuellen Supabase-KV-Stand, mergt, schreibt zurück.
- Bei KV-Schreibfehler erscheint eine sichtbare Fehlermeldung — kein stilles Fallback auf localStorage.
- Die `daily_revenues`-Tabelle (Roadmap in diesem File) wird erst aktiviert, wenn die aktuelle Lösung fachlich fertig getestet ist. Bis dahin keine Migration ausführen.

## Technische Roadmap — daily_revenues Migration

### Kontext
Tagesumsätze werden aktuell als grosser KV-Blob in `app_settings` gespeichert
(Schlüssel `dailyBudgets` / `beaulieu:dailyBudgets`). Als Sofortschutz gegen
Datenverlust wurde `safeUpsertDailyBudgets` eingeführt (liest KV → mergt →
schreibt zurück). Diese Lösung ist stabil, hat aber strukturelle Grenzen:
kein Audit-Log, kein atomarer UPSERT pro Tag, Merge-Konflikte bei Parallelzugriff.

### Zielarchitektur
Normalisierte Tabelle `daily_revenues` in Supabase Postgres:
```sql
-- Vorbereitet in supabase/migrations/20260507_daily_revenues.sql
CREATE TABLE daily_revenues (
  restaurant_id TEXT    NOT NULL,  -- 'oliv' | 'beaulieu'
  date          DATE    NOT NULL,
  actual_revenue        NUMERIC,
  planned_revenue       NUMERIC,
  actual_food           NUMERIC,
  actual_beverage       NUMERIC,
  actual_labor_cost     NUMERIC,
  previous_year_revenue NUMERIC,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  updated_by    TEXT,              -- user email für Audit-Trail
  PRIMARY KEY (restaurant_id, date)
);
```
Jeder Tag hat einen eindeutigen Datensatz — kein Blob, kein Merge nötig.

### Migrationsschritte (in dieser Reihenfolge)

**Schritt 1 — SQL-Migration ausführen**
- Script `supabase/migrations/20260507_daily_revenues.sql` im Supabase SQL-Editor
  ausführen (noch nicht aktiv).
- Zählt bestehende KV-Daten vor und nach der Migration (Abweichung = 0 prüfen).

**Schritt 2 — Datenmigration KV → Tabelle**
- Einmalige Server-Side-Migration: alle Einträge aus `app_settings` wo
  `key IN ('dailyBudgets', 'beaulieu:dailyBudgets')` als normalisierte Zeilen
  in `daily_revenues` einfügen.
- Validierung: `SELECT count(*) FROM daily_revenues` muss ≥ bisherige Blob-Tage.

**Schritt 3 — Neue Datenbankschicht**
- Neue Datei `src/lib/daily-revenues-db.ts` mit:
  - `upsertDailyRevenue(restaurantId, date, fields)` → atomarer UPSERT inkl.
    `updated_by` und `updated_at`
  - `getDailyRevenues(restaurantId, fromDate, toDate)` → Rückgabe als Map
  - `getDailyRevenueMonth(restaurantId, year, month)` → 31-Tage-Array
- Kein localStorage mehr für Tagesumsätze — direkt aus Supabase Postgres.

**Schritt 4 — Lese- und Schreibpfade umstellen**
Betroffene Komponenten (alle nutzen aktuell `safeUpsertDailyBudgets`):
1. `GastronoviImportSection` (handleSave, commitImport, handleImportClick)
2. `TagesansichtPage` (saveManualIst)
3. `TagesControllingPage` (commitUmsatzEdit)
4. `Dashboard` (saveRevenue)
5. `useVj2025Import` (Vorjahres-Seed)
6. `usePersonnelData` (Lohnkosten-Schreibpfad)
7. `SchedulePlanner` (Lohnkosten-Tagesblock)

**Schritt 5 — Audit-Log**
- Tabelle `daily_revenues` enthält `updated_by` (Email des einloggten Benutzers)
  und `updated_at` (Timestamp).
- Optional: separate `daily_revenues_audit`-Tabelle mit Trigger für vollständigen
  Change-History.

**Schritt 6 — Fallback entfernen**
- `safeUpsertDailyBudgets` auf Read-Only-Fallback reduzieren (nur noch lesen,
  nicht mehr schreiben).
- `useSyncStore` `SYNC_KEYS`-Liste: `dailyBudgets` entfernen.
- localStorage-Einträge `dailyBudgets` / `beaulieu:dailyBudgets` nach Migration
  löschen (Cleanup-Script).

**Schritt 7 — Integrationstests**
Alle vier Views müssen für jeden Testtag identische Werte zeigen:
- Tagesansicht (`TagesansichtPage`)
- Dashboard (`Index.tsx`)
- Tages-Controlling (`TagesControllingPage`)
- Erfolgsrechnung / P&L (`PLView.tsx`)

Testscript: `src/lib/__tests__/daily-revenues-integration.test.ts` (noch zu erstellen).

### Status
- [x] SQL-Migration-Script vorbereitet (`supabase/migrations/20260507_daily_revenues.sql`)
- [ ] SQL-Script im Supabase SQL-Editor ausführen
- [ ] Datenmigration KV → Tabelle
- [ ] `daily-revenues-db.ts` implementieren
- [ ] Schreibpfade umstellen
- [ ] Audit-Log aktivieren
- [ ] Fallback entfernen
- [ ] Integrationstests

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