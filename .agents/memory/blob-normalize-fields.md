---
name: Blob normalize strips new fields
description: New persisted record fields must be carried through the field-by-field normalize rebuild or they are silently lost on reload.
---

Rule: When adding fields to records inside a persisted settings blob (e.g. `tagesabschluss_v1.exportProtokolle`), the load-time normalizer (`normalizeTagesabschlussBlob` and siblings) rebuilds each record **field-by-field** — any field not explicitly copied there is silently stripped on EVERY load (localStorage read, KV merge, save-merge), and the next save persists the stripped version, losing the data permanently.

**Why:** Architect review caught that `sollTotal`/`habenTotal`/`settingsFingerprint` on export records were written correctly but vanished after reload, silently killing the Historie columns and the "veraltet bei Regeländerung" semantics across sessions. In-memory tests never caught it because they skipped the load round-trip.

**How to apply:** Whenever a new field is added to a normalized record type: (1) add the carry-over in the normalizer with type guard + fallback, (2) add a JSON round-trip test `create → JSON.parse(JSON.stringify(blob)) → normalize → expect fields preserved` — this test class is what catches the bug.
