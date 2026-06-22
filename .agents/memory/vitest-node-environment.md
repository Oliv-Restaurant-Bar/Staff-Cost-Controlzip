---
name: vitest node environment for pure-logic tests
description: Why pure-logic vitest files must declare the node environment, or they crash on canvas/libuuid in this container.
---

# Pure-logic vitest files must use the node environment

Every pure-logic test file under `src/lib/__tests__/` starts with the docblock
`// @vitest-environment node` on the very first line (before any comment/imports).

**Why:** The global vitest config sets `environment: "jsdom"` with
`resources: "usable"`. jsdom eagerly tries to load the native `canvas` module,
which needs `libuuid.so.1` — a system lib that is missing in the Replit
container. The result is an `ERR_DLOPEN_FAILED` unhandled error. When this hits
a test file it produces a confusing symptom: running the file alone reports
`Tests no tests` (the file silently collects nothing), and the full suite shows
that file under the failed/errored count even though the assertions are fine.
There is a `canvas` alias to a mock in `vitest.config.ts`, but it does not fully
prevent jsdom's native load path, so the per-file node environment is the
reliable fix.

**How to apply:** Any new test that only exercises pure functions (no DOM, no
React render) must have `// @vitest-environment node` as line 1. If a new test
mysteriously reports `no tests` or errors with `libuuid.so.1` / canvas, this
missing annotation is the first thing to check. Component/DOM tests that truly
need jsdom are the exception and stay on the default environment.
