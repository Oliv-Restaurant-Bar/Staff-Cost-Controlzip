---
name: Feldschlösschen PDF-Import
description: Parser-/Import-Regeln für Feldschlösschen Lieferschein-, Sammelrechnungs- und Historien-ZIP-PDFs (Warenkosten).
---

**Regeln:**
- Parser rein in `feldschloesschen.ts`, arbeitet auf `FsZeile` aus `toFsZeilen(reconstructGnPdfLines(...))`; `kompakt`-Feld toleriert pdfjs-Ligatur-Splits («Di|ff|erenz»). pdfjs in Node-Harnessen nur via CJS-require `pdfjs-dist/legacy/build/pdf.js` (ESM-Import scheitert).
- Kategorie-Klassifizierung: MWST-Satz ist das harte Signal (2.6 % ⇒ alkoholfrei, C0/0 % ⇒ Leergut); 8.1 % nur per Keyword/Marken-RX, unbekannt ⇒ `null` = Konto «offen» — NIE raten.
- Sammelrechnung ist reine KONTROLLE, wird nie als InvoiceEntry gebucht. `matchFakturen`: Datum ±7 Tage, Betrag ±0.10, Teilmengen-Suche per Bitmaske (eine Faktura bündelt mehrere, auch negative Leergut-LS). Anhang-LS-Brutto = offizieller «Endbetrag CHF» je Faktura via Rundungsausgleichs-Position (mwstCode 0, ≤2 CHF); die «inkl. Pfand»-Zeile darf `warenwertNetto` nicht überschreiben.
- Anhang-Übernahme braucht die Duplikat-Wache `findeNaheRechnung`: bestehende, keiner Faktura zugeordnete Rechnung im ±7-Tage/±0.10-Fenster blockiert den Import (gleiche Lieferung unter anderer Referenz) — nur exakte Referenz+Datum-Treffer dürfen upserten.
- Historie: KV `fs_historie_<jahr>_v1` (Record<sammelNr, Eintrag>, dublettensicher), EIN Jahres-Lock `fs_historie_lock_v1`, im Save-Pfad IMMER frisch gelesen; Lock-LESEFEHLER wirft (im Zweifel blockieren). ZIPs mit Umlaut-Dateinamen nur mit Python `zipfile`/jszip öffnen, `unzip` bricht.

**Why:** Review fand Doppelbuchungs-Risiko bei der Anhang-Übernahme (Faktura «fehlt» trotz naher bestehender Rechnung); Kontrollwerte: Lieferschein 17.07.2026 = 492.85, Juni-Sammelrechnung 87749870 = 9'723.00 / 5 Fakturas exakt.
**How to apply:** Bei jeder Änderung an FS-Parser/Import zuerst `src/lib/__tests__/feldschloesschen.test.ts` (node-Pragma) laufen lassen und gegen die /attached_assets-PDF-Kontrollwerte verifizieren.

## Lieferschein führend / Jahres-ZIP (Aug 2026)
- Kern-Pipeline in `fs-import.ts` (`kernImportiereFsRechnungen`): per-Monat-Caches, EIN KV-Write pro Monat — Pflicht für jahresgrosse Läufe.
- Jahres-ZIP bucht jetzt ALLE eingebetteten Anhang-Lieferscheine als Warenkosten (Lieferdatum!) + Preis-Historie + fs_historie; EIN Undo (typ fs_historie) über Monate+Historie+Jahre; Jahr-Sperre vor jedem Schreiben frisch prüfen.
- Anhang-Übernahme aus Monatsrechnung setzt `InvoiceEntry.quelle='monatsrechnung'` (provisorisch, Badge). Echter Lieferschein ersetzt nahe provisorische Einträge (gleiche Referenz ODER ±7 Tage/±0.10) auch über Monatsgrenzen — dabei IMMER Positionen UND Preis-Hinweise des alten Eintrags löschen (Waisen-Bug, vom Review gefunden); Undo-Snapshot inkl. Nachbarmonate.
- Regressionstests: `src/lib/__tests__/fs-import.test.ts` (KV-Mock; Monatsgrenzen-Ersetzung ohne Waisen).

