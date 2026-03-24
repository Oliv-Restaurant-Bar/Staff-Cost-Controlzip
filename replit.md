# Personalkostentracker – oLiv Restaurant & Bar

Internes Reporting-Tool für Umsatz, Personalkosten, Dienstplan und KPIs. 2–3 interne Nutzer.

## Tech Stack
- React + TypeScript + Vite
- Supabase (Auth + Datenbank) — Projekt `ajflrvuzmkfspsxkdyfe`
- Shadcn UI / Tailwind CSS
- date-fns, sonner, recharts

## Supabase-Konfiguration
- Projekt-URL: `https://ajflrvuzmkfspsxkdyfe.supabase.co`
- Anon Key: `sb_publishable_QXf-21IX_EQ_cwLGqNc24w_-fFS23ht`
- Login: `admin@olivbern.ch` / `OlivAdmin2026!`
- Datei: `src/integrations/supabase/client.ts`

## Ziel-Modulstruktur (in Umsetzung)
1. **Dashboard** — Übersicht KPIs, Umsatz, Kosten; pro-rata Personalkosten; Personal FIX-Sektion
2. **Dienstplanung** — Plan- und Ist-Dienstplan (SchedulePlanner.tsx)
3. **Soll / Ist Analyse** — Vergleich geplant vs. tatsächlich
4. **Personalstamm** — Mitarbeiterdaten (nur Admin)
5. **Reporting / Finanzmodul** — Vollständige Finanzdaten inkl. Vorjahr (PLView.tsx)
6. **Personal FIX** — Fixlohn-Übersicht: Monatslöhne inkl. 13. pro Abt., Vergleich vs. Budget (`/personal-fix`, nur Admin)

## Rollen-System (Phase 1 implementiert)
- **admin** → sieht alles, incl. Einzellöhne und alle Abteilungen
- **service_manager** → nur Service-Mitarbeiter, keine Einzellöhne
- **kueche_manager** → nur Küchen-Mitarbeiter, keine Einzellöhne

### Rollen-Infrastruktur
- `src/contexts/AuthContext.tsx` — lädt Rolle aus `user_profiles`-Tabelle
- `src/hooks/usePermissions.ts` — **zentraler Berechtigungs-Hook** (alle Regeln hier)
- `supabase/add_user_roles.sql` — einmalig ausführen zum Erstellen der `user_profiles`-Tabelle
- `src/App.tsx` — Routen-Schutz (Settings nur für Admin)

### Berechtigungsregeln (usePermissions.ts)
| Recht | Admin | Service-Mgr | Küchen-Mgr |
|---|---|---|---|
| Einzellöhne sehen | ✅ | ❌ | ❌ |
| Gesamtkosten/Quote | ✅ | ✅ | ✅ |
| Abt. wechseln | ✅ | ❌ | ❌ |
| Alle Abt. sehen | ✅ | ❌ | ❌ |
| Mitarbeiter bearbeiten | ✅ | ❌ | ❌ |
| Einstellungen | ✅ | ❌ | ❌ |
| Finanzdaten | ✅ | ❌ | ❌ |

## Datenbankschema (Supabase)
Skript: `supabase/setup_new_project.sql` — muss im Supabase SQL Editor ausgeführt werden.

Tabellen:
- `employees` — TEXT PRIMARY KEY (IDs '1'–'23'), Mitarbeiterdaten
- `schedule_entries` — Dienstplan-Einträge pro Mitarbeiter + Tag
- `actual_hours` — Ist-Stunden pro Mitarbeiter + Tag
- `app_settings` — Schlüssel/Wert-Speicher (Wochentag-Prozentsätze, Schwellenwerte)
- `user_profiles` — Rollen-Zuordnung (id → role) — nach SQL-Skript vorhanden

RLS-Policies: Nur eingeloggte Nutzer haben Zugriff.

## Service-Layer
`src/lib/supabase-db.ts` — alle Lade/Speicher-Funktionen für Supabase:
- `loadEmployees`, `upsertEmployee`, `upsertAllEmployees`, `deleteEmployee`
- `loadScheduleForMonth`, `saveScheduleEntry`, `saveFullScheduleForMonth`
- `loadActualHoursForMonth`, `saveActualHourEntry`
- `loadSetting`, `saveSetting`

## Datenpersistenz / Supabase-Sync
Finanz- und Tagesbudget-Daten werden bidirektional zwischen localStorage (primär, schnell) und Supabase `app_settings` (sekundär, persistent) synchronisiert.

