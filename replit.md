# Personalkostentracker

Detail-Lehren und Historie liegen in `.agents/memory/` — diese Datei beschreibt nur den aktuellen Stand.

## 1. Projektüberblick

- **Zweck:** Internes Reporting- und Controlling-Tool für Gastronomie-Betriebe: Umsatz, Personalkosten, Dienstpläne, Tagesabschlüsse, Reservationen/Gäste-CRM, Produkte/Warenkosten und Finanz-KPIs. Mandantenfähig für zwei Betriebe (Oliv, Beaulieu).
- **Benutzerrollen:** admin / service_manager / kueche_manager / beaulieu_manager / beaulieu_viewer / Gast (temporäre, passwortgeschützte read-only Freigaben).
- **Tech-Stack:** React + TypeScript + Vite, Shadcn UI, Tailwind, `date-fns`, `recharts`; Backend Supabase (Auth, Postgres, KV-Store `app_settings`). Ablage: `src/pages/`, `src/components/`, `src/lib/` (reine Logik + DB-Layer), `src/types/`, `src/contexts/`, `src/hooks/`, `supabase/migrations/`; Routing in `src/App.tsx`.
- **Zentrale Datenquellen:** Supabase-Tabellen (u. a. `employees`, `gn_*`, `reservation_records`, `product_sales`, `creditor_op_*`, `import_runs`) + KV-Blobs (Reporting, Tagesumsätze, Adyen-Abstimmung, Import-Registries); Importe aus Gastronovi (Z-Bericht/Produkt-CSV), Foratable (Reservationen/Gäste), Mirus (Arbeitszeiten), Adyen (Zahlungen), Sage (Jahres-Kosten, OP-Liste).
- **Hauptmodule:** Startseite/Dashboard · Reporting (P&L, Budget, Mehrjahre, Management Report, Banken-/Investorenbericht, Tagesumsätze, OP-Liste) · Tagesabschlüsse + Umsatzabstimmung · Import-Center/-Checkliste/-Cockpit · Gäste-CRM & Reservationen · Personal (Stamm, Positionen, Dienstplan, FIX+VARIABEL, Personalbedarf) · Produkte & Warenkosten · Kennzahlen-Bericht.
- **Grundprinzipien:** je Fachdomäne EINE Berechnungsquelle (Single Source of Truth); fehlend ≠ 0; Finanzdaten nur über sichere Merge-Schreibpfade; reine Logik getrennt von IO; Importe idempotent; keine geschätzten Finanzwerte.

## 2. Globale Architektur- und Datenregeln

