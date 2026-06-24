---
name: Guest duplicate merge safety
description: Why the guest-merge flow is ordered/idempotent the way it is, and the constraints any future change must respect.
---

# Gäste-Duplikat-Zusammenführung — Sicherheitsmodell

Duplikat-Erkennung über die **normalisierte Telefonnummer** (`/gaeste/duplikate`,
admin-only). Zusammenführung läuft TS-orchestriert im Client (kein DB-RPC), weil
der Stack — wie die Import-Flows — **keine echten Transaktionen** über mehrere
Supabase-Aufrufe bietet.

## Reihenfolge (NICHT umstellen) — recoverable by design
Reservationen ZUERST auf den Master umhängen → CRM mergen → Master-Identität
fill-empty → Aggregate aus `reservation_records` NEU berechnen → prüfen dass
KEINE Reservation mehr an einem Duplikat hängt → erst dann Duplikat-Profile
löschen → best-effort Audit-Log.

**Why:** `reservation_records.guest_id` ist FK `ON DELETE SET NULL`. Würde man
zuerst löschen, würden Reservationen verwaisen (guest_id=null) = Datenverlust.
Move-first macht jeden Mid-Flow-Abbruch reparierbar: die Reservationen sind schon
am Master, ein erneuter Lauf vollendet den Rest. Das Lösch-Gate verhindert, dass
ein Duplikat mit noch anhängenden Reservationen gelöscht wird.

## Harte Regeln
- **Aggregate IMMER neu aus `reservation_records` berechnen, NIE bestehende
  Gast-Aggregate summieren.** Sonst doppeln sich Zähler bei Wiederholung.
- **`match_key` beim Identitäts-Fill NIE anfassen** (UNIQUE(restaurant_id,
  match_key) würde brechen). Nur leere Master-Identitätsfelder ergänzen.
- **CRM-Merge muss idempotent sein:** bool=OR, einfacher Text=fill-empty,
  Notizen/Allergien/Unverträglichkeiten=zeilenweise dedupe-Union. Wiederholung
  darf nichts aufschaukeln.
- **Jeder Read/Write mit `.eq('restaurant_id', tenant)`.** Die RLS unterscheidet
  nur „eingeloggt ja/nein", NICHT pro Mandant — Mandantentrennung liegt komplett
  im App-Code. Preflight lädt alle betroffenen Profile mandantengescopt und
  bricht ab, wenn eine ID fehlt/fremd ist (VOR jeder Schreiboperation).
- **Audit-Log = best-effort, wirft nie** und enthält **nur IDs + Zähler**
  (keine Gast-PII).
- **Import-Modul (`reservation-import-db.ts`) NICHT verändern** — die Aggregat-
  Neuberechnung ist in der Merge-DB bewusst dupliziert (identische Semantik).

## Bekannte Grenze (akzeptiert für v1)
fill-empty hält pro Gast nur EINE E-Mail/Telefonnummer am Master. Ein späterer
Import, der ein gelöschtes Duplikat nur über eine andere E-Mail wiederfindet,
kann ein neues Profil anlegen. Robuste Langfristlösung wäre eine Identitäts-
Alias-Tabelle.

## Tests
Reine Logik node-env synthetisch; die Merge-DB hat einen In-Memory-Supabase-Mock
(Builder führt select/update/delete/upsert gegen einen Store aus), der Move-first,
Recompute, Lösch-Gate, Cross-Tenant-Abbruch und PII-freies Log real durchspielt.
