---
name: Umsatzabstimmung Quellen-Mismatch
description: Warum die Umsatzabstimmung importierte Umsatzdaten nicht sieht — sie liest nur 3 Quellen; vj_daily/revenueActual/expenseCategories sind für sie unsichtbar.
---

# Umsatzabstimmung liest nur 3 Quellen

Die Monatsabstimmung Umsatz (`UmsatzAbstimmung.tsx`) entscheidet «keine Abstimmungsdaten» ausschliesslich über:
1. `grossRevenueManual` / `takeAwayGrossManual` aus `tenantKey('reporting_v1')` (Jahr = gewähltes Jahr)
2. `actualRevenue`-Tagessummen aus `tenantKey('dailyBudgets')`
3. `gn_imports` (aktive Z-Berichte, `restaurant_id`-gefiltert)

**Seit 08/2026:** «Summe Tage» fällt für VORJAHRE automatisch auf `vj_daily` (brutto actualRevenue, monatsweise) zurück — aber NUR wenn der kanonische Tages-Store fürs ganze Jahr leer ist (nie Quellen mischen); Spaltenlabel zeigt die Quelle. Laufendes Jahr unverändert.

**Unsichtbar für die UA (bewusst prüfen, bevor man «Daten fehlen» glaubt):**
- `vj_daily:*` war bis 08/2026 komplett unsichtbar (Beleg 2026-07: 366 × `vj_daily:2024-*` Oliv, UA 2024 leer); jetzt nur noch als Vorjahres-Fallback sichtbar (s. oben).
- `revenueActual` / `expenseCategories` in reporting_v1 (Jahres-Kontoblatt-/ER-Importe).

**Why:** Import-Erfolg ≠ UA-Sichtbarkeit. ER (P&L) liest vj_daily für die VJ-Spalte, UA nicht → «ER zeigt 2024, UA nicht» ist Quellen-Mismatch, kein Datenverlust.

# Tenant-Key-Fallen in saveMonth-Aufrufern

`saveMonth` default-storeKey = `reporting_v1` (Oliv unpräfixiert). Aufrufer OHNE storeKey schreiben IMMER in den Oliv-Blob, egal welcher Tenant aktiv ist:
- ImportHub Jahres-Umsatz-Import (schreibt zudem `revenuePreviousYear` ins FOLGEJAHR year+1)
- ImportHub Personalkosten-VJ-Import (ebenfalls year+1)
- Reporting.tsx Jahres-Umsatz-Import (schreibt `revenueActual` ins importYear)

**How to apply:** Jeder neue saveMonth-/replaceAnnualCostYear-Aufruf MUSS `tenantKey(REPORTING_STORAGE_KEY)` explizit übergeben; VJ-Importe schreiben je nach Pfad in Jahr N oder N+1 — nie annehmen, dass «Import 2024» auch Records mit year=2024 erzeugt.

# KV-Backup kann teilweise fehlschlagen

Beleg 2026-07: Beaulieu-Registry `annualCostImports_v1` sagt monthsWithData=12, aber `beaulieu:reporting_v1` in Supabase hatte nur 8 × 2025-Monate (05/07/09/11 fehlten). localStorage des Import-Geräts hat alle 12; andere Geräte laden aus KV → Monate «fehlen». Sequenzielles Monats-Backup kann partiell scheitern; Registry-Zähler ≠ KV-Bestand.

# UA-Editierbarkeit & Mandanten-Layout
- Alle 12 Monatszeilen sind IMMER editierbar (kein «keine Daten»-Platzhalter); Beaulieu blendet die Take-Away-Spalte komplett aus (`isBeaulieu` in UmsatzAbstimmung.tsx), Oliv unverändert.
- Vorjahres-Writes prüfen den prior-year-lock FRISCH via getLockStateStrict (fail-closed, Toast «festgeschrieben — zuerst entsperren»); Leeren eines Felds = clearManualUmsatzField (löscht Feld + Import-Protokoll), da saveMonth-update undefined ignoriert.
- ImportSource kennt KEIN 'manual_entry' — neue Schreibpfade 'manual' verwenden (Alt-Aufruf in UA ist Baseline-tsc-Fehler).
