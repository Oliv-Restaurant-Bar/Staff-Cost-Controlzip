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
1. **Dashboard** — Übersicht KPIs, Umsatz, Kosten
2. **Dienstplanung** — Plan- und Ist-Dienstplan (SchedulePlanner.tsx)
3. **Soll / Ist Analyse** — Vergleich geplant vs. tatsächlich
4. **Personalstamm** — Mitarbeiterdaten (nur Admin)
5. **Reporting / Finanzmodul** — Vollständige Finanzdaten (nur Admin)

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

## Migrationsstatus
- SchedulePlanner.tsx: vollständig auf Supabase migriert (localStorage als Backup)
- usePersonnelData.ts: Mitarbeiter-Sync auf Supabase
- Settings.tsx: Wochentag-Prozentsätze + Schwellenwert auf Supabase
- useShiftConfig.ts: noch localStorage (Schicht-Konfiguration, tief integriert)
- Tagesbudgets: noch localStorage
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

## Deployment

Konfiguriert als **Static Site** (Vite Build → `dist/`).
- Build: `npm run build`
- Öffentliche URL nach Deploy: `*.replit.app`

## Nächste Schritte
1. **KRITISCH**: Alle 3 SQL-Migrationen im Supabase SQL-Editor ausführen (in Reihenfolge)
2. Manager-Accounts in Supabase Authentication erstellen
3. E-Mail-Versand für Onboarding-Link hinzufügen
