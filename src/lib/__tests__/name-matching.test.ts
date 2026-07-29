// @vitest-environment node
//
// Robustes Namens-Matching (Spec Punkt 2): Gross/Klein, Umlaute/Akzente,
// gedrehte Reihenfolge «Nachname Vorname» ↔ «Vorname Nachname».
import { describe, it, expect } from 'vitest';
import { normalizeNameKey, findMatchingEmployeeWithSuggestions } from '@/lib/name-matching';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import type { Employee } from '@/types/personnel';

const emp = (id: string, name: string): Employee => ({
  id, name, department: 'service', employmentType: 'aushilfe', hourlyWage: 30,
});

describe('normalizeNameKey', () => {
  it('senkt Gross/Klein, trimmt, kollabiert Spaces', () => {
    expect(normalizeNameKey('  Müller   Anna ')).toBe('mueller anna');
  });
  it('expandiert Umlaute und ß', () => {
    expect(normalizeNameKey('Schäfer Weiß')).toBe('schaefer weiss');
    expect(normalizeNameKey('Öztürk')).toBe('oeztuerk');
  });
  it('entfernt Akzente/Diakritika', () => {
    expect(normalizeNameKey('José Peña')).toBe('jose pena');
    expect(normalizeNameKey('Giménez Nahuel')).toBe('gimenez nahuel');
  });
  it('behandelt Komma/Bindestrich als Trenner', () => {
    expect(normalizeNameKey('Momand, Sajed')).toBe('momand sajed');
    expect(normalizeNameKey('Ben-Omar Saad')).toBe('ben omar saad');
  });
});

describe('findMatchingEmployeeWithSuggestions', () => {
  const employees = [
    emp('e1', 'Anna Müller'),
    emp('e2', 'Sajed Momand'),
    emp('e3', 'Marion Krauss'),
  ];

  it('matcht trotz Umlaut-Schreibweise (Mueller ↔ Müller)', () => {
    const r = findMatchingEmployeeWithSuggestions('Mueller Anna', employees, []);
    expect(r.bestMatch?.id).toBe('e1');
    expect(r.matchType).toBe('exact');
  });

  it('matcht gedrehte Reihenfolge «Nachname Vorname» (Momand Sajed ↔ Sajed Momand)', () => {
    const r = findMatchingEmployeeWithSuggestions('Momand Sajed', employees, []);
    expect(r.bestMatch?.id).toBe('e2');
    expect(r.matchType).toBe('exact');
  });

  it('matcht «Nachname, Vorname» mit Komma', () => {
    const r = findMatchingEmployeeWithSuggestions('Krauss, Marion', employees, []);
    expect(r.bestMatch?.id).toBe('e3');
    expect(r.matchType).toBe('exact');
  });

  it('unbekannter Name → matchType "new", nicht still verworfen (Vorschläge vorhanden)', () => {
    const r = findMatchingEmployeeWithSuggestions('Zzzz Yyyy', employees, []);
    expect(r.matchType).toBe('new');
    expect(Array.isArray(r.suggestions)).toBe(true);
  });

  it('Token-Kollision (zwei Personen, identisches Token-Set) → matchType "conflict", kein Auto-Match', () => {
    const collide = [emp('a', 'Anna Berg'), emp('b', 'Berg Anna')];
    const r = findMatchingEmployeeWithSuggestions('Anna Berg', collide, []);
    expect(r.matchType).toBe('conflict');
    expect(r.bestMatch).toBeNull();
    expect(r.suggestions.map(s => s.employee.id).sort()).toEqual(['a', 'b']);
  });
});

describe('matchEmployeeByName (Mirus-Ist-Flow) — Kollisionsschutz (Spec Punkt 4)', () => {
  it('zwei MA mit identischem Namen → exact-conflict, employee=null (manuelle Auswahl erzwungen)', () => {
    // Zwei verschiedene Personen, gleicher Name → exakter Treffer ist mehrdeutig.
    const collide = [emp('e1', 'Anna Berg'), emp('e2', 'Anna Berg')];
    const res = matchEmployeeByName('Anna Berg', collide);
    expect(res.matchType).toBe('conflict');
    expect(res.matchStep).toBe('exact-conflict');
    expect(res.employee).toBeNull();
  });

  it('gedrehte Kollision (kein exakter Treffer, aber zwei reversed-Treffer) → conflict', () => {
    // Import «Berg Anna»; kein exakter Treffer, aber sowohl «Anna Berg» als auch
    // «Anna Berg» (2. Person) matchen die gedrehte Reihenfolge → Kollision.
    const collide = [emp('e1', 'Anna Berg'), emp('e2', 'Anna Berg')];
    // Erst exact prüfen: «Berg Anna» ≠ «Anna Berg» als String → kein Step-1-Treffer,
    // fällt auf reversed. Beide matchen reversed → conflict.
    const res = matchEmployeeByName('Berg Anna', collide);
    // Step 1 greift hier NICHT (String ungleich), reversed liefert 2 → conflict.
    expect(res.matchType).toBe('conflict');
    expect(res.employee).toBeNull();
  });

  it('eindeutiger exakter Treffer bleibt "exact" (kein Fehlalarm)', () => {
    const emps = [emp('e1', 'Anna Berg'), emp('e2', 'Carlos Diaz')];
    const res = matchEmployeeByName('Anna Berg', emps);
    expect(res.matchType).toBe('exact');
    expect(res.employee?.id).toBe('e1');
  });

  it('gedrehte Reihenfolge weiterhin eindeutig matchbar', () => {
    const emps = [emp('e1', 'Sajed Momand')];
    const res = matchEmployeeByName('Momand Sajed', emps);
    expect(res.employee?.id).toBe('e1');
  });
});
