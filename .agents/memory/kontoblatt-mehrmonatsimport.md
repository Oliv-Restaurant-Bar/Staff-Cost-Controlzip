---
name: Kontoblatt-Mehrmonatsimport (Sage, PDF/Excel)
description: Regeln für Kosten-Importe, die mehrere Monate abdecken (Jahres-/Perioden-Kontoblatt), pro Konto+Monat.
---

- Mehrmonats-Dateien werden IMMER über Buchungsdatum pro Monat gruppiert (Netto = Soll−Haben); eine Jahres-/Periodendatei darf nie in EINEN Monat summiert werden.
  **Why:** Der alte Einzelmonats-Excel-Parser summierte alle Buchungen ungeachtet des Monats — Jahresdateien erzeugten falsche Riesenmonate.
  **How to apply:** Excel/PDF-Kostenimporte laufen über den Monats-Gruppierungs-Parser; Einzelmonat = Spezialfall (byMonth.size===1).
- Teiljahres-/Mehrmonatsimporte upserten NUR die Datei-Monate (kein Clearing anderer Monate); nur der explizite Jahres-Replace darf dateilose Monate bereinigen. Unveränderte Monate = kein Write (Dirty-Check).
- Monate mit 0-Netto gehören zum Zeitraum: 0-Zeilen mitschreiben und Routing nach Journal-Monaten, sonst bleiben stale Kontowerte/Journale beim Re-Import stehen.
- Lieferanten-Journal wird pro Monat ERSETZT, aber nur bei Ist-Daten — VJ-Importe im Monats-Wizard schreiben KEIN Journal (würden das Ist-Journal des Jahres überschreiben). Der Jahres-Kostenimport (VJ-Jahresdatei) schreibt Journale seines Jahres; bei Replace auch dateilose Monate leeren.
- Undo-Snapshots für Kostenimporte müssen expenseCategories UND Journal-Vorzustände enthalten (reporting-fields-Snapshot mit journals[]), sonst ist Undo unvollständig.
- Mandanten-Check: Firma aus dem Dateikopf (oliv/beaulieu) gegen den aktiven Mandanten prüfen und bei Mismatch STOPPEN — gilt für PDF und Excel gleichermassen.
- Save-Pfad-Locks immer strict/fail-closed prüfen (getLockStateStrict); permissives getLockState hebelt die Jahres-Sperre bei Lesefehlern aus.
