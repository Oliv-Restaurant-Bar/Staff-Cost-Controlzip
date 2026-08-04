---
name: PDF-Zeilen nie in feste y-Raster zwingen
description: Plan-/Tabellen-PDFs mit versetzten Grundlinien brauchen Anker-Clustering statt fixer y-Buckets
---

- **Regel:** Text-Items eines Tabellen-PDFs (pdfjs getTextContent) NIE über feste y-Rundung (z.B. 4px-Buckets) zu Zeilen gruppieren. Stattdessen: Anker-Spalte (z.B. Namensspalte links der ersten Datenspalte) nach y clustern (Gap-basiert), dann jede Datenzelle dem NÄCHSTGELEGENEN Anker per |Δy| zuordnen (Grenze ≈ ¾ des Median-Zeilenabstands).
- **Why:** Name und Zellwerte derselben Zeile liegen oft auf ~1–3px versetzten Grundlinien (unterschiedliche Fonts/Größen). Feste Buckets zerlegen die Zeile in eine Namens- und eine namenlose Wert-Zeile; werden namenlose Zeilen verworfen, verschwinden ganze Mitarbeiter/Datensätze still.
- **How to apply:** Datenbereich über y-Koordinaten des Header-INHALTS abgrenzen (nicht über Zeilen-Indizes); Summen-/Total-Zeilen als ungültige «Blocker»-Anker behalten (absorbieren Zellen, erzeugen nichts); nicht zuordenbare Zellen loggen/zählen, nie still verwerfen. Verifikation ohne Original-PDF: Text-Items via scripts/extract-pdf-items.mjs als JSON-Fixture dumpen und den Parser im Test mit gemocktem pdfjs-dist gegen das Fixture fahren.
