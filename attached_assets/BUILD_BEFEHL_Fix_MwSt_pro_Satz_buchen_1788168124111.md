# Build-Befehl — Warenrechnungen ohne Mischsätze: exakt nach MwSt-Satz vom Beleg buchen

## Problem
Rechnungen mit gemischten MwSt-Sätzen (z. B. Food 2.6 % + Non-Food/Beverage 8.1 %) werden aktuell
über einen **gemittelten Kopfsatz** gebucht (z. B. Transgourmet 2.9 %, Caporaso 3.2 %, Prodega
5.3 %). Das ist falsch. **Es darf keine Mischsätze geben.**

## Soll-Verhalten — Split pro MwSt-Satz (und Kategorie)
Jede Rechnung wird **exakt so gebucht wie auf dem Beleg**: pro **MwSt-Satz** eine eigene
Buchungszeile mit dem **korrekten Netto-Teilbetrag**, der **exakten MwSt** und dem passenden
**Warenkonto/Kategorie**. Also z. B. eine Rechnung → mehrere Positionen:
- Food **2.6 %** (Konto 4060)
- Beverage **8.1 %** (Konto 4020/4040/4050 je nach Getränkeart)
- Non-Food **8.1 %** (Konto 4701)
- Leergut/Pfand **0 %** (Konto 4800, ausserhalb WKQ)

Der Kopf-/Rechnungstotal muss weiterhin exakt aufgehen (Summe der Teilzeilen = Belegtotal), aber
**nie** als ein einziger gemittelter Satz gebucht werden.

## Umsetzung je Importer

### 1) CSV Transgourmet/Prodega
Die CSV hat **je Position** einen `MwSt. Code` und `Warengruppe`. Danach splitten:
- **MwSt-Satz aus dem Code:** `1`, `7` → **2.6 %** · `2`, `3`, `8` → **8.1 %** · `0` → **0 %** (Leergut/Ifco/Pfand).
  (Kontrolle: MwSt-Betrag der Zeile ÷ Positionspreis = Satz.)
- **Kategorie aus der Warengruppe:** `Food` / `Früchte + Gemüse` / `Molkerei/Backwaren` / `Metzgerei`
  → Food (4060) · `Wein` / `Spirituosen` → Beverage · `Nonfood` / `Nearfood` → Non-Food (4701) ·
  `Ifco LiftLock` / Pfand → Leergut (4800).
- Positionen je Rechnung nach **(Kategorie, MwSt-Satz)** gruppieren → je Gruppe **eine** Buchungszeile
  mit Σ Netto und dem exakten Satz. Keine Mittelung.

### 2) Lieferanten-PDFs (Caporaso, Terravigna, Fideco, Ambro, Gourmador, Spahni, Bohnenblust …)
Diese Belege weisen im Fuss die **MwSt pro Satz** aus. Diese Aufteilung übernehmen:
- **Caporaso** (2146205): 2.6 % von 1'471.50 (Food) **+** 8.1 % von 175.00 (Non-Food, Pizzakarton)
  → zwei Zeilen, nicht 3.2 % auf 1'646.50.
- **Terravigna** (ADORO): 693.00 rein 8.1 % (Beverage) → eine Zeile 8.1 %.
- **Ambro Food**: rein 2.6 % (Food) → korrekt.
- Allgemein: Kopf-Erkennung behalten, aber die **Satz-Aufteilung aus dem Beleg** buchen.

### 3) Feldschlösschen
Der Beleg hat die **MwSt-Zusammenfassung** je Umsatzgruppe. Danach splitten:
- Bier **8.1 %**, Spirituosen **8.1 %**, Zu-/Abschläge **8.1 %**
- Mineralwasser **2.6 %**, andere alkoholfreie Getränke **2.6 %**
- Leergut **0 %** (Konto 4800)
→ je Satz eine Zeile mit dem exakten Netto aus der Zusammenfassung. Nicht auf einen 5 %-Mischsatz mitteln.

## Bestehende Buchungen bereinigen
Die bereits mit Mischsatz gebuchten OLIV-KW35-Einträge (Transgourmet 2.9 %, Prodega 5.3 %/6.1 %/6.6 %,
Caporaso 3.2 %, Feldschlösschen 5 %) neu splitten — entweder per erneutem Import nach dem Fix
(Undo + Re-Import, idempotent) oder per Migration. Ambro Food (2.6 %) und Terravigna (8.1 %) sind
bereits korrekt.

## Akzeptanzkriterien
1. **Kein Beleg** wird mehr mit einem gemittelten/„krummen" MwSt-Satz gebucht. Jede Buchungszeile
   trägt einen **echten Satz vom Beleg**: 2.6 %, 8.1 % oder 0 %.
2. Rechnungen mit gemischten Sätzen erzeugen **mehrere** Zeilen (je Satz/Kategorie), deren Netto-Summe
   exakt dem Belegtotal entspricht.
3. **Caporaso 2146205** erscheint als 1'471.50 @2.6 % (Food) + 175.00 @8.1 % (Non-Food), nicht als 3.2 %.
4. **Transgourmet/Prodega**-CSV wird je Position nach MwSt-Code gesplittet; Ifco/Pfand mit 0 % auf 4800.
5. **Feldschlösschen** getrennt in 2.6 % / 8.1 % / 0 % gemäss MwSt-Zusammenfassung.
6. Vorsteuer/Erfolgsrechnung stimmen belegsgenau; die WKQ-Kategorien (Food/Beverage/Non-Food) bleiben korrekt.
