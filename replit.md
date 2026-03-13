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
- `src/types/supplier-documents.ts` — Typen: SupplierDocument, DocumentType/Category, SupplierMonthSummary, CostComparisonRecord
- `src/lib/supplier-documents-store.ts` — Store (localStorage supplier_docs_v1): CRUD, Monatsaggregation, Buchhaltungsvergleich (baut CostComparisonRecord aus beiden Stores ohne den reporting-store zu verändern)
- `src/pages/SupplierDocuments.tsx` — Lieferantendokumente-Seite: Beleg erfassen, Monatsselektor, Zusammenfassungskarten, Tabellenansicht, Buchhaltungsvergleich-Vorbereitung (Admin only)
- `src/types/budget.ts` — Budget-Typen: BudgetPosition, BudgetRule, BudgetRuleType, BudgetYear + neu: BudgetPLCategory, BudgetPLLineItem, DEFAULT_PL_CATEGORIES (12 Kategorien inkl. Zwischenergebnisse), DEFAULT_PL_LINE_ITEMS (26 Standard-Unterkonten, 3000–6600)
- `src/lib/budget-store.ts` — Budget-Store (localStorage budget_v1): Legacy-Funktionen + neu: loadBudgetWithPL, computePLCategoryTotals, computePLResultTotals, savePLLineItem, addCustomPLLineItem, removeCustomPLLineItem, syncPLToLegacyPositions
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

## Nächste Schritte
1. SQL-Skript `supabase/add_user_roles.sql` im Supabase SQL-Editor ausführen
2. Manager-Accounts in Supabase Authentication erstellen
3. Rollen via SQL den neuen Accounts zuweisen
4. Soll/Ist-Analyse als eigene Seite auslagern (Modul 3)
5. Personalstamm-Modul (nur Admin)
