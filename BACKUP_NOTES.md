# Backup-Notizen — Mirus Excel Import Pipeline

**Stand:** 12. Mai 2026
**Commit:** e6b189d9 (Excel Import Preview stabil)

---

## Aktueller Status

| Komponente | Status |
|---|---|
| Koordinatenbasierter Parser (`mirus-excel-parser.ts`) | ✅ Aktiv |
| Block-Merge-Logik (Name-Deduplication) | ✅ Aktiv |
| Monatstotale-Erkennung (zonenbasiert, 11 Felder) | ✅ Aktiv |
| Totale-Cross-Check (Tageszeilen vs. geparste Totale) | ✅ Aktiv |
| Import-Vorschau-Pipeline (`/mirus-import-preview`) | ✅ Stabil |
| JSON Preview Export (Debug-Download) | ✅ Aktiv |
| Qualitätsbewertung (0–100%, 7 Kriterien) | ✅ Aktiv |
| Supabase-Write / echter Import | ⛔ Bewusst disabled |

---

## Wichtige Dateien

| Datei | Zweck |
|---|---|
| `src/lib/mirus-excel-parser.ts` | Koordinatenbasierter Parser (SheetJS) |
| `src/pages/MirusExcelTest.tsx` | Diagnose-Testseite `/mirus-excel-test` |
| `src/pages/MirusImportPreview.tsx` | Import-Vorschau `/mirus-import-preview` |
| `src/types/mirus-import-preview.ts` | Typen: PreviewImportSession, PreviewEmployee, etc. |

---

## Parser-Architektur (Zusammenfassung)

- **Block-Erkennung:** Spalte C, Text enthält „Name / Vorname"
- **Name:** Spalte M(blockStart)
- **Wochenstunden:** Spalte BO(blockStart)
- **Tageszeilen:** ab blockStart + 5, Datumszellen in Spalte B
- **Merge-Logik:** gleicher Name → Blöcke werden zusammengeführt, Rest-Blöcke (<5 Tage) ebenfalls
- **Totale-Scan:** nur obere 15 + untere 15 Zeilen pro Block (zonenbasiert)
- **Cross-Check:** Summe der Tagesstunden vs. geparste `totalHours` — Differenz < 1h = validiert

---

## Qualitätsbewertung (max. 100 Punkte)

| Kriterium | Punkte |
|---|---|
| Name erkannt | 25 |
| Wochenstunden erkannt | 8 |
| Kostenstelle erkannt | 8 |
| ≥ 20 Tage erkannt | 27 |
| ≥ 15 aktive Tage (Schichten/Absenz) | 14 |
| Monatstotale erkannt | 8 |
| Monatstotale validiert (Cross-Check < 1h) | 10 |

---

## Offene Punkte (Roadmap Mirus-Import)

### Kurzfristig
- [ ] **Restaurant-Erkennung verbessern:** Dateiname-Parsing ist rudimentär; Mapping Dateiname → `oliv`/`beaulieu` sollte konfigurierbar sein
- [ ] **Qualitätswarnungen optimieren:** Schwellenwerte (< 85%, < 20 Tage) für verschiedene Mitarbeiterkategorien anpassen (z.B. Aushilfen)
- [ ] **MonatsTotaleSection visuell verbessern:** bessere Hierarchie, Soll/Ist-Vergleich deutlicher hervorheben

### Mittelfristig
- [ ] **Echter Import aktivieren** (nach Freigabe): `prepareImportPayload()` → Supabase-Insert in `schedules`-Tabelle
- [ ] **Mirus-Namensabgleich:** fuzzy-matching Mirus-Namen → Personalstamm-Namen (Umlaute, Abkürzungen)
- [ ] **Kostenstellen-Mapping:** automatisches Mapping `costCenter`-String → `department`-ID

### Langfristig
- [ ] Freigabe-Workflow (Admin prüft → genehmigt Import)
- [ ] Import-Audit-Log (wer hat wann importiert)
- [ ] Vergleich Import vs. bestehendem Monatsblatt

---

## Datenintegrität-Regeln (unverändert gültig)

- Alle `dailyBudgets`-Schreibpfade müssen `safeUpsertDailyBudgets()` verwenden
- Kein localStorage-Overwrite für Umsatzdaten
- `daily_revenues`-Tabelle noch nicht aktiv (Migration ausstehend, siehe `replit.md`)
