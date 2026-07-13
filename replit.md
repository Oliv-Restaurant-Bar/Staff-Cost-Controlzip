# Personalkostentracker

Internes Reporting-Tool für Umsatz, Personalkosten, Dienstpläne und KPIs — mandantenfähig (Oliv, Beaulieu).

> Diese Datei ist die technische Projektdokumentation (aktueller Stand). Detail-Lehren + vollständige Historie liegen in `.agents/memory/`. Aufbau: 1) Projektübersicht · 2) Architektur · 3) Designsystem/UX · 4) Module · 5) Importsystem · 6) Finanzlogik · 7) Offene Roadmap · 8) Entwicklungsregeln · 9) Changelog.

---

## 1. Projektübersicht

### Ziel der App
Internes Reporting- und Controlling-Tool für Gastronomie-Betriebe: erfasst und wertet Umsatz, Personalkosten, Dienstpläne, Tagesabschlüsse, Reservationen/Gäste-CRM, Produkte/Warenkosten und Finanz-KPIs aus. Mandantenfähig für zwei Betriebe (Oliv, Beaulieu).

### Hauptmodule
- **Dashboard / Startseite** — Tages-Status, Warnungen, Schnellaktionen; ausführliches KPI-Dashboard.
- **Reporting / Finanzen** — Erfolgsrechnung (P&L), Budget, Vorjahresvergleiche, Tagesumsätze, OP-Liste Kreditoren.
- **Personal** — Personalstamm, Positionen/Stationen, Personalbedarf (SOLL) + SOLL/Ist-Abgleich, Dienstplanung, Überstundenkosten.
- **Produkte & Warenkosten** — Artikel-/Produktstammdaten, WES (Warenkostensatz), Produkt-Analyse, Lieferantendokumente.
- **Importe** — Import-Center, Import-Checkliste/Cockpit, Z-Bericht/Gastronovi, Reservationen (Foratable), Mirus-Arbeitszeiten, Adyen, Tagesabschlüsse.
- **Gäste-CRM & Reservationen** — Gästeliste, Auto-Segmentierung, manuelles CRM-Profil, Kundenakte, Auswertungs-Dashboard, Kampagnen (CSV), Duplikat-Merge, Reservations-Analyse.
- **Kennzahlen** — konsolidierter Kennzahlen-Bericht (Referenz-Implementierung Designsystem Phase 3).

### Grundprinzipien
- **Multi-Tenancy** über ID-Präfixe (`b-` = Beaulieu), keine dedizierte `restaurant_id`-Spalte auf `employees`/`app_settings` (Details §2).
- **Reine Logik getrennt von IO:** Analyse-/Berechnungs-Libs sind DOM-/Supabase-frei und synthetisch getestet.
- **Single Source of Truth** je Fachdomäne — keine parallelen Zweitberechnungen (Details §2, §8).
- **Sichere Schreibpfade:** Finanz-/Umsatzdaten nie per naivem Blob-Write; read→merge→write mit sichtbarem Fehler statt stillem Fallback; Tombstones statt Hard-Delete bei merge-on-save-Blobs.
- **Read-only-Aggregatoren** (Import-Cockpit, Startseite, Gruppen-Overviews) leiten Status nur ab, sie schreiben nie und erfinden keine Zeitstempel.
- **Rollen-/PII-Gating** konsequent auf Route-Guard UND Lade-Effekt; Gäste rein lesend, kein PII.
- **Personalaufwand = Total Arbeitgeberkosten** appweit (Details §6).

---

## 2. Architektur

### Frontend
- React + TypeScript + Vite, Shadcn UI, Tailwind CSS, `date-fns`, `recharts`.
- Routing zentral in `src/App.tsx`. Navigation in `src/components/AppNav.tsx` (`DASHBOARD_ITEM` + `NAV_GROUPS` [exportiert für Tests], longest-path-Highlighting). NavItem-Flag `secondary: true` = Menüpunkt liegt pro Gruppe hinter „Mehr"-Toggle (Desktop-Sidebar + Mobile-Sheet), klappt bei aktiver Route auto-auf — sekundär: Kennzahlen Bericht, Datenintegrität MA, Gäste & Reservationen, Reservations Analyse, Gäste Duplikate. `/reporting` und `/import-cockpit` haben bewusst KEINEN Nav-Eintrag (nur per URL bzw. Header-Link im Import-Center; Route+Guard bestehen). `/foratable-report` leitet dauerhaft auf `/gaeste/auswertung` um (die frühere „Foratable Report"-Seite wurde in „Gäste & Reservationen" zusammengeführt).

### Backend
- Supabase: Auth, Postgres, KV-Store (`app_settings`).
- Schema: `supabase/setup_new_project.sql`; Migrationen in `supabase/migrations/` (sequenziell im Supabase SQL-Editor ausführen; Management-API-DDL ist manuell). PII-/CRM-/Reservations-Tabellen: RLS authenticated-only + `REVOKE anon`. RLS empirisch verifizieren — Live-DB hatte schon RLS-an-ohne-Policies trotz DISABLE im Setup.
- Auth/Rollen zentral in `src/hooks/usePermissions.ts` (+ `src/contexts/AuthContext.tsx`). Rollen: admin / service_manager / kueche_manager / beaulieu_* / Gast. **`isAdmin = isAdminUser || isGuest`** — admin-only-PII-/Schreibseiten gaten `isAdmin && !isGuest` auf Route-Guard UND Lade-Effekt (Fetch feuert vor `Navigate`). Onboarding: bestehende MA vervollständigen Daten per tokenisiertem Link; Selbstregistrierung erzeugt `pending_review`-Datensätze zur Admin-Freigabe; Gäste-Links = temporäre, passwortgeschützte read-only Freigaben.

### Datenmodell
- **Multi-Tenancy:** Tenant = ID-Präfix. `employees`/`app_settings` haben **KEINE `restaurant_id`-Spalte** (Beaulieu = `id LIKE 'b-%'`, Oliv = `id NOT LIKE 'b-%'`). Reservations-/CRM-/Kreditoren-Tabellen HABEN `restaurant_id`; jeder Read/Write ist tenant-gefiltert. `product_sales` ist mandantenübergreifend (kein `restaurant_id`). Tenant-Infra: `src/contexts/TenantContext.tsx`, `src/lib/tenant-utils.ts`; KV-Keys via `tenantKey`.
- **Persistenz:** localStorage als schneller Primärspeicher + Supabase `app_settings` (KV) als persistentes Backup (`useSyncStore`). Finanz-/Budgetdaten NIE per naivem Blob-Write (s. §6/§8). Bei union-merge-Blobs: **Tombstones** (`deleted:true` + `updatedAt`) statt Hard-Delete, sonst leben gelöschte Keys aus dem Remote-KV wieder auf; alle Leser filtern `deleted`.
- **Wo Dinge liegen:** `src/pages/` (Seiten), `src/components/` (UI), `src/lib/` (Logik + DB-Layer), `src/types/` (Modelle), `src/contexts/`, `src/hooks/`, `supabase/migrations/` (SQL). Supabase-Zugriff: `src/lib/supabase-db.ts`, `supabase-kv.ts`.

### Berechnungslogiken
- Analyse-/Berechnungs-Libs (`src/lib/*-utils.ts`, `*-analytics.ts`) sind DOM-/Supabase-frei (nur `import type`) und synthetisch getestet. DB-Layer (`*-db.ts`) kapselt IO und tenant-Filter.
- Finanzlogik (Personalaufwand, Sozialkosten, FIBU) siehe §6.

### Single Source of Truth
- Je Fachdomäne genau EINE Berechnungsquelle; UI-Kacheln und Drilldown-Listen stammen aus DENSELBEN Rows.
- Beispiele: `reservation-crm.ts` (CRM-Segment/Metrik, rein besuchsbasiert), `import-cockpit.ts`/`computeSourceStatus` (Frische-/Fälligkeitsschwellen — Startseite, Import-Center, Import-Cockpit teilen sie, KEINE eigenen Schwellen), `social-costs.ts`/`employee-rate.ts` (AG-Kostenfaktor). Bewusste Ausnahmen sind dokumentiert (z. B. Rückkehrpotenzial-Faktoren `OVERDUE_INTERVAL_FACTOR=1.5` vs. `RETURN_RISK_FACTOR=2.0` koexistieren absichtlich).

### Import-Engine
- Generische Parser: `src/lib/csv-import-engine.ts`, `pdf-import-engine.ts` (`extractPdfTextLines`). Fachliche Parser bauen darauf auf (Gastronovi, Adyen, Mirus, OP-Liste, Reservationen). Details der Importtypen/Checklisten-Logik in §5.
- **Parser-Diagnose-Pflicht:** jeder Import-Parser liefert ein `debug`-Objekt + `failureReason` auf ALLEN Pfaden und legt bei Fehler die reale Datei-Struktur offen, statt blind ein geratenes Format anzunehmen. Synthetische Fixtures vor Verlass auf Zahlen mit ECHTER Datei validieren.

### Designsystem
Zentrales Phase-3-Designsystem mit gemeinsamen Bausteinen — Details in §3.

---

## 3. Designsystem / UX (Phase 3, ab Juli 2026)

### Standards
- **Designprinzip:** Desktop-first (interne Reporting-/Controlling-Nutzung), schlichtes, modernes und lesefreundliches Design; Information vor Dekoration, Zahlen dicht und schnell erfassbar.
- **Für ALLE neuen/migrierten Seiten die gemeinsamen Bausteine verwenden — keine Eigenbauten.** Neue Module (auch geplante) nutzen dieselben Bausteine.
- **Seiten-Muster:** kompakte Toolbar → Warnung nur wenn nötig (HintBox) → max. 4 KPI-Karten (KpiGrid), weitere hinter MoreKpis (KPIs nie löschen, nur verlagern) → Hauptinhalt ohne langes Scrollen (Scroll-Container mit `max-h` + Sticky-Kopf) → Details per Klick/Tooltip/Collapsible.

### Gemeinsame Komponenten
- `src/components/ui/tones.ts` — Ton-Typ `good|warn|critical|info|neutral` + Farbmaps `TONE_DOT/TEXT/PILL/BOX`.
- `status-pill.tsx` (`StatusPill`), `kpi-card.tsx` (`KpiCard` mit EXPLIZITEN trend-Props ohne Fach-Semantik + `KpiGrid` + `MoreKpis`-Collapsible mit optionalem `storageKey`).
- `info-tip.tsx` (`InfoTip` — Erklärungen als Tooltip statt Textabsatz; `TooltipProvider` app-weit in `App.tsx`), `hint-box.tsx` (`HintBox`), `page-states.tsx` (`LoadingState`/`EmptyState`).
- `table-style.ts` — Klassen-Konstanten `TABLE/TH/TH_NUM/TH_STICKY/TD/TD_NUM/ROW_CLICKABLE` (bewusst KEINE DataTable-Abstraktion).
- `dialog-size.ts` — `DIALOG_SM/MD/LG`.
- `src/components/layout/PageShell.tsx` (Breiten `narrow=4xl`/`default=7xl`/`wide=1800px` — kein Einheitszwang) + `PageHeader.tsx` (sticky, opak; icon/title/info/meta/Toolbar-children/actions).
- **Hinweis (HintBox/StatusPill):** reichen `data-testid` NICHT durch — für Tests in Wrapper-`div` mit testid setzen.

