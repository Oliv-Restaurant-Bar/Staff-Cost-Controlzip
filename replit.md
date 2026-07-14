# Personalkostentracker

Internes Reporting- und Controlling-Tool für Gastronomie-Betriebe: Umsatz, Personalkosten, Dienstpläne, Tagesabschlüsse, Reservationen/Gäste-CRM, Produkte/Warenkosten und Finanz-KPIs. Mandantenfähig für zwei Betriebe (Oliv, Beaulieu). Detail-Lehren liegen in `.agents/memory/`.

## Projektübersicht

- **Dashboard/Startseite** — Tages-Status, Warnungen, Schnellaktionen; ausführliches KPI-Dashboard unter `/dashboard`.
- **Reporting/Finanzen** — Erfolgsrechnung (P&L), Budget, Vorjahres-/Mehrjahresvergleiche, Management Report, Banken-/Investorenbericht, Tagesumsätze, OP-Liste Kreditoren.
- **Personal** — Personalstamm, Positionen/Stationen, Personalbedarf (SOLL/Ist), Dienstplanung, Personal FIX+VARIABEL, Überstundenkosten.
- **Produkte & Warenkosten** — Artikel-/Produktstammdaten, WES, Produkt-Analyse, Lieferantendokumente.
- **Importe** — Import-Center, Import-Checkliste/Cockpit, Z-Bericht/Gastronovi, Reservationen (Foratable), Mirus, Adyen, Jahres-Kosten (Sage), OP-Liste.
- **Gäste-CRM & Reservationen** — Gästeliste, Segmentierung, Kundenakte, Auswertung, Kampagnen (CSV), Duplikat-Merge, Reservations-Analyse.
- **Kennzahlen** — konsolidierter Kennzahlen-Bericht (`KennzahlenBerichtPage`, Referenz fürs Designsystem).

## Architektur und Datenfluss

- **Frontend:** React + TypeScript + Vite, Shadcn UI, Tailwind, `date-fns`, `recharts`. Routing in `src/App.tsx`; Ablage: `src/pages/` (Seiten), `src/components/` (UI), `src/lib/` (Logik + DB-Layer), `src/types/`, `src/contexts/`, `src/hooks/`, `supabase/migrations/`.
- **Backend:** Supabase (Auth, Postgres, KV-Store `app_settings`). Schema `supabase/setup_new_project.sql`; Migrationen sequenziell im Supabase SQL-Editor ausführen (Management-API-DDL ist manuell). PII-/CRM-/Reservations-/Kreditoren-Tabellen: RLS authenticated-only + `REVOKE anon`; RLS empirisch verifizieren.
- **Multi-Tenancy:** Tenant = ID-Präfix (`b-` = Beaulieu). `employees`/`app_settings` haben KEINE `restaurant_id`-Spalte; Reservations-/CRM-/Kreditoren-Tabellen haben sie, jeder Read/Write ist tenant-gefiltert. `product_sales` ist mandantenübergreifend. Infra: `TenantContext.tsx`, `tenant-utils.ts`, KV-Keys via `tenantKey`.
- **Persistenz:** localStorage als schneller Primärspeicher + Supabase-KV als Backup (`useSyncStore`). Finanz-/Umsatzdaten NIE per naivem Blob-Write — nur read→merge→write (`safeUpsert*`) mit sichtbarem Fehler statt stillem Fallback. Union-merge-Blobs: Tombstones (`deleted:true`+`updatedAt`) statt Hard-Delete; alle Leser filtern `deleted`.
- **Reine Logik getrennt von IO:** Analyse-/Berechnungs-Libs (`src/lib/*-utils.ts`, `*-analytics.ts`) sind DOM-/Supabase-frei (nur `import type`); DB-Layer (`*-db.ts`) kapselt IO + Tenant-Filter.
- **Single Source of Truth:** je Fachdomäne genau EINE Berechnungsquelle; UI-Kacheln und Drilldowns aus DENSELBEN Rows. Beispiele: `reservation-crm.ts` (Segment/Metrik), `import-cockpit.ts`/`computeSourceStatus` (Frische-Schwellen für Startseite/Import-Center/Cockpit), `social-costs.ts`/`employee-rate.ts` (AG-Kostenfaktor), `warenkosten-quote.ts`, `warenaufwand-gruppierung.ts`. Bewusste Ausnahmen dokumentieren (z. B. Rückkehrpotenzial-Faktoren 1.5 vs. 2.0 koexistieren).
- **Read-only-Aggregatoren** (Import-Cockpit, Startseite, Gruppen-Overviews) leiten Status nur ab, schreiben nie, erfinden keine Zeitstempel.
- **Import-Engine:** generische Parser `csv-import-engine.ts`, `pdf-import-engine.ts` (`extractPdfTextLines`); fachliche Parser bauen darauf auf. Jeder Parser liefert `debug`-Objekt + `failureReason` auf ALLEN Pfaden und legt bei Fehler die reale Dateistruktur offen; synthetische Fixtures vor Verlass auf Zahlen mit ECHTER Datei validieren.

