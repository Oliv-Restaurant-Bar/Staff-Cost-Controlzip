---
name: Stunden-Stapel Bedarf→Dienstplan→Ist
description: Einheitliche Quelle für Bedarf-/Plan-/Ist-Stunden in Cockpit und Personalbedarf-Wochenübersicht
---

**Regel:** Alle Anzeigen des Stunden-Stapels (Bedarf-Stunden Soll → Dienstplan Plan → Ist MIRUS) nutzen AUSSCHLIESSLICH `src/lib/bedarf-stunden-utils.ts`. Die Cockpit-Zeilen `prod_stunden_plan`/`prod_stunden_ist` (IDs stabil!) beziehen ihre Werte NICHT mehr aus `ladePersonalkostenDaten` (istStdProTag/planStdProTag), sondern aus diesen Helfern; Produktivität nutzt denselben Ist-Wert.

**Semantik:** Bedarf = Profil je Datum (resolveActiveProfileForDate, eventOpen=false wie Wochenübersicht) × nettoSegmentMinutes (ArG-Staffel). Plan = buildPlannedEmployees (ohne Absenzen, ohne secondary-Slots) + nettoMinutesForSlots. Ist = actual_hours OHNE absenceType-Einträge; ohne Datenquelle immer null, nie 0. Δ zum Bedarf: >0 rot, ≤0 grün (deltaInverted im Cockpit).

**Why:** Zwei getrennte Berechnungen (personalkosten.ts vs. Bedarf-Helfer) lieferten unterschiedliche Populationen (FE-only-Ausschluss, isAdditionalCost, manuelle Pausen statt ArG) → Δ-zum-Bedarf war nicht vergleichbar (Review-Fail).

**How to apply:** Neue Flächen mit Plan-/Ist-Stunden gegen Bedarf immer über diese Helfer summieren; personalkosten.ts bleibt SSOT nur für KOSTEN (CHF/PKQ), nicht für die Stunden-Stapel-Anzeige. Vorjahres-Personalkosten (Buchhaltung, Jahre <2026) kommen read-only aus Tabelle `vorjahres_personalkosten` via `loadVorjahresPersonalkosten` (nur Monats-Spalte, keine Wochenverteilung).

## Absenz-Stunden im Ist-Grid (08/2026, aktualisiert)
- ÜBERHOLT durch «Absenz-Anrechnung (final, Fix/Flex)» unten: Kredit-Codes sind ANGERECHNETE Stunden (eigene Farbzeile je Code) — bei Fix-MA K/U/FE/FT, bei Flex nur K/U; F, unbekannte Codes und Flex-FE/FT bleiben reine violette Info. Anzeige-Klassierung muss datumsgenau derselben Phasen-Auflösung folgen wie die Rechnung.
- Weiterhin gültig: Plan-Basis nimmt die geplanten Zeiten AUCH bei Plan-Absenzmarke; keine Plan-Basis → leer, nie geraten; Produktivität bleibt IMMER rein MIRUS.
- Summen- und Zellen-Anzeige MÜSSEN dieselbe Wache nutzen (canonicalAbsenceCode + hours===0), sonst divergieren Zelle und Summe bei Bestandsdaten.



## Absenz-Anrechnung (Spec 08/2026 final, Fix/Flex)
Regel: OHNE MIRUS-Ist (hours exakt 0) zählen Plan-Netto-Stunden als «angerechnete Stunden» (Pensum/Soll-Ist, Überstunden-Gutschrift, Personalkosten): **K/U für Fix UND Flex; FE/FT NUR für Fix-MA (Monatslohn)** — bei Flex/Stundenlohn sind FE/FT komplett 0 (keine Stunden, keine Kosten, kein «Ist fehlt»). F immer 0. MIRUS>0 überschreibt jeden Code. Produktivität = IMMER nur echte MIRUS-Arbeit.
**Wichtig:** Fix/Flex je Monat über den wage-history-Phasenresolver bestimmen (Split-Monate datumsgenau je Phase), nie nur Stammsatz. EIN SSOT-Kredit-Pfad (Plan-Netto aus den stehen bleibenden Zeiten der Absenzzelle); plan_sync schreibt Kredit-Codes mit hours:0 (Alt-Einträge normalisiert, Ist-Locks respektiert); Codes immer kanonisieren (Legacy «krank»/«ferien»/«feiertag»/«frei»). Doppelzählungs-Falle: Kosten-/Forecast-Pfade dürfen für kanonische Codes NIE konfigurierte Pauschal-Stunden zusätzlich zu Zellzeiten addieren; Flex-Pfade müssen FE/FT/F-Einsätze ganz herausfiltern. 80%-Versicherungsblock bleibt NUR K/U. Überstunden-Konto ist Fix-only; Gutschrift = Tages-Soll, gedeckelt auf Saldo 0 (inkl. Feiertag).
