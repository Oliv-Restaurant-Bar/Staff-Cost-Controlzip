---
name: FIBU-Abgrenzungen (TP/RB) & Jahresansicht-Übernahme
description: TP/RB-Buchungen sind Abgrenzungen (keine Rechnungen); Jahres-Übernahme muss monats-gekeyt routen.
---

**Regeln:**
- Buchungstexte «TP RE …» / «RB TP RE …» = transitorische Monats-Abgrenzungen: in `buildWarenAbgleich` wie interne Umbuchungen VOR der Lieferanten-Zuordnung ausklammern (`abgrenzungen`/`abgrenzungenSumme`), nie als Übernahme-Kandidat, nie in «Alle übernehmen»; im degradierten Modus zusätzlich aus dem `buchhaltungTotal` herausrechnen. TP↔RB-Paare (gleicher Text-Rest, Summe ≈ 0) werden nur für die Anzeige gepaart/ausgeblendet (`paareAbgrenzungen`).
- Jahresansicht-Übernahme: der FIBU-Match-Schlüsselraum (`buchungKeysMitIndex`) ist MONATS-gekeyt. Jahres-Kandidaten deshalb PRO MONAT bauen (Monats-Journal + Monats-Rechnungen + Monats-Match-State) und aggregieren; beim Speichern jede Verknüpfung in den Match-State des Buchungs-Monats routen (load→mutate→save, `#0`-Normalisierung der Alt-Keys, Serialisierung über dieselbe Save-Chain wie Monats-Saves). Nie den Monats-`persistFibuState` für Jahres-Saves verwenden.

**Why:** Kandidaten aus einem Jahres-Journal hätten andere Duplikat-Indizes als die Monatsansicht → Matches beider Ansichten sähen sich nicht; TP/RB erzeugten Phantom-Differenzen und Phantom-Rechnungen bei «Alle übernehmen».

**How to apply:** Bei jeder Erweiterung des Übernahme-/Match-Flows (neue Ansichten, neue Kandidatenquellen) den Schlüsselraum monatstreu halten und Abgrenzungs-/Umbuchungs-Filter symmetrisch (lieferanten- UND degradierter Modus) prüfen. Alias «Schenk Suisse» → Gruppe «Obrist SA» (grp-obrist-schenk, beaulieu) existiert als Daten.
