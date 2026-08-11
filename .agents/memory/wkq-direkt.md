---
name: Warenkostenquote = direkter Warenaufwand 4020–4070
description: ER-KPI/P&L-Definition «direkt» ist strikt 4020–4070; 4000–4019 zählen als übrig; WES-Analyse-FIBU-Total ebenfalls nur 4020–4070.
---

# WKQ-KPI & «Direkter Warenaufwand» (08/2026, Build-Befehl)

- **Regel:** Die ER-Warenkostenquote (`cogs_ratio`, Financial-Metrics-Registry) rechnet
  auf `total_cogs_direct` (P&L-Zeile «Direkter Warenaufwand»), NICHT mehr auf
  `total_cogs_einkauf`. Nenner unverändert Betriebsertrag netto. Gilt identisch für
  Ist/Budget/VJ und Monat/Quartal/Jahr (bpl-aggregate nutzt dieselbe Zähler-Zeile).
- **Range-SSoT** (`warenaufwand-gruppierung.ts`): direkt = 4020–4070; übrig =
  4000–4019 UND 4071–4899; 4900 = eigene Zeile cogs_lager. Konten unter 4020 sind
  bewusst NICHT direkt (Kontrollwerte Juli 2026 Oliv: 30.7 / 29.0 / 25.3 %).
- **WES-Analyse-Seite:** FIBU-`buchTotal` = nur Food+Beverage (4020–4070); 4090
  bleibt nachrichtlich in der Kontenliste, zählt nie ins Total/die Vergleichsquote.
- **Why:** KPI, P&L-Zeile und Waren-Analyse müssen überall dieselbe Definition
  zeigen (User-Befehl «überall identisch, Wareneinsatz = 4020–4070»).
- **Grenzen:** Die OPERATIVE Cockpit-WKQ (`warenkosten-quote.ts`, 4000–Grenze) ist
  eine bewusst separate ZÄHLER-Definition — weiterhin NICHT angleichen.

## Einheitliche UMSATZBASIS (Nenner) — 08/2026
- Alle WKQ-Nenner (Cockpit-Monatsreport UND Warenrechnungen-Modul) = **Netto
  (Food+Beverage netto = umsatz-SSOT, inkl. Marketing)** — nie brutto
  `actualRevenue` (gab 16.5 % statt 17.4 %); Tagesnenner via
  `ladeNettoUmsatzByDate` (umsatz.ts).
- **Why:** User-Befehl «gleiche Basis überall»; leer statt 0, nie ÷0.

## Cockpit-Zeilen Warenkosten total/Food/Beverage: Soll & Δ (08/2026)
- **Soll = wirksame WEQ-Quote × IST-Netto-Umsatz der Zeile — für ALLE drei
  Zeilen** (auch Total; nie mehr Cockpit-Budget-CHF auf Budget-Umsatz-Basis).
  Invariante: Total-Soll = Food-Soll + Beverage-Soll — gilt im Monatsreport
  UND im Wochenverlauf (dort in beiden WEQ-Modi als Food+Bev-Summe).
- **Budget-WKQ** unter der Soll-Zelle = Soll ÷ Ist-Netto (= konstant die
  Quote, z.B. 24.0 %) — nie auf ER-Budget-Umsatz rechnen (zeigte 7.0 %).
- **Δ% = (Ist − Soll) ÷ Ist-Netto-Umsatz** (PP-Abweichung der WKQ zum Ziel,
  NICHT ÷ Soll) via `MrRow.deltaPctBasis` — von Bildschirmtabelle, Wochen-
  matrix (Basis aus der QUELL-Zeile der Spalte, nie Skeleton) und
  `mapRowForExport` (Excel/PDF) gleich behandelt.
- Das Cockpit-Budget «wareneinsatz» (ckId bleibt editierbar) steuert nur noch
  die QUOTE (÷ ER-Netto-Budget), nicht mehr direkt die Soll-Anzeige.
- **Why:** Total ≠ Food+Bev und Δ÷Soll verwirrten (Build-Befehl mit
  Kontrollwerten); leer statt 0, nie ÷0.
