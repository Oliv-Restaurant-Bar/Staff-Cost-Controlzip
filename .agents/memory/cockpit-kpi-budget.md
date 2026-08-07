---
name: Cockpit-KPI-Budget
description: Regeln des separaten Kennzahlen-Budgets (cockpit-budget:<jahr>) fürs Cockpit — Abgrenzung zu budget_v1, Ratio-Methodik, Präzedenzen.
---

- Store: KV `cockpit-budget:<jahr>` (tenant-präfixiert), Engine in `cockpit-budget.ts`. **budget_v1 (P&L/ER) bleibt unangetastet** — Cockpit-Umsatzzeilen fallen ohne Cockpit-Budget auf budget_v1 zurück, Ist-Stunden auf den Bedarf, Personalkosten auf pkBudget.
- Präzedenz: expliziter Monat > Jahres-Verteilung; ISO-KW-Override > Monatsableitung. Woche ohne Override = Σ Tagesanteile (Monatswert ÷ Kalendertage, über Monatsgrenzen); KW-Override × Tage/7 bei Klemmung, %-Werte ungekürzt.
- Stichtag-Kappung automatisch: `periodenBudget(from, istTo)` über Tagesanteile — kein separater Kappungs-Code.
- **Ratio-Budgets = Ratio der PERIODEN-TOTALE**, NICHT tagesgewichtete Monatsquoten. **Why:** Ist-Seite rechnet identisch (TA-Anteil = Σta÷Σbrutto, Ø-Verkauf = Σverkauf÷Σgäste); andere Methodik macht den Vergleich schief. Tagesgewichtung gilt nur für direkt erfasste %-Monatswerte. Ein Architect-Review hat das fälschlich als Bug geflaggt — bewusste Entscheidung.
- Seasonal-Verteilung = VJ-Ist-Monatssummen GENAU derselben Kennzahl (Gäste via gaeste-daily, Stunden/PK via personalkosten-Kern, Umsatzfamilie via umsatz-SSOT mit vj_daily-Fallback); keine Daten → Kalendertage + Toast-Hinweis.
- Nav-Links zu RequireAdmin-Routen brauchen exakt dasselbe Gate (isAdmin || isBeaulieuManager), sonst sehen Manager tote Links.
- Δ-abs-Spalte im ReportTable: gleiche Basis wie Δ% (deltaVsVj-Zeilen ⇒ Ist−VJ, sonst Ist−Budget) — nie zwei Basen in einer Zeile.
