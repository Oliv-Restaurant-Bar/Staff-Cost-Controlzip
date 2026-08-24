---
name: PDF-Artikeldetail MwSt-Rundung
description: Regel für Rechnungsprofile, die echte Artikelpositionen und gedruckte MwSt-Klassensummen kombinieren.
---

Bei PDF-Artikeldetails reicht es nicht, nur die Netto-Positionssumme gegen den Rechnungskopf zu prüfen. Auch jede gedruckte MwSt-Klasse muss mit ihren Artikel-Netto- und MwSt-Summen abgeglichen werden. Kleine Differenzen aus Einzelzeilen-Rundung werden deterministisch auf eine echte Position derselben Steuerklasse gelegt; nicht deckende Klassen werden fail-closed verworfen.

**Why:** Lieferanten können MwSt pro Klasse runden, während der Parser MwSt zunächst je Artikel rundet. Selbst bei korrektem Netto entstehen sonst Rappen-Differenzen im persistierten Brutto und in Konto-Splits.

**How to apply:** Bei neuen oder erweiterten PDF-Profilen die gedruckten Steuerklassen-Basen und -Beträge als autoritativ behandeln, Klassen-Netto mit maximal CHF 0.05 Toleranz prüfen und Tests für Kopf-, Lieferungs- und persistierte Positions-Bruttosummen ergänzen.