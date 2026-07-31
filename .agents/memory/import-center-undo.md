---
name: Import-Center Undo-Protokoll
description: «Letzten Import rückgängig machen» — Snapshot-vor-Schreiben-Muster, Stale-Schutz, MIRUS-Sonderweg
---

Zentrales Protokoll: `import-undo-store.ts`, KV-Key `import_undo_log:<tenant>` (app_settings). Max 5 Läufe pro Quelle, NUR der neueste trägt einen Undo-Snapshot (ältere sind reine Anzeige).

**Regeln:**
- Snapshot wird VOM AUFRUFER **vor** dem Schreiben erhoben und beschreibt exakt den Scope (Quelle+Zeitraum+Mandant). Snapshot-Arten: `kv-keys` (null=Key löschen), `reporting-fields` (Feld null=entfernen; Restore via `restoreReportingFields`), `reporting-record` (ganzer Monat inkl. Journal; `restoreReportingRecord`), `mirus-ist` (Verweis auf dienstplan_ist_backup + runId der geparkten Einträge).
- Protokollieren ist best-effort: Fehler bricht Import nie ab, aber Warn-Toast («Rückgängig nicht verfügbar»).
- **Stale-Schutz ist Pflicht in JEDEM Undo-Pfad**: vor dem Restore remote re-fetchen und prüfen, dass der Lauf noch der neueste nicht-undone der Quelle ist. `undoMirusImportRun` (mirus-undo.ts) hat einen EIGENEN Pfad am generischen `undoImportRun` vorbei — Review-Fail, bis der gleiche Check dort eingebaut war. Neue Sonderpfade brauchen ihn ebenfalls.
- MIRUS-Undo: Backup erst nach Vollerfolg löschen; geparkte «Offene Stunden» des Laufs via `discardParkedByRun` (nur status open) verwerfen; Aliasse bleiben. Dienstplan-Undo und Import-Center-Undo teilen sich das Backup (einmal verbraucht) und synchronisieren das Protokoll via `markMirusRunUndoneByBackup`.
- UI: `LastImportPanel` (source-Prop), Gäste ohne Undo-Button, Refresh via `IMPORT_UNDO_LOG_EVENT`.

**Nicht verdrahtet** (Stand Juli 2026): Tagesdaten-Einheitsimport, Manuelle Eingabe, Umsatz Vorjahr (Jahres-XLSX) — Muster ist erweiterbar (recordImportRun + Snapshot + Panel).
