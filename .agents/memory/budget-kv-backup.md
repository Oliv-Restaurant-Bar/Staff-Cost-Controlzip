---
name: budget_v1 KV-Backup Merge-Regeln
description: Sicherer read→merge→write-Pfad für Budget-Blobs; kvGetStrict für Merge-Basen; bekannte Grenze fehlender Tombstones.
---

# budget_v1 KV-Backup (saveAll → backupBudgetsToKV)

**Regel:** Budget-Blobs (`budget_v1`, `beaulieu:budget_v1`) dürfen NIE per naivem `kvSet(storeKey, data)` nach Supabase geschrieben werden. `saveAll` verlangt einen Aktions-Kontext `{ year, deleted? }`; ohne ihn wird das KV-Backup bewusst übersprungen (Warnung), nie naiv ersetzt.

**Merge-Regeln:** Zieljahr der Aktion gewinnt lokal (bzw. wird bei `deleted` explizit entfernt — kein Union-Resurrect der eigenen Aktion); Fremdjahre per `updatedAt`-Vergleich (neuer gewinnt, Gleichstand → lokal); einseitig vorhandene Jahre bleiben erhalten. Backups laufen über eine serialisierte Promise-Queue mit Deep-Snapshot (`flushBudgetKVBackups()` für Tests).

**Why:** Der frühere Voll-Replace löschte remote gespeicherte Budgetjahre, sobald localStorage stale war (frischer Browser/anderes Gerät) — Klasse „naiver Blob-Write" wie beim Reporting.

**kvGetStrict für Merge-Basen:** `kvGet` liefert bei Lesefehler `null` — ununterscheidbar von «leer». Jeder Merge-Schreibpfad, der den Remote-Stand als Basis braucht, muss `kvGetStrict` nutzen (wirft bei Fehler ⇒ Backup bricht sichtbar ab, localStorage bleibt Primärspeicher).

**Bekannte Grenzen (bewusst, im Backlog):**
- Keine Jahr-Tombstones: Ein auf Gerät A gelöschtes Budgetjahr kann von Gerät B mit stale localStorage beim nächsten Save wiederbelebt werden.
- Auto-Seed-Restrisiko: Frischer Browser vor Abschluss des Supabase-Syncs seedet 2026 und überschreibt per Zieljahr-Regel remote editierte 2026-Werte (vorher: ganzer Blob zerstört — jetzt nur das eine Jahr).

**How to apply:** Bei jedem neuen Schreibpfad auf Budget-/Reporting-Blobs zuerst prüfen, ob er über die sicheren Merge-Funktionen läuft; `kvSetStrict`/`kvGetStrict` statt still-schluckender Varianten für Finanzdaten.
