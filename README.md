# Oliv Staff Control — Personal Cost Tracker

A multi-tenant staff scheduling, payroll-cost, and P&L cockpit for **Oliv
Restaurant & Bar** and **Restaurant Beaulieu**, originally generated with
Lovable and now maintained directly in this repo.

**New to this codebase? Start with [`docs/dev/Overview.md`](docs/dev/Overview.md).**
It explains what the product actually does, the tech stack, the role/tenant
model, how to get it running locally, and how to test a fix end-to-end — plus
links to one doc per feature area (`docs/dev/features/*.md`) that walks through
every page, its data flow, and its non-obvious business rules. The whole UI
and much of the codebase is in German (the client is German-speaking); these
docs translate route/page names to English so a non-German-speaking developer
can navigate and test the app.

Docs are split by audience:
- `docs/dev/` — internal engineering docs (issue tracker, changelog, missing-tables
  investigation, feature/architecture notes). Not shared with the client as-is.
- `docs/client/` — client-facing status write-ups, in plain language.

For the ongoing bug-fix audit tracking, see
[`docs/dev/personal-cost-tracker-issues.md`](docs/dev/personal-cost-tracker-issues.md)
(issue list + test steps, client priorities listed first) and
[`docs/dev/personal-cost-tracker-changelog.md`](docs/dev/personal-cost-tracker-changelog.md)
(what's been fixed so far). For the client-readable version, see
[`docs/client/personal-cost-tracker-summary.md`](docs/client/personal-cost-tracker-summary.md).

## Quick start

```sh
npm i
npm run dev        # Vite dev server, http://localhost:8080 (auto-falls-back if taken)
```

Requires a `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (not committed — get the values from whoever holds Supabase project access). See `docs/dev/Overview.md` for the other commands (`build`, `lint`, `test`) and their known caveats.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS
- Supabase (Postgres + Auth)

Originally scaffolded with [Lovable](https://lovable.dev); no longer developed through it — see `docs/dev/Overview.md` for the current workflow.
