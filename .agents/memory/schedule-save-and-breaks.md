---
name: Dienstplan — Save-Queue & Pausen-Details
description: Race-Lehren zum tages-atomaren Speichern (Save-Queue) und zur Pause pro Einsatz im Dienstplan. Kurzfassung in replit.md §5 Personal.
---

## Tages-atomares Speichern (Save-Queue)
- Jede Zelländerung schreibt den GANZEN Tag (beide Slots) über eine serialisierte Save-Queue: pro Zelle max. 1 in-flight Save, last-writer-wins-Koaleszenz.
- **Why:** Einzelslot-Upserts verlieren bei Netz-Races die 2. Schicht (real aufgetretener Datenverlust) — der Payload muss immer der komplette Tageszustand sein.
- Header-Speicherstatus grün erst NACH Backend-Ack; rot mit Retry-Button bei Fehler. Perioden-Navigation warnt bei ungespeicherten/fehlgeschlagenen Saves (Flush bzw. «Trotzdem wechseln»).

## Pause pro Einsatz
- `DaySchedule.fruehBreakMinutes`/`spaetBreakMinutes`; je Einsatz Radio 0/30/60 im Zeit-Popover (2. Gruppe nur bei Split-Schicht, auch für frisch eingetippte Zeiten).
- Netto-Stunden NUR über die zentralen `useShiftConfig`-Funktionen (SSoT): `calculateNetShiftHours` (je Einsatz auf 0 geclampt, `null` bei ungültiger Zeit), `calculateDayNetHours`, `calculateDaySlotNetHours` (Slot-Split für Kosten).
- Manuell gesetzte Einsatz-Pausen ERSETZEN die Automatik (>9 h → 30 Min) vollständig; Legacy-Tagespause `breakMinutes` nur Lese-Fallback. Gilt für ALLE Plan-/Ist-/Kosten-/Controlling-Totale und Dienstplan-Exporte (netto; Pause nie auf Absenzstunden). Ist-Erfassung im Zeiten-Modus speichert netto («X.X h − N Min Pause»).
- **Race-Lehre:** Die Pause des 2. Einsatzes muss auf dem Split-Zeit-Commit MITREITEN (`onSplitTimeSelect(slot, breakMinutes)`) — nie über separaten Close-Flush, sonst verlieren veraltete Props sie bei Neuanlage. Pausen folgen den ZEITEN (Row 1 → früh, Row 2 → spät), auch im vertauschten Fall leerer Zellen (`primarySlot='spät'`) — sonst kreuzweise Zuordnung.
