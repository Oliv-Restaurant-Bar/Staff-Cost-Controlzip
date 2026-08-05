---
name: AG-Sozialkosten-Flag pro Flex-MA (global)
description: Per-Mitarbeiter «ohne AG-Sozialkosten» wird zentral in employee-rate.ts aufgelöst; Reichweite, Grenzen und Reaktivitäts-Fallen.
---

# AG-Sozialkosten-Flag (pro Flex-Mitarbeiter, global wirksam)

**Regel:** Das per-MA-Flag «ohne AG-Sozialkosten» wird an EINER Stelle aufgelöst: `getEmployerCostRate` in `src/lib/employee-rate.ts` (via `src/lib/ag-soz-flags.ts`). Bei Flag AUS: `totalHourly = grossHourly`, `socialHourly = 0`, `agOff: true`. Kein zweiter Rechenpfad in Aufrufern — Call-Sites nutzen weiter `totalHourly`/`getEffectiveHourlyRate`.

**Why:** Frühere Variante (Dual-Rate-Logik nur in PersonalFix) erzeugte inkonsistente Summen zwischen Tabelle, Popup, Export und Headline; Spec verlangt globale Wirkung (PKQ, Hochrechnung, Total FIX+VARIABEL, Exporte) mit gemischten Sätzen pro MA.

**How to apply:**
- Persistenz: `localStorage pfix_ag_soz_off_<tenantId>` (JSON-Array Basis-IDs), aktiver Mandant aus `active_tenant`-Key (gleich wie TenantContext). Split-Pseudo-IDs (`::flexsplit`) werden auf die Basis-ID normalisiert. Node/Tests ohne DOM → Flag immer aus.
- Das Flag gilt nur für FLEX-MA (Stundenlohn-Pfade). Fixlohn-Kosten laufen über `gross × agFactor` (personalkosten.ts fixKosten, operational-day, SchedulePlanner) und UMGEHEN das Flag bewusst — dort keinen Toggle anbieten.
- Reaktivität: employee-rate liest verstecktes localStorage-State → React-Memos merken den Toggle NICHT automatisch. In PersonalFix hängt `agSozOff`-State an allen rate-abhängigen Memos/Effekten (inkl. varPlan/varIstTotalCHF und pkDaten-Load). Andere Seiten (useEmployerRateMap etc.) sind nur via Remount frisch — Toggle-UI existiert nur in PersonalFix; wer den Toggle woanders anbietet, braucht ein reaktives Revision-Signal.
- Tests: `src/lib/__tests__/ag-soz-flags.test.ts` (happy-dom, echte SocialCostRates-Feldnamen `ahvPct` etc.).
