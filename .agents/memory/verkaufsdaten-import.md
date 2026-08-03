---
name: Verkaufsdaten Food/Beverage-Jahresimport
description: Gastronovi-Artikel-Jahresexporte (4 Dateien) → Cockpit Food/Beverage Ist + Vorjahr; Zero- und Merge-Regeln.
---

# Verkaufsdaten Food/Beverage-Import (src/lib/verkaufsdaten-import.ts)

- Quelle: 4 Tab-getrennte Jahresdateien (Food/Beverage × Umsatz/Anzahl); für Umsatz/Anzahl zählt die «Gesamt - …»-Zeile. Kategorie/Typ aus Inhalt (CHF-Präfix = Umsatz), Dateiname nur Fallback.
- Speicherziele: dailyBudgets.actualFood/actualBeverage (NUR diese Felder, alle Jahre — Cockpit liest per Datum); vj_daily.foodRevenue/beverageRevenue nur für Jahre < aktuell (dynamisches Vorjahr); Archiv-Blob `verkaufszahlen_{jahr}` (tenant-präfixiert, Umsatz + Anzahl) als Vorschau-/Diff-Basis.
- **Explizite 0 ≠ leere Zelle:** 0 ist ein echter Tageswert und ersetzt Bestand; nur leere Zellen bedeuten «nicht geliefert». Feld-Zuweisungen deshalb mit `!== undefined`, nie `> 0`.
- **vj_daily-Merge-Basis STRIKT lesen** (`loadVjDailyYearStrict`, wirft bei Fehler) VOR dem ersten Write — der tolerante `loadVjDailyYear` gibt bei Fehlern `{}` zurück und würde bestehende actualRevenue-Records überschreiben. Gleiches gilt für den Undo-Snapshot (bei Vergangenheits-Jahren: Snapshot-Fehler ⇒ Import abbrechen).
- Neuer vj_daily-Tag ohne Bestand: actualRevenue = Food + Beverage, source `verkaufsdaten_import`.
- Undo: source `verkaufsdaten-food-beverage`, kv-blob-entries (dailyBudgets-Tage) + kvItems (Archiv-Blob ganz + vj_daily-Keys).

## Gäste Take Away (aus den Anzahl-Dateien)
- TA-Gäste = Σ Einheiten aller TA-Artikelzeilen (Food + Beverage additiv, 1 Einheit = 1 Person); Gesamt-Zeile zählt NICHT mit. Speicherung im tenant-präfixierten KV-Blob `ta-gaeste-daily` — bewusst NICHT product_sales (Doppelzähl-/Ersetzungsrisiko mit der SalesUpload-Pipeline).
- TA-Erkennung streng: eigenständiges Grossbuchstaben-«TA» mit Unicode-Wortgrenzen (`\p{L}\p{N}`-Guards, nie Latin-Ranges von Hand — «ŠTA» wäre sonst Match) oder «take away»/takeaway (case-insensitive). Ricotta/Vegetaria/Tagesmenu dürfen NIE matchen.
- Gelieferte Tage ohne TA-Verkauf = explizite 0 im Store; Datei ohne TA-Artikel (Beaulieu) schreibt NICHTS. Cockpit liest Store zuerst (Summe null = kein Tag im Zeitraum → Fallback product_sales-Berechnung).
- **Alle Merge-Basen (vj_daily, Archiv, ta-gaeste-daily) STRIKT lesen, BEVOR der erste Write passiert** — sonst hinterlässt ein Lesefehler einen Teil-Import ohne Undo.

**Why:** Architect-Reviews fanden Datenverlust-Risiken (0-Werte nicht anwendbar; fail-open-Read als Merge-Basis; Teil-Import bei spätem Strict-Read; handgebaute Latin-Ranges als «Wortgrenze»).
**How to apply:** Bei jedem weiteren Import-Pfad, der vj_daily oder Blobs merged: ALLE strikten Reads vor dem ersten Write bündeln, 0 als Wert erhalten, Wortgrenzen mit Unicode-Properties.
