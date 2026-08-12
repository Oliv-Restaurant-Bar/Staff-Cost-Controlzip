---
name: Import-Belege (Quelldokument-Ablage)
description: Regeln für die Beleg-Ablage bei Warenrechnungs-Importen (Storage-Keys, MIME, manuell vs. Import)
---

- Beleg-Speicher = privater Bucket `waren-belege`; Bucket hat `allowed_mime_types` (serverseitig!) — CSV musste per Mgmt-API-SQL auf `storage.buckets` ergänzt werden. Neue Dateitypen ⇒ erst Bucket-Whitelist prüfen.
- Import-Belege liegen unter `${tenant}/import/<slug(lieferant)>--<slug(referenz)>-<fnv1a-hash8>` (`importBelegKey`). Hash über UNGEKÜRZTE Originale ist Pflicht — die 60-Zeichen-Slugs kollidieren sonst. Feldschlösschen-Referenzen brauchen Typ-Präfix (`ls-`/`fak-`/`sammel-`), gleiche Nummern über Dokumenttypen existieren real.
- CSV-Beleg-Identität = DATEIINHALT (Hash), nie Dateiname — umbenannte Re-Exporte müssen ersetzen statt duplizieren.
- `resolveImportReceiptPath`: manueller Beleg (Pfad ohne `/import/`) gewinnt IMMER; Import-Beleg wird von Re-Import ersetzt; ohne neuen Beleg bleibt der alte. Jeder neue Import-Pfad muss diese Auflösung nutzen, nie `receiptPath` blind überschreiben.
- Upload ist strikt best-effort (try/catch + toast.warning) — ein Storage-Fehler darf die Buchung nie blockieren. Undo-Snapshots decken nur KV, nicht Storage (bewusst: Ablage ist idempotent).

**Why:** Review fand reale Kollisionen (Slug-Kürzung, FS-Typen, Dateinamen-Identität); Bucket-MIME-Whitelist schlug beim CSV-Upload sonst still fehl.
**How to apply:** Bei jedem neuen Import-Pfad oder Beleg-Dateityp in Warenrechnungen.
