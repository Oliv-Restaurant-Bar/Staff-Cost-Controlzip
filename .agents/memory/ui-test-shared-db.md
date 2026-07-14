---
name: UI-Tests auf geteilter Dev-DB (Dienstplan)
description: Test-Agenten editieren sonst echte Plandaten — leere Zellen nur in Zukunftswochen suchen, Aufräumen zwingend verifizieren.
---

**Regel:** UI-Tests, die Dienstplan-Zellen anlegen, müssen per Periodennavigation 2+ Wochen in die ZUKUNFT blättern und dort eine wirklich leere Zelle nutzen; gefüllte Zellen nie anfassen; Aufräumen (Zelle leeren + Zeilen-Total zurück auf Ausgangswert) als eigener Verify-Schritt.

**Why:** Ein Testlauf in der aktuellen Woche fand keine leere Zelle, editierte einen echten bestehenden Eintrag und meldete einen falschen Fehlschlag (Total stieg erwartungsgemäss nicht). Frühere Läufe hinterliessen zudem Test-Reste in `schedule_entries`, die manuell per Supabase gelöscht werden mussten.

**How to apply:** In den Testplan explizit schreiben: „NIE gefüllte Zellen bearbeiten", Vorblättern in Zukunftswochen, Abbruch statt Ausweichen auf echte Daten, Cleanup-Verify. Test-Konto nach Admin-Läufen wieder auf eine schwache Rolle (z. B. kueche_manager) herabstufen.
