---
name: Financial Metrics Registry
description: Dashboard-Finanzkarten nur über die read-only Registry; loadMonth/loadBudget-Default-Keys sind NICHT tenant-präfixiert.
---

**Regel:** Monatliche Finanzkennzahlen (Umsatz/Personalkosten/Quoten IST·Budget·VJ) im Dashboard kommen ausschliesslich aus `getFinancialMetricValues(buildFinancialMetricInput(...))` — nie lokal aus budgetData/dailyBudgets nachrechnen. Finanzkarten sind IMMER netto; Quoten aus Rohwerten, Nenner fehlt/0 ⇒ null ⇒ '–' (kein 0-Fallback). Operative Karten (heute/Woche/pro-rata/Stichtag) bleiben bewusst Dienstplan-basiert.

**Falle (Why):** `loadMonth`/`loadBudgetWithPL` haben Default-Store-Keys OHNE Tenant-Präfix (`reporting_v1`/`budget_v1`). Mehrere Dashboard-Stellen lasen deshalb still Oliv-Daten im Beaulieu-Kontext. 

**How to apply:** Jeder Aufruf dieser Loader braucht explizit `tenantKey('reporting_v1')` bzw. `tenantKey('budget_v1')` UND `tenantId` in den Hook-Deps (plus `reportingTick`, da localStorage-Reads nicht reaktiv sind).
