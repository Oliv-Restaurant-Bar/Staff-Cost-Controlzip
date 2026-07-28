---
name: Netto-Umsatz SSOT (umsatz.ts)
description: Kanonische Netto-Umsatz-Quelle (manueller Import, NICHT gn_imports), Tag-Regel, umgestellte Views und Session-Race-Lessons
---
`src/lib/umsatz.ts` ist die EINZIGE Netto-Umsatz-Quelle. Konsumenten (alle umgestellt, Juli-2026-verifiziert): personalkosten.ts, monatsreport.ts, Dashboard, TagesansichtPage, TagesControllingPage, PLView (Erfolgsrechnung), Reporting, UmsatzAbstimmung. Keine zweite Umsatzberechnung anlegen.

**VERBINDLICHE Quellen-Entscheidung des Users (Juli 2026):** Der MANUELLE Tagesumsatz-Import («Nach Speisekarte»-Excel → dailyBudgets-KV) ist die EINZIGE Umsatzquelle für alle Netto-Auswertungen. Z-Berichte (gn_imports/gn_discounts) dienen NUR den Tagesabschlüssen und dürfen in ladeUmsatzTage NIE wieder gelesen oder gemischt werden. **Why:** Mischen von 26 Z-Bericht-Tagen + 1 Speisekarte-Tag ergab inkonsistente Summen; das Excel ist in sich konsistent (Gesamt-Zeile inkl. TA, nach Rabatten).

Regeln:
- Quelle: dailyBudgets-KV (tenant-präfixiert; oliv OHNE Präfix): actualRevenue = Gesamt brutto («Gesamt»-Zeile), takeawayRevenue = TA brutto («Take Away»-Zeile), actualFood/actualBeverage = Kategorien brutto. Marketing pro Tag aus maison-daily-KV (Nennwert = netto). Tage ohne manuellen Import fehlen (leer, nie 0).
- Netto = TA/1.026 + (Gesamt−TA)/1.081 + Marketing. Referenz Juli 2026: 235'219.00 / 29'898.50 / 13'193.40 → 232'269.95.
- Food/Bev-Split: Direktanteile /1.081, Rest ANTEILIG nach Food/Bev-Verhältnis (basis=0 → hälftig); nettoUmsatzTag und foodBeverageSplit sind UNGERUNDET (Rundung erst bei Summe/Anzeige), sonst Rappen-Drift vs. Monatsformel.
- Parser (revenue-parser.ts parseGastronoviExcel): Die «Zeitraum»-Spalte (Spalte 1) ist das MASSGEBLICHE Perioden-Total — die Tageszellen des Gastronovi-Exports summieren NICHT exakt darauf (Juli: Tage 233'288.40 vs. Zeitraum 235'219.00). Jede Serie (total/takeAway/food/bev) wird proportional auf ihr Zeitraum-Total skaliert, Rundungs-/Vorzeichenrest auf den letzten Tag mit Wert; TA-Clamp ≤ total NACH der Skalierung. Mit Gesamt-Zeile: food/beverage = ROHE Kategoriezeilen (KEINE 70/30-Umlage — nur so stimmt der Küche/Bar-Split, z. B. 155'885/76'385); Legacy-70/30 nur im Fallback ohne Gesamt-Zeile.
- Nach Parser-/Feld-Änderungen müssen Excel + Marketing-Datei NEU importiert werden — alte KV-Stände haben kein takeawayRevenue und actualRevenue = Kategoriesumme statt Gesamt.
- Tag-Regel Personalkosten: Tag = IST nur wenn VOR heute UND Ist-Stunden; heute+Zukunft = PLAN (flexKostenProTag stichtag-Param).
- Achtung: umsatzIstProTag in PersonalkostenDaten ist NETTO — neue Konsumenten nicht mit brutto vergleichen.
- gn_* Tabellen sind RLS authenticated-only: Notebook-Checks brauchen Login als Testuser; anon liefert leere Resultate.

Entschieden/gefixt bei der App-weiten Umstellung:
- Maison-Additiv fliesst NIRGENDS mehr in den IST-Umsatz ein; ABER Marketing-Tageswerte aus dem separaten Marketing-Import (maison-daily) sind per User-Entscheid Teil des Netto (Nennwert netto).
- ER/Reporting teilen sich `applyCanonicalIstRule` in src/lib/effective-records.ts (revenueActual = kanonisch, Take-Away Kto. 3000/3010-Split, 3xxx-Vorrang, Personalkosten 5000–5009-Vorrang). Nie wieder parallel in beiden Seiten pflegen.
- VerkaufsDashboard bewusst NICHT umgestellt: WES-% braucht Zähler+Nenner beide aus product_sales.
- Banner «Noch keine Daten» darf nie erscheinen, wenn kanonischer IST für den Monat existiert (Bedingung inkl. canonicalRevenue[month]?.hasData).

**Session-Race-Lesson (wichtig):** Läuft ein Supabase-Read-Effekt nur einmal beim Mount, kann er VOR der Session-Hydration feuern → RLS liefert still 0 Zeilen (HTTP 200, kein Fehler) → Seite bleibt dauerhaft leer. Jeder solche Lader braucht: (a) Nachladen bei 'store-synced', (b) Generationszähler statt cancelled-Flag, (c) leeres Ergebnis überschreibt nie bereits geladene Daten. (KV-Reads via kvGet sind weniger betroffen, aber gleiche Vorsicht.)

Datenlage Juli 2026 nach Umstellung: 27 Tage im dailyBudgets-KV vorhanden (22.07. = 6'383.40 sichtbar), aber alte KV-Stände ohne takeawayRevenue → Netto vorerst 228'814.16; nach Re-Import des Excels (neuer Parser) und ggf. Marketing-Re-Import (KV hat 13'006.20 statt 13'193.40) → Ziel 232'269.95.
