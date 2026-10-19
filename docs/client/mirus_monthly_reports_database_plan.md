# Datenbankarchitektur — Arbeitszeiten & Monatsblätter (Mirus Import)

**Stand:** Mai 2026
**Status:** Architekturplan — noch keine Migration, noch keine Tabellen

---

## Überblick

Dieses Dokument beschreibt die geplante Supabase-Datenbankstruktur für das
Modul „Arbeitszeiten & Monatsblätter". Das Modul importiert die monatlichen
Mirus-Excel-Exporte, matched sie gegen den Personalstamm, speichert sie in
normalisierten Tabellen und ermöglicht Review, Beanstandung und Freigabe.

### Kernprinzipien

1. **Kein Datenverlust bei Re-Import:** UPSERT-basiert, nicht DELETE+INSERT
2. **Vollständige Audit-Kette:** jede Änderung hinterlässt einen Eintrag
3. **Statusmodell:** Import durchläuft Zustände (preview → pending → approved / rejected)
4. **Multi-Tenant:** `restaurant_id TEXT` auf jeder Tabelle (`'oliv'` | `'beaulieu'`)
5. **Mitarbeiter-Matching:** entkoppelt vom Import — Matching-Tabelle erlaubt manuelle Korrektur

---

## Tabellenübersicht

```
mirus_import_sessions          ← eine Zeile pro hochgeladener Excel-Datei
mirus_import_employees         ← ein Eintrag pro Mitarbeiter pro Session
mirus_import_days              ← ein Eintrag pro Tag pro Mitarbeiter
mirus_import_shifts            ← ein Eintrag pro Zeitblock pro Tag
mirus_import_totals            ← Monatstotale pro Mitarbeiter (aus Datei + berechnet)
mirus_employee_name_map        ← Mirus-Name → employees.id Mapping (manuell pflegbar)
mirus_import_issues            ← Beanstandungen / Rückfragen pro Mitarbeiter oder Tag
mirus_import_audit_log         ← vollständige Änderungshistorie (trigger-basiert)
```

---

## 1. `mirus_import_sessions`

Eine Zeile pro hochgeladener Excel-Datei. Hält den Gesamtstatus des Imports.

```sql
CREATE TABLE mirus_import_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     TEXT        NOT NULL,               -- 'oliv' | 'beaulieu'
  source_file_name  TEXT        NOT NULL,               -- Originaldateiname
  source_file_hash  TEXT,                               -- SHA-256 des Uploads (Duplikat-Erkennung)
  month             SMALLINT    NOT NULL,               -- 1–12
  year              SMALLINT    NOT NULL,               -- z.B. 2026
  status            TEXT        NOT NULL DEFAULT 'preview',
  -- Statuswerte: 'preview' | 'pending_review' | 'approved' | 'rejected' | 'archived'
  employee_count    SMALLINT,
  selected_count    SMALLINT,
  total_hours       NUMERIC(8,2),
  average_quality   SMALLINT,
  warning_count     SMALLINT,
  notes             TEXT,                               -- optionale Admin-Notiz
  created_by        TEXT        NOT NULL,               -- user email
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (restaurant_id, year, month, source_file_hash)
);
```

**Statusmodell:**

```
preview
  │   (Admin wählt MA aus, prüft Warnungen)
  ▼
pending_review
  │   (Session eingereicht zur Freigabe)
  ├──► approved   (Daten übernommen in produktive Schichttabelle)
  └──► rejected   (Zurückgewiesen mit Begründung)
       │
       └──► (Korrektur → erneut preview)

archived   (ältere freigegebene Sessions — read-only)
```

---

## 2. `mirus_import_employees`

Ein Eintrag pro Mitarbeiter pro Import-Session. Enthält den rohen
Mitarbeiter-Datensatz aus dem Excel plus das Matching-Ergebnis gegen den
Personalstamm.

