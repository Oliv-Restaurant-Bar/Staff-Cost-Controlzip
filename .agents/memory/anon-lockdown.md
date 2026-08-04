---
name: Vollständiger anon-Lockdown (Supabase)
description: Regeln & Ausnahmen nach dem flächendeckenden anon-Sperr-Durchlauf; was öffentliche Flows nutzen dürfen.
---

**Regel:** Kein direkter anon-Tabellenzugriff — RLS überall an, REVOKE ALL FROM anon (Tabellen+Sequenzen, plus ALTER DEFAULT PRIVILEGES für künftige Tabellen). Öffentliche Flows laufen NUR über token-geprüfte SECURITY-DEFINER-RPCs oder die minimalen app_settings-Ausnahmen.

**Ausnahmen (einzige anon-Rechte):**
- app_settings: SELECT nur `published-schedule:%`, INSERT/UPDATE nur `staff-feedback:%` (UPDATE-Grant nötig, weil der Feedback-Pfad UPSERT nutzt — ON CONFLICT DO UPDATE verlangt UPDATE-Privileg schon zur Planzeit, auch ohne Konflikt).
- Storage: anon-INSERT nur Bucket `onboarding-docs` (privat); anon-SELECT dort wurde ENTFERNT (las alle HR-Dokumente) — Admin-Lesen via authenticated-Policy.
- RPCs: timesheet confirm/question/reject + get_confirmation_page_data + get/create_timesheet_request(s)_by_token; Onboarding get/mark/submit_by_token + create_onboarding_submission_public. Alle mit Token-Guard, Eingabe-Limits (Typ-Whitelist, Längen, max 50 Requests/Confirmation).

**Why:** anon-Key steckt im JS-Bundle; zuvor waren ~57 Tabellen (inkl. PII wie reservation_records_backup, employees-Token-Policies mit USING(true)-Charakter) offen. Gast-Sessions sind rein clientseitig (Passwort-Hash im Link) und laufen als anon — sie sehen nur die published-schedule-Ausnahme.

**How to apply:** Neue öffentliche Features NIE mit anon-Tabellen-Policies bauen — immer token-geprüfte SECURITY-DEFINER-RPC (search_path public, EXECUTE anon) mit Eingabe-Limits; Identität server-seitig aus dem Token ableiten, Client-Angaben ignorieren. Beim Anlegen neuer Tabellen: default privileges geben anon nichts mehr; authenticated-Policies explizit anlegen. Fremd-/Alt-Tabellen (bookings/menu/venues/leads/session…) liegen auf derselben DB, sind jetzt authenticated-only.


## Update 2026-08-06 — Features entfernt, Lockdown ohne Ausnahmen
- Gast-Freigaben (GuestSession, /gast, published-schedule, staff-feedback) und Mitarbeiter-Stundenbestätigung (Token-Flow) sind KOMPLETT entfernt (Code + RPCs + anon-Policies). isAdmin = nur echte Admin-Rolle; RequireAdmin ohne allowGuest.
- Migration 20260806_remove_guest_and_timesheet_confirmation.sql (live): app_settings-anon-Policies weg, alle Timesheet-Token-RPCs gedroppt, Sicherheitsnetz-DO-Loop, anon-EXECUTE auf Nicht-Onboarding-Funktionen entzogen.
- Zielzustand verifiziert: 0 anon-Tabellen-Grants, 0 anon-Policies. Einzige anon-Restflächen: token-geprüfte Onboarding-RPCs + Storage-INSERT onboarding-docs.
- Tabellen employee_timesheet_confirmations / timesheet_employee_requests existieren noch (Daten, authenticated-only) — bei Bedarf droppbar.
- Mirus-Re-Import schützt NICHT mehr über Bestätigungs-Status; Schutz = Monats-Finalisierung (timesheet_month_status) + Tages-Locks. Unlock setzt Status 'draft'.


## Update 2026-08-07 — Onboarding-per-Link entfernt, anon = 0 überall
- Route /onboarding/:token, OnboardingForm, Selbst-Anmeldungs-UI im Personalstamm und alle Onboarding-Client-APIs in supabase-db sind gelöscht. Neue MA nur noch eingeloggt im Personalstamm.
- Migration 20260807_remove_onboarding_public_flow.sql (live): 6 Funktionen gedroppt (4 Onboarding-RPCs, activate_onboarding_submission, get_token_access), Storage-anon-Policy «Anon upload onboarding docs» weg, DO-Loops entziehen anon/PUBLIC-EXECUTE auf ALLEN public-Funktionen (authenticated explizit gegranted) + ALTER DEFAULT PRIVILEGES.
- Verifiziert: anon_grants=0, anon_policies=0 (public+storage), anon_exec=0; REST/RPC/Storage mit anon-Key überall denied. KEINE gewollte anon-Ausnahme mehr.
- get_token_access ist gedroppt: useSupabaseSchedule hat kein Token-Plumbing mehr (canEdit/isAdmin fix true, Hook nur hinter Login); generierte types.ts enthält noch die alte Signatur (harmlos, beim nächsten Type-Regen weg).
- Öffentlich bleibt NUR /e/:token (Personaleintritt Phase 2) über die Edge Function personaleintritt-public (Service-Role, kein anon-DB-Zugriff).
- Tabellen onboarding_submissions + onboarding-docs-Bucket existieren noch (authenticated-only, Alt-Daten).

## Update 2026-08-08 — Personaleintritt-per-Link entfernt, 0 öffentliche Fläche
- Route /e/:token, MitarbeiterEintritt.tsx, public-api.ts, token.ts, InviteLinkDialog und alle Einladungs-Buttons (Liste rotateInvite, Neu createInvitation) sind gelöscht; PersonaleintrittNeu erzeugt nur noch Entwürfe.
- Edge Function personaleintritt-public: Code gelöscht UND deployte Function via Management API DELETE /v1/projects/{ref}/functions/{slug} entfernt (öffentlicher Aufruf ⇒ 404).
- Die 4 Mirus-Werkzeugrouten (/mirus-parser-test, -excel-test, -import-preview, -review) waren als Provider-freie Early-Returns in App.tsx ÖFFENTLICH — jetzt reguläre RequireAdmin-Routen. Bei «0 öffentliche Routen»-Audits App.tsx-Early-Returns VOR den Providern prüfen, nicht nur <Routes>.
- Verifiziert: public-Schema anon = 0 Grants/0 Policies/0 EXECUTE; Rest-anon-Rechte nur in storage/realtime/graphql_public (Supabase-Plattform-Defaults, 0 Policies ⇒ kein Zugriff). KEINE öffentliche Ausnahme mehr, alles hinter Login.
- Alt-Daten bleiben: personaleintritt-Records mit Status 'eingeladen'/invite_token_hash lesbar (db.ts-Mapping bewusst erhalten); Migration 20260724 unangetastet.