### Seitenstruktur
PageShell → PageHeader (sticky) → optionale HintBox → KpiGrid (≤4, Rest in MoreKpis) → Hauptinhalt (Tabellen im Scroll-Container mit Sticky-Kopf) → Detail per Klick/Tooltip/Collapsible.

### Farbdefinitionen
Grün = gut, Orange = Achtung, Rot = kritisch, Blau = Info, Grau = neutral (`tones.ts`).

### KPI-Regeln
Max. 4 KPI-Karten sichtbar (`KpiGrid`); weitere hinter `MoreKpis`. KPIs werden nie gelöscht, nur verlagert. Zahlen IMMER rechtsbündig + `tabular-nums`.

### Tabellenstandards
`table-style.ts`-Konstanten verwenden. Sticky-Kopf in Scroll-Container (`max-h`); Sticky-Flächen brauchen OPAKE Hintergründe (`bg-card`/`bg-muted`, keine `/40`-Alpha, sonst scheinen Zeilen durch). Zahlen `TD_NUM` (rechtsbündig, tabular-nums).

### Dialogstandards
`dialog-size.ts` (`DIALOG_SM/MD/LG`), Anwendung ab Phase 3.3.

### Referenz & Tests
- **Pilot / Referenz:** `KennzahlenBerichtPage` vollständig migriert. Phasenplan + Dashboard-Rollen-Audit: `docs/ux-phase3-plan.md`.
- Tests: `src/components/__tests__/design-system.test.tsx`, `src/pages/__tests__/KennzahlenBerichtPage.test.tsx`, `ReservationAnalysePage.test.tsx` (happy-dom).

---

## 4. Module

### Dashboard / Startseite
- **Startseite (vereinfacht, Admin):** Route „/" = `isAdmin ? StartOverview : (canAccessModule('dashboard') ? Dashboard : /personal)` — Manager/beaulieu_manager behalten das ausführliche Dashboard-Verhalten. Ausführliches Dashboard vollständig unter `/dashboard` (Nav-Item „Dashboard" in Gruppe Verkauf, adminOnly; `DASHBOARD_ITEM` heisst „Start"). Seite `src/pages/StartOverview.tsx` (3 Bereiche: Heute-Statuskarten Umsatzimport/Reservationen/Dienstplan/Tagesabschluss, Warnungen = NUR Status `action`, Schnellaktionen als Links; Gäste ohne Schreib-/PII-Aktionen). Rein `src/lib/start-overview-utils.ts` (`buildStartOverview`; Frische-Regeln 1:1 via `computeSourceStatus` aus dem Import-Cockpit — KEINE eigenen Schwellen; Dienstplan-Regel: geplant bis ≥ heute+7 = ok, < heute = action; Tagesabschluss = gestriger Tag im `adyenAbstimmung_v1`-Blob bestätigt, null = nicht eingerichtet → unknown ohne Warnung). Hook `src/hooks/useStartOverview.ts` (read-only: `fetchCockpitSignals` + Direkt-Read des Adyen-Blobs aus localStorage, NIE Save-Schicht; loading/error/ready). Tests: `start-overview-utils.test.ts` (node) + `StartOverview.test.tsx` (happy-dom).
- **„Heute wichtig"-Banner (Dashboard):** `src/components/HeuteWichtigBanner.tsx`, oben in `src/pages/Dashboard.tsx`. STRIKT read-only/additiv: nutzt `useStartOverview` (dieselbe Quelle, KEINE eigenen Frische-Regeln), zeigt NUR Status `action` + 4 Schnellaktionen (Import/Tagesabschluss/Dienstplan/Reservationen; Gäste ohne Schreib-/PII-Aktionen); nur Admin (`!isAdmin → null`). Test: `HeuteWichtigBanner.test.tsx` (happy-dom).
- **Dashboard-Inhalt:** KPIs, Umsatz, Kosten, anteilige Personalkosten (AG-basiert, s. §6).

### Import-Cockpit / Import-Checkliste
Seite „Import-Checkliste" = `/import-cockpit` (`src/pages/ImportCockpitPage.tsx`, PageShell/PageHeader). Admin-only, Gäste ausgeschlossen (`isAdmin && !isGuest` auf Route-Guard in `App.tsx` UND Lade-Effekt). OHNE Nav-Eintrag (Zugang via Header-Link im Import-Center oder direkt per URL). Nur ANZEIGE — KEINE Migration/Schreibpfade/Änderung an Importprozessen.
- **3 Tabs:** **Checkliste** [default] / **Status** [= Datenimporte-Übersicht] / **Kontrollen**. UI-Bausteine `src/components/import-cockpit/` (`cockpit-ui.tsx`/`CockpitDetailDrawer.tsx`/`DataImportsTab.tsx`/`ControlsTab.tsx`/`ImportChecklistTab.tsx`); Page orchestriert nur.
- **Deskriptoren/Schwellen** rein `src/lib/import-cockpit.ts` (`COCKPIT_SOURCES`, `INTERVAL_THRESHOLDS`, `computeSourceStatus`/`findMissingDays`/`summarizeCockpit`/`groupChecklist` + Label-/Badge-Maps). Read-only-Aggregator `src/lib/import-cockpit-db.ts` (`fetchCockpitSignals` via `Promise.allSettled`). 18 Quellen = 10 Datenimporte + 8 Kontrollen (11 prüfbar mit ableitbarem Signal, 7 reine Kontrollaufgaben `checkable:false`). Jede Quelle trägt `section` (`import`/`control`) + `tabCategory` (`CockpitTabCategory`, 13 Werte; Reihenfolge `IMPORT_/CONTROL_CATEGORY_ORDER`, Labels `TAB_CATEGORY_LABEL`) sowie `category`/`importType`/`uploadLabel`/optional `sourceHint`/`exampleFormat`/`actionLabel`; Kontrollen zusätzlich `responsible`/`importance`/`procedure` (Drawer).
- **Signale read-only aus Blobs** (nie via seedende/schreibende Store-Loader): `adyen` aus `adyenAbstimmung_v1`, Umsatzabstimmung aus `reporting_v1` (`umsatzabstimmungMonthsFromBlob`), Budget/Reporting aus `budget_v1`/`reporting_v1`. Datenlücken (`findMissingDays`) nur für tägliche `detectGaps`-Quellen (aktuell nur Tagesumsatz-KV; Mirus/Adyen periodenbasiert `detectGaps:false`), senken den Status höchstens auf gelb (Ruhetage legitim). „Import-Art" zeigt bei Datei-Uploads Dateiformat-Badges (`importFileFormats` aus `exampleFormat`-Endungen CSV/Excel/PDF).
- **Kontrollaufgabe „Buchhaltungs-Export"** (Quelle `buchhaltungs_export`) ist eine der 8 Kontrollen: harter Status-Override `buchhaltungsExportOverride` aus dem monatlichen Export-Stand (aktuell/erstellbar/offen), abgeleitet aus den abgeschlossenen Tagesabschlüssen — read-only, kein eigener Schreibpfad.
- **Datenimporte-Tab:** KPI-Kacheln (Aktuell/Bald fällig/Überfällig/Nie+Nicht prüfbar/Datenlücken) sind Toggle-Filter (`ImportKpiFilter`/`importRowMatchesKpi`), nach Bereich gruppierte Tabelle, ganze Zeile klickbar → Drawer. **Monatsübersicht** (`buildMonthOverview`/`summarizeImportYear`): Jahresauswahl + „Ganzes Jahr" + 12 Monatskarten, Monatsklick = Toggle-Filter (`importRowMatchesMonth`), UND-verknüpft mit allen Achsen. Legacy-Single-View-Layer bleibt für Rückwärtskompat/Tests, wird nicht mehr gerendert. Test `DataImportsTab.test.tsx` (happy-dom).
- **Checkliste-Tab + Engine:** siehe §5 (Importsystem).

