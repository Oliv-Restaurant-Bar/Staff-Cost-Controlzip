---
name: ER-Budget only via budgetByRow overrides (SSoT)
description: Why any consumer of P&L "budget" values must pass budgetByRow from buildBudgetByRowForMonth, not just call computePLForMonth(rec).
---

The ER-Budget (P&L `total_personnel.values.budget`, `net_revenue.values.budget`, etc.)
is NOT populated by `computePLForMonth(rec)` alone. It only appears when you pass
`{ budgetByRow }` overrides built from the budget module (`budget_v1`) via the shared
`buildBudgetByRowForMonth(budget, monthIdx, lookupFn=lookupAccount)` helper in
`pl-engine.ts`.

**Why:** computePLForMonth has TWO budget paths. The direct-field path
(`record.personnelCostPlanned` etc.) is coupled to `personnelCostActual` being defined,
so wage budgets silently vanish when there is no actual. The `budgetByRow` override path
is NOT coupled to actuals — `rowValues` pre-initializes ALL PL rows to `{}`, so overrides
apply regardless, and subtotal `sum` rows aggregate the child budgets. A prior review
FAILED because PersonalFix called computePLForMonth WITHOUT overrides → empty Plan budget,
AND that duplicated PLView's logic (SSoT violation).

**How to apply:** Any page that needs P&L *budget* numbers (not just actual) must:
1. `loadBudgetWithPL(year, tenantKey(BUDGET_STORAGE_KEY))`,
2. `buildBudgetByRowForMonth(budgetData, month0Based, lookupAccount)` (month is 0-based;
   app `selectedMonth` is 1-based → pass `selectedMonth - 1`),
3. pass `{ budgetByRow }` to computePLForMonth.
PLView and PersonalFix both derive ER-Budget from this ONE helper — do not re-inline the
budget-position → PL-row mapping. Mapping order: account number
(`lookupAccount`→`PL_CATEGORY_TO_ROW_ID`) first, else category (`BPL_CAT_TO_PL_ROW`);
skip `isInternal` items and 0 values.

**Test env gotcha:** unit tests importing anything from `pl-engine.ts` need `happy-dom`
(NOT `node`), because pl-engine transitively imports the Supabase client, which touches
`localStorage` at module load. Keep the helper testable by injecting `lookupFn`.
