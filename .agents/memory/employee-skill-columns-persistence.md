---
name: Employee station/skill columns persistence
description: primary_station/secondary_stations are written separately from employeeToDb, with a presence guard to avoid clobbering.
---
`primaryStation`/`secondaryStations` (Position keys) are deliberately NOT part of `employeeToDb`; they are written by a separate best-effort UPDATE after the main employee upsert. Missing-column errors are swallowed (the positions migration may be unrun); ANY other error must THROW so `upsertEmployee` returns false (no silent masking of a failed persist).

**Rule:** the station UPDATE must only touch a column when the field is PRESENT on the object (`'primaryStation' in emp`), never write `value ?? null` unconditionally.
**Why:** call sites that build an Employee literal without these optional fields would otherwise clear existing skills — the same undefined→null clobber class as the ali-reactivation incident. `dbToEmployee` always sets the keys, so loaded→saved employees still persist (and can intentionally clear) their stations.
**How to apply:** any time you add a separate best-effort column writer for an optional employee field.
