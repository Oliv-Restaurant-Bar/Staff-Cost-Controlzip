# Personalkostentracker

Internes Reporting-Tool für Umsatz, Personalkosten, Dienstpläne und KPIs — mandantenfähig (Oliv, Beaulieu).

## Run & Operate
- **Run:** `npm run dev` · **Build:** `npm run build` · **Tests:** `npx vitest run`
- **Env Vars:** Supabase URL + Anon Key (`src/integrations/supabase/client.ts`)
- **Große Builds:** bei OOM (Exit -1 ohne Output) mit `NODE_OPTIONS=--max-old-space-size=8192 npx vite build` erneut ausführen.

## Stack
- React + TypeScript + Vite, Shadcn UI, Tailwind CSS
- Supabase (Auth, Postgres, KV in `app_settings`), `date-fns`, `recharts`

## Architektur & Konventionen
- **Multi-Tenancy:** über ID-Präfixe (`b-` = Beaulieu) in `employees`/`app_settings` — **KEINE `restaurant_id`-Spalte** auf `employees`/`app_settings` (Filter `id LIKE 'b-%'` bzw. `NOT LIKE`). Reservations-/CRM-Tabellen haben `restaurant_id`; jeder Read/Write ist tenant-gefiltert.
- **Persistenz:** localStorage als schneller Primärspeicher + Supabase `app_settings` (KV) als persistentes Backup (`useSyncStore`). Finanz-/Budgetdaten NIE per naivem Blob-Write speichern (s. User preferences).
- **Auth/Rollen:** zentral in `src/hooks/usePermissions.ts` (+ `src/contexts/AuthContext.tsx`). Rollen admin / service_manager / kueche_manager / beaulieu_* / Gast. Admin-only-Seiten gaten `isAdmin && !isGuest` auf Route-Guard UND Lade-Effekt (Fetch feuert vor `Navigate`).
- **Stichtag:** globaler Cut-off-Filter (`StichtagContext`) für historisches Reporting/Periodenabschluss.
- **Reine Logik:** Analyse-/Berechnungs-Libs (`src/lib/*-utils.ts`, `*-analytics.ts`) sind DOM-/Supabase-frei (nur `import type`) und synthetisch getestet. Test-Dateien für Node-Only-Logik brauchen `// @vitest-environment node` in Zeile 1 (sonst jsdom/libuuid-Crash).
- **Wo Dinge leben:** `src/pages/` (Seiten), `src/components/` (UI), `src/lib/` (Logik + DB-Layer), `src/types/` (Modelle), `src/contexts/`, `src/hooks/`, `supabase/migrations/` (SQL). Kern: `src/App.tsx` (Routing), `src/components/AppNav.tsx` (Navigation: `DASHBOARD_ITEM` + `NAV_GROUPS`, longest-path-Highlighting; `/reporting` bewusst nur per URL erreichbar). Tenant: `src/contexts/TenantContext.tsx`, `src/lib/tenant-utils.ts`. Supabase: `src/lib/supabase-db.ts`, `supabase-kv.ts`. Schema: `supabase/setup_new_project.sql`.

## Module

### Reporting & Finanzen
- **Erfolgsrechnung / P&L:** `src/pages/PLView.tsx`, `src/lib/pl-engine.ts`, `src/types/pl.ts`, `src/lib/reporting-store.ts`, `src/types/reporting.ts`. Vorjahres-Diagnose-Banner (nur Sichtbarkeit, keine Berechnung): rein `src/lib/pl-prior-year-diagnostics.ts`.
- **Budget:** `src/pages/Budget.tsx`, `src/lib/budget-store.ts`, `src/types/budget.ts`. 2026-Seed automatisch beim ersten Laden ohne `plLineItems`.
- **Tagesumsätze:** KV-Blob `dailyBudgets` / `beaulieu:dailyBudgets`; Schreiben NUR via `safeUpsertDailyBudgets` (read → merge → write, sichtbarer Fehler statt stillem Fallback). Roadmap: Normalisierung nach `daily_revenues` (s. u.).