### Tagesabschlüsse
Seite `/tagesabschluesse` (`TagesabschluessePage.tsx`, Titel „Tagesabschlüsse"; kein Redirect). Guards: BlockedRoute für beaulieu_manager, `!isAdmin → Navigate`. Gäste rein lesend. Nav-Gruppe „Umsatz" (`ClipboardCheck`). Trägt `TagesabschlussSection` + `AdyenAbgleichSection` + `BuchhaltungsExportSection` (Page bleibt dünn; Komponenten in `src/components/umsatzabstimmung/`). Split-Test `umsatz-tagesabschluss-split.test.tsx`.
- **Monatsübersicht** (analog Excel „UMSATZ Oliv") `TagesabschlussSection.tsx`/`TagesabschlussTable.tsx`: **14 Spalten in 5 Gruppen** (`TAGESABSCHLUSS_COLUMN_GROUPS`, 2-zeiliger Header mit Gruppen-Tint). Kompakte Standardansicht = 10 Spalten (`detailOnly`-Flag blendet kk/einzahlungBank/cashIst/cashDiff aus; Helper `visibleColumns(group, showAll)`, Prop `showAllColumns` default false, Toggle `ta-columns-toggle`). Gruppen: **Umsatz** (Datum, Umsatz) | **Kartenzahlungen** (KK inkl. TWINT laut Z-Bericht; KK- und KK-Adyen-Zellen sind klickbare Popover-Buttons `ta-kk-btn-DATE`/`ta-adyen-btn-DATE`: KK-Popover = alle `isKkCard`-Arten in `KK_BREAKDOWN_ORDER` MC/Visa/TWINT/Amex/PostCard/LunchCheck/Stripe, KK-Adyen-Popover = nur Adyen-Arten inkl. Overrides aus `buildDayComparison` + `ADYEN_HINWEIS` + Sektion „Nicht über Adyen"; gemeinsamer Renderer `ZahlungsartenBreakdown.tsx`, auto-Posten „Korrektur (manuell)" wenn |Total−Summe|≥0.005; unklassifizierte Zahlarten wie KD Tisch 5000 zählen nirgends; KK Adyen farbig nach Diff-Status, Diff in Klammern, Total-Zeile `ta-total-adyen-diff` mit Vorzeichen-Aufhebungs-Hinweis) | **Kasse** (Bargeld Soll = berechnet/read-only mit Formel-Tooltip, Einzahlung Bank, Kassensaldo Soll = fortlaufend/read-only [„—" solange Anfangsbestand unbekannt], Cash Ist = manuell inline, Cash Diff = Ist − Kassensaldo Soll farbig) | Gutscheine | Weitere. **UX-Verdichtung:** Erklärtexte als Info-Tooltips (`ta-page-info`/`ta-section-info`); Monats-Toolbar mit „Heute" (`ta-heute`) + „+ Tagesabschluss" (`ta-add-abschluss`); Anfangsbestand-Warnung 1-zeilig (`ta-anfangsbestand-erfassen`); KPIs = 4 Chips (`ta-kpi-confirmed/-open/-diff/-saldo-ende`) + Collapsible „Weitere Kennzahlen" (`ta-kpi-more-toggle`/`ta-kpi-more`); Legende in `<details>` (`ta-legend-toggle`); Tabelle im Scroll-Container `max-h-[70vh]` mit sticky 2-zeiligem Kopf (OPAKE Header-Farben). Test `TagesabschlussSection.test.tsx` (happy-dom).
- **Inline-Buchungswerte:** direkt in der Zeile editierbar (`InlineAmountInput`, korrigiert = gelb): KK Adyen (`ta-input-karten-DATE` = Override auf `karten`), Kassensaldo Soll (`ta-input-saldo-DATE` = Tages-Anker via `setSaldoAnker`; Blob `saldoAnker` {date:{value,updatedAt}}, re-based die Saldo-Kette ab dem Tag; Row-Felder `saldoAnker`/`saldoBerechnet`), Gutscheine VerkG/EingG (`ta-input-gutschein-verkauft/-eingeloest-DATE`), Barausgaben-Total (`ta-input-expenses-DATE` → `upsertInlineExpense`: EINE generische Ausgabe `inline-DATE`, Konto `INLINE_EXPENSE_DEFAULT_KONTO`=1001; nur solange `isInlineExpenseEditable`). Bargeld Soll bleibt read-only. CSV-Export nutzt automatisch die Ist-Werte (Effektivwert-Modell + KK-Korrektur-Zeile).
- **Import-Abgleich beim Z-Bericht-Import:** rein `detectTagesabschlussImportConflicts(closings, blob)` (Konflikt = Import-Wert ↔ korrigierter Wert, |diff|≥0.005; `dayLocked` aus `abschluesse`-Status) + `applyImportConflictResolutions` ('uebernehmen' tombstoned den Override; gesperrte Tage nie angefasst). UI `TagesabschlussImportConflictDialog.tsx` (testids `ta-conflict-*`, Default „Manuellen Wert behalten"). Wiring in `GastronoviZBerichtPage.tsx` nach Single-/Batch-Import (best-effort, Blob frisch geladen).
- **Tombstones statt Löschen (Pflicht wegen merge-on-save):** Entfernen von Overrides/Saldo-Ankern/Barausgaben/Feld-Kommentaren/Differenzgründen/Anfangsbestand setzt `deleted:true` + `updatedAt`. Alle Leser filtern `deleted`; `computeMonthFingerprint` behält Tombstones bewusst (Löschung invalidiert den Export); erneutes Setzen reaktiviert.
- **Adyen-Abgleich (täglich):** `AdyenAbgleichSection.tsx`/`AdyenDayTable.tsx`/`adyen-ui.tsx`. Parser rein `src/lib/adyen-csv-parser.ts` („Received Payment Details"-CSV: Beträge vorzeichenbehaftet summiert, /refund|chargeback/ bei positivem Betrag negiert, NUR CHF, Payout-/Settlement-CSV abgelehnt). Abgleich rein `src/lib/adyen-abstimmung.ts`: Blob `adyenAbstimmung_v1` {days, methodLabels, overrides, comments, confirmations}, Persistenz `adyen-abstimmung-db.ts` (Settings-Infra localStorage + KV-Backup, KEINE Migration); `mergeAdyenImport` ersetzt NUR importierte Tage. Z-Bericht read-only via `loadGnPaymentMethodsForMonth` (nur Tagesimporte `period_from===period_to`); `normalizeGnPaymentName` mit ZWEI Flags: `isCard` (Adyen-Vergleichsbasis) und `isKkCard` (KK-Total/Export-Karten = alle isCard PLUS PostCard/Lunch-Check/Stripe, die NICHT über Adyen laufen — dürfen nie in isCard). Overrides bidirektional (zbericht|adyen, FieldKey `date:source:methodKey`), schreiben nie in `gn_*` zurück. Diff-Ampel `ADYEN_DIFF_THRESHOLDS` (grün ≤0.05 / orange ≤5 / rot). Tagesbestätigung `canConfirmDay`: Z-Bericht vorhanden + jede nicht-grüne Differenz übersteuert ODER kommentiert + Barbestand bestätigt. Tests `adyen-csv-parser.test.ts`, `adyen-abstimmung.test.ts` (node), `AdyenDayTable.test.tsx` (happy-dom).
- **Buchhaltungs-Export-Assistent (Monats-Export):** `BuchhaltungsExportSection.tsx` (testids `bx-*`), nach der Monatsübersicht (nur wenn Blob+Adyen geladen). Reine Logik `src/lib/buchhaltungs-export.ts`: Export-Gate `buildExportChecklist` (alle Z-Tage abgeschlossen, Monat zu, Mapping ok, Adyen/Cash-Diffs begründet), Monatsprüfung (9 Totale), Soll/Haben-Buchungsvorschau `buildSollHabenVorschau` über `buildTabelle2Rows` (Vorschau ≡ CSV garantiert), Kontrollwerte `buildKontrollwerte` (nur Anzeige), Konto-Labels `kontoLabel` (Fallback benutzerdefiniert → `DEFAULT_KONTO_BEZEICHNUNGEN` → Kontonummer). Buchungsregeln = `TagesabschlussExportDialog` (je Kontonummer editierbares Label `ta-exp-bez-*`; `exportSettings.kontoBezeichnungen`). Status `deriveExportStatus` = offen|bereit|exportiert|**veraltet** (Fingerprint über Monatsdaten + `computeSettingsFingerprint` über KONTEN — Konto-Änderung ⇒ veraltet, reine Umbenennung bewusst nicht; Banner `bx-veraltet-banner`). Export-Protokoll/Versionierung `createExportRecord`/`addExportRecord` → Blob-Feld `exportProtokolle` (merge-on-save-kompatibel, keine Migration; inkl. sollTotal/habenTotal/kassensaldoEnde). CSV = Tabelle2-Export `buchhaltungs-export-YYYY-MM-vN` (Blob frisch via `loadTagesabschlussLocal`). PDF-Abschlussblatt rein `src/lib/monatsabschluss-pdf.ts` (dynamic import, jsPDF). Tests `buchhaltungs-export.test.ts`, `monatsabschluss-pdf.test.ts` (node), `BuchhaltungsExportSection.test.tsx` (happy-dom).
- **Umsatzabstimmung (getrennte Seite):** `/umsatzabstimmung` (`UmsatzAbstimmungPage.tsx`) zeigt NUR die Monatsabstimmung (`UmsatzAbstimmung`, Card „Monatsabstimmung Umsatz"). Nav-Gruppe „Umsatz" (`Scale`).

### Reservationsanalyse
- **Reservations Analyse (konsolidiert):** `src/pages/ReservationAnalysePage.tsx` (admin `/gaeste/analyse`, Nav-Gruppe Foratable; ersetzt die Nav-Einträge `/gaeste/wochentag` + `/gaeste/vorjahr`, Routen bleiben per URL). Globaler Kennzahl-Umschalter **Personen (Default)/Reservationen** steuert KPI-Kacheln, alle Tabellen, beide Detail-Popups. Filter: Jahr + Von/Bis-Monat + Status (booked Default) + Presets. 5 Tabs: **Monate** (Ist vs. Vorjahr, Zeilen-Klick → Tages-Popup), **Wochentage**, **Saison**, **Matrix** (Wochentag × Monat via `buildWeekdayMonthMatrix` — GLEICHE Daten wie Heatmap, kein zweiter Scan; Extreme via `weekdayMatrixExtremes`), **Heatmap** (Monat × Wochentag, Zell-Klick → Aufschlüsselung). Monats-Popup: 8 KPI-Kacheln (`buildMonthDetailKpis`), recharts-Balkendiagramm Mo–So Ist vs. VJ (`buildWeekdayIstVorjahrChartData`; recharts-`Tooltip` als `RechartsTooltip` aliasen), Zusammensetzung mit „Anteil Monat" (`buildMonthWeekdayComposition`), Tagesliste mit Badges (`monthDetailDayFlags`). Reine Logik `src/lib/reservation-analyse-utils.ts` (reuse `reservation-yoy-utils.ts` + `reservation-weekday-analytics.ts`); keine Migration/Schreibzugriffe. Migriert auf Designsystem (PageShell/PageHeader, KpiGrid 4 KpiCards, table-style-Konstanten, InfoTip). Tests `reservation-analyse-utils.test.ts`, `ReservationAnalysePage.test.tsx` (happy-dom; vitest braucht `NODE_OPTIONS=--max-old-space-size=8192`).
- **Abgelöste Reservations-Seiten (nav-versteckt, nur per URL):** `ReservationWochentagPage.tsx` (`/gaeste/wochentag`, rein `reservation-weekday-analytics.ts` — 3 Modi Zeitraum/Schulferien/Saisonvergleich, Saison-Defs in KV via `season-definitions-db.ts`), `ReservationVorjahrPage.tsx` (`/gaeste/vorjahr`, rein `reservation-yoy-utils.ts`). Die frühere **Foratable Report**-Seite (`ForatableReportPage.tsx`) wurde entfernt und in „Gäste & Reservationen" (`/gaeste/auswertung`, s. §Module) zusammengeführt; `/foratable-report` leitet dauerhaft dorthin um.

### Produktanalyse
- **Produkt-Analyse (Rangliste + Drill-down):** `src/pages/ProduktAnalyse.tsx` → `ProduktDetail.tsx`, rein `src/lib/product-analytics.ts`. Perioden Tag/Woche/Monat/Jahr (ISO-Wochen mit 52/53-Rollover), Filter URL-gespiegelt (refresh-/back-fest). `product_sales` hat keine `restaurant_id` — nur boundary-treue reine Funktionen, keine Schema-Änderung.
- **Stammdaten/WES:** `src/pages/Artikel.tsx`, `ProduktStamm.tsx`, `WesAnalyse.tsx`, `ArtikelTracking.tsx` + Stores in `src/lib/`. Food/Beverage-Artikel, WES (Warenkostensatz) je Produkt, Vergleich Rezept/Lieferant/Buchhaltung. **Quote-Regel:** die Warenkostenquote (%) basiert IMMER nur auf den relevanten Warenkosten (Food + Beverage); «Diverses/Sonstiges» ist ausgeschlossen (auch in der WesAnalyse-Übersichtstabelle bei Lief./Buch.-%), während CHF-Beträge den vollen Aufwand inkl. Diverses zeigen (Fussnote erklärt die Basis).
- **Warenkostenquote (Single Source of Truth):** rein `src/lib/warenkosten-quote.ts` — `kategorieFromKonto` (OPERATIVES Mapping 4000/4030→Food, 4020→Beverage, Rest→Sonstiges; BEWUSST anders als FIBU-Kontenplan, nie quer-mappen), `computeWarenkostenTotals`, `warenkostenQuote` (relevant/Umsatz, `null` bei fehlendem/0-Umsatz — NIE 0), `buildErVergleich`. `waren-db.ts` re-exportiert den Typ. ALLE Quoten (Warenrechnungen-KPI/Forecast/Monat, Export) laufen hierüber — keine Zweitformel. Tests `warenkosten-quote.test.ts` (node).
- **Warenkosten-Excel-Export:** rein `src/lib/warenkosten-export.ts` (`buildWarenkostenExport` reine Aufbereitung + `warenkostenExportFileName` `Warenkosten_<Monat>_<Jahr>.xlsx` bzw. ISO-Range bei Mehrmonatszeitraum) + dünner exceljs-IO-Wrapper `exportWarenkostenToExcel` (eingefrorener Kopf, Autofilter, Schweizer `numFmt` CHF `#,##0.00`/Prozent `0.0"%"`, Detailzeilen + Summenblock mit relevant/Sonstiges/Total/Quote). Kategorisierung/Quote AUSSCHLIESSLICH aus `warenkosten-quote`. Button in Warenrechnungen (Analyse) gated per `canExport`. Tests `warenkosten-export.test.ts` (node, nur reine Funktionen).
- **Warenkosten vs. Erfolgsrechnung (FIBU-Abgleich):** Karte in `Warenrechnungen.tsx` (Analyse). `erVergleich`-Memo summiert die FIBU-Seite über `loadMonth`→`computePLForMonth` (`cogs_food`/`cogs_bev`/`cogs_other`/`net_revenue` — dieselbe Quelle wie Reporting/PLView, KEINE Nachfaktorisierung, read-only) und vergleicht via `buildErVergleich` (Diff CHF + Prozentpunkte + Ampel `ER_VERGLEICH_THRESHOLDS`). Beide Quoten teilen die FIBU-Umsatzbasis. **Wichtig:** die FIBU-Seite summiert IMMER ganze Kalendermonate → die Karte zeigt Ampel/Tabelle/Umsatzbasis NUR bei `monthAligned` (Zeitraum = 1. bis Monatsende, komplett vergangen); bei Woche/laufendem (Teil-)Monat/YTD neutrale HintBox statt Scheindifferenz. Fehlt die ER (`!hasEr`) → Info-HintBox + Link „/reporting" (nie stille 0). Calc-Pfad als `InfoTip`-Tooltip erklärt.
- **Lieferantendokumente:** `src/pages/SupplierDocuments.tsx`, `SupplierComparison.tsx` + `src/lib/supplier-documents-store.ts`.

### Personalstamm
- **Personalstamm:** `src/pages/Personalstamm.tsx` (admin + eingeschränkt `kueche_manager`). Lohn-Gating: Löhne unter `canSeeHourlyWages`/`canEditWages`; vertrauliche Flächen (Persönliche Daten inkl. AHV/IBAN, Verträge, Duplikat-Warnung, pending_review) unter `canManageAllEmployees = isAdmin || isBeaulieuManager`. `kueche_manager` sieht NIE Löhne/PII, bearbeitet nur Küchen-Stammdaten (Abteilung auf Küche gesperrt). Qualifikationen editierbar (Cross-Training). **Nur das Personalstamm-Formular schreibt `employees` nach Supabase** — Auto-Sync/SchedulePlanner/Seed schreiben NICHT (sonst Dubletten).
- **Positionen/Stationen:** `src/pages/Positionen.tsx` (admin), rein `src/lib/position-utils.ts`, `positions-db.ts`, `src/hooks/usePositions.ts`, Migration `20260625_positions.sql` (+ `employees.primary_station`/`secondary_stations`). Stabile **Keys (Slugs)**, nie Anzeigenamen, in `employee.primaryStation`/`secondaryStations` → Umbenennen bricht Zuordnungen nicht. Hierarchie Abteilung → Bereich → Position; `applyDefaultPositions` deaktiviert (löscht nicht) übrige Positionen.

### Dienstplanung
- **Dienstplan:** `src/pages/SchedulePlanner.tsx`, `src/components/schedule-planner/*`, `src/lib/pattern-warnings.ts` (Muster-Warnungen: aufeinanderfolgende Tage, kurze Ruhezeiten). Manager-Sichtbarkeit zentral über `src/lib/employee-visibility.ts` (`getVisibleEmployeesForRole`; eingeschränkte Rolle GEWINNT; RAW-`employees` nur für Import-Match/CRUD/localStorage). Küchen-Manager-Tagesheader lohn-sicher (`src/lib/schedule-daily-totals.ts` — kein CHF-Betrag erreicht das DOM). Export abteilungstreu (`src/lib/schedule-export-department.ts`). Schicht-Farbe/Legende `ShiftLegend.tsx`. Externe Kostenpersonen (`aush_*`-IDs) leben in `schedule_extra_cost_people`, NICHT in `employees`.
- **Personal FIX + VARIABEL (`/personal-fix`, `src/pages/PersonalFix.tsx`):** Seiten-Layout (reine Präsentation, keine Fach-/Rechenänderung) top-down: A) kompakter Sticky-Header · B) Zusammenfassung „Total Personal FIX + VARIABEL Ist" (`pfix-total-summary`: 4 DS-`KpiCard` in `KpiGrid` [Total Ist/Total Budget/„Abweichung Ist − Budget"/PKQ Ist], die alten 8 Kacheln in `MoreKpis storageKey="pfix-more-kpis"`; „Abweichung Ist − Budget" nutzt DASSELBE `budgetVsIst`-Memo wie Block A — keine Parallelrechnung) · C) Flex-Kosten pro Mitarbeiter (`pfix-flex-per-employee`) · D) Überstundenkosten (einklappbar, default zu) · E) Monatsansicht inkl. Gesamt-Total (einklappbar) · F) Budget-Auswertung (einklappbar; inneres Frame zu flush `-m-4`-`div`, „Wochenansicht"-Toggle + „Szenario aktiv"-Badge bleiben) · G) Einheitliche Flex-Auswertung. Lokaler Helper `CollapsibleSection` (Radix, `CollapsibleContent` unmountet bei Zu → Tests müssen Trigger `${testid}-trigger` erst klicken); Abweichungs-Modus default `week`, Toggle-Reihenfolge Woche/Tag/Monat/Jahr.
  - **Drei „Flex Ist"-Grössen — eine Quelle (SSoT):** die Seite zeigt bewusst drei unterschiedlich weit gefasste „Flex Ist"-Werte, die sich NUR im Umfang unterscheiden und aus denselben Bausteinen abgeleitet werden (rein `src/lib/personal-fix-reconciliation.ts`, `computeFlexScopes` — DOM-/Supabase-frei, nur Primitive; node-Tests `personal-fix-reconciliation.test.ts`): (1) **Flex Arbeit Ist** = nur variable-MA-Arbeitskosten (Stunden × Lohn; Section-G „Flex-Auswertung"-Chip/Tabelle + `monthIst`), (2) **Flex Ist inkl. Zusatzkosten** = +Zusatzkosten Fixlohn-MA (`zusatzIstCHF`; Footer der Tabelle „Flex Kosten pro Mitarbeiter" + KPI `pfix.active.istWork`), (3) **Total Flex Ist inkl. Ferien** = +Ferienabbau (`pfix.active.istTotalVar`). Der historisch verwirrende CHF-Unterschied A−B war exakt `zusatzIstCHF` (Fixlohn-MA-Zusatzkosten), NICHT ein Rechenfehler. Sichtbare Abstimmung `pfix-flex-reconciliation` (Section G, gated `proRataDay===null && (zusatzDelta>0.005 || ferienDelta>0.005)`; testids `pfix-recon-arbeit/-zusatz/-mitzusatz/-ferien/-total`) macht die Kette Arbeit → +Zusatz → +Ferien transparent. Labels/Tooltips überall distinkt („Flex Arbeit Plan/Ist", „(inkl. Zusatzk.)", „(inkl. Ferien)").
  - **PKQ Ist Tooltip** (`pfix-pkq-sub`): erklärt PKQ = Total Personal Ist ÷ Nettoumsatz mit ECHTER Umsatzquelle/Periode (kein Hardcode; `buildPkqBreakdown`).
  - **„Personalcontrolling" (`pfix-personalcontrolling`, gated `proRataDay===null`):** ZWEI kompakte, nebeneinanderliegende `ControllingBlock`-Blöcke (je 2 Zeilen CHF + Quote, farbige Differenz), read-only. **BEWUSST unterschiedliche Ton-Semantik pro Block** — Kern der Umstrukturierung. **Block A `pfix-pc-budget-ist` „Budget vs. Ist"** = App-Budget (`pfix.active.planTotal`) ↔ App-Ist (`pfix.active.istTotal`), Quoten `pkqPlan`/`pkqIst` (beide auf `effectiveRevenue` → Prozentpunkte vergleichbar). **RICHTUNGSABHÄNGIGER Ton** (betriebswirtschaftlich): Ist<Budget = grün „CHF X unter Budget", Ist>Budget = rot „CHF X über Budget", = neutral „Im Budget" (Pill = `budgetDeltaText`). Zentrale Differenz `diffCHF = Ist − Budget` aus `buildBudgetVsIst({budgetCHF,istCHF,budgetPct,istPct})` (rein `personal-fix-reconciliation.ts`) — DIESELBE Quelle wie die KPI-Karte „Abweichung Ist − Budget", KEINE Parallelrechnung. **Block B `pfix-pc-app-er` „App vs. Erfolgsrechnung"** = App-Ist ↔ FIBU 5xxx-Ist (`plPersonnelActual` = „Löhne (Total)" + „Sozialleistungen" via `computePLForMonth`; FIBU-Wert enthält bereits AG-Aufwand, wird NIE mit Sozialkosten multipliziert), Nenner = `effectiveRevenue`. **BETRAGSBASIERTER Ton** (technische Kontrolle, Magnitude) via `buildErfolgsrechnungVergleich` — Status-Pill `ER_STATUS_LABEL` (im Rahmen/beobachten/prüfen) bleibt erhalten, Footer = `appVsErText` („App CHF X höher/tiefer als ER" bzw. „App und ER stimmen überein"). app-Ist ist AG-basiert (inkl. Sozial) → apples-to-apples mit `total_personnel`. Fehlt die Erfolgsrechnung → `pfix-pc-app-er-missing` + Import-Link `pfix-er-import-link` (für Gäste ausgeblendet), NIE 0. **„Plan" → „Budget"** appweit für planTotal-basierte Labels (KpiGrid + MoreKpis). Die frühere Planung↔ER-Budget-Zeile (`buildErfolgsVergleichPaar`/`erVergleichPlan` + `budgetByRow`-Overrides) ist in der UI ENTFALLEN (Lib-Funktion bleibt für Tests). Tests: `personal-fix-reconciliation.test.ts` (node) decken `buildBudgetVsIst`/`budgetDeltaText`/`appVsErText` ab.
  - **Personalcontrolling-Drilldown (Ursachenanalyse):** KPI-Karten (Total Ist/Budget/Abweichung/PKQ Ist) und beide ControllingBlocks sind klickbar → `ControllingDrilldownDialog` (`src/components/personal-fix/ControllingDrilldownDialog.tsx`, testids `pfix-dd-*`) mit Fokus `ist|budget|abweichung|quote|er`. Reine Logik `src/lib/personal-controlling-drilldown.ts` (`buildDrilldown`: Gruppierung Tage/Positionen/Mitarbeitende, Periode Tag/Woche/Monat [nur Tages-Gruppierung], Ursachen-Ableitung `ueberstunden|ferien|krankheit|unfall|zusatzkosten|fehlende_stempelung|ungeplant|mehr_stunden|weniger_stunden` mit Tönen + Haupttreiber-Satz). Daten via gated `drilldownInput`-Memo in `PersonalFix.tsx` — dieselben Loader wie pfix/FlexBreakdownModal (`loadDailyPlan/Ist-`, `loadZusatzPlan/Ist-Details`, `supabaseActualHours`, `monthlyRevenues`), **KEINE neuen DB-Abfragen**; Brücken-Footer zeigt SSOT-Werte aus `pfix.active` (nie neu gerechnet, Abstimm-Warnung bei |Σ−FlexIst|≥1). Überstunden liegen nur monatlich vor → Hinweiszeile statt Tages-Ursache (`overtimeDayKeys:[]`). Sortier-/Such-Tabelle (table-style, sticky Kopf), CSV-Export (Blob + BOM), ER-Fokus = Monats-Brücke App↔FIBU (`erVergleich`). Absenz-Codes: FE=Ferien, K=Krank, U=Unfall. **Detailstufe (2. Ebene):** Klick (oder Enter/Space — Zeilen fokussierbar, aria-Labels) auf Tag-/Positions-/Mitarbeitendenzeilen öffnet eine interne Detailansicht im selben Dialog (`pfix-dd-detail*`): Zurück-Button, Escape schliesst nur die Detailstufe; Such-/Sortier-/Gruppier-Zustand der Übersicht bleibt erhalten. Zeigt Tages-/Schichtdetail mit Plan/Ist (Stunden, CHF, Zeiten, Pause — fehlende Zeiten „—", nie geschätzt), Ursachen pro Schicht (SSOT-`collectCauses` + Flags `zeiten_abweichend|kosten_ohne_stunden|stunden_ohne_kosten`), Kontextkennzahlen (Umsatz/Besetzung) NUR aus bereits geladenen Daten, Abstimmung gegen die angeklickte Übersichtszeile (`reconcileDetail`, Abweichung sichtbar, nie still) und gefilterten CSV-Export der sichtbaren Schichtzeilen (`buildShiftCsv`, BOM). Reine Detailfunktionen in derselben Lib; Schichtzeiten liefert PersonalFix read-only (`shiftTimes` aus schedule-v2-Blob + `supabaseActualHours`) — KEINE neuen DB-Abfragen/Tabellen/Migrationen. Tests `personal-controlling-drilldown.test.ts` (node, 46) + `ControllingDrilldownDialog.test.tsx` (happy-dom, 14).
- **Überstundenkosten Festangestellte** (Teil obiger Seite) + rein `src/lib/overtime-analysis.ts`. Monatslogik: `overtime = max(0, produktive Ist − Monatssoll)`, Soll = `42h × (Tage/7) × Pensum`. Nur Festangestellte (`vollzeit|teilzeit` UND `monthlySalary>0`); Absenzen (`absenceType`) zählen nie als produktiv; Pro-MA-Deaktivierung möglich.

### Personalbedarf
- **Personalbedarf (SOLL-Besetzung):** `src/pages/Personalbedarf.tsx` (admin), rein `src/lib/staffing-requirements-utils.ts`, `-db.ts`, `src/hooks/useStaffingRequirements.ts`, Migration `20260625_staffing_requirements.sql`. Pro (Saison × Wochentag) je Position ≥1 Schicht; vollständig getrennt von der Dienstplanung (kein FK). Erweiterbar über neue `scope_type`-Werte + `meta` jsonb OHNE künftige Migration. Orphan-Schutz: Schichten inaktiver Positionen bleiben beim Speichern erhalten.
- **Personalbedarf-Abgleich (SOLL/Ist, nur ANZEIGE):** rein `src/lib/staffing-comparison-utils.ts` + `StaffingComparisonPanel.tsx`/`DayStaffingBadge.tsx`/`StaffingScheduleCheckCard.tsx`; geteilte Bausteine in `staffing-status-ui.tsx`. **2-Farben-Warnung** (`ComparisonStatus` = `optimal`|`overstaffed`|`understaffed`): exakt = optimal/grün, JEDE Abweichung (auch ±1) = rot; Richtung nur über Label + Differenztext (`formatStaffingDiffPersons`, U+2212-Minus). KPI-Kacheln `summarizeStaffingKpis` (inkl. Überstunden-Potenzial = Σ fehlende Personen × Schichtdauer). Matching NUR über Hauptposition; rollen-scoped (`departments`-Filter, kein Cross-Department-Leak). Ändert KEINE Plan-/Kosten-/Overtime-Daten, keine neue Tabelle. **Nachfrage-Kontext (Reservationen):** rein `src/lib/staffing-demand-context.ts` (`buildDayDemandContext`: Tages-Personen/Res. + Ø der letzten `LOOKBACK_OCCURRENCES=8` Vorkommen desselben Wochentags inkl. 0-Tage, `pctDiff` null bei Ø=0, `kind` expected/past) + Hook `useDayDemandContext.ts` (EIN `fetchReservationsInRange`, PII sofort auf `{date,partySize,status}` projiziert) + `StaffingDemandContext.tsx` (Gating `isAdmin && !isGuest` intern; sichtbarer Fehlerhinweis statt stiller 0). Eingebaut in Panel/CheckCard (Voll) + DayStaffingBadge-Popover (`compact`, Fetch erst beim Öffnen). Tests `staffing-demand-context.test.ts` (node) + `StaffingDemandContext.test.tsx` (happy-dom).
- **Planungsempfehlungen (regelbasiert, read-only + lokale Simulation):** einklappbare Sektion in `/personal-fix` (`src/components/personal-fix/PlanungsempfehlungenSection.tsx`, testids `reco-*`), vor MoreKpis. Reine Logik `src/lib/staffing-recommendations.ts` (`buildStaffingRecommendations` + `applySimulation`): erklärbare Empfehlungen (Unterbesetzung/Überbesetzung/Schichtzeit/Kosten/Datenqualität) je Wochentag×Position aus abgeschlossenen Tagen — Faktenzellen via `buildFactCells(drilldownInput)` (DIESELBE SSOT wie der Controlling-Drilldown, KEINE Parallelrechnung), SOLL aus weekly-Requirements (Saison wählbar, Coverage via `slotOverlapsShift`), optional Tagesumsatz + Reservations-Personen (lazy Fetch nur bei geöffneter Sektion, PII sofort auf `{date,partySize,status}` projiziert → `personsPerDay`). **Mindestens 3 Vergleichstage** pro Gruppe, sonst übersprungen (`skippedGroups` sichtbar); fehlende Daten → `null` + `limitations`, NIE 0/geschätzt. UI: max. 6 Karten + „Alle anzeigen", Typ-Filter-Chips, Detail-Dialog (DIALOG_LG, Vergleichstage-Tabelle + Einschränkungen), Simulations-Dialog (DIALOG_MD, ±Personen/±Stunden/Zeiten, StatusPill „Simulation – noch nicht übernommen", rein lokal — KEIN Schreibpfad, „Im Dienstplan öffnen" → `/personal`). Berechnung nur bei offener Sektion (drilldownInput-Gate `!drilldownFocus && !planungOpen`). Tests `staffing-recommendations.test.ts` (node, 38) + `PlanungsempfehlungenSection.test.tsx` (happy-dom, 14).

### Gäste-CRM
- **CRM-Liste + Kern:** `src/pages/GaesteCrmPage.tsx`, rein `src/lib/reservation-crm.ts` (Single Source für Segment/Metrik — rein besuchsbasiert, `reservation_records` hat keine Geldspalte), `reservation-crm-db.ts` (read-only, tenant-isoliert). Manuelle CRM-Badges/Filter über `guest-list-filters.ts`. Optionale read-only View `guest_statistics` (`20260622_*`) spiegelt die TS-Semantik.
- **Manuelles CRM-Profil:** Tabelle `guest_crm_profiles` (`20260622_*`; kein `restaurant_id`, Tenant über Eltern-Gast), rein `guest-crm-profile.ts`, `-db.ts` (verifiziert Tenant vor Read/Write, wirft bei Schreibfehler). Strikt getrennt von berechnetem Segment/Score/Kampagnen.
- **Smart-Segmente:** rein `src/lib/guest-smart-segments.ts` (7 Live-Segmente, Mehrfachzugehörigkeit, strikt additiv, keine neue Query/Migration).
- **Detailseite (Kundenakte):** `src/pages/GaesteDetailPage.tsx` (admin `/gaeste/:guestId`), rein `reservation-guest-profile.ts`. Tabs Übersicht/CRM/Aktivität; gewichteter CRM-Score 0–100. Fetched-State am Anfang von `load()` UND im `catch` zurücksetzen (Cross-Guest-PII).
- **Gäste & Reservationen (zusammengeführt):** `src/pages/CrmAuswertungPage.tsx` (admin `/gaeste/auswertung`, Nav-Label „Gäste & Reservationen"/Kurz „Auswertung"; vereint die frühere „CRM Auswertung" + „Foratable Report", `/foratable-report` → Redirect). Admin-only `isAdmin && !isGuest` auf Route-Guard UND beiden Lade-Effekten; read-only, keine Schema-/Schreibpfade. Zwei Datendomänen: CRM (`loadCrm` 1×/Mandant, rein `reservation-dashboard.ts`) + Foratable-Zeitraum (`runReport` bei Range-Wechsel). Aufbau oben→unten: (A) PageShell/PageHeader (Drucken/PDF/Zum Import) · (B) `FutureReservationsOverview` — 4 klickbare KpiCards + `MoreKpis storageKey="ftr-more-kpis"`, MetricToggle Personen[Default]/Reservationen · (C) Zeitraum-Picker (Aktueller Monat / Nächste 7/14/30 Tage / Individuell) · (D) einklappbare Kalenderübersicht (default zu; Tag-Klick → PII-Tagesdialog `DayReservationsDialog`, `onSelectGuest`=goToGuest) · (E) seiteneigener Tages-/Totals-Dialog (`filterReservationDetails`) · (F) CRM-Tabs Überblick/Rückkehrpotenzial/Kampagnen (Kachel-Zählung + Drilldown aus DENSELBEN Rows) · (G) klassischer Report in Collapsible (Drucken/PDF/Zeitfenster erhalten). View-State open-redirect-sicher in URL (`crm-auswertung-url.ts` → {tab, rangeKind:FutureRangeKind, rangeFrom, rangeTo, campaign}). Zukunfts-/Kalenderwerte **wertegleich zur CRM-Auswertung** — KEINE zweite Zukunftslogik: rein `src/lib/foratable-future.ts` (`buildFutureOverview`/`buildDayDetail`/`futureQuickRange`/`levelTone`/`WEEKDAY_LABEL_*`) auf Basis `reservation-dashboard.ts` (`countInRange`/`aggregateReservationsByDay`/`addIsoDays`/`isActiveStatus`) + `classifyHeatmapLevel` (`reservation-analyse-utils.ts`). Übersicht+Kalender klemmen auf `[max(today,from),to]`, rein vergangener Teilbereich → HintBox. **Popups zeigen Aggregate bzw. admin-gated PII, nie PII an Gäste.** DB-Loader `foratable-future-db.ts` (`loadFutureReservationRows`, deckt `[today, max(to, today+29)]`). UI-Bausteine `src/components/foratable/FutureReservationsSection.tsx` (exportiert `FutureReservationsOverview`/`FutureCalendarSection`/`DayReservationsDialog`), `src/components/crm/ReservationDetailList.tsx` (Flags `showResNr`/`showTyp`/`hideDate`). Tests `crm-auswertung-url.test.ts`, `foratable-future.test.ts`, `reservation-dashboard.test.ts` (node), `FutureReservationsSection.test.tsx`, `gaeste-guest-session-gate.test.tsx` (happy-dom).
- **Kampagnen:** rein `src/lib/reservation-campaigns.ts` (18 Listen; manuelle CRM-Kampagnen lesen nur `m.crm`, nie das berechnete Segment). CSV UTF-8 mit BOM, `;`-getrennt, CRLF, dt. Header.
- **Rückkehrpotenzial:** rein in `reservation-dashboard.ts` (`OVERDUE_INTERVAL_FACTOR=1.5`) + Gästeliste-Metrik (`RETURN_RISK_FACTOR=2.0`, `reservation-crm.ts`) — koexistieren bewusst.
- **Duplikate:** `src/pages/GaesteDuplikatePage.tsx` (admin `/gaeste/duplikate`), rein `guest-duplicates.ts`, `-db.ts`. Merge ohne DB-Transaktion: Preflight (Cross-Tenant-Abort) → Reservationen zuerst umhängen (FK SET NULL) → CRM-Merge → Aggregate NEU berechnen (nie summieren) → Postcondition-Check → Duplikate löschen → PII-freies Audit (`20260623_guest_merge_log.sql`).
- **Segment-Aktionen (intern):** `SegmentActionBar.tsx`, rein `crm-activities.ts`, `-db.ts`, Migration `20260624_crm_activities.sql` (manuell ausführen). `verifyGuestsBelongToTenant` vor JEDEM Write; keine E-Mails/externen Integrationen.

### Reporting
- **Erfolgsrechnung / P&L:** `src/pages/PLView.tsx`, `src/lib/pl-engine.ts`, `src/types/pl.ts`, `src/lib/reporting-store.ts`, `src/types/reporting.ts`. Vorjahres-Diagnose-Banner (nur Sichtbarkeit, keine Berechnung): rein `src/lib/pl-prior-year-diagnostics.ts`. Reporting-Monate nur via `safeUpsertReportingMonth`/`safeDeleteReportingMonth` (naives kvSet löscht andere Monate).
- **Mehrjahresanalyse (Banken-/Investorensicht):** 4. Modus „Mehrjahre" in PLView (`ViewMode 'multi_year'`, Jahr-Select ausgeblendet). Rein `src/lib/multi-year-analysis.ts` (`buildMultiYearAnalysis`: Monatsmatrix mit Δ Vorjahr/Basisjahr, Rang, Jahresanteil, Personal-/WES-Quote; Totale mit **Common-Month-Vergleich bei Teiljahren**; KPIs CAGR/Wachstum/Trend; Executive Summary + `limitations`; CAGR nur über volle 12-Daten-Monats-Jahre). UI `src/components/reporting/MultiYearAnalysisSection.tsx` (testids `mya-*`; Toolbar 2–10-Jahres-Auswahl, KpiGrid 4 + MoreKpis, HintBox Datenbasis inkl. Prop `dataSourceHints`, Tabelle sticky-Kopf + Monatsklick → DIALOG_LG-Detaildialog, recharts Linie/Balken/Waterfall, Jahres-Karten). Exporte teilen DASSELBE `MultiYearAnalysis`-Objekt (Vorschau ≡ Export): Management-Report-PDF rein `src/lib/management-report-pdf.ts` (jsPDF/autoTable dynamic import; `pdfSafe` ersetzt U+2212/NBSP für WinAnsi) + 5-Blatt-Excel `src/lib/multi-year-excel.ts` (exceljs dynamic import, CHF `#,##0.00`/Prozent `0.0"%"`; Übersicht/Monatsvergleich/Jahresanalyse/Wachstum/Rohdaten). **Datenbasis = ROH `loadYear`→`computePLForMonth`** (bewusst OHNE Tagesansicht-Override/Maison/Exclude — als `dataSourceHints`-Hinweis in der UI deklariert, Werte können von Monats-/Jahresansicht abweichen). Keine Änderung bestehender Berechnungen, keine Migrationen. Tests: `multi-year-analysis.test.ts`, `management-report-pdf.test.ts`, `multi-year-excel.test.ts` (node) + `MultiYearAnalysisSection.test.tsx` (happy-dom).
- **Budget:** `src/pages/Budget.tsx`, `src/lib/budget-store.ts`, `src/types/budget.ts`. 2026-Seed automatisch beim ersten Laden ohne `plLineItems`.
- **Tagesumsätze:** KV-Blob `dailyBudgets` / `beaulieu:dailyBudgets`; Schreiben NUR via `safeUpsertDailyBudgets` (read → merge → write, sichtbarer Fehler statt stillem Fallback). Roadmap Normalisierung → `daily_revenues` (§7).
- **OP-Liste Kreditoren (Phase 1):** `/op-liste` (`src/pages/OpListe.tsx`, admin-only via BlockedRoute + `!isAdmin → Navigate`, Guard auch VOR Lade-Effekt; Gäste read-only ohne Import-Button; Nav-Gruppe Umsatz nach Tagesabschlüsse). PDF-Import (Sage-OP-Liste) im Dialog `OpImportDialog.tsx` mit Vorschau (KPIs/Top10/Warnungen) VOR dem Speichern; Parser rein `src/lib/op-liste-parser.ts` (X-Positions-Kalibrierung aus Kopfzeile für Alters-Buckets, Beträge nur mit 2 Nachkommastellen, debug+failureReason; synthetisches Fixture — vor Verlass auf Zahlen mit echter OP-PDF validieren). **Gesamtsaldo nach Priorität** (nach der Zeilen-Schleife entschieden, sonst überschreibt die letzte negative Gutschriften-Zeile den Netto-Saldo): 1) „Gesamt Saldo von N Posten" 2) „Total der Währung CHF" 3) schlichtes „Gesamtsaldo"; Subtotale „von N Rechnungen/Gutschriften" (`RE_GESAMT_SUBTOTAL`) gewinnen NIE. `RE_TOTAL_WAEHRUNG` VOR `RE_TOTAL` prüfen. `parseSwissAmount` entfernt „CHF" (global) vor dem Parsen; `extractAmountsFromText`/`AMOUNT_TEXT_RE` = Freitext-Fallback für verklebte Fusszeilen; `extractPostenCount` füllt `totals.itemCount` ohne „Anzahl Posten"-Zeile. **`totals.openAmount` bleibt `null`, wenn kein echtes Total erkannt wird — NIE still 0.00** (itemsSum-Fallback erst im DB-Layer `total_open_amount ?? itemsSum`); Abweichungswarnung nur bei erkanntem Total, separate Warnung wenn keins gefunden. Dialog-Gate `canConfirm` = parsed + snapshotDate + itemCount>0 + `!tableMissing` + (`recognizedTotal!==null` ODER Override-Checkbox `op-override-total`); „nicht erkannt"-Hinweis mit Override, `tableMissing` sperrt hart; Ersetzen-Fluss übergibt `replaceImportId`. Vergleich/Behörden rein `op-liste-compare.ts` (`normalizeSupplierName`, `compareSnapshots` mit Status neu/erledigt/gestiegen/gesunken/unverändert, `buildAuthoritySummary` MWST/QST/AHV/BVG). DB `op-liste-db.ts` + Migration `20260708_creditor_op.sql` (`creditor_op_imports`/`creditor_op_items`, RLS authenticated-only + REVOKE anon, partieller Unique-Index auf `(restaurant_id, snapshot_date)` WHERE status='active'); gleicher Stichtag nie still überschrieben — Lifecycle processing→active/replaced (+Rollback-Kompensation). Typen `src/types/op-liste.ts`. Tests `op-liste-parser.test.ts`, `op-liste-compare.test.ts` (node) + `OpListe.test.tsx`, `OpImportDialog.test.tsx` (happy-dom).

