---
name: Beaulieu Lieferanten-PDF-Import (Profile)
description: PDF-Rechnungserkennung über MWST-Nr-Profile für Mandant beaulieu — Architektur, Regeln, Fallstricke.
---

# Beaulieu Lieferanten-PDF-Import

- Profile in `src/lib/lieferanten-profile.ts`: KV-Key `waren_lieferanten_profile_v1` (tenantKey), Defaults `DEFAULT_PROFILE_BEAULIEU` (10 Lieferanten). Erkennung über MWST-Nr (nur Ziffern normalisiert); `EIGENE_MWST_NRN` (Beaulieu 336566594) darf NIE als Lieferant matchen. Hof am Stutz hat keine MWST-Nr → Name/IBAN-Tokens.
- Parser `src/lib/profil-pdf-parse.ts`: pro Profil eigener Kopfparser + generischer Fallback; Stufe-2-Positionen nur Terravigna/Spahni/Fideco. Fixtures = pdftotext-Extrakte unter `src/lib/__tests__/fixtures/beaulieu-pdf/`.
- **Regex-Fallen:** Spahni-Einheit ist auch `ST` (nicht nur STK); Terravigna-ArtNr kann ohne Bindestrich sein und der Betrag MUSS `x.xx`-Rappen haben, sonst matcht der QR-Zahlteil («00 00000 … 86253»); Bohnenblust-MwSt nur aus «2.6% MwSt. aus Betrag von CHF X  CHF Y», nie aus «Total inkl. MwSt.».
- Buchung über generalisierten FS-Kern `kernImportiereFsRechnungen` (opts `noteLabel`/`idPrefix`/`extraMapping`/`defaultKonto`); extraMapping-Regeln VORNE ins Array (WarengruppenMapping ist Array, kein Record!). Stufe 1 = synthetische Position (artNr '', preis 0) → Preisüberwachung/Historie überspringen sie.
- **Vorschau ist führend:** Stufe-2-Lieferungen werden nur gebucht, wenn Positionssumme = editiertes Netto (±0.05) UND Datum/Rechnungs-Nr unverändert; sonst Kopf-Buchung mit den User-Korrekturen. Nie stumm Roh-Parsdaten importieren.
- Undo-Typ `pdf_profil` (eigener Slot), Snapshot Monate ±1 + Preishistorie.
- Supplier-Sync (defaultWarenkonto/-Kategorie/-VatRate) als EIN Batch nach dem Import — nie pro Profil parallel (Read-Modify-Write-Race auf Supplier-Liste). Profil-Editor-Saves über Promise-Queue serialisieren.

## Dual-Lieferanten (Belegtyp)
- Profil-Feld `belegtyp`: 'dual' (Fideco/Spahni/Gasser/Bohnenblust; FS hat eigenen Import) | 'monatsrechnung' | 'einzelrechnung' (Default). Dual = FS-Modell: Lieferschein führend, Monatsrechnung Kontrolle+Lückenfüller.
- Erkennung: dual + Stufe 2 + >1 Lieferung ⇒ Monatsrechnung (pro Zeile umschaltbar). Abgleich in `monatsrechnung-abgleich.ts`: exakt LS-Nr (Monate ±1), sonst Datum+Brutto ±0.10; jede Bestandsbuchung deckt max. EINE Lieferung.
- **Doppelte Absicherung gegen Überschreiben echter Buchungen:** (1) Abgleich wird UNMITTELBAR vor dem Schreiben frisch gerechnet — bei Abweichung Abbruch; (2) Kern-Wache: quelle='monatsrechnung' + vorhandener nicht-provisorischer Treffer ⇒ `uebersprungen`, nie ersetzen. Nur eigene provisorische MR-Einträge sind upsert-bar.
- Spahni-Parser erkennt ZWEI Layouts: Sammelrechnung («LS-Nr. X vom Y»-Blöcke) UND Einzel-Lieferschein («Liefersch./Kd.-Nr. : <Nr> / XBEA» + «Lieferdatum» ⇒ EIN Block, LS-Nr = Rechnungs-Nr). Mehrere Sammelrechnungen pro Monat kollidieren nicht: Abgleich prüft nur die im jeweiligen PDF gelisteten Lieferungen.
- **Belegart-Sperre (alle Lieferanten):** erkenneBelegart klassifiziert Auftragsbestätigung/Offerte/Bestellung — nie buchbar (rote gesperrte Karte, nur Hinweis). Expliziter Rechnungs-Kopf («RECHNUNG…», «Rechnung <Nr>», «Faktura») gewinnt IMMER, damit Fusstexte die Sperre nicht auslösen. Backfill/Mehrfach-Rechnungen pro Monat laufen über die Lieferungsnr-Identität (Upsert), nie zusammenfassen.
- **Terravigna-Ausnahme (abAlsLieferschein, fest an Defaults gebunden):** AB wird als PROVISORISCHE Lieferung gebucht (quelle='auftragsbestaetigung', Identität = AB-Nr); die RECHNUNG ist massgeblich, bucht direkt (nie Kontroll-Modus) und ersetzt provisorische ABs via exakte Ref oder Datum ±3 Tage (opts.ersatzFensterTage, Default 7) + Brutto ±0.10. Beide quelle-Werte gelten im Kern als provisorisch: echte Buchungen werden NIE überschrieben. vorschauProvisorischeErsetzungen ist NUR Anzeige — massgeblich ist der Kern-Schreibpfad.
- Monatsrechnung bucht NIE ihren Gesamtbetrag; nur fehlende Lieferungen als provisorisch (`quelle:'monatsrechnung'`), Gruppierungsschlüssel `profilId|mr` hält MR- und LS-Buchungen im selben Import getrennt.

