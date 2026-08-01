---
name: Waren-Kontoklassen & Split
description: Warenkosten (4000–Grenze) vs. Betriebskosten Klassifikation, nurWarenAnteil-Muster, FIBU-Abgleich = Gesamt-Total
---

# Kontoklassen bei Warenrechnungen

**Regel:** Klasse ergibt sich NUR aus der Kontonummer: 4000–Grenze (Default 4070, KV `waren_grenze_v1`, tenantKey-präfixiert) = Warenkosten (zählen in WKQ); alles andere (>Grenze UND <4000, z.B. 6040) = Betriebskosten, NIE in der WKQ.
**Legacy-Regel:** Rechnung/Zeile OHNE Konto oder mit nicht-numerischem Konto = Warenkosten — Altbestand darf die WKQ nicht verlassen.

**nurWarenAnteil-Muster:** `computeWarenkostenTotals` kennt keine Splits. Deshalb wird an JEDER WKQ-/Warenkosten-total-Stelle die Eintragsliste vorab mit `nurWarenAnteil(list, grenze)` (waren-klassen.ts) reduziert (gemischte Splits anteilig, immutable, reine Betriebs-Rechnungen fallen weg). Betriebskosten separat via `sumBetriebNet`.

**Why:** Rechnungen sind auf beliebig viele Konten splittbar (kontoSplits[], Summe = Rechnungsnetto, MWST auf Rechnungsebene); ohne Klassentrennung würden Betriebskosten die WKQ verfälschen.

**How to apply:**
- Cockpit/Monatsreport: warenkosten_total/WKQ/Lieferanten-Kinder + Export-Blatt = waren-only; separate Zeile `betriebskosten_waren` (leer statt 0).
- Analyse «nach Lieferant»: GESAMT-Total über ALLE Konten + Spalten «davon Waren/Betrieb» (`aggregateBySupplierKlassen`) — Anteil-Spalte hat Gesamt-Basis, Footer-Badge ist WKQ (anderer Nenner, beschriftet lassen).
- FIBU-Abgleich pro Lieferant vergleicht bewusst das GESAMT-Total (ungefiltertes amountNet) — nur so stimmt der Kontoblatt-Vergleich. Nicht «fixen».
- Erfassungsliste/cumNet/Tages-Charts zeigen bewusst Gesamtbeträge.