### Kennzahlen
- **Kennzahlen-Bericht:** `KennzahlenBerichtPage` — konsolidierter Kennzahlen-Bericht, vollständig auf Designsystem Phase 3 migriert (Referenz-Implementierung, s. §3). Nav sekundär „Kennzahlen Bericht". Tests `KennzahlenBerichtPage.test.tsx` (happy-dom).

---

## 5. Importsystem

### Importtypen
Engine rein `src/lib/import-tasks-engine.ts` — 9 Typen (`TASK_TYPE_DEFS`):
- **Tages-/zeitraumbasiert:** zbericht, reservationen, umsatz, verkaufsdaten, mirus, marketing.
- **Monatlich:** erfolgsrechnung, istkosten.
- **Jährlich:** budget.

Weitere fachliche Import-Einstiege: CSV/PDF generisch (`csv-import-engine.ts`, `pdf-import-engine.ts`, `CSVImport.tsx`); Gastronovi Produkt-CSV (`SalesUpload.tsx` + `gastronovi-csv-parser.ts` → `product_sales`; `matchAnzahlUmsatz` summiert je (Produkt, Datum) zu EINEM Record — gleiche Namen/verschiedene Preise werden unvermeidlich summiert); Reservations-Import (`ReservationenImportPage.tsx`, `reservation-import-parser.ts`, `-db.ts`, Migration `20260621_reservations.sql`; idempotent via UNIQUE `(restaurant_id, external_reservation_id)`; Gast-Match Telefon → E-Mail, nie Name; Name-only de-dupliziert über `(restaurant_id, match_key)`); Gästeexport-Import/CRM-Anreicherung (`GaesteImportPage.tsx`, `foratable-guest-import(-parser).ts`, `-db.ts`; füllt NUR leere manuelle CRM-Felder, überschreibt nie; Match E-Mail → Telefon → Name). Foratable-Sammelseite `ForatableImportPage.tsx` (`?tab=reservationen|gaeste|verlauf`; Alt-Routen redirecten).

