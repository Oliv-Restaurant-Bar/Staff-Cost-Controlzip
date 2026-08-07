---
name: de-CH currency formatting uses NBSP
description: toLocaleString('de-CH', {style:'currency'}) separates "CHF" and the number with a non-breaking space — plain-string .replace('CHF ') silently fails.
---

**Rule:** When stripping the "CHF" prefix from `toLocaleString('de-CH', { style: 'currency', currency: 'CHF' })` output, use a regex like `/CHF\s*/u` — never `.replace('CHF ', '')` with a plain space.

**Why:** The locale inserts a non-breaking space (U+00A0) between "CHF" and the digits. A plain-space string replace does not match, leaving the prefix in place. This produced doubled units like "−CHF 30 CHF" in UI where the code appends " CHF" after a supposedly stripped value. It only surfaced through a test assertion; visually it is easy to miss.

**How to apply:** Any formatter that post-processes de-CH (or similar) currency strings must match whitespace with `\s` (which covers NBSP under the `u` flag) or, better, format the number without `style: 'currency'` in the first place when only the number is wanted.

## jsPDF-Standardfonts (Helvetica/WinAnsi)
Im PDF-Export NIE `toLocaleString('de-CH', currency)` verwenden: NBSP/Narrow-NBSP zerreissen Zahlen («CHF 3 0»). Auch U+2212 (−) und ≤ fehlen in WinAnsi → kaputte Glyphen. Regel: eigene ASCII-Formatter (Apostroph-Tausender, ASCII `-`, «bis 5 %» statt «≤5 %»); « » · — ä ö ü sind WinAnsi-sicher.
