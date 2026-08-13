---
name: Beaulieu Lieferanten-PDF-Import (Profile)
description: PDF-Rechnungserkennung über MWST-Nr-Profile für Mandant beaulieu — Architektur, Regeln, Fallstricke.
---

# Beaulieu Lieferanten-PDF-Import

- Profile in `src/lib/lieferanten-profile.ts`: KV-Key `waren_lieferanten_profile_v1` (tenantKey), Defaults `DEFAULT_PROFILE_BEAULIEU` (10 Lieferanten). Erkennung über MWST-Nr (nur Ziffern normalisiert); `EIGENE_MWST_NRN` (Beaulieu 336566594) darf NIE als Lieferant matchen. Hof am Stutz hat keine MWST-Nr → Name/IBAN-Tokens.
- Parser `src/lib/profil-pdf-parse.ts`: pro Profil eigener Kopfparser + generischer Fallback; Stufe-2-Positionen nur Terravigna/Spahni/Fideco. Fixtures = pdftotext-Extrakte unter `src/lib/__tests__/fixtures/beaulieu-pdf/`.
- **Regex-Fallen:** Spahni-Einheit ist auch `ST` (nicht nur STK); Spahni-Position kann zwischen Preis und Total ein einbuchstabiges Rabatt-Kürzel («A») UND/ODER einen Rabatt-Betrag tragen — beide optional zulassen, sonst fallen Zeilen weg (Σ≠Netto); Terravigna-ArtNr kann ohne Bindestrich sein und der Betrag MUSS `x.xx`-Rappen haben, sonst matcht der QR-Zahlteil («00 00000 … 86253»); Terravigna-Menge darf NEGATIV sein (Retouren-Block subtrahiert, Blöcke nur mit Retouren dürfen nicht wegfallen; preis bleibt 0, keine Preishistorie); Terravigna-Brutto DIREKT aus «Total CHF inkl. MwSt.» (MwSt=Brutto−Netto, gemischte Sätze 8.1/2.6 — nie aus Einzelsatz zurückrechnen).
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
- Neue Stufe-2-Parser: `ambro` (Blöcke «Basierend auf Lieferschein X vom … Lieferdatum Y» — LIEFERDATUM (2. Datum) ist massgeblich, nie das LS-Datum; Rundung wird dem MwSt-Betrag zugeschlagen, damit netto+mwst=Gesamtbetrag; belegtyp 'monatsrechnung' ⇒ modus immer final), `transgourmet` (EIN LS je Rechnung, «/» oder «vom»; Food/Non-Food je Position aus der MWST-Klasse: 2.6%→Food, 8.1/0%→Nonfood — deckt exakt die Sparten-Tabelle 42020/42030/42040/42060=Food, 42880/43010/47010/61520/64110=Non-Food; mwstSatz null wegen Mischsätzen).
- **Bohnenblust ist vom Automatik-Import AUSGESCHLOSSEN (User-Entscheid 08/2026, nur manuelle Erfassung):** kein Default-Profil, keine Parser, keine Kunden-Nr-Sonderregel; loadLieferantenProfile filtert alt-gespeicherte/gelernte Profile (id 'bohnenblust' + MWST 472136586); erkenneMandantImText gibt für Bohnenblust-Texte null zurück (Adresse ist immer Beaulieu ⇒ KEINE adressbasierte Sperre). Nicht wieder «reparieren».
- Zeilen-Parsing der neuen Parser über Zellen-Split `\s{2,}` (Zeilenrekonstruktion verbindet PDF-Zellen mit Doppel-Leerzeichen) statt fragiler Ganz-Zeilen-Regex; Bezeichnung teils auf Nachbarzeile (Ambro).
- **Mandanten-Gegenprobe:** `erkenneMandantImText` (Beleg-Adresse: Oliv Gastro AG/Restaurant & Bar Oliv vs Restaurant Beaulieu) — fremder Mandant ⇒ Zeile GESPERRT (istBuchbar false), nie stilles Umbuchen; beide/keine Adresse ⇒ null (kein Raten). **AUSNAHME Bohnenblust:** Adresse ist IMMER «Restaurant Beaulieu AG» — dort entscheidet die Kunden-Nr (1422004=Oliv, 9865.2=Beaulieu); unbekannte Nr ⇒ null + Warn-Hinweis «Mandant nicht eindeutig» in der Vorschau (buchbar, aber geflaggt).
- Fixtures neu via PRODUKTIVER Zeilenrekonstruktion erzeugen (esbuild-Bundle von gn-pdf-lines + reconstructGnPdfLines über die /tmp-Item-JSONs), Ablage `fixtures/oliv-pdf/`; Tests `oliv-pdf-parse.test.ts` mit exakten Kontrollwerten.
- Spahni-Kopf: Belegdatum = Datum direkt nach «Zollikofen ,» — Zeilenrest variiert («Seite 1», «/ 500», «/ SAST») und wird ignoriert; Zollikofen-Datum hat Vorrang vor dem generischen Kopf-Datum. Spahni-RECHNUNGEN («RECHNUNG : n» in der Kopfzone) sind IMMER finale Monatsrechnungen, auch mit 1 Lieferung; Einzel-LS (Nr aus «Liefersch./Kd.-Nr.») bleiben provisorisch — Kopfzonen-Check, nie Volltext.

