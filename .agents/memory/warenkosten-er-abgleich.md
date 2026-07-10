---
name: Warenkosten ↔ Erfolgsrechnung (FIBU) Abgleich — Monatsvollständigkeit
description: Why the operative-vs-FIBU cost comparison must be gated to whole, elapsed calendar months.
---

Comparing operative (invoice/period-based) Warenkosten against the FIBU
Erfolgsrechnung side is only valid for a period that covers whole, already-elapsed
calendar months.

**Why:** the FIBU side is only available per whole month (`computePLForMonth` sums a
month record). The comparison memo therefore always sums FULL calendar months over
the range. If the analysis period is a partial month (week mode, YTD, or the current
in-progress month), it pits a few days of operative costs against a full month of FIBU
cogs → the diff (CHF + Prozentpunkte) blows up and the ampel is guaranteed red, i.e. a
fake discrepancy. Architect flagged this as a required fix during the export/quote task.

**How to apply:** gate the ampel + comparison table + FIBU-Umsatzbasis on a
`monthAligned` flag: `from` is day 01, `to` is the last day of its month, and the
to-month is fully in the past (before the current month). When not aligned, show a
neutral HintBox ("Abgleich nur für ganze Monate") instead of numbers. Missing FIBU
data is a separate case → info HintBox + import link, never a silent 0 (the central
`warenkostenQuote` returns `null`, not 0, for missing/zero revenue).

Related SSOT rule: the Warenkostenquote (%) numerator is ALWAYS relevant = Food +
Beverage (Sonstiges/Diverses excluded), while absolute CHF displays stay full incl.
Sonstiges. Never introduce a second quote formula — everything routes through
`warenkosten-quote.ts`. Operative konto-mapping (4030→Food) is deliberately different
from the FIBU chart of accounts (4030=Bier→Beverage); never cross-map the two worlds.
