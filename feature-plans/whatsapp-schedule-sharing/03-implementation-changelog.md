# WhatsApp schedule sharing — implementation changelog

CRM task 39927 (feature 1 of 3). Status: **built, type-checked, unit-tested; not yet verified against a live database or deployed.**

## What was built
- `supabase/migrations/20261023_schedule_share.sql` — tables `schedule_share_links`, `published_schedule_weeks` (RLS on, no policies), five `SECURITY DEFINER` RPCs behind a role/tenant/department check, and `schedule_public_get(token)` as the only anon-callable function.
- `src/lib/schedule-publish-payload.ts` — pure payload builder, per-day change detection (change markers survive an unchanged re-publish), status (`draft | published | changed`), full-week coverage helper, WhatsApp message + `wa.me` URL builder.
- `src/lib/schedule-publish-db.ts` — RPC wrappers; database-first, no localStorage, 12 s timeout, errors surfaced.
- `src/components/schedule-planner/PublishScheduleDialog.tsx` — department picker (role-limited), per-week status and change count, publish, read-back verification, WhatsApp share, copy link, link reset (two-step confirm).
- `src/pages/StaffSchedulePage.tsx` — public mobile-first page (by day / by week, changed days highlighted, "Stand" timestamp, always fresh fetch + refetch on tab focus, invalid-link and error states).
- `SchedulePlanner.tsx` — "Veröffentlichen" toolbar button + dialog mount (+~25 lines). `App.tsx` — first public route `/staff-schedule/:token`. `vercel.json` — SPA rewrite so the deep link works when opened from WhatsApp.
- `src/lib/__tests__/schedule-publish-payload.test.ts` — 12 tests, all passing.

