---
name: Pfand/Depot = Konto 4800
description: Pfand/Leergut/Gebinde wird universal auf echtes Konto 4800 gebucht; 4800 ist neutral (nie WKQ/Betriebskosten); Legacy-«Depot»-Splits bleiben gültig.
---

# Pfand/Depot/Gebinde → Konto 4800 (seit 08/2026)

**Regel:** Neue Pfand-/Leergut-/Gebinde-Buchungen laufen auf das ECHTE Konto 4800 (KONTO_LABEL_PFAND = '4800'), nicht mehr auf das Pseudo-Konto «Depot». `istPfandKonto()` (waren-klassen) matcht BEIDE («Depot» + 4800/4800x) und ist die einzige Wahrheit: kontoKlasse → neutral (vor dem Nummernkreis-Check — sonst wäre 4800 Betriebskosten!), nettoOhneDepot/istDepotSplitKonto, direkter Warenaufwand (skip, nie «übrig»), FIBU-Konto-Abgleich (immer neutrale «Depot»-Zeile, auch bei Nicht-FS-Lieferanten — nie als normales Konto gegen das Journal).

**Why:** FIBU bucht Pfand auf 4800 Gebinde-Verrechnung; vorher landeten FS-Pfand-Kategorien teils via gespeicherte Warengruppen-Tabelle auf 6040. Depot gleicht sich über Rückgaben aus → nie WKQ/Warenaufwand.

**How to apply:**
- FS-Kategorien: token-basierte Zwangs-Erkennung (leergut|ladungsträger|pfand|depot|gebinde|container|harass) läuft VOR dem konfigurierten Mapping — ein Mapping kann Pfand nie mehr auf 6040/Warenkonto routen.
- Legacy-«Depot»-Splits in Altdaten NIE migrieren/umschreiben — alle Leser behandeln beide identisch.
- Neue Konsumenten, die Konten klassifizieren, müssen istPfandKonto nutzen, nie `=== 'Depot'` oder Nummernkreis allein.
- 4800 ist regel-lernbar (artikelKonten) — Pfand-Artikel sind lieferantenübergreifend immer 4800.

## Universal-Zwangsregel (08/2026, verschärft)
- `istZwingendPfand` (MwSt-Code 0 ODER starke Kennwörter inkl. FGG ODER Pfand-WARENGRUPPE wie «Leergut») läuft VOR gelernter Artikel-Zuordnung UND vor der Warengruppen-Tabelle — gespeicherte/gelernte 6040-/Warenkonto-Zuordnungen können Pfand nicht mehr überstimmen.
- `erzwingePfandPosition` als Post-Pass in positionenAusRechnung, uebernehmeManuelleKontierung und im Positionen-Dialog-Save: normalisiert JEDEN Zwangs-Pfandfall kanonisch (konto null, status pfand, manuell entfernt) — auch inkonsistenten Altbestand (status pfand mit gesetztem Konto), sonst zählt kontoSplitsAusPositionen das Konto weiter.
- Schwache Kennwörter (gebinde/harasse/container/fass) bleiben Fallback bei unbekannter Warengruppe — Bier «… Fass 20L»/«… Container» mit gemappter Gruppe bleibt Warenkonto.
