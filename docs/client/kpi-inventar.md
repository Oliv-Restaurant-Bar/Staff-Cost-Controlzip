# KPI-Inventar — Management-Dashboard (Startseite «/»)

Verbindliches Inventar der Management-KPIs nach dem **3-Ebenen-Controlling-Modell**.
Quelle der Wahrheit im Code: `src/lib/kpi-catalog.ts` (fester Katalog, reine Logik).
Dieses Dokument beschreibt die fachlichen Definitionen — die Berechnungsregeln selbst
leben ausschliesslich in den zentralen Engines (Financial-Metrics-Registry,
Ton-Helfer, wes-month usw.), der Katalog delegiert nur.

## Die 3 Ebenen

| Ebene | Zweck | Wo |
|---|---|---|
| **1 — Management** | 16 kompakte KPIs, in < 1 Minute erfassbar (4 Karten + Tabelle, Monatswahl) | Startseite «/», Sektion «Management-KPIs» |
| **2 — Analyse** | Bestehende Analyse-Seite je KPI («Analyse»-Link) | z. B. Erfolgsrechnung, WES-Analyse, FIX+VARIABEL, Kennzahlen-Bericht |
| **3 — Detail/Beleg** | Bestehende Detail-/Beleg-Ebene («Detail»-Link) | z. B. Tagesansicht (Z-Berichte), Warenrechnungen, Dienstplan, Umsatzabstimmung |

## Verbindliche Regeln

- **Fehlend = «—», NIE 0.** Quellen, die 0 als «keine Daten» liefern (gn-personen-db),
  werden auf null abgebildet.
- **P&L-KPIs delegieren 1:1 an die Financial-Metrics-Registry** (EIN `computePLForMonth`,
  IST/Budget/VJ immer netto). Keine Zweitberechnung.
- **Ampeln NUR aus bestehenden zentralen Regeln** (`warenPctTone`, `personalPctTone`,
  `vollstaendigkeitTone`, Bank-Benchmark-Regel ± 1.0 pp Toleranz). KPIs ohne bestehende
  Schwelle bleiben neutral — es werden keine neuen Schwellen erfunden.
- **Abw. Budget** = IST − Budget aus Rohwerten (CHF bzw. pp), reine Anzeige-Ableitung
  ohne Ampel; eine Seite fehlt ⇒ «—».
- **Monatskommentare** je Monat × KPI (KV-Blob `kpi_comments_v1`, tenant-präfixiert,
  Union-Merge newer-wins, Tombstones, Dirty-Check). Erscheinen im GL-Export.
- **Ziel-Personalquote** wird weiterhin zentral im Budget gepflegt — der Katalog zeigt
  sie nur an.

## Die 16 KPIs (Reihenfolge = Anzeige)