## Sammelvorschau (Batch, Aug 2026)
- Ab 2 Belegen kompakte Tabelle über den Detail-Karten: Lieferant|Rechnungs-Nr|Rechnungsdatum|Lieferungen|Netto|Brutto|Status (GESPERRT > FEHLER Σ-Lieferungen≠Netto ±0.05 > ERSETZT > NEU); Fusszeile Σ nur über NEU+ERSETZT.
- Dubletten-Check (NEU/ERSETZT) ist REINE Anzeige und strikt best-effort: eigener try/catch, Lesefehler ⇒ dublette=false, Zeile bleibt — darf den Importpfad nie beeinflussen. Referenzen: LS-Nrn UND Rechnungs-Nr prüfen (Import kann je nach Deckung Stufe 1 oder 2 buchen); Monats-Bestand pro Batch gecacht.
- Drag&Drop auf den Import-Container; Undo bleibt der bestehende eine pdf_profil-Slot (ganzer Batch).

## Profil-Lernen ohne MWST-Nr
- `lerneProfil` leitet ohne MWST-Nr automatisch Namens-Tokens ab (lowercase, Wörter ≥3 Zeichen) → `findeProfilImText` erkennt den Lieferanten beim Re-Import; bestehende Tokens/IBAN nie überschreiben. Lernen ist KUMULATIV — Import-Undo rollt Profile bewusst nicht zurück.
- Terravigna-AB Stufe 2 (08/2026): keine «Lieferungsnr.»-Blöcke ⇒ parseTerravignaAB baut EINE Lieferung (Nr=AB-Nr, Datum=Lieferdatum||Belegdatum — Feld kann LEER sein); Positionszeile mit optionaler Rab.%- UND MwSt-Spalte (nur `8.1|2.6`, sonst kapert Preisspalte den Satz), MwSt je Position; Fallback ist HART auf erkenneBelegart==='auftragsbestaetigung' begrenzt — Rechnungen ohne erkannte Blöcke mit referenzierter AB-Nr dürfen NIE als AB-Lieferung geparst werden (falsche Upsert-Identität).
- AB→Rechnung (Terravigna): Dokumente tragen KEINE gemeinsame Referenz (Rechnung nennt die AB-Nr. nicht). fs-import ersetzt eine provisorische AB nur bei GENAU EINEM Kandidaten im Fenster (Toleranz max(0.10, 1 % Brutto)); Matcher generell in zwei Pässen: exakte Referenz VOR Datum+Betrag.

## Caporaso & Monatsrechnung-Flag (08/2026)
- Caporaso: «LIEFERSCHEIN-RECHNUNG» = Einzelbeleg, bucht sofort final. Erkennung per Token `caporaso` (keine MWST-Nr im Profil). Lieferdatum aus «Lieferschein: L<Nr> vom TT.MM.JJJJ» = Rechnungsdatum.
- Konto-Split NICHT aus Positionen, sondern aus MwSt-Basen der Rechnungssumme: 2.6 %-Basis → Warengruppe «Küche»/4060, 8.1 %-Basis → «Betriebsmaterial»/4701 (`CAPORASO_KONTEN`). `caporasoMwstBasen` ist selbstvalidierend (basis×satz≈betrag ±0.06) UND auf MwSt-Kontextzeilen beschränkt (Rabatt/Skonto/Zuschlag ausgeschlossen) — sonst kapern Positionszeilen mit zufällig passenden Prozenten die Basis.
- Flag «Monatsrechnung ja/nein» pro Profil (`monatsrechnung`, effektiv via `hatMonatsrechnung`: explizit > Belegtyp-Ableitung). NEIN ⇒ fs-import-Opt `finalDirekt`: Entry final:true, Re-Import derselben Referenz = idempotenter Upsert.
- **finalDirekt-Herkunftswache ist Pflicht:** Upsert nur bei eigener Herkunft (gleicher idPrefix + quelle≠monatsrechnung), sonst kapert ein Referenzkonflikt fremde finale (manuelle/MR-)Buchungen. Gilt an BEIDEN Matchstellen (exakt + ±1-Monat-Referenzsuche).
- Fixtures caporaso-2144841/2144990 stammen aus den ECHTEN PDFs (produktive Zeilenrekonstruktion; zusätzlich rohe pdfjs-Items als `.items.json` für Pipeline-Tests). MwSt-Total = Summe der GEDRUCKTEN Beträge der Rechnung, nie aus den Basen neu berechnet (Rundung je Satz).
- Schnellerfassung («PDF-Rechnung erkennen») leitet erkannte Caporaso-PDFs in die Profil-Import-Vorschau um statt sie als Einzelzeile zu erfassen — bei einer Umleitung muss der PDF-Stapel selbst fortgeschaltet werden (der normale Fortschaltpunkt ist der Save der Schnellerfassung, der dann nie läuft).
- Sammelrechnung matcht pro GELISTETER Lieferung (LS-Nr exakt, sonst LS-Datum+Betrag im Fenster, Default 0) — nie «ganzer Monat»; Teil-MRs (z.B. Spahni 15. + Monatsende) finalisieren nur ihre eigenen LS. Regressionstest in fs-import.test.ts.

