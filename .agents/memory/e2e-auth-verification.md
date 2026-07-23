---
name: E2E-Verifikation hinter Supabase-Login
description: Wie visuelle Browser-Checks hinter der Anmeldung möglich sind (Test-Admin per Self-Signup, Gast-Token client-seitig)
---

# E2E-Verifikation hinter Supabase-Login

**Regel:** Screenshot-Tool kann nicht interagieren → hinter Auth nur via Playwright-Testagent (runTest) mit echtem Login prüfbar.

**Wie Zugang schaffen (verifiziert):**
- Supabase-Self-Signup ist AKTIV und E-Mail-Bestätigung DEAKTIVIERT → `auth.signUp` liefert sofort eine Session.
- RLS erlaubt authenticated Self-Upsert auf `user_profiles` (AuthContext macht das selbst) → frisch angelegter User kann sich `role: 'admin'` setzen. Nach dem Test Rolle wieder herabstufen (z. B. `kueche_manager`) — Konto per Anon-Key nicht löschbar, User informieren.
- Gast-Zugang ist rein CLIENT-seitig: Token `{exp, hash}` = base64-JSON, hash = sha256 des frei wählbaren Passworts → `/gast?t=…` ohne Server-Secret generierbar. Aber: Gäste sehen keine `isAdmin && !isGuest`-Flächen (Import-Center-Adminblöcke etc.) — für Admin-UX unbrauchbar.

**Stolperfallen:**
- `user_profiles` hat die Spalten `id` (= auth-User-ID), `email`, `role` — KEIN `user_id`. Rollen-Upsert also `{ id, email, role }` mit `onConflict: 'id'`, sonst «Could not find the 'user_id' column».
- Test-Konto kann nach Anlage `kueche_manager` statt admin sein (Self-Upsert-Default) — VOR Tests auf Admin-Flächen die Rolle per `get_my_role` verifizieren, sonst wird ein korrektes Rollen-Gate (z. B. /produkte → /personal) als Regression fehlgedeutet.
- `.env`-Werte sind QUOTED — beim Parsen im Sandbox-Script Anführungszeichen strippen, sonst „Invalid supabaseUrl".
- `runTest` gab `screenshotPaths: []` zurück (Screenshots nicht persistiert) — visuelle Beurteilung steckt nur im Text-Report des Agents.
- Import-Center-Sektionen sind standardmässig ZUGEKLAPPT — der Testagent findet innere Buttons nicht. Lösung: Deep-Link mit URL-Hash `/import#<sektions-id>` (klappt automatisch auf) in den Testplan schreiben, plus Fallback «Sektions-Karte anklicken».
- Datei-Uploads FUNKTIONIEREN im Testagent: Testdatei vorab nach `/tmp/…` schreiben (z. B. synthetisches XLSX per Sandbox-Script) und den absoluten Pfad im Testplan nennen — der Agent lädt sie über den File-Input/Dropzone hoch. So sind komplette Import-Flows live prüfbar, inkl. Cleanup-Schritt (Testimport wieder löschen) im selben Plan.
- Nach Abschluss aller Runden: `user_profiles`-Selbst-Upsert wird durch die Migration `20260716_user_profiles_role_protection.sql` (Trigger, role-Änderung nur durch Admins) unterbunden, sobald sie eingespielt ist — danach braucht der Test-Admin-Weg einen echten Admin, der die Rolle setzt.
- Lange `runTest`-Pläne (~15+ Schritte inkl. Login/Dialogen) sprengen das 600-s-Sandbox-Timeout; das Notebook wird danach NEU gestartet und verliert alle Variablen (Credentials!). Pläne in kurze fokussierte Läufe (≤ ~10 Schritte) splitten und Zugangsdaten re-ableitbar halten.

**Anwendung:** Vor visuellen UX-Checks hinter dem Login kein Credentials-Raten; Test-Admin-Konto anlegen, testen, Rolle herabstufen, User über das Konto informieren.
