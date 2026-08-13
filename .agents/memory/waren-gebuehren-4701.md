---
name: Gebühren/Konditionen → immer 4701
description: Zwangs-Regel für VEG/VRG, Recycl.-Geb., Logistikpauschale, Zu-/Abschläge; gilt in ALLEN Kontierungspfaden inkl. ZSF-Summenpfad
---

- Gebühren-Zeilen (VEG/VRG, recycl*, Logistikpauschale, Zu-/Abschläge, «…gebühr» nur am TOKEN-ENDE) laufen IMMER auf 4701 — vor gelernter Artikel-Zuordnung und Warengruppen-Tabelle; Pfand-Regel (4800) hat Vorrang (Depotgebühr bleibt Pfand).
- **Why:** FGG routet VEG in Parser und «Zusammenfassung MwSt.» je Satz in Warenkategorien (2.6 %→alkoholfrei, 8.1 %→Spirituosen) — ohne Zwangs-Regel landen Gebühren in WKQ-Konten 4020–4070. User-Entscheid 08/2026: konsequent, auch Kleinstbeträge.
- **How to apply:** Eine neue Kontierungs-Route ist erst fertig, wenn die Zwangs-Regel dort greift. Achtung SUMMENPFADE: der ZSF-Split bucketiert Kategorien-Totale — Gebühren-Positionen müssen je Kategorie+Satz aus dem Bucket herausgerechnet werden (Positionen an kontoSplitsAusFsKategorien übergeben). Nicht abstimmbare Gebühren (gebuehrenRest>0) NIE still übernehmen → sichtbarer Hinweis + Fallback auf Positions-Kontierung.
- «gebühr»-Token nur am Wortende matchen — «Gebührenfrei…»-Produktnamen sind sonst Falsch-Positive, die der Post-Pass dauerhaft festschreibt.
