# Bau-Auftrag für den Replit-Agenten — Modul «Personaleintritt & digitaler L-GAV-Arbeitsvertrag»

> **Kontext für den Agenten:** Dieses Modul wird **innerhalb** der bestehenden App *Staff Cost Control* gebaut (gleiches Replit-Projekt, gleiches Supabase-Projekt `ajflrvuzmkfspsxkdyfe`, gleicher Vite/React/TS-Frontend-Stack). Es ist **kein** separates Projekt. Der neu eingestellte Mitarbeiter muss am Ende im **Personalstamm** erscheinen und von dort in **Dienstplan** und **Auswertung** durchfliessen — d. h. es wird in dieselbe Mitarbeiter-Tabelle geschrieben, die der Personalstamm bereits liest.
>
> **Wichtig — vor dem Bauen prüfen (nicht raten):** Lies zuerst das bestehende Schema und passe die Feldnamen unten an die real existierenden Tabellen/Spalten an. Konkret zu ermitteln:
> 1. Exakter Name + vollständiges Schema der Mitarbeiter-/Personalstamm-Tabelle (inkl. `restaurant_id`, `abteilung`/`position`, `anstellung`, `eintritt`, `wochenstunden`/`pensum`, `status`).
> 2. Wie **Dienstplan** und **Auswertung** einen Mitarbeiter referenzieren (FK-Spalte, ID-Typ).
> 3. Ob bereits ein Storage-Bucket für Mitarbeiter-Dokumente existiert.
> 4. Wie `restaurant_id`/Tenant heute gesetzt wird (bekannt: `'oliv'` / `'beaulieu'` via `TenantContext`).
>
> Der Personalstamm wurde soeben überarbeitet (kompakte 7-Spalten-Liste; Status *Aktiv / Eintritt geplant / Ausgetreten* wird aus den Supabase-Stammdaten abgeleitet; Pensum = Wochenstunden/42; Eintritt TT.MM.JJJJ). **Dieses Modul muss genau diese Felder befüllen**, damit ein neuer Eintritt sofort als *«Eintritt geplant»* erscheint.

---

## 1. Ziel in einem Satz

Ein mobil-first, dreistufiger Prozess: Der **Geschäftsführer** (GF) erfasst die Eckdaten und löst einen persönlichen Link aus → der **neue Mitarbeiter** füllt am Handy die restlichen Vertrags- **und** Lohnprogramm-Felder aus und lädt Dokumente hoch → das **Backoffice** erhält alles gebündelt, füllt per Knopfdruck das **Original-L-GAV-PDF** aus, erzeugt einen **MIRUS-Export** und schickt den Vertrag zur **digitalen Unterschrift** (Skribble). Der Mitarbeiter landet automatisch im Personalstamm.

---

## 2. Datenmodell (Supabase / Postgres)

Neue Tabelle `personaleintritt` (Arbeits-/Entwurfsdatensatz, getrennt vom finalen Personalstamm bis zur Freigabe):

```sql
create table if not exists personaleintritt (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   text not null check (restaurant_id in ('oliv','beaulieu')),
  status          text not null default 'entwurf'
                  check (status in ('entwurf','eingeladen','ausgefuellt','geprueft','vertrag_gesendet','unterzeichnet','uebernommen','abgebrochen')),

  -- Phase 1: GF-Eckdaten
  vertragstyp     text check (vertragstyp in ('SL','ML')),   -- Stundenlohn / Monatslohn
  betrieb         text,
  funktion        text,
  eintritt        date,
  pensum_prozent  numeric,           -- nur ML; SL = unregelmässig
  probezeit_tage  int default 90,
  vertragsdauer   text check (vertragsdauer in ('unbefristet','befristet')),
  befristet_bis   date,

  -- Lohn-Erfassung (3 Modi, siehe §4)
  lohn_modus      text check (lohn_modus in ('grundlohn','mindestlohn','zieltotal')),
  lohnklasse      text,              -- Ia, Ib, II, IIIa, IIIb, IV
  grundlohn       numeric,           -- Modus A: Brutto exkl. 13.
  ziel_total      numeric,           -- Modus C: gewünschtes Total inkl. alles
  lohn_berechnet  numeric,           -- Ergebnis der Rückrechnung (Basislohn, der ins PDF/MIRUS geht)
  lohn_einheit    text check (lohn_einheit in ('monat','stunde')),

  -- Phase 2: Mitarbeiterdaten (Vertrag + Lohnprogramm) als strukturiertes JSON
  ma_daten        jsonb default '{}'::jsonb,

  -- Einladung
  invite_token    text unique,
  invite_expires  timestamptz,
  eingeladen_am   timestamptz,
  ausgefuellt_am  timestamptz,

  -- Ergebnis-Artefakte
  pdf_path        text,              -- ausgefülltes Vertrags-PDF im Bucket
  mirus_export_path text,
  skribble_request_id text,
  personalstamm_id uuid,             -- FK auf die reale Mitarbeiter-Tabelle nach Übernahme

  created_by      uuid references auth.users(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
```

