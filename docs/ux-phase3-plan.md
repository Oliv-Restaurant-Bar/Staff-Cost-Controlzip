# UX Phase 3 — Vereinheitlichungs-Plan (Stand 09.07.2026)

Ziel: App „wie aus einem Guss". Keine neuen Funktionen, kein Mechanismus-Wechsel (Route/Dialog/Sheet bleiben wie sie sind). Referenz-Muster ist die in Phase 2 verdichtete Tagesabschlüsse-Seite (Info-Tooltips statt Textabsätze, KPI-Chips + „Weitere Kennzahlen", kompakte Toolbar, Sticky-Tabellenkopf).

## Befund je Hauptmodul

| Modul | Header/Platz | KPI-Karten | Tabellen | Auffälligkeiten |
|---|---|---|---|---|
| Dashboard | sticky, kompakt | **8** (Admin; rollenabhängig, ~25 Renderstellen) | — (Karten-Grid) | eigene Inline-KpiCard mit border-l-4; Zeitraum-Navigation eigenes Muster |
| Import-Center | statisch, Datenstand-Panel gross | 4 Info-Karten | VJ-Umsatz-Tabelle | max-w-4xl; Gruppen-Karten aus Phase 2 = gutes Muster |
| Tagesabschlüsse | sticky, Tooltips | 4 Chips + Collapsible | Sticky-Kopf, kompakt | **Zielbild** — bereits Phase-2-Muster |
| Reservationsanalyse | statisch | 5–6 Kacheln (eigene KpiTile) | 2 YoY-Tabellen | Filter in eigenen Cards → Platzverbrauch |
| Produktanalyse | statisch, 1 Zeile Text | keine | Ranglisten, overflow-x | Toolbar ok (h-8), Container max-w-7xl |
| Personalbedarf | statisch, **3 Zeilen Erklärtext** | 1 Check-Karte | verschachtelte Cards | max-w-4xl (soll schmal bleiben) |
| Dienstplanung | sticky, sehr komplex | Mini-KPIs verstreut | ModernScheduleGrid | 6782 Zeilen — höchstes Risiko, nur minimal anfassen |
| CRM (Auswertung + Gästeliste) | statisch | **10 + 6** Kacheln (eigene Kpi) | Gästeliste sortierbar | grösster KPI-Overload; Gäste-Detail = eigene Route (bleibt) |
| Kennzahlen-Bericht | statisch | **4** ✓ | Excel-Ansicht XTable | bester Kandidat für Pilot |

Querschnitt:
- 6 parallele KPI-Karten-Implementierungen (StatCard, Dashboard-inline, KPIDashboard, ActualPerformanceKPI, CompactKPIWidget, staffing-status-ui).
- 3 Status-Ampel-Systeme (staffing-status-ui, adyen-ui, Import-Badges).
- 106 Dateien mit Dialogen, ~20 verschiedene Breiten; Footer-Reihenfolge und „Abbrechen"-Variante inkonsistent; Primärbuttons teils rose/violett.
- Tabellen-Stile (sticky Kopf, tabular-nums, zebra) überall manuell kopiert.
- Container-Breiten 4xl/5xl/6xl/7xl/screen-xl/1800px gemischt — teils bewusst (schmale Formularseiten).

## Phasenplan

### Phase 3.1 — Fundament + Pilot Kennzahlen-Bericht
UX-Gewinn: mittel · Risiko: **minimal** · Wiederverwendung: maximal (alles Folgende baut darauf).
- `PageShell`/`PageHeader`: sticky Kopf, Titel, Info-Tooltip statt Absätze, Aktions-Slot; Breiten-Varianten `narrow` (4xl) / `default` (7xl) / `wide` — kein Einheitszwang.
- `KpiCard` (Basis StatCard; Trend-Richtung/-Label als explizite Props, keine Kosten-Semantik erben).
- `StatusPill` (Basis staffing-status-ui; Adyen-/Import-Ampeln mappen später darauf).
- Tabellen-Klassen-Konstanten (kompakte Zellen, sticky Kopf mit OPAKEN Dark-Farben, tabular-nums, max-h ohne Seiten-Scroll) — bewusst keine schwere DataTable-Abstraktion.
- 3 Dialog-Breiten-Tokens (sm/md/lg) definieren (Anwendung ab 3.3).
- Pilot: KennzahlenBerichtPage vollständig auf die Bausteine umgestellt (hat schon 4 KPIs).
- Gate: tsc (app-tsconfig) + Seiten-Tests einzeln.

### Phase 3.2 — Leichte Seiten migrieren (ein Checkpoint pro Seite)
UX-Gewinn: **hoch** · Risiko: gering (reine Ansicht-Seiten, Logik unberührt).
Reihenfolge: Reservationsanalyse → Produktanalyse → Personalbedarf → Gäste-CRM → CRM-Auswertung (zuletzt: 10→4 KPIs = Informationsarchitektur-Änderung).
- Je Seite: PageShell/PageHeader, Toolbar einzeilig h-8, Erklärtexte → Tooltip, KPIs auf max 4 + Collapsible „Weitere Kennzahlen" (nichts löschen, nur verlagern), Tabellen auf Standard-Stil (Sticky-Kopf, Haupttabelle ohne Seiten-Scroll sichtbar).
- Import-Center-Feinschliff (Datenstand-Panel verdichten, PageHeader) hängt hier an, da risikoarm.
- Gate: Tests pro Seite; e2e-Durchlauf (Desktop+Mobile) am Phasenende.

