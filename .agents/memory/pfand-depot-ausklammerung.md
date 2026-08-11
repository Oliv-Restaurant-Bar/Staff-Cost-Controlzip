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
- **Erkennung** (`waren-positionen.ts`): MwSt-Code 0 (hart) + `istPfandBezeichnung`
  Token-genau (pfand*/leergut*/gebinde*/harass(e|en)/ifco*/depot(+gebühr)) —
  bewusst KEIN Präfix-Match mitten in Wörtern (Deposito/Harissa-Fallen).
  Vorrang: MwSt-Code 0 > manuelle Artikel-Zuordnung > Text-Pfand > Warengruppe
  (explizite User-Zuordnung ist kein «Zweifel»).
- Depot-Hinweis im Abgleich ist nur noch informativ («separat als Depot, nicht
  im Vergleich») — nie mehr Erklärung einer Differenz.
- **Why:** Transgourmet-Ifco/Harasse erzeugte in fast allen FIBU-Matches
  «enthält Leergut/Pfand»-Restdifferenzen; Vergleich muss Waren gegen Waren sein.
- **How to apply:** Neue Warenkosten-/Abgleich-Summen IMMER über nettoOhneDepot;
  jede neue Kategorie-/Klassen-Filterung muss dieselbe istDepotSplitKonto-Regel
  nutzen, sonst Total ≠ Food+Beverage.
