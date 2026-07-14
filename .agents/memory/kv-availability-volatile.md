---
name: KV-Verfügbarkeits-Cache flüchtig
description: Supabase-Availability darf nie dauerhaft gecacht werden; Klassifikation Netzwerk vs. echter DB-Fehler
---

# Supabase-Verfügbarkeit ist flüchtig

**Regel:** `_available === true` gilt nur bis zum nächsten Netzwerk-/Timeout-Fehler; jeder KV-Pfad (get/set/strict/safe-Upserts) meldet Erfolg (`markKVSuccess`) bzw. klassifizierten Fehler (`markKVFailure`). `unavailable` nur 30 s Negativ-Fenster, danach Re-Check.

**Why:** Vorher wurde «verfügbar» beim ersten Erfolg dauerhaft eingefroren — ein späterer Netzwerkausfall wurde nie erkannt, Backups scheiterten still bzw. mit falscher Fehlerklasse.

**How to apply:**
- Klassifikation NUR über `isKvUnavailable` (supabase-kv): Netzwerk/Timeout/DNS/abort/`supabaseUrl is required`/`navigator.onLine===false` → Fall A (offline). RLS/Constraint/`statement timeout`/`canceling statement` → Fall B (echter DB-Fehler, Verfügbarkeit bleibt).
- Die Verfügbarkeits-Probe klassifiziert ebenfalls: RLS-Fehler in der Probe = erreichbar.
- Test-Mocks, die «offline» simulieren, MÜSSEN echte Netzwerkfehlermeldungen verwenden (z. B. `Failed to fetch`) — generische Meldungen wie `probe fail` gelten als Fall B.
- Retry-Aktionen in `notifyKVBackupProblem` lesen den lokalen Stand FRISCH aus localStorage (Key zur Save-Zeit gebunden → tenant-sicher), nie eingefrorene Snapshots.
- schedule-publish-store umgeht den Cache bewusst (öffentliche anon-Seite mit eigenem Timeout) — dokumentierte Ausnahme, nicht «reparieren».
