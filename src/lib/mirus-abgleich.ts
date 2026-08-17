/**
 * mirus-abgleich.ts
 * =================
 * Pure Vergleichslogik für die Kontroll-Ansicht «MIRUS ↔ App Ist-Abgleich».
 *
 * Regeln (Spec-verbindlich):
 *  - Verglichen wird NUR, wo MIRUS einen Wert hat (persistierte Roh-Werte aus
 *    mirus-ist-werte). MIRUS = kein Eintrag ⇒ keine Zeile (Ist bleibt LEER).
 *  - Gezeigt werden nur echte Abweichungen |Δ| > 0.05 h.
 *  - Ausnahme-Mitarbeiter (erfassungsart MANUELL, z.B. Lokaj Mendim /
 *    Ramadani Mejdi) werden als «Ausnahme» markiert, NICHT als Fehler —
 *    ihre App-Werte sind gewollt und zählen nicht zu den fehlenden Stunden.
 *  - Leer statt 0: App-Ist ohne Eintrag ⇒ appStd = null.
 */

export interface AbgleichRow {
  employeeId: string;
  name: string;
  date: string;            // ISO
  mirusStd: number;        // > 0 (persistierter MIRUS-Tageswert)
  appStd: number | null;   // null = keine Ist-Zelle (leer)
  delta: number;           // mirusStd − (appStd ?? 0), gerundet 2 NK
  ausnahme: boolean;       // MANUELL-MA: markiert, kein Fehler
}

export interface AbgleichErgebnis {
  rows: AbgleichRow[];     // nur |Δ| > schwelle, sortiert Δ desc, dann Name/Datum
  /** Σ der in der App fehlenden Stunden (Δ > 0, ohne Ausnahmen). */
  fehlendeStunden: number;
  ausnahmeCount: number;
}

export const ABGLEICH_SCHWELLE_H = 0.05;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildMirusAbgleich(params: {
  /** Persistierte MIRUS-Werte, Key `${employeeId}|${date}`. */
  mirusWerte: Record<string, number>;
  /** App-Ist, Key `${employeeId}-${date}` (Supabase-Loader-Format). */
  appIst: Record<string, { hours: number; absenceType?: string | null }>;
  /** employeeId → Anzeigename (unbekannte IDs erscheinen mit der Roh-ID). */
  namen: Record<string, string>;
  /** employeeIds der Ausnahme-MA (erfassungsart MANUELL). */
  ausnahmen: Set<string>;
  /** Zeitraum-Grenzen (inklusive, ISO). */
  von: string;
  bis: string;
  schwelle?: number;
}): AbgleichErgebnis {
  const { mirusWerte, appIst, namen, ausnahmen, von, bis } = params;
  const schwelle = params.schwelle ?? ABGLEICH_SCHWELLE_H;
  const rows: AbgleichRow[] = [];
  let fehlend = 0;
  const ausnahmeEmps = new Set<string>();

  for (const [key, mirusStd] of Object.entries(mirusWerte)) {
    if (!(mirusStd > 0)) continue;
    const sep = key.indexOf('|');
    if (sep <= 0) continue;
    const employeeId = key.slice(0, sep);
    const date = key.slice(sep + 1);
    if (date < von || date > bis) continue;
    const app = appIst[`${employeeId}-${date}`] ?? null;
    const appStd = app ? r2(app.hours) : null;
    const delta = r2(mirusStd - (appStd ?? 0));
    if (Math.abs(delta) <= schwelle) continue;
    const ausnahme = ausnahmen.has(employeeId);
    rows.push({
      employeeId, date, mirusStd: r2(mirusStd), appStd, delta, ausnahme,
      name: namen[employeeId] ?? employeeId,
    });
    if (ausnahme) ausnahmeEmps.add(employeeId);
    else if (delta > 0) fehlend += delta;
  }

  rows.sort((a, b) =>
    // Ausnahmen ans Ende, sonst grösste fehlende Stunden zuerst
    Number(a.ausnahme) - Number(b.ausnahme) ||
    b.delta - a.delta ||
    a.name.localeCompare(b.name, 'de') ||
    a.date.localeCompare(b.date));

  return { rows, fehlendeStunden: r2(fehlend), ausnahmeCount: ausnahmeEmps.size };
}
