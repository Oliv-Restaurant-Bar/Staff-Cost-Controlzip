---
name: Pre-Migration-tolerante Supabase-Queries
description: Wie Code funktionsfähig bleibt, solange eine Migration (neue Spalte/Tabelle) noch nicht auf der Live-DB eingespielt ist.
---

Migrationen laufen manuell im Supabase SQL-Editor — Code muss VOR dem Einspielen voll funktionieren.

**Regeln:**
- Eine EXPLIZITE Spaltenliste, die eine erst per Migration entstehende Spalte nennt, schlägt vorher mit `42703` fehl; `select('*')` ist tolerant (liefert die Spalte einfach nicht). Schlanke Spaltenlisten (z. B. ohne grosse Blobs) dürfen deshalb nur vor-existierende Spalten nennen.
- Insert-Payloads: neue Spalten nur konditional spreaden (`...(cond ? { neue_spalte: x } : {})`), sonst scheitern auch Alt-Pfade.
- Fehlklassifikation zentral: fehlendes Schema erkennt man an Codes `42P01`/`PGRST205` (Tabelle) und `42703`/`PGRST204` (Spalte) PLUS Namens-Match in der Message — Leser geben dann leere Liste zurück (Migration fehlt ⇒ es KANN keine Daten geben), Schreiber geben einen sichtbaren Migrations-Hinweis.

**Why:** Live-DB und Code-Stand divergieren hier planmässig (DDL nie automatisch); stille Fehler oder kaputte Alt-Pfade wären sonst die Folge.
**How to apply:** Bei jedem Feature mit neuer Migration alle neuen Reads/Writes gegen die Live-DB OHNE Migration empirisch testen (Sandbox-Query genügt).
