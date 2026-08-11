---
name: Schutz manueller Kontierungen beim Kosten-Import
description: quelle='manuell'-Merge-Schutz in den Kosten-Schreibkernen; Freigabe nur explizit pro Konto×Monat
---

Regel: `ExpenseCategory.quelle: 'import'|'manuell'` — manuelle PL-Eingaben setzen 'manuell', Import-Builder 'import' (fehlend = wie 'import', Schutz gilt erst ab Kennzeichnung).

**Why:** Kosten-Importe ersetzten früher ALLE numerischen Konten und löschten manuell erfasste Zeilen (z.B. Konto 5004) stillschweigend.

**How to apply:**
- Schutz liegt im Schreib-Kern (`mergeProtectedCats` in beiden Kernen `replaceAnnualCostYear` + `upsertCostMonths`), NICHT in der UI/Vorschau — jeder neue Kosten-Schreibpfad erbt ihn automatisch, solange er diese Kerne nutzt.
- Überschreiben nur via `opts.uebernehmen` (Set `${month}|${accountNumber}`, monatsscharf); übernommene Zeile wird wieder 'manuell' geführt.
- Explizites Jahr-Löschen (`removeAnnualCostYear`) setzt bewusst `ignoreManualProtection:true` — Löschen entfernt auch manuelle Zeilen; dieses Flag NIE aus Import-Pfaden setzen.
- Dirty-Check-Schlüssel (`sameCategorySet`) ignoriert `quelle` absichtlich: identischer Re-Import bleibt No-op, kein updatedAt-Bump.
- Neue manuelle Schreibpfade für Konto-Kategorien MÜSSEN `quelle:'manuell'` setzen, sonst sind die Zeilen ungeschützt.
- Bekannte Grenze: Mehrmonats-Import (CSVImport) schützt zwar, hat aber keine Freigabe-UI — Übernahme nur im Jahres-Import-Center möglich.
