---
name: FIBU-Journal Dublettensicherung
description: Buchungszeilen-Dedupe im Journal-Writer + einmalige Bereinigung mit Undo; Strict-Writer bleibt bewusst verbatim.
---

# FIBU-Journal dublettensicher (08/2026)

- **Root Cause der 3×-Lieferanten:** Kostenblatt-Re-Import im «Ergänzen»-Modus baute
  `prior + neu` ohne Dedupe (CSVImport-Einzelmonatspfad) — Buchungszeilen wurden addiert.
- **Regel:** `saveJournalEntries` (reporting-store) dedupliziert IMMER (replace UND
  append) via `dedupeJournalZeilen` (journal-dedupe.ts). Schlüssel je Zeile:
  Datum + Beleg-Nr + Konto + Soll + Haben + normalisierter Text (Mandant+Monat
  stecken im Storage-Key). Gleicher Schlüssel = gleiche Zeile → 1× behalten.
- **`saveJournalEntriesStrict` bleibt bewusst verbatim** — Undo/Restore muss den
  Vorzustand exakt (inkl. Dubletten) zurückschreiben. Neue Import-Writer NIE über
  Strict routen.
- **Bereinigungs-UI** (Warenrechnungen, Abgleich-Tab): Hinweis+Dialog nur bei
  Dubletten; Undo-Snapshot (`journal_dedupe_undo_v1`, tenantKey, EIN Slot je
  Mandant) wird STRIKT VOR dem Schreiben gesichert. **Kontext-Wache:** Mandant/
  Monat/undoKey beim Aktionsstart einfrieren, Schreibziele nur aus dem eingefrorenen
  ctx; UI-State nur setzen, wenn Kontext noch aktiv (Architect-High: Navigation
  während await schrieb sonst in fremden Mandant/Monat).
- Bereinigung berührt NUR Journal-Arrays — expenseCategories (manuelle Konten wie
  5004) und FibuMatchState (erklärte Differenzen) bleiben unangetastet.
- Testfeste Juli-Kontrollwerte in `journal-dedupe.test.ts` (Ambro 8'568.39 …,
  Umbuchung −1'830 einfach; Strict behält 27 Duplikate).
- **Direkte KV-Reparatur** (wenn UI nicht praktikabel): app_settings via Supabase-
  Mgmt-API-SQL, aber IMMER dem App-Muster folgen — Undo-Snapshot zuerst upserten,
  dann dedupliziert schreiben; Oliv-Keys unpräfixiert. Clients holen den Stand beim
  Laden aus dem KV (loadJournalEntriesFromDB überschreibt localStorage).
