---
name: Personalkosten-SSOT (personalkosten.ts)
description: Alle Personalkosten-Ansichten müssen die zentrale Lib nutzen; Budget/PKQ-Regeln und Umstellungs-Fallstricke
---

# Personalkosten-SSOT

**Budget live (Juli 2026, finaler Stand):** PK_BUDGET_*-Konstanten (106'400/35.5 %/300'000) ENTFERNT. PK-Budget(Monat) = Ziel-Personalquote (Einstellung ziel_personalquote_v1, Default 35.5 %, Card in Settings) × Netto-Umsatz-Budget via getMonthlyBudgetRevenue(tenantKey('budget_v1')!) — gleiche Quelle wie Monatsreport. Ziel-Linie PKQ = konstante Einstellung, Obergrenze fix 40 %. getMonthlyBudgetPersonnel (wages+social exkl. other, buildBudgetByRowForMonth) existiert weiter, ist aber NICHT mehr der Headline-Pfad. Fehlt Umsatz-Budget ⇒ «—», nie Konstanten-Fallback. Der console.error «[FLEX] ist cross-check MISMATCH» in PersonalFix ist eine ALTE Diagnose (seit Apr 2026, Scope-Differenz der Parallel-Reconciliation), kein Regressionssignal.

**Etappe 3 (Juli 2026):** AG-Faktor-Default = 15.7 % (11.21 % gemeinsam + 4.5 % BVG) in DEFAULT_SOCIAL_COST_RATES; `migrateLegacyDefaultRates()` hebt NUR Blobs an, die exakt den alten 14.2-%-Defaults entsprechen. Employee.istQuelle ('mirus'|'manuell'|'plan', employees.ist_quelle, Presence-Guard!) steuert die Tag-Regel; Default via getEffectiveIstQuelle (fix→mirus, flex→plan), nie in DB zurückschreiben. Fehlendes Ist an vergangenen Tagen (mirus/manuell) ⇒ istFehltTage-Markierung + Plan-Wert, nie still 0. Die zwei «Flex Ist»-Werte in PersonalFix sind SCOPES (nur Flex-Arbeit vs. inkl. Zusatzk./Ferien), kein Rechenfehler — Vollumstellung von PersonalFix/ActualHoursGrid auf die Lib steht als Task aus.

**Regel:** `src/lib/personalkosten.ts` ist die EINZIGE Quelle für Personalkosten-Totale, Budget und PKQ in allen Ansichten (PersonalkostenNeu, PersonalFix-Kopf, MonthlyCostSummary, IstDayDetailDialog, Drilldowns).
- Budget = `PK_BUDGET_TOTAL` (106'400 = 35.5 % × 300'000), Zielquote `PK_BUDGET_QUOTE` (35.5 %), harte Obergrenze 40 %. NIE Budget aus budget_v1/useBudgetMonth für Personalkosten-Kopfzahlen (führte zu Schein-Budget 138'802).
- PKQ nur via `personalquote()` (Netto-Umsatz-Nenner aus umsatz.ts). Alte Formeln «volle Kosten ÷ Teil-/effectiveRevenue» ergaben falsche 63–65 %.
- Ferienabbau, Kranken/Unfall, Überstunden, Zusatzkosten sind AUSSERHALB der Kopf-Totale — nur als einklappbare Side-Info.

**Why:** Widersprüchliche Totale auf verschiedenen Seiten (PersonalFix vs. /personalkosten-neu) verwirrten den User; Etappe 2b (Juli 2026 verifiziert: HR 120'918, Budget 106'400, PKQ 45.0 %) hat alles auf die Lib gezogen.

**How to apply / Fallstricke:**
- Konsumenten laden async via `ladePersonalkostenDaten(...)`; beim Monats-/Tenantwechsel State SOFORT auf null setzen, sonst kurz falsche (alte) zentrale Werte sichtbar.
- Abteilungs-Splits dürfen lokale Detail-Logik behalten, müssen aber proportional aufs zentrale Total skaliert werden (Service+Küche=Gesamt); Randfall lokale Basis=0 explizit behandeln.
- Kumulierter PKQ-Verlauf: Fix `totalMonat × d/daysInMonth` (nicht 31× fixKosten), Tage ohne kumulierten Umsatz → null-Lücke.
- E2E hinter Login: Test-User-Rolle via Supabase-Management-API SQL setzen (PostgREST-PATCH mit service_role auf user_profiles gibt 42501 permission denied); nach Test auf kueche_manager zurückstufen.