### Frequenzen
Täglich / wöchentlich / monatlich / jährlich (`INTERVAL_THRESHOLDS` in `import-cockpit.ts`). Erwarteter Zeitraum IMMER auf `min(Monatsende, gestern)` gedeckelt (Tag X ist ab X+1 importierbar). Laufender Monat/Jahr bei monthly/yearly = neutral „läuft noch" (keine falsche Fälligkeit). Datenlücken nur für tägliche `detectGaps`-Quellen; Ruhetage bleiben legitim (kein Auto-Erledigen, InfoTip-Hinweis).

### Checklisten-Logik
- **Aufgaben-Erzeugung:** `buildImportTasks(year, month, coverage, today)` erzeugt pro Monat Aufgaben mit stabilen IDs (`type:day` / `type:from:to` / `type:YYYY-MM` / `type:YYYY` / `type:error`). Coverage-Fehler → sichtbare error-Aufgabe, NIE still. `buildImportTarget` → Ziel-Route + Prefill-Query (zbericht→/gastronovi-import?from&to&scope, umsatz→/import?target=tagesumsatz, mirus/marketing→/import?target=…, erfolgsrechnung/istkosten→/reporting?target&year&month, budget→/budget?year, reservationen→/foratable-import, verkaufsdaten→/sales-upload).
- **Coverage read-only** `src/lib/import-tasks-db.ts` (`fetchMonthCoverage` via `Promise.allSettled`; zbericht=gn_imports-Perioden, reservationen=reservation_records, umsatz=`dailyBudgets`-KV mit actualRevenue>0, verkaufsdaten=product_sales, mirus=timesheet_import_history→Monats-Voll-Coverage + actual_hours, marketing=Maison-KV, erfolgsrechnung/istkosten/budget=localStorage/KV-Blobs read-only — KEINE Store-Loader). KEINE neue Tabelle/Migration.
- **Intelligenter Arbeitsmodus** (Priorisierung/Fälligkeit) rein `src/lib/import-tasks-priority.ts`: `getTaskDueInfo` (daily ==heute→„Heute erledigen", <heute→„N Tag(e) überfällig"; range: ältester fehlender Tag bestimmt Urgenz, Label „N Tage offen"; monthly laufend→later [Pill „Monat läuft noch", kein Label], vorbei→„Monatsimport noch offen"; yearly→„Budget noch offen"; Urgenz NIE aus `notYetDue`), `prioritizeTasks` (Fehler → überfällig älteste zuerst → heute → später), `getTodayTasks`, `computeMonthProgress` (Prozent-Nenner = NUR fällige Aufgaben, `laterOpen` separat; `closure` not_started/partial/almost[≥80 %]/complete — complete nur wenn alle done UND Monat vorbei), `summarizeTypeCompletion`, `monthKey`, `CLOSURE_LABEL/TONE`.
- **Monats-Fortschritt für Monatsauswahl:** `fetchCoverageForMonths` (Worker-Pool Parallelität 3, `Record<yyyy-MM, MonthCoverage|null>`, null = sichtbarer Lade-Fehler) + Hook `src/hooks/useImportMonthProgress.ts` (Cache map/seed/loadYear/invalidate; `seed` übernimmt die frisch geladene Auswahl-Monats-Coverage ohne Zweit-Fetch; `loadYear` lädt nur beim Öffnen des Pickers fehlende Monate ≤ aktueller Monat [Zukunft nie gefetcht]; inFlight-Set gegen Doppel-Fetches; Fehl-Monate für Retry freigegeben; Generation-Counter verwirft veraltete Antworten nach invalidate/Tenant-Wechsel; allowed-Gate).
- **UI** `src/components/import-cockpit/ImportChecklistTab.tsx` (Phase-3-Bausteine): Monats-Toolbar prev/next/Heute, „Erledigte anzeigen"-Toggle (Collapsible pro Gruppe), Frequenz-Gruppen, Fortschrittskarte `checklist-progress-card` (Progress-Bar, `checklist-progress-label`, Closure-Pill `checklist-closure-pill`, Typ-Zusammenfassung `checklist-type-summary`, Meldungen `checklist-complete-message`/`-closure-hint`/`-due-done-message` in Wrapper-divs), „Heute zu erledigen"-Card `checklist-today-card` nur im aktuellen Monat (`checklist-today-empty`), MonthPicker-Popover (Trigger `checklist-month-label`; `checklist-month-picker`, `-picker-prev/next-year`, `-month-option-yyyy-MM` mit Dot+% / „Noch nicht begonnen" / „Fehler" / Spinner), Due-Labels additiv neben der „Offen"-Pill (warn=überfällig, info=heute). **Konflikt-Dialog** `checklist-conflict-dialog` bei „Ganzer Monat" über schon abgedeckten Zeitraum (Behalten/Ersetzen/Abbrechen — „Ersetzen" NAVIGIERT nur, schreibt hier nie).
- **Prefill advisory (nie harte Einschränkung):** rein `src/lib/import-prefill.ts` (`parseImportPrefill` validiert from/to/scope/target/year/month, `prefillRangeLabel`) + `src/components/ImportTaskPrefillHint.tsx` (HintBox), eingebaut in GastronoviZBerichtPage, ForatableImportPage, SalesUpload, ImportHub, Reporting, Budget.
- **Import-Center:** `/import` = `src/pages/ImportHub.tsx`, rein `src/lib/import-center.ts` (+ `-db.ts`). Launcher-Modell; Sichtbarkeit spiegelt echte Route-Guards (admin 9 / beaulieu_manager 3 / beaulieu_viewer 1 / Gast 0); nie Zeitstempel erfinden. **Importarten-Gruppen** rein `src/lib/import-groups.ts` (`IMPORT_GROUPS` = 4 Gruppen Umsatz/Z-Bericht · Reservationen · Arbeitszeiten/AZB · Tagesabschluss/Kennzahlen; `buildImportGroupOverviews` nutzt `computeSourceStatus` — KEINE eigenen Schwellen; Gruppen-Status = worst-of) + UI `ImportGroupCards.tsx` (read-only via `fetchCockpitSignals`). Inline-`Section`s default ZU; Header-Ghost-Link „Alle Quellen & Kontrollen" → `/import-cockpit`.
- **Import-Historie:** Tabelle `import_runs` (`20260623_import_runs.sql`), rein `import-runs.ts` + `-db.ts`. `logImportRun` best-effort/wirft nie, additiv, keine PII, `finished_at` = DB `now()`.

### Teilimport-Logik
`missingRanges` in der Engine: teilweise importierte Zeiträume erzeugen Restaufgaben nur für die Lücken (nicht den ganzen Zeitraum erneut). Bulk-Upserts vor `.upsert()` nach dem `onConflict`-Key deduplizieren (sonst „ON CONFLICT DO UPDATE cannot affect row a second time").

### Monatsabschluss-Logik
- **Import-seitig:** `computeMonthProgress` liefert `closure` (not_started/partial/almost/complete); complete nur wenn alle fälligen Aufgaben erledigt UND Monat vorbei.
- **Buchhaltungs-seitig:** Tagesabschluss-Monatsabschluss + Buchhaltungs-Export (Gate/Fingerprint/Versionierung) — siehe Modul „Tagesabschlüsse" (§4).

---

## 6. Finanzlogik (gilt appweit)

**Personalaufwand = Total Arbeitgeberkosten** (AG-Umbau, Juli 2026): ALLE Kostenanzeigen/-exporte rechnen mit effektivem AG-Aufwand, NIE mit rohem `hourlyWage`.

### Bruttolohn
Vereinbarter Lohn des Arbeitnehmers: Stundenlohn `hourlyWage` bzw. Monatslohn `monthlySalary`, jeweils inkl. anteiligem 13. Monatslohn (`monthlySalaryWith13th ?? monthlySalary`). Der Bruttolohn enthält bereits die Arbeitnehmerabzüge — diese werden vom Brutto abgezogen, nicht darüber hinaus als Aufwand addiert.

### Arbeitgeber-Sozialkosten
Zusätzlicher Arbeitgeberanteil obendrauf. Kern `src/lib/social-costs.ts`: `SocialCostRates` + `socialCostFactorFromRates`, `SOCIAL_COST_RATE_FIELDS` (u. a. BVG AG-Anteil), `splitEmployerCost(gross, rates)`. Alle Sätze sind AG-seitig.

### Total Arbeitgeberkosten
`src/lib/employee-rate.ts`: `getEmployerCostRate`/`getEffectiveHourlyRate` = Brutto inkl. anteil. 13. × AG-Faktor; `getWageLabel`. Festangestellte: `(monthlySalaryWith13th ?? monthlySalary) × Faktor` (Dashboard `agMonthly`, MobileDayView pro Kalendertag, DayDetailDialog pro Stunde ÷182h — beides AG-basiert). Hooks `useSocialCostRates` + `useEmployerRateMap` (`{rateById, rates}`, bevorzugt in Komponenten). Libs bekommen `rates` als PFLICHT-Param (pdf-export, comprehensive-report, schedule-export-import, schedule-print-export, correctionSuggestions) → tsc erzwingt Call-Sites. FIBU-Begriffe: `EMPLOYER_COST_LABELS(_SHORT)`/`EMPLOYER_COST_INFO`/`EmployerCostInfoTip`.

### FIBU-Ist
`pkIst` aus FIBU-5xxx-Konten ist BEREITS der effektive Arbeitgeberaufwand gemäss Buchhaltung → **NIE zusätzlich mit dem Sozialkosten-Faktor multiplizieren** (Kommentar bei `pkIst` in `Reporting.tsx` hält das fest). `dailyBudgets.plannedLaborCost`/`actualLaborCost` = Legacy-0-Felder (nicht mehr befüllt). Default-Import-Wage 25.00 in schedule-export-import bleibt bewusst roher Lohn (Import-Vorschlag, kein Kostenausweis).

### Budget
`budget-store.ts` / `Budget.tsx`; 2026-Seed automatisch beim ersten Laden ohne `plLineItems`. Budgetwerte folgen derselben AG-Kostenlogik.

### Erfolgsrechnung
`pl-engine.ts` / `PLView.tsx`; Ist-Personalaufwand kommt aus FIBU-Ist (bereits AG-Aufwand, nicht nochmals faktorisieren).

### Zentrale Sozialkostensätze
Ein zentraler Satz-Store (`social-costs.ts`, Settings-Card/KV). CH-Defaults synchron ab erstem Render — nie null. Änderung wirkt appweit über `useEmployerRateMap`.

### Keine Doppelzählung von Arbeitnehmerabzügen
Arbeitnehmerabzüge (AHV/ALV/NBU/Quellensteuer etc.) sind Bestandteil des Bruttolohns und werden davon abgezogen. Sie werden NIE zusätzlich als Aufwand erfasst.

### Quellensteuer ist kein Aufwand
Quellensteuer wird dem Arbeitnehmer vom Lohn abgezogen und weitergeleitet — sie erhöht den Personalaufwand NICHT. Sie erscheint nur als weiterzuleitende Verbindlichkeit (z. B. QST in der OP-Listen-Behördenauswertung), nie als AG-Kostenposition.

### Tote Komponenten (nicht migriert)
0 Importer; bei Wiederbelebung zuerst auf `rates` umstellen oder löschen: `KPIDashboard` (hardcoded ×1.22!), `UnifiedCostOverview`, `MonthlyOvertimeOverview`, `WeeklyOvertimeOverview`, `TimeEntriesEditor`, `PlannedLaborCostCalculator`.

---

## 7. Offene Roadmap (nur zukünftige Themen)

### daily_revenues Migration (vorbereitet, noch nicht aktiv)
**Problem:** Tagesumsätze liegen als grosser KV-Blob (`dailyBudgets` / `beaulieu:dailyBudgets`). `safeUpsertDailyBudgets` (read→merge→write) schützt vor Datenverlust, hat aber strukturelle Grenzen (kein Audit-Log, kein atomarer UPSERT pro Tag, Merge-Konflikte bei Parallelzugriff).
**Ziel:** normalisierte Tabelle `daily_revenues` (PK `(restaurant_id, date)`; Spalten actual/planned_revenue, actual_food/beverage, actual_labor_cost, previous_year_revenue, created/updated_at, updated_by) — ein Datensatz pro Tag, kein Blob/Merge. Script vorbereitet: `supabase/migrations/20260507_daily_revenues.sql`.
**Schritte:** 1) SQL-Migration ausführen (KV-Tage vorher/nachher zählen, Abweichung 0). 2) Einmalige Datenmigration KV → Tabelle (Validierung count ≥ Blob-Tage). 3) Neue Schicht `src/lib/daily-revenues-db.ts` (`upsertDailyRevenue`/`getDailyRevenues`/`getDailyRevenueMonth`). 4) Lese-/Schreibpfade umstellen (aktuell via `safeUpsertDailyBudgets`: GastronoviImportSection, TagesansichtPage, TagesControllingPage, Dashboard, useVj2025Import, usePersonnelData, SchedulePlanner). 5) Audit-Log (`updated_by`/`updated_at`, optional Trigger-Tabelle). 6) Fallback entfernen (`safeUpsertDailyBudgets` read-only, `dailyBudgets` aus `SYNC_KEYS`, localStorage-Cleanup). 7) Integrationstests (`daily-revenues-integration.test.ts`) — Tagesansicht/Dashboard/Tages-Controlling/P&L zeigen für jeden Testtag identische Werte.
**Status:** nur Schritt 0 erledigt (Script vorbereitet); alle weiteren Schritte offen. **Erst aktivieren, wenn die aktuelle Blob-Lösung fachlich fertig getestet ist — bis dahin keine Migration ausführen** (verbindliche Vorgabe, s. §8).

