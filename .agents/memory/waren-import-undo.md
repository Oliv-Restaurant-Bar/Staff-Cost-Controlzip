---
name: Warenrechnungs-Import-Undo
description: «Letzter Import rückgängig machen» für CSV-TG/Prodega-, Feldschlösschen- und Historien-ZIP-Importe — Snapshot-Regeln und bekannte Grenzen.
---

**Regeln:**
- Ein KV-Slot pro Mandant+Typ (`waren_import_undo_<csv|fs|fs_historie>_v1`, tenantKey). Record = vorher- UND nachher-Snapshot der betroffenen Blobs (supplier_invoices je Monat, waren_positionen, waren_preishinweise, waren_preishistorie_v1, fs_historie_<jahr>).
- Snapshot VOR dem ersten Schreiben, «nachher» NACH dem letzten Schreiben; nur der jeweils letzte Import ist undo-bar (Slot wird beim Undo geleert).
- Undo-Pfad: Jahr-Sperre frisch prüfen → stabiler Vergleich (Schlüssel sortiert) aktueller Stand vs. «nachher» → Slot frisch nachlesen (Doppel-Undo-Wache via zeitpunkt) → «vorher» zurückschreiben. Bei Abweichung IMMER verweigern, nie mergen.

**Why:** KV-Store hat kein Compare-and-Swap; Konfliktschutz ist read-then-write mit Stale-Checks (gleiche bekannte Grenze wie Import-Center-/Budget-Undo). Millisekunden-Fenster zwischen Prüfung und Restore bleibt theoretisch offen.
**How to apply:** Jeder neue Warenrechnungs-Import-Pfad muss vorher/nachher-Snapshots über ALLE Keys machen, die er schreibt — sonst verweigert der Konfliktschutz fälschlich oder restauriert unvollständig. Tests: waren-import-undo.test.ts (In-Memory-KV-Mock).
