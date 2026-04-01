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

import type { Employee } from '@/types/personnel';

const STORAGE_KEY = 'mirus_name_mappings_v1';

export type MirusNameMapping = Record<string, string | 'skip'>;

// ─── Name-Matching-Logik (geteilt zwischen Import-Schritten) ─────────────────

export type NameMatchType = 'exact' | 'saved' | 'firstName' | 'new';

export interface EmployeeMatchResult {
  employee: Employee | null;
  matchType: NameMatchType;
  /** Schritt der zum Match geführt hat (für Debug-Logging) */
  matchStep: string;
}

/**
 * Findet den passenden Mitarbeiter für einen aus Mirus importierten Namen.
 *
 * Matching-Reihenfolge:
 *  1. Gespeicherte Zuordnung aus localStorage (manuell bestätigt)
 *  2. Exakter case-insensitiver Vergleich
 *  3. Umgekehrte Wortreihenfolge exakt (Mirus: "Nachname Vorname" ↔ System: "Vorname Nachname")
 *  4. Wort-Scoring: exakter Wortmatch +2, Präfix-Match (≥4 Zeichen) +1
 *  5. Erstes Wort als Vorname
 *  6. Letztes Wort als Nachname
 *
 * @param importedName  Name wie er im Mirus-Export steht
 * @param existingEmps  Liste aller bekannten Mitarbeiter
 * @param debug         true = Console-Log für diesen Namen ausgeben
 */
export function matchEmployeeByName(
  importedName: string,
  existingEmps: Employee[],
  debug = false,
): EmployeeMatchResult {
  const log = debug
    ? (...args: unknown[]) => console.log('[Ist-Match]', importedName, '→', ...args)
    : () => undefined;

  // 1. Gespeicherte Zuordnung
  const savedId = lookupSavedMapping(importedName);
  if (savedId && savedId !== 'skip') {
    const emp = existingEmps.find(e => e.id === savedId);
    if (emp) {
      log('saved mapping', emp.name);
      return { employee: emp, matchType: 'saved', matchStep: 'saved' };
    }
  }
  if (savedId === 'skip') {
    log('skip (saved)');
    return { employee: null, matchType: 'new', matchStep: 'skip' };
  }

  const norm = importedName.toLowerCase().trim();
  const importParts = norm.split(/\s+/).filter(p => p.length > 0);

  // 2. Exakter Match
  const exact = existingEmps.find(e => e.name.toLowerCase().trim() === norm);
  if (exact) {
    log('exact', exact.name);
    return { employee: exact, matchType: 'exact', matchStep: 'exact' };
  }

  // 3. Umgekehrte Wortreihenfolge exakt
  const reversed = [...importParts].reverse().join(' ');
  const reversedExact = existingEmps.find(e => e.name.toLowerCase().trim() === reversed);
  if (reversedExact) {
    log('reversed-exact', reversedExact.name, '(reversed:', reversed, ')');
    return { employee: reversedExact, matchType: 'exact', matchStep: 'reversed-exact' };
  }

  // 4. Wort-Scoring
  const candParts = importParts.filter(p => p.length > 2);
  if (candParts.length > 0) {
    let bestScore = 0;
    let bestEmp: Employee | null = null;
    for (const emp of existingEmps) {
      const empParts = emp.name.toLowerCase().trim().split(/\s+/);
      let score = 0;
      for (const ip of candParts) {
        for (const ep of empParts) {
          if (ep === ip) { score += 2; break; }
          if ((ep.startsWith(ip) && ip.length >= 4) || (ip.startsWith(ep) && ep.length >= 4)) {
            score += 1; break;
          }
        }
      }
      if (score > bestScore) { bestScore = score; bestEmp = emp; }
    }
    if (bestEmp && bestScore > 0) {
      log('word-score', bestEmp.name, '(score:', bestScore, ')');
      return { employee: bestEmp, matchType: 'firstName', matchStep: `word-score:${bestScore}` };
    }
  }

  // 5. Erstes Wort (Vorname)
  const firstName = importParts[0] ?? '';
  const firstMatch = existingEmps.find(
    e => e.name.toLowerCase().trim().split(/\s+/)[0] === firstName,
  );
  if (firstMatch) {
    log('first-word', firstMatch.name);
    return { employee: firstMatch, matchType: 'firstName', matchStep: 'first-word' };
  }

  // 6. Letztes Wort (Nachname)
  const lastName = importParts[importParts.length - 1] ?? '';
  if (lastName.length > 2) {
    const lastMatch = existingEmps.find(e => {
      const eParts = e.name.toLowerCase().trim().split(/\s+/);
      return eParts.some(ep => ep === lastName || ep.startsWith(lastName) || lastName.startsWith(ep));
    });
    if (lastMatch) {
      log('last-word', lastMatch.name);
      return { employee: lastMatch, matchType: 'firstName', matchStep: 'last-word' };
    }
  }

  log('no match');
  return { employee: null, matchType: 'new', matchStep: 'none' };
}

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
