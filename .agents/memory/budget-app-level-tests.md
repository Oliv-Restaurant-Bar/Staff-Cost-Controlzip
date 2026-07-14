---
name: Budget-App-Level-Test-Harness
description: Fallstricke beim Testen der Budget-Seite über echte App-Einstiege (Fixtures, Lade-Migration, Regel-No-op)
---

# Budget-Seite über echte App-Einstiege testen

**Regel:** App-Level-Tests der Budget-Seite (Seite + TenantProvider + MemoryRouter) brauchen Fixtures mit den DEFAULT-PL-IDs (`pl_revenue`/`pli_ertrag_a`, `isDefault: true`, Kategorie `type: 'items'`).

**Why:** Die Lade-Migration ersetzt Custom-Kategorien durch die fixe PL-Struktur — Fixture-Zeilen mit eigenen IDs werden orphaned und sind im UI unsichtbar; der Test findet dann nichts, obwohl der Store die Daten hat. Ausserdem stabilisieren sich Lade-Migrationen erst nach mehreren `loadBudgetWithPL`-Aufrufen — Fixture vor dem Byte-Vergleich 2–3× laden.

**How to apply:**
- Zell-Edit im Test: Positionszeile über Label finden, `td[3+monat]` klicken (td0=Label, td1=Kumuliert, td2=%), `spinbutton` ändern, Enter — Commit speichert sofort (kein Save-Button).
- Regel-No-op-Test: `applyRulesToBudget` setzt `wasAutoCalculated = rules.length > 0` — Fixture muss das Flag bereits tragen, sonst ist der Flag-Wechsel eine echte fachliche Änderung und der Info-Toast bleibt aus.
- Stale-Race deterministisch: Supabase-Mock mit `holdKeys`-Set + `releases`-Array in `maybeSingle` (gehaltene Promise), Tenant-Wechsel über Test-Button mit `useTenant().setTenant(...)`, dann Releases feuern.
- Async-Effekte, die nach Tenant-/Jahr-Wechsel State setzen, brauchen einen Cancelled-Guard im Effekt-Cleanup (siehe replit.md §8) — der Budget-Sync-Effekt hatte diesen Bug (verspätete Oliv-Antwort → reload im Beaulieu-Kontext).