## Rollen und Berechtigungen

- Zentral `src/hooks/usePermissions.ts` + `AuthContext.tsx`. Rollen: admin / service_manager / kueche_manager / beaulieu_* / Gast.
- **`isAdmin = isAdminUser || isGuest`** — admin-only-PII-/Schreibseiten gaten deshalb `isAdmin && !isGuest` auf Route-Guard UND Lade-Effekt (Fetch feuert vor `Navigate`). Gäste sind rein lesend, nie PII.
- Lohn-Gating: `canSeeHourlyWages`/`canEditWages`; vertrauliche Personalflächen unter `canManageAllEmployees = isAdmin || isBeaulieuManager`. `kueche_manager` sieht nie Löhne/PII. Rollen-Gates nie verbreitern — engeres Alt-Gate anlegen statt bestehendes weiten.
- Manager-Sichtbarkeit auf Mitarbeitende zentral über `employee-visibility.ts` (`getVisibleEmployeesForRole`; eingeschränkte Rolle gewinnt; RAW-`employees` nur für Import-Match/CRUD).
- Onboarding: tokenisierte Links für Datenvervollständigung; Selbstregistrierung erzeugt `pending_review`; Gäste-Links = temporäre, passwortgeschützte read-only Freigaben.

## Navigation und Hauptmodule

- `src/components/AppNav.tsx` (`DASHBOARD_ITEM` + `NAV_GROUPS`, exportiert für Tests; longest-path-Highlighting). Flag `secondary: true` = hinter „Mehr"-Toggle (sekundär: Kennzahlen Bericht, Datenintegrität MA, Gäste & Reservationen, Reservations Analyse, Gäste Duplikate).
- Bewusst OHNE Nav-Eintrag (nur per URL/Header-Link): `/reporting`, `/import-cockpit`; `/foratable-report` → Redirect auf `/gaeste/auswertung`; `/gaeste/wochentag` + `/gaeste/vorjahr` bestehen nur noch per URL.
- Route „/" = `isAdmin ? StartOverview : (canAccessModule('dashboard') ? Dashboard : /personal)`. `StartOverview.tsx` (rein `start-overview-utils.ts` + Hook `useStartOverview`, read-only): Heute-Statuskarten, Warnungen nur bei Status `action`, Schnellaktionen; Frische-Regeln 1:1 via `computeSourceStatus`. „Heute wichtig"-Banner im Dashboard (`HeuteWichtigBanner.tsx`) nutzt dieselbe Quelle, nur Admin.

## Reporting und Erfolgsrechnung

