---
name: Einheitliche Zeitraum-Steuerung
description: Gemeinsame Perioden-Steuerung (Woche/Monat/Quartal/Jahr) für alle Auswertungs-Seiten — Mapping-Regeln und Fallen.
---

Regel: Alle Auswertungs-Seiten nutzen `ZeitraumSteuerung` (`src/components/ZeitraumSteuerung.tsx`) mit Logik-SSOT `src/lib/zeitraum.ts` — keine seiteneigenen Perioden-Navigationen mehr. Cockpit und Dienstplan sind bewusst ausgenommen.

**Why:** BUILD-Befehl 08/2026 verlangte EINE Quelle für Optik/Labels/Verhalten (FIBU-Abgleich-Muster); doppelte Navigationen führten zu inkonsistenten Perioden.

**How to apply:**
- Seiten halten den State selbst (value/onChange) — so bleibt die Periode über Tabs innerhalb der Seite erhalten.
- WOCHEN-FALLE: übergibt eine Seite den Wochenmodus, MÜSSEN `value.year`/`value.month` aus dem ISO-Montag (`wochenStart`) abgeleitet werden, nicht aus separatem Monats-State — sonst springt der Wechsel Woche→Monat auf den falschen Monat (KW1 kann im Vorjahr-Dezember beginnen).
- Zukunftssperre: Standard `nextGesperrt` blockt aktuelle/zukünftige Periode; Seiten mit Vorwärtsplanung (Budget) oder historischen Datenjahren (PLView) setzen `minJahr`/`maxJahr` explizit.
- Seitenspezifische Modi (Analyse: Mehrere Monate/YTD; Produktanalyse: Tag/Von–Bis) laufen als `extraModes` im selben Popover — keine zweite Steuerung daneben bauen.
- Read-only-Gates der Seiten (z.B. `granular === 'jahr'`-Toasts in Warenrechnungen, PLView `period !== 'month'`) bleiben Sache der Seite, nicht der Komponente.