`ma_daten` (jsonb) hält alle Phase-2-Felder gemäss dem gelieferten **Feldkatalog** (`Feldkatalog_Personaleintritt_Arbeitsvertrag.xlsx`). Struktur:

```jsonc
{
  "personalien": { "anrede":"", "name":"", "vorname":"", "strasse":"", "plz":"", "ort":"",
                   "geburtsdatum":"", "heimatort_nationalitaet":"", "telefon":"", "email":"" },
  "vertrag":     { "arbeitsort":"", "wochenstunden":"", "ferientage":"", "kuendigungsfrist":"",
                   "13_monatslohn": true, "lohnauszahlung_monatlich": true /* ... alle Häkchen aus SL/ML */ },
  "lohnprogramm":{ "zivilstand":"", "ahv_nr":"", "iban":"", "bank":"",
                   "ausweisart":"", "ausweis_nr":"", "aufenthaltsbewilligung":"",
                   "konfession":"", "ehepartner": { "name":"","erwerbstaetig":false },
                   "kinder":[ { "name":"","geburtsdatum":"","familienzulage_bei":"" } ] },
  "dokumente":   { "ahv_karte":"path", "ausweis_vorne":"path", "ausweis_hinten":"path", "bankkarte":"path", "foto":"path" }
}
```

**Mindestlohn-Konfiguration — jährlich aktualisierbar** (eigene Tabelle, nicht hartcodieren):

```sql
create table if not exists lgav_mindestlohn (
  jahr        int not null,
  klasse      text not null,        -- Ia, Ib, II, IIIa, IIIb, IV
  monat_x13   numeric not null,     -- CHF/Monat inkl. 13. (×13-Basis)
  primary key (jahr, klasse)
);
-- Seed 2026 (×13, inkl. 13.):
insert into lgav_mindestlohn (jahr,klasse,monat_x13) values
 (2026,'Ia',3713),(2026,'Ib',3943),(2026,'II',4070),
 (2026,'IIIa',4528),(2026,'IIIb',4635),(2026,'IV',5293)
on conflict do nothing;
```

Stundenlohn-Mindest = `monat_x13 × 13 / (52 × 42)`. Einführungszeit (Einarbeitung) darf −8 % betragen — als optionales Häkchen mit automatischer Reduktion. Die Mindestlohn-Prüfung (§4) liest **immer** aus dieser Tabelle für das Jahr des Eintritts.

---

## 3. Ablauf & Screens

### Phase 1 — GF erfasst Eckdaten (mobil)
Route `/personaleintritt/neu`. Sichtbar für Rolle *GF* (und Backoffice). Felder: Betrieb (aus Tenant vorbelegt), **Vertragstyp** (SL/ML als grosse Auswahl), Funktion, Beginn, Pensum (nur ML), Probezeit (Default 90 Tage), Vertragsdauer (unbefristet/befristet + Datum), **Lohn** (3 Modi, §4). Button **«Einladung an Mitarbeiter senden»** → erzeugt `invite_token` (kryptografisch zufällig, 32 Byte), setzt `status='eingeladen'`, `invite_expires = now()+14 Tage`, und verschickt den persönlichen Link per E-Mail und/oder SMS an den Mitarbeiter.

