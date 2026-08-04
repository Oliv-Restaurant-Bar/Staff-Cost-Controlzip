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
