---
name: architect response shape
description: Where the architect (code_review skill) verdict actually lives in its return value
---

The `architect(...)` return value has both `result` and `message`. Sometimes
`result.result` is **just an echo of the `relevantFiles` contents** ("The
following files may be relevant to the task:" + file bodies) with NO analysis
section appended — the whole string is file echoes and ends at the last
`</file>`.

**Why:** observed a run where `result.result` (~33k chars) contained only the
passed-in files; the actual verdict/summary was ONLY in `result.message`
(a 1–2 sentence pass/fail summary).

**How to apply:** when reviewing architect output programmatically via
code_execution, always log `result.message` (and `result.success`), not only
`result.result`. If `result.result` is just file echoes, treat `result.message`
as the verdict rather than re-spinning the architect (wastes cycles). To force a
detailed analysis, pass FEWER files and a sharper, single-question task.