### Personal
- **Personalstamm:** `src/pages/Personalstamm.tsx` (admin + eingeschränkt `kueche_manager`). Lohn-Gating: Löhne unter `canSeeHourlyWages`/`canEditWages`; vertrauliche Flächen (Persönliche Daten inkl. AHV/IBAN, Verträge, Duplikat-Warnung, pending_review) unter lokalem Gate `canManageAllEmployees = isAdmin || isBeaulieuManager`. `kueche_manager` sieht NIE Löhne/PII, bearbeitet nur Küchen-Stammdaten (Abteilung auf Küche gesperrt).
- **Positionen/Stationen:** `src/pages/Positionen.tsx` (admin), rein `src/lib/position-utils.ts`, `src/lib/positions-db.ts`, `src/hooks/usePositions.ts`, Migration `supabase/migrations/20260625_positions.sql` (+ `employees.primary_station`/`secondary_stations`). Stabile **Keys (Slugs)**, nie Anzeigenamen, in `employee.primaryStation`/`secondaryStations` → Umbenennen bricht Zuordnungen nicht. Hierarchie Abteilung → Bereich → Position; `applyDefaultPositions` deaktiviert (löscht nicht) übrige Positionen. Qualifikationen auch im Personalstamm editierbar (Cross-Training).
- **Personalbedarf (SOLL-Besetzung):** `src/pages/Personalbedarf.tsx` (admin), rein `src/lib/staffing-requirements-utils.ts`, `-db.ts`, `src/hooks/useStaffingRequirements.ts`, Migration `20260625_staffing_requirements.sql`. Pro (Saison × Wochentag) je Position ≥1 Schicht; vollständig getrennt von der Dienstplanung (kein FK). Erweiterbar über neue `scope_type`-Werte + `meta` jsonb OHNE künftige Migration. Orphan-Schutz: Schichten inaktiver Positionen bleiben beim Speichern erhalten.
- **Personalbedarf-Abgleich (SOLL/Ist, nur ANZEIGE):** rein `src/lib/staffing-comparison-utils.ts` + `src/components/schedule-planner/StaffingComparisonPanel.tsx`, `DayStaffingBadge.tsx`, `StaffingScheduleCheckCard.tsx`; geteilte Darstellungsbausteine (Status-Stile, Badge, Differenz-Tooltip, KPI-Kacheln) in `staffing-status-ui.tsx`. **2-Farben-Warnung** (`ComparisonStatus` = `optimal`|`overstaffed`|`understaffed`): exakt = optimal/grün, JEDE Abweichung (auch ±1) = rot; Richtung nur über Label (Überbesetzt/Unterbesetzt) + Differenztext (`formatStaffingDiffPersons`, U+2212-Minus). KPI-Kacheln via `summarizeStaffingKpis` (Optimal/Überbesetzt/Unterbesetzt in Bedarfs-Schichten + Überstunden-Potenzial = Σ fehlende Personen × Schichtdauer in Personen-Stunden). Tabellen: Benötigt/Geplant/Differenz(Tooltip)/Status-Badge. Tooltip (`staffingTooltipLines`) zeigt Umsatz/Produktivität nur, wenn Werte übergeben werden — dieses Modul führt KEINE Umsatzquelle. Matching NUR über Hauptposition; rollen-scoped (`departments`-Filter → kein Cross-Department-Leak). Ändert KEINE Plan-/Kosten-/Overtime-Daten, keine neue Tabelle.
- **Dienstplan:** `src/pages/SchedulePlanner.tsx`, `src/components/schedule-planner/*`, `src/lib/pattern-warnings.ts`. Manager-Sichtbarkeit zentral über `src/lib/employee-visibility.ts` (eingeschränkte Rolle GEWINNT; RAW-`employees` nur für Import-Match/CRUD/localStorage). Küchen-Manager-Tagesheader lohn-sicher (`src/lib/schedule-daily-totals.ts` — kein CHF-Betrag erreicht das DOM). Export abteilungstreu (`src/lib/schedule-export-department.ts`). Schicht-Farbe/Legende: `src/components/schedule-planner/ShiftLegend.tsx`.
- **Überstundenkosten Festangestellte:** `/personal-fix` (`src/pages/PersonalFix.tsx`) + rein `src/lib/overtime-analysis.ts`. Monatslogik: `overtime = max(0, produktive Ist − Monatssoll)`, Soll = `42h × (Tage/7) × Pensum`. Nur Festangestellte (`vollzeit|teilzeit` UND `monthlySalary>0`); Absenzen zählen nie als produktiv; Pro-MA-Deaktivierung möglich.

