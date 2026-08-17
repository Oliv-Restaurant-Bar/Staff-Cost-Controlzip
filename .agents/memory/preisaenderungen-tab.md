---
name: Preisänderungen-Tab (persistente Preishistorie)
description: Warenrechnungen-Tab «Preisänderungen» liest nur persistierte waren_preishinweise_*, erkennt nichts neu; Mehraufwand strikt zeitraum-gekappt.
---

## Regel
Die Preisänderungs-Erkennung ist bereits beim Import persistent: JEDER Importweg
(CSV/Transgourmet, Feldschlösschen, Beaulieu-PDF) speichert erkannte Änderungen
pro Monat unter `waren_preishinweise_<YYYY-MM>_v1` (Record<invoiceId,
PreisAenderung[]>, SSOT `berechnePreisAenderungen`). Auswertungen (Tab
«Preisänderungen», lib preisaenderungen.ts) dürfen NUR diese Hinweise lesen und
anreichern (Rechnung → Datum/Lieferant, Positionen → Konto/Warengruppe/Menge) —
nie neu erkennen, nie Importpfade anfassen.

**Why:** Doppelte Erkennung würde bei Re-Reads andere Ergebnisse liefern
(Historie-Stand ändert sich); die Hinweise sind der eingefrorene Import-Befund.

**How to apply:**
- Kumulierter Mehraufwand = Δ CHF × Menge mit max(Änderungsdatum, von) ≤
  Rechnungsdatum ≤ bis — Wochenansicht zählt sonst Monats-Bezüge mit (Review-FAIL 08/2026).
- «Leer statt 0»: ohne Positions-/Mengenbasis null, nie 0.
- Export-Buttons brauchen das `canExport`-Gate der Seite (Pflicht-Prop).
- Lieferant primär aus InvoiceEntry.supplierName; Fallback = Präfix des artikelKey.
