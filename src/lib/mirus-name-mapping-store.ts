/**
 * Mirus Name-Mapping Store
 * =========================
 *
 * Speichert bestätigte Zuordnungen zwischen Mirus-Exportnamen und
 * Mitarbeiter-IDs im localStorage, damit beim nächsten Import dieselben
 * Namen automatisch erkannt werden.
 *
 * Schlüssel: 'mirus_name_mappings_v1'
 * Format:    Record<normalizedImportedName, employeeId | 'skip'>
 *
 * Regel: Nur «exakt gematchte» oder «manuell zugewiesene» Namen werden gespeichert.
 * «skip» bedeutet: dieser Name wird bei zukünftigen Importen stillschweigend übersprungen.
 */

const STORAGE_KEY = 'mirus_name_mappings_v1';

export type MirusNameMapping = Record<string, string | 'skip'>;

// ─── Lesen ────────────────────────────────────────────────────────────────────

export function loadNameMappings(): MirusNameMapping {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ─── Schreiben ────────────────────────────────────────────────────────────────

/**
 * Einzelne Zuordnung speichern oder aktualisieren.
 * importedName wird normalisiert (lowercase + trim) als Schlüssel.
 */
export function saveNameMapping(importedName: string, employeeId: string | 'skip'): void {
  const all = loadNameMappings();
  all[normalize(importedName)] = employeeId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * Mehrere Zuordnungen auf einmal speichern (nach einem Import-Bestätigungs-Dialog).
 */
export function saveNameMappingsBatch(
  mappings: Array<{ importedName: string; employeeId: string | 'skip' }>,
): void {
  const all = loadNameMappings();
  for (const { importedName, employeeId } of mappings) {
    if (employeeId) {
      all[normalize(importedName)] = employeeId;
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * Zuordnung für einen Namen löschen.
 */
export function removeNameMapping(importedName: string): void {
  const all = loadNameMappings();
  delete all[normalize(importedName)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * Alle gespeicherten Zuordnungen löschen.
 */
export function clearNameMappings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ─── Suchen ───────────────────────────────────────────────────────────────────

/**
 * Gespeicherte Mitarbeiter-ID für einen importierten Namen nachschlagen.
 * Gibt undefined zurück wenn keine Zuordnung gespeichert ist.
 */
export function lookupSavedMapping(importedName: string): string | 'skip' | undefined {
  const all = loadNameMappings();
  return all[normalize(importedName)];
}

/**
 * Normalisierung: lowercase + trim (für konsistente Schlüssel)
 */
function normalize(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Anzahl gespeicherter Zuordnungen.
 */
export function countSavedMappings(): number {
  return Object.keys(loadNameMappings()).length;
}