| # | KPI | Einheit | Quelle (SSoT) | Formel | Budget/VJ | Ampel | Ebene 2 | Ebene 3 | Karte |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Nettoumsatz | CHF | Financial-Metrics-Registry | Summe Ertragskonten, netto | ✓ | — | /erfolgsrechnung | /tagesansicht | ✓ |
| 2 | Warenaufwand | CHF | Registry (Warenaufwand-Gruppierung) | direkt + übrig (Kontobereiche) | ✓ | — | /wes-analyse | /warenrechnungen | |
| 3 | Warenquote | % | Registry (Quote aus Rohwerten) | Warenaufwand ÷ Nettoumsatz × 100 | ✓ | `warenPctTone` (> 28 warn, > 33 kritisch) | /wes-analyse | /warenrechnungen | ✓ |
| 4 | Bruttogewinn 1 | CHF | Registry | Nettoumsatz − Warenaufwand | ✓ | — | /erfolgsrechnung | — | |
| 5 | Personalaufwand | CHF | Registry (effektive ER-Regeln) | Löhne + AG-Sozialkosten + übriger PA | ✓ | — | /personal-fix | /personal | |
| 6 | Personalquote | % | Registry (Quote aus Rohwerten) | Personalaufwand ÷ Nettoumsatz × 100 | ✓ | `personalPctTone` mit Budget-Ziel (ohne Ziel neutral) | /personal-fix | /analyse | ✓ |
| 7 | EBITDA | CHF | Registry | Bruttogewinn 2 − übriger Betriebsaufwand | ✓ | — | /erfolgsrechnung | — | |
| 8 | EBITDA-Marge | % | Registry | EBITDA ÷ Nettoumsatz × 100 | ✓ | Bank-Benchmark ≥ 15 % (± 1.0 pp) | /reporting | — | |
| 9 | EBIT | CHF | Registry | EBITDA − Abschreibungen | ✓ | — | /erfolgsrechnung | — | ✓ |
| 10 | EBIT-Marge | % | Registry | EBIT ÷ Nettoumsatz × 100 | ✓ | Bank-Benchmark ≥ 10 % (± 1.0 pp) | /reporting | — | |
| 11 | Gäste | Anzahl | gn_person_metrics («Anzahl Personen») | Summe Tages-Gästezahlen | nur VJ | — | /gaeste/auswertung¹ | /gaeste¹ | |
| 12 | Durchschnittsbon | CHF | gn_person_metrics («Durchschnittsbon») | Ø Tageswerte im Monat | nur VJ | — | /kennzahlen-bericht | — | |
| 13 | Umsatz pro Gast | CHF/Gast | gn_person_metrics | Umsatz total ÷ Anzahl Gäste | nur VJ | — | /kennzahlen-bericht | — | |
| 14 | Wareneinsatz (verkaufsbasiert) | % | wes-month × Registry-Nettoumsatz | Σ (Menge × Rezept-WES) ÷ Nettoumsatz × 100 | — | — | /wes-analyse | /produkt-analyse | |
| 15 | Produktivität | CHF/h | Registry-Umsatz ÷ Arbeitszeiten | Nettoumsatz ÷ produktive Ist-Stunden (> 0, ohne Abwesenheiten) | — | — | /kennzahlen-bericht | /personal | |
| 16 | Tagesabschlüsse geprüft | % | Adyen-Abstimmungs-Blob | bestätigte ÷ erfasste Tage (bis gestern) × 100 | — | `vollstaendigkeitTone` (≥ 80 gut, ≥ 50 warn) | /tagesabschluesse | /umsatzabstimmung | |

¹ Gast-Sessions: Links auf PII-Flächen (`/gaeste`, `/gaeste/auswertung`) werden ausgeblendet.

## Export-Profile (Excel + PDF)

| Profil | Inhalt | KPIs |
|---|---|---|
| **Geschäftsleitung** | Alle 16 KPIs **+ Monatskommentare** | 1–16 |
| **Bank** | P&L-Kern bis EBIT-Marge | 1–10 |
| **Investoren** | Kompakt: Umsatz + Ergebnis | 1, 7, 8, 9, 10 (Investoren ⊆ Bank) |

Regeln: Excel mit echten Zahlenzellen (Rohwerte) + Anzeige-Rundung nur über Zellformate,
`null` = leere Zelle (nie 0); PDF mit denselben Rows und Ampel-Färbung nur auf der
IST-Spalte. Beide Exporte konsumieren `buildManagementKpiRows` (dieselben
`getKpiValues`/`getKpiTone` wie die UI — keine Zweitberechnung).

## Datenaktualität

| Quelle | Rhythmus |
|---|---|
| Z-Bericht (Umsatz) | täglich nach PDF-Import |
| ER-/Kosten-Import (Sage) | monatlich |
| Gastronovi-KPI-Importe (Gäste, Bon) | wöchentlich |
| Arbeitszeiten (Mirus/manuell) | nach Import/Erfassung |
| Tagesabschluss-Bestätigungen | laufend |