### Phase 2 — Mitarbeiter füllt aus (mobil, öffentlich per Token)
Route `/e/:token` — **ohne** Login, nur gültiger, nicht abgelaufener Token. Zeigt oben schreibgeschützt die GF-Eckdaten. Darunter alle Pflichtfelder aus dem Feldkatalog: Personalien, restliche Vertragsfelder **und** Lohnprogramm-Felder (Zivilstand, AHV-Nr., IBAN/Bank, Ausweisart+Nr., Aufenthaltsbewilligung, Konfession, Ehepartner, Kinder/Familienzulagen). **Datei-Uploads** (Kamera erlaubt): AHV-Karte, Ausweis Vorder-/Rückseite, Bankkarte, Foto. Zwischenspeichern möglich; Absenden setzt `status='ausgefuellt'`, `ausgefuellt_am=now()`.

### Phase 3 — Backoffice
Route `/personaleintritt` (Liste aller Eintritte mit Status-Badges, analog Personalstamm-Design). Detailansicht mit vier Aktionen:
1. **Vertrag erstellen** → füllt das Original-SL- bzw. -ML-PDF (§5), legt es unter `pdf_path` ab, Vorschau.
2. **MIRUS-Export** → erzeugt strukturierten Lohn-Export (§6).
3. **Zur Unterschrift senden** → Skribble (§7).
4. **In Personalstamm übernehmen** → schreibt Mitarbeiter in die reale Personalstamm-Tabelle (§8), `status='uebernommen'`.

---

## 4. Lohn-Erfassung — 3 Modi (GF, Phase 1)

Der **Basislohn**, der ins Vertrags-PDF und in MIRUS geht, wird je nach Modus so bestimmt:

**Modus A — «Grundlohn / Bruttolohn exkl. 13.»** — GF gibt den Monatsbrutto (exkl. 13.) oder den Stundenlohn direkt ein. `lohn_berechnet = grundlohn`. Mindestlohn-Prüfung gegen `lgav_mindestlohn`.

**Modus B — «Mindestlohn-Schnellwahl»** — Zwei Buttons: *Stundenvertrag* / *Monatsvertrag*. GF wählt die Lohnklasse (Ia … IV); das System setzt automatisch den Mindestlohn aus `lgav_mindestlohn` für das Eintrittsjahr. Bei Einführungszeit optional −8 %.

**Modus C — «Ziel-Total inkl. alles»** — GF gibt z. B. «5000/Monat» oder «26/Stunde» als *Total inkl. allem* ein; das System **rechnet zurück** auf den Basislohn:

- **Monatslohn (ML):** `Basis (Festlohn exkl. 13.) = Ziel × 12 / 13`.
- **Stundenlohn (SL):** `Basis = Ziel / (1 + 0.1065 + 0.0227 + 0.0833) = Ziel / 1.2125`
  (10.65 % Ferien + 2.27 % Feiertag + 8.33 % 13. Monatslohn). Die drei Zuschläge werden auf dem Vertrag separat ausgewiesen.

In allen Modi: **Warnung**, wenn `lohn_berechnet` unter dem geltenden L-GAV-Mindestlohn liegt (blockierend, ausser Einführungszeit-Häkchen aktiv). Ergebnis (`lohn_berechnet`, `lohn_einheit`, Zuschlags-Aufschlüsselung) transparent anzeigen, bevor der GF die Einladung auslöst.

---

## 5. PDF-Auto-Ausfüllung — Original-Design beibehalten

**Harte Anforderung des Kunden:** exakt das gelieferte PDF (SL bzw. ML), nur die Felder ausgefüllt — **kein** Nachbau. Beide Vorlagen sind bereits **AcroForm-Formulare** mit benannten Feldern (SL: 102 Felder, ML: 103 Felder). Die vollständige Feldnamen-Liste liegt in `SL_text.txt` / `ML_text.txt` (bzw. `contracts.json`).

Vorgehen: Vorlagen als Assets im Projekt ablegen. Beim «Vertrag erstellen» die AcroForm-Felder per Name aus `personaleintritt` + `ma_daten` befüllen (Server-seitig in einer Supabase Edge Function mit `pdf-lib`, oder per `pypdf`). Checkboxen über die exakten Häkchen-Feldnamen setzen. Optional **flatten** (Felder fixieren) für die Versandkopie; eine nicht-geflachte Version für spätere Korrekturen behalten. Ergebnis in Bucket `mitarbeiter-dokumente/{restaurant_id}/{id}/vertrag.pdf`.

---

## 6. MIRUS-Lohnexport

