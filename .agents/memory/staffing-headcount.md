---
name: Personalbedarf Kopfzahl-Modell
description: Führende Kennzahl im Personalbedarf ist die KOPFZAHL (Personen/Tag), nicht Einsätze/Blöcke.
---

**Regel:** Personalbedarf zeigt überall (Wochenmatrix «Personal total», Tages-Badge, Kacheln, Balkendiagramm) die KOPFZAHL: eine Person zählt 1× pro Tag. Automatik = max(Mittag, Abend) — durchgehende Person mit 2 Blöcken = 1. Explizites Soll via `meta.dayHeadcount` auf den staffing_requirements-Zeilen der Position/des Tages (Editor-Feld «Personen am Tag», leer = Automatik). Schichtblöcke beschreiben nur WANN (Stunden/M-A), werden nie zur Personenzahl summiert.

**Präzedenz UG-Zuschlag:** `meta.ugSurcharge`-Personen werden IMMER addiert, auch auf eine explizite Kopfzahl (`explicit + ugExtra`) — ein Basis-Profilwert darf den operativen Zuschlag nicht unterdrücken.

**Why:** Blocksummen zählten durchgehende Personen doppelt; User-Auftrag Juli 2026.
**How to apply:** Neue Ansichten/Reports auf Personen-Ebene müssen `WeekCell.headcount` (staffing-week-utils) nutzen, nie mittag+abend. Stunden-Analytik (bedarf-stunden-utils) bleibt block-basiert.

**Zeitformat-Falle:** staffing_requirements.shift_start/end sind text; Alt-/Fremd-Schreiber können 'HH:MM:SS' liefern → isValidTime schlägt fehl, Stunden werden NaN («–»). Leser normalisiert (rowToRequirement), aber neue Schreibpfade müssen 'HH:MM' schreiben.

## Live-Hinweis Dienstplan (Plan vs. Bedarf)
- Kopfzahl-SSOT ist `computeWeekCell` (staffing-week-utils) — Wochenmatrix UND Dienstplan-Hinweis (`staffing-day-hints.ts`) nutzen sie; nie separat rechnen.
- Personen-Total des Hinweises MUSS in der Soll-Einheit (Σ Positions-Kopfzahlen) laufen: Person auf 2 Positionen zählt 2×, sonst falsche Unterbesetzungs-Pille trotz grüner Positionszeilen. Unzugeordnete Personen nur als Hinweis, Stunden dagegen über ALLE produktiven Einsätze (Kosten).

## Wochen-Abgleich (Personalbedarf-Seite)
- `buildWeekCompare` (staffing-week-compare.ts) ist die einzige Quelle der Wochen-Vergleiche (Kacheln, Matrix «Bedarf vs. Planung», Stunden-Tabelle) — intern nur computeDayPlanHints pro Datum.
- Plan-Kopfzahl = Σ Positions-Kopfzahlen (Person auf 2 Positionen zählt 2×, gleiche Einheit wie Soll); Regressionstest mit Splitschicht über 2 Positionen existiert.
- Plan-/Ist-Stunden sind `null`, nie 0, wenn nichts geplant/importiert ist.
- Farbkonvention Kopfzahl-Matrix: grün = passt, ROT = über Bedarf, GELB = unter (abweichend von der 2-Farben-Logik des Einzeltag-Abgleichs).
- Mitarbeiter-Zweitpositionen heißen `secondaryStations` (nicht trainedStations).
