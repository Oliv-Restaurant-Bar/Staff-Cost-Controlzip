---
name: FIBU-Abgleich Buchhaltungszeilen ignorieren
description: Buchhaltungszeilen werden im Abgleich nie gelöscht, nur bewusst ignoriert — persistent, import-fest, kollisionssicherer Schlüssel; Kopf-Differenz bereinigt, Drilldown bleibt Kontrollsicht.
---

# Buchhaltungszeilen im Waren-FIBU-Abgleich ignorieren (08/2026)

**Regeln:**
- Buchhaltung = Kontrollquelle: es gibt KEIN Hart-Löschen von Buchhaltungszeilen — nur «bewusst ignoriert» im Abgleich, jederzeit per «Wieder aufnehmen» umkehrbar.
- Wiedererkennungs-Schlüssel muss kollisionssicher sein: Belegnummer ALLEIN reicht nicht (wiederholt sich über Lieferanten/Jahre). Schlüssel enthält Nr + Datum + Betrag + Lieferant/Text-Diskriminator; ohne Nummer Datum+Betrag+Text. Unbekannte/abweichende Schlüssel ⇒ Zeile bleibt SICHTBAR (fail-open, nie still ausblenden).
- Import-fest, weil Kandidaten bei jedem Journal-Load neu abgeleitet und erst DANACH gefiltert werden — nie die Rohdaten anfassen.
- Kopf-Kennzahl «Differenz» zeigt die bereinigte Zahl MIT Offenlegung (vor Ignorieren + ignorierter Betrag); der Differenz-Drilldown bleibt bewusst UNBEREINIGT (Kontrollsicht) — nicht «angleichen».
- «Löschen» einer Erfassung ≠ «Ignorieren»: Gelöschtes kommt beim nächsten Import wieder (gewollt); dauerhaft draussen = Ignorier-Listen.

**Why:** Reviewer-Vorfall: Beleg-Nr-only-Schlüssel hätte fremde Buchungen still versteckt; und eine nur teilweise gefilterte Differenz widerspricht «zählt nicht mehr».
