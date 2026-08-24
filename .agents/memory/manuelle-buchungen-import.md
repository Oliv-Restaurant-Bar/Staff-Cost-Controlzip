---
name: Manueller Buchungsimport
description: Robuste CSV/Text-Eingabe für manuelle Buchungen mit optionalem Header und Kommentarzeilen.
---

Der manuelle Buchungsimport muss vor der Header-Prüfung BOM, Leerzeilen und `#`-Kommentare entfernen. Der Header ist tolerant (Groß-/Kleinschreibung, Feld-Whitespace und `MwSt%`/`MwSt %`/`MwSt-%`) und darf fehlen, wenn die erste Nutzzeile neun valide Felder hat.

**Why:** Externe CSV-/Text-Exporte enthalten häufig Kommentare, Leerzeilen oder abweichende Header-Schreibweisen; diese dürfen nicht zu einem falschen Strukturfehler führen.

**How to apply:** Datenzeilen weiter trimmen, Kommentare/Leerzeilen ignorieren und Dezimalpunkt sowie Dezimalkomma akzeptieren. Mandanten- und Belegschlüssel sowie Vorschau/Undo nicht umgehen.