---
name: Interne Umbuchungen & Differenz-SSOT im FIBU-Abgleich
description: «Umb.»-Präfix-Journalzeilen sind Konto-Korrekturen (keine Rechnungen); Gesamt-Differenz «erfasst vs. Buchhaltung» kommt in allen Ansichten aus EINER Quelle.
---

**Regel 1 — Umbuchungen:** Journal-Zeilen, deren Text mit «Umb.»/«Umbuchung» BEGINNT
(nur Präfix), sind interne Konto-Korrekturen. Sie gehören in KEINEN Rechnungs-Vergleich
(weder Lieferanten- noch Konto-Sicht, auch nicht in den degradierten nur-total-Modus) —
nur informativ ausweisen.
**Why:** Die Gegenseite liegt auf ausgeklammerten Konten (4701/Depot) und wird nicht
mitverglichen → Phantom-Differenzen.

**Regel 2 — Differenz-SSOT:** Die Gesamt-Differenz «erfasst vs. Buchhaltung» wird in
allen Ansichten (Abgleich UND Analyse) aus demselben Abgleich-Modell gespeist; die
klickbare Aufschlüsselung bündelt exakt in echte Lücken / interne Umbuchungen (separat)
/ Pfand-Reste mit der Invariante Lücken + Reste = Gesamt-Differenz.

**How to apply:** Neue Konsumenten des Waren-Journals für Vergleiche müssen entweder
bereits gefilterte Abgleich-Daten nutzen oder den Umbuchungs-Präfix-Check selbst
anwenden; neue Differenz-Anzeigen nie eigenständig rechnen, immer aus dem gemeinsamen
Abgleich-Modell speisen.
