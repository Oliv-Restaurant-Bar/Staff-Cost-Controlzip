---
name: KV-Persistenz — Detailregeln
description: Tiefendetails zu localStorage+Supabase-KV-Persistenz (Merge-Kerne, Tombstones, Verfügbarkeit, updatedAt, Budget-Seed, app_settings-Wrapper). Kurzfassung in replit.md §2.
---

Ergänzt die Kurzregeln in `replit.md` §2 «Persistenz». Verbindliche Details:

## Sichere Merge-Schreibpfade
- Der Reporting-Monats-Upsert kennt KEINEN destruktiven Fallback: nie Ein-Monats-Blob bei Fehler — Fehler wird geworfen, Upsert-Error explizit geprüft.
- Lokale Monate dienen als Basis-Union gegen fehlgeschlagene Remote-Reads — auch beim LÖSCHEN. **Why:** ein still fehlgeschlagener Remote-Read schriebe sonst einen leeren Blob = Remote-Wipe (real aufgetretener Befund).
- Monats-Upsert und Monats-Löschen teilen EINEN Merge-Kern in `supabase-kv`.
- Entscheid gegen ein generisches `safeBlobUpsert`: die Merge-Regeln sind bewusst je Domäne verschieden (Budget: Jahres-Merge newer-wins + Aktionsjahr; Tagesumsätze: Feld-Merge remote>0-wins; Reporting: Monats-Replace). Technische Guards (`asRecordBlob`, `readLocalRecord`) zentral in `kv-blob-utils` (Supabase-frei, von Load-Pfaden nutzbar).
- Mehrmonats-Schleifen (z. B. vj_daily-Übernahme, Jahres-Kosten-Import) sichern KV SEQUENZIELL (`skipKvBackup` + `retryReportingMonthsBackup`, Fehler sichtbar mit Retry). **Why:** parallele Blob-Upserts überschreiben sich gegenseitig mit veralteten Monatswerten.

## Verfügbarkeit & Fehlerklassifikation
- `notifyKVBackupProblem`: offline = Hinweis-Toast, echter Fehler = Fehler-Toast mit «Erneut versuchen»; Retry liest den LOKALEN Stand frisch, nie alte Snapshots.
- Supabase-Verfügbarkeit ist FLÜCHTIG: «verfügbar» gilt nur bis zum nächsten Netzwerk-/Timeout-Fehler (invalidiert Cache); «nicht verfügbar» nur 30 s, danach Re-Check. Echte DB-Fehler (RLS/Constraint/statement timeout) sind KEIN Offline-Signal. Klassifikation zentral in `isKvUnavailable`/`markKVFailure` (supabase-kv) — Verfügbarkeit nie dauerhaft einfrieren.

## updatedAt-Disziplin
- `updatedAt` = echte fachliche Änderung. Stempeln darf AUSSCHLIESSLICH der Save-Pfad nach zentralem Dirty-Check (Budget: `saveBudgetYear`, fachlicher Vergleich exkl. `createdAt`/`updatedAt`/`viewDefault`).
- Identisches Speichern = No-op (kein Bump, kein localStorage-/KV-Write); wiederholtes Löschen lässt den Tombstone-Zeitstempel unangetastet; reine Funktionen/Ableitungen (Regel-Engine, Legacy-Sync) stempeln nie.
- Ausnahmen, die immer speichern: Jahr-Neuanlage und bewusste Neuanlage über einem Tombstone.
- Lade-Migrationen/Legacy-Syncs persistieren nur lokal (Dirty-Check, kein `updatedAt`-Bump, nie neues Jahr anlegen, nie Tombstone überschreiben).

## Budget-Jahres-Blob
- Jahres-Tombstones; der 2026-Auto-Seed ist ein reiner, NICHT persistierter View-Default (transientes `viewDefault`-Flag): blosses Laden schreibt weder localStorage noch KV, erzeugt kein `updatedAt`, belebt keinen Tombstone wieder, zählt in Import-Checkliste/-Cockpit nicht als Datenbestand. Erst echte Benutzeraktionen (Wert ändern, Speichern, expliziter Seed-Reset, Jahr kopieren) persistieren.

## app_settings-Wrapper
- ALLE Zugriffe auf die Tabelle `app_settings` über `appSettingsTable()` (`src/lib/app-settings-table.ts`). **Why:** die Tabelle fehlt in den auto-generierten Supabase-Typen (werden nie manuell editiert) — der technisch nötige Cast ist dort an EINER Stelle isoliert, kein `any` erreicht Aufrufer.
- Der Wrapper ist reine Infrastruktur; Domain-Regeln (Merge, Tombstones, Tenant-Präfix, Availability) bleiben vollständig bei den Aufrufern.

## dailyBudgets: Tages-updatedAt-Merge (2026-08)
- safeUpsertDailyBudgets stempelt jeden geänderten Tag mit updatedAt (ISO) und überspringt undefined-Werte in Updates (Key weglassen ≠ löschen).
- mergeDailyBudgets zweistufig: beide Seiten gestempelt ⇒ jüngerer Tag gewinnt feldweise ({...älter,...jünger}); sonst Legacy (remote>0 gewinnt). Bekannte Grenze: Stempel pro TAG, nicht pro Feld — Zwei-Geräte-Konflikt auf verschiedenen Feldern desselben Tages löst der jüngere Gesamttag.
- F/B-Kategorien (food/beverage-Keys) NIE als 0 schreiben, wenn die Quelle keine Kategorie-Zeilen hat: sowohl commitGastronoviDays als auch der Bulk-Pfad in GastronoviImportSection schreiben F/B nur bei >0; manuelle Eingabe: leer = Key weglassen, explizite 0 = Wert.
