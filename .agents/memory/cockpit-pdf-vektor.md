---
name: Cockpit-PDF-Export (Raster 1:1 + optionaler Waren-Block)
description: Aktuelle Regel für den Cockpit-PDF-Export — 1:1-DOM-Raster der aktiven Ansicht plus optionaler Waren-Block; die frühere «alles Vektor»-Regel ist überholt.
---

# Cockpit-PDF-Export

**Regel (08/2026, User-Entscheid):** Die aktive Cockpit-Ansicht wird 1:1 «wie angezeigt» exportiert — DOM-Raster via html2canvas (`cockpit-pdf-export.ts`, CSS-Klassen `.pdf-hide`/`.pdf-only`), NICHT als nachgebautes Vektor-Layout. Zusatzseiten «Letzte 4 Wochen» und «Wochenverlauf» bleiben Vektor-Modelle (`cockpit-report-pdf.ts`).

**Why:** User verlangte explizit, dass das PDF exakt der App-Ansicht entspricht (Farben, Badges, Δ-Vorzeichen); der frühere Voll-Vektor-Ansatz wich sichtbar ab.

**How to apply:**
- Vor JEDEM Export fragt ein Dialog «Waren-Block mitexportieren?» (Ja/Nein).
- Waren-Block (`cockpit-waren-block.ts`): 3 Seiten via jspdf-autotable (Lieferanten-Übersicht, Tagesverlauf kumuliert, Anomalie pro KW). Zahlenbasis = direkter Warenaufwand 4020–4070 via `direktAnteilNet` (Splits pro Konto, Pfand neutral), Umsatz = Netto-SSOT, Ignore-Liste gefiltert.
- EINE Periodenbasis für ALLE Aggregationen (nur Tage ≤ heute) — sonst weichen Lieferantensumme und Total ab; «leer statt 0» bei 0-Direktanteil.
- `CockpitExportPart` kennt `kind:'zeichner'` (freier jsPDF-Zeichner, fügt selbst Seiten an).
- html2canvas ist jetzt als Dependency deklariert.
