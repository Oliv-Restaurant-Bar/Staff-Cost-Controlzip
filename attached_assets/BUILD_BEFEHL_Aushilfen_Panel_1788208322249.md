# Build-Befehl — FEHLT NOCH: Aushilfen-Auswahl-Panel in «Besatzung & Produktivität»

**Kritisch: Dieses Panel wurde bereits zweimal nicht umgesetzt. Bitte jetzt genau wie im Mock-up
`besatzung_produktivitaet.html` bauen.**

## Was fehlt
Im Menüpunkt «Besatzung & Produktivität» fehlt das **Aushilfen-Auswahl-Panel** komplett. In der
Live-App gibt es aktuell keine Möglichkeit, die Ist-Stunden von Aushilfen auszuwählen/einzurechnen.

## Genau so bauen (wie Mock-up)

### 1) Panel-Position & Aussehen
- **Zuoberst im Menüpunkt**, direkt unter der Kopfzeile, **vor** dem Produktivität/Dienstplan-Umschalter.
- Eigenes, hervorgehobenes Panel: **«＋ Aushilfen — Aushilfen aus ‹Dienstplan · Ist-Stunden› ergänzen»**.
- Untertitel: «Manuell erfasst, **nicht** in der Kontrollliste. Ganze Woche = Häkchen; einzelne Tage
  = Datums-Chips anklicken. Ausgewählte Stunden fliessen in Besatzung, Produktivität und den Dienstplan.»

### 2) Inhalt DYNAMISCH aus echten Daten (NICHT die Demo-Namen!)
- **Meyer T. / Koch B. waren nur Platzhalter im Mock-up.** Nicht hardcoden.
- Das Panel listet **alle Mitarbeitenden, die im Menüpunkt «Dienstplan · Ist-Stunden» (manuell/Ist)
  Stunden in der gewählten Woche haben, aber NICHT in der Kontrollliste/MIRUS vorkommen** = Aushilfen.
- Je Aushilfe eine Zeile: Name · Abteilung (Küche/Service) · gewählte Stundensumme + Datums-Chips
  je Tag mit Ist-Stunden (z. B. «Fr 28.08 · 6.5 h»).
- Gibt es in der Woche **keine** solchen Aushilfen: Hinweis anzeigen «Keine Aushilfen in dieser Woche
  erfasst» — nicht einfach leer/weglassen.

### 3) Auswahl pro Tag ODER ganze Woche
- **Häkchen** auf der Aushilfe-Zeile = ganze Woche (alle Tage mit Ist-Stunden).
- **Datums-Chip** anklicken = nur dieser Tag. Chip an/aus umschaltbar.
- Auswahl **pro Mandant merken**.

### 4) Ausgewählte Aushilfe-Stunden fliessen ein in:
- **Besatzungsstunden** (KPI + Diagramm-Balken),
- **Produktivität** (Umsatz ÷ Besatzungsstunden — sinkt entsprechend),
- **Dienstplan/Wochenmatrix + Mitarbeiter-Zeitraum** — die Aushilfe erscheint dort an den gewählten
  Tagen, klar markiert **«Aushilfe · manuell»** als **Stunden-Badge** (keine Von-Bis-Stempelzeit).
- KPI-Untertitel «Besatzungsstunden» = «Kontrollliste + Aushilfe», wenn welche gewählt sind.

## Datenquelle (wichtig)
Massgeblich für Produktivität/Besatzung ist der **Ist-Dienstplan (alle Ist-Stunden, MIRUS + manuell)**
— nicht nur die Kontrollliste. Aushilfen sind die manuell erfassten Ist-Stunden, die nicht aus der
Kontrollliste stammen.

## Akzeptanzkriterien
1. Das blaue Aushilfen-Panel ist sichtbar, zuoberst, wie im Mock-up.
2. Es zeigt die **echten** Aushilfen der Woche (dynamisch), nicht Demo-Namen; leere Woche → Hinweis.
3. Häkchen (Woche) und Datums-Chips (Tag) funktionieren; Auswahl wird gemerkt.
4. Angehakte Aushilfe erhöht Besatzungsstunden, senkt Produktivität und erscheint im Dienstplan/
   Mitarbeiter-Zeitraum als «Aushilfe · manuell».
5. Optisch deckungsgleich mit `besatzung_produktivitaet.html`.
