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

## Muster-Klassierung (Ausbau Juli 2026)
- Engine ist jetzt Drei-Weg-Vergleich MIRUS/Dienstplan-PLAN/gespeicherte Ist; Zellen klassiert als Muster 1–5 (`auto_take`, `conflict_zero`, `absence_keep`, `conflict_absence`, `conflict_diff`) plus `silent_round` (Diff ≤ 0.05 h → still geschrieben, erscheint nirgends).
- Rundungsschwelle `MIRUS_ROUNDING_THRESHOLD_H` (0.05 h) ist Parameter von `buildMirusReconcilePlan`; Muster-5-Konflikte ersetzen das frühere Auto-Überschreiben abweichender Stunden.
- **Konsistenz-Regel:** `resolvePlanToWrites`, `expectedAfterTotals` (Engine) und `finalEntryForCell`/`decisionForCell` (Button) müssen dieselbe Fallmatrix abbilden — bei Änderung immer alle vier anpassen.
- Muster 3 keep: bestehende Ist-Absenz bleibt UNANGETASTET; nur Plan-Absenz ohne Ist wird als `{hours:0, absenceType}` materialisiert. Plan-Absenzcodes werden via lokale Kopie der VACATION/SICK/ACCIDENT-Sets kanonisiert (kein Import aus absence-utils — zieht Supabase-Kette in Node-Tests!).
- Erstklassierung «Datei-MA ohne erfassungsart → MIRUS» ist bewusst; muss in der Vorschau explizit ausgewiesen werden (Alert «Neu als MIRUS klassiert»), sonst Review-Fail wegen Write-Gate.

## Namens-Matching & Aliasse (Juli 2026)
- Matching in mirus-name-mapping-store faltet jetzt Umlaute/Akzente (foldDiacritics: ä→ae/ö→oe/ü→ue/ß→ss + NFD-Strip) in ALLEN Vergleichspfaden; Reihenfolge egal (reversed/token-set), Mehrdeutigkeit → conflict (fail-closed, manuell).
- Dauerhafte MIRUS-Aliasse pro Mandant in app_settings (`mirus_name_aliases:<tenant>`): fetchRemoteAliases vor dem Matching in den localStorage-Cache mergen (remote gewinnt); nur manuell bestätigte Zuordnungen werden remote gespeichert, 'skip' bleibt bewusst lokal. Alles best-effort, wirft nie.
- Mapping-Keys sind gefaltet normalisiert; lookupSavedMapping hat Legacy-Fallback für alte ungefaltete Keys. Bekannte Grenze: saveRemoteAliases read-merge-upsert ist nicht atomar (seltener Last-Writer-Verlust bei parallelen Geräten).