**Neue Dateien:**
- `src/lib/supabase-kv.ts` — kvGet/kvSet auf `app_settings`-Tabelle + syncLocalToSupabase / syncSupabaseToLocal
- `src/hooks/useSyncStore.ts` — einmalige Sync-Hook nach Login (push lokal → Supabase, dann pull Supabase → lokal wenn leer)

**Ablauf nach Login:**
1. `useSyncStore` in App.tsx läuft einmalig → schreibt lokale Daten nach Supabase
2. Falls localStorage leer → lädt Supabase-Daten lokal → feuert `store-synced`-Event
3. Alle Seiten hören auf `store-synced` und laden Daten neu

**Keys die synced werden:** `reporting_v1`, `budget_v1`, `dailyBudgets`

## Migrationsstatus
- SchedulePlanner.tsx: vollständig auf Supabase migriert (localStorage als Backup)
- usePersonnelData.ts: Mitarbeiter-Sync auf Supabase
- Settings.tsx: Wochentag-Prozentsätze + Schwellenwert auf Supabase
- useShiftConfig.ts: noch localStorage (Schicht-Konfiguration, tief integriert)
- reporting_v1: localStorage primär + Supabase `app_settings` als Backup
- budget_v1: localStorage primär + Supabase `app_settings` als Backup
- dailyBudgets: localStorage primär + Supabase `app_settings` als Backup
- UI-Präferenzen: bewusst in localStorage (nutzerspezifisch)

## Routing
| Pfad | Seite | Zugriff |
|---|---|---|
| `/` | `Dashboard.tsx` | Alle (rollenbasiert) |
| `/analyse` | `SollIstAnalyse.tsx` | Alle (rollenbasiert) |
| `/personal-stamm` | `Personalstamm.tsx` | Alle (rollenbasiert, Admin voll) |
| `/reporting` | `Reporting.tsx` | Nur Admin |
| `/kontenplan` | `AccountMapping.tsx` | Nur Admin |
| `/erfolgsrechnung` | `PLView.tsx` | Nur Admin |
| `/csv-import` | `CSVImport.tsx` | Nur Admin |
| `/personal` | `SchedulePlanner.tsx` | Alle (rollenbasiert) |
| `/overview` | `Index.tsx` | Alle (Legacy) |
| `/settings` | `Settings.tsx` | Nur Admin |
| `/schedule-planner` | `SchedulePlanner.tsx` | Alle |
| `/budget` | `Budget.tsx` | Nur Admin |

