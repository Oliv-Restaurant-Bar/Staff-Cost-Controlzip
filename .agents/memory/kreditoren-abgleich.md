---
name: Kreditoren-Abgleich (Lieferanten-Cockpit)
description: Infoniqa Kreditoren-Personenkonto-Auszug als Kontrollebene über Warenrechnungen — Parser-, Matching- und Sicherheitsregeln.
---

# Kreditoren-Abgleich / Lieferanten-Cockpit

**Regeln:**
- Parser (`kreditoren-parser.ts`): Spaltenzuordnung der Beträge über X-Koordinaten der Kopfzeile «Soll/Haben/Saldo» (Mittelwert-Grenzen); nur HABEN = Rechnungen; SOLL mit G-Konto 1021 oder «Zahlungslauf» = Zahlung; übrige SOLL (Rückvergütungen) = `soll_sonstig`, nie Vorschlag. Referenz aus Folgezeile in der Text-Spalte ODER Nummer im Text. Fixture-Test gegen echten Oliv-Auszug (16 Waren-Lieferanten Kontrolle).
- Zuordnung (Waren ja/nein + Konto + Modell) pro Mandant in KV `waren_kreditoren_zuordnung_v1`, Schlüssel = normalisierter Kreditor-Name. Auto-Vorschlag (40xx-Haben) ist NUR Vorschlag: Falsch-Positive existieren (GastroSocial bucht auf 4060), reine-div-Kreditoren können echte Waren sein (Rutishauser-DiVino=Wein).
- Matching PRIMÄR über BELEGNUMMER (normRef: erstes Token, trailing Satzzeichen/führende Nullen weg) — das Kreditor-Buchungsdatum weicht SYSTEMATISCH vom Lieferdatum ab und ist nur Fallback ohne Ref (Betrag+Datumsnähe, nie gegen ref-tragende oder ref-reservierte Rechnungen). Mehrfach-Refs als Batch mit minimaler Betragsabweichung; Buchung mit bekannter Ref ohne freien Treffer = Dublette (nie Fallback/Vorschlag). Konzern-Gruppe: Prodega zählt zum Kreditor «Transgourmet Schweiz AG».
- FINALISIERUNG: spätere Detail-Importe (CSV + fs-import/PDF) ersetzen provisorische kreditoren_uebernahme-Platzhalter via findeKreditorenUebernahme (gleiche Ref-Logik, Monate ±1) — echtes Lieferdatum+Positionen gewinnen, ID bleibt, Betragsabweichung > FIBU-Toleranz gibt Hinweis (nie still). Fallback ohne Ref nur eindeutig per Betrag; mehrdeutig = manuell. Cross-Monat: Platzhalter-Monat braucht FIBU-Match- UND Sidecar-Bereinigung (Positionen/Preishinweise), sonst Leichen. Finalisierung separat zählen (nicht «ersetzt»).
- IGNORIEREN: Buchungen «kein Wareneinkauf» (Boni/Korrekturen) via KV waren_kreditoren_ignoriert_v1 (tenant-präfixiert); Key = Kreditor+normRef bzw. Kreditor+Datum+Betrag (importstabil). Im Abgleich VOR allen Match-/Dubletten-Pfaden in aktiv-Liste aussortieren (Status 'ignoriert'), sonst verbrauchen sie Rechnungen oder landen in Übernahme/Differenz.
- Dual-Lieferanten matchen NUR gegen `final === true` (nie `quelle==='monatsrechnung'` allein — alte provisorische MR-Einträge dürfen nichts als «erfasst» markieren); nur Lieferscheine im Monat → Status «provisorisch», kein Vorschlag.
- Übernahme = provisorische Rechnung `quelle:'kreditoren_uebernahme'`, `final:false`; fs-import-Ersatzpfad muss diese Quelle in der Eligibility-Union führen, sonst Dubletten statt Finalisierung.
- Der Auszug ändert NIE bestehende Rechnungen; Undo über bestehendes WarenImportUndo (`typ:'kreditoren'`).

**Sicherheits-Lehren (Architect-Review):**
- Mandanten-Wache fail-closed: PDF ohne positiv erkannte Firma ablehnen (nicht nur bei erkannt-fremd).
- Jede neue Warenrechnungen-Fläche braucht das `canCreate`-Gate in JEDEM Schreib-Handler (nicht nur Buttons ausblenden).
- UI-Auswahl-Keys nie aus Lieferant+Datum+Betrag bauen — gleiche echte Buchungen kollidieren; Index-basierte Keys verwenden.
