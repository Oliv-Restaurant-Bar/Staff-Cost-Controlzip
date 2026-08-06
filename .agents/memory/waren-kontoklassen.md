---
name: Waren-Kontoklassen & Split
description: Warenkosten (4000–Grenze) vs. Betriebskosten Klassifikation, nurWarenAnteil-Muster, FIBU-Abgleich = Gesamt-Total
---

# Kontoklassen bei Warenrechnungen

**Regel:** Klasse ergibt sich NUR aus der Kontonummer: 4000–Grenze (Default 4090, KV `waren_grenze_v1`, tenantKey-präfixiert) = Warenkosten (zählen in WKQ); alles andere (>Grenze UND <4000, z.B. 4701 Betriebsmaterial, 6040) = Betriebskosten, NIE in der WKQ. Default gilt für beide Mandanten identisch; je Mandant in den Stammdaten änderbar.

**ER-Zuordnung ≠ WKQ (08/2026, explizit befohlen):** In der ER/P&L zählen 4701–4703 UND 4800–4900 zum Material-/Warenaufwand (Bruttogewinn 1, formelle OR-ER) — Defaults 4701/4800 = `cogs_other`. Die operative WKQ-Klasse (4000–Grenze) bleibt davon UNBERÜHRT — die zwei Zuordnungen bewusst nie «konsistent machen». Budget-Migration hängt pli_betriebsmat/pli_gebinde_akt von pl_other_op zurück nach pl_goods_cost. Im klassischen BPL-Split bleibt 4900 eigene Zeile NACH den Zwischentotalen (nie in «Übriger Warenaufwand»-Subtotal).

**4900 Veränderung Warenvorrat (Lagerveränderung):** eigene P&L-Kategorie/Zeile `cogs_lager` — NICHT «übriger Warenaufwand» (Range-Obergrenze übrig = 4899). P&L: `total_cogs_einkauf` = direkt+übrig (ohne 4900), `total_cogs` = Einkauf+Lager (Wareneinsatz, id unverändert für alle Konsumenten). Einkaufs-WKQ (`cogs_ratio`, auch bpl-aggregate) rechnet auf `total_cogs_einkauf`; Detailzerlegungen (Bank/Investor, PDF-Export) müssen `cogs_lager` mitführen, sonst summieren sichtbare Komponenten nicht aufs Total.
**Legacy-Regel:** Rechnung/Zeile OHNE Konto oder mit nicht-numerischem Konto = Warenkosten — Altbestand darf die WKQ nicht verlassen.

**nurWarenAnteil-Muster:** `computeWarenkostenTotals` kennt keine Splits. Deshalb wird an JEDER WKQ-/Warenkosten-total-Stelle die Eintragsliste vorab mit `nurWarenAnteil(list, grenze)` (waren-klassen.ts) reduziert (gemischte Splits anteilig, immutable, reine Betriebs-Rechnungen fallen weg). Betriebskosten separat via `sumBetriebNet`.

**Why:** Rechnungen sind auf beliebig viele Konten splittbar (kontoSplits[], Summe = Rechnungsnetto, MWST auf Rechnungsebene); ohne Klassentrennung würden Betriebskosten die WKQ verfälschen.

**How to apply:**
- Cockpit/Monatsreport: warenkosten_total/WKQ/Lieferanten-Kinder + Export-Blatt = waren-only; separate Zeile `betriebskosten_waren` (leer statt 0).
- Analyse «nach Lieferant»: GESAMT-Total über ALLE Konten + Spalten «davon Waren/Betrieb» (`aggregateBySupplierKlassen`) — Anteil-Spalte hat Gesamt-Basis, Footer-Badge ist WKQ (anderer Nenner, beschriftet lassen).
- FIBU-Abgleich pro Lieferant vergleicht bewusst das GESAMT-Total (ungefiltertes amountNet) — nur so stimmt der Kontoblatt-Vergleich. Nicht «fixen».
- Erfassungsliste/cumNet/Tages-Charts zeigen bewusst Gesamtbeträge.

## Warengruppen→Konto (CSV-Positionsimport, Aug 2026)
- Zuordnungstabelle konfigurierbar: KV `waren_warengruppen_konten_v1` (tenantKey); Default in DEFAULT_WARENGRUPPEN_MAPPING (waren-positionen.ts). Unbekannte Gruppe = status 'offen' — NIE raten.
- Positionen pro Rechnung persistiert: KV `waren_positionen_<YYYY-MM>_v1` = Record<invoiceId, GespeichertePosition[]>; manuelles Override via `manuell:true`.
- **Re-Import muss Overrides mergen**: `uebernehmeManuelleKontierung` (Identität artNr bzw. normalisierte Bezeichnung); Splits IMMER aus gemergten Positionen ableiten (kontoSplitsAusPositionen), nie frisch aus Mapping.
- Pseudo-Konten: 'Depot' (Pfand, MwSt-Code 0) → KontoKlasse 'neutral' (zählt NIRGENDS); 'offen' → bewusst Warenkosten bis Zuordnung (Policy dokumentiert in waren-klassen.ts).
- Abgleich pro Konto: buildKontoAbgleich (waren-abgleich.ts) — gebucht = Σ Soll−Haben je accountNumber (führende Nullen tolerieren), diff null ohne Journalzeile (leer statt 0), nur-Journal-Zeilen via `relevanteKonten` begrenzen sonst flutet das Kontoblatt.

## WKQ-Kategorie: Konto autoritativ (Aug 2026)
kategorieFromKonto = FIBU-identisches Schema: Beverage {4020,4030,4040,4050}, Food = ALLE übrigen Konten 4000–Grenze (inkl. 4060/4070/4090); das alte operative Mapping (4030=Tiefkühl→Food, nur 4000/4020/4030) ist abgeschafft. `kategorieOf`/`kategorieShares`: das KONTO überstimmt eine gespeicherte kategorie (Import-Altlasten «Sonstiges» auf 4060 etc. zählen wieder in die WKQ); kontolos/'offen' ohne kategorie → Food (Legacy = Warenkosten, muss in Quote); Depot/ausserhalb Range → Sonstiges, kategorie zählt nicht. Invariante: relevantNet(nurWarenAnteil-Liste) == sumWarenNet. ALLE Food/Bev-Konsumenten (Warenrechnungen, Cockpit, Kennzahlen-Bericht, TagesControlling, Analyse) müssen die zentralen Helfer nutzen — nie rohe e.kategorie summieren; Cockpit-Total/WKQ zusätzlich nurWarenAnteil-filtern.

## Konto-Normalisierung (5-stellig)
- ALLE WKQ-/Klassen-Pfade normalisieren Konten wie `normalizeWarenKonto`: 3–5 Ziffern, 5-stellig → erste 4 (`40201`→4020). `warenkosten-quote.normalisiereKontoNummer` (bewusst lokal dupliziert, Import-Zyklus) + `kontoKlasse` via normalizeWarenKonto. Nie roher `parseInt`.
- Wochen-WKQ/Analyse-KPIs (`waren-analyse`): immer split-bewusste Basis `computeWarenkostenTotals(nurWarenAnteil(list,grenze)).relevantNet` — nie rohes amountNet.
- Unkontierte (kein numerisches Konto, nicht Depot) zählen als Warenkosten; `zaehleUnkontierte()` + sichtbarer Amber-Hinweis in Cockpit/Analyse (Quote nie still unscharf).
