# Backup: Dienstplan UI — Rückkehrpunkt (bestätigt)

## Status
Dieser Stand ist der **bestätigte Rückkehrpunkt**.
Der "Klassisch"-Modus zeigt exakt diese Darstellung.
Der Klassisch-Modus darf nie entfernt oder überschrieben werden.

## Git-Checkpoint
Commit: `14cc030345532544d6957d483616b467197a9e58`
Titel: "Update quick time presets and display limits in schedule planner"

## Aktuelle Darstellung (Klassisch)

### Wochenansicht
- Sticky Header mit zwei Reihen: Titel/Aktionen oben, Zeitraum-Steuerung unten
- Linke Sidebar: ShiftLegend (Schichtpalette), Abteilungsfilter, Mitarbeiterfilter
- Hauptgitter: `ScheduleGrid` — Excel-ähnlich, jede Zelle hat Früh/Spät-Unterbereiche
- KPI-Streifen oben: PKQ, Lohnkosten, Umsatz, geplante Stunden, Mitarbeiteranzahl, Warnungen
- Soll/Ist-Vergleich-Karte unterhalb des Grids

### Zeiteditor-Popover (TimeInputCell)
- Öffnet bei Klick auf eine Tageszelle
- Schnellwahl: 6 einfache Einsätze (2-spaltig) + 4 geteilte Einsätze
- 2 Einsatzzeilen (1. Einsatz / 2. Einsatz optional)
- Kompakter Uhren-Picker: Stunden links, Minuten rechts (00/15/30/45)
- Kopieren/Einfügen inkl. geteilte Einsätze

### Mitarbeiterspalte
- Name + Stundenbadge + Warndots
- Kein separates Popup (Klick öffnet keinen Info-Overlay)

### Tageskopf
- Wochentag + Datum in einer Spalte

## Betroffene Komponenten (werden NICHT gelöscht)
- `src/pages/SchedulePlanner.tsx` — Hauptseite, Datenlogik, Rendering
- `src/components/schedule-planner/ScheduleGrid.tsx` — Wochengitter (Klassisch)
- `src/components/schedule-planner/TimeInputCell.tsx` — Zeiteditor-Popover
- `src/components/schedule-planner/ShiftDropdown.tsx` — Schichtpalette
- `src/hooks/useQuickTimes.ts` — Schnellauswahl-Presets

## Toggle
`localStorage` Schlüssel: `schedule_view_mode`
Werte: `"classic"` (Standard) | `"modern"`

Oben im Dienstplan-Header ist ein Toggle sichtbar:
**[ Klassisch ] [ Modern ]**

Default ist **Klassisch** — die Modern-Ansicht wird separat gebaut
und ändert **nie** die Datenlogik, Speicherlogik oder Kostenlogik.

## Zurück zur alten Ansicht
1. Toggle oben rechts im Dienstplan-Header auf **"Klassisch"** klicken
2. Oder direkt: `localStorage.setItem('schedule_view_mode', 'classic')` im Browser
3. Seite neu laden

## Was NIE geändert werden darf (in beiden Modi gleich)
- Kostenlogik (`calculateEffectiveHours`, `calculateBreakDeduction`)
- Soll/Ist-Berechnung
- Budgetlogik / `safeUpsertDailyBudgets`
- Supabase-Schreibpfade
- Schichtdatenstruktur (`ShiftConfigItem`)
- Mirus-Import-Logik
- Bestehende Save-Logik
