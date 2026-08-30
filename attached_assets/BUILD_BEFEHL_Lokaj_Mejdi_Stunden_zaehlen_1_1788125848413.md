# Build-Befehl — Lokaj Mendim & Ramadani Mejdi: Fixlohn-MA, Ist-Stunden überall mitzählen (nur Überstunden ausgenommen)

## Problem

**Lokaj Mendim** und **Ramadani Mejdi** (OLIV) sollen **identisch** behandelt werden:
**Fixlohn-Mitarbeiter**, deren Ist-Stunden aus dem **Ist-Dienstplan** überall mitzählen — aber vom
**Überstunden-Konto** ausgenommen bleiben.

Aktuell falsch:
- Das Flag „ausgenommen · kein ÜStd-Konto" wirkt **zu breit** und nimmt beide auch aus
  **Stunden-Summen, Produktivität und Personalkosten** heraus (z. B. Ramadani Mejdi mit nur 16.8 h
  statt seiner ~199.7 h aus dem Dienstplan).
- **Ramadani Mejdi** ist als **„Zusatzkosten" / variabel** (Stundensatz 49.33 CHF/h) geführt — das
  ist falsch. Er ist ein **Fixlohn-MA** wie Lokaj Mendim.

## Soll-Verhalten

### 1) Beide als Fixlohn-MA führen
- **Ramadani Mejdi**: von „Zusatzkosten"/variabel auf **Fixlohn** umstellen — genau wie Lokaj Mendim.
  Das „Zusatzkosten"-Flag und die Stundensatz-basierte Kostenrechnung (49.33 CHF/h × Std) entfernen.
- **Lokaj Mendim**: bleibt Fixlohn (unverändert).
- Beide erscheinen in der **Fix-Lohnkosten-Liste** (fixes Monatsgehalt), **nicht** in der
  variablen/Flex-Liste. Ihre Kosten laufen über den Fixlohn wie bei allen anderen Fix-MA — die
  Ist-Stunden treiben **nicht** ihre Kosten (Fixlohn), aber sie zählen für Stunden/Produktivität/Belegung.

### 2) Flag „ausgenommen" nur noch aufs Überstunden-Konto scopen
Das Flag `ausgenommen · kein ÜStd-Konto` darf **ausschliesslich** das **Überstunden-Konto**
betreffen (z. B. `exclude_from_overtime_account = true`). Alle anderen Aggregationen dürfen dieses
Flag **nicht** mehr als Ausschlussgrund verwenden.

### 2b) WICHTIG — Stunden-Quelle ist der Ist-Dienstplan, NICHT die Kontrollliste
**Lokaj Mendim ist NICHT in der Kontrollliste/MIRUS mit Stunden erfasst.** Seine Ist-Stunden werden
**manuell im Ist-Dienstplan** eingetragen (wie bei einer Aushilfe). Sie müssen **trotzdem** in die
**Produktivität** und alle Stunden-/Belegungs-Kennzahlen einfliessen.
- Massgeblich für Produktivität (Umsatz ÷ Personalstunden) und alle Stunden-Summen ist der
  **Ist-Dienstplan** — also **alle** Ist-Stunden je MA/Tag, egal ob sie per **MIRUS/Kontrollliste**
  importiert **oder manuell** (Aushilfe, Lokaj, Mejdi) erfasst wurden.
- Die Produktivität darf **nicht** nur die Kontrolllisten-/MIRUS-Stunden im Nenner zählen — sonst
  fehlen genau die manuell erfassten MA wie Lokaj Mendim und die Produktivität wird zu hoch.
- Prüfen, ob im Produktivitäts-/Stunden-Nenner nach „Quelle = MIRUS/Kontrollliste" gefiltert wird —
  falls ja, diesen Filter entfernen und stattdessen die Ist-Dienstplan-Stunden (alle Quellen) nehmen.

### 3) Ist-Stunden beider MA (aus dem Ist-Dienstplan) müssen einfliessen in:
1. **Personalstunden-Summen** (Dienstplan-Tagestotale, Soll/Ist-Stunden, Wochen-/Monats-Ist).
2. **Produktivität** (Umsatz ÷ Personalstunden) — Cockpit **und** Menüpunkt «Besatzung & Produktivität».
   Ihre Stunden erhöhen den Nenner → Produktivität wird korrekt (tiefer).
3. **Cockpit-Zeile «Stunden — Ist (MIRUS)»** und **Personalquote (PKQ)**.
4. **Besatzungsstunden** und alle Belegungs-/Auslastungs-Kennzahlen.

### Nur AUSGENOMMEN bleiben beide im:
- **Überstunden-Konto** (Fix-MA): weiterhin „–" / „ausgenommen · kein ÜStd-Konto".

## Umsetzung
- Ist-Stunden-Quelle einheitlich der **Ist-Dienstplan** (dieselbe Quelle wie die Tages-Summen) —
  kein separater/abweichender Wert.
- Prüfen, wo nach `ausgenommen`/`kein ÜStd-Konto`/`Zusatzkosten` gefiltert wird, und diese Filter
  aus **Stunden-, Produktivitäts-, PKQ- und Kosten-Aggregationen entfernen**; nur im
  Überstunden-Konto behalten.
- Mejdi im Stammdaten-/Kostenmodell von „variabel/Zusatzkosten" auf **Fixlohn** umstellen.

## Akzeptanzkriterien (mit den sichtbaren Zahlen)
1. **Ramadani Mejdi** steht in der **Fix-Lohnkosten-Liste** (fixes Monatsgehalt), nicht mehr als
   „Zusatzkosten"/variabel; kein Stundensatz 49.33 CHF/h × Std mehr.
2. **Lokaj Mendim** unverändert Fixlohn.
3. Beide zählen mit ihren **vollen Ist-Stunden aus dem Dienstplan** in Personalstunden, Produktivität
   und Besatzung (Mejdi Monat ~199.7 h / KW35 ~50.4 h; Lokaj Monat 137.8 h) — Mejdi nicht mehr mit 16.8 h.
   **Lokaj Mendim zählt mit, obwohl er NICHT in der Kontrollliste/MIRUS steht** (Stunden manuell im
   Ist-Dienstplan) — die Produktivität nimmt seine Stunden mit in den Nenner.
4. **Produktivität (Umsatz/Std)** im Cockpit und in «Besatzung & Produktivität» sinkt entsprechend,
   weil der Stunden-Nenner nun vollständig ist.
5. **Cockpit «Stunden — Ist (MIRUS)» = Dienstplan-Tages-Summen** derselben Woche (alle MA, inkl. beider).
6. **Überstunden-Konto** zeigt für Lokaj Mendim und Ramadani Mejdi weiterhin „–"
   („ausgenommen · kein ÜStd-Konto") — unverändert.
