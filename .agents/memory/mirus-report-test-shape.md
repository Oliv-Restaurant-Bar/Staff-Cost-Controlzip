---
name: MIRUS report_test Echtdaten
description: Nicht offensichtliche Struktur echter Kontrolllisten-Exporte gegenüber synthetischen Workbooks.
---

Echte `report_test`-Exporte dürfen zusätzliche Spalten rechts der 30 fachlich erwarteten Spalten enthalten. Die festen Quellspalten bleiben massgeblich; zusätzliche Exportmetadaten sind kein Ablehnungsgrund.

**Why:** Die freigegebenen OLIV-/Beaulieu-Dateien hatten 32 Spalten. Eine Prüfung auf exakt 30 Spalten wies beide echten Dateien ab.

**How to apply:** Mindestens 30 Spalten verlangen und weiterhin nur die definierten festen Spalten lesen.

Mitarbeiter-Kopfzeilen können von der Namensspalte über die Datumsspalte hinaus verbunden sein. Nach Auflösung des Merge-Ankers enthält deshalb auch die Datumsspalte den Mitarbeiternamen.

**Why:** Eine Leertext-Prüfung der aufgelösten Datumsspalte übersprang sämtliche Mitarbeitenden in den echten Dateien.

**How to apply:** Mitarbeiter-Kopfzeilen daran erkennen, dass ein Name vorhanden und der aufgelöste Datumswert nicht positiv numerisch ist.