---
name: MwSt-Satz-Bündelungs-Check (Waren-Analyse)
description: Cross-Konto-Kontierungsbefund je Lieferant (FIBU bündelt nach MwSt-Satz auf ein Beverage-Konto) — Erkennungsregeln, Abgrenzungen, Testfeste Werte.
---

# MwSt-Satz-Bündelung (Cross-Konto-Kontierungs-Check)

Regel: Treuhänder bündelt FIBU-Buchungen nach MwSt-Satz auf EIN Beverage-Konto
(z.B. Feldschlösschen alles auf 4030), während der App-Split (Wahrheit) auf
Geschwister-Konten verteilt. Dann EIN Befund statt Einzel-Abweichungen je Konto.

**Erkennungs-Konturen (bewusst eng, Architect-geprüft):**
- Nur Beverage-Geschwister (4020–4050) + Non-Food (4090/4701) beteiligt; das
  Überschusskonto MUSS ein Beverage-Konto sein. Food-Muster (4060/4070) sind
  KEINE Bündelung — die behandelt der bestehende Einzel-Konto-Check.
- Genau EIN Überschuss (Delta < −100 CHF), ≥2 Defizite (Summe ≥ 100), gegenseitige
  Deckung ≥ 50 %. Deltas = App − FIBU (App massgebend).
- Vorschlags-Unterdrückung NUR pro `${lieferant}|${konto}`-Paar der beteiligten
  Konten — unabhängige Abweichungen desselben Lieferanten auf anderen Konten
  (z.B. fehlende Rechnung 4060) müssen sichtbar bleiben. **Why:** globales
  Lieferanten-Skip versteckte echte Befunde (Architect-FAIL 08/2026).
- Unerklärte Restdifferenzen = negative Einzelbuchungen (Gutschriften) des
  Lieferanten auf dem Überschusskonto — separat ausweisen, NIE in den
  kopierbaren Umbuchungs-Text mischen.

**Testfeste Regression (Feldschlösschen 07/2026 Oliv)** in
`waren-analyse.test.ts`: Deltas 4030 −8'915.40 / 4040 +2'192.62 /
4050 +7'736.85 / 4701 +465.00; Restdifferenz Beleg 1068 −2'075.75 separat.
