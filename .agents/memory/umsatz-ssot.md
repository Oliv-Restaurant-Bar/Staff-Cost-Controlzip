---
name: Netto-Umsatz SSOT (umsatz.ts)
description: Kanonische Netto-Umsatz-Quelle, Tag-Regel, umgestellte Views und Session-Race-Lessons
---
`src/lib/umsatz.ts` ist die EINZIGE Netto-Umsatz-Quelle. Konsumenten (alle umgestellt, Juli-2026-verifiziert): personalkosten.ts, monatsreport.ts, Dashboard, TagesansichtPage, TagesControllingPage, PLView (Erfolgsrechnung), Reporting, UmsatzAbstimmung. Keine zweite Umsatzberechnung anlegen.

Regeln:
- Netto = TA_brutto/1.026 + (Gesamt−TA)/1.081 + Marketing (gn_discounts, Name exakt «Marketing»/«marketing», Nennwert netto; Maison/Mitarbeiter-Rabatt NICHT).
- Quelle: gn_imports Tagesimporte (aggregation_level='day'), Replace-Semantik per imported_at; Tage ohne Import fehlen (leer, nie 0).
- Food/Bev-Split: Direktanteile /1.081, Rest ANTEILIG nach Food/Bev-Verhältnis (basis=0 → hälftig, nie 50/50 pauschal); Invariante food+beverage === netto via `beverage = netto − food` nach Rundung.
- «Nach Speisekarte»-Excel-Import (Import-Center, GastronoviImportSection) schreibt NUR dailyBudgets-KV, nie gn_imports → Tage ohne Z-Bericht bleiben in allen Umsatz-Views leer; post-Import-Warnung listet solche Tage (Coverage-Check exakt wie ladeUmsatzTage: gross_revenue > 0). Speisekarte-Export enthält nur Food+Bev (kein TA/Marketing/ungruppiert) und kann einen Tag nie korrekt ersetzen.
- Achtung Datenscope: gn_imports food_revenue+bev_revenue (brutto) können > gross_revenue sein → rest pro Tag negativ; DB-basierter Food-Anteil (~70.9 %) weicht vom Kassen-Export-Anteil (~67.1 %) ab. Formel ist korrekt; Differenz kommt aus dem Spalten-Scope.
- **Why:** dailyBudgets war brutto und eine zweite, abweichende Rechnung; Meeting-Zahlen müssen überall identisch sein.
- Tag-Regel Personalkosten: Tag = IST nur wenn VOR heute UND Ist-Stunden; heute+Zukunft = PLAN (flexKostenProTag stichtag-Param).
- Achtung: umsatzIstProTag in PersonalkostenDaten ist seither NETTO — neue Konsumenten nicht mit brutto vergleichen.
- gn_* Tabellen sind RLS authenticated-only: Notebook-Checks brauchen den Service-Role-Key ODER Login als Testuser; anon liefert leere Resultate.

Entschieden/gefixt bei der App-weiten Umstellung:
- Maison-Additiv fliesst NIRGENDS mehr in den IST-Umsatz ein (Dashboard, PLView, Reporting, Tagesansicht); Maison bleibt nur als eigene Anzeige-/Export-Spalte. **Why:** Zielzahlen des Users = rein kanonisch, ohne Maison.
- ER/Reporting teilen sich `applyCanonicalIstRule` in src/lib/effective-records.ts (revenueActual = kanonisch, Take-Away Kto. 3000/3010-Split, 3xxx-Vorrang, Personalkosten 5000–5009-Vorrang). Nie wieder parallel in beiden Seiten pflegen.
- VerkaufsDashboard bewusst NICHT umgestellt: WES-% braucht Zähler+Nenner beide aus product_sales, sonst Quellen-Mismatch.
- Banner «Noch keine Daten» darf nie erscheinen, wenn kanonischer IST für den Monat existiert (Bedingung inkl. canonicalRevenue[month]?.hasData).

**Session-Race-Lesson (wichtig):** Läuft ein Supabase-Read-Effekt nur einmal beim Mount, kann er VOR der Session-Hydration feuern → RLS liefert still 0 Zeilen (HTTP 200, kein Fehler) → Seite bleibt dauerhaft leer. Jeder solche Lader braucht: (a) Nachladen bei 'store-synced', (b) Generationszähler statt cancelled-Flag (überlappende Loads), (c) leeres Ergebnis überschreibt nie bereits geladene Daten. ladeUmsatzTage loggt Fehler jetzt als `[UMSATZ]`-console.warn (nie stumm schlucken).

Datenlage Juli 2026: 04./17.07. lagen falsch datiert als «replaced»-Rows (repariert); 22.07. fehlt in allen Quellen (Z-Bericht nie importiert) — Sollwerte 22.07.: Brutto 8'314.00, TA 1'547.40, Marketing 600.00.
