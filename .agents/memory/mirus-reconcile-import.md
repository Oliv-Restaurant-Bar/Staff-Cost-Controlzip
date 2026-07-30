---
name: MIRUS-Reconcile-Import (Dienstplan)
description: Regeln des neuen Ist-Stunden-Imports «MIRUS überschreibt mit Rückfragen» — Erfassungsart, Backup/Undo, Write-Disziplin.
---

Der Dienstplan nutzt `MirusReconcileImportButton` (Engine: `mirus-import-engine.ts`); die alte `ActualHoursImportButton` bleibt NUR für PersonnelTab/HoursEditor/ImportHub — nicht löschen, drei Seiten importieren sie noch.

Regeln (Spec-verbindlich, bei Änderungen beibehalten):
- `employees.erfassungsart` 'MIRUS'|'MANUELL' ist reine Import-Kennzeichnung (NULL = MANUELL); Persistierung nur chirurgisch via `updateEmployeeErfassungsart`, nie über employeeToDb-Vollupdate.
- MANUELL-MA und Nicht-Datei-MA werden NIE geschrieben — auch nicht im lokalen State (Alt-Bug: replace-Modus räumte ~78 lokale Einträge weg).
- Zellen: Datei>0 überschreibt Stunden ohne Absenz-Marke automatisch; Absenz+Datei-0 bleibt komplett. Konflikt A (0 vs Stunden) / B (Stunden vs Absenz) → Rückfrage vor dem Schreiben.
- Supabase-Writes pro Zelle awaited via `saveActualHourEntry` (gibt `{ok}` zurück, wirft NIE — Ergebnis prüfen, nicht try/catch); lokaler State erst nach Erfolg via `onCellChange(..., {skipSupabase:true})`.
- Backup in `dienstplan_ist_backup` VOR dem Schreiben; Undo löscht das Backup erst nach vollständig erfolgreicher Wiederherstellung; Undo-Button hängt an DB-Backup-Existenz, nicht am localStorage-Report.

**Why:** Review-Fail wegen fire-and-forget-Writes + Backup-Löschung trotz möglicher Teilfehler; diese Disziplin verhindert stille Datenverluste.
