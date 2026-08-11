---
name: Cockpit-PDF Vektor-Export
description: Strukturierter jsPDF-Export der Wochen-Reporttypen (statt html2canvas-Raster) — Regeln für Modell, Pagination und Datenfluss.
---

ALLE Cockpit-Reporttypen (Wochenübersicht, Letzte 4 Wochen, Wochenverlauf, Monatsübersicht, Jahresvergleich) exportieren als strukturiertes Vektor-PDF aus `cockpit-report-pdf.ts` — kein Raster-Capture mehr für diese Tabs. Design folgt dem HTML-Muster: Δ-Chips HELL getönt + dunkle Schrift, rechtsbündig, nur so breit wie nötig; auf Anzeige-Rundung 0 → KEIN Chip, nur «—»; keine Legenden/Fussnoten (nur Kopfband + Tabelle + Fusszeile); Label/Notiz/Sub einzeilig mit Ellipse (nie `maxWidth`-Umbruch — blutet über die Zeilenhöhe).

**Regeln:**
- Δ-Semantik NIE neu erfinden: Wochen-/Monats-Modelle nutzen `mapRowForExport(row, granularity)` (gleiche Basis wie Bildschirm inkl. deltaVsVj/deltaInverted/deltaPp); Verlauf nutzt `budgetInverted`; Jahresvergleich rechnet Δ gegen das Cockpit-KPI-Budget (wie die Bildschirmtabelle), VJ als Unterzeile.
- Kein «Weitere Kennzahlen»-Sammelblock: unbekannte Zeilen per id-/Label-Heuristik in die fachliche Sektion (Warenkosten Food/Bev → Waren).
- Max. 4 Wochengruppen pro A4-quer-Seite (`MAX_GRUPPEN_PRO_SEITE`); mehr Gruppen horizontal in «Teil t/n»-Seiten splitten — sonst clippen Chips/Werte (8-Wochen-Verlauf!).
- Datenfluss Verlauf/Jahresvergleich: Views melden Daten via `onPdfDaten`-Ref und MÜSSEN bei jedem Ladebeginn UND beim Unmount (Tab-Wechsel) `null` melden — sonst exportiert der Export-Handler stale Daten mit falschen Metadaten.
- Seitenzahlen erst am Ende via `zeichneFusszeilen` (Gesamtzahl unbekannt beim Zeichnen); Renderer selbst zeichnet keine Footer.
- Ampeln immer Wert+Farbe+Label: WKQ ≤30 grün/≤35 gelb/>35 rot (Spez-Vorgabe, unabhängig vom Ziel-WKQ); PKQ ≤40/≤44/>44; Ø-Verkauf & Produktivität gegen Budget (≥100 %/≥95 %).
- VJ-Ansicht im Verlauf: VJ-Wert als `ist.sub`-Zeile, Ampel hat Vorrang; Grafikmodus exportiert dieselbe Tabelle.

**Why:** Ohne Pagination clippt der Export bei vielen Gruppen; ohne Null-Meldung bei Ladebeginn exportiert er stale Verlauf-Daten nach Einstellungswechsel.
**How to apply:** Bei jeder Änderung am Cockpit-PDF (neue Spalten, neue Reporttypen, neue Kennzahlen) diese Invarianten prüfen; Tests in `__tests__/cockpit-report-pdf.test.ts`.

**Nicht-WinAnsi-Zeichen (z.B. «Δ»):** jsPDF-Kernfonts drucken dafür «"». Lösung: Segment-Rendering via `textMitDelta` (Δ = Symbol-Kernfont, Zeichen D), nie direkt in helvetica setzen; in engen Mehr-Gruppen-Ansichten (gruppen>1) werden Ist-Subnotizen/WKQ-Badges unterdrückt, sonst bluten sie in den Δ-Chip der Nachbargruppe.

**Kompaktes Spaltenraster (08/2026):** Werte-Gruppe Ist·Budget·Δ sitzt bündig rechts (Label-Spalte absorbiert Rest), Gruppenbreite gedeckelt (`MAX_GRUPPE_W`), Drittel-Teilung einheitlich für ALLE Reporttypen; Köpfe rechtsbündig auf derselben −1-mm-Kante wie die Werte (inkl. Δ-Header). Δ-Chip-Text muss deterministisch passen: `fitText` (Fontgrösse reduzieren, dann «…»-Kürzung) — nie über den Chip hinaus zeichnen; Geometrie-Test mit Fake-jsPDF sichert das ab.