## Wichtige Dateien
- `src/components/AppNav.tsx` — Zentrale Sidebar-Navigation (Desktop) + Bottom-Bar (Mobile); rollenbasiert gefiltert
- `src/types/reporting.ts` — Typen für Finanzmodul (MonthlyFinancialRecord, ExpenseCategory, ImportRecord)
- `src/lib/reporting-store.ts` — Datenzugriff Reporting (localStorage, Supabase-migrationsbereit), Import-Deduplication-Logik
- `src/types/account-mapping.ts` — P&L-Typen: PLCategory, PLSection, AccountMapping, AccountRange, AccountSign, DepartmentHint
- `src/lib/account-mapping-store.ts` — Swiss KMU Kontenrahmen (40+ Gastro-Konten 3xxx–6xxx), Lookup-Logik (exakt/Bereich/kein Treffer), CRUD für Custom-Mappings
- `src/pages/AccountMapping.tsx` — Admin-Übersicht Kontenplan: Tabelle nach P&L-Abschnitt gruppiert, Edit-Dialog, Matching-Test-Panel
- `src/types/pl.ts` — P&L-Typen: PLRowDef, PLFormula, PLCellValues, PLComputedRow, PLMonthResult, PLYearResult, PLDrilldown
- `src/lib/pl-engine.ts` — P&L-Engine: PL_STRUCTURE (statisches GuV-Schema), computePLForMonth, computePLForYear, getDrilldown, categoryId→Zeilen-Mapping
- `src/pages/PLView.tsx` — Erfolgsrechnung: Monatsansicht (Ist/Budget/VJ/Abw.) + Jahresübersicht (12 Monate nebeneinander) + Drilldown-Dialog
- `src/lib/csv-import-engine.ts` — CSV-Parse-Engine: Trennzeichen-Erkennung, Swiss-Betragsformat, Spalten-Heuristik, Konto-Matching via lookupAccount, buildMonthRecord
- `src/lib/pdf-import-engine.ts` — PDF-Parse-Engine: pdfjs-dist Text-Extraktion, Y-Koordinaten-Gruppierung, Kontozeilen-Erkennung, Monats-/Jahres-Erkennung
- `src/pages/CSVImport.tsx` — Universeller Import-Wizard für CSV+PDF (3 Schritte: Upload/Konfiguration → Vorschau → Bestätigen)
- `src/lib/connectors/gastronovi-connector.ts` — Gastronovi-Vorbereitung: Typen, CSV-Parser, Kategorie-Mapping, Aggregation, API-Stub (noch nicht aktiv)
- `src/types/supplier-documents.ts` — Typen: SupplierDocument, DocumentType/Category, SupplierMonthSummary, CostComparisonRecord, AccountToSupplierMapping, SupplierCostComparison
- `src/lib/supplier-documents-store.ts` — Store (localStorage supplier_docs_v1): CRUD, Monatsaggregation, Buchhaltungsvergleich; NEU: loadSupplierMappings/saveSupplierMappings/upsertSupplierMapping/deleteSupplierMapping (localStorage supplier_account_mapping_v1); buildSupplierCostComparisons jetzt vollständig implementiert mit echtem Konto-Matching
- `src/pages/SupplierDocuments.tsx` — Lieferantendokumente-Seite: Beleg erfassen, Monatsselektor, Zusammenfassungskarten, Tabellenansicht; Link zu /lieferanten-vergleich
- `src/pages/SupplierComparison.tsx` — NEU: Lieferantenvergleich-Seite (Admin only, /lieferanten-vergleich): Monat/Jahr-Filter, Summary-Karten (Lieferantendokumente vs Buchhaltung), Kategorie-Übersicht (food/bev/other), per-Lieferant-Tabelle mit Status-Badges, Drilldown-Dialog, Kontozuordnung-Konfiguration (Lieferant→Kontonummer→Anteil%)
- `src/types/budget.ts` — Budget-Typen: BudgetPosition, BudgetRule, BudgetRuleType, BudgetYear + neu: BudgetPLCategory, BudgetPLLineItem, DEFAULT_PL_CATEGORIES (12 Kategorien inkl. Zwischenergebnisse), DEFAULT_PL_LINE_ITEMS (26 Standard-Unterkonten, 3000–6600)
- `src/lib/budget-store.ts` — Budget-Store (localStorage budget_v1): Legacy-Funktionen + neu: loadBudgetWithPL, computePLCategoryTotals, computePLResultTotals, savePLLineItem, addCustomPLLineItem, removeCustomPLLineItem, syncPLToLegacyPositions; resetBudget2026ToSeed()
- `src/lib/budget-seed-2026.ts` — Excel-Seed Budget 2026: alle 35 P&L-Positionen (3000–6940) mit monatlichen CHF-Werten aus Budget_2026.xlsx; Auto-Import bei erstem Laden von Jahr 2026 (wenn keine plLineItems vorhanden)
- `src/pages/Budget.tsx` — Budget-Planungsseite (nur Admin): Vollständige P&L-Erfolgsrechnung-Struktur mit Hauptkategorien, Unterkonten (4-stellige Kontonummern), Zwischenergebnisse (Bruttogewinn 1&2, Total Personal, EBITDA), Inline-Zelleneditor, "Unterkonto hinzufügen"-Dialog, Jahr-Kopie-Dialog, Regel-Engine-Dialog
- `src/lib/mirus-name-mapping-store.ts` — Persistente Mirus-Namenszuordnungen (localStorage mirus_name_mappings_v1): save/load/lookup/clear
- `src/types/personnel.ts` — TimeEntry ergänzt mit importSource ('mirus'|'manual'); MirusImportMode Typ ('replace'|'update')
- `src/hooks/usePersonnelData.ts` — importMirusDailyData: mode-Parameter (replace/update), replace löscht Mirus-Einträge für den Zeitraum, source='mirus' wird gespeichert
- `src/components/ActualHoursImportButton.tsx` — Neu: Import-Modus-Selektor (Replace/Update), persistente Namenszuordnungen, unresolved Warnung, source-Tagging
- `src/pages/Dashboard.tsx` — Neue Dashboard-Startseite (rollenbasierte KPI-Karten)
- `src/pages/SchedulePlanner.tsx` — Hauptseite Dienstplan (~2000 Zeilen)
- `src/pages/Index.tsx` — Legacy Übersicht (unter /overview erreichbar)
- `src/hooks/usePermissions.ts` — Zentrales Berechtigungssystem
- `src/hooks/usePersonnelData.ts` — Mitarbeiter + Zeiteinträge (localStorage)
- `src/hooks/useShiftConfig.ts` — Schichtkonfiguration
- `src/pages/Settings.tsx` — Einstellungen (nur Admin)
- `src/contexts/AuthContext.tsx` — Supabase Auth + Rollenladung
- `src/App.tsx` — Routing + Routen-Schutz

