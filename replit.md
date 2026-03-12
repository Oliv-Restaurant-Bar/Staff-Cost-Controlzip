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

## Ziel-Modulstruktur (in Umsetzung)
1. **Dashboard** — Übersicht KPIs, Umsatz, Kosten
2. **Dienstplanung** — Plan- und Ist-Dienstplan (SchedulePlanner.tsx)
3. **Soll / Ist Analyse** — Vergleich geplant vs. tatsächlich
4. **Personalstamm** — Mitarbeiterdaten (nur Admin)
5. **Reporting / Finanzmodul** — Vollständige Finanzdaten (nur Admin)

## Rollen-System (Phase 1 implementiert)
- **admin** → sieht alles, incl. Einzellöhne und alle Abteilungen
- **service_manager** → nur Service-Mitarbeiter, keine Einzellöhne
- **kueche_manager** → nur Küchen-Mitarbeiter, keine Einzellöhne

### Rollen-Infrastruktur
- `src/contexts/AuthContext.tsx` — lädt Rolle aus `user_profiles`-Tabelle
- `src/hooks/usePermissions.ts` — **zentraler Berechtigungs-Hook** (alle Regeln hier)
- `supabase/add_user_roles.sql` — einmalig ausführen zum Erstellen der `user_profiles`-Tabelle
- `src/App.tsx` — Routen-Schutz (Settings nur für Admin)

### Berechtigungsregeln (usePermissions.ts)
| Recht | Admin | Service-Mgr | Küchen-Mgr |
|---|---|---|---|
| Einzellöhne sehen | ✅ | ❌ | ❌ |
| Gesamtkosten/Quote | ✅ | ✅ | ✅ |
| Abt. wechseln | ✅ | ❌ | ❌ |
| Alle Abt. sehen | ✅ | ❌ | ❌ |
| Mitarbeiter bearbeiten | ✅ | ❌ | ❌ |
| Einstellungen | ✅ | ❌ | ❌ |
| Finanzdaten | ✅ | ❌ | ❌ |

## Datenbankschema (Supabase)
Skript: `supabase/setup_new_project.sql` — muss im Supabase SQL Editor ausgeführt werden.

Tabellen:
- `employees` — TEXT PRIMARY KEY (IDs '1'–'23'), Mitarbeiterdaten
- `schedule_entries` — Dienstplan-Einträge pro Mitarbeiter + Tag
- `actual_hours` — Ist-Stunden pro Mitarbeiter + Tag
- `app_settings` — Schlüssel/Wert-Speicher (Wochentag-Prozentsätze, Schwellenwerte)
- `user_profiles` — Rollen-Zuordnung (id → role) — nach SQL-Skript vorhanden

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
- `src/pages/SchedulePlanner.tsx` — Hauptseite Dienstplan (~2000 Zeilen)
- `src/hooks/usePermissions.ts` — Zentrales Berechtigungssystem
- `src/hooks/usePersonnelData.ts` — Mitarbeiter + Zeiteinträge
- `src/hooks/useShiftConfig.ts` — Schichtkonfiguration
- `src/pages/Settings.tsx` — Einstellungen (nur Admin)
- `src/contexts/AuthContext.tsx` — Supabase Auth + Rollenladung
- `src/App.tsx` — Routing + Routen-Schutz

## Nächste Schritte (Phase 2)
1. SQL-Skript `supabase/add_user_roles.sql` im Supabase SQL-Editor ausführen
2. Manager-Accounts in Supabase Authentication erstellen
3. Rollen via SQL den neuen Accounts zuweisen
4. Dashboard-Seite (/) rollengerecht anpassen (Manager sehen nur ihre KPIs)
5. Soll/Ist-Analyse als eigene Seite auslagern
