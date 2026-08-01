---
name: Gäste IN (dine-in) — Quelle & 1:1-Monatsersatz
description: Woher «Gäste IN» kommt, dublettensicherer Gäste-Import (Monatsersatz), Undo-Snapshot-Regeln und die Snapshot-Stripping-Falle.
---

# Gäste IN — Quelle & dublettensicherer Import

- «Gäste IN» (Tag/Woche/Monat, alle Views inkl. Umsatz pro Gast und Anteil-Zeilen) stammt AUSSCHLIESSLICH aus dem KV-Blob `gaeste-daily` (tenant-präfixiert) — 1:1 aus dem Gäste/Anzahl-Import. NIE aus Umsatz ÷ Durchschnittsverkauf schätzen, NIE mit Take-Away verrechnen (TA ist separate Kennzahl aus Produktanalyse).
- Gäste-Import ist 1:1-MONATSERSATZ: `saveGaesteDailyReplaceMonths` entfernt Bestands-Tage der importierten Monate, die nicht in der Datei sind (ersetzt gleiche Tage, addiert nie); Diff-Vorschau via `diffGaesteDaily` («X neu · Y aktualisiert · Z unverändert» + Entfernt-Warnung). **Why:** Alt-Tage aus Fehl-/Doppelimporten blieben sonst liegen und verfälschten die Monatssumme.
- Undo-Snapshot bei destruktiven Monats-Scopes IMMER bei der BESTÄTIGUNG aus dem frischen Bestand bilden (alle Bestands-Tage der Monate ∪ Datei-Tage), nie aus der Vorschau-Diff.
- FALLE Import-Protokoll: Nur der NEUESTE Lauf je Quelle behält seinen Snapshot (ältere werden gestrippt). Ein zweiter Import derselben Quelle vernichtet den Wiederherstellungspfad des ersten. E2E-Tester haben so am 01.08.2026 die echten Beaulieu-Juli-Gästedaten (27 Tage, Summe 14'600) unwiederbringlich ersetzt — Testimporte auf der geteilten Dev-DB nie doppelt ausführen, User muss echte Datei neu importieren.