## Dashboard (src/pages/Dashboard.tsx)
Lädt direkt aus Supabase (Mitarbeiter, Dienstplan, Ist-Stunden) + localStorage (dailyBudgets).
Rollenbasierte Ansicht:

| Bereich | Admin | Service-Mgr | Küchen-Mgr |
|---|:---:|:---:|:---:|
| Umsatz heute/KW/Monat | ✅ | ❌ | ❌ |
| Budget vs. Ist Umsatz | ✅ | ❌ | ❌ |
| Vorjahresvergleich | ✅ | ❌ | ❌ |
| Personalkosten (Gesamt) | ✅ | Service | Küche |
| Kostenquote | ✅ | Service | Küche |
| Stunden Soll/Ist | ✅ | Service | Küche |
| Warnung bei Kostenüberschreitung | ✅ | ✅ | ✅ |

## Personalstamm HR-Felder (vollständig migriert)

Alle HR-Felder liegen jetzt direkt im `Employee`-Objekt (Supabase):
- `birthDate`, `nationality`, `phone`, `email`, `addressStreet`, `addressZip`, `addressCity`, `ahvNumber`, `iban`
- `contractType`, `positionTitle`, `contractStart`, `contractEnd`, `isLimitedContract`, `trialPeriodMonths`, `noticePeriodWeeks`
- `onboardingStatus` (`none`|`prepared`|`sent`|`in_progress`|`completed`), `onboardingToken`, `onboardingDocuments`
- `employeeStatus` (`active`|`pending_review`) — `pending_review` = neue Selbst-Anmeldung wartet auf Admin-Aktivierung
- `socialCostFactor` (Standard: 1.13), `has13thSalary`

**Minijob entfernt:** `EmploymentType` enthält `minijob` weiterhin für bestehende Daten, aber alle SelectItem-Optionen wurden entfernt.

## SQL-Migrationen (alle 3 ausführen — in Reihenfolge!)

**Migration 1:** `supabase/migrations/20260315_hr_fields_extension.sql`
- Basis-HR-Felder (employment_end_date, trial_period_months, etc.)

**Migration 2:** `supabase/migrations/20260315_onboarding_flow.sql`
- `in_progress` Status zum Constraint hinzufügen
- `onboarding_documents TEXT` Spalte
- Supabase Storage Bucket `onboarding-docs`
- RLS-Policies für anonymen Onboarding-Zugriff (nur via Token)

**Migration 3:** `supabase/migrations/20260315_employee_self_registration.sql`
- `employee_status VARCHAR DEFAULT 'active'` Spalte
- RLS-Policy für anonymen INSERT mit `pending_review` Status

**Migration 4:** `supabase/migrations/20260315_quellensteuer_fields.sql`
- `permit_type VARCHAR` — Aufenthaltsstatus (swiss/C/B/L/G/other)
- `marital_status VARCHAR` — Zivilstand (single/married/divorced/widowed)
- `spouse_employed BOOLEAN` — Ehepartner erwerbstätig?
- `spouse_lives_in_switzerland BOOLEAN` — Ehepartner wohnt in CH?

## Onboarding-Link-Flow

Public Route: `/onboarding/:token` — ohne Login erreichbar (BrowserRouter ist jetzt auf App-Ebene)

**Modus 1: Bestehender Mitarbeiter** (`/onboarding/<uuid-token>`)
- Token-Validierung beim Laden → Daten vorbefüllt
- Setzt Status automatisch auf `in_progress` wenn Link geöffnet wird
- Speichert Daten zurück in bestehendem employee record, Status → `completed`

