---
name: ER unvollständige Monate & nachrichtliche Konten
description: Monats-Vollständigkeits-Regel (partial ausklammern) und Nachrichtlich-Konten 5004/5005/5011 in ER/P&L
---

## Regeln
- **Partial-Monat** = genau EINE Seite vorhanden (Umsatz XOR importierte Kosten) → grau «unvollständig», ausgeklammert aus Jahres-/Periodensummen, Budget-Vergleich, KPIs, Betriebsergebnis. Ganz leere Monate bleiben drin (Budget zählt weiter). SSOT: `src/lib/month-completeness.ts` (`monthCompleteness`, `isNachrichtlichAccount`).
- **Nachrichtliche Konten 5004/5005/5011** (Personal Aushilfe, nicht im Infoniqa-Export): Zeilen bleiben sichtbar (Badge NACHRICHTLICH, `BPLRow.isMemo`), zählen aber in KEINE Summe.

**Why:** Befehl 08/2026 — Monate mit nur Umsatz (Bsp. Aug 2026) verfälschten YTD/Budget-Vergleich; 5004/5005 wurden früher ADDITIV zu personnelCostActual gezählt (alte ADDITIVE_WAGE_ACCOUNTS-Sonderbehandlung in pl-engine — bewusst ENTFERNT, nicht wiederherstellen).

**How to apply:**
- Ausschluss muss in BEIDEN Rechenwegen sitzen: BPL (`computeBPLRows`/`sumCatFromCategories` in PLView) UND klassischer `pl-engine` (numericActual-, numericPY-Loop, `buildPrevYearByRowForMonth`, `buildBudgetByRowForMonth`). Nur PLView filtern reicht NICHT — YearView/KPIs/EBIT kommen aus pl-engine.
- Partial-Filter greift in PLView: `periodAgg`, `registryKpis` (periodPls), `yearEffectiveMonths`, `YearView/YearRow` via `incompleteIdxs`-Set (zusätzlich zu `excludeMonthIdx`).
- Bekannte Grenze: `hasData` bleibt true, wenn nur Memo-Kosten existieren (kein Summenleck).
- pl-engine-Tests brauchen happy-dom (Supabase-transitiv) und `r.def.id` (nicht `r.id`).
