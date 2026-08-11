---
name: Pfand/Leergut = Depot, kein Warenaufwand
description: Depot-Splits sind aus ALLEN Warenkosten-Summen und dem FIBU-Abgleich ausgeklammert; Pfand-Erkennung MwSt-Code 0 + Token-Text; manuelle Artikel-Zuordnung schlägt Text-Erkennung.
---

# Pfand/Leergut/Gebinde → Depot (08/2026, Build-Befehl)

## FIBU-Abgleich: gleicher Konto-Scope beider Seiten (Erweiterung 08/2026)
- `fibuVergleichsNetto(e, grenze)` (waren-cockpit) = NUR Splits der Klasse
  «warenkosten» (4000–Grenze via kontoKlasse), ohne Depot UND ohne 4701/
  Betriebskosten — derselbe Scope, mit dem das Journal gefiltert wird.
  ALLE Abgleich-Beträge (buildWarenAbgleich erfasst-Seite, Auto-Match,
  lieferantMatchStat, zerlegeLieferantDifferenz, selSummen-Live-Ampel) nutzen
  diese Basis; `betriebsAnteilNet` liefert den informativen 4701-Hinweis.
- Degradierter Modus (kein Journal): buchhaltungTotal = `total_cogs_direct`,
  NIE `total_cogs` (enthält cogs_other 4701 + Lagerveränderung → Scheindifferenz).
- Mandanten-Grenze (`loadWarenkostenGrenze`) wird durchgereicht
  (AbgleichInput.warenkostenGrenze bzw. trailing param); Default 4090.
- sumInvoicesNet (Cockpit/WKQ-Totale) bleibt bewusst nettoOhneDepot
  (4701 zählt dort weiterhin über die Kontoklassen-Logik).
- **Why:** TG Juli zeigte −4'256.02 statt ~454.88, weil ~3'856.64 auf 4701 nur
  auf der Erfasst-Seite steckten (Journal zählt 4000–4089) — Apfel-Birnen.

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
