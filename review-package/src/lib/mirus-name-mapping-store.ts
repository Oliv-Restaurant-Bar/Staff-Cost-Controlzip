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

/**
 * Akzente/Umlaute wegfalten («Ilir Ukaj» = «Ilír Ukaj», «Müller» = «Muller»).
 * NFD-Zerlegung + Entfernen der kombinierten Diakritika; ß → ss.
 */
export function foldDiacritics(s: string): string {
  return s
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Name-Matching-Logik (geteilt zwischen Import-Schritten) ─────────────────

export type NameMatchType = 'exact' | 'saved' | 'firstName' | 'new' | 'conflict';

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
 *  0. Gespeicherte Zuordnung aus localStorage (manuell bestätigt)
 *  1. Exakter Match (case-insensitiv, nach Normalisierung)
 *  2. Exakter Match nach Stripping (Kommas, Punkte, Sonderzeichen entfernt)
 *  3. Umgekehrte Wortreihenfolge exakt — "Momand Sajed" ↔ "Sajed Momand"
 *  4. Token-Vollmatch: alle Tokens des Importnamens kommen als eigene Wörter vor
 *  5. Wort-Scoring: exakter Token +2, Präfix-Match (≥4 Zeichen) +1
 *     (Mindesterfordernis: alle langen Tokens müssen irgendwie matchen)
 *  6. Erstes Token als Vorname (eindeutig)
 *  7. Letztes Token als Nachname (eindeutig)
 *  8. Einzelner Token = vollständiger Systemname (eindeutig)
 *
 * Spezialbehandlung:
 *  - "Momand, Sajed" → Komma entfernt → "Momand Sajed" → reversed → "Sajed Momand"
 *  - "Sadete Domi"   → "sadete" exakt +2, "domi" prefix von "domenig" +1 → beste Score
 *
 * @param importedName  Name wie er im Mirus-Export steht
 * @param existingEmps  Liste aller bekannten Mitarbeiter
 * @param debug         true = Console-Log für diesen Namen ausgeben
 */
/** Entfernt Duplikate anhand der Mitarbeiter-ID (behält Reihenfolge). */
function dedupeById(list: Employee[]): Employee[] {
  return Array.from(new Map(list.map(e => [e.id, e])).values());
}

export function matchEmployeeByName(
  importedName: string,
  existingEmps: Employee[],
  debug = false,
): EmployeeMatchResult {
  const log = (...args: unknown[]) => {
    if (debug) console.log('[MATCH]', ...args);
  };

  log(`raw import name: "${importedName}"`);

  // ── Step 0: Saved mapping ─────────────────────────────────────────────────
  const savedId = lookupSavedMapping(importedName);
  if (savedId === 'skip') {
    log('import row saved: no (skip mapping)');
    return { employee: null, matchType: 'new', matchStep: 'skip' };
  }
  if (savedId) {
    const emp = existingEmps.find(e => e.id === savedId);
    if (emp) {
      log(`final resolved employee: "${emp.name}" via saved mapping`);
      log(`import row saved: yes (saved mapping)`);
      return { employee: emp, matchType: 'saved', matchStep: 'saved' };
    }
    log(`saved mapping id="${savedId}" not found in employee list, continuing`);
  }

  // ── Normalization helpers ─────────────────────────────────────────────────

  /** Lowercase + Akzent-/Umlaut-Faltung + trim + collapse whitespace */
  const norm = (s: string) => foldDiacritics(s.toLowerCase()).trim().replace(/\s{2,}/g, ' ');

  /** Strip non-letter, non-space chars (commas, dots, hyphens used as separators) */
  const strip = (s: string) => norm(s).replace(/[^a-z\s]/gi, ' ').replace(/\s{2,}/g, ' ').trim();

  const normImport  = norm(importedName);
  const stripImport = strip(importedName);

  log(`normalized import name: "${normImport}"`);
  if (stripImport !== normImport) log(`stripped import name: "${stripImport}"`);

  const importTokens  = stripImport.split(/\s+/).filter(p => p.length > 0);
  const longTokens    = importTokens.filter(p => p.length >= 3);

  if (debug) {
    existingEmps.forEach(e => log(`candidate employee: "${e.name}" (id=${e.id})`));
  }

  const normEmp  = (e: Employee) => norm(e.name);
  const stripEmp = (e: Employee) => strip(e.name);

  // ── Step 1: Exact match (normalized) ─────────────────────────────────────
  // ALLE exakten Treffer sammeln (nicht nur den ersten): bei einer
  // Normalisierungs-/Reihenfolge-Kollision (zwei verschiedene Personen mit
  // identischem normalisiertem Namen) darf NICHT automatisch gematcht werden.
  const exactAll = dedupeById(
    existingEmps.filter(e => normEmp(e) === normImport || stripEmp(e) === stripImport),
  );
  if (exactAll.length === 1) {
    log(`final resolved employee: "${exactAll[0].name}" via exact match`);
    log(`import row saved: yes (exact)`);
    return { employee: exactAll[0], matchType: 'exact', matchStep: 'exact' };
  }
  if (exactAll.length > 1) {
    log(`exact match AMBIGUOUS: ${exactAll.map(e => `"${e.name}"`).join(', ')} — marking conflict`);
    return { employee: null, matchType: 'conflict', matchStep: 'exact-conflict' };
  }

  // ── Step 2: Exact match after stripping punctuation ───────────────────────
  // Handles "Momand, Sajed" → "Momand Sajed" compared to system "Momand Sajed"
  if (stripImport !== normImport) {
    const stripExact = existingEmps.find(e => stripEmp(e) === stripImport);
    if (stripExact) {
      log(`final resolved employee: "${stripExact.name}" via strip-exact match`);
      log(`import row saved: yes (strip-exact)`);
      return { employee: stripExact, matchType: 'exact', matchStep: 'strip-exact' };
    }
  }

  // ── Step 3: Reversed word order ───────────────────────────────────────────
  // "Momand Sajed" (import) ↔ "Sajed Momand" (system), and vice versa.
  // Try reversing both the normalized and stripped import name.
  const tryReversedAll = (tokens: string[]): Employee[] => {
    const rev = [...tokens].reverse().join(' ');
    return existingEmps.filter(e => stripEmp(e) === rev || normEmp(e) === rev);
  };
  const reversedAll = dedupeById([
    ...tryReversedAll(importTokens),
    ...tryReversedAll(norm(importedName).split(/\s+/).filter(Boolean)),
  ]);

  if (reversedAll.length === 1) {
    const revStr = [...importTokens].reverse().join(' ');
    log(`reversed-order match: "${stripImport}" → reversed "${revStr}" → "${reversedAll[0].name}"`);
    log(`import row saved: yes (reversed-exact)`);
    return { employee: reversedAll[0], matchType: 'exact', matchStep: 'reversed-exact' };
  }
  if (reversedAll.length > 1) {
    log(`reversed-order match AMBIGUOUS: ${reversedAll.map(e => `"${e.name}"`).join(', ')} — marking conflict`);
    return { employee: null, matchType: 'conflict', matchStep: 'reversed-conflict' };
  }

  // ── Step 4: All-token containment ─────────────────────────────────────────
  // Every token of the import name must appear as an exact word token in the
  // employee name (order-independent). Both directions are tried.
  // "Momand Sajed" → {"momand","sajed"} both in {"sajed","momand"} → match
  if (longTokens.length >= 2) {
    const containsAll = (empTokens: string[], query: string[]) =>
      query.every(qt => empTokens.some(et => et === qt));

    const allTokenMatch = existingEmps.filter(e => {
      const eParts = stripEmp(e).split(/\s+/);
      return containsAll(eParts, longTokens) || containsAll(longTokens, eParts);
    });

    if (allTokenMatch.length === 1) {
      log(`token match: all tokens ${JSON.stringify(longTokens)} found in "${allTokenMatch[0].name}"`);
      log(`final resolved employee: "${allTokenMatch[0].name}" via all-token match`);
      log(`import row saved: yes (all-token)`);
      return { employee: allTokenMatch[0], matchType: 'exact', matchStep: 'all-token' };
    }
    if (allTokenMatch.length > 1) {
      log(`all-token match AMBIGUOUS: ${allTokenMatch.map(e => `"${e.name}"`).join(', ')}`);
    }
  }

  // ── Step 5: Word scoring ──────────────────────────────────────────────────
  // Exact token +2, prefix match (≥4 chars, either direction) +1.
  // Require that ALL long tokens contribute at least +1 to avoid false positives.
  // "Sadete Domi" → "sadete" +2, "domi"/"domenig" prefix +1 → score 3 for "Sadete Domenig"
  if (longTokens.length > 0) {
    const scored = existingEmps.map(e => {
      const eParts = stripEmp(e).split(/\s+/);
      let score = 0;
      let matchedTokens = 0;
      for (const ip of longTokens) {
        let tokenScore = 0;
        for (const ep of eParts) {
          if (ep === ip) { tokenScore = 2; break; }
          if ((ep.startsWith(ip) || ip.startsWith(ep)) && ip.length >= 4 && ep.length >= 4) {
            tokenScore = Math.max(tokenScore, 1);
          }
        }
        score += tokenScore;
        if (tokenScore > 0) matchedTokens++;
      }
      return { emp: e, score, matchedTokens };
    }).filter(x => x.score > 0);

    if (debug) {
      scored.forEach(x => log(`candidate employee: "${x.emp.name}" word-score=${x.score} matched-tokens=${x.matchedTokens}/${longTokens.length}`));
    }

    // Only accept if EVERY long token contributed something
    const valid = scored.filter(x => x.matchedTokens === longTokens.length);
    valid.sort((a, b) => b.score - a.score);

    if (valid.length === 1) {
      log(`final resolved employee: "${valid[0].emp.name}" via word-score=${valid[0].score}`);
      log(`import row saved: yes (word-score:${valid[0].score})`);
      return { employee: valid[0].emp, matchType: 'firstName', matchStep: `word-score:${valid[0].score}` };
    }
    if (valid.length > 1 && valid[0].score > valid[1].score) {
      // Unique best score — take it
      log(`final resolved employee: "${valid[0].emp.name}" via word-score=${valid[0].score} (unique best)`);
      log(`import row saved: yes (word-score-best:${valid[0].score})`);
      return { employee: valid[0].emp, matchType: 'firstName', matchStep: `word-score-best:${valid[0].score}` };
    }

    // Fall through with relaxed scoring (not all tokens matched)
    const relaxed = scored.filter(x => x.matchedTokens >= Math.max(1, longTokens.length - 1));
    relaxed.sort((a, b) => b.score - a.score);
    if (relaxed.length === 1) {
      log(`final resolved employee: "${relaxed[0].emp.name}" via relaxed-score=${relaxed[0].score}`);
      log(`import row saved: yes (relaxed-score:${relaxed[0].score})`);
      return { employee: relaxed[0].emp, matchType: 'firstName', matchStep: `relaxed-score:${relaxed[0].score}` };
    }
  }

  // ── Step 6: First token as first name (unique match only) ─────────────────
  const firstToken = importTokens[0] ?? '';
  if (firstToken.length >= 3) {
    const firstMatches = existingEmps.filter(
      e => stripEmp(e).split(/\s+/)[0] === firstToken,
    );
    if (firstMatches.length === 1) {
      log(`final resolved employee: "${firstMatches[0].name}" via first-word match`);
      log(`import row saved: yes (first-word)`);
      return { employee: firstMatches[0], matchType: 'firstName', matchStep: 'first-word' };
    }
  }

  // ── Step 7: Last token as last name (unique match only) ───────────────────
  const lastToken = importTokens[importTokens.length - 1] ?? '';
  if (lastToken.length >= 3) {
    const lastMatches = existingEmps.filter(e => {
      const eParts = stripEmp(e).split(/\s+/);
      return eParts.some(ep => ep === lastToken || ep.startsWith(lastToken) || lastToken.startsWith(ep));
    });
    if (lastMatches.length === 1) {
      log(`final resolved employee: "${lastMatches[0].name}" via last-word match`);
      log(`import row saved: yes (last-word)`);
      return { employee: lastMatches[0], matchType: 'firstName', matchStep: 'last-word' };
    }
  }

  // ── Step 8: Single token = full system name (unique) ─────────────────────
  {
    const tokenCandidates: Employee[] = [];
    for (const token of importTokens) {
      if (token.length < 3) continue;
      const hit = existingEmps.find(e => stripEmp(e) === token);
      if (hit && !tokenCandidates.some(c => c.id === hit.id)) tokenCandidates.push(hit);
    }
    if (tokenCandidates.length === 1) {
      log(`final resolved employee: "${tokenCandidates[0].name}" via token-full-name (unique)`);
      log(`import row saved: yes (token-full-name)`);
      return { employee: tokenCandidates[0], matchType: 'firstName', matchStep: 'token-full-name' };
    }
    if (tokenCandidates.length > 1) {
      const names = tokenCandidates.map(c => `"${c.name}"`).join(', ');
      log(`token-full-name AMBIGUOUS: ${names} — marking unresolved`);
      return { employee: null, matchType: 'new', matchStep: 'token-full-name-ambiguous' };
    }
  }

  log(`final resolved employee: none`);
  log(`import row saved: no — "${importedName}" did not match any employee`);
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
 * Versucht zuerst den exakt normalisierten Namen, dann den bereinigten Namen
 * (ohne Satzzeichen), um auch "Momand, Sajed" → Eintrag für "Momand Sajed" zu finden.
 * Gibt undefined zurück wenn keine Zuordnung gespeichert ist.
 */
export function lookupSavedMapping(importedName: string): string | 'skip' | undefined {
  const all = loadNameMappings();
  const exactKey    = normalize(importedName);
  const strippedKey = exactKey.replace(/[^a-z\s]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  const legacyKey   = legacyNormalize(importedName);
  return all[exactKey]
    ?? (strippedKey !== exactKey ? all[strippedKey] : undefined)
    ?? (legacyKey !== exactKey ? all[legacyKey] : undefined);
}

/**
 * Normalisierung für Mapping-Schlüssel: lowercase + Akzent-/Umlaut-Faltung + trim.
 * (Ältere localStorage-Einträge können ungefaltete Keys haben — lookupSavedMapping
 * probiert deshalb zusätzlich den Legacy-Key ohne Faltung.)
 */
function normalize(name: string): string {
  return foldDiacritics(name.toLowerCase()).trim().replace(/\s{2,}/g, ' ');
}

/** Legacy-Schlüssel (vor Einführung der Akzent-Faltung). */
function legacyNormalize(name: string): string {
  return name.toLowerCase().trim().replace(/\s{2,}/g, ' ');
}

/**
 * Anzahl gespeicherter Zuordnungen.
 */
export function countSavedMappings(): number {
  return Object.keys(loadNameMappings()).length;
}

// ─── Dauerhafte MIRUS-Aliasse (Supabase, pro Mandant) ─────────────────────────
//
// Manuell bestätigte Zuordnungen werden zusätzlich zum localStorage-Cache
// dauerhaft in app_settings gespeichert (Key `mirus_name_aliases:<tenant>`),
// damit sie geräteübergreifend und nach Cache-Löschung erhalten bleiben.
// Format: Record<normalizedImportedName, employeeId> — 'skip' bleibt bewusst
// lokal (Gerätepräferenz, keine Personenzuordnung).
// Alle Funktionen sind best-effort und werfen nie (Import darf nicht an der
// Alias-Persistenz scheitern).

function aliasKey(tenantId: string): string {
  return `mirus_name_aliases:${tenantId}`;
}

/** Dauerhafte Aliasse des Mandanten laden (leer bei Fehler). */
export async function fetchRemoteAliases(tenantId: string): Promise<Record<string, string>> {
  try {
    const { appSettingsTable } = await import('@/lib/app-settings-table');
    const { data, error } = await appSettingsTable()
      .select('value')
      .eq('key', aliasKey(tenantId))
      .maybeSingle();
    if (error || !data) return {};
    const val = data.value as Record<string, string> | null;
    return val && typeof val === 'object' ? val : {};
  } catch {
    return {};
  }
}

/**
 * Manuelle Zuordnungen dauerhaft speichern: frisch laden → mergen → upsert
 * (Merge, damit parallel gespeicherte Aliasse nicht überschrieben werden).
 */
export async function saveRemoteAliases(
  tenantId: string,
  mappings: Array<{ importedName: string; employeeId: string }>,
): Promise<void> {
  if (mappings.length === 0) return;
  try {
    const { appSettingsTable } = await import('@/lib/app-settings-table');
    const current = await fetchRemoteAliases(tenantId);
    const next = { ...current };
    for (const { importedName, employeeId } of mappings) {
      next[normalize(importedName)] = employeeId;
    }
    const { error } = await appSettingsTable().upsert(
      { key: aliasKey(tenantId), value: next as unknown as Record<string, unknown> },
      { onConflict: 'key' },
    );
    if (error) console.warn('[MIRUS-ALIAS] Speichern fehlgeschlagen:', error.message);
  } catch (e) {
    console.warn('[MIRUS-ALIAS] Speichern fehlgeschlagen:', e);
  }
}

/**
 * Remote-Aliasse in den lokalen Mapping-Cache übernehmen (vor dem Matching
 * aufrufen). Lokale Einträge gewinnen NICHT — der dauerhafte Alias ist die
 * verbindliche, manuell bestätigte Zuordnung.
 */
export function mergeAliasesIntoLocal(aliases: Record<string, string>): void {
  const entries = Object.entries(aliases);
  if (entries.length === 0) return;
  const all = loadNameMappings();
  for (const [key, empId] of entries) all[key] = empId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* Cache-Fehler ignorieren */ }
}
