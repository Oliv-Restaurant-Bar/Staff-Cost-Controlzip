---
name: Vitest full-run OOM & singleFork pollution
description: How to run the full test suite when memory is tight, and why singleFork produces false failures.
---

**Rule:** A plain `npx vitest run` (all ~70 files) can be OOM-killed (exit -1, NO output) while the dev workflow is running. Run in chunks instead (e.g. `src/lib` then `src/components src/pages src/test`).

**Why:** The container has ~8 GB total; the dev server + parallel vitest workers exceed it. OOM kills are silent — easy to mistake for a hung run.

**How to apply:**
- Chunked runs with `--pool=forks --poolOptions.forks.singleFork=true` fit in memory, BUT singleFork disables per-file isolation → cross-suite pollution (localStorage/mocks leak) produces FALSE failures (seen: DataImportsTab, AdyenDayTable, page-gate suites failing only in singleFork).
- Before treating such failures as real, re-run the failing suites isolated with the default pool — if they pass there, it's a singleFork artifact.
- Also: don't run `tsc` and vitest in parallel — together they OOM even when each alone fits.
