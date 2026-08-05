---
name: Kreditoren-Abgleich (Lieferanten-Cockpit)
description: Infoniqa Kreditoren-Personenkonto-Auszug als Kontrollebene über Warenrechnungen — Parser-, Matching- und Sicherheitsregeln.
---

# Kreditoren-Abgleich / Lieferanten-Cockpit

**Regeln:**
- Parser (`kreditoren-parser.ts`): Spaltenzuordnung der Beträge über X-Koordinaten der Kopfzeile «Soll/Haben/Saldo» (Mittelwert-Grenzen); nur HABEN = Rechnungen; SOLL mit G-Konto 1021 oder «Zahlungslauf» = Zahlung; übrige SOLL (Rückvergütungen) = `soll_sonstig`, nie Vorschlag. Referenz aus Folgezeile in der Text-Spalte ODER Nummer im Text. Fixture-Test gegen echten Oliv-Auszug (16 Waren-Lieferanten Kontrolle).
- Zuordnung (Waren ja/nein + Konto + Modell) pro Mandant in KV `waren_kreditoren_zuordnung_v1`, Schlüssel = normalisierter Kreditor-Name. Auto-Vorschlag (40xx-Haben) ist NUR Vorschlag: Falsch-Positive existieren (GastroSocial bucht auf 4060), reine-div-Kreditoren können echte Waren sein (Rutishauser-DiVino=Wein).
- Dual-Lieferanten matchen NUR gegen `final === true` (nie `quelle==='monatsrechnung'` allein — alte provisorische MR-Einträge dürfen nichts als «erfasst» markieren); nur Lieferscheine im Monat → Status «provisorisch», kein Vorschlag.
- Übernahme = provisorische Rechnung `quelle:'kreditoren_uebernahme'`, `final:false`; fs-import-Ersatzpfad muss diese Quelle in der Eligibility-Union führen, sonst Dubletten statt Finalisierung.
- Der Auszug ändert NIE bestehende Rechnungen; Undo über bestehendes WarenImportUndo (`typ:'kreditoren'`).

**Sicherheits-Lehren (Architect-Review):**
- Mandanten-Wache fail-closed: PDF ohne positiv erkannte Firma ablehnen (nicht nur bei erkannt-fremd).
- Jede neue Warenrechnungen-Fläche braucht das `canCreate`-Gate in JEDEM Schreib-Handler (nicht nur Buttons ausblenden).
- UI-Auswahl-Keys nie aus Lieferant+Datum+Betrag bauen — gleiche echte Buchungen kollidieren; Index-basierte Keys verwenden.
