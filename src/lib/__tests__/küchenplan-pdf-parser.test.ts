// @vitest-environment node
/**
 * Regression: Küchenplan-Parser mit ECHTEN PDF-Text-Items (Fixture aus
 * Arbeitsplan April 2026, via scripts/extract-pdf-items.mjs extrahiert).
 * Das Fixture hat die kritische Struktur: Name und Schicht-Codes liegen auf
 * leicht versetzten Grundlinien (Mejdi y≈422.14, Codes y≈423.22; Miro y≈408
 * vs. Nachbarzeile 404) — feste y-Buckets zerlegen solche Mitarbeiter in
 * eine Namens- und eine namenlose Code-Zeile. Der Parser clustert deshalb
 * per Namens-Anker + Band-Zuordnung.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures', 'arbeitsplan-2026-04.pdf-items.json'), 'utf8'));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  version: 'test',
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: fixture.pageCount,
      getPage: (p: number) => Promise.resolve({
        getTextContent: () => Promise.resolve({
          items: fixture.pages[p - 1].items.map((it: { x: number; y: number; str: string }) => ({
            str: it.str,
            transform: [1, 0, 0, 1, it.x, it.y],
          })),
        }),
      }),
    }),
  }),
}));

import { parseKüchenplanPDF } from '@/lib/küchenplan-pdf-parser';

const fakeFile = { arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;

describe('parseKüchenplanPDF (Fixture Arbeitsplan 04/2026, versetzte Grundlinien)', () => {
  it('erkennt ALLE Mitarbeitenden inkl. oberster Zeile (Mejdi) und verliert keine Schichten', async () => {
    const res = await parseKüchenplanPDF(fakeFile);
    expect(res.error).toBeNull();

    // Oberste Datenzeile darf nicht vom Header-Skip verschluckt werden
    expect(res.detectedNames).toContain('Mejdi');
    // Alle 11 Namen der Namensspalte
    for (const n of ['Mejdi', 'Miro', 'Culi', 'Karel', 'Micky', 'Deti', 'ASIM', 'ALI', 'SAJED', 'Aushilfe A', 'Aushilfe F']) {
      expect(res.detectedNames).toContain(n);
    }
    expect(res.detectedNames).toHaveLength(11);

    // Mejdi: Name y≈422.14, Codes y≈423.22 (versetzte Grundlinie) — die
    // Arbeits-Codes müssen ihm zugeordnet sein, nicht verworfen werden.
    const mejdi = res.entries.filter(e => e.rawName === 'Mejdi');
    expect(mejdi.length).toBeGreaterThan(20);
    expect(mejdi.some(e => e.code === 'A')).toBe(true);

    // Kein Mitarbeiter mit 0 Einträgen
    for (const n of res.detectedNames) {
      expect(res.entries.filter(e => e.rawName === n).length, `Einträge für ${n}`).toBeGreaterThan(0);
    }

    // Legende erzeugt keine Namen/Codes («FT= Feiertag» usw.)
    expect(res.detectedNames.some(n => /=/.test(n))).toBe(false);
    expect(res.detectedCodes).not.toContain('Feiertag');
  });
});