### OP-Liste Kreditoren (Ausbau)
Phase 1 (Import/Vergleich/Behörden) ist live (§4). Geplant: weitere Phasen (Auswertungen, Trendverläufe) — nutzen dieselben Designsystem-Bausteine (§3).

### Erfolgsrechnung & Budget (Ausbau)
Weiterer Ausbau von P&L und Budget (tiefere Vorjahresvergleiche, feinere Gliederung) auf Basis der bestehenden Engines.

### Weitere geplante Module
Neue Flächen verwenden die gemeinsamen Bausteine (§3) und die zentrale Finanz-/Import-Logik — nichts Eigenes erfinden.

---

## 8. Entwicklungsregeln

### Run & Operate
- **Run:** `npm run dev` · **Build:** `npm run build` · **Tests:** `npx vitest run`
- **Env Vars:** Supabase URL + Anon Key (`src/integrations/supabase/client.ts`)
- **Große Builds:** bei OOM (Exit -1 ohne Output) mit `NODE_OPTIONS=--max-old-space-size=8192 npx vite build` erneut ausführen.

### Type-Check
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.app.json --noEmit`. Das nackte `npx tsc --noEmit` prüft NICHTS (Root-tsconfig ist solution-style mit `files: []`). tsc kann still OOM-sterben (Exit -1) → wiederholen. Legacy-Fehler existieren; nur auf berührte Dateien filtern.

### Tests
- **Reine Logik:** `// @vitest-environment node` in Zeile 1 (sonst jsdom/libuuid-Crash). **React-Komponenten:** `// @vitest-environment happy-dom` (jsdom lädt natives `canvas` → libuuid-DLOPEN-Crash; Alias/vi.mock greifen dort nicht).
- Vitest immer mit `NODE_OPTIONS=--max-old-space-size=8192` (4096 wird still ge-OOM-killt). Voller `vitest run` OOM-gefährdet → in Chunks laufen; `singleFork` killt Isolation (false failures) → isoliert re-verifizieren.
- Parser gegen synthetische Fixtures gebaut → vor Verlass auf Zahlen mit ECHTER Datei validieren.