- **P&L:** `src/pages/PLView.tsx`, `src/lib/pl-engine.ts` (`computePLForMonth`, `PL_STRUCTURE`), `reporting-store.ts`. Reporting-Monate NUR via `safeUpsertReportingMonth`/`safeDeleteReportingMonth`. Vorjahres-Diagnose-Banner rein `pl-prior-year-diagnostics.ts`. P&L-Budget nur über `budgetByRow` (`buildBudgetByRowForMonth`).
- **Warenaufwand-Zwischentotale (SSoT `warenaufwand-gruppierung.ts`):** Direkter Warenaufwand = Konten 4000–4070, Übriger Warenaufwand = 4071–4900 (numerische Range über normalisierte Kontonummer, Grenzen inklusiv — Grenzwerte 4070/4071 getestet; ausserhalb → keine Gruppe, nie stilles Zuordnen). PL_STRUCTURE-Rows `total_cogs_direct`/`total_cogs_uebrig`; `total_cogs` = Summe beider; Bruttogewinn 1 unverändert daraus. Bei Konto-Level-Daten gewinnt die Range über die Kategoriezuordnung (Konflikt ⇒ `dataQualityWarnings`), sonst Kategorie-Fallback (food/bev→direkt, other→übrig); Budget-Split via `buildCogsBudgetSplitForMonth`. Zentral in allen Ansichten und Exporten (klassische ER via `computeBPLRows`, PDF, Excel, `MULTI_YEAR_POSITIONS`, `BANK_ROW_IDS`).
- **Mehrjahresanalyse + Management Report:** PLView-Modi `multi_year`/`mgmt_report`. Rein `multi-year-analysis.ts` (Monatsmatrix mit Δ Vorjahr/Basisjahr, Common-Month-Vergleich bei Teiljahren, CAGR nur über volle 12-Daten-Monats-Jahre, Datenqualität `hinweis|warnung|fehler`, `buildMethodikNotes`). ER-Positions-Selektor (`MULTI_YEAR_POSITIONS`; Semantik `revenue|expense|result` — expense neutral, keine Grün/Rot-Färbung); Jahres-Mehrfachauswahl 2–5, Default letzte 3, ältestes = Basisjahr. UI `MultiYearAnalysisSection.tsx` + Live-Report `ManagementReportView.tsx`. Datenbasis = ROH `loadYear`→`computePLForMonth` (ohne Tagesansicht-Override/Maison/Exclude — als `dataSourceHints` deklariert).
- **Jahres-Kosten-Import (Sage Kontoblatt):** ImportHub-Karte; Parser `parseAnnualSageKontoblattByMonth` (xlsx, Perioden-Erkennung, debug+failureReason). Schreibt via `applyAnnualCostImport` (safe-upsert je Monat, NUR Kostenfelder des Zieljahres; Monate ohne Buchungen werden nicht angelegt). Import-Registry `annual-cost-imports-store.ts` (KV `annualCostImports_v1`, merge-on-save + Tombstones; Entry je Jahr mit importedAt/fileName/monthsWritten/unmappedCount; Löschen = Tombstone + Kostenfelder nullen).
- **Budget:** `budget-store.ts`/`Budget.tsx`; 2026-Seed automatisch beim ersten Laden ohne `plLineItems`; Budgetwerte folgen der AG-Kostenlogik.
- **Tagesumsätze:** KV-Blob `dailyBudgets`/`beaulieu:dailyBudgets`; Schreiben NUR via `safeUpsertDailyBudgets`.
- **OP-Liste Kreditoren:** `/op-liste` (admin-only; Gäste read-only ohne Import). Sage-PDF-Import mit Vorschau vor dem Speichern; Parser rein `op-liste-parser.ts` (X-Positions-Kalibrierung für Alters-Buckets; Gesamtsaldo nach Priorität NACH der Zeilen-Schleife: „Gesamt Saldo von N Posten" > „Total der Währung CHF" > „Gesamtsaldo", Subtotale gewinnen nie; `totals.openAmount` bleibt `null` ohne erkanntes Total — nie still 0.00; Override-Checkbox im Dialog-Gate). Vergleich/Behörden rein `op-liste-compare.ts` (MWST/QST/AHV/BVG). DB mit Lifecycle processing→active/replaced; gleicher Stichtag nie still überschrieben.

## Banken- und Investorenbericht

- PLView-Modus `bank_investor`; Datenbasis = DASSELBE `multiYearSeries`-Memo wie Mehrjahre/Report (keine Zweitberechnung). Rein `src/lib/bank-investor-analysis.ts` (`buildBankInvestorAnalysis`).
- **Zweijahresvergleich:** Basisjahr vs. aktuelles Jahr, „bis gleicher Monat" default AN (`comparisonMonthIndices`). Executive-KPIs mit Wirkungs-Ampel (Ergebnis rauf=grün, Quote runter=grün, absolute Kosten relativ zum Umsatzwachstum via `toneForCostDelta`; Schwellen 0.5 %/0.2 pp). Monats-/EBIT-Reihen, Positionstabelle mit Quoten, Kostenstruktur, Datenqualität inkl. `unmappedAccounts`. <2 Jahre mit Daten ⇒ EmptyState.
- **Mehrjahres-/Management-Reporting:** Jahresmodus `two|three|all` (`selectBankYears`; Legacy-Selects nur bei 'two'). Scorecard (endet bei EBIT), Executive Summary (9 KPIs + regelbasierter Gesamttrend), Waterfall Umsatz→EBIT (Subtotale = Engine-Werte), EBIT-Treiberanalyse (Beiträge + Residual-Kontrollwert), Historie (volle Jahressummen, Teiljahr markiert), Benchmarks (`BANK_BENCHMARKS`: Warenquote ≤30, Personalquote ≤35, EBITDA-Marge ≥15, EBIT-Marge ≥10, Bruttomarge ≥70 %; Toleranz 1.0 pp), Heatmaps (Monat×Jahr), Investor-Timeline (Datenbasis + Importstand je Jahr aus der Import-Registry), regelbasierte Kernaussagen (5 positiv + 5 Potenziale). UI-Sektionen + Drilldown in `src/components/reporting/bank-investor/`; Scorecard-Zeilenklick → Drilldown-Dialog.
- **USER-ENTSCHEID: Der Bericht endet bei EBIT.** Keine „Jahresgewinn"-Zeile, EBIT nie mit Jahresgewinn gleichgesetzt, keine Schätzungen, keine unvollständigen Finanzkonten. Zentraler Hinweis `EBIT_REPORT_NOTE` („Finanzergebnis und Steuern sind in dieser Auswertung nicht enthalten. Der Bericht endet daher bei EBIT.") erscheint identisch in UI, PDF und Excel. Jahresgewinn kann als eigene Phase folgen, sobald Finanzaufwand/-ertrag und Steuern vollständig importiert und gemappt sind.
- **Exporte teilen DASSELBE Analysis-Objekt** (Vorschau ≡ Export): PDF `bank-investor-pdf.ts` (Abschnittsreihenfolge = Bildschirm) + Excel `bank-investor-excel.ts` (7 Blätter: Übersicht/Monatsvergleich/ER Basisjahr/ER aktuell/Kennzahlen und Margen/Mehrjahresanalyse/Datenqualität; Waterfall-Kosten als negative Zahl).

