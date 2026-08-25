---
name: Flex-Auswertung Ist-Stichtag
description: Wochenvergleich Plan vs. Ist nur bis zum letzten echten Mirus-Ist-Tag; plan_sync verfälscht den Stichtag.
---

**Regel:** Der Ist-Stichtag der Flex-Auswertung (PersonalFix) ist der letzte Tag mit ECHTEN importierten Ist-Stunden — Einträge mit `source === 'plan_sync'` (automatischer Plan→Ist-Spiegel, inkl. K/U-Absenzen mit Stunden > 0) dürfen ihn NICHT bestimmen. Wochen über den Stichtag hinaus werden auf BEIDEN Seiten (Plan UND Ist) auf Tage ≤ Stichtag gekappt und als «(teilweise, bis DD.MM.)» gekennzeichnet; komplett spätere Wochen bleiben «noch offen».

**Why:** plan_sync-Einträge tragen Stunden > 0 auch Tage/Wochen in die Zukunft (Absenz-Spiegel). Ein Stichtag «letzter Tag mit Ist > 0» rutschte dadurch auf 16.08. statt 11.08. → KW-Teilwoche verglich fast eine ganze Plan-Woche gegen 2 Ist-Tage (−42 % Schein-Abweichung, verfälschtes Total). Vorfall 08/2026.

**Hybrid-Regel (bewusst):** Innerhalb ≤ Stichtag zählt das Ist ALLER Quellen (auch plan_sync-Absenzen) — identisch zu allen anderen Ist-Ansichten. plan_sync ist nur für die STICHTAG-Bestimmung ausgeschlossen.

**How to apply:** Live-Flex und Cockpit-PDF verwenden denselben Tagesfakten-Builder und dieselbe kalenderbasierte Cockpit-Grenze. Autoritative Istbasis sind die tenant-gefilterten Supabase-MIRUS-Zeilen; normale lokale Cache-Zellen sind nur Lade-/Fehler-Fallback, lokale Absenz-/Zusatzkosten-Overrides bleiben geschützt. Der MIRUS-Stichtag ignoriert `plan_sync` und Zusatzkosten. Eine aktuelle Teilwoche zählt nicht zu «abgerechneten Wochen». Externe Aushilfen, AG-Sätze und Split-Phasen müssen identisch aufgelöst werden; kein zusätzlicher Pro-rata-Schnitt.