```sql
CREATE TABLE mirus_import_employees (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID        NOT NULL REFERENCES mirus_import_sessions(id) ON DELETE CASCADE,
  restaurant_id       TEXT        NOT NULL,

  -- Rohdaten aus Excel (so wie der Parser sie geliefert hat)
  raw_name            TEXT,                             -- Name aus Mirus-Datei
  raw_department      TEXT,
  raw_cost_center     TEXT,
  raw_weekly_hours    NUMERIC(5,2),
  raw_employment_period TEXT,
  raw_sheet_name      TEXT,
  raw_block_start_row SMALLINT,
  raw_block_end_row   SMALLINT,
  raw_merged_count    SMALLINT    DEFAULT 1,

  -- Matching-Ergebnis
  matched_employee_id TEXT,                            -- employees.id (z.B. 'mueller-hans')
  match_confidence    TEXT,                            -- 'exact' | 'fuzzy' | 'manual' | 'unmatched'
  match_score         SMALLINT,                        -- 0–100
  match_notes         TEXT,                            -- z.B. "Namensabweichung: Müller vs Mueller"

  -- Qualität & Status
  quality_score       SMALLINT,
  import_status       TEXT        NOT NULL DEFAULT 'pending',
  -- Statuswerte: 'selected' | 'excluded' | 'pending' | 'approved' | 'rejected'
  is_selected         BOOLEAN     NOT NULL DEFAULT true,
  exclusion_reason    TEXT,

  -- Berechnete Felder (aus Tageszeilen)
  calculated_day_count  SMALLINT,
  calculated_total_hours NUMERIC(8,2),
  calculated_active_days SMALLINT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mirus_import_employees_session   ON mirus_import_employees(session_id);
CREATE INDEX idx_mirus_import_employees_matched   ON mirus_import_employees(matched_employee_id);
CREATE INDEX idx_mirus_import_employees_restaurant ON mirus_import_employees(restaurant_id, matched_employee_id);
```

---

## 3. `mirus_import_days`

Ein Eintrag pro Kalendertag pro Mitarbeiter. Enthält alle geparsten
Tagesdaten inklusive Rohdaten aus den Excel-Zellen.

```sql
CREATE TABLE mirus_import_days (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_employee_id  UUID        NOT NULL REFERENCES mirus_import_employees(id) ON DELETE CASCADE,
  session_id          UUID        NOT NULL,             -- denormalisiert für schnelle Abfragen
  restaurant_id       TEXT        NOT NULL,

  -- Tagesdaten
  date                DATE        NOT NULL,
  weekday             TEXT,                             -- 'Mo' | 'Di' | ... | 'So'
  absence_code        TEXT,                             -- 'FE' | 'KR' | 'KO' | ...
  break_minutes       SMALLINT,
  total_hours         NUMERIC(5,2),
  notes               TEXT,
  confidence          TEXT,                             -- 'high' | 'medium' | 'low'

  -- Rohdaten für Audit / Debugging
  raw_date_cell       TEXT,
  raw_work_time_cell  TEXT,
  raw_pause_cell      TEXT,
  raw_total_cell      TEXT,
  raw_remark_cell     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (import_employee_id, date)
);

CREATE INDEX idx_mirus_import_days_employee ON mirus_import_days(import_employee_id);
CREATE INDEX idx_mirus_import_days_date     ON mirus_import_days(session_id, date);
```

---

## 4. `mirus_import_shifts`

Ein Eintrag pro Zeitblock (From–To) pro Tag. Ein Tag kann mehrere Zeitblöcke haben
(z.B. Früh- und Abenddienst).

```sql
CREATE TABLE mirus_import_shifts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_day_id       UUID        NOT NULL REFERENCES mirus_import_days(id) ON DELETE CASCADE,
  import_employee_id  UUID        NOT NULL,             -- denormalisiert
  session_id          UUID        NOT NULL,             -- denormalisiert

  shift_index         SMALLINT    NOT NULL DEFAULT 0,   -- 0 = erster Block, 1 = zweiter, ...
  time_from           TIME,                             -- z.B. 08:00
  time_to             TIME,                             -- z.B. 16:30
  duration_hours      NUMERIC(5,2),                    -- berechnet: (to - from - pause)
  department          TEXT,                             -- optionale Abteilungszuordnung

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mirus_import_shifts_day ON mirus_import_shifts(import_day_id);
```

---

## 5. `mirus_import_totals`

Monatstotale pro Mitarbeiter — sowohl aus der Excel-Datei geparst als auch
aus den Tageszeilen berechnet. Ermöglicht den Cross-Check.