## Import-System

- **Checklisten-Engine** rein `import-tasks-engine.ts` — 9 Typen: täglich/zeitraum (zbericht, reservationen, umsatz, verkaufsdaten, mirus, marketing), monatlich (erfolgsrechnung, istkosten), jährlich (budget). Aufgaben mit stabilen IDs; Coverage-Fehler → sichtbare error-Aufgabe. Coverage read-only `import-tasks-db.ts` (KEINE Store-Loader). Priorisierung/Fälligkeit rein `import-tasks-priority.ts` (`getTaskDueInfo`, `prioritizeTasks`, `computeMonthProgress` — Nenner nur fällige Aufgaben; complete nur wenn alles done UND Monat vorbei). Erwarteter Zeitraum immer auf `min(Monatsende, gestern)` gedeckelt; laufender Monat/Jahr neutral „läuft noch". Teilimporte: `missingRanges` erzeugt Restaufgaben nur für Lücken. Prefill advisory (nie harte Einschränkung) via `import-prefill.ts`.
- **Import-Cockpit** `/import-cockpit` (admin-only, ohne Nav-Eintrag, reine Anzeige; 3 Tabs Checkliste/Status/Kontrollen). Deskriptoren/Schwellen rein `import-cockpit.ts` (`COCKPIT_SOURCES`: 10 Datenimporte + 8 Kontrollen; `computeSourceStatus`/`findMissingDays`); Signale read-only aus Blobs, nie via seedende Loader. Datenlücken nur für tägliche Quellen, senken Status höchstens auf gelb (Ruhetage legitim). Kontrolle „Buchhaltungs-Export" mit Status-Override aus dem monatlichen Export-Stand. Monatsübersicht + KPI-Kacheln als Toggle-Filter.
- **Import-Center** `/import` (`ImportHub.tsx`, rein `import-center.ts`): Launcher; Sichtbarkeit spiegelt echte Route-Guards. Gruppen-Overviews rein `import-groups.ts` via `computeSourceStatus` (Status = worst-of).
- **Z-Bericht/Gastronovi** (`gn_*`-Tabellen): Tagesimporte `period_from===period_to`; nie Multi-Tage auto-splitten; Replace via rows-affected verifizieren.
- **Gastronovi Produkt-CSV** → `product_sales`: gleiche Produktnamen je Datum werden zu EINEM Record summiert (flache CSV ohne Artikelnummer).
- **Reservations-Import (Foratable):** idempotent via UNIQUE `(restaurant_id, external_reservation_id)`; Gast-Match Telefon → E-Mail, nie Name; Name-only dedupliziert über `match_key`. Gästeexport-Import füllt NUR leere manuelle CRM-Felder, überschreibt nie.
- **Import-Historie:** `import_runs`; `logImportRun` best-effort/wirft nie, additiv, keine PII, Zeitstempel = DB `now()`.