## Universeller Upload (Warenrechnungen)
Ein Dropzone klassifiziert Dateien (CSV→CSV-Import, FS-Kennung/ZIP→Feldschlösschen, sonst Profil-PDF-Import inkl. Unbekannt-Zuordnung) und speist sie über `externalFilesRef`-Kanäle der weiterhin gemounteten (CSS-versteckten) Import-Komponenten ein. **Regeln:** CSV-Kanal arbeitet als verlustfreie Warteschlange (nächste Datei erst wenn Vorschau frei); Direkt-Upload je Lieferant in der Übersicht ist fail-closed (fremde/unerkannte Dateien werden abgewiesen, nie umgeleitet); Upload-Steuerelemente nur mit canCreate.

## Ambro Einzel-Lieferscheine (08/2026)
- Ambro ist DUAL: Einzel-LS (eigener Beleg) provisorisch, Monatsrechnung ersetzt via LS-Nr; Konto 4060.
- LS-Kopftabelle «Belegnummer Datum Lieferdatum Seite» — Empfängerzeile davor («Oliv Gastro AG 26116806 …»), darum KOPF_PARSER mit Prefix-Toleranz; 3. Spalte ist nur beim LS das Lieferdatum (bei Rechnung = Fälligkeit — Gate über «Lieferschein»-Überschrift in Kopfzone).
- Massgebliches Buchungsdatum = LIEFERDATUM (2. Datum), NIE das «Basierend auf Auftrag … vom»-Datum.
- Positions-Zeilenparser (8/9 Zellen, Bezeichnung ggf. auf Vorzeile) ist für Monatsrechnung und LS identisch.

## Gourmador (frigemo) — Dual + Stufe-2-Parser (08/2026)
- Faktura mit «Beleg-Nr. <LS-Nr> vom <Datum>»-Blöcken je Lieferung; Parser `gourmador` in LIEFERUNG_PARSER.
- Eine Gourmador-FAKTURA ist IMMER die massgebliche Monatsrechnung — dokumenttyp-Override in parseProfilPdf (wie Spahni), auch bei nur EINER Lieferung; explizite «Lieferschein»-Dokumente bleiben provisorisch.
- Generischer Fallback für Dual-Lieferanten OHNE Positions-Parser: `kopfAlsLieferung()` (monatsrechnung-abgleich.ts) bucht den Kopf als EINE Gesamt-Lieferung «Monatsrechnung gesamt» — greift nur bei explizitem Sammel-/Monatsrechnung-Kopf; UI (`mrLieferungen`-Helper in BeaulieuPdfImport) nutzt Stufe 2, sonst Kopf.
- Positionszeilen-Regex: Art-Nr ab 3 Ziffern (echte frigemo-Nrn «834», «131»), Preis/Betrag dürfen negativ sein (IFCO-Gebinde-Retourzeilen «-1 ST -3.20 …») — sonst verliert der Parser ganze Belege (Block ohne matchende Positionen wird gefiltert) bzw. die Zeilensumme reconcilet nicht auf «Gesamtbetrag exkl. MwSt.» (= Warenwert + Gebindewert). QR-Schutz bleibt: Zeile muss auf MwSt-%-Token enden, Beträge mit Rappen.
- IFCO-Positionen laufen automatisch via istZwingendPfand (Bezeichnungs-Token «ifco») auf 4800 — nie eigene Konto-Logik im Parser bauen.


## Bohnenblust (seit 08/2026 PDF-Import, vorher nur manuell)
- Profil trägt `nurMandant: 'beaulieu'` — loadLieferantenProfile filtert es bei Oliv (dort weiterhin manuelle Erfassung). Ausschluss-Konstante BOHNENBLUST_AUSGESCHLOSSEN wurde entfernt.
- Beleg-Adresse ist IMMER Beaulieu (auch für Oliv-Lieferungen) — Mandant via Kunden-Nr: 9865.2 = Beaulieu, andere (Oliv 1422004) ⇒ null in erkenneMandantImText.
- Blöcke «Lieferschein Nr.» UND «Nachlieferung Nr.» = eigenständige Belege; Kopf-«Total» ist Beleg-Summe, keine Position; Positionszeilen via Artikel-Nr-Muster XX.NN.NN mit optionalem 4. Segment (BW.90.00.3, Rechnung 48162!) und \s+-Trennern (produktive Rekonstruktion liefert EINZEL-Leerzeichen!).
- Dokumenttyp-Override muss auch dt==='lieferschein' übersteuern («Rechnungsnummer» matcht \bRechnung\b nicht → generische Erkennung kippt auf lieferschein).
