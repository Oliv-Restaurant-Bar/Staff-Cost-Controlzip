---
name: Bare tsc --noEmit is vacuous
description: Root tsconfig is solution-style (files:[] + references) — plain `npx tsc --noEmit` checks NOTHING and exits 0; how to type-check for real.
---

**Rule:** In this repo, `npx tsc --noEmit` (root) is a vacuous check — the root `tsconfig.json` has `"files": []` plus project references, so plain tsc type-checks zero files and always exits 0. Real check: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.app.json` (redirect output to a file; piping through grep got the process OOM-killed once).

**Why:** A wrong-module import (`useAuth` from the context file instead of the hook) shipped with "tsc green" and only surfaced as a runtime SyntaxError in the browser console.

**How to apply:** Use `-p tsconfig.app.json` as the gate. Note the full app currently has ~700 lines of PRE-EXISTING errors in legacy files — don't treat them as regressions; filter output for the files you touched (`grep -Ei '<your-files>' /tmp/tsc_out.txt`) and require zero matches there.
