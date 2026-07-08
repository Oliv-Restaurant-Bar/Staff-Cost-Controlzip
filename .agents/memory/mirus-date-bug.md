---
name: Mirus XLS date-system bug
description: Excel 1904-date-system causes all dates to shift +4 years (1462 days) when cellDates:true is used.
---

## Problem
Some Mirus `.xls` exports (e.g. Beaulieu tenant) have the Excel 1904 date system flag set. The `xlsx` library with `cellDates: true` converts serial numbers to JS Date objects using this flag, shifting every date by exactly +1462 days (4 years). November 2024 becomes November 2028.

## Fix (applied, in `src/lib/mirus-parser.ts`)
1. **Remove `cellDates: true`** from `XLSX.read()` call — keep raw numeric serials, convert manually via `XLSX.SSF.parse_date_code`.
2. **`inferYear`** now skips Date-object cells and requires year ≤ currentYear+3.
3. **`cellToDateObj`** validates Date-object years: rejects if `|cellYear - inferredYear| > 3` or year outside 2020–currentYear+3.
4. **`sanitizeEntries`** post-parse filter: discards entries with year outside [currentYear-10, currentYear+2]; logs a clear error if ALL entries are discarded.

## Why
`cellDates: true` is the root trigger. Without it, dates stay as Excel serial numbers and `XLSX.SSF.parse_date_code` always uses the Gregorian calendar regardless of fDateSystem flag.

## How to apply
Never use `cellDates: true` for Mirus files. All other parsers in this project already avoid it.

Same rule on the WRITE side: when generating .xlsx exports, don't hand JS Date objects to the `xlsx` lib (TZ/date-system ambiguity). Write a deterministic 1900-epoch serial yourself (`25569 + Date.UTC(y,m-1,d)/86_400_000`, cell type `n` + date number format) — TZ-independent and safe for dates ≥ 1900-03-01.