## Tagesabschlüsse

- Seite `/tagesabschluesse` (BlockedRoute beaulieu_manager, `!isAdmin → Navigate`; Gäste lesend). Komponenten in `src/components/umsatzabstimmung/`.
- **Monatsübersicht:** 14 Spalten in 5 Gruppen (Umsatz/Kartenzahlungen/Kasse/Gutscheine/Weitere), kompakte Standardansicht 10 Spalten. KK-/KK-Adyen-Popovers mit Zahlungsarten-Breakdown (gemeinsamer Renderer; unklassifizierte Zahlarten zählen nirgends). Bargeld Soll + Kassensaldo Soll berechnet/read-only („—" solange Anfangsbestand unbekannt); Cash Ist manuell; Inline-Buchungswerte direkt editierbar (KK-Adyen-Override, Saldo-Anker re-based die Kette, Gutscheine, Barausgaben als EINE generische Inline-Ausgabe Konto 1001).
- **Import-Abgleich:** `detectTagesabschlussImportConflicts` beim Z-Bericht-Import (Konflikt = Import ↔ korrigierter Wert; gesperrte Tage nie angefasst; „Übernehmen" tombstoned den Override).
- **Adyen-Abgleich (täglich):** Parser rein `adyen-csv-parser.ts` („Received Payment Details"-CSV, vorzeichenbehaftet, refund/chargeback-Negierung, nur CHF, Payout-CSV abgelehnt). Abgleich rein `adyen-abstimmung.ts` (Blob `adyenAbstimmung_v1`; `mergeAdyenImport` ersetzt nur importierte Tage). `normalizeGnPaymentName` mit ZWEI Flags: `isCard` (Adyen-Vergleichsbasis) und `isKkCard` (KK-Total = alle isCard PLUS PostCard/Lunch-Check/Stripe, die nie in isCard dürfen). Overrides bidirektional, schreiben nie in `gn_*`. Diff-Ampel grün ≤0.05/orange ≤5/rot. Tagesbestätigung: Z-Bericht vorhanden + jede nicht-grüne Differenz übersteuert oder kommentiert + Barbestand bestätigt.
- **Buchhaltungs-Export (Monat):** rein `buchhaltungs-export.ts` — Export-Gate (alle Z-Tage abgeschlossen, Monat zu, Mapping ok, Diffs begründet), Soll/Haben-Vorschau ≡ CSV garantiert, Status offen|bereit|exportiert|veraltet (Fingerprint über Monatsdaten + Konten; Konto-Änderung ⇒ veraltet, reine Umbenennung nicht), Export-Protokoll versioniert im Blob. PDF-Abschlussblatt rein `monatsabschluss-pdf.ts`.
- Tombstones sind Pflicht: jedes Entfernen von Overrides/Ankern/Ausgaben/Kommentaren setzt `deleted:true`; `computeMonthFingerprint` behält Tombstones bewusst (Löschung invalidiert den Export).
- **Umsatzabstimmung** (Monatsabstimmung) ist eine eigene Seite `/umsatzabstimmung`.

## Reservationen und Gäste-CRM

- **CRM-Kern:** rein `reservation-crm.ts` (Single Source für Segment/Metrik — rein besuchsbasiert, keine Geldspalte); `reservation-crm-db.ts` read-only/tenant-isoliert. Besuchszählung nur completed; first/last_seen nie mit all-status mischen.
- **Manuelles CRM-Profil** (`guest_crm_profiles`, Tenant über Eltern-Gast) strikt getrennt vom berechneten Segment. **Smart-Segmente** rein `guest-smart-segments.ts` (7 Live-Segmente, additiv).
- **Kundenakte** `/gaeste/:guestId`: gewichteter CRM-Score 0–100; Fetched-State am Anfang von `load()` UND im `catch` zurücksetzen (Cross-Guest-PII).
- **Gäste & Reservationen** `/gaeste/auswertung` (vereint CRM-Auswertung + früheren Foratable Report): Zukunfts-KPIs + Kalender + CRM-Tabs; Zukunftslogik rein `foratable-future.ts` auf Basis `reservation-dashboard.ts` — keine zweite Zukunftsberechnung; View-State open-redirect-sicher in URL. Popups zeigen Aggregate bzw. admin-gated PII, nie PII an Gäste.
- **Kampagnen:** rein `reservation-campaigns.ts` (18 Listen; manuelle Kampagnen lesen nur `m.crm`). CSV UTF-8 mit BOM, `;`-getrennt, CRLF, deutsche Header.
- **Duplikat-Merge** (ohne DB-Transaktion): Preflight Cross-Tenant-Abort → Reservationen zuerst umhängen → CRM-Merge → Aggregate NEU berechnen (nie summieren) → Postcondition → löschen → PII-freies Audit. `match_key` nie anfassen.
- **Reservations-Analyse** `/gaeste/analyse`: Umschalter Personen/Reservationen, 5 Tabs (Monate/Wochentage/Saison/Matrix/Heatmap — Matrix und Heatmap teilen dieselben Daten), Monats-Popup mit Ist-vs-Vorjahr. Rein `reservation-analyse-utils.ts` (reuse `reservation-yoy-utils.ts` + `reservation-weekday-analytics.ts`).

## Personal und Personalbedarf

- **Personalstamm:** Nur das Personalstamm-Formular schreibt `employees` nach Supabase — Auto-Sync/SchedulePlanner/Seed schreiben NICHT (Dubletten). Import-Match braucht die volle Mitarbeiterliste. Externe Kostenpersonen (`aush_*`) leben in `schedule_extra_cost_people`, nicht in `employees`.
- **Positionen/Stationen:** stabile Keys (Slugs), nie Anzeigenamen, in `employee.primaryStation`/`secondaryStations` — Umbenennen bricht keine Zuordnungen. `applyDefaultPositions` deaktiviert statt löscht.
- **Dienstplanung:** `SchedulePlanner.tsx` + `pattern-warnings.ts`; Küchen-Manager-Ansichten lohn-sicher (kein CHF-Betrag im DOM via `schedule-daily-totals.ts`); Export abteilungstreu.
- **Personal FIX+VARIABEL** (`/personal-fix`): drei „Flex Ist"-Grössen aus EINER Quelle (`personal-fix-reconciliation.ts`, `computeFlexScopes`): (1) Flex Arbeit Ist, (2) + Zusatzkosten Fixlohn-MA, (3) + Ferienabbau; sichtbare Abstimmungskette. Personalcontrolling: Block „Budget vs. Ist" mit richtungsabhängigem Ton (unter Budget = grün), Block „App vs. Erfolgsrechnung" mit betragsbasiertem Ton; FIBU-Wert = „Löhne (Total)"+„Sozialleistungen" aus `computePLForMonth`, nie nachfaktorisiert. Drilldown (`personal-controlling-drilldown.ts`): Gruppierung Tage/Positionen/MA, Ursachen-Ableitung, 2. Detailebene je Schicht — nur bereits geladene Daten, keine neuen DB-Abfragen; fehlende Zeiten „—", nie geschätzt.
- **Überstunden:** rein `overtime-analysis.ts` — `overtime = max(0, produktive Ist − Monatssoll)`, Soll = 42h × (Tage/7) × Pensum; nur Festangestellte mit `monthlySalary>0`; Absenzen zählen nie als produktiv; liegen nur monatlich vor.
- **Personalbedarf (SOLL):** pro Saison×Wochentag je Position; getrennt von der Dienstplanung (kein FK); Orphan-Schutz beim Speichern. **SOLL/Ist-Abgleich** (nur Anzeige): 2-Farben-Warnung (exakt = grün, jede Abweichung = rot, Richtung über Label); Matching nur über Hauptposition, rollen-scoped. Nachfrage-Kontext aus Reservationen (PII sofort auf `{date,partySize,status}` projiziert).
- **Planungsempfehlungen** (regelbasiert, read-only + lokale Simulation): mindestens 3 Vergleichstage pro Gruppe, sonst übersprungen; fehlende Daten → `null` + `limitations`, nie 0/geschätzt; Simulation rein lokal, kein Schreibpfad.

## Warenkosten und Produktanalyse

- **Produkt-Analyse:** `ProduktAnalyse.tsx`/`ProduktDetail.tsx`, rein `product-analytics.ts`; Perioden Tag/Woche/Monat/Jahr (ISO-Wochen mit 52/53-Rollover), Filter URL-gespiegelt.
- **Warenkostenquote (SSoT `warenkosten-quote.ts`):** `kategorieFromKonto` = OPERATIVES Mapping (4000/4030→Food, 4020→Beverage, Rest→Sonstiges) — bewusst anders als der FIBU-Kontenplan, nie quer-mappen. Quote (%) basiert IMMER nur auf relevanten Warenkosten (Food+Beverage), «Diverses/Sonstiges» ausgeschlossen; CHF-Beträge zeigen den vollen Aufwand. `null` bei fehlendem/0-Umsatz — nie 0. ALLE Quoten laufen hierüber.
- **FIBU-Abgleich (Warenkosten vs. ER):** FIBU-Seite via `loadMonth`→`computePLForMonth` (read-only); Vergleich nur bei `monthAligned` (ganzer, vergangener Kalendermonat) — sonst neutrale HintBox statt Scheindifferenz; fehlende ER → Hinweis + Link, nie stille 0.
- **Stammdaten/WES:** Artikel, ProduktStamm, WesAnalyse, ArtikelTracking; Vergleich Rezept/Lieferant/Buchhaltung. **Lieferantendokumente:** SupplierDocuments/Comparison + Store.

## Exporte

- Alle Exporte konsumieren dieselben zentralen Datenobjekte wie die UI (Vorschau ≡ Export) — keine separate Export-Berechnungslogik.
- **Excel:** exceljs per dynamic import; Beträge als echte Zahlen; Schweizer Formate CHF `#,##0.00`, Prozent `0.0%` (Rohwert/100) bzw. `0.0"%"`. **PDF:** jsPDF/autoTable per dynamic import, `pdfSafe` für WinAnsi-Zeichen.
- Exporte: P&L-PDF/Excel, Management-Report-PDF, Mehrjahres-Excel, Banken-/Investoren-PDF+Excel, Warenkosten-Excel, Buchhaltungs-Export-CSV + Monatsabschluss-PDF, Dienstplan-Exporte (abteilungstreu, AG-Kosten), Kampagnen-CSV, Drilldown-CSVs (Blob + BOM).

## Fachliche Kernregeln

- **Personalaufwand = Total Arbeitgeberkosten appweit.** Bruttolohn (inkl. anteiligem 13.) × AG-Faktor (`social-costs.ts` + `employee-rate.ts`; Hooks `useSocialCostRates`/`useEmployerRateMap`; Libs bekommen `rates` als Pflicht-Param). Nie mit rohem `hourlyWage` rechnen.
- **FIBU-Ist (5xxx) ist BEREITS AG-Aufwand** — nie zusätzlich mit dem Sozialkosten-Faktor multiplizieren. ER-Personal-Ist = Löhne+Sozialleistungen aus `computePLForMonth`, exkl. übriger Personalaufwand.
- **Keine Doppelzählung:** Arbeitnehmerabzüge sind Bestandteil des Bruttolohns. **Quellensteuer ist kein Aufwand** — nur weiterzuleitende Verbindlichkeit (z. B. QST in der OP-Behördenauswertung).
- **Fehlend ≠ 0:** fehlende Daten werden als `null`/„—" ausgewiesen, nie als 0/CHF 0 erfunden; Basis 0 ⇒ „nicht vergleichbar"; kein NaN/Infinity. Gilt für P&L, Quoten, Banken-Bericht, OP-Total, Drilldowns.
- **Banken-Bericht endet bei EBIT** (USER-ENTSCHEID, s. Abschnitt Banken- und Investorenbericht).
- **Umsatz-/Finanzdaten nie per localStorage-Overwrite oder naivem Blob-Write speichern** (verbindliche User-Vorgabe): `safeUpsertDailyBudgets`/`safeUpsertReportingMonth` etc.; KV-Schreibfehler sichtbar melden, kein stilles Fallback.
- Warenaufwand-Gruppen (4000–4070/4071–4900) und Warenkostenquote-Basis (nur Food+Beverage) sind fixe fachliche Regeln (s. jeweilige Abschnitte).
- de-CH-Formate appweit; Zahlen rechtsbündig + `tabular-nums`.

## Technische Konventionen

- **Designsystem (einmal zentral):** Desktop-first, schlicht, modern, lesefreundlich, Information vor Dekoration; responsive ohne Funktionsverlust. Für alle Seiten NUR die gemeinsamen Bausteine: `tones.ts` (grün=gut, orange=Achtung, rot=kritisch, blau=Info, grau=neutral), `StatusPill`, `KpiCard`/`KpiGrid`/`MoreKpis` (max. 4 KPI-Karten sichtbar, Rest verlagern — nie löschen), `InfoTip` (Erklärungen als Tooltip), `HintBox`, `LoadingState`/`EmptyState`, `table-style.ts`-Konstanten (Sticky-Köpfe brauchen OPAKE Hintergründe), `dialog-size.ts`, `PageShell`/`PageHeader`. Seitenmuster: Toolbar → optionale HintBox → KpiGrid → Hauptinhalt im Scroll-Container mit Sticky-Kopf → Details per Klick/Tooltip/Collapsible. Referenz: `KennzahlenBerichtPage`; Plan `docs/ux-phase3-plan.md`. HintBox/StatusPill reichen `data-testid` nicht durch → Wrapper-div.
- **Run/Build:** `npm run dev` · `npm run build` (bei stillem OOM/Exit -1: `NODE_OPTIONS=--max-old-space-size=8192`). Env: Supabase URL + Anon Key (`src/integrations/supabase/client.ts`).
- **Type-Check:** `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.app.json --noEmit` — das nackte `tsc --noEmit` prüft nichts (solution-style Root-tsconfig); Legacy-Fehler existieren, nur auf berührte Dateien filtern.
- **Tests:** reine Logik `// @vitest-environment node`, Komponenten `// @vitest-environment happy-dom` (jsdom crasht via natives canvas). Vitest immer mit 8192-MB-Heap; voller Lauf OOM-gefährdet → in Chunks. Zentrale Logik ist durch Unit-/Regressionstests abgesichert (Grenzwerte, Idempotenz, Export=UI); Parser vor Verlass auf Zahlen mit echter Datei validieren.
- **Review:** nach grösseren Features Architect-Review mit Git-Diff; Review difft die ganze Branch seit letztem Checkpoint — fremde Commits nicht zurückdrehen.
- **Dokumentation:** diese Datei nach jeder abgeschlossenen Änderung auf den aktuellen Stand bringen (kein Changelog, keine Task-Protokolle); Detail-Lehren in `.agents/memory/` (keine Secrets/PII, nichts aus dem Code Ableitbares).
- Referenzen: Supabase https://supabase.com/docs · React https://react.dev/ · Tailwind https://tailwindcss.com/docs · Shadcn UI https://ui.shadcn.com/docs

## Bekannte Einschränkungen

- **`daily_revenues`-Migration vorbereitet, NICHT aktiv:** Tagesumsätze liegen weiter im KV-Blob (`safeUpsertDailyBudgets` schützt, hat aber Grenzen: kein Audit-Log, kein atomarer Tages-UPSERT). Script `supabase/migrations/20260507_daily_revenues.sql` liegt bereit; erst aktivieren, wenn die Blob-Lösung fachlich fertig getestet ist (verbindliche Vorgabe).
- **Tote Komponenten (nicht auf AG-Kosten migriert, 0 Importer):** `KPIDashboard` (hardcoded ×1.22!), `UnifiedCostOverview`, `MonthlyOvertimeOverview`, `WeeklyOvertimeOverview`, `TimeEntriesEditor`, `PlannedLaborCostCalculator` — bei Wiederbelebung zuerst auf `rates` umstellen oder löschen.
- Migrationen laufen manuell im Supabase SQL-Editor; RLS-Stand der Live-DB empirisch prüfen.
- Gastronovi-Produkt-CSV: gleiche Produktnamen mit verschiedenen Preisen werden unvermeidlich summiert (keine Artikelnummer in der Quelle).
- Überstunden liegen nur monatlich vor (keine Tages-Ursachenzuordnung im Drilldown).
- Mirus-Excel: 1904-Datumsflag — nie mit `cellDates:true` lesen; MA-Namen ggf. manuell mappen.
- FIBU-Vergleiche summieren immer ganze Kalendermonate — Teilperioden-Vergleiche werden bewusst nicht angezeigt.
