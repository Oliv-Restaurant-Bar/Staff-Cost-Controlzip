# Build-Befehl — Neuer Menüpunkt «Besatzung & Produktivität» + Cockpit-Export

Bitte einen **neuen, eigenständigen Menüpunkt «Besatzung & Produktivität»** umsetzen. Datenquelle
ist **ausschliesslich der Import der Kontrollliste** (MIRUS-Export `report_test`, `.xls`). Dieser
Import wird **nur für diesen Menüpunkt** verwendet und darf die bestehenden Importe (Ist-Stunden
für Dienstplan/Personalkosten, Umsatz, Warenrechnungen/WKQ) **nicht** verändern. Zusätzlich am
Ende: zwei Diagramme in den **Cockpit-Export** übernehmen (Abschnitt 9).

---

## 1) Kontrollliste einlesen (`report_test`, `.xls`)

- Echte **BIFF/OLE2 `.xls`** (kein HTML). Python `xlrd` (`open_workbook`) oder Node `xlsx`.
  Genau **ein Blatt `report_test`**, 30 Spalten. Zellen teils **verbunden (merged)** → immer die
  obere linke **Ankerzelle** lesen.

### Kopf
| Zeile (0-basiert) | Spalte | Inhalt |
|---|---|---|
| 0 | 2 | `Kontrollliste DD.MM.YYYY - DD.MM.YYYY` → Auswertungszeitraum |
| 1 | 2 | Mandant, z. B. `3027 Restaurant OLIV` / `3012 Restaurant Beaulieu AG` |
| 5 | — | Kopfzeile: Datum · Zeiterfassung · Brutto · Total · Effektiv · Brutto · Total · Differenz · Status |

### Datenblock (ab Zeile 7), pro Mitarbeitende:r
- **Namenszeile:** Spalte **2** hat Text **und** Spalte **3 leer** → neuer MA.
- **Tageszeile:** Spalte **3** = Excel-Datums-Seriennummer (z. B. `46235` = 01.08.2026; Basis 1899-12-30).

| Spalte | Bedeutung | Verwendung |
|---|---|---|
| 3 | Datum (seriell) | → Datum, Wochentag, ISO-Kalenderwoche |
| 6 | Zeiterfassung (Roh-Stempel **oder** Abwesenheit) | Codes `1 Frei` / `1 Ferien` / `1 Krank` / `1 Frei (kompensation)` |
| 9 | Zeiterfassung Brutto | Roh-Brutto |
| 12 | Zeiterfassung Total | **> 0 ⇒ gestempelt (Ist)** ; `0` ⇒ nur manuell/geplant |
| 15 | **Effektiv — Von-Bis-Fenster** | **massgebend** für Schichtzeiten (siehe 2) |
| 18 | Effektiv Brutto | Brutto der Schicht (inkl. Pause) |
| 20 | **Effektiv Total (netto)** | **massgebende Netto-Arbeitsstunden** (Produktivität) |
| 23 | Differenz | Kontrolle |
| 26 | Status | Flags: `Fehler` / `Geprüft` / `Manuell` (Kombinationen) — blockieren den Import **nicht** |

- **Abbruch:** Namenszeile mit Text `Total` = Fusszeile → nicht als MA aufnehmen, Parsing beenden.
- **`inIst`-Flag je MA:** true, wenn an mind. einem Tag Spalte 12 > 0 (gestempelt). Sonst
  «nur Kontrollliste» markieren (z. B. Abdii Avdi = geplant, noch nicht gestempelt).

---

## 2) Von-Bis-Fenster (Spalte 15) + 30-Minuten-Regel

- Spalte 15 ist die **bereits korrigierte** Arbeitszeit (Fehler/Manuell schon berücksichtigt) —
  immer **diese** Spalte nehmen, nicht Spalte 6.
- Mehrere Segmente (Splitdienst) durch **Zeilenumbruch** getrennt: `10:00 - 14:00\n17:30 - 23:00`.
  Muster je Segment `HH:MM - HH:MM` → Dezimalstunden.
