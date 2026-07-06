---
name: vitest environments (node for pure logic, happy-dom for components)
description: Why pure-logic vitest files must declare the node environment and component tests must use happy-dom — jsdom crashes on canvas/libuuid in this container.
---

# Vitest environments in this container

- Pure-logic tests (no DOM/React): `// @vitest-environment node` on line 1.
- React component tests: `// @vitest-environment happy-dom` on line 1.

**Why:** The global vitest config sets `environment: "jsdom"`. jsdom eagerly
`require`s the native `canvas` package, which needs `libuuid.so.1` — missing in
the Replit container → `ERR_DLOPEN_FAILED` unhandled error. Symptom is
confusing: the file reports `no tests` / an "Unhandled Error" before any test
runs. The `canvas` alias in `vitest.config.ts` and `vi.mock("canvas")` in
setup.ts do NOT help, because jsdom loads canvas via plain CJS require outside
the vite transform pipeline — aliases/mocks never intercept it.

**How to apply:**
- New pure-function test → `// @vitest-environment node` line 1.
- New component/DOM test → `// @vitest-environment happy-dom` line 1
  (`happy-dom` is a devDependency; works with @testing-library/react +
  fireEvent, e.g. the Import-Cockpit DataImportsTab tests).
- If a test mysteriously reports `no tests` or errors with `libuuid.so.1` /
  canvas, the missing annotation is the first thing to check.

**Also:** running several vitest suites in one command can be OOM-killed
(exit -1, no output) like vite build; split the run and/or use
`--pool=forks --maxWorkers=1` with `NODE_OPTIONS=--max-old-space-size=8192`.
