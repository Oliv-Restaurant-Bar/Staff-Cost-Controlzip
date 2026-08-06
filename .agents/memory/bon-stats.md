---
name: Anzahl Bons & Ø-Bon (abgeleitet)
description: Bons werden NIE gespeichert, sondern aus avgcheck-daily × Brutto-Tagesumsatz abgeleitet; Jahres-Ø immer gewichtet.
---

**Regel:** Anzahl Bons ist eine ABGELEITETE Kennzahl (kein eigener Store): je Tag `round(BruttoGesamt ÷ Durchschnittsbon)`, nur wenn beide Werte > 0 (nie ÷0, leer statt 0). Jahres-Ø-Bon = Σ Brutto ÷ Σ Bons — GEWICHTET, nie Mittelwert der Tageswerte. Zentral in `bon-stats.ts` (`berechneBonStats`, `ladeBruttoTageJahr`: dailyBudgets, Jahr komplett leer → vj_daily-Fallback, nie mischen).

**Why:** Kontrollwerte des Users (z.B. Beaulieu 2025: 22'572 Bons, Ø 79.87) stimmen nur mit Tagesrundung + gewichtetem Ø; ein Tages-Mittelwert weicht ab. Sehr hohe Tages-Ø (Einzelrechnung/Event, z.B. 1'319.80) sind KEIN Fehler — nur kennzeichnen (≥4× Jahres-Ø), im Total belassen.

**How to apply:** Jede neue Bon-Anzeige (Cockpit, Vorschau, Reports) über berechneBonStats; Abweichungen von Kontrollwerten zuerst auf fehlende Paar-Tage prüfen (Durchschnitt-Datei kürzer als Umsatz-Bestand ⇒ weniger Bons), nicht auf die Formel.
