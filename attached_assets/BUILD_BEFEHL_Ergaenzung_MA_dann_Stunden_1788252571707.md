# Build-Befehl — Aushilfen/Ergänzung NEU: «erst Mitarbeiter, dann Stunden» + Modell erweitern

## Kernkorrektur des Verständnisses
Die Ergänzung ist **NICHT nur** für Mitarbeitende, die ganz in der Kontrollliste fehlen (Pathi,
Aushilfe). Sie ist für **ALLE manuell erfassten Ist-Stunden, die NICHT in der Kontrollliste stehen**
— auch bei **regulären** Mitarbeitenden mit **Zusatztagen**.

**Beispiel (muss funktionieren):** **Domi Sadete** — die Kontrollliste enthält Mo–Fr. Sie hat aber
**zusätzlich am Sa und So** gearbeitet und diese Stunden **manuell im Ist-Dienstplan** erfasst
(ohne MIRUS). Diese Sa/So-Stunden müssen sich ergänzen lassen. Aktuell findet das Panel «keine
Aushilfen», weil es nur nach komplett fehlenden MA sucht — das ist zu eng.

## Neues UX-Modell: erst Mitarbeiter wählen, dann Stunden
1. **Schritt 1 — Mitarbeiter wählen:** Liste/Dropdown aller Mitarbeitenden, die **ergänzbare
   manuelle Ist-Stunden** haben (siehe Definition unten). Das sind sowohl reine Aushilfen (Pathi,
   Aushilfe, Pizza 2 Aushilfe …) als auch reguläre MA mit Zusatztagen (z. B. Sadete).
2. **Schritt 2 — Stunden/Tage wählen:** nach der MA-Auswahl dessen **ergänzbare Tage** als
   Datums-Chips zeigen (z. B. Sadete «Sa 29.08 · X h», «So 30.08 · Y h») → per Chip/Häkchen
   auswählen. Ganze Auswahl = alle ergänzbaren Tage; einzeln = Chips anklicken.
3. Ausgewählte manuelle Stunden fliessen in **Besatzung, Produktivität und Dienstplan/Mitarbeiter-
   Zeitraum** ein, markiert «manuell» / «Aushilfe».

## Definition «ergänzbare manuelle Ist-Stunden» (Erkennung)
Pro Mitarbeiter und Tag:
`ergänzbar = Ist-Dienstplan-Iststunden(MA, Tag) − Kontrolllisten-Stunden(MA, Tag)`
- Ist das Ergebnis **> 0** und stammt der Überschuss aus **manueller** Erfassung (nicht MIRUS),
  ist dieser Tag ergänzbar.
- So werden **beide** Fälle gefunden:
  - **Pathi / Aushilfe** (kein Kontrolllisten-Eintrag → alle ihre Ist-Tage ergänzbar),
  - **Sadete** (Kontrollliste Mo–Fr vorhanden → nur die zusätzlichen manuellen **Sa/So** ergänzbar).
- Quelle immer die **Ist-Spalte** des Dienstplans der gewählten Woche (OLIV), nicht Plan.

## Keine Doppelzählung
- Tage, die bereits aus der Kontrollliste kommen (Sadete Mo–Fr), bleiben unverändert und werden
  **nicht** ein zweites Mal ergänzt. Nur der manuelle Überschuss (Sa/So) wird hinzugefügt.

## Akzeptanzkriterien
1. **Domi Sadete** ist im Panel wählbar; nach Auswahl erscheinen ihre **Sa + So** als Chips mit den
   manuell erfassten Stunden; angehakt fliessen sie in KW35 Besatzung/Produktivität/Dienstplan ein.
2. **Pathi / Aushilfe / Pizza 2 Aushilfe** erscheinen mit ihren manuellen Ist-Tagen (nicht mehr «keine»).
3. Reihenfolge im UI: **erst MA wählen, dann Stunden/Tage**.
4. Kontrolllisten-Tage werden nicht doppelt gezählt; Produktivität sinkt korrekt um die ergänzten Stunden.
5. Auswahl pro Mandant/Woche gemerkt.
