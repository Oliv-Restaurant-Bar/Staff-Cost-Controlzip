---
name: Dienstplan tages-atomare Saves + Save-Queue
description: Warum Dienstplan-Zellen nie als Einzelslot-Upserts gespeichert werden dürfen und wie Queue-Koaleszenz sicher bleibt.
---

# Regel
Dienstplan-Schreibpfade speichern immer den GANZEN Tag (beide Slots früh/spät als eine Payload) über eine pro Zellen-Schlüssel serialisierte Save-Queue — nie zwei getrennte Einzelslot-Upserts.

**Why:** Zwei schnell aufeinanderfolgende Upserts derselben Zelle (Split-Schicht: früh dann spät) racen auf Netzwerkebene; der ältere kann NACH dem neueren landen und dessen Slot überschreiben → reproduzierbarer 2.-Schicht-Verlust. Async-State (useState) ist beim zweiten Aufruf noch stale — deshalb synchroner Ref-Spiegel (scheduleDataRef) als Lesequelle.

**How to apply:**
- Jede neue Callsite (Clipboard, Multi-Plan, Dialoge, Embedded-Planner) muss durch den tages-atomaren Patch-Pfad laufen, nicht direkt Slot-weise upserten.
- Queue-Koaleszenz (last-writer-wins) ist NUR sicher, weil jede Payload der komplette Tageszustand ist — bei Teil-Payloads würde Verwerfen von Zwischenständen Daten verlieren.
- Speicherstatus „gespeichert" erst nach Backend-Ack (lastSavedAt aus der Queue), nie beim Enqueue.
- Bekannte Restlücke: EmbeddedSchedulePlanner/DepartmentSchedule schreiben ohne Queue (Ref-Fix deckt Tages-Atomarität, nicht Netz-Reihenfolge).
