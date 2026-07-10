---
name: ER-Abgleich Personalaufwand SSOT
description: How the "Personal FIX + VARIABEL" ER reconciliation defines the FIBU personnel figure it compares against.
---

# ER-Abgleich: FIBU-Personalaufwand = Löhne + Sozialleistungen (SSOT)

The ER-Abgleich (Ist and Plan) in the "Personal FIX + VARIABEL" page compares the
app-calculated Personalaufwand against a FIBU figure that is **exactly** the
Erfolgsrechnung's `personnel_wages` ("Löhne (Total)") + `personnel_social`
("Sozialleistungen"), read straight from the SAME `computePLForMonth(rec, overrides)`
call that renders the Erfolgsrechnung/PLView.

**Deliberately EXCLUDES `personnel_other` ("Übriger Personalaufwand").**

**Why:** The app's own Personalaufwand calculation models only wages + employer
social costs; it does not model "Übriger Personalaufwand" (Ausbildung,
Personalverpflegung, etc.). Comparing against `total_personnel` (which includes
`personnel_other`) would produce a permanent phantom difference. So the comparison
uses wages+social on BOTH sides — same definition for Ist and Plan.

**How to apply:**
- Never reintroduce a separate 5xxx aggregation, a "clean" recompute, or a
  `personnelCostActual`-vs-`total_personnel` dual-source rule. `buildErfolgsrechnungVergleich`
  is a thin wrapper that takes `fibuCHF` directly — the caller sums wages+social
  from the single `computePLForMonth` result.
- `personnel_wages` already inherits the `personnelCostActual`-priority rule inside
  pl-engine, so reading it is automatically SSOT-correct.
- Sum helper returns `null` only when BOTH cells are undefined; the paar helper
  treats ≤0 as `missing`. Never fabricate 0.
- If only one of wages/social is booked, the partial sum shows a large diff — that
  is an intentional data-completeness signal, not a bug to "fix".