**Modus 2: Neue Selbst-Anmeldung** (`/onboarding/new`)
- Generischer Link ohne Mitarbeiter-Record nötig
- Formular inkl. Name, Stellenwunsch, Eintrittstermin, Beschäftigungsart
- Erstellt neuen Employee-Record mit `employee_status = 'pending_review'`
- Admin-seitige Aktivierung oder Ablehnung in Personalstamm

Datei: `src/lib/supabase-db.ts` — Funktionen:
- `findEmployeeByToken(token)` — Employee per Token laden (anon)
- `markOnboardingInProgress(id)` — Status → in_progress
- `submitOnboardingData(id, formData, docs)` — Daten speichern + completed
- `uploadOnboardingFile(id, file, type)` — Datei in Storage hochladen
- `createPendingEmployee(data)` — Neuer Employee mit `pending_review` anlegen
- `activateEmployee(id)` — `employee_status` → `active`

**Admin-Sicht (Personalstamm):**
- "Anmelde-Link"-Button im Header mit Badge-Zähler für pending Einträge
- "Ausstehende Anmeldungen" Sektion oben in der Mitarbeiterliste (orange)
- Detail-Banner für pending Employee: Prüfen → "Ablehnen" oder "Aktivieren"

## Globaler Stichtag-Filter

**Zweck:** Auswertungen auf einen bestimmten Stichtag (z.B. Monatsende) begrenzen — nützlich für Revisionen und Periodenabschlüsse.

**Dateien:**
- `src/contexts/StichtagContext.tsx` — Context mit `stichtag`, `isInScope(year, month)`, localStorage-Persistenz unter `stichtag_v1`
- `src/components/StichtagBanner.tsx` — Amber-Banner ("Stichtag-Auswertung per TT.MM.JJJJ") mit Aufheben-Button

**API des Contexts:**
- `stichtag: Date | null` — Stichtag-Datum
- `stichtagYear / stichtagMonth / stichtagDay` — aufgeschlüsselt
- `isActive: boolean` — ob Stichtag gesetzt
- `isInScope(year, month): boolean` — true wenn <= Stichtag-Monat
- `formatted` — "TT.MM.JJJJ"
- `formattedMonthYear` — "MMMM JJJJ" (z.B. "März 2026")
- `setStichtag(date)` / `clearStichtag()`

**Integration:**
- **AppNav Sidebar** — `StichtagPicker` (Amber-Widget mit Datum-Input + X-Button)
- **Dashboard** — `StichtagBanner` am Seitenanfang
- **PLView** — `StichtagBanner` + auto-jump zu Stichtag-Jahr/Monat per `useEffect`
- **Reporting** — `StichtagBanner` + Monatstabellenzeilen ausserhalb Stichtag werden gedimmt (opacity-40) und durchgestrichen

## Gastlink-System (Sitzungs-Sharing)

Admins können zeitbegrenzte, passwortgeschützte Links für Sitzungs-Teilnehmende generieren.

**Flow:**
1. Admin klickt "Gastlink" im Dashboard-Header → öffnet Dialog
2. Admin setzt Passwort + Dauer (1h / 2h / 4h / 8h / 1 Tag)
3. Generierter Link: `/gast?t=BASE64_TOKEN` (Token = SHA-256-Hash + Ablaufzeitstempel)
4. Gäste besuchen den Link, geben das Passwort ein → Zugang für die gesetzten Stunden
5. Gäste sehen alle Seiten (wie Admin) aber im Lesemodus; GuestBanner + Ablauf-Timer oben

**Dateien:**
- `src/contexts/GuestSessionContext.tsx` — Session-State, Crypto-Hilfsfunktionen
- `src/pages/GuestAccess.tsx` — öffentliche Seite unter `/gast` (kein Login nötig)
- `src/components/GuestLinkGenerator.tsx` — Admin-Dialog zum Link generieren
- `src/components/GuestBanner.tsx` — violettes Banner oben mit Timer + "Beenden"-Button
- `src/App.tsx` — `/gast`-Route öffentlich; AppContent lässt gültige Guest-Sessions durch

## Arbeitsmuster-Warnungen (Dienstplanung)

Datei: `src/lib/pattern-warnings.ts`

Erkennt operativ riskante Planungsmuster für alle Mitarbeiter über den gesamten Monat:

