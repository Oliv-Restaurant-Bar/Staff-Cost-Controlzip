---
name: vite build OOM (silent kill)
description: Why `npm run build` exits with no output here and how to make it succeed.
---

`npm run build` (`vite build && cp …`) can exit with code -1 and **zero output** — no
error, no stack — when the Node process is OOM-killed during the Rollup/minify step.
It looks like the command "did nothing", which is misleading.

**Why:** This is a large SPA (single ~8 MB main chunk). Default Node heap isn't enough
in this container, so the build is killed before Vite prints anything.

**How to apply:** When a build returns empty/-1 with no log, it's almost certainly OOM,
not a compile error (run `npx tsc --noEmit` to confirm types are fine). Rerun with a
raised heap. As the bundle has grown, 4096 is now **also** OOM-killed silently in this
~8 MB-chunk SPA — use 8192:

    NODE_OPTIONS=--max-old-space-size=8192 npx vite build

(Container has ~8 GB total; 8192 succeeds with ~2 GB free. If even that is killed,
check `free -m` first — another process may be holding memory.)

A successful build prints the usual chunk-size table and benign "dynamically imported
but also statically imported" / ">500 kB chunk" warnings — those are pre-existing, not
caused by your change.

## Full `vitest run` (whole suite) OOMs the same silent way
The full `npx vitest run` (all ~47 files) is ALSO OOM-killed silently — exit code -1,
**zero output** — because vitest's default multi-fork/thread parallelism spins up many
workers at once in this container. A single test file (`vitest run path/to/file`) runs
fine; only the full suite dies.

**How to apply:** run the full suite serially with a raised heap:

    NODE_OPTIONS=--max-old-space-size=6144 npx vitest run --no-file-parallelism --pool=forks

This passes (~727 tests, ~45 s). There is ONE pre-existing unrelated unhandled error:
`libuuid.so.1: cannot open shared object file` from `node_modules/canvas` — it's an env
issue, counts as "1 error" but does not fail tests; ignore it.

**Caveat (2026-07):** even the serial full-suite command above is OOM-killed when the
Vite dev server workflow is running (it holds a big chunk of container RAM). Even TWO
test files in one invocation can die then. Options: run the suite while the workflow is
stopped, or run affected files ONE per invocation — both work reliably.