- **Über Mitternacht:** Endzeit ≤ Startzeit ⇒ **+24 h** (z. B. `17:39 - 00:17` → 17.65–24.28).
- **Zeilen ohne Zeitfenster** (Abwesenheit/leer) = keine Schicht (0 Std).
- **Netto-Stunden je Tag = Spalte 20** (nicht Fensterlänge — die wäre brutto).

**30-Minuten-Regel (Balken-Bildung):** Segmente nach Start sortieren; solange
`nächster.Start − aktueller.Ende ≤ 0.5 h` → **zu einem Balken verschmelzen** (`Ende = max`), sonst
**neuer Balken**.
- `10:00-14:00` + `17:30-23:00` (Lücke 3.5 h) → **zwei** Balken (echte Pause / Splitdienst).
- `10:35-11:10` + `11:12-13:31` + `13:34-15:27` (Lücken < 30 Min) → **ein** Balken `10:35-15:27`
  (reine Stempel-Korrekturen).

---

## 3) Abteilung (Küche / Service / Geschäftsleitung)

**Die Kontrollliste enthält KEINE Abteilung.** Für Küche/Service braucht es eine
**Mitarbeiter-Stammdaten-Zuordnung** `Mitarbeiter → Abteilung`:
- Primär: editierbare **Stammdaten-Tabelle** im Cockpit (pro Mandant): `Küche` / `Service` / `Geschäftsleitung`.
- Auto-Seed: aus dem Tägliche-Stunden-Import (`report_stdtagkst`, Abteilungssplit 1 Küche / 2 Service / 4 GL) vorbefüllen, falls vorhanden.
- Fallback: unbekannter MA → `Service`, aber **sichtbar markieren** («Abteilung offen»).
- Geschäftsleitung (z. B. `Krebs Marcel`, Beaulieu) separat ausweisen, nicht in die Küche/Service-Produktivität mischen.

---

## 4) Zwei Hauptansichten (Umschalter oben im Menüpunkt)

**A) Produktivität** (Diagramm-Ansicht) · **B) Dienstplan** (Schicht-Ansicht).
Gemeinsame Filter: Abteilung (`Alle / Küche / Service`), Wochen-Wechsel (KW).

---

## 5) Ansicht «Dienstplan» (genaue Zeiten)

**5a) Tagesansicht «Schichten — wer von wann bis wann»:**
- Zeitachse **oben**. **Genau EINE Zeile pro Mitarbeiter:in**; mehrere Balken pro Zeile = Pausen
  > 30 Min (Regel Punkt 2). Nicht pro Segment eine eigene Zeile.
- **Von-Bis-Zeit mittig ÜBER dem Balken** anzeigen (nicht im/neben dem Balken) — so überlappen
  auch mehrere schmale Balken nicht.
- **Links je Zeile die Netto-Tagesstunden** (rot, wenn Überstunden nach Punkt 6).
- **Rote Umrandung** des Balkens = Überstunden **oder** Ende nach Mitternacht (Punkt 6).

**5b) Einzel-MA-Ansicht** (MA wählen) mit **Zeitraum-Umschalter KW / Monat**:
- **Woche:** 7 Tage untereinander mit Von-Bis-Balken + Netto-Stunden links; Wochenwechsel möglich.
- **Monat:** **jeden Arbeitstag einzeln** untereinander (wie Wochenansicht), nach KW gruppiert,
  jeder Tag mit seinen zusammengefassten Balken — nicht nur eine Wochensumme.

**5c) Wochen-Dienstplan-Tabelle:** MA-Zeilen × Wochentage, je Zelle Von-Bis (bei Splitdienst beide
Zeilen) + Netto-Std, gruppiert nach Abteilung, Wochensumme je MA + Fusszeile «Personalstd/Tag».

---

