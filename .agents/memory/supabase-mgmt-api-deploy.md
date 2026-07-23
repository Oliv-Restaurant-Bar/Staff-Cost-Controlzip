---
name: Supabase Edge Deploy via Management API
description: How to deploy edge functions + set function secrets without CLI; PAT staleness; verify_jwt gotcha
---

# Supabase Edge Functions ohne CLI deployen

**Regeln:**
- Personal Access Tokens (`sbp_…`, Secret `SUPABASE_ACCESS_TOKEN`) veralten/werden widerrufen → bei 401 gegen `api.supabase.com` NICHT weiter probieren, sondern frischen Token per Secrets-Request vom User anfordern (Dashboard → Account → Access Tokens). Der `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`) ist KEIN Ersatz für Management-API/Storage-Admin-Aufrufe («Invalid Compact JWS»).
- Deploy: `POST https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug=<name>` als multipart mit Feld `metadata` (JSON: `{"name","entrypoint_path":"index.ts","verify_jwt":false}`) + Feld `file` (die .ts-Datei). Antwort 201 mit `status:ACTIVE`.
- `verify_jwt` MUSS in der Deploy-`metadata` stehen — `supabase/config.toml` wirkt nur beim CLI-Deploy.
- Function-Secrets: `POST /v1/projects/{ref}/secrets` mit `[{"name","value"}]` (201). Secrets vor dem Deploy setzen, dann sofort wirksam.
- Projekt-Ref immer aus `.env` (`VITE_SUPABASE_URL`) ableiten, nie aus Erinnerung/Notizen (dort stand schon eine falsche Ref).
- Webhook-Secrets, die der User extern (n8n) braucht: nie in den Chat drucken; in gitignorete Datei `.local/…` legen und den User auf die Datei verweisen.

**Why:** Alles empirisch verifiziert beim gastronovi-inbound-Deploy; CLI ist im Replit-Env nicht eingeloggt, DDL bleibt per Projekt-Konvention manuell im SQL-Editor.