MIRUS ist das eingesetzte Lohnprogramm (Swiss Gastro/Hotellerie; Swissdec-zertifiziert; Schnittstelle MIRUS-CONNECT). **Vor dem finalen Anbinden mit dem MIRUS-Support das exakte Importformat bestätigen** (CSV/Excel-Mitarbeiterimport vs. MIRUS-CONNECT/API). Bis dahin: strukturierten Export bauen, der genau die Lohnprogramm-Felder liefert (Personalien, AHV-Nr., IBAN, Zivilstand, Konfession, Ehepartner, Kinder/Familienzulagen, Ausweis/Bewilligung, Eintritt, Funktion, Pensum, Basislohn + Lohnart). Diese Felder sind im Feldkatalog in Spalte **«Zweck»** als *Lohn* bzw. *beides* markiert und werden aus `ma_daten.lohnprogramm` + den Eckdaten gezogen.

---

## 7. Digitale Unterschrift — Skribble

Skribble (Schweizer Anbieter, ZertES/eIDAS-konform). Für Arbeitsverträge genügt **SES/AES** (QES optional). Flow: «Zur Unterschrift senden» erstellt eine Skribble-Signaturanfrage mit dem ausgefüllten PDF, Signierende = Mitarbeiter (+ ggf. Arbeitgeber), speichert `skribble_request_id`, setzt `status='vertrag_gesendet'`. Webhook/Poll auf Abschluss → signiertes PDF zurück in den Bucket, `status='unterzeichnet'`.

---

## 8. Übernahme in den Personalstamm (→ Dienstplan → Auswertung)

Beim «In Personalstamm übernehmen» einen Datensatz in die **reale Mitarbeiter-Tabelle** schreiben (Name aus dem tatsächlichen Schema — bitte ermitteln), gemappt auf die Personalstamm-Felder:

| Personalstamm-Feld | Quelle |
|---|---|
| Mitarbeiter (Name, Vorname) | `ma_daten.personalien` |
| Abteilung / Position | `funktion` |
| Anstellung (Vollzeit/Teilzeit/Aushilfe) | aus `vertragstyp` + `pensum_prozent` ableiten |
| Eintritt | `eintritt` |
| Wochenstunden (→ Pensum = /42) | `ma_daten.vertrag.wochenstunden` bzw. `pensum_prozent` |
| Status | initial *«Eintritt geplant»* (durch Eintritt in der Zukunft), automatisch → *Aktiv* |
| restaurant_id | `restaurant_id` |

`personalstamm_id` in `personaleintritt` zurückschreiben. Danach erscheint der Mitarbeiter automatisch in der bestehenden 7-Spalten-Personalstamm-Liste und ist im Dienstplan und in der Auswertung referenzierbar (FK-Struktur bitte aus dem bestehenden Schema übernehmen).

---

## 9. Sicherheit & UX

- **Mobile-first**: alle drei Phasen für das Handy optimiert; Uploads mit Kamera-Direktzugriff.
- **Token-Link** (Phase 2): unrätselbar, ablaufend (14 Tage), einmalige Nutzung nach Absenden; keine Personendaten in der URL.
- **RLS**: `personaleintritt` und der Dokumente-Bucket nur für authentifizierte Backoffice/GF-Rollen des jeweiligen `restaurant_id`; die öffentliche Phase-2-Route nur über eine Edge Function mit Token-Validierung (kein direkter Tabellenzugriff).
- **Storage-Bucket** `mitarbeiter-dokumente` (privat) für Uploads + PDFs; falls bereits ein Dokumente-Bucket existiert, diesen verwenden.
- **Validierung**: IBAN, AHV-Nr. (756.xxxx.xxxx.xx), Datumsformate, Pflichtfelder je Vertragstyp.

---

## 10. Reihenfolge der Umsetzung (Vorschlag)

1. Schema anlegen (`personaleintritt`, `lgav_mindestlohn`, Bucket + RLS) und bestehendes Personalstamm-Schema verifizieren.
2. Phase 1 (GF-Formular inkl. 3 Lohn-Modi + Mindestlohn-Prüfung) + Einladungsversand.
3. Phase 2 (Token-Route, Mitarbeiter-Formular, Uploads).
4. Phase 3 Backoffice-Liste + Detail; PDF-Auto-Ausfüllung (SL/ML).
5. Personalstamm-Übernahme (→ Dienstplan/Auswertung).
6. MIRUS-Export (Format mit Support bestätigen).
7. Skribble-Anbindung.

Jede Stufe einzeln testbar ausliefern.
