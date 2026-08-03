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
