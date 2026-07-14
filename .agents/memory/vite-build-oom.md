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

This passes (~1478 tests, ~85 s). The former "1 error" (`libuuid.so.1` DLOPEN from
`node_modules/canvas`) was caused by a test file WITHOUT a `@vitest-environment`
directive falling back to jsdom (which loads native canvas). Fixed 2026-07 by adding
`// @vitest-environment node` — if the error reappears, look for a NEW test file
missing the directive on line 1, not for an env problem.

**Caveat (2026-07):** even the serial full-suite command above is OOM-killed when the
Vite dev server workflow is running (it holds a big chunk of container RAM). Even TWO
test files in one invocation can die then. Options: run the suite while the workflow is
stopped, or run affected files ONE per invocation — both work reliably.

**Reliable chunked full-suite recipe (2026-07, 70 files/1557 tests):** list all test
files into a text file, `split -l 9` into chunks, then per chunk:

    NODE_OPTIONS=--max-old-space-size=4096 npx vitest run --silent=true --maxWorkers=2 <files>

All 8 chunks pass even with the dev workflow running. Flag gotcha: use `--silent=true`
— a bare `--silent` before the file list swallows the next path as the flag's value and
silently skips that test file.

## `tsc --noEmit` itself now OOMs too (2026-07)
`npx tsc -p tsconfig.app.json --noEmit` is OOM-killed silently (exit -1, no output)
even with `NODE_OPTIONS=--max-old-space-size=12288` while the dev workflow runs —
**when output goes to the terminal**. Redirecting to a file makes it complete:

    NODE_OPTIONS=--max-old-space-size=12288 npx tsc -p tsconfig.app.json --noEmit > /tmp/tsc-out.txt 2>&1

exits 2 with ~338 pre-existing legacy errors — grep the file for YOUR touched files
only. If even the redirect run dies, fall back to workspace LSP diagnostics
(`getLatestLspDiagnostics` in code_execution) as the type gate. Batched `vitest run`
of the affected files (`--pool=forks --maxWorkers=1`) still works fine for ~12 files
per invocation.
