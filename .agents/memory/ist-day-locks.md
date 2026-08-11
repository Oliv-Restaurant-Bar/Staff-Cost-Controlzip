---
name: Ist-Tagessperren (Dienstplan)
description: Sperr-Modell für Ist-Stunden-Tage; jeder actual_hours-Schreibpfad braucht einen Lock-Guard, Commits müssen Locks strikt frisch laden.
---

# Ist-Tagessperren

Tages-Granularität, KV-Key `ist_day_locks:{tenant}:{YYYY-MM}` in app_settings; API in `ist-day-locks.ts` (strict/best-effort/multi-Monat). UI: Schloss je Tag/KW/Alle im ActualHoursGrid, nur mit `canEditEmployees`.

**Regeln:**
- **Jeder** Schreibpfad auf Ist-Stunden braucht einen Lock-Guard. Aktuelle Konsumenten: MIRUS-Reconcile (Engine `lockedDates`-Param + Commit-Recheck), OpenHoursSection, StundenimportPage, ImportHub-Legacy-MIRUS, ArbeitszeitblaetterPage, SchedulePlanner (manuell, Plan→Ist, Bulk, Lösch-Angebot), EmbeddedSchedulePlanner. **Neuer Konsument = neue Lücke.**
- Import-Guards lesen STRIKT (Lesefehler = Abbruch, nichts geschrieben) — nie «Fehler = keine Sperren».
- Commits müssen Locks UNMITTELBAR vor den Writes frisch laden (Vorschau-Fenster kann offen stehen) und Writes filtern; Meldung «gesperrt — nicht überschrieben», kein Fehler.
- Replace-Modi müssen bestehende Einträge gesperrter Tage im lokalen Monatsblob behalten (sonst lokaler Wipe trotz intaktem Supabase).
- Kein CAS im KV: Lock-Toggles im Tab per Promise-Kette serialisieren; bei Save-Fehler Remote frisch laden statt blind zurückrollen. Cross-Tab/-User-Lost-Update = bekannte Grenze (Import-Guards lesen ohnehin frisch remote).

**Why:** Import darf manuell korrigierte/abgeschlossene Tage nie überschreiben; ein einziger ungeschützter Pfad hebelt das ganze Feature aus (Architect-Review fand 5 Bypass-Pfade).
**How to apply:** Bei jedem neuen Ist-Stunden-Schreibpfad zuerst `loadIstDayLocksStrict`/`ForMonths` einbauen und gesperrte Tage filtern.
