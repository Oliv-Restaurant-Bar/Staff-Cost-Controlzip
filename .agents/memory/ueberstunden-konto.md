---
name: Überstunden-Konto Fix-MA
description: Regeln des Überstunden-Features (src/lib/ueberstunden.ts, /ueberstunden, Monatsreport-Zeile ueberstunden_total)
---

**Regeln:**
- Laufendes Konto startet hart am **2026-07-01** (`UEBERSTUNDEN_START`), davor kein Übertrag; alle Rechnungen nur bis HEUTE (schützt auch vor Geister-Zukunftszeilen in actual_hours).
- **leer statt 0**: Eine ISO-Woche zählt (Soll UND Ist) nur, wenn der Mandant in der Woche Datenbasis hat (irgendein actual_hours-Eintrag oder Absenz-Eintrag). Sonst würde jede import-lose Woche still −Pensum×42 driften.
- Soll = `employees.weeklyHours` (100 % = 42 h) direkt; Tagesgutschrift Ferien/Krank/Unfall = weeklyHours/5; «Frei» = 0. FIX-Zuordnung **je Monat** via applyEffectiveWagesForMonth (gleiches SSOT wie Personalkosten).
- Absenzen leben in KV `ueberstunden-absenzen:<jahr>` (tenant-präfixiert), NIE in actual_hours/schedule_entries (Write-Gates!). Einstufiges Undo über `prev`-Feld im Blob.

**Warum Stale-Wache statt CAS:** KV hat kein CAS; Schreibpfade lesen strikt (`ladeUeAbsenzenStrict`, Lesefehler wirft) und `speichereUeAbsenzen` vergleicht `updatedAt` mit dem erwarteten Stand → `UeAbsenzenKonflikt` statt Vollblob-Überschreiben fremder Änderungen. Undo prüft zusätzlich gegen den UI-Stand.

**Cockpit-Pfad:** `ladeUeberstundenTotal` ist ein Voll-Jahres-Scan (Lohn-Auflösungen + 12 actual_hours-Monate) und läuft im Monatsreport — deshalb 5-min-Cache je Mandant+Stichtag, invalidiert beim Absenzen-Speichern; Fehler → Zelle leer (try/catch in ladeMonatsreport).