## Deviations from plan
- Publish granularity is "fully covered ISO weeks in the visible range" (month view skips the partial border weeks) — avoids publishing half-loaded weeks over a complete earlier publish.
- Added read-back verification after each publish (carried over from the old code's idea, now enforced).

## Verification so far
- `tsc -p tsconfig.app.json`: 219 errors before and after (baseline), none in touched files. `npm run build` OK. ESLint clean on new files.
- NOT done: migration not applied to any database; no end-to-end click-through; no real WhatsApp send.

## Outstanding manual steps
1. Run the migration in the dev Supabase SQL editor (and later production).
2. Make sure `VITE_PUBLIC_URL` in the Vercel project points at the stable domain (links in WhatsApp use it).
3. Click-through on dev: publish a week as admin, open the link in a private window, edit a shift, re-publish, reload the link; try as service_manager (Küche must be unavailable); reset the link and confirm the old one shows "nicht mehr gültig".
4. Security review findings: see section below.

## Security review (static, migration not run against a DB)
No critical/high findings. 3 medium, 13 low/suggestions.

**Fixed**
- M1 absence text: published only as `Ferien | Feiertag | Frei | Abwesend`; sick (K), accident (U) and unknown values become "Abwesend". Enforced in the client builder and by the DB validator.
- M2 server-side validation: new `schedule_share_validate_payload` (key whitelist, department/weekStart must match the arguments, Monday only, ±60-day window, ≤200 employees, 7 days each, slot/absence checks, 500 KB cap). Wages or free text cannot be stored.
- M3 public response bounded: window [today−7, today+60], max 12 weeks.
- L1 employee ids stripped from the public response; L3 page keys no longer rely on names.
- L2 page skips malformed weeks instead of crashing; L11 generic error text for anonymous visitors.
- L6 `assert_allowed` / `validate_payload` no longer executable by `authenticated`.
- L8 `vercel.json`: `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on `/staff-schedule/*`.
- L9 read-back check tolerates a parallel publish (`>=`). L13 migration wrapped in a transaction.
- Dialog warns when the generated link points at localhost.

**Not changed (deliberate)**
- L4: `user_profiles` has no active flag, so nothing to check. Whether users can update their own `role` under RLS is pre-existing and shared with the control-list migration — worth a separate check (`supabase/fix_role_rls.sql`).
- L5: `search_path = public` kept to match the repo's other SECURITY DEFINER functions; not exploitable by default.
- L7 (link created on first dialog open): harmless, no weeks exposed.
- L8 token hashing, L10 batch RPC / abortable timeout, L12 retention job: deferred; add if the client wants them.

## Follow-ups after first browser check (2026-10-23)
- Dialog overflow fixed (long token pushed the dialog wider than its frame).
- Status bug fixed: `computeStatus` compared raw JSON; jsonb returns `{end,start}` key order -> "geändert" right after publishing. Now compared field-wise (+ test).
- Shorter links: new migration `20261024_schedule_share_short_token.sql` (20 hex chars = 80 bit, `schedule_share_new_token()`, public read accepts >= 16 chars, existing long test tokens are replaced). Link path is now `/s/<token>`; `/staff-schedule/:token` kept as alias. `vercel.json` header rule covers both.
- Message in the publish dialog is an editable textarea, prefilled with the default text; "Standardtext wiederherstellen"; warning if the link was removed from the text.
- Staff page redesigned: per-tenant theme from the logos (Oliv: black + sage, Jost; Beaulieu: forest green + gold, Cormorant Garamond headings), logo header, initials avatars, time pills, absence badges, changed-entry highlight with previous time, today marker, themed week table. Fonts + noindex meta are injected by the page only.
- Beaulieu theme not yet viewed in a browser (needs a published Beaulieu week).

## Responsive + short link + favicon (2026-10-23)
- Staff page: container widens to `max-w-6xl` for the week table (all 7 days visible on desktop/tablet), day view stays `max-w-3xl`; phone week table compacted (narrower name column, `10:00–14:00`, swipe hint). Tested at 1920/1568, 820 and 390 px.
- Token now 12 chars A-Za-z0-9 (~71 bit) via `schedule_share_new_token()`; link = `<domain>/s/<12 chars>`. Migration `20261024_...` re-runnable; it replaces tokens > 12 chars.
- Favicon: Lovable heart replaced by the Oliv "O" on a black tile (`favicon.ico` multi-size, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`); manifest + `index.html` updated (theme-color `#1B1B19`, `?v=2` cache-bust). Beaulieu links swap in a "B" icon (`favicon-beaulieu-32.png`, `apple-touch-icon-beaulieu.png`) from `StaffSchedulePage`.
- Admin publish dialog at phone width not tested (planner window would not resize in the test browser).

## Unsaved-changes guard (2026-10-24)
- Publishing is blocked while the planner has unsaved or failed saves (`hasUnsavedChanges`); the dialog shows an alert with "Jetzt speichern" and publishing refuses with a toast. Unit-tested (`PublishScheduleDialog.test.tsx`).

## Client feedback round 1 (2026-10-26)
Client asked for: several weeks at once with easy switching, a name filter for staff, and a landscape PDF (one week per page).
- **Several weeks:** the publish dialog no longer depends on the planner's visible range. It checks the next 9 weeks (= DB publish window), lists only weeks with shifts or already published, shows 5 first and "Mehr laden" for the rest; "Alle auswählen" works on the shown weeks. Months not loaded in the planner are read from the DB; a load failure aborts instead of publishing partial data. This also fixes a latent bug: a week spanning two months could be published with the other month's days empty. WhatsApp text now says "KW 44–48 sind online" (ranges, plural verb).
- **Staff page:** week chips show the date range and mark the current week (hidden scrollbar, active chip centred); switching weeks keeps the weekday, the day is derived synchronously (fixes the flicker) and the content fades in. "Anzeigen für" name filter (day + week view), remembered per link in localStorage; "Nächste Schicht" card for the selected person (`src/lib/staff-next-shift.ts`, tested), tap jumps to that day.
- **PDF (admin only, in the publish dialog):** `src/lib/schedule-pdf.ts`, A4 landscape, one week per page, themed like the staff page (logo, cream background, brand header, absence colours, "Stand" footer), shrinks font / puts two shifts side by side so a big department still fits one page. Jost and Cormorant Garamond embedded from `public/fonts/` (OFL, Latin subset for Cormorant), fetched only when a PDF is made; falls back to Helvetica/Times. Oliv logo background removed in the browser (colour-to-alpha). Tests in `schedule-pdf.test.ts`.
- **Planner UI:** the shift popup in `TimeInputCell` is limited to the free space in the window (collision padding, scrolls inside) so it no longer runs off screen; the publish dialog scrolls inside the window.
- Verification: tsc baseline 219 unchanged; lint clean on touched files (pre-existing findings remain in `TimeInputCell.tsx`); new/changed unit tests pass; checked in the browser (name filter, week switching, popup, dialog, phone width). Not visually checked: the Oliv PDF with the transparent logo, admin dialog at phone width.
