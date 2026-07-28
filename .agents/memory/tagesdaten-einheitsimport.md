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
- prior-year-lock (getLockState) wird zentral in commitGastronoviDays geprüft (blocked ⇒ gar keine Writes). Auch die manuelle Tageserfassung (ManualEntryCard) geht im previous_year-Fall über commitGastronoviDays — jeden neuen Vorjahres-Schreibpfad dort anbinden, sonst SSOT-Divergenz.
