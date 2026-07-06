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
- **Reine Logik:** Analyse-/Berechnungs-Libs (`src/lib/*-utils.ts`, `*-analytics.ts`) sind DOM-/Supabase-frei (nur `import type`) und synthetisch getestet. Test-Dateien für Node-Only-Logik brauchen `// @vitest-environment node` in Zeile 1 (sonst jsdom/libuuid-Crash); React-Komponententests brauchen `// @vitest-environment happy-dom` (jsdom lädt das native `canvas`-Paket → libuuid-DLOPEN-Crash, Alias/vi.mock greifen dort nicht).
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
- **Tagesabschlüsse (UI-Name; früher „Umsatzabstimmung"):** Route bleibt `/umsatzabstimmung` (Alias `/tagesabschluesse` redirectet); Nav-Label/Seitentitel/Cockpit-Quelle heissen „Tagesabschlüsse", Bereichs-Label `umsatz` = „Umsatz / Tagesabschluss", Monats-Card = „Monatsabstimmung Umsatz". Der alte Name taucht nur noch technisch auf (Route, IDs, Dateinamen).
- **Adyen-Abgleich (Tagesabschlüsse, täglich):** Section auf `/umsatzabstimmung` (`src/components/umsatzabstimmung/` = `AdyenAbgleichSection.tsx`/`AdyenDayTable.tsx`/`adyen-ui.tsx`; Page bleibt dünn). Parser rein `src/lib/adyen-csv-parser.ts` („Received Payment Details"-CSV: Beträge vorzeichenbehaftet summiert, Typen mit /refund|chargeback/ werden bei positivem Betrag negiert, NUR CHF, Payout-/Settlement-CSV wird mit klarem Fehler abgelehnt, Debug+failureReason auf allen Pfaden; vor Verlass auf die Zahlen mit einer ECHTEN Adyen-Datei validieren — Fixture ist synthetisch). Abgleich rein `src/lib/adyen-abstimmung.ts`: Blob `adyenAbstimmung_v1` {days, methodLabels, overrides, comments, confirmations}, Persistenz `adyen-abstimmung-db.ts` = Settings-Infra (localStorage primär + KV-Backup, KEINE Migration); `mergeAdyenImport` ersetzt NUR importierte Tage und erhält Overrides/Kommentare/Bestätigungen. Z-Bericht-Seite read-only via `loadGnPaymentMethodsForMonth` (NUR Tagesimporte `period_from===period_to`); Mapping `normalizeGnPaymentName` auf Adyen-Keys (mastercard/visa/amex/twint/…), Nicht-Karten (Bar/Gutschein/…) nur kommentier-/übersteuerbar. Overrides `{originalValue, correctedValue, correctedByManualOverride, comment?, updatedAt}` bidirektional (zbericht|adyen, FieldKey `date:source:methodKey`), schreiben NIE in `gn_*` zurück; Erst-Original bleibt bei Mehrfach-Override verankert. Diff-Ampel `ADYEN_DIFF_THRESHOLDS` (grün ≤0.05 / orange ≤5 / rot). Tagesbestätigung `canConfirmDay`: Z-Bericht vorhanden + jede nicht-grüne Differenz übersteuert ODER kommentiert + Barbestand bestätigt. Gäste (isGuest) rein lesend. Tests: `adyen-csv-parser.test.ts`, `adyen-abstimmung.test.ts` (node), `AdyenDayTable.test.tsx` (happy-dom).
- **Import-Center:** `/import` = `src/pages/ImportHub.tsx`, rein `src/lib/import-center.ts` (+ `-db.ts`). Launcher-Modell; Sichtbarkeit spiegelt echte Route-Guards (admin 9 / beaulieu_manager 3 / beaulieu_viewer 1 / Gast 0); nie Zeitstempel erfinden.
- **Import-Cockpit (read-only Frische-/Fälligkeits-Übersicht):** `/import-cockpit` = `src/pages/ImportCockpitPage.tsx`, rein `src/lib/import-cockpit.ts` (Deskriptoren `COCKPIT_SOURCES`, Schwellen `INTERVAL_THRESHOLDS`, `computeSourceStatus`/`findMissingDays`/`summarizeCockpit`/`groupChecklist` + Label-/Badge-Maps), read-only Aggregator `src/lib/import-cockpit-db.ts` (`fetchCockpitSignals` via `Promise.allSettled`). Nur ANZEIGE — KEINE Migration/Schreibpfade/Änderung an Importprozessen. Admin-only, Gäste ausgeschlossen (`isAdmin && !isGuest` auf Route-Guard in `App.tsx` UND Lade-Effekt). **3-Tab-Struktur** (reine Logik `src/lib/import-cockpit-tabs.ts`, UI-Bausteine `src/components/import-cockpit/` = `cockpit-ui.tsx`/`CockpitDetailDrawer.tsx`/`DataImportsTab.tsx`/`ControlsTab.tsx`/`TasksTab.tsx`; Page orchestriert nur, `defaultValue="imports"`): **Datenimporte** (echte Datei-/Erfassungs-Importe, `section:'import'`), **Kontrollen** (wiederkehrende organisatorische Checks, `section:'control'`), **Aufgaben** (aggregierte OFFENE Punkte aus BEIDEN Sektionen, gruppiert Heute/Woche/Monat/Jahr, kritisch-zuerst). Jede Quelle trägt `section` + `tabCategory` (`CockpitTabCategory`, 13 Werte; Reihenfolge `IMPORT_CATEGORY_ORDER`/`CONTROL_CATEGORY_ORDER`, Labels `TAB_CATEGORY_LABEL`); Kontrollen zusätzlich `responsible`/`importance`/`procedure` (Drawer). 17 Quellen = **10 Datenimporte + 7 Kontrollen** (11 prüfbar mit ableitbarem Signal, 6 reine Kontrollaufgaben `checkable:false`; neu `adyen` = monatlicher Datei-Upload, Signal read-only aus dem `adyenAbstimmung_v1`-localStorage-Blob via `adyenDaysFromBlob`, Frische = letzter importierter Adyen-Tag ≤ heute, `detectGaps:false`, Route `/umsatzabstimmung`). **Umsatzabstimmung als monatlicher manueller Datenimport** (`manual_entry`, Route `/umsatzabstimmung`, keine Format-Badges): Signal read-only aus dem `reporting_v1`-localStorage-Blob via reiner `umsatzabstimmungMonthsFromBlob` (Monat gepflegt, sobald `grossRevenueManual` ODER `takeAwayGrossManual` > 0; `latestDataDate` = letzter gepflegter Monat 'yyyy-MM' — passt zu `normalizeDataDate`/Monatsübersicht), NIE via Reporting-Store-Funktionen (kein Seed/Write); Drawer zeigt Pflege-Hinweis (`COMPLETENESS_NOTE.umsatzabstimmung`) + Button „Zur Umsatzabstimmung". Frische je Intervall (täglich/wöchentlich/monatlich/jährlich); Datenlücken (`findMissingDays`, innere Löcher) NUR für tägliche `detectGaps`-Quellen (aktuell nur Tagesumsatz KV — Mirus ist periodenbasiert, `detectGaps:false`) und senken den Status höchstens auf gelb (Ruhetage sind legitim). Tenant-Filter folgt bestehenden Mustern (actual_hours/schedule_entries = `employee_id`-Präfix `b-` — `employees` hat KEINE `restaurant_id`, Reservations/CRM = `restaurant_id`, KV via `tenantKey`); `product_sales` ist mandantenübergreifend (`tenantNeutral`-Flag in der UI). **Budget/Reporting-Signal NIE via `loadBudgetYear`** (seedet+schreibt) — direkt aus dem localStorage-Blob (`budget_v1`/`reporting_v1`) lesen. Jede Quelle trägt zusätzlich `category` (7 Werte `CockpitCategory`), `importType` (`CockpitImportType`: file_upload/manual_entry/control/system/not_configured — `system` derzeit ungenutzt, nur `inventur` = not_configured), `uploadLabel` (was hochladen), optional `sourceHint`/`exampleFormat` (Datei-Upload-Quellen) und `actionLabel`. **Legacy Single-View-Layer** (bleibt im Modul für Rückwärtskompat + Tests, von der 3-Tab-UI abgelöst und NICHT mehr gerendert): `CockpitFilterState`/`rowMatchesFilters`/`matchesCockpitSearch`, `groupChecklist`/`visibleIds`, Maps `CATEGORY_LABEL`/`CATEGORY_ORDER`, `IMPORT_TYPE_LABEL`/`IMPORT_TYPE_ORDER`/`IMPORT_TYPE_BADGE_CLASS`, `STATUS_HINT`; das `category`-Feld (7 Werte `CockpitCategory`) ist `@deprecated` zugunsten `section`+`tabCategory`. UI je Tab: **Datenimporte** — KPI-Kacheln (Aktuell/Bald fällig/Überfällig/Nie+Nicht prüfbar/Datenlücken via `summarizeCockpit`) sind **Toggle-Filter** (Klick filtert die Tabelle, aktive Kachel markiert/aria-pressed, erneuter Klick hebt auf; reine Logik `ImportKpiFilter` + `importRowMatchesKpi`/`toggleImportKpiFilter`, Feld `kpi` in `ImportTabFilterState`; „Datenlücken" = `missingDays>0` unabhängig vom Status, „Nie/Nicht prüfbar" gebündelt); nach Bereich gruppierte Tabelle (Spalten Datenquelle/„Import-Art"/„Letzter Import"/„Ist-Daten bis"/Intervall/Status-Badge/Nächste Fälligkeit — KEINE „Was hochladen?"- und KEINE „Aktion"/Details-Spalte mehr, die GANZE Zeile ist klickbar → Drawer, cursor-pointer + Hover). „Import-Art" zeigt bei Datei-Uploads **Dateiformat-Badges** (CSV/Excel/PDF) statt „Datei-Upload": reine Ableitung `importFileFormats(def)` aus den `exampleFormat`-Endungen (csv/xls/xlsx/pdf, Reihenfolge CSV→Excel→PDF, NUR `importType:'file_upload'`, nie erfinden — sonst leere Liste und Fallback auf `ImportTypeBadge`, z. B. „Manuelle Eingabe"); Anzeige `FileFormatBadges` (cockpit-ui). Filter Bereich/Import-Art/Intervall/Status + Suche (KPI-Kachel wird UND-verknüpft, „Filter zurücksetzen" löscht auch sie). **Monatsübersicht** (Card zwischen KPI-Kacheln und Filterleiste): Jahresauswahl (Chevrons, Default = laufendes Jahr; Jahreswechsel überträgt einen aktiven Monatsfilter auf denselben Monat des neuen Jahres) + „Ganzes Jahr"-Button (aktiv = kein Monatsfilter) + Jahres-Totale (`summarizeImportYear`: aktuell/überfällig aus Quellen mit „Ist-Daten bis" im Jahr, nie = Nie-Quellen [0 für reine Zukunftsjahre], Lücken-Tage im Jahr — direkt aus Rows, NIE Monats-Summen [Nie würde 12× zählen]) + 12 Monatskarten (`buildMonthOverview`: aktuell/überfällig via Monat von `result.latestDataDate`, Lücken-Tage via `missingDays`-Monat, „nie" in jedem NICHT-zukünftigen Monat; Problem-Monate rot [überfällig/nie] bzw. amber [nur Lücken], aria-pressed). Monatsklick = Toggle-Filter (`month: 'YYYY-MM'|null` in `ImportTabFilterState`, reine `importRowMatchesMonth(row,month,today)`: Match via Ist-Daten-bis-Monat ODER Lücken-Tag im Monat ODER status never in nicht-zukünftigem Monat; UND-verknüpft mit allen anderen Achsen inkl. KPI-Kachel, z. B. Überfällig+Juli). `importRowMatchesFilters` hat optionalen 3. Param `today` (Default `localTodayIso()`), `DataImportsTab` optionale `today`-Prop (nur Tests). `due_soon`-Zeilen matchen den Monatsfilter, tauchen aber bewusst in keiner Zell-Zählung auf (Zellen zählen nur die 4 Spec-Kennzahlen); jahres-granulare `latestDataDate` ('yyyy') matcht keinen Monat, zählt aber im Jahres-Total. Komponententest `src/components/import-cockpit/__tests__/DataImportsTab.test.tsx` (happy-dom). **Kontrollen** — abgeleiteter `ControlStatus` (`done`/`due_today`/`due_soon`/`overdue`/`not_configured` via reiner `computeControlStatus`: `!checkable`|`never`|`uncheckable`→`not_configured`; `overdue`→`overdue`; `current`/`due_soon`→`due_today` wenn `nextDue===today` sonst `done`/`due_soon`), KPI-Kacheln (Erledigt/Heute fällig/Bald fällig/Überfällig/Nicht eingerichtet via `summarizeControls`), Tabelle mit Verantwortlich/Rhythmus/Nächste Fälligkeit, Filter Bereich/Intervall/Status + Suche. **Aufgaben** — reine `buildTasks(rows,today)` leitet aus Import-/Kontroll-Status OFFENE Punkte + Priorität (`critical`/`medium`) + `timeframe` (Intervall→today/week/month/year) ab (kritisch-zuerst sortiert), `groupTasksByTimeframe` in vier Karten (Heute/Woche/Monat/Jahr), KPI via `summarizeTasks`, Filter Bereich/Priorität/Zeithorizont + Suche. Prioritäten: Import `overdue`→critical, `never`/`due_soon`→medium; Kontrolle `overdue`/`due_today`→critical, `due_soon`→medium. **No-Fabrication:** neutrale Zustände (Import current/uncheckable, Kontrolle done/not_configured) erzeugen BEWUSST KEINE Aufgabe und werden nicht als offen gezählt (bewusste Abweichung von den gelben Spec-Beispielen für `uncheckable`/`not_configured`). Geteilter `CockpitDetailDrawer` über alle drei Tabs. Reine Filter-Layer je Tab: `importRowMatchesFilters`/`controlRowMatchesFilters`/`taskMatchesFilters` (+ `EMPTY_*_TAB_FILTER`). Weiterhin nur ANZEIGE — keine Upload-/Importlogik, keine Migration. Tests: `import-cockpit.test.ts` (582 Z., unverändert) + `import-cockpit-tabs.test.ts`. Nav: eigener Eintrag in der Import-Gruppe (`AppNav.tsx`). **„Ist-Daten bis" (früher „Stand / Daten bis"):** die Spalte/der Drawer zeigen den letzten ECHTEN Ist-Tag, nie ein Zukunftsdatum. Bei täglichen `detectGaps`-Quellen wird ein zukünftiges MAX-Datum auf heute gekappt und als `ignoredFutureDate` (Signalfeld `futureDataDate`) im Drawer als amber Hinweis ausgewiesen; `computeSourceStatus` nutzt durchgängig das gekappte `refRaw` für `latestDataDate`/Reason. **Vollständigkeit statt MAX:** reine `lastGaplessDay(covered, today)` liefert den letzten lückenlos verfügbaren Tag (bricht beim ersten Loch ab, ignoriert Tage > heute) → `completeUntil` im Drawer als „Vollständig importiert bis" (nur `detectGaps`). Lücken senken Status weiterhin höchstens auf gelb. **Mirus PERIODENBASIERT (nur im Aggregator, read-only):** „Ist-Daten bis" ist NICHT MAX(date) aus `actual_hours`, sondern das Monatsende der zuletzt erfolgreich importierten Mirus-Periode aus der **Import-Historie `timesheet_import_history`** (Quelle 'mirus', via `getImportHistoryAll`) — so heben verirrte Einzel-Tageszeilen (z. B. ein 04.07-Datensatz obwohl nur bis 30.06 importiert) den Stand nicht fälschlich an. Reine Ableitung: `deriveMirusPeriodFromHistory(entries)` (max year·12+month unter verwertbaren [source null|'mirus', importedCount null|>0], Tie-Break jüngster `importedAt`; → `periodFrom`=Monatsanfang, `periodTo`=Monatsende) + `deriveMirusPeriodEndFromDays(days,today)` (Fallback ohne Historie: Monatsende des letzten Monats VOR dem laufenden mit echten Ist-Tagen). **Kappen im Aggregator:** ein `periodTo` im laufenden Monat (Teil-Import) wird in `mirusSignal` auf heute gekappt (`min(periodTo,today)`) und das Monatsende als `futureDataDate`-Hinweis ausgewiesen — „Ist-Daten bis" bleibt nie ein Zukunftsdatum. Ohne ableitbare Periode → Status `never` (nicht `uncheckable`; Drawer behält Hinweise). `actual_hours` liefert nur noch **Drawer-Hinweise**, die NIE in Status/„Ist-Daten bis" einfliessen: `latestRecordDate` (spätester echter Ist-Tag ≤ heute, `.is('absence_type',null)` + `.or(hours>0,start_time≠null,end_time≠null)`) und `futureDataDate`. Interval bleibt `daily` → 30.06 vs. heute = mehrere Tage hinter = überfällig (nie „aktuell"). Drawer-Bausteine: „Datei" (`fileName`), „Letzter gefundener Tagesdatensatz" (`latestRecordDate`, nur wenn ≠ „Ist-Daten bis"), amber Hinweis bei späteren Tagesdatensätzen > Perioden-Ende, `COMPLETENESS_NOTE.mirus`. Tagesumsatz/Z-Bericht/Produktverkäufe weiterhin auf ≤ heute gekappt; Reservationen/Gäste-CRM/Dienstplan bleiben bewusst zukunfts-fähig. **Deviation:** Spec nannte `import_runs`, doch das ist Foratable-only — die echte Mirus-Historie liegt in `timesheet_import_history`. Keine Migration/Schreibpfade. **Manuelle Kontroll-Erledigung (EINZIGE Ausnahme vom read-only):** Kontrollen (`section:'control'`) + Kontroll-Aufgaben können per Mehrfachauswahl (Zeilen-/Gruppen-/Master-Checkbox) über einen bestätigten Sammel-Button „Als erledigt markieren" manuell abgeschlossen werden. Echte **Datenimporte** (`section:'import'`) NIE — in den Aufgaben werden sie beim Erledigen mit `partitionTasksForCompletion` abgetrennt und per Toast „Datenimporte können nur durch den passenden Import abgeschlossen werden." blockiert. Reine Logik `src/lib/import-cockpit-checks.ts` (`ManualCompletion{completedAt,nextDue}`/`ManualCompletionMap`, `nextDueAfterCompletion` spiegelt `computeNextDue`: täglich+1/wöchentlich+7T/monatlich+1M/jährlich+1J, `makeCompletion`/`markControlsDone`/`isCompletionActive` = `today<nextDue`/`pruneCompletions`/`partitionTasksForCompletion`); Persistenz `src/lib/import-cockpit-checks-db.ts` = **bestehende** Settings-Infra (localStorage primär via `tlsGetJson`/`tlsSetJson` + best-effort Supabase-KV-Backup `app_settings` via `kvGet`/`kvSet`, tenant-scoped `tenantKey(tenantId,'importCockpitControlChecks')`, wirft nie) — KEINE neue Tabelle, KEINE Migration, KEIN SQL. `buildControlRows`/`buildTasks` nehmen optionalen 3. Param `completions` (rückwärtskompatibel): aktive Erledigung → `controlStatus:'done'` + überschriebene `nextDue` + `manuallyCompleted`/`completedAt`; Import-Zeilen bleiben unberührt. Page hält `manualChecks`-State (Load bei `tenantId`-Wechsel), Handler filtert defensiv auf `section:'control'`. Drawer zeigt bei aktiver Erledigung `done` + „Zuletzt erledigt (manuell)" + neue Fälligkeit. Tests: `import-cockpit-checks.test.ts` (26 Z.).
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
