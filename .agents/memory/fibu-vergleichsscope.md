---
name: FIBU-Lieferanten-Vergleich Konto-Scope 4020–4070
description: Warenaufwand-Abgleich erfasst↔Buchhaltung läuft NUR über 4020–4070; 4000/4090 sind aussen vor.
---

**Regel:** Der FIBU-Warenaufwand-Lieferanten-Vergleich (buildWarenAbgleich + fibuVergleichsNetto + Auto-Matching) läuft AUSSCHLIESSLICH über die Vergleichskonten 4020–4070 (`istFibuVergleichsKonto` in waren-klassen.ts) — auf BEIDEN Seiten, grenzen-unabhängig (auch bei WKQ-Grenze ≠ 4090).

**Why:** Beaulieu-Konto 4000 ist ein Prodega-LSV-Durchlaufkonto: jede Lieferung wird 2× gebucht (+Rechnung/−Lastschrift), der Saldo ist reines Clearing und erzeugte eine Phantom-Differenz von −5'606.08 (08/2026). 4090 (Übrige/Nonfood) hat keine Rechnungs-Vergleichsbasis.

**How to apply:**
- Rechnungen mit fibuVergleichsNetto 0 (reine 4000/4090/4701-Rechnungen) gehören auf KEINE Vergleichsseite (sonst falsche «nur-erfasst»-Zeile) und sind NICHT matchbar (Phase-0-Referenz-Match hat keine Betragsprüfung).
- Status-Toleranz = max(schwelle, 0.1 % des grösseren Betrags) — grosse Lieferanten mit Pfand-/Rundungsresten bleiben grün.
- «Barausgaben Prodega» (Bar-Einkäufe auf 4060) ist per Nutzer-Alias in der Beaulieu-Gruppe «Prodega / Transgourmet» — bewusst, da die Erfasst-Seite diese Einkäufe enthält; Alias nicht entfernen.
- Kontoblatt-/Konto-Abgleich (Kontrollsicht) bleibt bewusst UNGEFILTERT.
- Splitlose kontolose/«offen»-Rechnungen zählen weiter Legacy-voll; splitlose Betriebskosten-Singles (4701) behalten volles amountNet (Bestandsverhalten).
