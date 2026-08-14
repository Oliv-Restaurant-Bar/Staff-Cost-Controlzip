---
name: Tagesdaten-Einheitsimport
description: Ein Upload mit Auto-Typerkennung (Gäste/Durchschnitt/Umsatz/Marketing) + Jahr-Dropdown im Import-Center; Speicher- und Sperr-Regeln.
---

# Tagesdaten-Einheitsimport (Import-Center)

- EIN Upload (TagesdatenImportSection, id `umsatz-ist`) ersetzt die alten Karten Umsatz-Ist/Vorjahr, Maison, Gäste, Durchschnitt. Erkennung zentral in `tagesdaten-auto-import.ts`, Parser werden NICHT dupliziert.
- Erkennungs-Reihenfolge: gaeste («Gesamt» + «… P.») → marketing («marketing»-Zeile, VOR umsatz!) → durchschnitt («Durchschnitt» MIT CHF) → umsatz (Gesamt/Food/Beverage/Take-Away MIT CHF). Mehrheitsregel: «Durchschnitt»-Zeile + ≥2 CHF-Kategorien ⇒ umsatz. Nicht eindeutig ⇒ null, kein Import.
- Jahr kommt AUSSCHLIESSLICH aus dem Dropdown (Spalten sind nur «TT.MM.»); keine Silvester-/Zeitraum-Heuristik. Kalendervalidierung: ungültige Tage (29.02. ausserhalb Schaltjahr etc.) werden ausgeschlossen und in der Vorschau als Warnung gelistet — auch von Parsern «gerollte» Daten filtern.
- Pflicht-Vorschau (Typ, Jahr, Bereich, Tage, Monatstotale) — vor Bestätigung keine Writes.
- Umsatz-Speicherung via `gastronovi-daily-save.ts::commitGastronoviDays`: Jahr==aktuell → actual (dailyBudgets); Jahr<aktuell → previous_year = DOPPELZIEL dailyBudgets.previousYearRevenue UND vj_daily (upsertVjDailyBatch, Schema/Prefix wie VjDailyImportSection). **Why:** monatsreport/daily-actuals lesen VJ aus vj_daily — nur previousYearRevenue zu schreiben macht Importe unsichtbar.
- vj_daily-Records tragen optional `takeawayRevenue` (nur >0 gesetzt; Alt-Records ohne Feld = VJ-TA-Anteil bleibt leer, Re-Import nötig). Der VJ-Zweig im Monatsreport muss jede neue Kennzahl explizit summieren — Food/Bev gefüllt heisst nicht, dass TA mitkommt.
- prior-year-lock (getLockState) wird zentral in commitGastronoviDays geprüft (blocked ⇒ gar keine Writes). Auch die manuelle Tageserfassung (ManualEntryCard) geht im previous_year-Fall über commitGastronoviDays — jeden neuen Vorjahres-Schreibpfad dort anbinden, sonst SSOT-Divergenz.
- Datentyp ist PFLICHT-WAHL des Nutzers (Select umsatz-ist/umsatz-vj/gaeste/marketing/durchschnitt); Auto-Erkennung + Dateiname («Anzahl/Gäste/Pax»→gaeste, gewinnt vor Inhalt) sind NUR Vorschlag. **Why:** eine Gästezählung ohne «P.»-Suffix («Anzahl Oliv 07.2026.xlsx», ganze Zahlen) wurde von der Inhalts-Erkennung als Umsatz verbucht.
- Plausibilitäts-Riegel via analyzeWertemuster: umsatz+anzahl-Muster = HARTER Block (istHartBlockiert, keine Bestätigung möglich); andere Widersprüche (gaeste+chf etc.) verlangen eine Pflicht-Checkbox in der Vorschau. Umsatz-Wahl muss zum Jahr passen (umsatz-ist ⇔ laufendes Jahr), sonst Block vor dem Parsen.

