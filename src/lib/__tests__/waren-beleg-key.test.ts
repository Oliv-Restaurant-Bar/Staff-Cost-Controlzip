// @vitest-environment happy-dom
/** Beleg-Schlüssel der Import-Ablage: eindeutig UND stabil (Re-Import ersetzt). */
import { describe, it, expect } from 'vitest';
import { importBelegKey, resolveImportReceiptPath, istImportBelegPfad } from '@/lib/waren-db';

describe('importBelegKey', () => {
  it('ist deterministisch (gleiche Eingabe → gleicher Schlüssel)', () => {
    expect(importBelegKey('Feldschlösschen', 'ls-123')).toBe(importBelegKey('Feldschlösschen', 'ls-123'));
  });
  it('lange Referenzen mit gleichem 60-Zeichen-Präfix kollidieren NICHT', () => {
    const lang = 'x'.repeat(80);
    expect(importBelegKey('L', lang + 'A')).not.toBe(importBelegKey('L', lang + 'B'));
  });
  it('gleiche Nummer über Dokumenttypen (ls/fak/sammel) kollidiert NICHT', () => {
    const keys = ['ls-777', 'fak-777', 'sammel-777'].map(r => importBelegKey('Feldschlösschen', r));
    expect(new Set(keys).size).toBe(3);
  });
  it('Sonderzeichen/Umlaute ergeben gültige Pfade mit import/-Präfix', () => {
    const k = importBelegKey('Café Müller & Söhne', 'RG 2026/07 №42');
    expect(k.startsWith('import/')).toBe(true);
    expect(k).toMatch(/^import\/[a-z0-9._-]+--[a-z0-9._-]+-[0-9a-f]{8}$/);
  });
});

describe('resolveImportReceiptPath', () => {
  it('manueller Beleg (ohne /import/) gewinnt immer', () => {
    expect(resolveImportReceiptPath('oliv/inv-1.pdf', 'oliv/import/a--b-12345678.pdf')).toBe('oliv/inv-1.pdf');
  });
  it('Import-Beleg wird durch neuen Import-Beleg ersetzt', () => {
    expect(resolveImportReceiptPath('oliv/import/a--b-1.pdf', 'oliv/import/a--b-2.pdf')).toBe('oliv/import/a--b-2.pdf');
  });
  it('ohne neuen Beleg bleibt der bestehende (auch Import-Beleg) erhalten', () => {
    expect(resolveImportReceiptPath('oliv/import/a--b-1.pdf', undefined)).toBe('oliv/import/a--b-1.pdf');
    expect(resolveImportReceiptPath(undefined, undefined)).toBeUndefined();
  });
  it('istImportBelegPfad erkennt nur import/-Pfade', () => {
    expect(istImportBelegPfad('oliv/import/a--b-1.pdf')).toBe(true);
    expect(istImportBelegPfad('oliv/inv-1.pdf')).toBe(false);
  });
});
