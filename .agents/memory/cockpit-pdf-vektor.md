---
name: Cockpit-PDF-Export (Raster 1:1 + optionaler Waren-Block)
description: Aktuelle Regel für den Cockpit-PDF-Export — 1:1-DOM-Raster der aktiven Ansicht plus optionaler Waren-Block; die frühere «alles Vektor»-Regel ist überholt.
---

# Cockpit-PDF-Export

**Regel (08/2026, User-Entscheid):** Die aktive Cockpit-Ansicht wird 1:1 «wie angezeigt» exportiert — DOM-Raster via html2canvas (`cockpit-pdf-export.ts`, CSS-Klassen `.pdf-hide`/`.pdf-only`), NICHT als nachgebautes Vektor-Layout. Zusatzseiten «Letzte 4 Wochen» und «Wochenverlauf» bleiben Vektor-Modelle (`cockpit-report-pdf.ts`).

**Why:** User verlangte explizit, dass das PDF exakt der App-Ansicht entspricht (Farben, Badges, Δ-Vorzeichen); der frühere Voll-Vektor-Ansatz wich sichtbar ab.

**How to apply:**
- Vor JEDEM Export fragt ein Dialog «Waren-Block mitexportieren?» (Ja/Nein).
- Waren-Block (`cockpit-waren-block.ts`): 3 Seiten via jspdf-autotable (Lieferanten-Übersicht, Tagesverlauf kumuliert, Anomalie pro KW). Zahlenbasis = direkter Warenaufwand 4020–4070 via `direktAnteilNet` (Splits pro Konto, Pfand neutral), Umsatz = Netto-SSOT, Ignore-Liste gefiltert.
- EINE Periodenbasis für ALLE Aggregationen (nur Tage ≤ heute) — sonst weichen Lieferantensumme und Total ab; «leer statt 0» bei 0-Direktanteil.
- `CockpitExportPart` kennt `kind:'zeichner'` (freier jsPDF-Zeichner, fügt selbst Seiten an).
- html2canvas ist jetzt als Dependency deklariert.

**Design-System (08/2026):** Im Mixed-Export sind Raster- und Waren-Seiten einheitlich HOCHFORMAT mit Marken-Kopfband (branding.headerBg + Akzentlinie, Titel·Mandant·Zeitraum·Stand) und 13-mm-Rand; Fusszeile (Firma · Seite x/y) zentral via `zeichneFusszeilen` auf allen Seiten. Waren-Seiten tragen je eine KPI-Zeile (Warenaufwand · WKQ-Ampel ≤30 grün/≤40 amber/>40 rot · Netto-Umsatz · Ziel max. 30 %) plus Vektor-Charts (Lieferanten-Balken, Kumulations-Linien, Wochen-WKQ mit Ziellinie); Status-Chips final grün / provisorisch amber. Die breiten Vektor-Matrizen «Letzte 4 Wochen»/«Wochenverlauf» bleiben bewusst quer (Renderer fest 297 mm). Achtung: «≤» ist in jsPDF-Helvetica (WinAnsi) nicht darstellbar — «max.» o.ä. verwenden.

## Personal-Block & gemeinsames Stil-Modul (08/2026)
- Gemeinsames Design-System für Cockpit-PDF-Blöcke lebt in `cockpit-block-stil.ts`; Waren- und Personal-Block teilen Kopfband/KPI-Boxen/Chips — neue Blöcke NIE eigene Stile duplizieren.
- Personal-Block-Regeln: Stichtag IMMER auf min(heute, Monatsende) klemmen (Vergangenheits-Export sonst mit späteren Ist-Daten verfälscht); Überstunden-«Laufend» über ALLE Konto-Jahre seit UEBERSTUNDEN_START summieren, Totale aus den Lib-Ergebnissen (nie gerundete Zeilen summieren).
- Zusatzkosten-Zeilen (Fix-MA) brauchen dieselbe Quellen-Auflösung wie ladePersonalkostenDaten (Supabase kanonisch, localStorage-Fallback/Overrides), sonst weicht der Export von PersonalFix ab.
- «ohne AG»-Flags (pfix_ag_soz_off_<tenant>) liegen NUR im Browser-localStorage — headless-Harness sieht sie nicht; CHF-Kontrollwerte nur im echten Browser prüfbar.
