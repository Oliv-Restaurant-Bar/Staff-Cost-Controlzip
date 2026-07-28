---
name: Monatsreport Quellen & Regeln
description: Datenquellen und Leerzellen-Regel des Monatsreports (Startseite für Admins)
---
Monatsreport (`src/lib/monatsreport.ts`, Startroute `/` für Admins; alte StartOverview → `/startuebersicht`).

Regeln:
- Fehlende Quelle ⇒ Zelle **leer (null)**, nie 0. **Why:** Meeting-Report darf keine erfundenen Nullen zeigen.
- «Monat» = Ist bis heute (laufender Monat), ganzer Monat (Vergangenheit), leer (Zukunft) — gilt auch für Zähl-Quellen wie Gruppen ≥20 Pax (Reservationen sonst zukunftsverzerrt).
- «Woche» nur im laufenden Monat; Budget-Wochenanteil via Wochentagsgewichte (`ladeWochentagsGewichte`).
- Brutto Plan = Netto-Budget × 1.081 (Ableitung, wie KennzahlenBericht).
- Bewusst leer in Etappe 1: Gäste Take Away, Durchschnittsverkauf TA (keine TA-Gäste-Quelle); Warenaufwand/Lieferanten = spätere Etappe.
- Gäste-Kennzahlen (Juli 2026): «Gäste IN» = manueller GÄSTE-Import (gaeste-daily-KV, Zeile «Gesamt», Zeitraum-Total massgeblich, ganzzahlig abgeglichen; Soll Juli 8'584); «Durchschnittsverkauf» = importierter Zeitraum-Wert (avgcheck-monthly-KV, Zeile «Durchschnitt»; Soll 53.47), NICHT berechnet — VJ ebenfalls aus avgcheck-monthly; «Umsatz pro Gast» = BERECHNET netto/Gäste; «Wein/Spirituosen» ENTFERNT (kein Z-Bericht mehr im Report). Parser/Store: src/lib/gaeste-import.ts + gaeste-store.ts (Merge-Save mit kvGetStrict-Remote-Basis).
- Neue Nav-Einträge mit `beaulieuAllowed` brauchen Routen mit `RequireAdmin allowBeaulieu`, sonst dead links für beaulieu_manager.