### Phase 3.3 — Dialog-Normierung (mechanisch, modulweise)
UX-Gewinn: mittel · Risiko: gering, weil rein mechanisch und nur in migrierten Modulen.
- Breiten-Tokens anwenden, Footer-Standard (Abbrechen ghost links, Primäraktion default rechts), Farb-Sonderfälle entfernen, Zeilen-Klick-Affordanz (cursor-pointer + hover:bg-muted) vereinheitlichen.
- Mechanismen (Route vs Dialog vs Sheet) bleiben unverändert. Nicht alle 106 Dialoge auf einmal — modulweise mit den Phasen.

### Phase 3.4 — Dashboard (zwei Teilschritte)
UX-Gewinn: **sehr hoch** (meistgenutzte Seite) · Risiko: mittel (4 Rollen, Lohn-Gates).
- Vorab: Rollen-Audit der KPI-Sichten (admin/service/kueche/beaulieu — Anzahl je Rolle verschieden; kueche_manager darf NIE CHF-Beträge sehen).

#### Rollen-Audit KPI-Sichten (durchgeführt 09.07.2026, Phase 3.1 — nur Analyse, keine Änderung)
Quelle: `src/pages/Dashboard.tsx` (Inline-`KpiCard` ~Z. 122; Perioden-Selector Heute/Woche/Monat/Jahr ~Z. 203 + Referenzdatum-Navigation ~Z. 206–218; Ansicht-Filter „Alle/Umsatz/Ist vs. Budget/Ist vs. Vorjahr/Personal" ~Z. 1038) und `src/hooks/usePermissions.ts`.

| Rolle | KPI-Karten (oben) | CHF sichtbar? | Gates |
|---|---|---|---|
| admin (+ Gast: identische Sicht, read-only) | 12–18 je nach Ansicht-Filter/Stichtag: Umsatz Ist/Budget/Vorjahr, Abw. abs/%, Pro-rata, Stichtag, PK Ist/Plan, Kostenquote Ist/Plan, Abw. PK | JA (voll) | `isAdmin` + `showUmsatz`/`showPersonal`/`showJbv` |
| beaulieu_manager | ~6–10: Umsatz + PK des eigenen Mandanten | JA (Mandant) | `isBeaulieuManager` + Ansicht-Filter |
| service_manager | 3–4: nur PK Ist/Plan + Kostenquote (Abteilung Service) | Umsatz NEIN; PK-Totals JA | `showPersonal` + `canSeePersonnelCostTotals` |
| kueche_manager | 3–4: nur PK Ist/Plan + Kostenquote (Abteilung Küche) | Umsatz NEIN; PK-Totals JA | `showPersonal` + `canSeePersonnelCostTotals` |

WICHTIGE Präzisierung fürs 3.4-Umbau-Gate: `canSeePersonnelCostTotals` ist in `usePermissions.ts` (Z. 244) hart `true` für ALLE Rollen — kueche_manager sieht auf dem Dashboard heute also Abteilungs-PK-Summen in CHF (verifiziert). Das „NIE CHF"-Verbot betrifft Einzellöhne (`canSeeHourlyWages` = nur admin/beaulieu) und die Dienstplan-Tagesheader (`schedule-daily-totals`), NICHT die Dashboard-PK-Totals. Beim 8→4-Umbau (b) darf sich an dieser Sichtbarkeitsgrenze NICHTS ändern; Umsatz-Sektionen bleiben strikt `isAdmin`-gebunden (Z. 1112, 1235).
- (a) 1:1-Tausch auf shared KpiCard + PageShell, Anzahl unverändert.
- (b) 8→4 Standard-KPIs + „Weitere Kennzahlen"-Collapsible; Zustand in localStorage bzw. für Manager-Rollen default-offen. Komponententest pro Rolle.
- Gate: Tests pro Rolle + e2e.

### Phase 3.5 — Dienstplanung (bewusst zuletzt, minimal)
UX-Gewinn: mittel · Risiko: hoch → deshalb kleinster Eingriff.
- NUR Header/Toolbar-Angleich + StatusPill-Nutzung. Kein Umbau des Grids, Breite bleibt wide, keine Änderungen an Plan-/Kosten-Logik.

## Priorisierungslogik
1. Erst Bausteine (3.1), damit jede weitere Seite billiger wird (Wiederverwendung).
2. Dann viele sichtbare Seiten mit geringem Risiko (3.2) = grösster Gewinn pro Aufwand.
3. Mechanisches (3.3) nach der Struktur, sonst doppelte Arbeit.
4. Dashboard (3.4) erst mit erprobten Bausteinen + Rollen-Audit.
5. Dienstplanung (3.5) zuletzt und minimal — grösste Seite, grösstes Regressionsrisiko.

## Leitplanken
- Keine neuen Features, keine Daten-/Logikänderungen, keine Mechanismus-Wechsel.
- KPIs werden nie gelöscht, nur hinter „Weitere Kennzahlen" verlagert.
- Rollen-Gates (Lohn/PII) bei jedem KPI-/Layout-Umbau explizit prüfen.
- Jede Phase einzeln shippable; Tests einzeln pro Datei (OOM), tsc nur mit `-p tsconfig.app.json`.
- Explizit NICHT im Scope: PLView/Erfolgsrechnung, Reporting, Budget, OP-Liste (nicht Teil der 9 Module; profitieren später automatisch von den Bausteinen).
