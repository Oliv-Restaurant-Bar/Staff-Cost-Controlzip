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
  // Always log with [MATCH] prefix for debug names so output matches the
  // requested format (even when debug=false for non-targeted names).
  const log = (...args: unknown[]) => {
    if (debug) console.log('[MATCH]', `raw import name: "${importedName}" →`, ...args);
  };

  log(`processing against ${existingEmps.length} employees`);

  // 1. Gespeicherte Zuordnung (mirus_name_mappings_v1)
  const savedId = lookupSavedMapping(importedName);
  if (savedId && savedId !== 'skip') {
    const emp = existingEmps.find(e => e.id === savedId);
    if (emp) {
      log(`final resolved employee: "${emp.name}" via saved mapping`);
      console.log(`[MATCH] import row saved: yes (saved mapping) — ${importedName} → ${emp.name}`);
      return { employee: emp, matchType: 'saved', matchStep: 'saved' };
    }
    // Saved ID no longer matches any employee — fall through to heuristics
    log(`saved mapping id="${savedId}" not found in employee list, continuing`);
  }
  if (savedId === 'skip') {
    log('skip (saved mapping)');
    console.log(`[MATCH] import row saved: no (skip mapping) — ${importedName}`);
    return { employee: null, matchType: 'new', matchStep: 'skip' };
  }

  const norm = importedName.toLowerCase().trim();
  const importParts = norm.split(/\s+/).filter(p => p.length > 0);

  if (debug) {
    existingEmps.forEach(e => {
      console.log(`[MATCH] candidate employee: "${e.name}" (id=${e.id})`);
    });
  }

  // 2. Exakter Match (case-insensitiv)
  const exact = existingEmps.find(e => e.name.toLowerCase().trim() === norm);
  if (exact) {
    log(`final resolved employee: "${exact.name}" via exact match`);
    console.log(`[MATCH] import row saved: yes (exact) — ${importedName} → ${exact.name}`);
    return { employee: exact, matchType: 'exact', matchStep: 'exact' };
  }

  // 3. Umgekehrte Wortreihenfolge exakt ("Nachname Vorname" ↔ "Vorname Nachname")
  const reversed = [...importParts].reverse().join(' ');
  const reversedExact = existingEmps.find(e => e.name.toLowerCase().trim() === reversed);
  if (reversedExact) {
    log(`reversed-order match: "${reversed}" → "${reversedExact.name}"`);
    console.log(`[MATCH] reversed-order match: "${importedName}" ↔ "${reversedExact.name}"`);
    console.log(`[MATCH] import row saved: yes (reversed-exact) — ${importedName} → ${reversedExact.name}`);
    return { employee: reversedExact, matchType: 'exact', matchStep: 'reversed-exact' };
  }

  // 3b. Jedes Token des Importnamens als vollständiger Mitarbeitername prüfen
  // Fängt Fälle wie "Momand Sajed" → "Sajed" (nur-Vorname im System) zuverlässig ab.
  for (const token of importParts) {
    if (token.length < 3) continue;
    const tokenFullMatch = existingEmps.find(e => e.name.toLowerCase().trim() === token);
    if (tokenFullMatch) {
      log(`token-full-name match: token="${token}" → "${tokenFullMatch.name}"`);
      console.log(`[MATCH] reversed-order match: token "${token}" is full employee name "${tokenFullMatch.name}"`);
      console.log(`[MATCH] final resolved employee: "${tokenFullMatch.name}" via token-full-name`);
      console.log(`[MATCH] import row saved: yes (token-full-name) — ${importedName} → ${tokenFullMatch.name}`);
      return { employee: tokenFullMatch, matchType: 'exact', matchStep: `token-full:${token}` };
    }
  }

  // 4. Wort-Scoring: exakter Wortmatch +2, Präfix-Match (≥4 Zeichen) +1
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
      if (debug && score > 0) {
        console.log(`[MATCH] candidate employee: "${emp.name}" word-score=${score}`);
      }
      if (score > bestScore) { bestScore = score; bestEmp = emp; }
    }
    if (bestEmp && bestScore > 0) {
      log(`final resolved employee: "${bestEmp.name}" via word-score=${bestScore}`);
      console.log(`[MATCH] import row saved: yes (word-score:${bestScore}) — ${importedName} → ${bestEmp.name}`);
      return { employee: bestEmp, matchType: 'firstName', matchStep: `word-score:${bestScore}` };
    }
  }

  // 5. Erstes Token als Vorname
  const firstName = importParts[0] ?? '';
  const firstMatch = existingEmps.find(
    e => e.name.toLowerCase().trim().split(/\s+/)[0] === firstName,
  );
  if (firstMatch) {
    log(`final resolved employee: "${firstMatch.name}" via first-word match`);
    console.log(`[MATCH] import row saved: yes (first-word) — ${importedName} → ${firstMatch.name}`);
    return { employee: firstMatch, matchType: 'firstName', matchStep: 'first-word' };
  }

  // 6. Letztes Token als Nachname (fallback)
  const lastName = importParts[importParts.length - 1] ?? '';
  if (lastName.length > 2) {
    const lastMatch = existingEmps.find(e => {
      const eParts = e.name.toLowerCase().trim().split(/\s+/);
      return eParts.some(ep => ep === lastName || ep.startsWith(lastName) || lastName.startsWith(ep));
    });
    if (lastMatch) {
      log(`final resolved employee: "${lastMatch.name}" via last-word match`);
      console.log(`[MATCH] import row saved: yes (last-word) — ${importedName} → ${lastMatch.name}`);
      return { employee: lastMatch, matchType: 'firstName', matchStep: 'last-word' };
    }
  }

  log('no match found');
  console.log(`[MATCH] import row saved: no — "${importedName}" did not match any employee`);
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
