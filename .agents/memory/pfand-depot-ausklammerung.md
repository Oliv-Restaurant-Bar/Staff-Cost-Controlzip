---
name: Pfand/Leergut = Depot, kein Warenaufwand
description: Depot-Splits sind aus ALLEN Warenkosten-Summen und dem FIBU-Abgleich ausgeklammert; Pfand-Erkennung MwSt-Code 0 + Token-Text; manuelle Artikel-Zuordnung schlägt Text-Erkennung.
---

# Pfand/Leergut/Gebinde → Depot (08/2026, Build-Befehl)

- **Regel:** Pfand ist KEIN direkter Warenaufwand — die FIBU bucht Depot auf ein
  separates Konto. SSOT `waren-cockpit.ts`: `istDepotSplitKonto` /
  `depotAnteilNet` / `nettoOhneDepot`. Diese Basis gilt für `sumInvoicesNet`,
  `aggregateBySupplier`, `kategorieShares`/`sumNetByKategorie` (Food+Bev =
  Total ohne Depot!), `buildWarenAbgleich` (erfasst-Seite) und ALLE Beträge in
  `waren-fibu-matches.ts` (Auto-Match, sumI, offenErfasst, nur_erfasst).
- Rechnungen OHNE kontoSplits behalten ihr volles amountNet (kein Raten);
  persistierte Daten werden NIE mutiert — Ausklammerung rein rechnerisch.
- **Erkennung** (`waren-positionen.ts`), zweistufig token-genau (kein Präfix-Match
  in Fremdwörtern — Deposito/Harissa-Fallen):
  - STARK (pfand*/leergut*/ifco*/depot(+gebühr)) → immer Depot;
  - SCHWACH (gebinde*/harass(e|en)) → NUR wenn die Warengruppe keinem Konto
    zuordenbar ist (Zweifel → Depot statt «offen»); gemappte Gruppe gewinnt
    (Bier «10×33 Harass» 8.1 % bleibt 4030/4050!).
  Vorrang: MwSt-Code 0 > manuelle Artikel-Zuordnung > Stark-Text > Warengruppe >
  Schwach-Text (explizite User-Zuordnung ist kein «Zweifel»).
- **Feldschlösschen** (`kontoSplitsAusFsKategorien`): ZSF-Kategorienamen
  leergut|ladungsträger|pfand|depot|gebinde|harass(e|en) → Depot (unabhängig vom
  MwSt-Mix); Recyclinggebühren bewusst im Mapping (4701, echte Gebühr, kein Depot).
  Kontrollwerte FS Juli Oliv: Depot 645.00 / Warenkosten 15'064.15 / 465 → 4701.
- Depot-Hinweis im Abgleich ist nur noch informativ («separat als Depot, nicht
  im Vergleich») — nie mehr Erklärung einer Differenz.
- **Why:** Transgourmet-Ifco/Harasse erzeugte in fast allen FIBU-Matches
  «enthält Leergut/Pfand»-Restdifferenzen; Vergleich muss Waren gegen Waren sein.
- **How to apply:** Neue Warenkosten-/Abgleich-Summen IMMER über nettoOhneDepot;
  jede neue Kategorie-/Klassen-Filterung muss dieselbe istDepotSplitKonto-Regel
  nutzen, sonst Total ≠ Food+Beverage.