- **Multi-Tenancy:** Tenant = ID-Präfix (`b-` = Beaulieu). `employees`/`app_settings` haben KEINE `restaurant_id`-Spalte; Reservations-/CRM-/Kreditoren-Tabellen haben sie, jeder Read/Write ist tenant-gefiltert. `product_sales` ist mandantenübergreifend. Infra: `TenantContext.tsx`, `tenant-utils.ts`, KV-Keys via `tenantKey`.
- **Persistenz:** localStorage als schneller Primärspeicher + Supabase-KV als Backup (`useSyncStore`). Finanz-/Umsatzdaten NIE per naivem Blob-Write — nur read→merge→write (`safeUpsertDailyBudgets`, `safeUpsertReportingMonth`/`safeDeleteReportingMonth` etc.) mit sichtbarem Fehler statt stillem Fallback (verbindliche User-Vorgabe). Union-merge-Blobs: Tombstones (`deleted:true`+`updatedAt`) statt Hard-Delete; alle Leser filtern `deleted`.
- **Keine parallelen Datenmodelle/Berechnungen:** bestehende Tabellen und Engines bevorzugen; keine neuen Tabellen ohne zwingenden Grund; UI-Kacheln und Drilldowns aus DENSELBEN Rows; Drilldown-Summen sichtbar gegen die übergeordnete Summe abstimmen, Abweichung nie still. Bewusste Ausnahmen dokumentieren (z. B. Rückkehrpotenzial-Faktoren 1.5 vs. 2.0 koexistieren).
- **SSoT-Kerne (zentrale Libs):** `pl-engine.ts` (`computePLForMonth`, `PL_STRUCTURE`) · `warenaufwand-gruppierung.ts` · `warenkosten-quote.ts` · `social-costs.ts`/`employee-rate.ts` (AG-Kostenfaktor) · `reservation-crm.ts` (Segment/Metrik) · `import-cockpit.ts`/`computeSourceStatus` (Frische-Schwellen für Startseite/Import-Center/Cockpit).
- **Reine Logik getrennt von IO:** Analyse-/Berechnungs-Libs (`src/lib/*-utils.ts`, `*-analytics.ts`) sind DOM-/Supabase-frei (nur `import type`); DB-Layer (`*-db.ts`) kapselt IO + Tenant-Filter. Read-only-Aggregatoren (Import-Cockpit, Startseite, Gruppen-Overviews) leiten Status nur ab, schreiben nie, erfinden keine Zeitstempel.
- **Import-Engine:** generische Parser `csv-import-engine.ts`/`pdf-import-engine.ts`; jeder Parser liefert `debug`-Objekt + `failureReason` auf ALLEN Pfaden und legt bei Fehler die reale Dateistruktur offen. Importe idempotent; Bulk-Upserts vor `.upsert()` nach dem `onConflict`-Key deduplizieren; Replace via rows-affected verifizieren; manuelle Werte nie unbemerkt überschreiben (Konflikt-Dialoge, Tombstone-Overrides).
- **Rollen/Berechtigungen:** zentral `usePermissions.ts` + `AuthContext.tsx`. **`isAdmin = isAdminUser || isGuest`** — admin-only-PII-/Schreibseiten gaten deshalb `isAdmin && !isGuest` auf Route-Guard UND Lade-Effekt (Fetch feuert vor `Navigate`); Gäste rein lesend, nie PII. Lohn-Gating `canSeeHourlyWages`/`canEditWages`; vertrauliche Personalflächen unter `canManageAllEmployees = isAdmin || isBeaulieuManager`; `kueche_manager` sieht nie Löhne/PII. Rollen-Gates nie verbreitern — engeres Alt-Gate anlegen. Manager-Sichtbarkeit auf Mitarbeitende zentral über `employee-visibility.ts` (eingeschränkte Rolle gewinnt; RAW-`employees` nur für Import-Match/CRUD).
- **Datenschutz:** PII-/CRM-/Reservations-/Kreditoren-Tabellen mit RLS authenticated-only + `REVOKE anon` (RLS empirisch verifizieren). Reservations-PII in Auswertungen sofort auf `{date,partySize,status}` projizieren; Audit-Logs (`import_runs`, Merge-Log) PII-frei; Detailseiten mit `/:id` setzen Fetched-State am Anfang von `load()` UND im `catch` zurück (Cross-Guest-PII).
- **Betrieb:** Migrationen sequenziell manuell im Supabase SQL-Editor (Management-API-DDL ist manuell). Env: Supabase URL + Anon Key (`src/integrations/supabase/client.ts`). Monats-Coverage-Ladeprozesse cachen pro Monat, fetchen Zukunft nie und verwerfen veraltete Antworten nach Tenant-Wechsel.

## 3. Globale UI- und UX-Richtlinien

