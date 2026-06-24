---
name: Overtime/hours-threshold analytics must exclude absences
description: Why hours-over-threshold analytics (overtime) must drop absenceType entries before summing.
---

Any analytic that compares worked hours against a threshold (overtime over
8.4h/day or 42h/ISO-week, etc.) must EXCLUDE absence entries before summing.

**Rule:** productive hours = `hours > 0 && !absenceType`. An `ActualHourEntry`
can carry an `absenceType` (FE/K/U/…) with non-zero `hours`. If you sum those
into a weekly total, vacation/sick/accident days push the employee over the
weekly threshold and fabricate overtime cost.

**Why:** the overtime card for fixed-salary employees originally counted every
`supabaseActualHours` record with `hours > 0`; a full week of leave (e.g. 5×8.4h
FE) read as 42h+ and produced phantom overtime. Caught in architect review.

**How to apply:** filter `absenceType` both at the data-wiring layer AND inside
the pure analysis lib (defense-in-depth). The grid already uses the same
`hours > 0 && !absenceType` predicate for "productive" cells — match it.
