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