### Architect-Review
Nach größeren Features Architect-Review (code_review skill) mit `includeGitDiff:true`. Review difft die ganze Branch seit letztem Checkpoint — fremde/ältere Commits nicht zurückdrehen.

### Wiederverwendung bestehender Komponenten
Für alle neuen/migrierten Seiten die Designsystem-Bausteine (§3) verwenden — keine Eigenbauten, keine doppelten UI-Komponenten.

### Keine parallelen Berechnungen
Je Fachdomäne EINE Berechnungsquelle (§2 Single Source of Truth). UI-Kacheln und Drilldown aus DENSELBEN Rows. Bewusste Ausnahmen dokumentieren.

### Verbindliche Datenintegrität (User preference)
- **Umsatzdaten dürfen niemals per localStorage-Overwrite oder naivem Blob-Write gespeichert werden.**
- Jeder Schreibpfad für `dailyBudgets` / `beaulieu:dailyBudgets` muss `safeUpsertDailyBudgets()` verwenden (liest immer zuerst den Supabase-KV-Stand, mergt, schreibt zurück).
- Bei KV-Schreibfehler erscheint eine sichtbare Fehlermeldung — kein stilles Fallback auf localStorage.
- `daily_revenues` (§7) erst aktivieren, wenn die aktuelle Lösung fachlich fertig getestet ist.