```sql
CREATE TABLE mirus_import_totals (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  import_employee_id    UUID        NOT NULL UNIQUE REFERENCES mirus_import_employees(id) ON DELETE CASCADE,
  session_id            UUID        NOT NULL,

  -- Aus Excel geparste Werte (HH:MM oder Dezimal als Text, so wie im Blatt)
  total_hours_raw       TEXT,
  pause_total_raw       TEXT,
  netto_total_raw       TEXT,
  soll_stunden_raw      TEXT,
  ueberzeit_raw         TEXT,
  zeitzuschlag_raw      TEXT,
  saldo_raw             TEXT,
  ferien_raw            TEXT,
  feiertag_raw          TEXT,
  kompensation_raw      TEXT,
  krankheit_raw         TEXT,

  -- Normalisiert (Dezimalstunden, berechnet aus raw)
  total_hours_decimal   NUMERIC(8,2),
  ueberzeit_decimal     NUMERIC(8,2),
  saldo_decimal         NUMERIC(8,2),
  ferien_decimal        NUMERIC(8,2),

  -- Cross-Check: Summe aus Tageszeilen
  calculated_total_hours NUMERIC(8,2),
  totals_diff           NUMERIC(6,2),                  -- |total_hours_decimal - calculated|
  totals_validated      BOOLEAN     DEFAULT false,      -- true wenn diff < 1h

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 6. `mirus_employee_name_map`

Mapping-Tabelle: Mirus-Rohname → Personalstamm-ID.
Erlaubt manuelles Pflegen von Abweichungen (Umlaute, Abkürzungen, Namenswechsel).

```sql
CREATE TABLE mirus_employee_name_map (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     TEXT        NOT NULL,

  -- Mirus-Seite
  mirus_raw_name    TEXT        NOT NULL,               -- z.B. "Mueller, Hans"
  mirus_name_norm   TEXT,                               -- normalisiert (lowercase, ohne Sonderzeichen)

  -- Personalstamm-Seite
  employee_id       TEXT        NOT NULL,               -- employees.id
  employee_name     TEXT,                               -- Anzeigename (denormalisiert)

  -- Matching-Metadaten
  match_type        TEXT        NOT NULL DEFAULT 'manual',
  -- 'exact' | 'fuzzy_auto' | 'manual' | 'alias'
  confidence        SMALLINT,                           -- 0–100 (für fuzzy)
  notes             TEXT,                               -- z.B. "Heirat 03/2025: Huber → Baumann"

  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (restaurant_id, mirus_raw_name)
);

