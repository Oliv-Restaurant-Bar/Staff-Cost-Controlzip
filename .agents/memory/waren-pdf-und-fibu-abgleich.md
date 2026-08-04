---
name: Warenrechnungen PDF-Erkennung & FIBU-Abgleich
description: PDF-Erkennung (pdfjs+tesseract lazy), Alias-Lernen nur mit Opt-in, Journal-Keys mandantenfähig (Oliv legacy-unpräfixiert)
---

- **Journal-Keys mandantenfähig (seit Aug 2026)**: `journalMonthKey` in reporting-store — Oliv bleibt aus Legacy-Gründen OHNE Präfix (`sage_journal_v1_{y}_{m}`, alle Alt-Importe), andere Mandanten mit Tenant-Präfix (`beaulieu:sage_journal_v1_…`). Alle Journal-Funktionen nehmen optionales `tenantId` (Default 'oliv'); `journalVerfuegbarFuerTenant()` erlaubt oliv+beaulieu, unbekannte Mandanten degradiert. **Why:** Beaulieu braucht den lieferantengenauen FIBU-Abgleich; Oliv-Keys umbenennen würde Alt-Daten verwaisen. **How to apply:** JEDER Journal-Reader/-Writer (auch Freshness-Checks in import-tasks-db, Undo-Snapshots) muss tenantId durchreichen — vergessener Default 'oliv' zeigt sonst still Oliv-Daten beim falschen Mandanten.
- **Sage-Kontoblatt-PDF liefert jetzt auch Buchungszeilen**: parseSageKontoblatt extrahiert Journal (Soll/Haben-Klassifikation über die Saldo-Bewegung, da im PDF-Text nur EINE Betragsspalte steht); Monatswert primär TotalSoll−TotalHaben nur wenn BEIDE Werte auf der Total-Haben-Zeile lesbar (sonst Endsaldo−Vortrag, signiert — negative Salden!). Mandanten-Check via Firmenname im Kopf («Oliv Gastro AG»/«Restaurant Beaulieu AG»); Jahres-Lock im CSVImport-Speicherpfad FAIL-CLOSED via getLockStateStrict. Tests verankert an echten PDF-Textdump-Fixtures (`src/lib/__tests__/fixtures/sage-oliv-*`).
- **Lieferanten-Journal = NUR Warenaufwand-Konten 4000–Grenze (write-time-Filter)**: alle Kosten-Import-Pfade (Einzelmonat, Mehrmonat, Jahres-Import) filtern Buchungszeilen vor `saveJournalEntries` via `splitWarenJournal` (waren-klassen, strikt — keine Legacy-Regel, 5-stellig→4-stellig). Auch im Ergänzen-Modus wird das BESTEHENDE Journal mitbereinigt und als replace geschrieben; leere Waren-Liste wird bei replace geschrieben (purgt Alt-Journale). **Why:** Löhne (MIRUS 5xxx), Gebühren, 4701/4800/4900 verfälschten den FIBU-Abgleich pro Lieferant. **How to apply:** Neue Journal-Writer MÜSSEN vor dem Save filtern; ER-Kontobeträge (expenseCategories) bleiben davon unberührt — dort werden ALLE Konten gespeichert.
- **Alias-Lernen nur mit expliziter Zustimmung**: erkannte Roh-Schreibweise (erste Textzeile) kann Adress-/Kopfzeile sein; automatisches Speichern vergiftet künftige Auto-Matches dauerhaft. Checkbox default UNCHECKED, Reset pro PDF.
- **Lieferanten-Volltext-Matching** (`findSupplierInText`): Kern-Tokens ohne Rechtsformen (STOP_TOKENS), Ein-Token-Namen < 4 Zeichen nie matchen, bei Gleichstand kein Match (mehrdeutig = unzugeordnet).
- OCR: tesseract.js lazy-import nur wenn pdfjs-Text < 40 Zeichen (Scan); Fehler → `ocrFehler`, nie throw — UI fällt auf manuelle Erfassung zurück, PDF bleibt Beleg.
- `page.render({ canvasContext, viewport })` — kein `canvas`-Property (pdfjs-Typen).

## Lieferanten-Alias-Gruppen (Anzeige-Gruppierung)
- KV `waren_alias_gruppen_v1` (tenantKey), Form `{groups:[...]}` — «Key fehlt» ≠ «leer gespeichert»: nur bei fehlendem Key erhält Beaulieu Defaults (Prodega/Transgourmet, Gourmador/Frigemo); kein Write-on-Read.
- Kanonisierung IMMER via `applyAliasGruppen`/`buildAliasResolver` (waren-alias-gruppen.ts, normalizeSupplierKey-basiert) an der Ladestelle der Rechnungsliste — nie Beträge/Daten ändern, nur supplierName-Merge.
- FIBU-Abgleich: erfasst+gebucht pro Gruppe summiert, Journal matcht auch Gruppen-Aliasse; `mitglieder`-Breakdown nur bei echter Zusammenführung. Drilldown-/Detail-Filter müssen Original-Namen via Resolver vergleichen (entries behalten Original-Namen).