## 6) Überstunden-/Nacht-Markierung (rot) — bestätigt

- Rot, wenn **Netto-Arbeitsstunden des Tages ≥ 9 h** (Spalte 20, **ohne** Pause — die
  Anwesenheits-Spanne inkl. Pause zählt NICHT) **oder** Schicht endet **≥ 23:50** (nach Mitternacht).
- Beispiel: 10:00–14:00 + 17:00–22:00 = 8.4 h netto → **nicht** rot (obwohl Spanne 12 h).
- Optional: falls ein echtes Überstunden-/Zeitkonto in der App existiert (Wochensoll z. B. 42 h),
  kann die rote Markierung stattdessen **daraus** gespeist werden.

---

## 7) Ansicht «Produktivität» (Diagramme)

**7a) Wochen-KPIs (gewählte KW):** Besatzungsstunden, Umsatz (netto), Produktivität Ø (CHF/Std),
produktivster Tag.

**7b) Diagramm «Umsatz & Produktivität pro Tag» (gewählte KW):**
- **Balken = Umsatz je Tag** (CHF, aus dem Umsatz-Import). Kleine Zahl **im** Balken = Besatzungsstunden («X Std»).
- **Punkte/Linie = Produktivität CHF/Besatzungsstunde** je Tag.
- **Waagrechte Budget-Linie bei 100 CHF/Std**. Punkte **grün = ≥ Budget**, **rot = < Budget**
  (Farbe anhand der **gerundeten** angezeigten Zahl, damit z. B. «100» grün ist).
- **Lesbarkeit:** Produktivitätszahlen mit **dunklem Chip/Hintergrund** hinterlegen (grün/rot auf
  Goldbalken sonst nicht lesbar). Budget-Beschriftung als kleiner Chip am **rechten Rand** der Linie
  (nicht über den Balken/KPIs legen).
- **Balken/Tag anklickbar → Tages-Detail** (Panel/Popup): Umsatz, Besatzungsstunden und
  Produktivität vs. Budget des Tages + die **Schicht-Zeitlinie aller Mitarbeitenden** dieses Tages
  (wer von wann bis wann, Netto-Stunden links) — gleiche Darstellung wie 5a.
- Fehlt der Umsatz-Import für die Woche: Balken zeigen Besatzungsstunden (in «Std»), Produktivität/
  Budget erscheinen automatisch, sobald der Umsatz da ist.

**7c) Diagramm «Umsatz vs. Personalstunden — Wochenverlauf»:** Balken = Personalstunden je Woche
(Σ Spalte 20, **als «Std» beschriftet**), Linie = Umsatz, zusätzlich Produktivität CHF/Std je Woche.

---

## 8) Aushilfen aus «Dienstplan · Ist-Stunden» ergänzen (Häkchen)

**Problem:** Aushilfen werden **manuell** erfasst und kommen **nicht** über MIRUS / die
Kontrollliste — ihre Stunden fehlen sonst in Besatzung & Produktivität.

**Lösung — Auswahl-Panel mit Häkchen, pro Tag ODER ganze Woche:**
- Ganze Woche = Häkchen auf der Aushilfe-Zeile.
- Einzelne Tage = anklickbare **Datums-Chips** (z. B. «Fr 21.08 · 6.5 h»); nur angehakte Tage zählen.
- Quelle der Stunden: der **Dienstplan-Ist-Stunden-Import** (Liste jener MA, die dort Ist-Stunden
  haben, aber in der Kontrollliste fehlen).
- Ausgewählte Aushilfe-Stunden fliessen in **Besatzungsstunden**, **Produktivität** (sinkt
  entsprechend) und den **Wochen-Dienstplan** ein — nur an den gewählten Tagen, klar markiert
  «Aushilfe · Ist / manuell». Da keine Von-Bis-Stempelzeit vorliegt: als **Stunden-Badge**
  darstellen (gestrichelter Balken «＋ X.X h · Aushilfe»), nicht als Von-Bis-Balken.
