# WhatsApp schedule sharing — implementation checklist

Order matters: DB → pure lib → DB wrappers → UI → wiring → tests → verification.

- [ ] 1. Migration `supabase/migrations/20261023_schedule_share.sql`: two tables, RLS on, helper `schedule_share_assert_allowed(tenant, dept)`, five RPCs, grants (only `schedule_public_get` to `anon`).
- [ ] 2. `src/lib/schedule-publish-payload.ts` (pure): types, `buildWeekPayload`, `diffWeekPayload`, `computeStatus`, `buildWhatsAppMessage`, `buildWhatsAppUrl`, ISO-week grouping helper.
- [ ] 3. `src/lib/schedule-publish-payload.test.ts`: payload build, change detection, status, message/url encoding, week grouping.
- [ ] 4. `src/lib/schedule-publish-db.ts`: RPC wrappers (`getShareLink`, `rotateShareLink`, `publishWeek`, `getPublishedWeek`, `fetchPublicSchedule`), typed errors.
- [ ] 5. `src/components/schedule-planner/PublishScheduleDialog.tsx`.
- [ ] 6. `src/pages/StaffSchedulePage.tsx` (public).
- [ ] 7. Wire: planner toolbar entry + dialog mount; public route in `App.tsx` outside auth gate; `getPublicBaseUrl()` for the link.
- [ ] 8. Type-check (`tsc -p tsconfig.app.json` before/after diff), run new tests, lint new files.
- [ ] 9. Security review of migration + public page (anon path).
- [ ] 10. Write `03-implementation-changelog.md`; update `CLAUDE.md` (new public route, new tables/RPCs, `_deprecated` note unaffected).
