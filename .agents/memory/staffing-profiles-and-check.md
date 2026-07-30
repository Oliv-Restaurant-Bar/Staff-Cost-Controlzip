---
name: Personalbedarf-Profile & Dienstplan-Prüfung
description: Architektur der Profil-Config (app_settings), CdS-Regel, 3-Dimensionen-Ampel, Lock-Durchsetzung
---

- Profile («Standard»/«Winter/UG»/custom) leben NICHT als Schema — season-Schlüssel in `staffing_requirements` + Config-Blob `staffing_profiles:<tenantId>` in app_settings (normalize beim Laden erzwingt standard+winter immer vorhanden). Pure Logik: `staffing-profiles-utils.ts`; Prüf-Logik (ArG-Pausenstaffel 15/30/60 ab 5.5/7/9 h, Split = Summe je Segment, CdS-Regel, 3-Dimensionen-Ampel): `staffing-check-utils.ts` — beide pur + node-Tests.
- **Why:** kein Schema-Change, mandantensicher über Key-Präfix, Defaults im Code (Oliv: CdS ['2','103','105'], Umsatzbudget Mo 5000…So 7000).
- **How to apply:** «Festsetzen»-Lock muss im SAVE-PfAD geprüft werden (frisch aus DB), nicht nur UI-readOnly. SchedulePlanner-Auto-Profil: einmal PRO MANDANT via Ref auf tenantId, sonst stale nach Tenant-Wechsel. Dienstplan-Key-Parsing: Datum = letzte 10 Zeichen (Employee-IDs enthalten Bindestriche/UUIDs).
- Beaulieu-Standard-Vorschlag = read-only Karte aus Juni/Juli-PLAN-Zeiten (Dienstplan-Slots, NIE Ist/MIRUS); schreibt nichts.
- **Winter/UG ist ABGELEITET, keine eigenen Zeilen:** Profil hat `baseKey:'standard'`; effektiver Bedarf IMMER via `buildEffectiveRequirements` (Standard-Zeilen umgeschlüsselt + additiver UG-Zuschlag auf die späteste Schicht, sonst synthetische Abendzeile). Zuschlag greift im Winter Fr/Sa ODER ganzjährig per Tages-Flag `ug_event_days:<tenant>` (app_settings). Konsumenten dürfen NIE rohe requirements für abgeleitete Profile lesen (Doppelzählung/Null-Bedarf); Personalbedarf-Editor ist für abgeleitete Profile read-only inkl. Save-Guard. Keine season='winter'-Zeilen mehr in der DB säen.
- Dynamische Personen-Regeln (CdS, Gastgeber nur Do/Fr/Sa, Kalte Küche/Sushi) leben als Config auf StaffingProfilesConfig + reine compute*-Checks; Regel-Verstösse = GELB in der Abdeckung, nur unbesetzte Soll-Schichten = ROT. Jede neue Regel muss in BEIDEN Anzeigen (StaffingComparisonPanel UND StaffingDayCheck) gerendert werden, sonst widerspricht die Erfolgszeile der Ampel.
- Beaulieu-Katalog: «Abwasch» existiert ZWEIMAL — Küche `abwasch` (Spüle/Abwasch) vs. Service `abwasch_service` (Abwasch); nie verwechseln. CdS-Priorität Beaulieu default: Krebs b-200 > Redzepi b-161 > Joana b-220 (im Code-Default, kein Blob nötig). Alte Positionen (Sushi/Pizza/Bar oben/unten …) sind DEAKTIVIERT, nicht gelöscht.
- Optimistische Mehrfach-Toggles (Event-Flag): Schreibzugriffe über Single-Flight-Queue + Revisionszähler serialisieren — veraltete Revisionen überspringen, bei Fehler des letzten Stands DB-Wahrheit neu laden. Closure-Stand in toggle() ist ein Race.

## Ist-Zählregel (seit Juli 2026)
Alle Ist-Zahlen (Panel, DayCheck-counts, Dienstplan-Badges) laufen über
`assignPlannedToShifts`: jeder EINSATZ (Slot) zählt genau in EINEM Soll-Block
(grösste Überlappung; Priorität Regel > Haupt > Zweit > Legacy-Alias, Aliasse
in `LEGACY_POSITION_ALIASES`, z.B. bar ↔ bar_buffet_springer). Getrennte
Früh+Spät-Slots dürfen zwei Blöcke füllen. Dynamische Regeln kommen als
`preferredKeysById` via `dynamicPositionOverrides(cds, cold)` herein — jeder
neue Aufrufer von computeStaffingComparison/…DayStaffingSummary muss sie
mitgeben, sonst weichen die Zahlen vom Panel ab. **Nie** zu countPlanned je
Zeile zurückkehren (Mehrfachzählung war der ursprüngliche Bug).
Personalbedarf-Seite: Standard-Ansicht «Ganze Woche» (staffing-week-utils,
Mittag/Abend-Grenze 16:00); Editor nur in der Tagesansicht.
