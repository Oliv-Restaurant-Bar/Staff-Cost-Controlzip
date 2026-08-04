---
name: Deletions in merge-on-save KV blobs need tombstones
description: Any blob persisted via union-merge (newest updatedAt wins per key/id) resurrects hard-deleted keys from the remote KV — deletions must be tombstones
---

Settings-infra blobs (localStorage primary + Supabase KV backup) are saved via
merge-on-save: before writing, the remote KV state is re-read and UNION-merged
per key/id with newest `updatedAt` winning. This protects against stale devices
overwriting each other — but it means **hard-deleting a key is a bug**: the
deleted key has no local entry, so the remote (older, still-live) entry wins
the union and the deletion silently resurrects on the next save/load.

**Rule:** every "remove" mutation in such a blob must write a tombstone
(`deleted?: true` + fresh `updatedAt`) instead of `delete obj[key]`, and every
reader must filter `deleted` entries. Re-setting a value strips the flag
(reactivation). Keep anchored fields (e.g. first-original values) on the
tombstone so re-corrections stay consistent.

**Why:** The Tagesabschluss import-conflict feature's core action ("übernehmen"
= remove manual override) was fully undone by the KV merge whenever the backup
was reachable — deletions only "worked" offline. Same class of bug applies to
any namespace merged per key: check ALL remove paths of a blob, not just the
one you're building (day-closure records already used status-flag-instead-of-
delete for exactly this reason).

**How to apply:** when adding a delete/clear mutation to a blob saved through
a `merge*Blobs` union, grep the merge function for that namespace; if it unions
per key/id, use a tombstone + reader filters + a merge-resurrection test
(local tombstone newer vs remote live entry must stay deleted after merge).

## Adyen-Abstimmung (adyenAbstimmung_v1) folgt demselben Muster (2026-08)
Blob-Saves auf geteilten KV-Keys brauchen merge-on-save (strict read → jüngster Stand je Key gewinnt → write; bei Read-Fehler KV-Write überspringen + Retry mit Save-Snapshot). Jeder Lösch-Pfad (Override entfernen, Kommentar leeren, Bestätigung widerrufen) schreibt einen Tombstone, ALLE Leser filtern `deleted` — auch read-only-Konsumenten wie Coverage-Berechnungen müssen lokal+remote MERGEN statt naiv zu vereinigen, sonst überstimmt ein altes Remote-`confirmed:true` einen jüngeren Widerruf.