CREATE INDEX idx_mirus_name_map_employee ON mirus_employee_name_map(restaurant_id, employee_id);
CREATE INDEX idx_mirus_name_map_norm     ON mirus_employee_name_map(restaurant_id, mirus_name_norm);
```

**Matching-Algorithmus (geplant, noch nicht implementiert):**

```
1. Exact-Match:     mirus_raw_name == employees.name (case-insensitive, trim)
2. Normalisiert:    Umlaute ersetzen (ä→ae, ö→oe, ü→ue), Komma-Trennung umkehren
3. Fuzzy-Match:     Levenshtein-Distanz ≤ 2 auf normalisierten Namen
4. Manuell:         Admin wählt in der UI den richtigen Mitarbeiter → Eintrag in name_map
5. Alias:           Einmal manuell gemappt → wird für alle zukünftigen Importe übernommen
```

---

## 7. `mirus_import_issues`

Beanstandungen und Rückfragen auf Session-, Mitarbeiter- oder Tages-Ebene.
Ermöglicht strukturiertes Review mit Gesprächshistorie.

```sql
CREATE TABLE mirus_import_issues (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID        NOT NULL REFERENCES mirus_import_sessions(id) ON DELETE CASCADE,
  import_employee_id    UUID        REFERENCES mirus_import_employees(id) ON DELETE CASCADE,
  import_day_id         UUID        REFERENCES mirus_import_days(id) ON DELETE SET NULL,

  -- Klassifizierung
  severity              TEXT        NOT NULL,           -- 'error' | 'warning' | 'info'
  category              TEXT        NOT NULL,
  -- Kategorien: 'name_mismatch' | 'no_match' | 'totals_deviation' |
  --             'missing_days' | 'excessive_hours' | 'quality_low' |
  --             'manual_correction' | 'admin_note'
  message               TEXT        NOT NULL,
  detail                JSONB,                          -- strukturierte Zusatzdaten

  -- Status der Beanstandung
  status                TEXT        NOT NULL DEFAULT 'open',
  -- 'open' | 'acknowledged' | 'resolved' | 'overridden'
  resolved_by           TEXT,
  resolved_at           TIMESTAMPTZ,
  resolution_note       TEXT,

  -- Wer hat die Beanstandung erstellt
  created_by            TEXT        NOT NULL,           -- 'system' | user email
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mirus_issues_session  ON mirus_import_issues(session_id);
CREATE INDEX idx_mirus_issues_employee ON mirus_import_issues(import_employee_id);
CREATE INDEX idx_mirus_issues_status   ON mirus_import_issues(session_id, status);
```

---

## 8. `mirus_import_audit_log`

Vollständige unveränderliche Änderungshistorie. Wird per Trigger befüllt —
keine direkten Inserts durch die Applikation.

```sql
CREATE TABLE mirus_import_audit_log (
  id              BIGSERIAL   PRIMARY KEY,
  table_name      TEXT        NOT NULL,
  record_id       UUID        NOT NULL,
  session_id      UUID,                               -- denormalisiert für schnelle Filterung
  restaurant_id   TEXT,
  operation       TEXT        NOT NULL,               -- 'INSERT' | 'UPDATE' | 'DELETE'
  old_values      JSONB,
  new_values      JSONB,
  changed_fields  TEXT[],                             -- Array der geänderten Felder
  changed_by      TEXT        NOT NULL,               -- user email oder 'system'
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kein Update, kein Delete — append-only
CREATE INDEX idx_mirus_audit_session ON mirus_import_audit_log(session_id);
CREATE INDEX idx_mirus_audit_record  ON mirus_import_audit_log(table_name, record_id);
CREATE INDEX idx_mirus_audit_time    ON mirus_import_audit_log(changed_at DESC);
```

**Trigger-Schema (für jede relevante Tabelle):**

```sql
CREATE OR REPLACE FUNCTION mirus_audit_trigger_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mirus_import_audit_log
    (table_name, record_id, session_id, restaurant_id, operation, old_values, new_values, changed_by, changed_at)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.session_id, OLD.session_id),
    COALESCE(NEW.restaurant_id, OLD.restaurant_id),
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE row_to_json(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END,
    current_setting('app.current_user', true),
    now()
  );
  RETURN NEW;
END;
$$;

-- Anwenden auf:
CREATE TRIGGER mirus_sessions_audit  AFTER INSERT OR UPDATE OR DELETE ON mirus_import_sessions  FOR EACH ROW EXECUTE FUNCTION mirus_audit_trigger_fn();
CREATE TRIGGER mirus_employees_audit AFTER INSERT OR UPDATE OR DELETE ON mirus_import_employees FOR EACH ROW EXECUTE FUNCTION mirus_audit_trigger_fn();
CREATE TRIGGER mirus_issues_audit    AFTER INSERT OR UPDATE OR DELETE ON mirus_import_issues    FOR EACH ROW EXECUTE FUNCTION mirus_audit_trigger_fn();
```

---

## 9. Row Level Security (RLS)

### Grundprinzip

```sql
ALTER TABLE mirus_import_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_import_employees     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_import_days          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_import_shifts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_import_totals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_employee_name_map    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirus_import_issues        ENABLE ROW LEVEL SECURITY;
-- audit_log: nur service_role darf lesen, kein direkter Zugriff
```

### Rollenzuordnung

| Rolle | Rechte |
|---|---|
| `admin` | Vollzugriff auf alle Sessions und Restaurants |
| `service_manager` | Lesen aller Sessions für `restaurant_id = 'oliv'`; Einreichen (pending_review) |
| `kueche_manager` | Lesen eigener Monatsblätter (gefiltert nach Department) |
| `beaulieu_manager` | Vollzugriff für `restaurant_id = 'beaulieu'` |
| `beaulieu_viewer` | Lesezugriff für `restaurant_id = 'beaulieu'` |

### RLS-Policies (Beispiel für `mirus_import_sessions`)

```sql
-- Admin: alles
CREATE POLICY "admin_full_access" ON mirus_import_sessions
  FOR ALL TO authenticated
  USING (
    (SELECT role FROM employees WHERE id = auth.uid()::text) = 'admin'
  );

-- service_manager: nur oliv, nur approved/pending lesen; preview einreichen
CREATE POLICY "service_manager_oliv" ON mirus_import_sessions
  FOR SELECT TO authenticated
  USING (
    restaurant_id = 'oliv'
    AND (SELECT role FROM employees WHERE id = auth.uid()::text) = 'service_manager'
  );

-- beaulieu_manager: nur beaulieu
CREATE POLICY "beaulieu_manager_access" ON mirus_import_sessions
  FOR ALL TO authenticated
  USING (
    restaurant_id = 'beaulieu'
    AND (SELECT role FROM employees WHERE id = auth.uid()::text) IN ('beaulieu_manager', 'admin')
  );
```

---

## 10. Import-Workflow (End-to-End)

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1 — Preview (Browser, kein DB-Write)                         │
│                                                                     │
│  Excel hochladen → parseMirusExcel() → buildPreviewSession()        │
│  PreviewImportSession im lokalen State                              │
│  Benutzer prüft Mitarbeiter, Tage, Totale, Warnungen               │
│  Benutzer wählt aus: ☑ Importieren / ☐ Nicht importieren           │
└────────────────────────┬────────────────────────────────────────────┘
                         │  "Zur Prüfung einreichen"
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 2 — Session speichern (erste DB-Writes)                      │
│                                                                     │
│  INSERT mirus_import_sessions  (status = 'pending_review')         │
│  INSERT mirus_import_employees (pro ausgewähltem MA)               │
│  INSERT mirus_import_days      (pro Tag pro MA)                    │
│  INSERT mirus_import_shifts    (pro Zeitblock pro Tag)             │
│  INSERT mirus_import_totals    (pro MA)                            │
│  INSERT mirus_import_issues    (system-generierte Warnungen)       │
│                                                                     │
│  Namens-Matching:                                                   │
│    1. Lookup in mirus_employee_name_map                             │
│    2. Exact-Match → employees                                       │
│    3. Fuzzy-Match → Vorschlag                                       │
│    4. Kein Match → Issue 'no_match' erstellt                        │
└────────────────────────┬────────────────────────────────────────────┘
                         │  Admin / Manager öffnet Review-UI
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 3 — Review (Admin)                                           │
│                                                                     │
│  Session-Übersicht → alle Issues sehen                             │
│  Pro Mitarbeiter:                                                   │
│    - Tage prüfen, Zeitblöcke bestätigen                            │
│    - Issues als 'resolved' / 'overridden' markieren                │
│    - Fehlende Matches manuell setzen (→ name_map Update)           │
│    - Beanstandungen hinzufügen                                     │
│  Status: pending_review → (alle Issues closed?) → freigeben        │
└────────────────────────┬────────────────────────────────────────────┘
                         │  "Freigeben"
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 4 — Freigabe (Produktiv-Write)                               │
│                                                                     │
│  UPDATE mirus_import_sessions SET status = 'approved'              │
│  UPSERT in produktive Schichttabelle (schedule_entries o.ä.)       │
│  Audit-Log wird automatisch per Trigger befüllt                    │
│  Benachrichtigung (optional): betroffene Manager                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. Versionierung & Re-Import

### Problem
Gleiche Periode kann mehrfach importiert werden (korrigierte Datei, Nachlieferung).

### Lösung

- `source_file_hash` (SHA-256) verhindert exakt-identische Duplikate
- Unterschiedliche Datei → neue Session für gleichen Monat möglich
- Status `archived` für ältere Versionen derselben Periode
- Beim Freigeben einer neuen Version: vorherige Session → `archived`

```sql
-- Vor Freigabe einer neuen Session prüfen:
UPDATE mirus_import_sessions
SET status = 'archived'
WHERE restaurant_id = $1
  AND year = $2
  AND month = $3
  AND status = 'approved'
  AND id != $new_session_id;
```

---

## 12. Wie `PreviewImportSession` gespeichert wird

Die aktuelle `PreviewImportSession` (TypeScript-Typ) wird in Phase 2 in die
normalisierten Tabellen überführt. Mapping:

| PreviewImportSession | DB-Tabelle | Felder |
|---|---|---|
| `session.*` | `mirus_import_sessions` | alle Meta-Felder |
| `session.employees[n]` | `mirus_import_employees` | rohe + gematchte Felder |
| `session.employees[n].days[d]` | `mirus_import_days` | Tagesdaten |
| `session.employees[n].days[d].shifts[s]` | `mirus_import_shifts` | Zeitblöcke |
| `session.employees[n].totals` | `mirus_import_totals` | alle Totale |
| `session.employees[n].warnings[w]` | `mirus_import_issues` | mit `created_by = 'system'` |
| `session.globalWarnings[w]` | `mirus_import_issues` | ohne `import_employee_id` |

Die Konvertierung erfolgt in einer neuen Funktion `commitPreviewSession(session, userId)`:

```typescript
// Geplante Signatur (noch nicht implementiert)
async function commitPreviewSession(
  session:      PreviewImportSession,
  userId:       string,
  restaurant:   'oliv' | 'beaulieu',
): Promise<{ sessionId: string; errors: string[] }>
```

---

## 13. Mitarbeiter-Matching — Detail

### Normalisierung (Mirus-Name → Vergleichsstring)

```typescript
function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/,\s*/g, ' ')      // "Müller, Hans" → "muellerhans"
    .replace(/\s+/g, '')
    .trim();
}
```

### Matching-Reihenfolge

```
1. name_map lookup     → sofortiger Treffer (manuell gepflegt)
2. Exact (normalisiert) → employees WHERE normalize(name) = normalize(raw)
3. Fuzzy              → Levenshtein ≤ 2 → Kandidat mit Score 70–99
4. Kein Treffer       → issue 'no_match', match_confidence = 'unmatched'
```

### Manuelle Korrektur in UI

- Admin sieht ungematchte Mitarbeiter
- Dropdown: Personalstamm-Suche
- Auswahl → INSERT in `mirus_employee_name_map` (match_type = 'manual')
- Gilt für alle zukünftigen Importe mit gleichem Rohnamen

---

## 14. Beanstandungen und Bestätigungen

### System-generierte Beanstandungen (auto bei Phase 2)

| Kategorie | Auslöser |
|---|---|
| `no_match` | Mitarbeiter nicht im Personalstamm gefunden |
| `totals_deviation` | `totals_diff > 3h` |
| `missing_days` | < 20 Tage erkannt (ausser Teilmonate) |
| `excessive_hours` | `calculated_total_hours > 250` |
| `quality_low` | `quality_score < 85` |
| `no_cost_center` | `raw_cost_center` leer |
| `merge_info` | Mitarbeiter aus mehreren Blöcken zusammengeführt |

### Benutzer-Beanstandungen (manuell in Review-UI)

```sql
INSERT INTO mirus_import_issues (
  session_id, import_employee_id, import_day_id,
  severity, category, message,
  created_by
) VALUES (
  $session_id, $employee_id, NULL,
  'warning', 'manual_correction',
  'Stunden stimmen nicht mit Rapportzettel überein',
  $user_email
);
```

### Bestätigungen (Resolution)

```sql
UPDATE mirus_import_issues
SET
  status          = 'resolved',
  resolved_by     = $user_email,
  resolved_at     = now(),
  resolution_note = 'Geprüft und korrekt — Mitarbeiter arbeitet 2 Restaurants'
