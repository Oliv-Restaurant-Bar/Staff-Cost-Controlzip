---
name: Monats-Phasenresolver FIX/FLEX
description: Lohnart je Monat aus employee_wages-Historie, Split-Monate, Pseudo-Flex-ids
---
Regeln (SSOT `applyEffectiveWagesForMonth` in wage-history.ts, konsumiert von PersonalFix.tsx UND personalkosten.ts):
- Lohnart des Monats = Phase aktiv am Monatsersten; Stammsatz nur Fallback ohne Historie. hourly-Phase verdrängt Stammsatz-Monatslohn.
- **Backfill-Annahme:** existiert KEINE Phase vor Monatsbeginn und die früheste Historie beginnt IM Monat, gilt sie ab Monatsbeginn (bewusste Geschäftsannahme).
- Lohnart-Wechsel mitten im Monat → `MonthWageSplit` mit Datumsbereichen + Tage-Anteilen (monthlyFraction/hourlyFraction); nur der ERSTE Wechsel zählt.
- **Split-Monat, keine Doppelzählung:** FLEX-Pseudo-Zeile trägt eigene id `<empId>::flexsplit`; alle Stunden-Lookups über `splitBaseId()` + ×hourlyFraction; Stundensaldo/allEmployees filtert Pseudo-ids. In personalkosten.ts: fixKosten × monthlyFraction, Tages-Stundenmaps tag-genau auf Pseudo-id verschoben (Monatslohn-Tage entfernt).
- Logging: `[WAGE-MONTH] employee|monat|lohnart|quelle`.
**Why:** Stammsatz-Klassifikation ordnete MA mit Lohnhistorie im falschen Topf ein (FLEX statt FIX) → massiv falsche Flex-Plan-Kosten.
**How to apply:** Jede neue Ansicht, die FIX/FLEX klassifiziert, MUSS über den Monats-Resolver gehen; nie `contractType` aus dem Stammsatz direkt für Monatslogik verwenden; bei id-keyed Stundenmaps immer an `::flexsplit` denken.
