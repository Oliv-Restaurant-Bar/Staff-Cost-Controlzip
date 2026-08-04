---
name: Plan-Std SSoT (Personalkosten ↔ Dienstplan)
description: Personalkosten «Plan Std» muss den schedule-v2-Cache voll durch Supabase ersetzen; Guards nur bei echtem Fehler.
---

**Regel:** «Plan Std» in Personalkosten kommt aus Supabase `schedule_entries` (SSoT). Der localStorage-Cache `schedule-v2-YYYY-MM` ist ein REINER Cache und wird beim Spiegeln VOLLSTÄNDIG ersetzt (kein Merge, keine Reste, auch leerer Monat ersetzt). Aggregation via `aggregatePlanHours` (Monatsfilter + FE-Skip + calculateDayNetHours) — identisch zum Dienstplan.

**Why:** Tick-/Leer-Guards im Supabase→localStorage-Spiegel liessen veraltete Cache-Einträge dauerhaft stehen → Personalkosten zeigte MEHR Plan-Stunden als der Dienstplan (Aug 2026 Oliv, bis +32.5 h). Zusätzlich fehlte im Aggregator der Monats-Datumsfilter, sodass Fremdmonats-Reste im Blob mitzählten.

**How to apply:**
- Einziger legitimer Guard: echter Supabase-Fehler (`loadScheduleForMonth` → null). Ein erfolgreiches leeres Resultat gewinnt (Supabase siegt bei Divergenz).
- Der Spiegel-Effekt läuft auch bei `scheduleRefreshTick`-Refreshes (nach Import/Dienstplan-Update) — nie per Tick-Guard überspringen.
- Async-Loads in solchen Effekten brauchen einen Stale-Guard (Cleanup setzt `stale=true`), sonst überschreibt ein out-of-order Response den frischeren Spiegel.
- FE-Plan-Absenzen und isAdditionalCostPlan kommen aus Supabase-Spalten — Vollersatz verliert nichts.
- «Ist Std» (actual-hours) ist bewusst KEIN Vollersatz: localStorage-only absenceType (FE/K/U) muss den Merge überleben.
