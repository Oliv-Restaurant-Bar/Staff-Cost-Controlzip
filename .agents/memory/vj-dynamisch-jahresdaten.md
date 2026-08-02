---
name: Dynamisches Vorjahr aus Jahresdaten
description: Monatsreport-VJ-Spalte liest bevorzugt die normalen Ist-Daten des Jahres −1; vj_daily nur Fallback; Jahres-Abschluss-Lock gilt für ALLE Importe.
---

**Regel:** Die Vorjahres-Spalten des Monatsreports (Umsatz/Food/Bev/TA, Monat UND VJ-Woche) lesen bevorzugt die normalen Ist-Daten des Jahres −1 über die umsatz.ts-SSOT (`ladeUmsatzTage`), konvertiert in vj_daily-Semantik (brutto, Netto = brutto/VAT_STD). `vj_daily` bleibt Fallback für alt-importierte VJ-Jahre (z.B. 2025). VJ-Woche: Überlagerung STRIKT nur auf die exakt gemappten VJ-Kalendertage (Set), nie auf die ganze Datumsspanne — die geklemmte Woche kann Lücken haben.

**Personalkosten-VJ:** `vorjahres_personalkosten` (Buchhaltung, nur Jahre < 2026) mit Fallback auf den Erfolgsrechnungs-Monatsrecord Jahr−1 via `computePLForMonth` → personnel_wages + personnel_social (identisch ER-Abgleich-SSOT, personnel_other bewusst aussen vor).

**Why:** Jahresbasierte Datenhaltung — 2026er-Ist-Importe erscheinen 2027 automatisch als Vorjahr, ohne separaten VJ-Import. Alle dailyBudgets-Tage mit previousYearRevenue>0 hatten bereits vj_daily-Records (geprüft 2026-08, beide Mandanten) — keine Datenmigration nötig.

**Jahres-Abschluss:** Der prior-year-lock (`prior_year_locked:<tenant>:<jahr>`) ist als «Jahr abschliessen» umgedeutet: commitGastronoviDays prüft ihn für JEDES Ziel (auch Ist), der Tagesdaten-handleConfirm prüft FRISCH für alle Typen (gaeste/durchschnitt/marketing/umsatz) über alle betroffenen Jahre. UI: RareBlockCard «Jahre abschliessen» (letzte 4 Jahre, lockYear/unlockYear, Gate `isAdmin && !isGuest`, window.confirm). Bekannte Grenze: check-then-write, nicht atomar gegen parallele Clients.
