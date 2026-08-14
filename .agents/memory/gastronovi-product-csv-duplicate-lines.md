---
name: Gastronovi product-sales CSV import — duplicate line-items
description: How matchAnzahlUmsatz handles a product listed on multiple export lines, and the inherent limit of a flat (no article-number) CSV.
---

# Gastronovi product-sales import: duplicate-name line-items

## Hierarchischer Export («> »-Detailzeilen) — Dreifachzählungs-Schutz (08/2026)
Neuere Exporte sind hierarchisch: Kategorie-SUMMEN («Food (Speisen)», «Beverage (Getränke)», «Gesamt»)
plus «> »-Detailzeilen; jede der 4 Dateien (BA/BU/FA/FU) enthält EINE Kategorie im Detail, die andere
nur als Summe. Regeln in `parseWideFile` (hierarchischer Modus, sobald eine Zeile mit «>» beginnt):
- Nicht-«>»-Zeilen = Aggregate → komplett überspringen; Ausnahme Blattwerte OHNE Kinder:
  **Trinkgeld** und **Non-Foods (Nichtlebensmittel)** (`HIERARCHIE_BLATT_AUSNAHMEN`).
- «> »-Präfix wird für Speicherung/Matching entfernt.
- Blatt-Ausnahmen stehen in BEIDEN Dateipaaren → `dedupeAcrossPairs` (SalesUpload, in doParse =
  Vorschau-paritätisch) entfernt NUR diese per Name+Datum (Food gewinnt); Lösch-Scope beim Import
  aus den UN-deduplizierten Zeilen (sonst überleben Alt-Dubletten).
- Umsatz-only-Produkte werden mit quantity 0 importiert (nicht mehr verworfen), «(nur in Umsatz)»-Flag bleibt.
**Why:** Aggregat+Detail+Paar-Doppelung ergab exakt Faktor 3 (Beaulieu 08/2026: 18'897 statt 6'300).
**How to apply:** Faktor gegen die Gesamt-Zeile der Datei muss 1.0 sein; Altformat (ohne «>») bleibt unverändert.

When a single product name appears on **more than one line** in a Gastronovi wide-format
export (the "Anzahl"/quantity file and/or the "Umsatz"/revenue file), `matchAnzahlUmsatz`
in `src/lib/gastronovi-csv-parser.ts` aggregates them.

## Current behaviour (the fix — shipped)
Both Anzahl and Umsatz lines are aggregated **per normalized product name, summing day
values per date** (`aggregateRowsByName`), and exactly **one** record is emitted per
`(product, date)`. `MatchResult.duplicateProducts` lists every product that was merged so
the import preview can surface it (blue banner in `SalesUpload.tsx`).

**Why:** the old code had two defects, both triggered by duplicate line-items:
1. *Umsatz lookup was last-write-wins* (`umsatzMap.set(name,row)`) → an earlier same-name
   Umsatz line was silently discarded → month revenue collapsed.
2. *Anzahl lines were never de-duped* → two quantity lines emitted two rows for the same
   `(name,date)`, both reading the single surviving Umsatz value → quantity inflated and
   that day's revenue double-counted. Tell-tale signature in `product_sales`: two rows with
   the same `(product_name, sale_date)`, identical `revenue`, different `quantity`.

**How to apply:** never reintroduce a `Map.set(name,row)` overwrite or per-line emission
here. Summing duplicate same-name lines is the intended aggregation.

## Inherent limit — same name, different article
The wide CSV has **no article-number column**, so two genuinely different articles that
share a display name (e.g. a 10-CHF item and a 16-CHF item both called "Pizza Prosciutto TA")
are indistinguishable and get **summed**. Re-importing the real June 2026 food export after
the fix therefore yields the *summed* totals (Pizza Prosciutto TA ≈ qty 509 / rev 5222),
**not** Gastronovi's article-level split (qty 487 / rev 4870). This is expected, not a bug —
separating them would require article numbers the flat CSV doesn't carry.

## Related, separate facts
- `aggregateProducts` (sales-db.ts) and the Produkt-Analyse ranking group by **exact
  `product_name`** — NO cross-name normalization at aggregation time. `normalizeProductName`
  is used ONLY for the Anzahl↔Umsatz join, never to merge ranking rows.
- Many legitimate "modifier" rows (steak doneness, spice level, "ohne Alkohol", ice-cream
  flavours) carry quantity but `revenue = 0` by design — the revenue sits on the parent
  article. Do not mistake those for the old bug.
