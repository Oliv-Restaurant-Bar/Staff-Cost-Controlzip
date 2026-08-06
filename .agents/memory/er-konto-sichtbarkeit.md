---
name: ER-Konto-Sichtbarkeit (Budget-P&L)
description: Wie ausgeblendete/leere ER-Konten funktionieren und wo Sichtbarkeit persistiert wird
---

Regel: Default-Line-Items mit Ist=Budget=VJ=0 werden in der Budget-ER automatisch ausgeblendet; dauerhafte Sichtbarkeit = `isForceVisible` am `BudgetPLLineItem` (persistiert im tenant-präfixierten `budget_v1` → pro Mandant, überlebt Reload).

**Why:** Sichtbarkeit darf nie zweitgleisig (z.B. eigener KV-Key) gespeichert werden — das Budget-Item ist die SSOT und wandert mit Backup/Sync mit.

**How to apply:**
- `computeBPLRows(..., { showHidden })` liefert leere Konten als `isAutoHidden`-Nullzeilen (reine Darstellung «—», beeinflussen keine Summen). Quartal/Jahr: `aggregateBPLRows` rechnet das Flag aus den Periodensummen neu.
- Monat-vs-Monat-Vergleich MUSS die Vergleichsmonat-Zeilen mit `showHidden:true` rechnen, sonst fehlt die 0 des Vergleichsmonats in der Injektions-Map und der native VJ-Wert bleibt fälschlich stehen.
- Neue immer sichtbare Standardkonten: als Default-Item mit `isForceVisible:true` anlegen (`ensureDefaultPLItems` ergänzt per id bestehende Budgets, kein Duplikat).
