---
name: Analyse = direkter Warenaufwand 4020–4070
description: Warenrechnungen-Analyse-Tab nutzt bewusst NUR Konten 4020–4070 als Warenkosten-Definition (User-Befehl 08/2026) — Abweichung von der alten WKQ-SSOT, gilt nur für Analyse-Flächen.
---

Regel: ALLE Zahlen im Analyse-Tab (KPI-Box, WKQ, Wochen-WKQ, Gruppen/Anomalien/Top-Rechnungen via `nurDirektAnteil`, ER-Gegenüberstellung) basieren auf dem direkten Warenaufwand = Konten 4020 Wein · 4030 Bier · 4040 Spirituosen · 4050 Mineral · 4060 Küche · 4070 Kaffee/Tee (`direkterWarenaufwand` in waren-analyse.ts). Übrige Konten (4090/4701/48xx) und unkontierte Anteile erscheinen NUR als Hinweis, nie in Hauptzahl/Quote; Depot bleibt neutral.

**Why:** User-Befehl 08/2026 — Analyse soll exakt der ER-Position «Direkter Warenaufwand» entsprechen. Andere Tabs/Exports (warenkosten-quote.ts-SSOT, Erfassung, Cockpit) bewusst UNVERÄNDERT.

**How to apply:**
- ER-Seite je Konto kommt aus `record.expenseCategories` mit numerischer `categoryId` (roh, KEINE Vorzeichen-/Abs-Korrektur — identisch zur pl-engine-Semantik, die cat.amount unverändert summiert).
- Konto-Differenzen werden mit dem Erklär-Dropdown im Monats-Blob `waren_fibu_matches_<YYYY-MM>_v1` unter Namespace-Key `konto:<nr>` abgeschlossen — Saves MÜSSEN über dieselbe serialisierte Kette wie der FIBU-Tab laufen (`fibuSaveChain`), sonst Blob-Clobber.
- Gegenüberstellung nur bei `monthAligned` (ganze abgeschlossene Monate); Abschliessen nur in Einmonats-Sicht.
- Konto-Drilldown (`buildKontoDrilldown`): je Lieferant App- vs. FIBU-Betrag auf EINEM direkten Konto; Journal LAZY erst beim Aufklappen laden (+ `journalVerfuegbarFuerTenant`-Wache). Split-Hinweis nur «kein Fehlbetrag» nennen, wenn das Lieferanten-Total über ALLE direkten Konten ≤ 0.05 ausgleicht (`reineZuordnung`), sonst echten Restbetrag ausweisen — teilweiser Ausgleich ist KEIN reiner Split (Review-Befund 08/2026). Erklär-Grund `konto_split` existiert in ERKLAER_GRUENDE.

## Kontierungs-Check & Korrektur-Vorschläge (Befehl F, 08/2026)
- Non-Food-Konten für den Check: 4090/4701 (`NONFOOD_KONTEN`). Defizit = App−FIBU **pro Non-Food-Konto** (nachKonto = grösstes Defizit, NIE grösster App-Betrag — 4090 kann voll gebucht sein, 4701 fehlen).
- Zuteilung des Defizits über die positiven Diffs ALLER 6 direkten Konten sequenziell (grösste zuerst, deterministisch) — Summe der Umbuchungs-Vorschläge darf das Defizit nie übersteigen (Review-Befund: sonst doppelte Umbuchungen bei 2 abweichenden Konten).
- Typ-Präzedenz je Zeile: ok → kontierung → zuordnung (reiner Split) → fehlende_rechnung (diff>0) → unklar (diff<0).
- `buildKorrekturVorschlaege` liefert kopierbare Ein-Zeilen-Texte (fmtChfText: de-CH, U+2019 → gerader Apostroph für Buchhaltungssoftware); ohne Journal leere Liste.
- UI: Journal-Lazy-Load triggert auch `vorschlaegeOpen`, nicht nur kontoDrill.
