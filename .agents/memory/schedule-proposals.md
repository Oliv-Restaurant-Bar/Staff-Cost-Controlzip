---
name: Dienstplan-Vorschläge aus der Bedarf-Analyse
description: «Offene Punkte»-Workflow (Vorschlag → Bestätigung), Konflikt-Recheck-Pflicht, Entfernen-Schutz
---

Vorschläge aus dem Bedarf-vs-Plan-Zell-Pop-up leben im app_settings-Blob
`schedule_proposals:<tenant>` (src/lib/schedule-proposal-store.ts), Status
open/confirmed/rejected statt Löschen; erst die Bestätigung im Dienstplan
(ScheduleProposalInbox, «Offene Punkte») schreibt echte Einträge — immer über
den tages-atomaren applyDayPatch-Pfad, nie direkt.

**Regeln:**
- Konfliktprüfung ist ZWEISTUFIG: beim Vormerken (Analyse-Seite, Warnung keine
  Sperre) UND erneut bei der Bestätigung gegen den AKTUELLEN scheduleData-Stand.
  Der Stand vom Vormerken ist nie verlässlich.
- Entfernen-Bestätigung löscht den GANZEN Tageseintrag (DaySchedule hat kein
  Positions-/Origin-Feld). Deshalb Pflicht: aktuellen Tageszustand anzeigen,
  bei Absenz oder Split-Tag explizites «Trotzdem entfernen» verlangen, leeren
  Tag ohne Write schliessen. Ein Review-Fail entstand genau hier (stale
  Vorschlag hätte neuere Absenz/2. Schicht gelöscht).
- Herkunft/Audit nur im Vorschlags-Store (resolutionNote), nicht am
  Schedule-Eintrag.
- Slot-Wahl bei Bestätigung: Start < 16:00 → früh, sonst spät; belegter
  Ziel-Slot weicht auf den freien aus; beide belegt → Fehler, Punkt bleibt offen.
