# Build-Befehl — «Besatzung & Produktivität»: Mitarbeiter-Zeitraum an das freigegebene Mock-up angleichen

Die Live-Ansicht «Mitarbeiter-Zeitraum» (und teils die Schichten-Gantt) entspricht **nicht** dem
freigegebenen Mock-up `besatzung_produktivitaet.html`. Bitte 1:1 an das Mock-up angleichen. Die
folgenden Punkte sind verbindlich.

## 1) NUR Mitarbeitende anzeigen, die gearbeitet haben
- In **jeder** Ansicht (Schichten-Gantt, Mitarbeiter-Zeitraum, Tages-Detail): Mitarbeitende mit
  **0.0 Netto-Stunden im jeweiligen Zeitraum ausblenden** — keine leeren Zeilen.
  - Aktuell falsch: Blaku Artin 0.0 h, Batushaj Brahim 0.0 h, Collazo 0.0 h, Dzhymsheleishvili 0.0 h
    (an Tagen ohne Schicht) usw. erscheinen. Das darf **nicht** sein.
- **Tagesansicht:** nur MA mit Schicht an **diesem** Tag.
- **Wochenansicht (ein MA):** nur die **Arbeitstage** dieser Woche (freie Tage weglassen, nicht als
  leere Zeile).
- **Monatsansicht (ein MA):** nur MA mit Stunden im Monat; je MA nur die Arbeitstage, nach KW gruppiert.

## 2) Zeitachse
- **Beginn 07:00** (nicht 00:00), Ende bis ~**02:00** (Schichten nach Mitternacht sichtbar).
- **Mehr Uhrzeiten:** Raster (Gridlines) stündlich, Beschriftung mind. alle 2 h, gut lesbar.
- **Von-Bis mittig ÜBER dem Balken** (wie Mock-up), nicht im/neben dem Balken.
- Rote Umrandung = **≥ 9 Netto-Std** oder Ende **nach Mitternacht**; 30-Min-Merge (Pause > 30 Min = zwei Balken).
- Links je Zeile die **Netto-Stunden**.

## 3) Ansicht/Zeitraum-Auswahl oben — konsistent mit dem übrigen Cockpit
Umschalter **Woche / Monat / Jahr** (wie die Cockpit-Tabs), zusätzlich zur Produktivität/Dienstplan-
Umschaltung. Und die **drei Detail-Ansichten** aus dem Mock-up:
- **a) Pro Tag:** alle MA, die an diesem Tag gearbeitet haben, gruppiert nach **Küche / Service**.
- **b) Pro Mitarbeiter · Woche:** die Arbeitstage der gewählten Woche untereinander (MA per Dropdown).
- **c) Pro Mitarbeiter · Monat:** jeder Arbeitstag einzeln, nach KW gruppiert (MA per Dropdown).
Umschalter **KW / Monat** je gewähltem Mitarbeiter — genau wie im Mock-up.

## 4) Aushilfen aus Ist-Stunden — FEHLT aktuell komplett!
Das Häkchen-Panel **«Aushilfen aus Dienstplan · Ist-Stunden ergänzen»** aus dem Mock-up ist in der
Live-App **nicht vorhanden**. Bitte übernehmen:
- Aushilfen sind **manuell** erfasst und kommen **nicht** über Kontrollliste/MIRUS.
- Auswahl **pro Tag oder ganze Woche** (Häkchen + Datums-Chips, z. B. «Fr 21.08 · 6.5 h»).
- Ausgewählte Aushilfe-Stunden fliessen in **Besatzungsstunden, Produktivität und den
  Mitarbeiter-Zeitraum/Dienstplan** ein — markiert «Aushilfe · manuell» als **Stunden-Badge**
  (keine Von-Bis-Stempelzeit).
- Quelle der Stunden: der **Ist-Dienstplan** (alle Ist-Stunden, MIRUS + manuell) — nicht nur die Kontrollliste.

## 5) Darstellung 1:1 wie Mock-up `besatzung_produktivitaet.html`
- Layout, Farben, Von-Bis über dem Balken, Netto-Stunden links, rote Nacht/Überstunden-Umrandung,
  klickbares **Tages-Detail** (Umsatz + Produktivität vs. Budget 100 + Mitarbeiter-Zeitlinie),
  Diagramm «Umsatz & Produktivität pro Tag» (goldene Umsatz-Balken + grüne Produktivitätslinie +
  rote Budget-Linie 100).

## Akzeptanzkriterien
1. Keine Zeile mit 0.0 h irgendwo — nur wer gearbeitet hat, erscheint.
2. Zeitachse startet 07:00, stündliches Raster, Von-Bis über dem Balken.
3. Woche/Monat/Jahr-Umschalter oben; Einzel-MA mit KW/Monat; Tages-Ansicht mit allen MA des Tages.
4. Aushilfen (Ist-Stunden, nicht aus Kontrollliste) per Häkchen ergänzbar und überall mitgezählt.
5. Optisch deckungsgleich mit dem freigegebenen Mock-up.
