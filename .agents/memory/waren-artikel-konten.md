---
name: Artikel→Konto-Zuordnungen (Import-Vorschau)
description: Gelernte Positions-Kontierung pro Mandant/Lieferant; Vorrangregeln und Vorschau↔Import-Konsistenz
---

- KV `waren_artikel_konten_v1` (tenantKey), Key = `artikelKey(lieferant, pos)` → Konto. Merge-Save (nie ganze Tabelle ersetzen).
- Vorrang in `positionenAusRechnung`/`kontoFuerPositionMitArtikel`: **Pfand (MwSt-Code 0) > Artikel-Zuordnung > Warengruppen-Tabelle**; Artikel-Treffer werden `manuell:true` markiert.
- `uebernehmeManuelleKontierung`: NEUE manuell markierte Positionen gewinnen gegen alten manuellen Bestand (sonst überschreibt Alt-Import frische Vorschau-Wahl).
- **Why:** Vorschau («⚠ N offen» anklickbar, Konto-Dropdown je Position) muss exakt zeigen, was der Kern bucht; Overrides werden VOR dem Kern-Aufruf gespeichert, der Kern lädt die Tabelle selbst.
- Beaulieu: editiertes row.konto fliesst via `{ ...profil, konto }` in extraMapping — Konto MUSS Teil des proProfil-Gruppen-Schlüssels sein, sonst gewinnt die erste Zeile für alle Zeilen desselben Lieferanten.
