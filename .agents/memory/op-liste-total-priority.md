---
name: OP-Liste Gesamtsaldo priority
description: Why the creditor OP-list footer total must be resolved by priority AFTER the line loop, and never emitted as a silent 0.00.
---

# OP-Liste (Kreditoren) Gesamtsaldo-Erkennung

The Sage "Offene Posten … Kreditoren" PDF footer has up to three
"Gesamt Saldo von N …" lines plus a "Total der Währung CHF" line.

**Rule:** collect footer-total candidates into *separate* buckets during the
line loop and pick the winner AFTER the loop, by priority:
1. "Gesamt Saldo von N **Posten**" (net saldo)
2. "Total der Währung CHF"
3. plain "Gesamtsaldo"
Subtotals "von N **Rechnungen**" (gross) and "von N **Gutschriften**"
(negative) must be excluded as candidates.

**Why:** the original bug set the total inline while iterating, so the LAST
matching line — the negative "… Gutschriften" subtotal — overwrote the real
net saldo and the displayed Gesamtsaldo collapsed toward 0.00. Ordering the
footer lines in the PDF is not under our control, so inline last-wins is unsafe.

**Never emit a silent 0.00:** the parser keeps `totals.openAmount = null` when
no real total line is recognized. The itemsSum fallback lives ONLY in the DB
layer (`total_open_amount = openAmount ?? itemsSum`). Deviation warnings fire
only when a total was recognized; a separate warning fires when none was found.
The import dialog then shows "nicht erkannt" and blocks confirm unless the user
ticks an explicit override.

**How to apply:** any change to footer parsing must preserve (a) the
post-loop priority resolution, (b) `RE_TOTAL_WAEHRUNG` checked before the
generic supplier `RE_TOTAL`, and (c) the null-not-zero contract. Fixtures are
synthetic — validate against a real OP-Liste PDF before trusting the numbers.