### Produkte & Warenkosten
- **Stammdaten/Analyse:** `src/pages/Artikel.tsx`, `ProduktStamm.tsx`, `WesAnalyse.tsx`, `ArtikelTracking.tsx` + zugehörige Stores in `src/lib/`.
- **Produkt-Analyse (Rangliste + Drill-down):** `src/pages/ProduktAnalyse.tsx` → `ProduktDetail.tsx`, rein `src/lib/product-analytics.ts`. Perioden Tag/Woche/Monat/Jahr (ISO-Wochen mit 52/53-Rollover), Filter URL-gespiegelt (refresh-/back-fest). `product_sales` hat keine `restaurant_id` — nur boundary-treue reine Funktionen, keine Schema-Änderung.
- **Lieferantendokumente:** `src/pages/SupplierDocuments.tsx`, `SupplierComparison.tsx` + `src/lib/supplier-documents-store.ts`.

### Importe
- **CSV/PDF:** `src/lib/csv-import-engine.ts`, `pdf-import-engine.ts`, `src/pages/CSVImport.tsx`.
- **Gastronovi Produkt-CSV:** `src/pages/SalesUpload.tsx` + rein `src/lib/gastronovi-csv-parser.ts` → `product_sales`. `matchAnzahlUmsatz` summiert je (Produkt, Datum) zu genau EINEM Record; gleiche Namen/verschiedene Preise werden unvermeidlich summiert (flaches CSV, keine Artikelnr.).
- **Import-Center:** `/import` = `src/pages/ImportHub.tsx`, rein `src/lib/import-center.ts` (+ `-db.ts`). Launcher-Modell; Sichtbarkeit spiegelt echte Route-Guards (admin 9 / beaulieu_manager 3 / beaulieu_viewer 1 / Gast 0); nie Zeitstempel erfinden.
- **Foratable (Sammelseite):** `src/pages/ForatableImportPage.tsx` (`?tab=reservationen|gaeste|verlauf`); Alt-Routen `/reservationen-import`, `/gaeste-import` redirecten.
- **Reservations-Import:** `src/pages/ReservationenImportPage.tsx`, rein `src/lib/reservation-import-parser.ts`, `-db.ts`, Migration `20260621_reservations.sql` (`reservation_imports`/`guest_profiles`/`reservation_records`). Idempotent via UNIQUE `(restaurant_id, external_reservation_id)`. Gast-Match nur Telefon → E-Mail (nie Name); Name-only-Bookings de-duplizieren über `(restaurant_id, match_key)`.
- **Gästeexport-Import (CRM-Anreicherung):** `src/pages/GaesteImportPage.tsx`, rein `foratable-guest-import(-parser).ts`, `-db.ts`. Füllt NUR leere manuelle CRM-Felder — überschreibt nie, fasst Reservationen/Segmente/Besuchszähler nicht an. Match E-Mail → Telefon → Name (Ambiguität = „nicht zugeordnet").
- **Import-Historie:** Tabelle `import_runs` (`20260623_import_runs.sql`), rein `import-runs.ts` + `-db.ts`. `logImportRun` best-effort/wirft nie, additiv, keine PII, `finished_at` = DB `now()`.

### Gäste-CRM & Reservationen
- **CRM-Liste + Kern:** `src/pages/GaesteCrmPage.tsx`, rein `src/lib/reservation-crm.ts` (Single Source für Segment/Metrik — rein besuchsbasiert, `reservation_records` hat keine Geldspalte), `reservation-crm-db.ts` (read-only, tenant-isoliert). Manuelle CRM-Badges/Filter über `guest-list-filters.ts` (fehlendes CRM → alle Flags false). Optionale read-only View `guest_statistics` (`20260622_*`) spiegelt die TS-Semantik.
- **Manuelles CRM-Profil:** Tabelle `guest_crm_profiles` (`20260622_*`; kein `restaurant_id`, Tenant über Eltern-Gast), rein `guest-crm-profile.ts`, `-db.ts` (verifiziert Tenant vor Read/Write, wirft bei Schreibfehler). Strikt getrennt von berechnetem Segment/Score/Kampagnen.
- **Smart-Segmente:** rein `src/lib/guest-smart-segments.ts` (7 Live-Segmente, Mehrfachzugehörigkeit, strikt additiv, keine neue Query/Migration).
- **Detailseite (Kundenakte):** `src/pages/GaesteDetailPage.tsx` (admin `/gaeste/:guestId`), rein `reservation-guest-profile.ts`. Tabs Übersicht/CRM/Aktivität; gewichteter CRM-Score 0–100.
- **CRM Auswertung:** `src/pages/CrmAuswertungPage.tsx` (admin `/gaeste/auswertung`), rein `reservation-dashboard.ts`. Tabs Übersicht/Rückkehrpotenzial/Kampagnen; Kachel-Zählung und Drilldown-Liste stammen aus DENSELBEN Rows. View-State open-redirect-sicher in URL (`crm-auswertung-url.ts`).
- **Kampagnen:** rein `src/lib/reservation-campaigns.ts` (18 Listen; manuelle CRM-Kampagnen lesen nur `m.crm`, nie das berechnete Segment). CSV UTF-8 mit BOM (in der Seite), `;`-getrennt, CRLF, dt. Header.
- **Rückkehrpotenzial:** rein in `reservation-dashboard.ts` (Tab-Faktor `OVERDUE_INTERVAL_FACTOR=1.5`) + Gästeliste-Metrik (`RETURN_RISK_FACTOR=2.0`, `reservation-crm.ts`) — beide koexistieren bewusst.
- **Duplikate:** `src/pages/GaesteDuplikatePage.tsx` (admin `/gaeste/duplikate`), rein `guest-duplicates.ts`, `-db.ts`. Merge ohne DB-Transaktion: Preflight (Cross-Tenant-Abort) → Reservationen zuerst umhängen (FK SET NULL) → CRM-Merge → Aggregate NEU berechnen (nie summieren) → Postcondition-Check → Duplikate löschen → PII-freies Audit (`20260623_guest_merge_log.sql`).
- **Segment-Aktionen (intern):** `SegmentActionBar.tsx`, rein `crm-activities.ts`, `-db.ts`, Migration `20260624_crm_activities.sql` (manuell ausführen). `verifyGuestsBelongToTenant` vor JEDEM Write; keine E-Mails/externen Integrationen.
- **Reservations Analyse (konsolidiert):** `src/pages/ReservationAnalysePage.tsx` (admin `/gaeste/analyse`, Nav-Gruppe Foratable). Ersetzt die Nav-Einträge `/gaeste/wochentag` + `/gaeste/vorjahr` (Routen bleiben per URL erreichbar, wie `/reporting`). Globaler Kennzahl-Umschalter **Personen (Default)/Reservationen** steuert KPI-Kacheln, alle Tabellen und beide Detail-Popups. Filter: Jahr + Von/Bis-Monat + Status (booked Default) + Schnellwahl-Presets. 4 Tabs: **Monate** (Ist vs. Vorjahr, Zeilen-Klick → Tages-Popup), **Wochentage**, **Saison**, **Heatmap** (Monat × Wochentag, Zell-Klick → Tages-Aufschlüsselung). Reine Logik `src/lib/reservation-analyse-utils.ts` (reuse `reservation-yoy-utils.ts` + `reservation-weekday-analytics.ts`); keine Migration/Schreibzugriffe. Tests: `reservation-analyse-utils.test.ts`.
- **Abgelöste Reservations-Seiten (nav-versteckt, nur per URL):** `ReservationWochentagPage.tsx` (`/gaeste/wochentag`, rein `reservation-weekday-analytics.ts` — 3 Modi Zeitraum/Schulferien/Saisonvergleich, Saison-Defs in KV via `season-definitions-db.ts`), `ReservationVorjahrPage.tsx` (`/gaeste/vorjahr`, rein `reservation-yoy-utils.ts`). Aktiv verlinkt bleibt der **Foratable Report** `ForatableReportPage.tsx` (`/foratable-report`, rein `foratable-report.ts` + `reservation-time-analysis.ts`).

## Wichtige Invarianten (Guardrails)
Detail-Lehren + Historie in `.agents/memory/`. Kernregeln:
- Nie `restaurant_id` zu `employeeToDb`/`employees` hinzufügen — Tenant = ID-Präfix.
- Nur das Personalstamm-Formular schreibt `employees` nach Supabase; Auto-Sync/SchedulePlanner/Seed schreiben NICHT. Import-Match muss die VOLLE Mitarbeiterliste sehen (sonst Dubletten).
- Reporting-Monate nur via `safeUpsertReportingMonth`/`safeDeleteReportingMonth` (naives kvSet löscht andere Monate).
- Rollen-Gates nie „verbreitern" — ein weiter gefasstes Gate leakt alle Flächen, die es mit-gated. Stattdessen ein engeres Alt-Gate anlegen.
- Bulk-Upserts vor `.upsert()` nach dem `onConflict`-Key deduplizieren.
- Detail-`/:id`-Seiten: Fetched-State am Anfang von `load()` UND im `catch` zurücksetzen (sonst Cross-Guest-PII).
- Positions-/Staffing-Zuordnungen speichern **Keys**, nie Anzeigenamen.
- Overtime/Analytics: Absenz-Einträge (`absenceType`) sind nicht produktiv.

## Architecture decisions
- **Multi-tenancy:** ID-Präfixe (`b-` für Beaulieu) statt dedizierter `restaurant_id`-Spalte (Einfachheit + Rückwärtskompatibilität).
- **Data Persistence:** LocalStorage als schneller Primärspeicher, Supabase `app_settings` als persistentes Backup (v. a. Finanz-/Budgetdaten); Sync via `useSyncStore`.
- **Authorization:** zentraler `usePermissions`-Hook für rollenbasierten Zugriff.
- **Onboarding:** bestehende MA vervollständigen Daten per tokenisiertem Link; Selbstregistrierung erzeugt `pending_review`-Datensätze zur Admin-Freigabe.
- **Time-based Reporting:** globaler „Stichtag"-Filter (`StichtagContext`) für historische Auswertungen/Periodenabschluss.

## Product
- **Dashboard:** KPIs, Umsatz, Kosten, anteilige Personalkosten.
- **Dienstplanung:** Plan- und Ist-Schichten; Muster-Warnungen (aufeinanderfolgende Tage, kurze Ruhezeiten).
- **Soll/Ist-Analyse:** Plan- vs. Ist-Leistung.
- **Personalstamm:** Mitarbeiterverwaltung (admin), rollenbasierte Sichtbarkeit.
- **Reporting/Finanzen:** P&L, Budget, Vorjahresvergleiche.
- **Fixe Personalkosten:** Monatslöhne inkl. 13. Monatslohn je Abteilung.
- **Multi-Tenant + Rollen:** Oliv/Beaulieu isoliert; admin/service_manager/kueche_manager mit unterschiedlichem Zugriff.
- **Onboarding & Gäste-Links:** Selbstregistrierung; temporäre, passwortgeschützte read-only Freigabelinks.
- **Produktstammdaten & WES:** Food/Beverage-Artikel, WES (Warenkostensatz) je Produkt, Vergleich Rezept/Lieferant/Buchhaltung.
- **Gäste-CRM:** Gästeliste mit Suche, Besuchszahlen, Auto-Segmentierung, manuellem CRM-Profil, Kundenakte, Auswertungs-Dashboard, Kampagnen-Listen (CSV-only), Duplikat-Zusammenführung und Reservations-Analyse.

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
- **Supabase Migrations:** Alle SQL-Scripts in `supabase/migrations/` müssen sequenziell im Supabase SQL Editor ausgeführt werden.
- **Tenant Filtering:** Beaulieu = `id LIKE 'b-%'`, Oliv = `id NOT LIKE 'b-%'`; keine explizite `restaurant_id`-Spalte (außer Reservations-/CRM-Tabellen).
- **Mirus Name Mapping:** ggf. manuelles Mapping nötig, um MA-Namen korrekt zu verknüpfen; Excel-1904-Datumsflag nie mit `cellDates:true` lesen (Datumsverschiebung).
- **Default Budget Seed:** 2026-Budget wird beim ersten Laden geseedet, falls keine `plLineItems` existieren.

## Pointers
- **Supabase:** https://supabase.com/docs
- **React:** https://react.dev/
- **Tailwind CSS:** https://tailwindcss.com/docs
- **Shadcn UI:** https://ui.shadcn.com/docs
