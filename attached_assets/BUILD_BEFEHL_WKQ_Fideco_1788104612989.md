# Build-Befehl für den Replit-Agenten — Warenrechnungen / WKQ

Bitte drei Dinge umsetzen. Bestehende Importer (Transgourmet-CSV, Feldschlösschen-PDF,
Obrist, Rutishauser, Metzgerei Spahni) dürfen dabei NICHT kaputtgehen. Alles auf
**Netto-Basis (= Erfolgsrechnung)** rechnen. Keine Beträge löschen — nur als „ersetzt"
markieren, damit die Historie erhalten bleibt.

---

## 1) Fideco-Lieferschein erkennen (auch ohne MWST-Nummer)

**Problem:** Die Lieferanten-Erkennung läuft über MWST-Nr-Profile. Fideco-Lieferscheine
tragen KEINE MWST-Nummer und werden darum als „Unbekannter Lieferant" abgewiesen.

**Lösung:** Zusätzlich zum MWST-Nr-Profil einen **Text-Fallback** einführen. Wenn im PDF
kein bekanntes MWST-Nr-Profil greift, den Lieferanten über stabile Kopf-Textmerkmale
erkennen. Für Fideco erkennen, wenn EINES davon im PDF-Text vorkommt (case-insensitive):

- `Fideco` / `www.fideco.ch` / `Fideco Murten`
- oder die Kundennummer `27135` (Fideco-Kundennummer von Beaulieu)
- (Kontext: „A Member of Rungis express Family / A METRO Company")

**Bei erkanntem Fideco-Lieferschein automatisch setzen:**
- Lieferant: `Fideco`
- Konto: `4060`   ·   Kategorie: `Food`   ·   MwSt: `2.6 %` (Fleisch)
- Belegtyp: `Lieferschein` → Status `provisorisch`
- Beleg-Nr: die Lieferschein-Nummer (Feld „Lieferschein", z. B. 7750842)
- Datum: das LS-Datum (Feld „LS-Datum", z. B. 24.08.26)

**Positionen parsen:** Zeilen mit Art.-Nr (z. B. `N0177`, `0324`, `N10211`), Bezeichnung,
Menge in KG, Einzelpreis und Betrag. Netto = Summe der Positions-Beträge; zur Kontrolle
gegen die Gesamt-/CHILLED-Zeile (`CHF …`) prüfen. Alle Fideco-Fleischpositionen mit 2.6 %.

---

## 2) „Monatsrechnung ersetzt Lieferscheine" — auch für Fideco

Fideco soll sich genau wie Terravigna / Spahni verhalten
(„PDF Lieferscheine + Monatsrechnung"). Regel für ALLE Lieferanten dieses Typs:

**Gruppierungsschlüssel für die Ersetzung:** `(Lieferant, Kalendermonat des Lieferdatums)`

**Ersetzungslogik beim Bilden JEDER Summe (WKQ, Warenaufwand, Analyse):**
- Existiert für eine `(Lieferant, Monat)`-Gruppe eine **Monatsrechnung** → nur die
  Monatsrechnung zählen, ALLE provisorischen Lieferscheine dieser Gruppe ignorieren.
- Existiert (noch) KEINE Monatsrechnung → die provisorischen Lieferscheine zählen.
- Einzelrechnungen (Obrist, Rutishauser, Blaser, Prodega-CSV) haben kein Lieferschein-
  Pendant → zählen immer einmal.

**Beim Import einer Monatsrechnung:** die betroffenen Lieferscheine
`(gleicher Lieferant, gleicher Monat)` als `ersetzt / superseded` markieren (nicht löschen)
und aus allen Summen ausschliessen. So entsteht nie ein Doppel.

---

## 3) Eine einzige WKQ-Kachel — provisorische zählen wie echte Rechnungen

**Ziel:** Es darf NICHT mehr zwei unterschiedliche WKQ geben (aktuell 26.9 % inkl.
provisorisch vs. 19.4 % Erfolgsrechnung). Die provisorischen Lieferscheine sind echte
Kosten und MÜSSEN in die WKQ.

**Neue, einheitliche Berechnung (überall identisch verwenden — Monat-KPI oben UND Analyse):**
- **Zähler** = Σ Netto aller ZÄHLENDEN Belege auf Konten `4020–4070`, nach der
  Ersetzungsregel aus Punkt 2 (also inkl. provisorische Lieferscheine, die noch nicht
  durch eine Monatsrechnung ersetzt sind; jede Lieferant-Monat-Gruppe genau einmal).
- **Nenner** = Netto-Umsatz des gewählten Zeitraums.
- **WKQ = Zähler / Nenner.**

**Darstellung:**
- Die alte zweite/abweichende WKQ-Kennzahl entfernen. Es gibt genau EINE WKQ, die in
  allen Kacheln denselben Wert zeigt (bei gleichem Zeitraum muss Monat-KPI = Analyse sein).
- Provisorischen Anteil transparent ausweisen, z. B. Unterzeile
  „inkl. CHF X provisorisch (Y Belege)", aber im WKQ-Wert enthalten.
- Non-Food (Konto 4701) und Leergut/Depot (separate Konten) bleiben wie bisher AUSSERHALB
  der 4020–4070-WKQ.

---

## Akzeptanzkriterien (bitte prüfen)

1. Ein Fideco-Lieferschein (ohne MWST-Nr) wird erkannt und als Fideco / 4060 / Food /
   2.6 % / provisorisch erfasst — nicht mehr „Unbekannter Lieferant".
2. Wird danach eine Fideco-Monatsrechnung importiert, verschwinden die Fideco-Lieferscheine
   desselben Monats aus allen Summen (Status „ersetzt"); der Monatsbetrag zählt nur einmal.
3. Es gibt nur noch EINE WKQ-Zahl; Monat-KPI und Analyse zeigen bei gleichem Zeitraum
   denselben Wert. Provisorische sind darin enthalten.
4. Kein Doppelzählen mehr zwischen Lieferschein und Monatsrechnung.
5. Bestehende Importer und die Netto-/Erfolgsrechnungs-Basis bleiben unverändert.