## Rangordnung neu (Aug 2026): Monatsrechnung MASSGEBLICH
- Modell: MR (final) > Lieferschein/AB (provisorisch). Kern-MR-Pfad überschreibt provisorische Buchungen mit finalen Werten, Lieferdatum je EINZELNER Lieferung aus der Rechnung (nie Belegdatum), setzt `final:true`; ohne Match frisch (final) gebucht, nie Gesamtbetrag zusätzlich.
- Ergebnis-Interface fs-import: `uebersprungen` entfernt → `bereitsFinal` + `ueberschrieben`.
- FINAL-Wache: finale Buchung wird von weiterer MR nur bei EXAKTER Referenz aktualisiert (idempotenter Re-Import); Datum/Betrag-Treffer ⇒ bereitsFinal-Skip. LS/AB-Upload nach Finalisierung ⇒ bereitsFinal (auch Ref-Match Monate ±1).
- MR-Match: exakte Ref (Monate ±1), sonst Datum ≤ ersatzFensterTage (Default 0; Terravigna 3) + Brutto ±0.10; `vergeben`-Set: eine Bestandsbuchung deckt max. eine Lieferung pro Lauf.
- Manuell-Heuristik: match.id beginnt NICHT mit `fs-`/`lpdf-` ⇒ manuell erfasst; UI verlangt Bestätigungs-Checkbox; Bestätigung an Fingerprint (id|date|amountGross sortiert) gebunden — jede Abweichung bricht Import ab.
- MR-Altdaten ohne final-Flag = weiterhin provisorisch (rückwärtskompatibel).
- Feldschlösschen-Grenze: gebündelte Fakturas (Teilmengen-Match) werden NICHT 1:1 überschrieben, nur bestätigt; Lückenfüller sind final.

## Modus-Wahl (Aug 2026)
- `dokumenttyp` aus dem PDF-Inhalt gewinnt; nur bei null greift die Heuristik `belegart==='rechnung' && lieferungen.length>1` → monatsrechnung. Anzahl LS-Blöcke allein entscheidet NIE.

## Oliv-Erweiterung (Aug 2026)
- Import + Profil-Editor laufen für BEIDE Mandanten (Gates in Warenrechnungen.tsx geöffnet); Default-Profile gelten mandantenweit, KV bleibt per tenantKey getrennt.
- Neue Stufe-2-Parser: `ambro` (Blöcke «Basierend auf Lieferschein X vom … Lieferdatum Y» — LIEFERDATUM (2. Datum) ist massgeblich, nie das LS-Datum; Rundung wird dem MwSt-Betrag zugeschlagen, damit netto+mwst=Gesamtbetrag; belegtyp 'monatsrechnung' ⇒ modus immer final), `transgourmet` (EIN LS je Rechnung, «/» oder «vom»; Food/Non-Food je Position aus der MWST-Klasse: 2.6%→Food, 8.1/0%→Nonfood — deckt exakt die Sparten-Tabelle 42020/42030/42040/42060=Food, 42880/43010/47010/61520/64110=Non-Food; mwstSatz null wegen Mischsätzen), `bohnenblust` («Lieferschein Nr. X vom Y Total Z»-Blöcke).
- Zeilen-Parsing der neuen Parser über Zellen-Split `\s{2,}` (Zeilenrekonstruktion verbindet PDF-Zellen mit Doppel-Leerzeichen) statt fragiler Ganz-Zeilen-Regex; Bezeichnung teils auf Nachbarzeile (Ambro).
- **Mandanten-Gegenprobe:** `erkenneMandantImText` (Beleg-Adresse: Oliv Gastro AG/Restaurant & Bar Oliv vs Restaurant Beaulieu) — fremder Mandant ⇒ Zeile GESPERRT (istBuchbar false), nie stilles Umbuchen; beide/keine Adresse ⇒ null (kein Raten). **AUSNAHME Bohnenblust:** Adresse ist IMMER «Restaurant Beaulieu AG» — dort entscheidet die Kunden-Nr (1422004=Oliv, 9865.2=Beaulieu); unbekannte Nr ⇒ null + Warn-Hinweis «Mandant nicht eindeutig» in der Vorschau (buchbar, aber geflaggt).
- Fixtures neu via PRODUKTIVER Zeilenrekonstruktion erzeugen (esbuild-Bundle von gn-pdf-lines + reconstructGnPdfLines über die /tmp-Item-JSONs), Ablage `fixtures/oliv-pdf/`; Tests `oliv-pdf-parse.test.ts` mit exakten Kontrollwerten.
- Spahni-Kopf: Belegdatum aus «Zollikofen , 31.07.26  Seite» (generischer Fallback fängt nur 4-stellige Jahre).

## Profil-Lernen ohne MWST-Nr
- `lerneProfil` leitet ohne MWST-Nr automatisch Namens-Tokens ab (lowercase, Wörter ≥3 Zeichen) → `findeProfilImText` erkennt den Lieferanten beim Re-Import; bestehende Tokens/IBAN nie überschreiben. Lernen ist KUMULATIV — Import-Undo rollt Profile bewusst nicht zurück.
- AB→Rechnung (Terravigna): Dokumente tragen KEINE gemeinsame Referenz (Rechnung nennt die AB-Nr. nicht). fs-import ersetzt eine provisorische AB nur bei GENAU EINEM Kandidaten im Fenster (Toleranz max(0.10, 1 % Brutto)); Matcher generell in zwei Pässen: exakte Referenz VOR Datum+Betrag.
