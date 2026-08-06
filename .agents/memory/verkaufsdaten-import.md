---
name: Verkaufsdaten Food/Beverage-Jahresimport
description: Gastronovi-Artikel-Jahresexporte (4 Dateien) → NUR Gäste Take Away + Archiv; Cockpit-Food/Beverage kommt AUSSCHLIESSLICH aus dem Umsatz-Excel.
---

# Verkaufsdaten Food/Beverage-Import (src/lib/verkaufsdaten-import.ts)

- Quelle: 4 Tab-getrennte Jahresdateien (Food/Beverage × Umsatz/Anzahl); für Umsatz/Anzahl zählt die «Gesamt - …»-Zeile. Kategorie/Typ aus Inhalt (CHF-Präfix = Umsatz), Dateiname nur Fallback. Zellen können komplett doppelt gequotet sein (`splitTsvCells` entfernt Quotes VOR jeder Erkennung); Tagesspalten «DD.MM.» mit oder ohne End-Punkt.
- **Datenquellen-Trennung (User-Entscheid 08/2026):** Der Import schreibt NUR noch (a) `ta-gaeste-daily` und (b) Archiv-Blob `verkaufszahlen_{jahr}` (tenant-präfixiert, Vorschau-/Diff-Basis). dailyBudgets.actualFood/actualBeverage und vj_daily.foodRevenue/beverageRevenue dürfen von hier NIE wieder beschrieben werden — Cockpit-Food/Beverage stammt ausschliesslich aus dem Umsatz-Excel (umsatz-SSOT, Invariante Food+Beverage=Netto; Oliv TA→100 % Food, Rest+Rabatte 50/50).
- Artikel-Umsätze/-Anzahlen für die Produktanalyse laufen über die separate SalesUpload-Pipeline (product_sales) — Verkaufsdaten-Import schreibt bewusst NICHT in product_sales (Doppelzähl-Risiko).
- **Explizite 0 ≠ leere Zelle:** 0 ist ein echter Tageswert und ersetzt Bestand; nur leere Zellen bedeuten «nicht geliefert». Feld-Zuweisungen deshalb mit `!== undefined`, nie `> 0`.
- Undo: source `verkaufsdaten-food-beverage`, Snapshot kind `kv-keys` (Archiv-Blob ganz + ta-gaeste-daily ganz).

## Gäste Take Away (aus den Anzahl-Dateien)
- TA-Gäste = Σ Einheiten aller TA-Artikelzeilen (Food + Beverage additiv, 1 Einheit = 1 Person); Gesamt-Zeile zählt NICHT mit. Daraus auch der TA-Anteil.
- TA-Erkennung streng: eigenständiges Grossbuchstaben-«TA» mit Unicode-Wortgrenzen (`\p{L}\p{N}`-Guards, nie Latin-Ranges von Hand — «ŠTA» wäre sonst Match) oder «take away»/takeaway (case-insensitive). Ricotta/Vegetaria/Tagesmenu dürfen NIE matchen.
- Gelieferte Tage ohne TA-Verkauf = explizite 0 im Store; Datei ohne TA-Artikel (Beaulieu) schreibt NICHTS. Cockpit liest Store zuerst (Summe null = kein Tag im Zeitraum → Fallback product_sales-Berechnung).
- **Alle Merge-Basen (Archiv, ta-gaeste-daily) STRIKT lesen, BEVOR der erste Write passiert** — sonst hinterlässt ein Lesefehler einen Teil-Import ohne Undo.

**Why:** User verlangte explizit, dass Artikel-CSV-Importe die Cockpit-Zeilen Food/Beverage nie überschreiben (Umsatz-Excel ist die einzige F/B-Quelle); frühere Architect-Reviews fanden Datenverlust-Risiken (0-Werte, fail-open-Reads, Teil-Imports).
**How to apply:** Jede Erweiterung dieses Imports darf nur ta-gaeste-daily/Archiv anfassen; für F/B-Cockpit-Daten immer auf Umsatz-Excel/umsatz.ts verweisen. Strikte Reads vor dem ersten Write bündeln, 0 als Wert erhalten.