## Gruppierungszeilen & Vorjahres-Kategorien (Aug 2026)
- `GastronoviDayResult.takeAway` ist OPTIONAL: `undefined` = Datei ohne Take-Away-Zeile («nicht geliefert» → bestehende takeawayRevenue nie überschreiben), `0` = Zeile vorhanden, echter Tageswert (ersetzt Bestand). Konsumenten müssen auf `!== undefined` prüfen.
- `commitGastronoviDays(previous_year)` schreibt zusätzlich `actualFood`/`actualBeverage` (nur >0) + `takeawayRevenue` in dailyBudgets — vergangenes Jahr = Ist dieses Jahres + Quelle des dynamischen Vorjahrs; `actualRevenue` bleibt unangetastet.
- **Why:** `upsertVjDailyBatch` ersetzt den GANZEN Record pro Tag → vj_daily-Bestand des Jahres MUSS vor dem ersten Write strikt gelesen (`loadVjDailyYearStrict`, Fehler = Abbruch ohne Writes) und feldweise gemerged werden, sonst löscht ein Import ohne Kategorienzeilen bestehende Food/Bev/TA-Werte.
- Monatsreport-Overlay `istAlsVjRecord` merged feldweise mit dem vj_daily-Record des Tages (Monat + Woche) — Ist-Überlagerung darf vorhandene Kategorien nie verdecken.
- Jahres-Lock blockiert ALLE Ziele (auch actual) — Test, der das Gegenteil erwartet, ist veraltet.

## Striktes Zahl-Parsing (nie NaN/stilles 0)
Alle Tagesdaten-Parser (Gäste/Durchschnitt/Marketing/Umsatz) parsen Zellen strikt über den zentralen Betrags-Parser: unlesbare Zellen werden NIE als 0/NaN gespeichert, sondern als «unlesbare Werte» (Zeile/Spalte/Rohwert) gesammelt — die Import-UI blockiert den Import hart (Button + Guard im Save-Pfad), bis das Format geklärt ist. Leer/«-» ⇒ null (leer statt 0), nie 0. «1.234» wird bewusst als deutsche Tausendergruppe (=1234) gelesen.
**Why:** parseFloat-Präfix-Parsing («123abc»⇒123) und isNaN⇒0-Fallbacks haben falsche Tageswerte erzeugt; Vorschau zeigte «CHF NaN».
**How to apply:** Jeder neue/geänderte Tagesdaten-Parse-Pfad (auch Legacy-Karten wie die Gastronovi-Import-Karte!) muss den Sammler durchreichen und bei nicht-leerem Sammler blockieren — nie einen Aufrufer ohne Block lassen.

## Umsatz-Vorschau & Label-Matching
- Monatstotale der Umsatz-Vorschau = BRUTTO-Summe der «Gesamt»-Zeile (gegen die Quelldatei kontrollierbar); nie via UmsatzTag/summiereUmsatz aus Import-Rohzeilen bauen — UmsatzTag verlangt ALLE Felder als Zahl, ein undefined takeAway ergibt NaN («CHF NaN»).
- Zeilen-Labels flexibel, aber mit Neutral-Guard: Non-Foods/Aufladung Kundenkarten/Trinkgeld/Rundungsdifferenzen/Rabatte sind NIE eigene Kategorien («Non-Foods» matcht sonst includes('food') als Food). Gilt für revenue-parser UND den separaten VJ-Import (VjDailyImportSection hat einen EIGENEN Parser — bei Parser-Härtungen immer beide Pfade prüfen).
- «None»/«null»-Platzhalter aus Exporten = leer (kein Wert), nicht unlesbar.

## Zeitraum-Spalte NIE zur Skalierung
- Die Spalte «Zeitraum»/«Gesamtbetrag im Anzeigezeitraum» deckt den GANZEN Anzeigezeitraum ab, auch wenn die Datei nur einen Teil der Tage als Spalten enthält. Ein proportionaler Abgleich der Tageswerte auf dieses Total blähte alle Tage auf (08/2026: Faktor ×2.62 bei 4 Tagesspalten). **Regel:** Tagesspaltenwerte immer 1:1 speichern; Zeitraum-Total nur Info/Kontrolle (zGesamt nur für hasGesamt-Erkennung). Regressionstest: revenue-parser-noscale.test.ts.