- Desktop-first, schlicht, modern, lesefreundlich, Information vor Dekoration; responsive ohne Funktionsverlust; verständliche deutsche Bezeichnungen; de-CH-Formate appweit, Zahlen rechtsbündig + `tabular-nums`.
- NUR die gemeinsamen Bausteine verwenden, keine Eigenbauten: `tones.ts` (grün=gut, orange=Achtung, rot=kritisch, blau=Info, grau=neutral), `StatusPill`, `KpiCard`/`KpiGrid`/`MoreKpis` (max. 4 KPI-Karten sichtbar, Rest verlagern — nie löschen), `InfoTip`, `HintBox`, `LoadingState`/`EmptyState`, `table-style.ts` (Sticky-Köpfe brauchen OPAKE Hintergründe), `dialog-size.ts`, `PageShell`/`PageHeader`. HintBox/StatusPill reichen `data-testid` nicht durch → Wrapper-div.
- Seitenmuster: Toolbar → optionale HintBox → KpiGrid (wichtige Kennzahlen früh sichtbar) → Hauptinhalt im Scroll-Container mit Sticky-Kopf → Details per Klick/Tooltip/Collapsible; Drilldowns in bestehenden Dialogen mit klarer Zurück-Navigation; Filter/Zeitraum wirken erkennbar auf die Anzeige. Referenz: `KennzahlenBerichtPage`.
- Navigation: `AppNav.tsx` (`DASHBOARD_ITEM` + `NAV_GROUPS`; longest-path-Highlighting; `secondary: true` = hinter „Mehr"-Toggle). Bewusst OHNE Nav-Eintrag (nur URL/Header-Link): `/reporting`, `/import-cockpit`; `/foratable-report` → Redirect auf `/gaeste/auswertung`. Route „/" = `isAdmin ? StartOverview : (canAccessModule('dashboard') ? Dashboard : /personal)`.
- Exporte verwenden dieselben fachlichen Werte und Hinweise wie die UI (s. §6).

## 4. Aktueller Funktionsumfang

### Startseite und Dashboard
Startübersicht (admin, read-only): Heute-Statuskarten, Warnungen nur bei Status `action`, Schnellaktionen; Frische-Regeln 1:1 via `computeSourceStatus`. „Heute wichtig"-Banner im Dashboard nutzt dieselbe Quelle, nur Admin. KPI-Dashboard unter `/dashboard`.

### Import-System
- **Checklisten-Engine** rein `import-tasks-engine.ts` — 9 Typen: täglich/zeitraum (zbericht, reservationen, umsatz, verkaufsdaten, mirus, marketing), monatlich (erfolgsrechnung, istkosten), jährlich (budget). Stabile Aufgaben-IDs; Coverage-Fehler → sichtbare error-Aufgabe; Coverage read-only (`import-tasks-db.ts`, keine Store-Loader). Priorisierung/Fälligkeit rein `import-tasks-priority.ts` (Fortschritts-Nenner nur fällige Aufgaben; complete nur wenn alles done UND Monat vorbei). Erwarteter Zeitraum immer auf `min(Monatsende, gestern)` gedeckelt; laufender Monat/Jahr neutral „läuft noch". Teilimporte erzeugen Restaufgaben nur für Lücken (`missingRanges`). Prefill advisory, nie harte Einschränkung.
- **Import-Cockpit** `/import-cockpit` (admin-only, reine Anzeige; Tabs Checkliste/Status/Kontrollen). Schwellen rein `import-cockpit.ts` (10 Datenimporte + 8 Kontrollen); Datenlücken nur für tägliche Quellen, senken Status höchstens auf gelb (Ruhetage legitim); Kontrolle „Buchhaltungs-Export" mit Status-Override aus dem monatlichen Export-Stand.
- **Import-Center** `/import`: Launcher; Sichtbarkeit spiegelt echte Route-Guards; Gruppen-Overviews via `computeSourceStatus` (Status = worst-of).
- **Z-Bericht/Gastronovi** (`gn_*`): Tagesimporte `period_from===period_to`; nie Multi-Tage auto-splitten. **Produkt-CSV** → `product_sales`: gleiche Produktnamen je Datum werden zu EINEM Record summiert (flache CSV ohne Artikelnummer).
- **Reservations-Import (Foratable):** idempotent via UNIQUE `(restaurant_id, external_reservation_id)`; Gast-Match Telefon → E-Mail, nie Name; Name-only dedupliziert über `match_key`. Gästeexport-Import füllt NUR leere manuelle CRM-Felder, überschreibt nie.
- **Import-Historie:** `import_runs`; Logging best-effort/wirft nie, additiv, keine PII, Zeitstempel = DB `now()`.

### Tagesabschlüsse und Umsatzabstimmung
- `/tagesabschluesse` (admin bzw. beaulieu_manager; Gäste lesend). Monatsübersicht mit 14 Spalten in 5 Gruppen (kompakt 10); Zahlungsarten-Breakdown-Popovers (unklassifizierte Zahlarten zählen nirgends); Bargeld Soll + Kassensaldo Soll berechnet/read-only („—" solange Anfangsbestand unbekannt); Cash Ist manuell; Inline-Buchungswerte editierbar (KK-Adyen-Override, Saldo-Anker re-based die Kette, Gutscheine, Barausgaben als EINE generische Inline-Ausgabe Konto 1001).
- **Import-Abgleich:** Z-Bericht-Import erkennt Konflikte mit korrigierten Werten; gesperrte Tage nie angefasst; „Übernehmen" tombstoned den Override.
- **Adyen-Abgleich (täglich):** Parser rein `adyen-csv-parser.ts` („Received Payment Details"-CSV, vorzeichenbehaftet, refund/chargeback-Negierung, nur CHF, Payout-CSV abgelehnt); Abgleich rein `adyen-abstimmung.ts` (Import ersetzt nur importierte Tage). `normalizeGnPaymentName` mit ZWEI Flags: `isCard` (Adyen-Vergleichsbasis) und `isKkCard` (KK-Total = alle isCard PLUS PostCard/Lunch-Check/Stripe, die nie in isCard dürfen). Overrides bidirektional, schreiben nie in `gn_*`. Diff-Ampel grün ≤0.05/orange ≤5/rot. Tagesbestätigung: Z-Bericht vorhanden + jede nicht-grüne Differenz übersteuert oder kommentiert + Barbestand bestätigt.
- **Buchhaltungs-Export (Monat):** rein `buchhaltungs-export.ts` — Export-Gate (alle Z-Tage abgeschlossen, Monat zu, Mapping ok, Diffs begründet), Soll/Haben-Vorschau ≡ CSV garantiert, Status offen|bereit|exportiert|veraltet (Fingerprint über Monatsdaten + Konten; Konto-Änderung ⇒ veraltet, reine Umbenennung nicht), Export-Protokoll versioniert. PDF-Abschlussblatt rein `monatsabschluss-pdf.ts`. Tombstones sind Pflicht; der Fingerprint behält sie bewusst (Löschung invalidiert den Export).
- **Umsatzabstimmung** (Monatsabstimmung) ist eine eigene Seite `/umsatzabstimmung`.

### Erfolgsrechnung, Mehrjahresanalyse, Budget
- **P&L:** `pl-engine.ts` + `reporting-store.ts`; Reporting-Monate NUR via safe-upsert. Vorjahres-Diagnose-Banner rein `pl-prior-year-diagnostics.ts`. P&L-Budget nur über `budgetByRow` (`buildBudgetByRowForMonth`).
- **Warenaufwand-Zwischentotale (SSoT `warenaufwand-gruppierung.ts`):** Direkter Warenaufwand = Konten 4000–4070, Übriger = 4071–4900 (numerische Range über normalisierte Kontonummer, Grenzen inklusiv; ausserhalb → keine Gruppe, nie stilles Zuordnen). Rows `total_cogs_direct`/`total_cogs_uebrig`; `total_cogs` = Summe beider; Bruttogewinn 1 unverändert daraus. Bei Konto-Level-Daten gewinnt die Range über die Kategoriezuordnung (Konflikt ⇒ `dataQualityWarnings`), sonst Kategorie-Fallback (food/bev→direkt, other→übrig); Budget-Split via `buildCogsBudgetSplitForMonth`. Zentral in allen Ansichten und Exporten.
- **Mehrjahresanalyse + Management Report:** rein `multi-year-analysis.ts` (Monatsmatrix mit Δ Vorjahr/Basisjahr, Common-Month-Vergleich bei Teiljahren, CAGR nur über volle 12-Daten-Monats-Jahre, Datenqualität `hinweis|warnung|fehler`). ER-Positions-Selektor mit Semantik `revenue|expense|result` — expense neutral, keine Grün/Rot-Färbung; Jahres-Mehrfachauswahl 2–5, Default letzte 3, ältestes = Basisjahr. Datenbasis = ROH `loadYear`→`computePLForMonth` (ohne Tagesansicht-Override/Maison/Exclude — als Datenhinweis deklariert).
- **Jahres-Kosten-Import (Sage Kontoblatt):** Parser mit Perioden-Erkennung; schreibt safe-upsert je Monat, NUR Kostenfelder des Zieljahres; Monate ohne Buchungen werden nicht angelegt. Import-Registry je Jahr (merge-on-save + Tombstones); Löschen = Tombstone + Kostenfelder nullen.
- **Budget:** `budget-store.ts`; 2026-Seed automatisch beim ersten Laden ohne `plLineItems`; Budgetwerte folgen der AG-Kostenlogik. **Tagesumsätze:** KV-Blob `dailyBudgets`/`beaulieu:dailyBudgets`, Schreiben NUR via `safeUpsertDailyBudgets`.

### Banken- und Investorenbericht
- PLView-Modus; Datenbasis = DASSELBE Mehrjahres-Memo wie Mehrjahre/Report (keine Zweitberechnung); Analyse rein `bank-investor-analysis.ts`.
- **Zweijahresvergleich:** Basisjahr vs. aktuelles Jahr, „bis gleicher Monat" default AN. Executive-KPIs mit Wirkungs-Ampel (Ergebnis rauf=grün, Quote runter=grün, absolute Kosten relativ zum Umsatzwachstum; Schwellen 0.5 %/0.2 pp). <2 Jahre mit Daten ⇒ EmptyState.
- **Mehrjahres-/Management-Reporting:** Jahresmodus `two|three|all`; Scorecard (endet bei EBIT), Executive Summary (9 KPIs + regelbasierter Gesamttrend), Waterfall Umsatz→EBIT (Subtotale = Engine-Werte), EBIT-Treiberanalyse (Beiträge + Residual-Kontrollwert), Historie (volle Jahressummen, Teiljahr markiert), Benchmarks (Warenquote ≤30, Personalquote ≤35, EBITDA-Marge ≥15, EBIT-Marge ≥10, Bruttomarge ≥70 %; Toleranz 1.0 pp), Heatmaps, Investor-Timeline (Importstand je Jahr aus der Import-Registry), Kernaussagen (5 positiv + 5 Potenziale); Scorecard-Zeilenklick → Drilldown-Dialog.

### OP-Liste Kreditoren
`/op-liste` (admin-only; Gäste read-only ohne Import). Sage-PDF-Import mit Vorschau vor dem Speichern; Parser rein `op-liste-parser.ts` (X-Positions-Kalibrierung für Alters-Buckets; Gesamtsaldo nach Priorität NACH der Zeilen-Schleife: „Gesamt Saldo von N Posten" > „Total der Währung CHF" > „Gesamtsaldo", Subtotale gewinnen nie; `totals.openAmount` bleibt `null` ohne erkanntes Total — nie still 0.00; Override-Checkbox im Dialog-Gate). Vergleich/Behörden rein `op-liste-compare.ts` (MWST/QST/AHV/BVG). Lifecycle processing→active/replaced; gleicher Stichtag nie still überschrieben.

### Gäste-CRM und Reservationen
- **CRM-Kern:** rein `reservation-crm.ts` (besuchsbasiert, keine Geldspalte); Besuchszählung nur completed; first/last_seen nie mit all-status mischen. Manuelles CRM-Profil strikt getrennt vom berechneten Segment; 7 additive Smart-Segmente.
- **Kundenakte** `/gaeste/:guestId`: gewichteter CRM-Score 0–100. **Gäste & Reservationen** `/gaeste/auswertung`: Zukunfts-KPIs + Kalender + CRM-Tabs; Zukunftslogik rein `foratable-future.ts` — keine zweite Zukunftsberechnung; View-State open-redirect-sicher in URL; Popups zeigen Aggregate bzw. admin-gated PII, nie PII an Gäste.
- **Kampagnen:** 18 Listen (manuelle Kampagnen lesen nur das manuelle CRM-Feld); CSV UTF-8 mit BOM, `;`-getrennt, CRLF, deutsche Header.
- **Duplikat-Merge** (ohne DB-Transaktion): Preflight Cross-Tenant-Abort → Reservationen zuerst umhängen → CRM-Merge → Aggregate NEU berechnen (nie summieren) → Postcondition → löschen → PII-freies Audit; `match_key` nie anfassen.
- **Reservations-Analyse** `/gaeste/analyse`: Personen/Reservationen-Umschalter, Tabs Monate/Wochentage/Saison/Matrix/Heatmap (Matrix und Heatmap teilen dieselben Daten), Monats-Popup mit Ist-vs-Vorjahr.

### Personal, Personalbedarf, Personalcontrolling
- **Personalstamm:** Nur das Personalstamm-Formular schreibt `employees` nach Supabase — Auto-Sync/Dienstplan/Seed schreiben NICHT (Dubletten). Import-Match braucht die volle Mitarbeiterliste. Externe Kostenpersonen (`aush_*`) leben in `schedule_extra_cost_people`, nicht in `employees`.
- **Positionen/Stationen:** stabile Keys (Slugs), nie Anzeigenamen — Umbenennen bricht keine Zuordnungen; Default-Anwendung deaktiviert statt löscht.
- **Dienstplanung:** Muster-Warnungen; Küchen-Manager-Ansichten lohn-sicher (kein CHF-Betrag im DOM); Export abteilungstreu.
- **Personal FIX+VARIABEL** (`/personal-fix`): drei „Flex Ist"-Grössen aus EINER Quelle (`personal-fix-reconciliation.ts`): (1) Flex Arbeit Ist, (2) + Zusatzkosten Fixlohn-MA, (3) + Ferienabbau; sichtbare Abstimmungskette. Personalcontrolling: „Budget vs. Ist" mit richtungsabhängigem Ton (unter Budget = grün), „App vs. Erfolgsrechnung" mit betragsbasiertem Ton; FIBU-Wert = Löhne+Sozialleistungen aus `computePLForMonth`, nie nachfaktorisiert. Drilldown: Gruppierung Tage/Positionen/MA, Ursachen-Ableitung, 2. Detailebene je Schicht — nur bereits geladene Daten, keine neuen DB-Abfragen; fehlende Zeiten „—", nie geschätzt.
- **Überstunden:** rein `overtime-analysis.ts` — `overtime = max(0, produktive Ist − Monatssoll)`, Soll = 42h × (Tage/7) × Pensum; nur Festangestellte mit `monthlySalary>0`; Absenzen zählen nie als produktiv; liegen nur monatlich vor.
- **Personalbedarf (SOLL):** pro Saison×Wochentag je Position; getrennt von der Dienstplanung (kein FK); Orphan-Schutz beim Speichern. SOLL/Ist-Abgleich nur Anzeige: 2-Farben-Warnung (exakt = grün, jede Abweichung = rot, Richtung über Label); Matching nur über Hauptposition, rollen-scoped. Nachfrage-Kontext aus Reservationen (PII sofort projiziert).
- **Planungsempfehlungen** (regelbasiert, read-only + lokale Simulation): mindestens 3 Vergleichstage pro Gruppe, sonst übersprungen; fehlende Daten → `null` + Einschränkungshinweis, nie 0/geschätzt; Simulation rein lokal, kein Schreibpfad.

### Warenkosten und Produktanalyse
- **Produkt-Analyse:** rein `product-analytics.ts`; Perioden Tag/Woche/Monat/Jahr (ISO-Wochen mit 52/53-Rollover), Filter URL-gespiegelt.
- **Warenkostenquote (SSoT `warenkosten-quote.ts`):** `kategorieFromKonto` = OPERATIVES Mapping (4000/4030→Food, 4020→Beverage, Rest→Sonstiges) — bewusst anders als der FIBU-Kontenplan, nie quer-mappen. Quote (%) basiert IMMER nur auf Food+Beverage, «Diverses/Sonstiges» ausgeschlossen; CHF-Beträge zeigen den vollen Aufwand. `null` bei fehlendem/0-Umsatz — nie 0. ALLE Quoten laufen hierüber.
- **FIBU-Abgleich (Warenkosten vs. ER):** FIBU-Seite read-only via `computePLForMonth`; Vergleich nur bei ganzem, vergangenem Kalendermonat — sonst neutrale HintBox statt Scheindifferenz; fehlende ER → Hinweis + Link, nie stille 0.
- **Stammdaten/WES:** Artikel-/Produktstammdaten, WES-Analyse, Artikel-Tracking (Vergleich Rezept/Lieferant/Buchhaltung); Lieferantendokumente mit Vergleich.

### Kennzahlen
Konsolidierter Kennzahlen-Bericht (`KennzahlenBerichtPage`) — Referenz-Implementierung des Designsystems.

## 5. Bewusste fachliche Entscheidungen

- **Banken-/Investorenbericht endet bei EBIT (USER-ENTSCHEID):** keine „Jahresgewinn"-Zeile, EBIT nie mit Jahresgewinn gleichgesetzt, Finanzergebnis und Steuern nicht enthalten, keine Schätzungen. Zentraler Hinweis `EBIT_REPORT_NOTE` („Finanzergebnis und Steuern sind in dieser Auswertung nicht enthalten. Der Bericht endet daher bei EBIT.") erscheint identisch in UI, PDF und Excel. Fehlende Finanzwerte werden nie als 0 dargestellt.
- **Warenaufwand-Gruppen:** Direkter Warenaufwand = Konten 4000–4070, Übriger Warenaufwand = 4071–4900 (fixe fachliche Regel, Grenzen inklusiv).
- **Personalaufwand = Total Arbeitgeberkosten appweit:** Bruttolohn (inkl. anteiligem 13.) × AG-Faktor (`social-costs.ts` + `employee-rate.ts`; Libs bekommen `rates` als Pflicht-Param). Nie mit rohem `hourlyWage` rechnen.
- **FIBU-Ist (5xxx) ist BEREITS AG-Aufwand** — nie zusätzlich mit dem Sozialkosten-Faktor multiplizieren. ER-Personal-Ist = Löhne+Sozialleistungen aus `computePLForMonth`, exkl. übriger Personalaufwand.
- **Keine Doppelzählung:** Arbeitnehmerabzüge sind Bestandteil des Bruttolohns. **Quellensteuer ist kein Aufwand** — nur weiterzuleitende Verbindlichkeit (z. B. QST in der OP-Behördenauswertung).
- **Fehlend ≠ 0:** fehlende Daten als `null`/„—" ausweisen, nie als 0/CHF 0 erfinden; Basis 0 ⇒ „nicht vergleichbar"; kein NaN/Infinity. Gilt für P&L, Quoten, Banken-Bericht, OP-Total, Drilldowns und Exporte.
- **FIBU-Vergleiche** summieren immer ganze Kalendermonate — Teilperioden-Vergleiche werden bewusst nicht angezeigt.
- **Gastronovi-Produkt-CSV:** gleiche Produktnamen mit verschiedenen Preisen werden unvermeidlich summiert (keine Artikelnummer in der Quelle). **Überstunden** liegen nur monatlich vor (keine Tages-Ursachenzuordnung). **Mirus-Excel:** 1904-Datumsflag — nie mit `cellDates:true` lesen; MA-Namen ggf. manuell mappen.
- **Tote Komponenten (nicht auf AG-Kosten migriert, 0 Importer):** `KPIDashboard` (hardcoded ×1.22!), `UnifiedCostOverview`, `MonthlyOvertimeOverview`, `WeeklyOvertimeOverview`, `TimeEntriesEditor`, `PlannedLaborCostCalculator` — bei Wiederbelebung zuerst auf `rates` umstellen oder löschen.

## 6. Exporte und Konsistenz

- Alle Exporte konsumieren dieselben zentralen Datenobjekte wie die UI (Vorschau ≡ Export) — keine separate Export-Berechnungslogik, keine abweichenden Summen oder Schätzungen; Hinweise, Zwischentotale, Filter und Zeitraumbezüge identisch zur UI; fehlende Werte werden nie still zu 0.
- **Excel:** exceljs per dynamic import; Beträge als echte Zahlen; Schweizer Formate CHF `#,##0.00`, Prozent `0.0%` (Rohwert/100) bzw. `0.0"%"`. **PDF:** jsPDF/autoTable per dynamic import, `pdfSafe` für WinAnsi-Zeichen. **CSV:** Blob + BOM.
- Vorhandene Exporte: P&L-PDF/Excel, Management-Report-PDF, Mehrjahres-Excel, Banken-/Investoren-PDF+Excel (7 Blätter; Waterfall-Kosten als negative Zahl), Warenkosten-Excel, Buchhaltungs-Export-CSV + Monatsabschluss-PDF, Dienstplan-Exporte (abteilungstreu, AG-Kosten), Kampagnen-CSV, Drilldown-CSVs.

## 7. Tests und Verifikation

- Fachlogik mit fokussierten Tests absichern; kritische Summen, Abgleiche, Importregeln und Export=UI-Konsistenz brauchen Regressionstests (Grenzwerte, Idempotenz). Parser vor Verlass auf Zahlen mit ECHTER Datei validieren (synthetische Fixtures reichen nicht).
- **Vitest:** reine Logik `// @vitest-environment node`, Komponenten `// @vitest-environment happy-dom` (jsdom crasht via natives canvas). Immer mit `NODE_OPTIONS=--max-old-space-size=8192`; voller Lauf OOM-gefährdet → in Chunks.
- **Type-Check:** `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.app.json --noEmit` — das nackte `tsc --noEmit` prüft nichts (solution-style Root-tsconfig); Legacy-Fehler existieren, nur auf berührte Dateien filtern.
- **Run/Build:** `npm run dev` · `npm run build` (bei stillem OOM/Exit -1 mit 8192-MB-Heap wiederholen).
- **Review:** nach grösseren Features Architect-Review mit Git-Diff; Review difft die ganze Branch seit letztem Checkpoint — fremde/ältere Commits nicht als Teil des aktuellen Tasks behandeln oder zurückdrehen.
- **Dokumentation:** diese Datei nach jeder abgeschlossenen Änderung aktualisieren (kein Changelog, keine Task-Protokolle); Detail-Lehren in `.agents/memory/` (keine Secrets/PII, nichts aus dem Code Ableitbares).

## 8. Aktuelle Roadmap

- **Jahresgewinn-Phase im Banken-/Investorenbericht:** erst wenn Finanzaufwand/-ertrag und Steuern vollständig importiert und gemappt sind.
- **`daily_revenues`-Migration (vorbereitet, NICHT aktiv):** Tagesumsätze liegen weiter im KV-Blob (`safeUpsertDailyBudgets` schützt, hat aber Grenzen: kein Audit-Log, kein atomarer Tages-UPSERT). Script `supabase/migrations/20260507_daily_revenues.sql` liegt bereit; erst aktivieren, wenn die Blob-Lösung fachlich fertig getestet ist (verbindliche Vorgabe).
- **OP-Liste Kreditoren:** weitere Auswertungs-/Trend-Phasen auf Basis der bestehenden Designsystem-Bausteine.
