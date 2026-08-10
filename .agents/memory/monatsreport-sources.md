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

## Daten-Stichtag statt Hochrechnung (08/2026)
- Monats-Sicht: Stichtag = min(letzter Umsatz-Tag, letzter MIRUS-Ist-Stunden-Tag) aus dem PK-Kern (pk.istTage/umsatzIstProTag); nur eine Quelle vorhanden → deren letzter Tag; abgeschlossener Monat = Monatsletzter; nie > heute. Kopf zeigt «Stand bis TT.MM.JJJJ» (standBis in MonatsreportDaten).
- ALLE Monats-Ist (Umsatz, Gäste, Ist-Stunden, Ø-Verkauf-Fallback) und die Cockpit-Budget-pro-rata klemmen auf standIso. Personalkosten-Zeile = personalkosten('istBisHeute',{stichtag}) — KEINE Hochrechnung mehr; PKQ = Ist÷Ist mit demselben Stichtag. Reservationen/TA-Gäste/Reviews bleiben bewusst ganzer Monat (geplante Zukunft zählt); Wochen-Spalte bleibt «bis heute» geklemmt.

## Budget-Umschalter Stichtag/voller Monat (08/2026)
- Monats-Budgetspalte umschaltbar: 'stichtag' (Default, Budget anteilig standTag/daysInMonth) vs. 'monat' (volles Monatsbudget); Ist bleibt IMMER bis Stichtag. Modus sessionStorage pro Mandant.
- **Ratio-Positionen (kind 'ratio': Ø-Verkauf, PKQ, Produktivität, TA-Anteil) IMMER aus der vollen Monatsauflösung (ckMFull)**, nie aus der pro-rata-Auflösung — deren Ratio-Fallbacks verzerren, weil Zähler/Nenner ungleich anteilig sind (Gäste kalendertag-anteilig vs. Umsatz tagesgewichtet).
- Wochen-Budgets bleiben unberührt (ckW); Warenkosten-sollMonat (Ist-basiert) und reviewZielBudget bewusst nicht umgeschaltet.
- «vs. VJ» nur wo KEIN Budget hinterlegt (08/2026): Anteil-Zeilen (sharePct, z.B. Gäste Take Away) rechnen Δ gegen das Perioden-Budget, sobald eines existiert; Ausnahme fmt='countPax' (Gruppen ab 20 Pax: Budget in Personen, Wert in Anzahl Gruppen → weiter vs. VJ). Regel gilt in Bildschirm-Tabelle, Wochen-Zellen UND Excel-Export (Export-Prädikat synchron halten!).
- Stichtag-Selektor (08/2026): Modus «bis Stichtag» hat manuellen Datums-Override (Ist UND Budget klemmen auf gewählten Tag; Reset bei Monats-/Mandantenwechsel). Anteilige absolute Budgets rechnen KALENDERTAG-anteilig aus der vollen Monatsauflösung (Monatsbudget × Tag ÷ Monatstage) — die frühere tagesgewichtete pro-rata-Auflösung (resolveCockpitBudgets fromIso..standIso) ist bewusst entfernt. Gilt für ALLE Absolutwerte inkl. Rezensions-Budgets; Ratio-KPIs nie kürzen.
