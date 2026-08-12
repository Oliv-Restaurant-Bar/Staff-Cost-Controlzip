---
name: Warenrechnungen Wochen-Granularität
description: Regeln für die Monat↔Woche-Periodensicht auf der Warenrechnungen-Seite (KPI, FIBU, Nachbarmonat)
---

**Regeln:**
- Die Periodensicht ist rein ABGELEITET: `viewEntries`/`viewRevenueByDate`-Memos filtern auf die Woche; der `entries`-State bleibt IMMER der volle geladene Monat. Schreibpfade (saveMonth, setEntries, Übernahme) dürfen nie auf der gefilterten Basis arbeiten — sonst Datenverlust beim Speichern.
- Wochen über der Monatsgrenze: Nachbarmonat wird separat nachgeladen (`wocheExtra`); der Cache MUSS mit `tenantId|monatsKey` verschlüsselt und beim Dep-Wechsel sofort geleert werden, sonst kurzzeitig Fremdmandanten-Daten sichtbar.
- FIBU-Abgleich in Wochenansicht = reine Anzeige: beide Seiten (Rechnungen UND Journal) konsistent auf Woche∩Monat filtern, `buchhaltungTotal=null` (ER-Total ist monatlich), Erklärt-Markierungen/Übernahme-Kandidaten/Match-Mutationen gesperrt (`persistFibuStateView`-Wächter) — Markierungen gelten pro MONAT und würden sonst Wochen-Differenzen persistieren.
- Lieferanten-«Ohne Einträge»: Eintrags-Namen (aus Importen) ≠ Stammdaten-Namen («Paul Ullrich AG» vs «Paul Ulrich», «Barausgaben Lidl» vs «LIDL»). Zuordnung tolerant über normalizeSupplierKey + Alias-Resolver + Token-Match (≥4 Zeichen, Stopwörter gmbh/barausgaben) — nie exakter Namensvergleich.

**Why:** 08/2026 KPI-Popup-Auftrag: exakter Vergleich meldete 16 von 22 Lieferanten fälschlich als «ohne Einträge»; Architect-Review fand Mandanten-Leak im Nachbarmonats-Cache und Monats-Mutationen aus der Wochenbasis.

**How to apply:** Bei jeder weiteren Perioden-/Granularitäts-Erweiterung dieser Seite (oder analoger Seiten) zuerst prüfen, welche Memos Lese-Sicht und welche Pfade Schreib-Basis sind.