## Kategorie-Aufteilung folgt der FGG-«Zusammenfassung MwSt.» (massgeblich)
- Moscht/Cider (CIDER_RX) ist NIE Bier — auch die 8.1%-Variante zählt FGG zu «Andere alk. freie Getränke».
- Obstbrände: Keyword (`brand\b` etc.) plus Alkohol-%-Signal ≥15 in der Bezeichnung ⇒ Spirituosen; Bier mit tiefem % (5.2%) bleibt Bier.
- VEG-Einweg-Glasgebühren zählt FGG zur WARENkategorie (2.6% ⇒ Andere alk. freie, 8.1% ⇒ Spirituosen heuristisch); nur Logistikpauschalen sind «Zu-/Abschläge».
- Umgebrochene Bezeichnungen: Markentext-Zeilen stehen VOR ihrer Materialzeile (Weizenfrisch-Fall) ⇒ pendingText/pendingBez mit Verpackungs-Suffix-Heuristik (/\d+X\d/ ⇒ gehört zur VORHERIGEN Position). Kopfzeilen-Filter darf nur `feldschlösschengetränke` (Absender) ausschliessen, nicht jedes «Feldschlösschen …» (Markennamen!).
- Post-Pass `nachklassifiziereProArtikel`: abgeschnittene Bezeichnungen («24X0,33 (AKTION)») erben die Warengruppe der längsten Bezeichnung derselben Artikel-Nr im Dokument.
- **Why:** Juli 2026 Beaulieu: «Erfasst» wich pro Kategorie ab (Bier +87, AF-Bier −230, Spirituosen −118 …), Gesamtsumme stimmte. Nach den Regeln: alle Kategorien Diff 0.00; Leergut −0.09 = neutrale Rundungsdifferenz-Position (gewollt).
- **How to apply:** Klassifizierung nie an der Gesamtsumme validieren, sondern per Kategorien-Gegenprobe gegen die Zusammenfassung MwSt. Nur warengruppe/bezeichnung ändern, nie positionspreis (Matching/Beträge bleiben unangetastet). Alte gespeicherte Positionen werden erst durch erneuten Upload der Monatsrechnung finalisiert.

## Belegtyp inhaltsbasiert + ZIP final (Aug 2026)
- `erkenneDokumenttyp(text, belegart)` (profil-pdf-parse.ts): Kopfzone = erste 25 nicht-leere Zeilen; «Sammel-/Monatsrechnung» → monatsrechnung; Nicht-Rechnung (AB/Offerte/Bestellung) → lieferschein; «Lieferschein»-Überschrift ohne «Rechnung» im Kopf → lieferschein; sonst null.
- `erkenneBelegart` prüft ebenfalls Kopfzone ZUERST (AB-Kopf + «Rechnung» im Fusstext bleibt AB); ohne Kopf-Signal zählt der Gesamttext.
- Jahres-ZIP-Import bucht Anhang-Lieferungen mit `quelle:'monatsrechnung'` (final, ersetzt provisorische).

## Konto-Splits aus der Faktura-eigenen «Zusammenfassung MwSt.» + FIBU pro Lieferant (Aug 2026)
- `parseFsSammelrechnung` liest im Anhang je Faktura die eigene ZSF nach `fakturaKategorien[fakturaNr]` (zsfModus; «Endbetrag CHF» geht weiter an die bestehenden Handler, globale kategorien bleiben sauber).
- `kontoSplitsAusFsKategorien`: Bier→4030, Spirituosen→4040, Mineralwasser/Andere alk. freie→4050, Wein→4020, Leergut/Ladungsträger + reine 0%-Kategorien→'Depot' (neutral), Mietmaterial/Recycling/Zu-/Abschläge→4701, unbekannt→'offen' (nie raten). Brutto = n81·1.081+n26·1.026+n00.
- Import: `FsImportRechnung.fsKategorien` übersteuert die Positions-Kontierung NUR wenn ΣZSF-Netto ≈ Buchungs-Netto (±0.10), sonst sichtbarer Hinweis + Positions-Fallback. UI übergibt die ZSF nur bei Fakturen mit GENAU EINEM Anhang-LS (Buchung=pro LS, ZSF=pro Faktura; 1:n nicht eindeutig aufteilbar).
- FIBU-Konto-Abgleich: `buildKontoAbgleich({lieferantZeilen})` löst FS-Rechnungen (supplierName) und Journal-Buchungen (text-RX) aus dem Pro-Konto-Vergleich und aggregiert sie in eine `~Feldschlösschen`-Zeile — FIBU bucht FS pauschal ~4030, Pro-Konto wäre systematisch rot. Depot-Splits UND reine Depot-Einzelkonto-Rechnungen bleiben neutral separat (Review-Fund).
- **Why:** User-Vorgabe 08/2026: Kontierung folgt der Rechnungs-eigenen ZSF; Kontrolle Juli Oliv (7 FS-Rechnungen): 4030 4'538.00 · 4040 2'789.30 · 4050 7'450.77 · Leergut 1'186 + Logistik 165 raus. Juli-Oliv-`kred_*`-Einträge (Σ 15'728.54 ganz auf 4030) brauchen die Oliv-Juli-Monatsrechnung (PDF) zum Finalisieren.
