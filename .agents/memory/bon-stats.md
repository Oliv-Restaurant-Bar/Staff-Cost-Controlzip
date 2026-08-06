---
name: Anzahl Bons & Ø-Bon (abgeleitet)
description: Bons werden NIE gespeichert, sondern aus avgcheck-daily × Brutto-Tagesumsatz abgeleitet; Jahres-Ø immer gewichtet.
---

**Regel:** Anzahl Bons ist eine ABGELEITETE Kennzahl (kein eigener Store): je Tag `round(BruttoGesamt ÷ Durchschnittsbon)`, nur wenn beide Werte > 0 (nie ÷0, leer statt 0). Jahres-Ø-Bon = Σ Brutto ÷ Σ Bons — GEWICHTET, nie Mittelwert der Tageswerte. Zentral in `bon-stats.ts` (`berechneBonStats`, `ladeBruttoTageJahr`: dailyBudgets, Jahr komplett leer → vj_daily-Fallback, nie mischen).

**Why:** Kontrollwerte des Users (z.B. Beaulieu 2025: 22'572 Bons, Ø 79.87) stimmen nur mit Tagesrundung + gewichtetem Ø; ein Tages-Mittelwert weicht ab. Sehr hohe Tages-Ø (Einzelrechnung/Event, z.B. 1'319.80) sind KEIN Fehler — nur kennzeichnen (≥4× Jahres-Ø), im Total belassen.

**Ø-Bon Restaurant (ohne TA), nur Oliv:** (Σ Gesamt-Brutto − Σ TA-Umsatz) ÷ (Σ Bons − Σ TA-Artikel) über die gepaarten Tage. TA-Bons = Artikelmengen aus `product_sales` (Name endet auf « TA» oder enthält Take Away; 1 Artikel = 1 Bon = 1 Gast) — NICHT `ta-gaeste-daily` (das zählt Food+Beverage und überzählt). Server-Prefilter (`*take*away*`) muss OBERMENGE des exakten Client-Filters sein; ohne TA-Artikel-Daten → leer, nie Gesamt-Ø minus TA-Umsatz ausweisen. Kontrollwert Oliv 2025: 34'911 Rest-Bons, Ø 93.64.

**How to apply:** Jede neue Bon-Anzeige (Cockpit, Vorschau, Reports) über berechneBonStats; Abweichungen von Kontrollwerten zuerst auf fehlende Paar-Tage prüfen (Durchschnitt-Datei kürzer als Umsatz-Bestand ⇒ weniger Bons), nicht auf die Formel.
