# UX Phase 3 — Vereinheitlichungs-Plan (Stand 09.07.2026)

Ziel: App „wie aus einem Guss". Keine neuen Funktionen, kein Mechanismus-Wechsel (Route/Dialog/Sheet bleiben wie sie sind). Referenz-Muster ist die in Phase 2 verdichtete Tagesabschlüsse-Seite (Info-Tooltips statt Textabsätze, KPI-Chips + „Weitere Kennzahlen", kompakte Toolbar, Sticky-Tabellenkopf).

## Audit-Befund (Kurzfassung)

1. **Vertikaler Platz:** Erklärtext-Absätze (Personalbedarf 3 Zeilen, ImportHub-Datenstand, CrmAuswertung); Header teils sticky (Dashboard, Tagesabschlüsse, Dienstplan), teils statisch; Container-Wildwuchs (max-w-4xl/5xl/6xl/7xl/screen-xl/1800px), space-y-4/5/6 gemischt.
2. **Zu viele KPI-Karten:** Dashboard 8 (Admin-Sicht, rollenabhängig, ~25 KpiCard-Renderstellen), CrmAuswertung 10+6, ReservationAnalyse 5–6. Kennzahlen-Bericht = 4 (Zielbild).
3. **Doppelte Darstellungen:** keine harten Tabellen-Duplikate; aber 6 parallele KPI-Karten-Implementierungen (StatCard, Dashboard-inline, KPIDashboard, ActualPerformanceKPI, CompactKPIWidget, staffing-status-ui) und überall kopierte Tabellen-Stile (sticky header, tabular-nums, zebra).
4. **Dialoge/Drawer:** 106 Dateien mit DialogContent, ~20 verschiedene Breiten; Footer-Reihenfolge und „Abbrechen"-Variante (outline vs ghost) inkonsistent; Primärbuttons teils rose/violett statt Standard.
5. **Vereinheitlichbar:** PageShell/PageHeader, KpiCard, StatusPill (3 Ampel-Systeme: staffing-status-ui, adyen-ui, Import-Badges), Tabellen-Klassen-Konstanten, Dialog-Breiten-Tokens.

## Phasenplan

### Phase 3.1 — Fundament + Pilot (geringstes Risiko, höchste Wiederverwendung)
- Neue geteilte Bausteine, KEINE Verhaltensänderung:
  - `PageShell`/`PageHeader`: sticky Kopf, Titel, Info-Tooltip statt Absätze, Aktions-Slot; Breiten-Varianten `narrow` (4xl), `default` (7xl/screen-xl), `wide` — KEIN Einheitszwang auf 7xl.
  - `KpiCard` (Basis StatCard, Trend-Richtung/-Label als explizite Props — keine Kosten-Semantik erben).
  - `StatusPill` (Basis staffing-status-ui; Adyen-/Import-Ampeln mappen später darauf).
  - Tabellen-Klassen-Konstanten (kompakte Zellen, sticky Kopf mit OPAKEN Dark-Farben, tabular-nums, max-h) — bewusst KEINE schwere DataTable-Abstraktion.
  - 3 Dialog-Breiten-Tokens (sm/md/lg) definieren (Anwendung erst ab 3.3).
- Pilot: KennzahlenBerichtPage (hat schon 4 KPIs) komplett auf die Bausteine umgestellt.
- Gate: tsc (app-tsconfig), betroffene Tests einzeln.

### Phase 3.2 — Leichte Seiten migrieren (ein Checkpoint pro Seite)
Reihenfolge: ReservationAnalyse → ProduktAnalyse → Personalbedarf → GaesteCrm → CrmAuswertung (zuletzt, weil 10→4 KPIs eine Informationsarchitektur-Änderung ist).
- Je Seite: PageShell/Header, Toolbar einzeilig h-8, Erklärtexte → Tooltip, KPIs auf max 4 + Collapsible „Weitere Kennzahlen" (nichts löschen, nur verlagern).
- Gate: Tests der Seite + visueller Check; e2e-Durchlauf am Phasenende.

### Phase 3.3 — Dialog-Normierung (mechanisch, modulweise)
- Breiten-Tokens anwenden, Footer-Standard (Abbrechen ghost links, Primäraktion default rechts), Farb-Sonderfälle (rose/violett) entfernen, Zeilen-Klick-Affordanz (cursor-pointer + hover:bg-muted) vereinheitlichen.
- NUR in bereits migrierten Modulen, modulweise — nicht alle 106 Dialoge auf einmal. Mechanismen (Route vs Dialog vs Sheet) bleiben.

### Phase 3.4 — Dashboard (zwei Teilschritte)
- Vorab: Rollen-Audit der KPI-Sichten (admin/service/kueche/beaulieu — Anzahl unterscheidet sich je Rolle; Lohn-Gate kueche_manager darf NIE CHF sehen).
- (a) 1:1-Tausch auf shared KpiCard + PageShell, Anzahl unverändert.
- (b) 8→4 Standard-KPIs + „Weitere Kennzahlen"-Collapsible; Aufklapp-Zustand in localStorage merken bzw. für Manager-Rollen default-offen (kein gefühlter Funktionsverlust). Happy-dom-Test pro Rolle.
- Danach: ImportHub (Datenstand-Panel verdichten, PageHeader).

### Phase 3.5 — Dienstplanung (höchstes Risiko, bewusst zuletzt und minimal)
- NUR Header/Toolbar-Angleich + StatusPill-Nutzung. Kein Umbau des Grids (6782 Zeilen), Breite bleibt wide.

## Leitplanken
- Keine neuen Features, keine Daten-/Logikänderungen, keine Mechanismus-Wechsel.
- KPIs werden nie gelöscht, nur hinter „Weitere Kennzahlen" verlagert.
- Rollen-Gates (Lohn/PII) bei jedem KPI-/Layout-Umbau explizit prüfen.
- Jede Phase einzeln shippable; Tests einzeln pro Datei (OOM), tsc nur mit `-p tsconfig.app.json`.
