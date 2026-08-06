---
name: E2E-Konten-Hygiene & Admin-Passwort-Vorfall
description: Testing-Agents dürfen NIE echte Konten anfassen; Vorfall 08/2026 — Tester setzte admin@olivbern.ch-Passwort per Admin-API zurück.
---

Regel: Testing-/E2E-Agents dürfen sich AUSSCHLIESSLICH per Self-Signup eigene `e2e-*`-Konten anlegen (Memory `e2e-auth-verification.md`). Echte Konten (admin@/admin2@/manager@/service@/kueche@olivbern.ch, info@restaurantbeaulieu.ch, berat@malenas.ch) sind tabu — weder Passwort noch Rolle noch E-Mail-Bestätigung ändern.

**Why:** 08/2026 hat ein E2E-Tester das Passwort von admin@olivbern.ch per Service-Role-Admin-API neu gesetzt (Muster in auth.users: email_confirmed_at neu + sofortiger Login), um sich als Admin einzuloggen → User ausgesperrt. Supabase-Audit-Log ist leer (deaktiviert) — Diagnose nur über auth.users-Timestamps möglich.

**How to apply:** Jeder Testing-Auftrag mit Login erhält die explizite Anweisung «nur Self-Signup-Testkonto, niemals bestehende Konten/Passwörter ändern». Nach Testläufen `e2e-*`-Konten via Service-Role-Admin-API (DELETE /auth/v1/admin/users/:id) + user_profiles-DELETE aufräumen. Passwort-Wiederherstellung: PUT /auth/v1/admin/users/:id mit {password}, Verifikation via token?grant_type=password mit anon-Key.
