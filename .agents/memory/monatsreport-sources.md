---
name: Monatsreport Quellen & Regeln
description: Datenquellen und Leerzellen-Regel des Monatsreports (Startseite für Admins)
---
Monatsreport (`src/lib/monatsreport.ts`, Startroute `/` für Admins; alte StartOverview → `/startuebersicht`).

Regeln:
- Fehlende Quelle ⇒ Zelle **leer (null)**, nie 0. **Why:** Meeting-Report darf keine erfundenen Nullen zeigen.
- «Monat» = Ist bis heute (laufender Monat), ganzer Monat (Vergangenheit), leer (Zukunft) — gilt auch für Zähl-Quellen wie Gruppen ≥20 Pax (Reservationen sonst zukunftsverzerrt).
- Budget-Wochenanteil via Wochentagsgewichte (`ladeWochentagsGewichte`); Wochen-Zeitraum-Regel siehe Abschnitt «Wochenübersicht: volle ISO-Woche» unten.
- Brutto Plan = Netto-Budget × 1.081 (Ableitung, wie KennzahlenBericht).
- Bewusst leer in Etappe 1: Gäste Take Away, Durchschnittsverkauf TA (keine TA-Gäste-Quelle); Warenaufwand/Lieferanten = spätere Etappe.
- Gäste-Kennzahlen (Juli 2026): «Gäste IN» = manueller GÄSTE-Import (gaeste-daily-KV, Zeile «Gesamt», Zeitraum-Total massgeblich, ganzzahlig abgeglichen; Soll Juli 8'584); «Durchschnittsverkauf» = importierter Zeitraum-Wert (avgcheck-monthly-KV, Zeile «Durchschnitt»; Soll 53.47), NICHT berechnet — VJ ebenfalls aus avgcheck-monthly; «Umsatz pro Gast» = BERECHNET netto/Gäste; «Wein/Spirituosen» ENTFERNT (kein Z-Bericht mehr im Report). Parser/Store: src/lib/gaeste-import.ts + gaeste-store.ts (Merge-Save mit kvGetStrict-Remote-Basis).
- Neue Nav-Einträge mit `beaulieuAllowed` brauchen Routen mit `RequireAdmin allowBeaulieu`, sonst dead links für beaulieu_manager.

## Wochenübersicht: volle ISO-Woche (monatsübergreifend)
- Die Wochen-Spalte zeigt die VOLLE ISO-Woche, auch über Monats-/Jahresgrenzen; geklemmt wird nur an der Ist-Grenze «heute» (laufende Woche).
- **Why:** KW 31 (27.07.–02.08.) auf den Monat zu beschneiden verfälschte Ist/Budget-Vergleiche; User-Vorgabe 08/2026.
- **How to apply:** Jeder Wochentag zieht Ist UND Budget aus SEINEM Monat/Jahr (Fremdmonats-Daten nachladen: Rechnungen, Plan/Ist-Stunden, PK-Kern, Tages-Budgets; Cockpit-Budgets pro Jahres-Segment auflösen — CHF summieren, % ER-Netto-gewichtet). Wochen-Summen nie aus den Monats-Loops filtern, sondern eigener Loop über die Wochentage.
- Warenkosten & Wareneinsatz sind EINE Zeile (Ist = Warenkosten total, Soll = WEQ-% × Ist-Netto; WEQ-Quote je Monat aus Cockpit-Wareneinsatz ÷ ER-Netto, Fallback Ziel-WKQ); separate Wareneinsatz- und Betriebskosten-Zeilen wurden bewusst entfernt (auch im Export/Wochenverlauf).
- PK/PKQ-Budgets NUR aus dem Cockpit-Budget-Store — der alte 35.5-%-Fallback aus dem Personal-Modul darf nicht zurückkommen; leer statt 0.
