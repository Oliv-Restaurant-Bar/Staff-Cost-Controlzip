---
name: ER Jahresansicht — Umsatz vergangener Hauptjahre
description: Jahres-/Mandanten-getaggter canonicalRevenue-State + vj_daily-Fallback für den Umsatz, wenn ein vergangenes Jahr als Hauptjahr gewählt ist.
---

## Regel
- `canonicalRevenue` und `mainYearVjDaily` in PLView sind `{year, tenant, …}`-getaggt; Konsumenten prüfen BEIDE, sonst fliessen beim Jahr-/Mandantenwechsel Fremdwerte in die Ansicht (Bug 08/2026: «Jahr 2025» zeigte 2026-Ist; Tenant-Leak Oliv↔Beaulieu).
- Die «leeres Ergebnis überschreibt nie geladenes»-Schutzlogik darf nur innerhalb desselben `{year, tenant}` greifen — sonst bleibt Fremdmandant-Umsatz dauerhaft stehen.
- Umsatz vergangener Hauptjahre: Monate ohne manuellen Tagesimport (dailyBudgets) werden aus `vj_daily:<jahr>` gefüllt — derselbe Speicher wie die Vorjahr-Spalte der Folgejahr-Ansicht; Netto-Umrechnung via `vjTagWerte` (umsatz-SSOT, TA-Split), NICHT plain grossToNet.

**Why:** vj_daily ist die einzige jahresspezifische Tagesquelle für abgeschlossene Jahre; Monats-indizierte Maps ohne Jahr/Tenant-Tag sind bei async Loads grundsätzlich stale-anfällig.

**How to apply:** Bei jedem neuen month-indizierten Async-State in PLView (o.ä. Jahres-Views) Jahr UND Mandant mittaggen und im Konsum prüfen; für laufende Jahre ist vj_daily leer → Fallback ist no-op.
