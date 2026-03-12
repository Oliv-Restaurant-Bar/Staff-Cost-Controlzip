# Personalkostentracker – oLiv Restaurant & Bar

Internes Reporting-Tool für Umsatz, Personalkosten, Dienstplan und KPIs. 2–3 interne Nutzer.

## Tech Stack
- React + TypeScript + Vite
- Supabase (Auth + Datenbank) — Projekt `ajflrvuzmkfspsxkdyfe`
- Shadcn UI / Tailwind CSS
- date-fns, sonner, recharts

## Supabase-Konfiguration
- Projekt-URL: `https://ajflrvuzmkfspsxkdyfe.supabase.co`
- Anon Key: `sb_publishable_QXf-21IX_EQ_cwLGqNc24w_-fFS23ht`
- Login: `admin@olivbern.ch` / `OlivAdmin2026!`
- Datei: `src/integrations/supabase/client.ts`

## Datenbankschema (Supabase)
Skript: `supabase/setup_new_project.sql` — muss im Supabase SQL Editor ausgeführt werden.

Tabellen:
- `employees` — TEXT PRIMARY KEY (IDs '1'–'23'), Mitarbeiterdaten
- `schedule_entries` — Dienstplan-Einträge pro Mitarbeiter + Tag
- `actual_hours` — Ist-Stunden pro Mitarbeiter + Tag
- `app_settings` — Schlüssel/Wert-Speicher (Wochentag-Prozentsätze, Schwellenwerte)

RLS-Policies: Nur eingeloggte Nutzer haben Zugriff.

## Service-Layer
`src/lib/supabase-db.ts` — alle Lade/Speicher-Funktionen für Supabase:
- `loadEmployees`, `upsertEmployee`, `upsertAllEmployees`, `deleteEmployee`
- `loadScheduleForMonth`, `saveScheduleEntry`, `saveFullScheduleForMonth`
- `loadActualHoursForMonth`, `saveActualHourEntry`
- `loadSetting`, `saveSetting`

## Migrationsstatus
- SchedulePlanner.tsx: vollständig auf Supabase migriert (localStorage als Backup)
- usePersonnelData.ts: Mitarbeiter-Sync auf Supabase
- Settings.tsx: Wochentag-Prozentsätze + Schwellenwert auf Supabase
- useShiftConfig.ts: noch localStorage (Schicht-Konfiguration, tief integriert)
- Tagesbudgets: noch localStorage
- UI-Präferenzen: bewusst in localStorage (nutzerspezifisch)

## Wichtige Dateien
- `src/pages/SchedulePlanner.tsx` — Hauptseite Dienstplan (1690 Zeilen)
- `src/hooks/usePersonnelData.ts` — Mitarbeiter + Zeiteinträge
- `src/hooks/useShiftConfig.ts` — Schichtkonfiguration
- `src/pages/Settings.tsx` — Einstellungen
- `src/contexts/AuthContext.tsx` — Supabase Auth
