---
name: ER unvollständige Monate & Personal-Aushilfe-Konten
description: Monats-Vollständigkeits-Regel (partial ausklammern) und Aushilfe-Konten 5004/5005/5011 in ER/P&L (immer eingerechnet, PDF abwählbar)
---

## Regeln
- **Partial-Monat** = genau EINE Seite vorhanden (Umsatz XOR importierte Kosten) → grau «unvollständig», ausgeklammert aus Jahres-/Periodensummen, Budget-Vergleich, KPIs, Betriebsergebnis. Ganz leere Monate bleiben drin (Budget zählt weiter). SSOT: `src/lib/month-completeness.ts` (`monthCompleteness`, `isNachrichtlichAccount`).
- **Personal Aushilfe 5004/5005/5011** (nicht im Infoniqa-Export): seit Befehl 08/2026 v2 IMMER voll in Lohnaufwand/Personalaufwand + alle Folgesummen — ADDITIV auch wenn `personnelCostActual`/`personnelCostPreviousYear` gesetzt ist (keine Doppelzählung, da nicht im Export enthalten). Die frühere «nachrichtlich, zählt nirgends»-Regel ist AUFGEHOBEN; NACHRICHTLICH-Badge/`isMemo` entfernt.
- **PDF-Export**: Checkbox «Personal Aushilfe einrechnen?» (Default Ja) im PDFExportDialog. Bei Nein werden die 3 Konten NUR für den Export aus den Records gestrippt (expenseCategories + PreviousYear) UND die Overrides (prevYearByRow/budgetByRow/cogsBudgetSplit) aus den gestrippten Quellen neu gebaut — sonst injizieren die Overrides die Konten in die VJ-/Budget-Spalten zurück. Maison-Delta danach auf den gestrippten Records.

**Why:** Befehl 08/2026 (v2): App soll die realen Personalkosten inkl. Aushilfe zeigen; nur der PDF-Export soll die Konten optional ausblenden können. Monate mit nur Umsatz verfälschten YTD/Budget-Vergleich → Partial-Regel bleibt.

**How to apply:**
- Die additive Ausnahme sitzt in pl-engine (numericActual/numericPY-Loop: personnel_wages-Skip gilt NICHT für `isNachrichtlichAccount`); BPL-Summen (`sumCatFromCategories`, computeBPLRows-Items) filtern NICHT mehr.
- `isNachrichtlichAccount` bleibt bewusst in `monthCompleteness` (Kosten-Seite): Monate mit nur Umsatz + manueller 5004 sind weiterhin unvollständig.
- Partial-Filter greift in PLView: `periodAgg`, `registryKpis` (periodPls), `yearEffectiveMonths`, `YearView/YearRow` via `incompleteIdxs`-Set (zusätzlich zu `excludeMonthIdx`).
- pl-engine-Tests brauchen happy-dom (Supabase-transitiv) und `r.def.id` (nicht `r.id`).
- Kontrollwerte Juli 2026 (Beaulieu-Daten, 5004=10'028): Lohnaufwand 52'509 mit / 42'481 ohne — verifiziert.
