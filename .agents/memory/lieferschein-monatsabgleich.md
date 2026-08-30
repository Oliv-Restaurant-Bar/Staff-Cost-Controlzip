---
name: Lieferschein→Monatsrechnung Abgleich
description: Revisionssicheres Ersetzen-statt-addieren-Modell für provisorische Lieferscheine und autoritative Monatsrechnungen.
---

**Regel:** Die Monatsrechnung ERSETZT provisorische Lieferscheine desselben kanonischen Lieferanten/Liefermonats wirtschaftlich. Original-Lieferscheine werden nie gelöscht oder betragsmässig verändert, sondern mit Lineage als ersetzt markiert; nur die autoritative Monatsrechnung zählt.

**Why:** Additive Übernahme verdoppelte Monate; echtes Überschreiben/Löschen zerstörte dagegen die Revisionshistorie. Das Markierungsmodell verhindert beides.

**How to apply:** Jede Aggregation, Analyse, FIBU-Sicht, Kandidatenlogik und jeder Export muss zuerst die zentrale Auswahl zählender Belege anwenden. Ersetzte Historienzeilen dürfen auch bei Re-Importen nie wieder Match-Kandidaten sein. Undo snapshotet Markierung und Monatsrechnung gemeinsam.

**Kreditoren über Monatsgrenzen:** Der Buchungsmonat kann nach dem Liefermonat liegen. Nur ein eindeutiger Liefermonat darf automatisch aufgelöst werden; mehrere Kandidaten sind fail-closed. Die autoritative Sammelrechnung muss die einzelnen Kreditorenbuchungen mit Betrag und Multiplizität als Herkunftsallokationen bewahren, damit Wiederholungsimporte auch ohne Referenz und bei identischen Zeilen idempotent bleiben.

**Why:** Eine reine Buchungsmonat-Zuordnung liess ältere Lieferscheine weiterzählen; eine Ein-Rechnung-pro-Buchung-Zuordnung scheiterte bei Sammelrechnungen und verdoppelte deren Betrag im Wiederabgleich.
