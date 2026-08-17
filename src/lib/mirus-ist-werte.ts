/**
 * mirus-ist-werte.ts
 * ==================
 * Persistente MIRUS-Roh-Tageswerte (Stunden je Mitarbeiter/Tag) — SSOT der
 * Stempeluhr für die Kontroll-Ansicht «MIRUS ↔ App Ist-Abgleich».
 *
 * Speicherung: Supabase app_settings (mandantenfähig)
 *   key   = "mirus_ist_werte:{tenantId}:{YYYY-MM}"
 *   value = { tenantId, month, werte: Record<"empId|date", number>, updatedAt }
 *
 * Regeln:
 *  - Dublettensicher: pro Schlüssel (Mitarbeiter + Datum + Mandant) wird beim
 *    Speichern ERSETZT, nie addiert — Mehrfach-Import summiert nichts.
 *  - Es werden ALLE aus der Datei aufgelösten Werte gespeichert (auch für
 *    Ausnahme-/MANUELL-Mitarbeiter): der Blob ist die MIRUS-Wahrheit, die
 *    Ausnahme-Regel greift nur beim SCHREIBEN der Ist-Stunden.
 *  - Best-effort beim Import (Rückgabe bool), STRIKT beim Lesen für die
 *    Kontroll-Ansicht (Lesefehler ≠ «keine Werte»).
 */

import { appSettingsTable } from '@/lib/app-settings-table';

export interface MirusIstWerteBlob {
  tenantId: string;
  month: string;                     // 'YYYY-MM'
  /** Key `${employeeId}|${date}` → MIRUS-Tagesstunden (>0; 0-Werte werden nicht gespeichert). */
  werte: Record<string, number>;
  updatedAt: string;
}

export const mirusWerteKey = (tenantId: string, month: string) =>
  `mirus_ist_werte:${tenantId}:${month}`;

export const mirusWertKey = (employeeId: string, date: string) => `${employeeId}|${date}`;

/** Strikt lesen (wirft bei DB-Fehler); fehlender Eintrag = leeres Objekt. */
export async function loadMirusIstWerteStrict(
  tenantId: string, month: string,
): Promise<Record<string, number>> {
  const { data, error } = await appSettingsTable()
    .select('value')
    .eq('key', mirusWerteKey(tenantId, month))
    .maybeSingle();
  if (error) throw new Error(`MIRUS-Werte konnten nicht gelesen werden: ${error.message}`);
  const val = (data?.value ?? null) as MirusIstWerteBlob | null;
  const raw = val?.werte;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** Mehrere Monate strikt lesen (Union; Keys kollidieren nie — Datum im Key). */
export async function loadMirusIstWerteForMonths(
  tenantId: string, months: Iterable<string>,
): Promise<Record<string, number>> {
  const uniq = [...new Set(months)];
  const blobs = await Promise.all(uniq.map(m => loadMirusIstWerteStrict(tenantId, m)));
  const out: Record<string, number> = {};
  for (const b of blobs) Object.assign(out, b);
  return out;
}

/**
 * Import-Werte einmergen: bestehenden Blob FRISCH laden, betroffene Keys
 * ERSETZEN (nie addieren), zurückschreiben. Werte ≤ 0 löschen den Key
 * (MIRUS 0 = kein Eintrag, leer statt 0). Best-effort: false bei Fehler.
 */
export async function mergeMirusIstWerte(
  tenantId: string, month: string,
  neueWerte: Record<string, number>,
): Promise<boolean> {
  try {
    const bestehend = await loadMirusIstWerteStrict(tenantId, month);
    const werte = { ...bestehend };
    for (const [k, v] of Object.entries(neueWerte)) {
      if (Number.isFinite(v) && v > 0) werte[k] = Math.round(v * 100) / 100;
      else delete werte[k];
    }
    const blob: MirusIstWerteBlob = {
      tenantId, month, werte, updatedAt: new Date().toISOString(),
    };
    const { error } = await appSettingsTable()
      .upsert({ key: mirusWerteKey(tenantId, month), value: blob }, { onConflict: 'key' });
    if (error) { console.error('[mirus-ist-werte] Speichern fehlgeschlagen:', error); return false; }
    return true;
  } catch (e) {
    console.error('[mirus-ist-werte] mergeMirusIstWerte:', e);
    return false;
  }
}