- **consecutive-days**: ≥6 Arbeitstage am Stück → Warnung; ≥7 → Kritisch
- **consecutive-late**: ≥3 Spätschichten in Folge → Warnung; ≥4 → Kritisch
- **short-recovery**: <11h Pause zwischen Schicht-Ende und nächstem Schicht-Start → Warnung; <8h → Kritisch
- **weekly-overload**: >50h in einem rollierenden 7-Tage-Fenster → Warnung; >55h → Kritisch

**Typ `PatternWarning`**: `{ empId, empName, dept, type, severity, message, detail, firstDate }`

**Integration:**
- **ScheduleGrid** — Kleine farbige Chips in der Mitarbeiternamen-Spalte (amber = Warnung, rot = Kritisch) mit Tooltip-Details
- **PlanningAssistant** — Kollapsibles Panel "Arbeitsmuster-Warnungen" oberhalb der Tabs; Klick auf Chip springt direkt zur betroffenen Woche und markiert den Mitarbeiter
- **SchedulePlanner** — `patternWarnings` useMemo berechnet Warnungen über `daysInMonth`, übergibt sie an ScheduleGrid und PlanningAssistant

## Artikelstamm (Stage 1)

Route: `/artikel` · Nur Admin · Dateien: `src/pages/Artikel.tsx`, `src/lib/artikel-store.ts`

Zentrale Datenbank für alle Food- und Beverage-Artikel. Grundlage für spätere Module:
Rezeptkosten, Lieferantenrechnungen, Inventur, theoretischen Warenbestand.

**Datenmodell (`Artikel`):**
```typescript
{ id, name, inventoryType: 'food'|'beverage', unit, defaultCostPerUnit, storageLocations: string[], active, createdAt, updatedAt }
```

**Lagerorte:**
- Food: TK, Frigo, Gemüselager, Trockenlager
- Beverage: Keller, EG Buffet, UG Buffet

**Speicherung (Stage 1):** Supabase `app_settings` mit Key `artikel_master_v1` (via `kvGet`/`kvSet` aus `supabase-kv.ts`)

**Stage 2 Migration:** `supabase/migrations/20260323_artikel_master.sql` — erstellt dedizierte `articles`-Tabelle mit RLS, Index, update-Trigger und Migrationsskript aus `app_settings`.

## WES-Analyse

Route: `/wes-analyse` · Nur Admin · Datei: `src/pages/WesAnalyse.tsx`

Vergleicht den Wareneinsatz (WES) aus drei Quellen nebeneinander:
1. **Rezeptur** — theoretischer WES aus `ProductCostEntry.wes × ProductEntry.count` (Kalkulation × Kassensystem-Verkäufe)
2. **Lieferanten** — operativer WES aus erfassten Lieferscheinen/Rechnungen (`getMonthSummary`)
3. **Buchhaltung** — gebuchter WES aus `expenseCategories` Konten 4020–4090 (Sage-Import)

**Tabs:**
- **Übersicht** — 12-Monats-Tabelle + Jahressumme, CHF + %, Differenz Lieferanten/Buchhaltung farblich markiert, Food/Beverage Split-Cards
- **Nach Konto** — Aufschlüsselung nach FIBU-Konto (4020 Wein, 4030 Bier, 4040 Spirituosen, 4050 Mineral, 4060 Küche, 4070 Kaffee & Tee) mit % Umsatz, gruppiert nach Food / Beverage / Diverses
- **Erklärung** — erklärt auf Deutsch alle 3 Quellen, was zu prüfen ist, und wie Differenzen interpretiert werden

**FIBU-Konto → Kategorie Mapping:**
- Food: 4060, 4061 · Beverage: 4020, 4030, 4040, 4050, 4070 · Autres: 4090, 4701

## Artikel-Tracking

Route: `/artikel-tracking` · Nur Admin · Dateien: `src/pages/ArtikelTracking.tsx`, `src/lib/artikel-tracking-store.ts`

Monatliche Einkaufs- und Verbrauchsanalyse für ausgewählte Artikel mit aktivem `trackingAktiv`-Flag.

**Datenmodell (`ArtikelPurchase`):**
```typescript
{ id, articleId, articleName, date, year, month, quantity, pricePerUnit, totalCost (NET CHF), supplier, note?, createdAt, updatedAt }
```
Gespeichert in `localStorage` mit Key `artikel_purchases_v1`.