### Guardrails (Kernregeln; Detail-Lehren + Historie in `.agents/memory/`)
- Nie `restaurant_id` zu `employeeToDb`/`employees` hinzufügen — Tenant = ID-Präfix.
- Nur das Personalstamm-Formular schreibt `employees` nach Supabase; Auto-Sync/SchedulePlanner/Seed schreiben NICHT. Import-Match muss die VOLLE Mitarbeiterliste sehen (sonst Dubletten).
- Reporting-Monate nur via `safeUpsertReportingMonth`/`safeDeleteReportingMonth`.
- Rollen-Gates nie „verbreitern" — ein weiter gefasstes Gate leakt alle mit-gegateten Flächen; stattdessen ein engeres Alt-Gate anlegen.
- Bulk-Upserts vor `.upsert()` nach dem `onConflict`-Key deduplizieren.
- Detail-`/:id`-Seiten: Fetched-State am Anfang von `load()` UND im `catch` zurücksetzen (Cross-Guest-PII).
- Positions-/Staffing-Zuordnungen speichern **Keys**, nie Anzeigenamen.
- Overtime/Analytics: Absenz-Einträge (`absenceType`) sind nicht produktiv.
- Merge-on-save-Blobs: Tombstones statt Hard-Delete (§2 Persistenz).
- Admin-Gates: `isAdmin && !isGuest` auf Route-Guard UND Lade-Effekt.
- Mirus/Excel: 1904-Datumsflag nie mit `cellDates:true` lesen (Datumsverschiebung); MA-Namen ggf. manuell mappen.

### Dokumentationspflicht
Nach jeder abgeschlossenen Änderung diese Datei aktualisieren (aktueller Stand). Historie/Meilensteine kompakt in §9; Detail-Lehren in `.agents/memory/` (keine Secrets/PII, keine aus dem Code ableitbaren Details).

### Referenzen
Supabase https://supabase.com/docs · React https://react.dev/ · Tailwind https://tailwindcss.com/docs · Shadcn UI https://ui.shadcn.com/docs

---

## 9. Changelog (Meilensteine, komprimiert)

- **Multi-Tenancy & Persistenz-Fundament:** ID-Präfix-Mandanten (`b-` = Beaulieu), localStorage-Primär + KV-Backup (`useSyncStore`), `safeUpsert*`-Schreibpfade gegen Blob-Datenverlust.
- **Gäste-CRM & Reservationen:** Foratable-Import (idempotent), besuchsbasiertes CRM (Single Source), manuelles CRM-Profil, Smart-Segmente, Kundenakte, CRM-Auswertung, Kampagnen (CSV), Duplikat-Merge, Reservations-Analyse (konsolidiert).
- **Personal (AG-Umbau, Juli 2026):** Personalaufwand = Total Arbeitgeberkosten appweit; zentrale Sozialkostensätze; FIBU-Ist nicht faktorisieren (§6).
- **Tagesabschlüsse:** Monatsübersicht (Excel-analog), Adyen-Abgleich (täglich), Inline-Buchungswerte, Import-Abgleich, Tombstones, Buchhaltungs-Export-Assistent (Gate/Fingerprint/Versionierung, PDF).
- **OP-Liste Kreditoren Phase 1:** Sage-PDF-Import mit Vorschau, Snapshot-Vergleich, Behördenauswertung, Lifecycle-DB.
- **Designsystem Phase 3 (ab Juli 2026):** gemeinsame Bausteine (tones/StatusPill/KpiCard/InfoTip/HintBox/PageShell/PageHeader/table-style); Pilot KennzahlenBerichtPage; Phase 3.2 ReservationAnalysePage migriert.
- **Import UX Phase 2 → Import-Checkliste (Juli 2026):** Import-Center-Gruppen, read-only Import-Cockpit (3 Tabs), Startseite/„Heute wichtig"-Banner; Checkliste-Tab mit Engine (`import-tasks-engine`), Prefill-Advisory, intelligentem Arbeitsmodus (Priorisierung/Fälligkeit/Monatsfortschritt, `import-tasks-priority` + `useImportMonthProgress`).