- Auswahl (Tage/Woche) **pro Mandant merken**.

---

## 9) NEU — Cockpit-Export erweitern

Im **Cockpit-Export** (bestehender Cockpit-/Dashboard-Export) zusätzlich **zwei Diagramme** aus
diesem Menüpunkt übernehmen, jeweils dieselbe Darstellung wie oben:

1. **«Produktivität pro Tag» der aktuellsten (zuletzt importierten) Woche** — das Diagramm aus 7b
   (Umsatz-Balken + Produktivitätslinie + Budget-Linie 100), Mo–So der neusten Woche.
2. **Darunter: «Wochenverlauf»** — das Diagramm aus 7c über die **letzten 4 abgeschlossenen Wochen
   + die laufende Woche** (also 5 Wochen: 4 komplette + aktuelle). Laufende Woche visuell
   kennzeichnen (z. B. «(laufend)» / halbtransparent), da noch nicht vollständig.

Beide Diagramme sollen aus denselben Kontrolllisten-/Umsatz-Daten gespeist werden wie der
Menüpunkt (keine Doppelerfassung).

---

## 10) Isolierung & Akzeptanzkriterien

**Isolierung:** Dieser Import speist **nur** «Besatzung & Produktivität» und die zwei neuen
Cockpit-Export-Diagramme. Dienstplan-Ist, Personalkosten, Umsatz und Warenrechnungen/WKQ bleiben
unverändert.

**Testfälle (echte Zahlen):**
1. **Netto-Rekonziliation Woche = Σ Spalte 20:** Beaulieu **KW35 = 317.53 h**; OLIV **KW34 = 663.28 h**
   gesamt, davon Abdii Avdi 45.0 h (Spalte 12 = 0, «nur geplant»), gestempelt/Ist = 618.3 h.
2. **30-Min-Regel:** `10:00-14:00`+`17:30-23:00` → 2 Balken (eine Zeile); Ramadani Mejdi
   8.4 h netto → **nicht** rot; de Jong Micky Sa mit 3 Balken sauber (Zeiten über den Balken).
3. **Splitdienst/Mitternacht:** `17:39 - 00:17` → Ende 24:17, korrekt «nach Mitternacht» (rot).
4. **Abteilung** aus Stammdaten; unbekannte MA markiert. Abdii Avdi = Küche.
5. **Aushilfe-Häkchen:** angehakte Aushilfe (nur Fr) erhöht Besatzungsstunden Fr, senkt Produktivität,
   erscheint nur am Fr im Wochen-Dienstplan.
6. **Diagramm:** Balken = Umsatz, Linie = Produktivität, Budget-Linie 100; Klick auf Tag zeigt die
   Mitarbeiter-Zeitlinie + Umsatz/Produktivität des Tages.
7. **Cockpit-Export:** enthält «Produktivität pro Tag» (neuste Woche) + «Wochenverlauf» (letzte 4
   Wochen + laufende Woche).

## Spalten-Kurzreferenz (Blatt `report_test`, 0-basiert)
```
Namenszeile : Spalte 2 = Name, Spalte 3 leer
Tageszeile  : 3=Datum(seriell) 6=Zeiterfassung/Abwesenheit 9=ZE-Brutto
              12=ZE-Total(netto, >0 ⇒ gestempelt) 15=Effektiv Von-Bis(mehrzeilig)
              18=Eff-Brutto 20=Eff-Total(NETTO) 23=Differenz 26=Status
Fusszeile   : Spalte 2 = "Total" ⇒ Ende
Abwesenheit : "1 Frei" | "1 Ferien" | "1 Krank" | "1 Frei (kompensation)"
Über Mitternacht: Endzeit ≤ Startzeit ⇒ +24 h ; Balken-Trennung ab Pause > 30 Min
Überstunden : Netto-Tagesstunden ≥ 9 h (Sp. 20) ODER Ende ≥ 23:50
```
