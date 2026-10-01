# Administration & System Tools

This domain covers the parts of the app that aren't about day-to-day restaurant operations, but about configuring and maintaining the system itself: global settings (passwords, revenue-distribution defaults, backups), the master list of legal business entities ("Betriebe") that HR records attach to, a data-integrity comparison tool, and a set of debug/test pages for the MIRUS staff-hours import pipeline. There's also one legacy full-page dashboard (`/overview`) kept around from an earlier version of the app.

## Pages

| Route | English name | Purpose | Role access |
|---|---|---|---|
| `/settings` | Settings | System-wide admin settings: password protection toggle (site-wide login lock + a separate "sensitive areas" password), default weekday revenue-distribution percentages, labor-cost threshold, staff-name-mapping management (for import matching), full database backup/restore (download, browser-stored versions, email backup, ZIP export), user management, plus embedded cards for capacity settings, social-cost rates, VAT (MwSt) rates, and target personnel-cost ratio. This is the single largest "system configuration" surface in the app. | `canAccessSettings` — admin only |
| `/betriebe` | Businesses / Locations | Manages "Betrieb" records (table `betriebe`, since migration `20260724f`) — the legal business entities that feed contract PDFs, SEM (Swiss social-insurance) reporting, HR dossiers, and the weekly-hours model used by the staff-onboarding module. Records can't be hard-deleted (they're a foreign-key target from `personaleintritt.betrieb_id`) — only deactivated (`aktiv=false`); deactivated ones stay visible (greyed out) so old records still resolve. Has an "SCC integration" toggle linking a Betrieb to a specific tenant's employee master/schedule. | Admin only — explicitly **excludes** `beaulieu_manager` per the route comment ("NUR Admin OHNE Gäste – kein beaulieu_manager") |
| `/integrity-test` | Data Integrity Test | Compares `localStorage` vs. the Supabase KV backup for the `dailyBudgets` key (tenant-scoped) and reports whether they're in sync — shows which dates exist only locally vs. only remotely, plus per-month KV sums. Includes a manual "sync" action. This is a debugging tool for chasing local/remote data-drift issues, not an end-user feature. | Admin only |
| `/mirus-parser-test` | MIRUS PDF parser test | Uploads a MIRUS monthly PDF timesheet, runs it through `parseMirusPDF()`, and shows everything the parser recognized as a debug table (employee names, day rows, confidence per field). No save, no Supabase call at all. | Admin only (previously public/standalone, now behind the auth gate — see gotchas) |
| `/mirus-excel-test` | MIRUS Excel parser test | Same idea for the Excel/XLS variant: upload → structure analysis → parse (`parseMirusExcel()`) → validation (per-employee issue list: missing dates, totals mismatches, duplicate flags) → export. No save, no Supabase, no production logic. | Admin only |
| `/mirus-import-preview` | MIRUS import preview | Builds a `PreviewImportSession` from a parsed MIRUS Excel file — a safe, read-only staging step before anything touches the database. Computes a per-employee "quality score" (0–100) from how complete/plausible the parsed data looks. No Supabase write; local state only. | Admin only |
| `/mirus-review` | MIRUS review | A fuller HR review workflow: loads the session that `/mirus-import-preview` staged (via `localStorage`), lets a reviewer accept/hold/exclude/flag-for-correction each employee with an audit log, and tracks review status per employee. Still no Supabase write — purely local state; this is the human-review step before real import happens elsewhere. | Admin only |
| `/overview` | Legacy personnel overview | `Index.tsx` — an older, self-contained personnel-tracking dashboard (own tab navigation: Übersicht/Umsatz/Personal/Dienstplan) that predates the current page structure. Still functional and reachable, but not part of the current information architecture (not in the main nav). | Reachable for everyone except `beaulieu_manager`, who gets redirected via `BlockedRoute` back to `/` (comment: "Legacy – beaulieu_manager darf nicht auf die Oliv-Overview") |
| `*` (catch-all) | 404 Not Found | Generic not-found page; logs the attempted path to the console (`console.error`). | Public (renders for any unmatched path, still behind the app's own auth gate since there are no public routes) |

## Data flow

- `/settings` writes through `src/lib/supabase-db.ts` (`saveSetting`) for tenant-scoped settings and `src/lib/full-backup.ts` for the backup/restore system (`downloadBackup`, `restoreFromBackup`, `saveBackupToBrowser`, `sendBackupEmail`, `exportBackupsAsZip`); name-mapping management goes through `src/lib/name-matching.ts`. Several settings sub-panels are their own components (`CapacitySettingsCard`, `SocialCostRatesCard`, `MwstRatesCard`, `ZielPersonalquoteCard`, `UserManagementCard`) each presumably with their own small data module — not traced in depth here.
- `/betriebe` reads/writes through `src/lib/personaleintritt/db.ts` (`loadBetriebe`, `createBetrieb`, `updateBetrieb`) and configuration constants in `src/lib/personaleintritt/betriebs-config.ts`.
- `/integrity-test` reads `localStorage` directly and `src/lib/supabase-kv.ts` (`kvGet`, `syncLocalToSupabase`, `syncSupabaseToLocal`).
- The four MIRUS test/review pages share two parser modules: `src/lib/mirus-pdf-parser.ts` (`parseMirusPDF`) and `src/lib/mirus-excel-parser.ts` (`parseMirusExcel`) — these are the same parsers the *production* import flow (`/import`, `StundenimportPage`) uses, which is exactly why these pages are useful for debugging real import problems. `/mirus-review` also uses `src/types/mirus-review.ts` for its review-state types.

## Key files

| File | Purpose |
|---|---|
| `src/lib/full-backup.ts` | Full database backup/restore/export logic behind `/settings` |
| `src/lib/name-matching.ts` | Staff-name-mapping management (used for import name matching) |
| `src/lib/personaleintritt/db.ts` | `betriebe` table reads/writes |
| `src/lib/personaleintritt/betriebs-config.ts` | Betrieb configuration constants (weekly-hours models, display names) |
| `src/lib/mirus-pdf-parser.ts` | MIRUS PDF timesheet parser — shared by test page and real import flow |
| `src/lib/mirus-excel-parser.ts` | MIRUS Excel timesheet parser — shared by 3 of the 4 MIRUS pages and production import |
| `src/lib/supabase-kv.ts` | Generic KV sync helpers used by `/integrity-test` |

## Non-obvious gotchas

- **The four MIRUS pages do nothing to the database.** Every one of them explicitly avoids Supabase writes (confirmed in each file's own header comment: "Kein Speichern, kein Supabase" / "KEIN Supabase-Write"). They're debugging/QA tools for the MIRUS parsing pipeline, not part of the live import path — if a MIRUS import bug is reported, these pages are exactly where to reproduce and inspect it safely without risking production data, but fixing the underlying parser still means editing `mirus-pdf-parser.ts` / `mirus-excel-parser.ts`, which are also used by the real import pages.
- **These MIRUS pages used to be deliberately public** (no auth) and are now behind the standard admin auth gate — per the `App.tsx` route comment. If you're chasing an old bug report or bookmark that assumed no-login access, that assumption is now stale.
- **`Betriebe` records are never hard-deleted.** They're a foreign-key target for `personaleintritt.betrieb_id`; only `aktiv=false` (deactivate) is possible. If a "delete" seems to not work, that's by design — check for the deactivate/grey-listing behavior instead.
- **`beaulieu_manager` is excluded from both `/betriebe` and `/overview`** — two separate, independently-coded exclusions (not derived from one shared rule), so if extending role logic, check both route guards rather than assuming one covers the other.
- **`/settings`'s password protection is a separate, lower-level mechanism from the Supabase Auth login** — it's a `localStorage`-flag-driven UI lock (`PASSWORD_PROTECTION_ENABLED_KEY`, `GLOBAL_SITE_PROTECTION_ENABLED_KEY`) layered on top of the real auth system, seemingly left over from an earlier (pre-Supabase-Auth) version of the app. Don't confuse it with the real role/session auth described elsewhere in these docs.
- **`/overview` (`Index.tsx`) is a legacy, self-contained dashboard** with its own tab system and its own `usePersonnelData` hook — it doesn't share the page-shell/navigation patterns the rest of the app now uses. It's still live and functional, just outside the current information architecture; don't use it as a reference for "how pages are built" in this codebase.

## Orphaned pages — not reachable via navigation

These two files exist under `src/pages/` and are real, substantial features, but (confirmed per this project's `CLAUDE.md`, and consistent with what's visible in `App.tsx`'s import list, which does **not** include either) — they are **not wired into any route** in `App.tsx` and are not imported by any other component. A developer browsing the running app cannot reach them by clicking anything; they can only be found by reading the source tree directly.

- **`ArbeitszeitblaetterPage.tsx`** (timesheet approval) — a personnel-tracking page built around `usePersonnelData`, with its own tab navigation (Übersicht/Umsatz/Personal/Dienstplan), employee form dialogs, and date/week selection. Appears to be an early or parallel version of the personnel-tracking UI, structurally similar to the legacy `/overview` (`Index.tsx`) page above.
- **`StundenimportPage.tsx`** (MIRUS hours import) — a production-shaped (not test-shaped) MIRUS Excel hours-import flow: parses via `parseMirusExcel()`, matches employees by name (`matchEmployeeByName`), and actually persists via `saveActualHourEntry()` into `actual_hours` — unlike the four MIRUS test pages above, this one **does** write to Supabase. It appears to be a real, finished alternative/precursor import path for staff hours that simply never got a route added to `App.tsx`.

If a fix or feature request references either page name, treat it as "exists as code, unreachable in the running app" rather than assuming it's part of the current user-facing flow — confirm with the client whether it should be revived (routed) or removed before building on it.
