---
name: Gäste IN — abgeleitete Quelle & Importe
description: «Gäste IN» wird aus Umsatz ÷ Umsatz-pro-Person ABGELEITET (08/2026); getippter Personen-Import nur noch Referenz; Import-/Undo-Regeln.
---

# Gäste IN — Quelle & Importe

## Massgebliche Quelle = ABLEITUNG (User-Befehl 08/2026, ersetzt frühere Regel!)
- «Gäste IN» (alle Views: Monat/Woche/Jahr, Ø-Verkauf pro Gast, Anteil-Zeilen) = `round(IN-HOUSE-Brutto(Tag) ÷ UmsatzProPerson(Tag))`; **In-House = Gesamt-Brutto − Take-Away-Brutto** («Umsatz pro Person» ist eine In-House-Kennzahl; TA-Gäste kommen aus ihrer eigenen Quelle, NIE aus dieser Formel). SSOT `gaeste-derived.ts`. **Why:** getippte Personenzahl bei Tisch-Eröffnung war zu hoch (Beaulieu 08/2026: 4'056 statt ~3'258; Oliv +2.8 %).
- Quelle pp = KV `umsatzprogast-daily` (tenant-präfixiert, gaeste-store) aus dem Import-Typ «Umsatz/Gast (CHF pro Person)» — Gastronovi-Tagesexport mit Kopf «Durchschnitt». NICHT verwechseln mit `avgcheck-daily` = Durchschnittsbon (Ø pro BON, ~66.71, Bon-Statistik) — gleiche Datei-Kopfzeile, anderer Typ; Nutzer wählt den Typ bewusst.
- Schutzregeln: pp fehlt/0 → Tag LEER (nie ÷0, nie 0 erfinden); pp-Quelle fehlt ganz → Gäste IN leer, KEIN Rückfall auf den getippten Wert. VJ-Gäste sind daher leer, bis pp-Daten des VJ existieren (gewollt).
- Getippter Personen-Import (`gaeste-daily`) bleibt gespeichert, aber NUR als Referenz — Tooltip an der Gäste-IN-Zeile (`MrRow.hinweis`): «getippt X · abgeleitet Y · Abweichung Z%».

## Import-Regeln
- Umsatz/Gast-Import: Ersetzen PRO TAG (saveMerged), Vorschau mit Kontrolltabelle abgeleiteter Gäste je Monat, Undo-Snapshot `umsatzprogast-daily`(+`-monthly`).
- Gäste-Import (getippt) bleibt 1:1-MONATSERSATZ: `saveGaesteDailyReplaceMonths` entfernt Bestands-Tage der importierten Monate, die nicht in der Datei sind; Undo-Snapshot bei BESTÄTIGUNG aus frischem Bestand (alle Bestands-Tage der Monate ∪ Datei-Tage).
- FALLE Import-Protokoll: Nur der NEUESTE Lauf je Quelle behält seinen Snapshot — Doppel-Import derselben Quelle vernichtet den Wiederherstellungspfad (echter Datenverlust am 01.08.2026 durch E2E-Tester).
