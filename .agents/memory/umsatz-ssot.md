---
name: Netto-Umsatz SSOT (umsatz.ts)
description: Kanonische Netto-Umsatz-Quelle und Tag-Regel der Personalkosten
---
`src/lib/umsatz.ts` ist die EINZIGE Netto-Umsatz-Quelle (Konsumenten: personalkosten.ts, monatsreport.ts). Keine zweite Umsatzberechnung anlegen.

Regeln:
- Netto = TA_brutto/1.026 + (Gesamt−TA)/1.081 + Marketing (gn_discounts, Name exakt «Marketing»/«marketing», Nennwert netto; Maison/Mitarbeiter-Rabatt NICHT).
- Quelle: gn_imports Tagesimporte (aggregation_level='day'), Replace-Semantik per imported_at; Tage ohne Import fehlen (leer, nie 0).
- Food/Bev-Split: Direktanteile /1.081, Rest hälftig; Invariante food+beverage === netto via `beverage = netto − food` nach Rundung.
- **Why:** dailyBudgets war brutto und eine zweite, abweichende Rechnung; Meeting-Zahlen müssen überall identisch sein.
- Tag-Regel Personalkosten: Tag = IST nur wenn VOR heute UND Ist-Stunden; heute+Zukunft = PLAN (flexKostenProTag stichtag-Param).
- Achtung: umsatzIstProTag in PersonalkostenDaten ist seither NETTO — neue Konsumenten nicht mit brutto vergleichen.
- gn_* Tabellen sind RLS authenticated-only: Notebook-Checks brauchen den Service-Role-Key, anon liefert leere Resultate.
