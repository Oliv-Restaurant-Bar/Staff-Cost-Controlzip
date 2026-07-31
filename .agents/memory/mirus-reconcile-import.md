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

## Parser layoutrobust (Juli 2026)
- Blockerkennung generisch (BLOCK_HEADER_RE «<Nr> <Label>», keine hardcodierten Abteilungsnamen); unbekannte Blöcke (Hilfsarbeiter, Geschäftsleitung) werden GELESEN, nicht mehr übersprungen; küche/service per Keyword, sonst bleibt currentDept.
- Mehrblock-Mitarbeiter: parseEmployeeRows summiert am Ende pro (name lowercase, Tag) — nie überschreiben.
- Harte Stopps: Spaltenzahl ≠ Titel-Zeitraum (Ende−Start+1) → failureReason; Wochentags-Gegenprobe bleibt Pflicht. Keine permissiven Fallbacks einführen.
- Mandanten-Check: detectCostCenter + COST_CENTER_TENANTS {3027→oliv, 3012→beaulieu} (Zuordnung NUR über Nummer, robust gegen «AG»); Button stoppt bei Mismatch VOR jedem Schreiben; fehlender/unbekannter Kostenträger blockt nicht.

## Offene Stunden (Parken)
- Store `mirus-open-hours-store.ts`: app_settings-Blob `mirus_open_hours:<tenant>`, Laden→Mergen→Upsert (best-effort, nicht atomar); Status open/resolved/discarded statt Löschen (keine Tombstones). fetchParkedEntries WIRFT bei Lesefehler.
- Parken schreibt NIE Ist; Write-Gate bleibt: keine MA-Anlage aus Import/Offene-Stunden-UI, nur Link auf Personalstamm.
- Auto-Auflösung nach Re-Import nur bei Tagesabdeckung (jeder geparkte Tag ±0.05h im Import), sonst offen lassen — Teil-Importe dürfen nichts still verstecken.
- Manuelle Zuweisung (OpenHoursSection): volle Pipeline (Plan/Backup/Writes), Ziel-MA für den Plan als MIRUS behandeln (sonst skippt die Engine); resolved NUR wenn keine Muster-Zelle mit fileHours>0 auf 'keep' steht, sonst bleibt Eintrag offen.

## Parken statt «Neu erstellen» (Juli 2026)
- Im MIRUS-Matching-Dialog (allowPark) ist der Default für unbekannte Namen 'park'; 'create' («Neuen Mitarbeiter anlegen») parkt EBENFALLS und verweist nur per Toast auf den Personalstamm — nie Ghost-Datensätze (Write-Gate).
- Sentinel-Werte 'park'/'create' dürfen NIE als Mitarbeiter-ID interpretiert oder als Alias/Name-Mapping gespeichert werden — alle Filter (saveNameMappingsBatch, manualAliases, nameToEmp, Dialog-handleConfirm) müssen sie ausschliessen.
- Erfolgsmeldung via buildMirusSuccessMessage (pure): zugeordnet/geparkt/übersprungen getrennt, «Summe im Importumfang (Monat)» ohne out-of-scope; out-of-scope-Stunden separat ausweisen.
- Altlast bereinigt: Legacy-Pfad hatte Juli-2026-Beaulieu-Stunden unter UUID-employee_ids ohne employees-Datensatz in actual_hours hinterlassen (unauffindbar); solche Ghost-Stunden gehören nach mirus_open_hours:<tenant> (Tageswerte!) und die actual_hours-Zeilen gelöscht. Service-Role hat KEINEN Zugriff auf employees/app_settings (REVOKE) — Diagnose/Fix via Management-API-SQL.
