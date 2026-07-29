---
name: Foratable Res.Nr. je Restaurant
description: Res.Nr. (external_reservation_id) ist NUR pro Restaurant eindeutig — Kollisionen zwischen oliv/beaulieu sind normal, keine Duplikate.
---

Foratable vergibt Reservationsnummern **pro Restaurant**, nicht global. Gleiche
`external_reservation_id` unter `oliv` UND `beaulieu` sind daher völlig
verschiedene Reservationen (anderes Datum, andere Gäste, anderer Pax).

**Why:** Juli 2026 wurde eine «Bereinigung von 9'564 Doppel-Res.Nr.» verlangt;
die Analyse zeigte 9'564 Paare mit 0 identischen Kern-Feldern und 100%
abweichendem `restaurant_name` — es gab NICHTS zu bereinigen. `restaurant_name`
stammt je Zeile aus der CSV-Spalte «Restaurant» und war 100% konsistent zum
`restaurant_id`.

**How to apply:** Duplikat-/Konsistenz-Checks für Reservationen IMMER auf
`(restaurant_id, external_reservation_id)` beziehen; Cross-Tenant-Gleichheit
der Res.Nr. ist KEIN Indiz für Fehlimporte. Zuordnungs-Kontrolle: Abgleich
`restaurant_name` ↔ `restaurant_id` (Mapping: enthält «beaulieu»→beaulieu,
sonst «oliv»→oliv). Backup-Kopie existiert: `reservation_records_backup_20260729`.
