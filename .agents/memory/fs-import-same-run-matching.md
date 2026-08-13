---
name: fs-import Same-Run-Matching
description: Kern-Import — frisch geschriebene Buchungen desselben Laufs im Datum+Betrag-Fallback tabu, für exakte Referenz-Treffer aber sichtbar
---

Regel: In `kernImportiereFsRechnungen` hält ein `neuErstellt`-Set die im selben Lauf geschriebenen Buchungs-IDs. Sie sind in den mehrdeutigen Datum+Betrag-Fallback-Prädikaten (MR-Zweipass UND Nicht-MR-Ersatzpfad) ausgeschlossen, bleiben aber für exakte Referenz-Treffer sichtbar.

**Why:** Produktionsfall 08/2026 (Espro/Amarx): zwei 50.00-Lieferungen am selben Tag in EINER Monatsrechnung — die zweite matchte per Datum+Betrag-Fallback die soeben final gebuchte erste und wurde als «bereits final» übersprungen (Buchung fehlte still). Der naive Fix (neue IDs in `vergeben`) hätte die exakte Referenz-Idempotenz gebrochen: dieselbe MR doppelt im Batch hätte ZWEI finale Buchungen erzeugt.

**How to apply:** Bei jeder Änderung an den Match-Pässen in fs-import.ts beide Gegenfälle testen: (a) gleicher Tag + gleicher Betrag, verschiedene LS-Nrn → beide gebucht; (b) gleiche Referenz doppelt im Batch → genau ein Eintrag. Regressionstests existieren in `fs-import.test.ts`. `vergeben` (bereits gematchte Bestands-Einträge) und `neuErstellt` nie zusammenlegen.
