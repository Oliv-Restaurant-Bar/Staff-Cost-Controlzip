---
name: Split-Zellen primary/secondary-Vertauschung
description: Leere Dienstplan-Zellen rendern primarySlot='spät' — per-Slot-Payloads im Zell-Popover müssen nach chronologischer Zeile routen, nicht nach primary/secondary.
---

**Regel:** In den Dienstplan-Grids ist `primarySlot='spät'`, sobald der früh-Slot leer ist — also bei JEDER leeren Zelle. Alles, was das Zellen-Popover pro Slot committet (Pausen, Flags), muss der chronologischen Zeile folgen (Row 1 → früh-Slot, Row 2 → spät-Slot) und darf nie am primary/secondary-Mapping hängen.

**Why:** Beim Pro-Einsatz-Pausen-Feature wurden die Pausen zuerst dem primary/secondary-Callback zugeordnet → im Standardfall „leere Zelle → Split-Schicht anlegen" landeten sie kreuzweise vertauscht (früh=30/spät=0 statt umgekehrt). Das Tagestotal stimmte zufällig trotzdem (Summe gleich), erst der Slot-Kosten-Split und das Wiederöffnen der Zelle zeigten den Fehler — Totale-Assertions allein reichen als Test nicht.

**How to apply:** Bei jedem neuen per-Slot-Attribut im Zeit-Popover beide Branches (`slotType==='früh'` UND `'spät'`) prüfen; im spät-Branch gehen Row-1-Werte an den secondary-Callback (→ früh). Verifikation: Zelle nach dem Speichern WIEDERÖFFNEN und die Zuordnung prüfen, nicht nur Summen. Deterministisch abgesichert im Komponententest `TimeInputCell.break-routing.test.tsx`.
