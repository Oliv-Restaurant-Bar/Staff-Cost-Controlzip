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
