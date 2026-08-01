---
name: Feedback-CSV-Import (Lunchgate) Upsert-Muster
description: Rezensions-Import in reviews_data — Upsert-Schlüssel, Idempotenz, Undo-Snapshot
---

- Upsert-Schlüssel = Publish Date + normalisierter Gast + Reservation Date; **ohne Gast IMMER Zeilen-Hash** — sonst kollabieren zwei anonyme Feedbacks am selben Tag zu einem Datensatz (Review-Finding).
- Idempotenz nur, wenn bei «aktualisiert» die **bestehende id wiederverwendet** wird (mergeById arbeitet per id); answered/screenshotPath des Bestands dabei erhalten.
- Ganzer Import = EIN `upsertSingleReviews`-Batch (ein CAS-Write); Undo = kv-keys-Snapshot des kompletten `reviews_data:<tenant>`-Blobs (inkl. Tombstones via `fetchReviewsRawValue`, null = Key fehlte) VOR dem Schreiben.
- Cockpit-Sternzeilen zentral über `reviewStarRowDefs()` in monatsreport.ts (Google+Lunchgate × 5..1); Plattformen nie mischen — Zählung nur via `countReviewsByStar` mit Plattform-Filter.
- csv-import-engine kann kein BOM/quoted-multiline — Feedback-CSV hat eigenen Parser in `feedback-import.ts`.

**Why:** Erneuter Import derselben Datei darf nichts duplizieren; anonymer Schlüssel ohne Hash war eine echte Kollisionsquelle.
**How to apply:** Bei jedem weiteren Rezensions-/Feedback-Importpfad denselben Schlüssel- und Batch-Mechanismus nutzen, nie zeilenweise upserten.

## Echtes Lunchgate-Datumsformat
- Der reale Export liefert «31 Jul 2026 09:47» (Tag Monatsname EN/DE Jahr Uhrzeit), NICHT dd.MM.yyyy — parseFeedbackDate muss den Monatsnamen VOR dem Space-Split matchen, sonst werden alle Zeilen übersprungen («Keine gültigen Zeilen»).
- Alle Datums-Pfade kalender-validieren (Date.UTC-Rückvergleich): 31 Feb/29 Feb im Nicht-Schaltjahr ⇒ null, nie stillschweigend verschobene Daten.
- Eine «Kein Inhalt»-Meldung beim Nutzer kann in Wahrheit ein Parser-Fehler sein — Browser-Console-Logs ([Feedback-Import]-Diagnose) zuerst prüfen, bevor man die UI verdächtigt.
