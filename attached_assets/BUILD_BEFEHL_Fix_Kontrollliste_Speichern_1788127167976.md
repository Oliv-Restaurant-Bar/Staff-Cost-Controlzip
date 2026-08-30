# Build-Befehl — Fix: «Kontrollliste konnte nicht gespeichert werden: duplicate key value violates unique constraint app_settings_key_key»

## Problem
Beim Speichern/Importieren der Kontrollliste (Menüpunkt «Besatzung & Produktivität») schlägt das
Speichern mit einem **Unique-Constraint-Fehler** auf `app_settings_key_key` fehl:
> duplicate key value violates unique constraint "app_settings_key_key"

Ursache: Es wird ein **INSERT** in `app_settings` (Spalte `key` ist UNIQUE) gemacht, obwohl für
diesen `key` bereits eine Zeile existiert (z. B. beim erneuten Import derselben Woche/desselben
Kontrolllisten-Zeitraums, oder weil Import-Status/Cache pro Mandant unter einem festen Key abgelegt
wird). Beim ersten Import klappt es, beim zweiten kollidiert der Key.

## Lösung — UPSERT statt INSERT
Das Schreiben in `app_settings` (und analog jede Persistenz des Kontrolllisten-Import-Status) auf
**UPSERT** umstellen, damit ein bestehender `key` **aktualisiert** statt neu eingefügt wird.

**Postgres/Supabase — Beispiel:**
```sql
INSERT INTO app_settings (key, value, updated_at)
VALUES ($1, $2, now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
```

**Supabase-Client — Beispiel:**
```js
await supabase
  .from('app_settings')
  .upsert({ key, value, updated_at: new Date().toISOString() },
          { onConflict: 'key' });
```

## Zusätzlich prüfen
- Falls der `key` **pro Mandant/Woche** eindeutig sein soll (OLIV vs. Beaulieu, KW-Zeitraum), den
  Key **zusammengesetzt** bilden (z. B. `kontrollliste_import:OLIV:2026-W34`) **oder** die
  Unique-Constraint auf `(mandant_id, key)` erweitern — damit OLIV und Beaulieu sich nicht
  gegenseitig überschreiben.
- Idempotenz: erneuter Import desselben Zeitraums darf **kein** Duplikat erzeugen, sondern den
  bestehenden Eintrag ersetzen (überschreiben), wie bei der bereits umgesetzten idempotenten
  Wochenhistorie.

## Akzeptanzkriterien
1. Kontrollliste importieren/speichern funktioniert **auch beim zweiten Mal** ohne Fehler.
2. Kein `duplicate key … app_settings_key_key` mehr.
3. Erneuter Import derselben Woche überschreibt sauber (idempotent), erzeugt keine Doppel-Zeile.
4. OLIV und Beaulieu beeinflussen sich beim Speichern nicht gegenseitig.
