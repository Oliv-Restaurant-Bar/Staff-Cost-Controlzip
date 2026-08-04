// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  normalizeSchichtCode, getMappingForCode, DEFAULT_MAPPING,
} from '@/lib/schicht-code-mapping-store';

describe('normalizeSchichtCode', () => {
  it('Grossbuchstaben, Leerzeichen weg, trailing = strippen', () => {
    expect(normalizeSchichtCode('B a')).toBe('BA');
    expect(normalizeSchichtCode('FE=')).toBe('FE');
    expect(normalizeSchichtCode(' o1 ')).toBe('O1');
  });
});

describe('getMappingForCode', () => {
  it('Varianten Ae/Ba/Be → Basisschicht mit Zeiten von A bzw. B', () => {
    for (const [variant, base] of [['Ae', 'A'], ['Ba', 'B'], ['Be', 'B'], ['B a', 'B'], ['AE=', 'A']] as const) {
      const m = getMappingForCode(variant, []);
      const b = DEFAULT_MAPPING.find(e => e.code === base)!;
      expect(m, variant).not.toBeNull();
      expect(m!.start).toBe(b.start);
      expect(m!.end).toBe(b.end);
      expect(m!.hours).toBe(b.hours);
      expect(m!.type).toBe('work');
    }
  });

  it('Abwesenheits-Codes sind nie Arbeit (0 Std, ohne Zeiten)', () => {
    for (const code of ['F', 'FE', 'K', 'FW', 'MI', 'MS', 'KO', 'FT', 'FE=']) {
      const m = getMappingForCode(code, []);
      expect(m, code).not.toBeNull();
      expect(m!.type).not.toBe('work');
      expect(m!.hours).toBe(0);
      expect(m!.start).toBeUndefined();
    }
  });

  it('wirklich unbekannter Code → null (kein stiller Default)', () => {
    expect(getMappingForCode('XY', [])).toBeNull();
    expect(getMappingForCode('10:00', [])).toBeNull();
  });

  it('Arbeits-Codes tragen die Legenden-Zeiten und Pausen', () => {
    const b = getMappingForCode('B', [])!;
    expect(b.start).toBe('11:30');
    expect(b.end).toBe('21:30');
    expect(b.breakMinutes).toBe(60);
    const a = getMappingForCode('A', [])!;
    expect(a.start2).toBe('17:30');
    expect(a.end2).toBe('23:00');
    const o2 = getMappingForCode('O2', [])!;
    expect(o2.breakMinutes).toBe(15);
  });
});
