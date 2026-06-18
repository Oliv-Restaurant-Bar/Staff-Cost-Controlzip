---
name: Gastronovi parser diagnostics convention
description: How Gastronovi CSV import parsers must surface failures so format-recognition bugs are debuggable.
---

# Gastronovi parser-diagnostic convention

Every Gastronovi CSV import parser (Z-Bericht, Personen, Durchschnittsbon, and any
future type) must return a `debug` object on **all** paths — including early
failure returns — and set a precise `failureReason` string at each point where
recognition can fail. The page renders this as a collapsible "Parser-Diagnose"
block (auto-opened on failure) with a "Diagnose kopieren" button.

The debug object must capture enough to diagnose a recognition failure *without
the file*: detected delimiter + per-delimiter counts, raw/non-empty line counts,
the detected header/date row, detected columns, the detected value row, any
candidate lines, document-wide counts that hint at the format shape (e.g.
date-cell vs money-cell counts to distinguish wide vs long layout), and the first
~20 raw lines.

**Why:** real customer CSVs arrive browser-uploaded, so the agent cannot read
them from disk. When a parser silently reports "keine Tageswerte gefunden", there
is no way to tell whether the delimiter, the date-header detection, or the value
row was the problem. The fix is always: surface the real structure first, then
correct the recognition — never blind-adapt the parser to a guessed format.

**How to apply:**
- Detect the delimiter by counting `;` `,` `\t` and picking the max — never
  `includes(';') ? ';' : ','`.
- When counting "money" cells for a format hint, exclude date-like cells
  (`parseHeaderDate`) — otherwise dates like `01.06.2026` inflate the money count.
- In the diagnostic UI, the collapsible toggle must be a `div role="button"` (or
  similar), not a `<button>`, because it contains an inner copy `<button>` —
  nested buttons are invalid HTML / React warnings.
- Put the file name inside the debug object so the copied diagnostic is complete
  even on failure (on failure the parsed result is not set in page state).

## Durchschnittsbon: multi-layout detection (wide vs. vertical)

The Durchschnittsbon export ships in two shapes. Distinguish them by structure,
not by header labels: **wide** = one header row carries ≥2 date cells (days as
columns); **vertical/long** = each data row carries exactly 1 date cell + ≥1 money
cell (one day per row). Resolve the year ONCE before branching (explicit year in
any date cell → Zeitraum range → filename → current-year fallback) and surface it
as `usedYear`/`usedYearSource` in the debug object.

**Why:** the real wide file puts the OVERALL average under a `Zeitraum` column,
right next to the daily date columns. It is excluded for free because daily values
are built only from cells whose header `parseHeaderDate`-validates — never add
positional/"first value" exclusion logic, which would break if column order moves.

**How to apply:**
- No-year files need a per-layout month-rollover resolver (Dec→Jan ⇒ year+1);
  rows must be processed in document/column order for rollover to be correct.
- Comma-as-delimiter AND comma-as-decimal (unquoted, e.g. `54,07`) is inherently
  ambiguous — do not blind-parse it; emit a visible warning and tell the user to
  re-export with semicolons. European exports use `;`, so this is the supported path.
