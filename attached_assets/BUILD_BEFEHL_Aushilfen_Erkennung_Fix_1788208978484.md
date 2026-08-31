# Build-Befehl — Aushilfen-Erkennung reparieren (Panel zeigt fälschlich «keine Aushilfen»)

## Problem
Das Aushilfen-Panel ist jetzt da, zeigt aber **«Keine Aushilfen in dieser Woche erfasst»** — das ist
**falsch**. OLIV hat für KW35 sehr wohl Aushilfen im **Ist-Dienstplan**, z. B. **Pathi**, **Aushilfe**,
**Pizza 2 Aushilfe**, **Aushilfe 2 Küche**. Die Erkennungslogik findet sie nicht.

## Soll
**Aushilfen = Mitarbeitende, die im «Dienstplan · Ist-Stunden» (Ist-Spalte) der gewählten Woche
Ist-Stunden > 0 haben, aber NICHT in der Kontrollliste/MIRUS dieser Woche vorkommen.**
Diese müssen im Panel erscheinen (mit Datums-Chips je Tag mit Ist-Stunden).

## Debug-Checkliste (bitte alle prüfen)
1. **Quelle = Ist-Dienstplan, Ist-Spalte** — nicht nur Plan, nicht nur die Kontrolllisten-Tabelle.
   Die Aushilfe-Stunden sind manuell als **Ist** im Dienstplan erfasst (bestätigt durch den Kunden).
2. **Woche-/Datumsfilter** korrekt auf die gewählte KW (KW35 = 24.–30.08.2026). Häufiger Fehler:
   Query filtert auf Kontrolllisten-Zeitraum statt auf die Dienstplan-Ist-Woche.
3. **Namensabgleich** gegen die Kontrollliste **normalisiert** (trim, doppelte Leerzeichen,
   Gross-/Kleinschreibung). Pathi/Aushilfe dürfen nicht versehentlich «gematcht» und dadurch
   ausgefiltert werden.
4. **Keine MIRUS-Voraussetzung**: Aushilfen haben KEINEN MIRUS-Datensatz — die Query darf einen
   MIRUS-/Kontrolllisten-Eintrag NICHT voraussetzen. Genau umgekehrt: es sind die MA **ohne**
   Kontrolllisten-Eintrag.
5. **Mandant = OLIV** (nicht Beaulieu).
6. **Abteilung**: unbekannte Aushilfe → Default Küche/Service gemäss Stammdaten; kein Grund zum Ausschluss.

## Erwartetes Ergebnis (Akzeptanz)
1. Das Panel listet für OLIV KW35 die realen Aushilfen (**Pathi**, **Aushilfe**, ggf. **Pizza 2
   Aushilfe**, **Aushilfe 2 Küche** …) mit ihren **Ist-Stunden je Tag** (Datums-Chips, z. B. «Di 25.08 · 9.0 h»).
2. Häkchen (ganze Woche) + Datums-Chips (einzelne Tage) funktionieren.
3. Angehakte Aushilfe erhöht Besatzungsstunden, senkt Produktivität, erscheint im Dienstplan/
   Mitarbeiter-Zeitraum als «Aushilfe · manuell».
4. Nur wenn wirklich **keine** MA mit Ist-Stunden ohne Kontrolllisten-Eintrag existieren, erscheint
   «keine Aushilfen» — für OLIV KW35 ist das NICHT der Fall.

## Gegenprobe für den Agenten
Query im Ist-Dienstplan (OLIV, 24.–30.08): alle MA mit Σ Ist-Stunden > 0, deren Name NICHT in der
Kontrollliste (report_test) derselben Woche steht → muss Pathi/Aushilfe usw. zurückgeben, nicht leer.
