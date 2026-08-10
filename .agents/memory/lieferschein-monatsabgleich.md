---
name: Lieferschein→Monatsrechnung Abgleich
description: Ersetzen-statt-addieren-Modell für Warenkosten; Regeln für Kreditoren-Übernahme mit provisorischen Lieferscheinen.
---

**Regel:** Die Monatsrechnung ERSETZT provisorische Lieferscheine desselben Lieferanten/Monats — sie darf nie zusätzlich gespeichert werden. Entscheid pro Lieferant: Differenz anteilig auf Lieferdaten skaliert (Wochen-Granularität bleibt) oder als Korrektur-Eintrag aufs Rechnungsdatum; «nicht übernehmen» lässt Lieferscheine massgeblich und markiert `abgleichStatus:'differenz_offen'`.

**Why:** Additive Übernahme verdoppelte Monate (Terravigna 211363: Monatsrechnung + Lieferscheine = 2×). Juli 2026 Oliv wurde per anteiligem Abgleich auf 7'013.37 fixiert.

**How to apply:** SSOT ist `waren-monatsabgleich.ts` (pure, getestet). Kreditoren-Übernahme bietet auch status='provisorisch'-Buchungen an, bucht sie aber NIE direkt — nur über Abgleich-Gruppen; fail-closed wenn die frische Vorschau leer ist. Matching immer mit `loadSupplierAliases` und Argument-Reihenfolge `supplierMatchesKreditor(supplierName, kreditorName, aliases)`. Lieferschein = quelle fehlt oder 'auftragsbestaetigung', nicht final.
