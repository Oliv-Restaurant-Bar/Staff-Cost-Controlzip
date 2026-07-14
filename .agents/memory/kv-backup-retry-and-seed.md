---
name: KV-Backup Retry & Seed-Merge
description: Regeln für KV-Backup-Fehlerbehandlung (Retry-Snapshots), Auto-Seed-Merge-Semantik und Tombstone-Umstellungen in Union-merge-Blobs.
---

## Retry liest frisch, nie den alten Snapshot
Ein «Erneut versuchen»-Callback für ein fehlgeschlagenes KV-Backup darf NICHT den beim Fehler eingefangenen Daten-Snapshot re-enqueuen — er muss den lokalen Stand frisch lesen (z. B. `loadAll(storeKey)`).
**Why:** Szenario: Backup scheitert → User speichert erneut (erfolgreich) → klickt danach den alten Retry-Toast → der stale Snapshot läuft NACH dem neueren Backup und regressiert remote bis zum nächsten Save.
**How to apply:** In jeder retry-Closure von `notifyKVBackupProblem`-Konsumenten den Zustand im Callback-Moment lesen, nicht bei Closure-Erstellung.

## Auto-Seed-Saves müssen markiert sein
Jeder automatische Seed-Write (z. B. Budget-2026-Seed beim ersten Laden) muss im Save-Action-Objekt `seeded:true` tragen; der KV-Union-Merge lässt dann remote-Jahre mit echten Werten gewinnen und zieht localStorage nach.
**Why:** Ein unmarkierter Seed sieht im Merge wie ein User-Save aus und überschreibt remote bearbeitete Budgets anderer Geräte.
**How to apply:** Expliziter User-Reset trägt bewusst KEIN `seeded` (User-Entscheid gewinnt). Offline-Fehlerklassifikation: `isKvUnavailable` (Netzwerk-Regex) → Info-Toast; echter Fehler → Error-Toast + Retry.

## Reine Ladepfade dürfen NIE speichern (kein Write-on-Load)
Ein Ladepfad (load*-Funktion), der «zur Sicherheit» das migrierte Ergebnis über den normalen Save-Pfad zurückschreibt, stempelt `updatedAt` neu und löst ein KV-Backup aus — im Aktionsjahr-Merge gewinnt lokal bedingungslos, also überschreibt ein Gerät mit stalem localStorage beim BLOSSEN ÖFFNEN den neueren Remote-Stand.
**Why:** Genau so verlor der Budget-Store Remote-Änderungen (externer Review-Befund): loadBudgetWithPL rief saveBudgetYear bei jedem Load mit echten Daten; zusätzlich Write-Amplification, weil jeder Reporting-/Dashboard-Render über den Load lief.
**How to apply:** Lade-Migrationen nur LOKAL persistieren (localStorage) und nur bei effektiver Änderung (Dirty-Check über Objektreferenz — jede Migrationsstufe gibt bei «keine Änderung» dieselbe Referenz zurück); `createdAt`/`updatedAt` unverändert lassen (Migration ≠ User-Änderung, sonst gewinnt stale in newer-wins-Merges), nie ein neues Jahr anlegen, nie Tombstones überschreiben. Sync-Helfer (z. B. Legacy-Positions-Sync) brauchen einen eigenen Dirty-Check, sonst stempeln sie jeden Load als «geändert».

## Tombstone-Umstellung: ALLE direkten Blob-Leser auditieren
Wenn ein Store von Hard-Delete auf Tombstones umgestellt wird, genügt es nicht, die Store-eigenen Leser zu filtern — Read-only-Aggregatoren (Import-Checkliste, Import-Cockpit, Startseite) lesen den localStorage-Blob DIREKT und zählen Tombstones sonst still als Datenbestand.
**Why:** Genau das passierte bei der Budget-Tombstone-Einführung: `budgetCoverage` meldete gelöschte Jahre als «erledigt», das Cockpit zählte sie als Records.
**How to apply:** Nach jeder Tombstone-Einführung per grep nach dem Storage-Key (z. B. `budget_v1`) alle direkten JSON.parse-Leser finden und `!rec.deleted` filtern.
