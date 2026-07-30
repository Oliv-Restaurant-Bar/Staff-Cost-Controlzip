---
name: Stunden-Stapel Bedarf→Dienstplan→Ist
description: Einheitliche Quelle für Bedarf-/Plan-/Ist-Stunden in Cockpit und Personalbedarf-Wochenübersicht
---

**Regel:** Alle Anzeigen des Stunden-Stapels (Bedarf-Stunden Soll → Dienstplan Plan → Ist MIRUS) nutzen AUSSCHLIESSLICH `src/lib/bedarf-stunden-utils.ts`. Die Cockpit-Zeilen `prod_stunden_plan`/`prod_stunden_ist` (IDs stabil!) beziehen ihre Werte NICHT mehr aus `ladePersonalkostenDaten` (istStdProTag/planStdProTag), sondern aus diesen Helfern; Produktivität nutzt denselben Ist-Wert.

**Semantik:** Bedarf = Profil je Datum (resolveActiveProfileForDate, eventOpen=false wie Wochenübersicht) × nettoSegmentMinutes (ArG-Staffel). Plan = buildPlannedEmployees (ohne Absenzen, ohne secondary-Slots) + nettoMinutesForSlots. Ist = actual_hours OHNE absenceType-Einträge; ohne Datenquelle immer null, nie 0. Δ zum Bedarf: >0 rot, ≤0 grün (deltaInverted im Cockpit).

**Why:** Zwei getrennte Berechnungen (personalkosten.ts vs. Bedarf-Helfer) lieferten unterschiedliche Populationen (FE-only-Ausschluss, isAdditionalCost, manuelle Pausen statt ArG) → Δ-zum-Bedarf war nicht vergleichbar (Review-Fail).

**How to apply:** Neue Flächen mit Plan-/Ist-Stunden gegen Bedarf immer über diese Helfer summieren; personalkosten.ts bleibt SSOT nur für KOSTEN (CHF/PKQ), nicht für die Stunden-Stapel-Anzeige. Vorjahres-Personalkosten (Buchhaltung, Jahre <2026) kommen read-only aus Tabelle `vorjahres_personalkosten` via `loadVorjahresPersonalkosten` (nur Monats-Spalte, keine Wochenverteilung).
