---
name: MwSt-Netto-Split (konfigurierbar)
description: Netto aus Brutto immer via grossToNet/umsatz-SSOT mit TA-Split; Sätze konfigurierbar über mwst.ts (global, admin-gated).
---

Regel: Netto aus Brutto-Tagesumsätzen NIE mit festem ÷1.081 rechnen — immer
`grossToNet(gross, takeaway)` (personnel.ts) bzw. umsatz.ts-SSOT: TA ÷ (1+TA-Satz),
übriger Umsatz ÷ (1+Standardsatz). Fehlende TA-Daten ⇒ pauschal Standardsatz UND
sichtbar kennzeichnen («ohne TA-Split, … pauschal»), nie stillschweigend.

Sätze sind konfigurierbar: `src/lib/mwst.ts`, KV-Key `mwst_rates_v1` (GLOBAL,
bewusst nicht tenant-präfixiert — CH-Sätze). Modul-Cache mit Defaults 8.1/2.6 %;
`VAT_RATES` in personnel.ts sind Live-Getter darauf.

**Why:** Take Away hat 2.6 % statt 8.1 % — Pauschalrechnung macht Netto zu tief
und WKQ/PKQ zu hoch. Architect-Review-Erkenntnisse: (1) Cache-Mutation triggert
keine React-Re-Renders ⇒ App-Start hinter `MwstRatesGate` (App.tsx) hydrieren,
nach Satz-Änderung Seite neu laden; (2) Settings-Karte muss `isAdmin && !isGuest`
gaten (beaulieu_manager hat Settings-Zugriff, darf globale Sätze nicht ändern);
(3) Persistenz nur via `kvSetStrict` (kvSet schluckt Fehler still).

**How to apply:** Neue Netto-Ableitungen aus Brutto nie hart codieren; gebuchte
FIBU-Netto-Werte (reporting/PLView) nie umrechnen. Beaulieu ohne TA rechnet
datengetrieben automatisch durchgehend Standardsatz. ER-Übernahme
(vj-daily-transfer) trägt `taSplit`/`taDayCount` — UI-Badges bei fehlendem oder
unvollständigem Split.

Für Warenbelege gilt zusätzlich: nie einen Satz aus Gesamt-MwSt ÷ Gesamt-Netto
bilden. Gedruckte Positions-/Zusammenfassungswerte je 0/2.6/8.1 % bleiben als
Satzklassen am Kontosplit erhalten; der skalare Satz gilt nur für echte
Ein-Satz-Belege. Ein gemischter PDF-Beleg ohne prüfbare Satzbasen fällt
geschlossen aus. Positionsdetails dürfen eine gedruckte Zusammenfassung nur
ersetzen, wenn Netto UND MwSt in beiden Richtungen pro Satz decken.

**Why:** Ein mathematischer Mischsatz ist keine buchbare Steuerklasse und
zerstört die Nachvollziehbarkeit; einseitige Prüfungen übersehen zusätzliche
Detailklassen.

**How to apply:** Importspezifische MwSt-Codes nie zwischen Lieferanten
wiederverwenden; Positionen tragen zusätzlich den expliziten Satz. Gedruckte
Zusammenfassungen kennzeichnen ihre Herkunft, damit spätere Kontoänderungen
nicht unbemerkt deren Rundungs-Cents verwerfen.
