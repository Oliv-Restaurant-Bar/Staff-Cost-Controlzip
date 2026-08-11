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

## Einheitliche UMSATZBASIS (Nenner) — 08/2026, zweiter Build-Befehl
- Alle WKQ-Nenner (Cockpit-Monatsreport UND Warenrechnungen-Modul) = **Netto
  (Food+Beverage netto = umsatz-SSOT `nettoUmsatzTag`, inkl. Marketing)**.
  Warenrechnungen las vorher brutto `actualRevenue` (16.5 % statt 17.4 %) —
  jetzt via `ladeNettoUmsatzByDate` (umsatz.ts) für `revenueByDate`/`rangeRevenue`.
- Monatsreport-Zeilen Warenkosten total/Food/Beverage: WKQ-% dezent unter Ist-
  UND Budget-Wert (`WkqInlineInfo.budgetPct`). Budget-Nenner: Total-Monat =
  ER-Netto-Budget (Fallback Ist-Netto), Kategorien/Woche = Ist-Umsatz (kein
  Kategorie-/Wochen-Umsatzbudget vorhanden — Soll ist darauf gerechnet).
- **Why:** User-Befehl «gleiche Basis überall»; leer statt 0, nie ÷0.
- **How to apply:** Neue WKQ-Anzeigen nie auf brutto `actualRevenue` rechnen;
  Tagesnenner immer über `ladeNettoUmsatzByDate`/umsatz-SSOT beziehen.