WHERE id = $issue_id;
```

### Freigabe-Bedingung

Eine Session kann erst freigegeben werden, wenn:
- Alle Issues mit `severity = 'error'` sind `resolved` oder `overridden`
- Alle Mitarbeiter haben `matched_employee_id IS NOT NULL` oder sind `excluded`

---

## 15. Noch nicht entschieden / offene Fragen

| Frage | Optionen |
|---|---|
| Produktive Schichttabelle | Neue `schedule_entries`-Tabelle ODER Update bestehender `schedules`-Logik? |
| Freigabe-Notification | E-Mail via Supabase Edge Functions? Push-Notification? |
| Mitarbeiter-Selbst-Review | Sollen Mitarbeiter ihre eigenen Blätter einsehen können? |
| Lohnkosten-Anbindung | Direkter Link Schicht → Lohnkosten-Berechnung nach Freigabe? |
| Export nach Freigabe | PDF-Export des freigegebenen Monatsblatts? |
| Archivierungs-Frist | Wie lange werden Rohdaten aufbewahrt? (DSGVO-relevant) |

---

## Nächste Schritte (nach Freigabe dieses Plans)

1. **Review dieses Plans** mit Stakeholdern
2. **SQL-Migration schreiben** (`supabase/migrations/20260XXX_mirus_tables.sql`)
3. **`commitPreviewSession()`** implementieren (Phase 2 Write-Funktion)
4. **Matching-Algorithmus** implementieren (`src/lib/mirus-name-matching.ts`)
5. **Review-UI** aufbauen (auf Basis der bestehenden Import-Preview-Seite)
6. **RLS-Policies** definieren und testen
7. **Echten Import-Button** aktivieren (Phase 4)

---

*Dokument erstellt: Mai 2026 — Architekturplan, noch keine Migration*
