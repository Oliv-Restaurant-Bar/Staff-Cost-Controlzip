// @vitest-environment node
/** Ehrliche MIRUS-Erfolgsmeldung: zugeordnet/geparkt/übersprungen/out-of-scope korrekt getrennt. */
import { describe, it, expect } from 'vitest';
import { buildMirusSuccessMessage } from '@/lib/mirus-success-message';

describe('buildMirusSuccessMessage', () => {
  it('nur zugeordnete: keine Park-/Skip-/Scope-Teile', () => {
    const msg = buildMirusSuccessMessage({
      assignedEmployeeCount: 12, assignedHours: 1453.6, writtenCells: 250,
      parkedCount: 0, parkedHours: 0, skippedHours: 0, outOfScopeHours: 0, warnCount: 0,
    });
    expect(msg).toBe('MIRUS-Import: 12 MA zugeordnet importiert (1453.60 h), 250 Zellen geschrieben, Backup angelegt.');
  });

  it('trennt zugeordnet vs. geparkt und weist die Scope-Summe aus', () => {
    const msg = buildMirusSuccessMessage({
      assignedEmployeeCount: 10, assignedHours: 1353.35, writtenCells: 240,
      parkedCount: 2, parkedHours: 100.25, skippedHours: 0, outOfScopeHours: 0, warnCount: 0,
    });
    expect(msg).toContain('10 MA zugeordnet importiert (1353.35 h)');
    expect(msg).toContain('2 Eintrag/Einträge geparkt/offen (100.25 h, nicht zugeordnet');
    expect(msg).toContain('Summe im Importumfang (Monat): 1453.60 h.');
    expect(msg).not.toContain('übersprungen');
    expect(msg).not.toContain('ausserhalb');
  });

  it('Cross-Month-Datei: out-of-scope-Stunden separat, NICHT in der Scope-Summe', () => {
    const msg = buildMirusSuccessMessage({
      assignedEmployeeCount: 3, assignedHours: 300, writtenCells: 60,
      parkedCount: 1, parkedHours: 40, skippedHours: 10.5, outOfScopeHours: 25.75, warnCount: 1,
    });
    expect(msg).toContain('10.50 h bewusst übersprungen');
    expect(msg).toContain('Summe im Importumfang (Monat): 350.50 h.'); // 300+40+10.5, ohne 25.75
    expect(msg).toContain('25.75 h liegen ausserhalb des Import-Monats');
    expect(msg).toContain('1 Warnung(en)');
  });

  it('rundet Summen auf 2 Nachkommastellen (Float-Reste)', () => {
    const msg = buildMirusSuccessMessage({
      assignedEmployeeCount: 2, assignedHours: 0.1 + 0.2, writtenCells: 2,
      parkedCount: 1, parkedHours: 0.1 + 0.2, skippedHours: 0, outOfScopeHours: 0, warnCount: 0,
    });
    expect(msg).toContain('(0.30 h)');
    expect(msg).toContain('Summe im Importumfang (Monat): 0.60 h.');
  });
});
