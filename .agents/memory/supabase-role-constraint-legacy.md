---
name: Supabase Rollen-Constraint Altbestand
description: Historische Rollenwerte bei sicherheitsrelevanten user_profiles-Constraint-Änderungen.
---

Die Live-Datenbank kann in `user_profiles.role` noch den historischen Wert `manager` enthalten. Beim Ersetzen des Rollen-CHECKs muss dieser Wert als Bestandskompatibilität zulässig bleiben, darf aber in neuen Autorisierungsfunktionen keine Fähigkeit erhalten.

**Why:** Ein transaktionaler Live-Datenbanktest scheiterte beim Hinzufügen eines nur auf aktuelle App-Rollen begrenzten CHECKs, weil ein bestehendes Profil noch `manager` verwendete.

**How to apply:** Vor Rollen-Constraint-Härtungen vorhandene Werte read-only inventarisieren. Historische Werte nötigenfalls im CHECK erhalten, in der Berechtigungsmatrix aber explizit oder per deny-by-default verweigern.