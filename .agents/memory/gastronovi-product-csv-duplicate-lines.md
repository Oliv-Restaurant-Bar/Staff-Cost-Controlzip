---
name: Gastronovi product-sales CSV import — duplicate line-items
description: Why a product's stored qty/revenue can diverge from Gastronovi when the export lists it on multiple lines (matchAnzahlUmsatz in gastronovi-csv-parser.ts).
---

# Gastronovi product-sales import: duplicate-name line-items break qty + revenue

When a single product appears on **more than one line** in a Gastronovi wide-format
export (both the "Anzahl"/quantity file and the "Umsatz"/revenue file), the product-sales
import (`matchAnzahlUmsatz` in `src/lib/gastronovi-csv-parser.ts`) corrupts that product's
stored numbers. Symptom seen in the wild: "Pizza Prosciutto TA" stored qty 509 / rev CHF 704,
while Gastronovi reported qty 487 / rev ~CHF 4'870.

Two independent defects, both triggered by duplicate line-items:

1. **Umsatz lookup is last-write-wins.** `umsatzMap` is built with
   `Map.set(normalizeProductName(name), row)`. If the same normalized name occurs twice in the
   Umsatz file, the **earlier line is silently discarded**. If the surviving line only carries
   revenue for a few days, the rest of the month's revenue is lost → revenue collapses
   (e.g. ~4'870 → a few hundred).

2. **Anzahl rows are never de-duplicated.** The function emits one DB row per
   (anzahl line × date) with no dedup, so two quantity lines both produce rows on the overlapping
   days → phantom quantity. Because both duplicate anzahl lines read revenue from the *same*
   surviving `umsatzMap` entry, the identical daily revenue is written onto **both** rows →
   that day's revenue is double-counted. Tell-tale signature in `product_sales`: two rows with the
   same `(product_name, sale_date)` and the **exact same `revenue`** but different `quantity`.

**Why it only hits a few products:** most products appear once per file and import cleanly.
Only items the export splits onto multiple lines (e.g. a take-away "TA" item that is also listed
under another section) are affected.

**Diagnostic recipe (read-only):** query `product_sales` for the product; if most days have
`revenue = 0` while quantity is present, and a handful of days have duplicate `(name,date)` rows
sharing an identical revenue value, this is the bug. `quantity_stored − Σ(duplicate-row qty)`
will usually equal the true Gastronovi quantity.

**Related, separate fact:** `aggregateProducts` (sales-db.ts) and the Produkt-Analyse ranking
group by **exact `product_name`** — there is NO cross-name normalization at aggregation time.
`normalizeProductName` is used ONLY for the Anzahl↔Umsatz join, never to merge ranking rows.
So e.g. "Pizza Prosciutto TA", "Pizza Prosciutto", "Pizza Prosciutto e Funghi TA" are always
separate ranking rows; none are folded into another.

**Also note:** many legitimate "modifier" rows (steak doneness "À point"/"Bien cuit"/"Saignant",
spice "scharf"/"mittel", "ohne Alkohol", ice-cream flavours) carry quantity but `revenue = 0` by
design — the revenue sits on the parent article. Do not mistake those for this bug.
