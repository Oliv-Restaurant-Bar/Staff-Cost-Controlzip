---
name: kueche_manager-Dashboard-Zugriff ist gewollt (Matrix-Kommentar veraltet)
description: Der Kommentar-Block in usePermissions widerspricht dem Code — Dashboard-Zugriff für Manager-Rollen und canSeePersonnelCostTotals für alle sind bewusstes Bestandsverhalten.
---

**Regel:** `canAccessModule('dashboard')` erlaubt service_manager/kueche_manager bewusst (Manager behalten ihr Soll/Ist-Kosten-Dashboard), und `canSeePersonnelCostTotals` ist absichtlich für ALLE Rollen true (aggregierte Abteilungskosten, keine Einzellöhne). Der Kommentar-Matrix-Block oben in usePermissions («Dashboard: kueche_mgr –») ist VERALTET und widerspricht dem Code — nicht dem Kommentar folgen und das Gate verengen.

**Why:** Ein E2E-Lauf meldete «kueche_manager sieht CHF-Kostenkarten» als vermeintliche Regression. Analyse + Architect-Review bestätigten: gewolltes Bestandsverhalten (Rollen-Doku: Küchen-Manager = Dienstplanung Küche + Soll/Ist-Analyse); verboten sind nur Einzellöhne/PII/Umsätze/Finanzbereich — die fehlen dort korrekt. Gates nie ungefragt verengen oder verbreitern (siehe overloaded-permission-flag).

**How to apply:** Bei Rollen-E2E-Plänen für Manager-Rollen erwarten: Dashboard MIT aggregierten Personalkosten der eigenen Abteilung, OHNE financial-month-section/Umsätze/Löhne. Bei Doku-Arbeit: Kommentar-Matrix in usePermissions gegen den Code abgleichen statt blind zu übernehmen.