## Manuelles FIBU-Matching (Drilldown)
- Match-Gruppen sind rein zuordnend (IDs/Schlüssel, nie Beträge); Buchungen ohne stabile ID → deterministischer Schlüssel aus Feldern + Duplikat-Index in Anzeige-Reihenfolge; verschwundene Schlüssel werden ignoriert, nie «repariert».
- Optimistische KV-Saves in schneller Folge: IMMER serialisieren + funktional auf Ref-Stand mutieren; Rollback nur auf den Vorzustand der fehlgeschlagenen Mutation; Erfolgs-UI (Toast/Auswahl leeren) erst nach bestätigtem Save.

## Auto-Match (FIBU-Abgleich)
- Auto-Match nur eindeutige Treffer; Datumsnähe ist BEWUSST Tiebreaker bei gleicher Differenz (Produktentscheid des Users, Spez. 3c) — Reviewer-Einwand dagegen wurde bewusst nicht umgesetzt.
- Manuell aufgelöste Matches sperren ihre Mitglieder dauerhaft für den Auto-Lauf (gesperrt-Liste im Match-Blob); ein neues manuelles Match entsperrt sie wieder.
- Auto-Lauf darf erst NACH dem Laden des gespeicherten Match-Zustands starten, sonst matcht er gegen leeren State und dupliziert.
- Toleranz (Default CHF 10) ist mandantenweit persistiert und steuert auch die grüne Ampel.

## Transgourmet/Prodega CSV-Positionsimport & Preisüberwachung
- Portal-CSVs verwenden Rechnungsnummern über Monate wieder (z.B. "58") — Dokument-Identität ist IMMER rechnungsNr+Datum (docKey), nie die Nummer allein; gilt für Gruppierung, Dubletten und Preis-Historie-Quelle.
- Preisüberwachung: Einzelpreis (Spalte "Preis", netto) pro Mandant+Lieferant+Art.-Nr. (Fallback normalisierter Name, ohne beides kein Hinweis); Pfand = MwSt-Code 0 ausgenommen; Mindest-CHF-Differenz gegen Rundungsalarme; Re-Import desselben Dokuments vergleicht nicht neu, ersetzt nur.
- **Why:** Doppel-/Korrektur-Importe dürfen die Historie nicht verfälschen und keine Schein-Preisänderungen melden.

## FIBU-Übernahme (Buchung → provisorische Rechnung)
- Kandidaten = 'nur-gebucht'-Zeilen + nichtZugeordnet MINUS bereits gematchte Buchungen; Schlüssel MÜSSEN `buchungKeysMitIndex` (`…#0/#1`) sein — derselbe Schlüsselraum wie das Match-Drilldown, sonst entfernt ein Match auf eine von zwei identischen Buchungen beide (bare Alt-Keys defensiv als `#0` lesen).
- Übernahme schreibt InvoiceEntry mit `quelle:'fibu_uebernahme'`, `final:false`, `vatIncluded:false`, Betrag exakt Soll−Haben; danach manuelle FIBU-Match-Gruppe (invoiceId↔indizierter Key) via serialisiertem persistFibuState — bei Fehlschlag 1 idempotenter Retry + explizite Warnung (Dubletten-Wache verhindert Doppel-Übernahme).
- Jeder Schreibpfad im Abgleich-Tab braucht das `canCreate`-Gate — der Tab ist auch für Nur-Leser sichtbar.

## Barausgaben (Bar-/Kasseneinkäufe) als eigene Lieferanten
- Buchungstexte mit Präfix «Barausgabe(n)» → kanonischer Lieferant «Barausgaben <Laden>» (barausgabenLieferant, Vorrang vor findSupplierInText); pro Laden abgeleitete Standard-Alias-Gruppen (`<Laden>`, `Barausgabe <Laden>`), die VOR den Nutzer-Gruppen einsortiert werden — buildAliasResolver ist last-write-wins, Nutzer-Gruppen überstimmen.
- **buildWarenAbgleich liefert `effektiveAliasGruppen`** — JEDE UI-Stelle, die Rechnungen einer Abgleich-Zeile filtert (Match-Drilldown), MUSS ihren Resolver daraus bauen, nie nur aus den gespeicherten Nutzer-Gruppen, sonst leeres Drilldown bei abgeleiteten Gruppen.
- Übernahme-Kandidaten für Barausgaben-Zeilen auch bei Status ok/abweichung auf BUCHUNGS-Ebene: ungematchte Buchungen ohne Datum+Betrag-Gegenstück (±5 Rp.) in den erfassten Rechnungen; jede Rechnung deckt genau EINE Buchung, und in Match-Gruppen verbrauchte invoiceIds dürfen keine zweite Buchung decken (sonst verschwindet der Kandidat bei identischen Doppel-Buchungen).