**Pro Monat + Artikel berechnet (`ArtikelMonthStats`):**
- `purchasedQty` — Gesamtmenge (Einheiten)
- `purchasedCHF` — Gesamtkosten NET CHF
- `orderCount` — Anzahl Einkaufsbelege
- `avgDaysBetweenOrders` — Ø Tage zwischen Bestellungen (null wenn < 2 Käufe)
- `theoreticalConsumption` — aus Rezeptur × Verkaufsanzahl (null wenn keine Rezeptur/Verkaufsdaten)
- `diffQty` — Einkauf minus theoretischer Verbrauch

**Tracking-Flag auf Artikel:**
- `trackingAktiv: boolean` (neu) — steuert Sichtbarkeit in dieser Analyse
- `inventurRelevant: boolean` (bestehend) — steuert Hervorhebung in Inventur + Lieferanten-Panel
- Migration: `ensureAccountingAccounts()` setzt `trackingAktiv = inventurRelevant` für bestehende Artikel ohne Flag

**Datenquellen (theoretischer Verbrauch):**
1. `loadRezepturenFromDB()` — Rezepturen mit `ingredients[].articleId`
2. `loadProdukteData()` — Verkaufsmengen per Monat (`ProductEntry.count`, `month: 'yyyy-MM'`)

## Rezeptur-Wartungs-Tools (Kalkulations-Tab, Produkte)

### BulkRezepturUpdate (`src/components/produkte/BulkRezepturUpdate.tsx`)
Massen-Update für eine einzelne Rezeptur-Zutat über mehrere Produkte:
1. Zutat auswählen (Dropdown aller bekannten Zutaten aus allen Rezepturen)
2. Produkte auswählen (alle oder manuell per Checkbox)
3. Neue Menge eingeben
4. Vorschau bestätigen → alle Rezepturen + WES-Werte werden auf einmal aktualisiert
- Speichert via `saveRezepturenToDB` und berechnet `ProductCostEntry.wes/wesQ` neu

### RezepturRealityCheck (`src/components/produkte/RezepturRealityCheck.tsx`)
Regel-basierte Analyse: Einkauf (Artikel-Tracking) vs. theoretischer Verbrauch (Rezeptur × Verkauf) über die letzten 3 Monate.
- **>130%** → Rezeptur wahrscheinlich zu tief angesetzt
- **<60%**  → Rezeptur könnte zu hoch angesetzt sein
- Erfordert `trackingAktiv`-Artikel mit erfassten Einkäufen
- Zeigt Monatsdetails per aufklappbarer Zeile

### BasiskomponentenManager (`src/components/produkte/BasiskomponentenManager.tsx`)
Wiederverwendbare Basis-Rezepturen (z.B. „Pasta Basis", „Risotto Basis") für das Verwalten gemeinsamer Zutatengruppen:
- Erstellen/Bearbeiten/Löschen von Basiskomponenten mit eigenem Zutaten-Editor
- Verlinkung: Zeigt welche Produktrezepturen eine Basis verwenden
- **Propagation**: Wenn eine Basiskomponente geändert wird, werden alle verlinkten Rezepturen mit Vorschau aktualisiert (costPerUnit der Basis-Zutat wird synchronisiert)
- Manueller Trigger: „Verlinkungen neu berechnen"-Button pro Basiskomponente
- Speicherung: Supabase KV `basis_komponenten_v1` + localStorage-Fallback

**RezepturDialog Integration:**
- Beim Öffnen werden `BaseComponentMap` und Artikel parallel geladen
- Basiskomponenten-Zutaten werden mit violettem „Basis"-Badge angezeigt (read-only Name/Kosten, nur Menge editierbar)
- Button „Basiskomponente hinzufügen" erscheint wenn mindestens eine Basis existiert → öffnet Inline-Select zum Einfügen

**Datenmodell:**
- `RecipeIngredient.baseRecipeId?: string` — markiert eine Zutat als Basis-Referenz
- `costPerUnit` der Basis-Zutat = aktueller Portionspreis der Basiskomponente (damit alle WES-Berechnungen unverändert funktionieren)

## Deployment

Konfiguriert als **Static Site** (Vite Build → `dist/`).
- Build: `npm run build`
- Öffentliche URL nach Deploy: `*.replit.app`

## Nächste Schritte
1. **KRITISCH**: Alle 3 SQL-Migrationen im Supabase SQL-Editor ausführen (in Reihenfolge)
2. Manager-Accounts in Supabase Authentication erstellen
3. E-Mail-Versand für Onboarding-Link hinzufügen
