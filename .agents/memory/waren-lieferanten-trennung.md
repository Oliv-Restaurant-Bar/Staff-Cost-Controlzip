---
name: Transgourmet/Prodega Lieferanten-Trennung (CSV-Import)
description: Markt→Lieferant-Ableitung pro Rechnung, docKey-Identität, «Lieferant offen»-Regel.
---

**Regeln:**
- Lieferant wird pro Rechnung aus der Markt-Spalte abgeleitet (KV `waren_markt_lieferanten_v1`, Defaults BGH→Transgourmet, Bern/Moosseedorf→Prodega); unbekannter Markt = «Lieferant offen» → Rechnung wird beim Import ÜBERSPRUNGEN, nie geraten. Nummern-Plausibilität (6xxxxxxx=TG, 1–4-stellig=Prodega) nur Warnung — Markt gewinnt.
- `docKey` = `rechnungsNr|datum|markt(lowercase)` — kurze Portal-Nummern können am selben Tag in MEHREREN Märkten vorkommen; Markt gehört zur Dokument-Identität (Review-Fund: sonst Cross-Markt-Mischung). Preis-Historie ist pro Lieferant geführt → TG/Prodega getrennt.
- Alias-Gruppe Prodega/Transgourmet im FIBU-Abgleich bewusst NICHT löschen (Buchhaltung bucht teils gemischt); Standard-Ansicht = getrennt.

**Why:** Rechnungsnummern-Wiederverwendung + gemischte Portal-Exporte; Duplikat-Upsert-Schlüssel bleibt Mandant+Lieferant+Referenz+Datum.
**How to apply:** Bei Änderungen an parseTransgourmetCsv/Import-Pfad die Cross-Markt-Kollisions-Tests in waren-positionen.test.ts beachten.

## Markt im Dedup-Schlüssel (Aug 2026)
- Bestands-Upsert beim CSV-Import matcht Lieferant+Nr+Datum+MARKT (SSOT `findeCsvBestandsTreffer` in waren-positionen.ts); InvoiceEntry hat optionales Feld `markt`.
- **Why:** Bern & Moosseedorf mappen beide auf «Prodega»; gleiche kurze Portal-Nr. am selben Tag überschrieb sonst die andere Markt-Rechnung.
- Alt-Einträge ohne markt matchen tolerant und bekommen den Markt beim Update; der zweite Markt desselben Tags legt danach neu an. ID-Fallback enthält den Markt (keine Date.now()-Kollision).

## TG/Prodega-Familien-Toleranz beim Bestands-Treffer (Aug 2026)
- Bar-Einkäufe aus einem Prodega-Markt können in der FIBU als Transgourmet laufen (Nummernkreis 2607…) und werden im Bestand manuell umgehängt. `findeCsvBestandsTreffer` akzeptiert TG↔Prodega als denselben Lieferanten — aber NUR bei exakt gleichem Markt; markt-lose Alt-Einträge brauchen weiter den exakten Namen (Cross-Markt-Kollisionsschutz).
- Beim Re-Import gewinnt der Bestands-supplierName gegen den Markt-Default, und Preis-Historie/Preishinweise werden mit dem EFFEKTIV persistierten Lieferanten gerechnet (nicht mit dem Vorschau-Default) — sonst fallen Umhängungen zurück bzw. landen Preisverläufe unterm falschen Lieferanten.
