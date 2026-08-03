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
