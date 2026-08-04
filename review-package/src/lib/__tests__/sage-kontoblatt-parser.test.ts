// @vitest-environment happy-dom
/**
 * Sage-Kontoblatt-Parser — verankert an echten PDF-Textdumps (Oliv 01/2026, 03/2026).
 * Fixtures: mit pdfjs (legacy, node) extrahierte Zeilen der echten Kontoblatt-PDFs.
 *
 * Prüft die Spec «Kosten-Import Sage Kontoblatt»:
 *  - Monatsbetrag je Konto = Total Soll − Total Haben (nicht Saldo/Vortrag)
 *  - Buchungszeilen (Lieferanten-Journal) inkl. Soll/Haben-Klassifikation
 *    über die Saldo-Bewegung und Referenznummern-Anhang
 *  - Kopf-Metadaten: Firmenname → Mandant, Zeitraum → Monat/Jahr
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }));
vi.mock('../pdf-worker-setup', () => ({ ensurePdfWorkerConfigured: () => {} }));
vi.mock('xlsx', () => ({ read: vi.fn(), utils: {} }));

import { parseSageKontoblatt, parseSageHeaderMeta } from '../pdf-import-engine';
import linesMar from './fixtures/sage-oliv-2026-03-lines.json';
import linesJan from './fixtures/sage-oliv-2026-01-lines.json';

type Fixture = { y: number; items: { x: number; text: string }[]; text: string }[];
const mar = linesMar as unknown as Fixture;
const jan = linesJan as unknown as Fixture;

function rowsByAccount(lines: Fixture) {
  const res = parseSageKontoblatt(lines as never);
  const map = new Map(res.rows.map(r => [r.accountNumber, r]));
  return { ...res, map };
}

describe('parseSageHeaderMeta (echte Kopfzeilen)', () => {
  it('erkennt Oliv Gastro AG + Periode 03/2026', () => {
    const meta = parseSageHeaderMeta(mar.map(l => l.text));
    expect(meta.company).toMatch(/Oliv Gastro AG/i);
    expect(meta.tenant).toBe('oliv');
    expect(meta.month).toBe(3);
    expect(meta.year).toBe(2026);
  });

  it('leitet Beaulieu-Mandant aus Firmenname ab', () => {
    const meta = parseSageHeaderMeta(['Kontoblatt   Restaurant Beaulieu AG   Seite: 1', 'vom: 01.06.26   bis   30.06.26']);
    expect(meta.tenant).toBe('beaulieu');
    expect(meta.month).toBe(6);
    expect(meta.year).toBe(2026);
  });
});

describe('parseSageKontoblatt — Monatswerte = Total Soll − Total Haben (Oliv 03/2026)', () => {
  const { map, warnings } = rowsByAccount(mar);

  it('4020 Wein: 14577.94 − 0.00', () => {
    expect(map.get('4020')?.amount).toBeCloseTo(14577.94, 2);
  });
  it('4030 Bier: 9022.43 − 20.35', () => {
    expect(map.get('4030')?.amount).toBeCloseTo(9002.08, 2);
  });
  it('4040 Spirituosen: 276.23 − 613.69 (negativ, Retouren-Überhang)', () => {
    expect(map.get('4040')?.amount).toBeCloseTo(-337.46, 2);
  });
  it('4050 Mineral: 0.00 − 95.20 (negativ)', () => {
    expect(map.get('4050')?.amount).toBeCloseTo(-95.20, 2);
  });
  it('keine Plausibilitätswarnungen bei konsistentem PDF', () => {
    expect(warnings.filter(w => w.includes('Plausibilität'))).toEqual([]);
  });
});

describe('parseSageKontoblatt — Lieferanten-Journal (Oliv 03/2026)', () => {
  const { journalEntries, map } = rowsByAccount(mar);

  it('extrahiert Buchungszeilen mit Lieferantentext', () => {
    expect(journalEntries.length).toBeGreaterThan(20);
    const terravigna = journalEntries.find(e => /Terravigna/i.test(e.text));
    expect(terravigna).toBeDefined();
    expect(terravigna!.accountNumber).toBe('4020');
    expect(terravigna!.soll).toBeCloseTo(13482.01, 2);
    expect(terravigna!.haben).toBe(0);
  });

  it('klassifiziert Haben-Buchungen über die Saldo-Bewegung (4030, 20.35 Gutschrift)', () => {
    const gutschrift = journalEntries.find(
      e => e.accountNumber === '4030' && Math.abs(e.amount - 20.35) < 0.005,
    );
    expect(gutschrift).toBeDefined();
    expect(gutschrift!.haben).toBeCloseTo(20.35, 2);
    expect(gutschrift!.soll).toBe(0);
  });

  it('hängt Referenznummern an die Buchung an', () => {
    const withRef = journalEntries.find(e => e.belegNr?.includes('63848136'));
    expect(withRef).toBeDefined();
    expect(withRef!.text).toMatch(/Transgourmet/i);
  });

  it('Journal-Summe je Konto (Soll−Haben) entspricht dem Monatswert', () => {
    for (const acct of ['4020', '4030', '4040', '4050']) {
      const sum = journalEntries
        .filter(e => e.accountNumber === acct)
        .reduce((a, e) => a + e.soll - e.haben, 0);
      expect(sum).toBeCloseTo(map.get(acct)!.amount, 1);
    }
  });
});

describe('parseSageKontoblatt — zweites echtes PDF (Oliv 01/2026)', () => {
  const { rows, journalEntries, map } = rowsByAccount(jan);

  it('liefert Konten und Journal', () => {
    expect(rows.length).toBeGreaterThan(3);
    expect(journalEntries.length).toBeGreaterThan(10);
  });

  it('Journal-Summe = Monatswert für alle Konten mit Buchungen', () => {
    const accounts = new Set(journalEntries.map(e => e.accountNumber));
    for (const acct of accounts) {
      const sum = journalEntries
        .filter(e => e.accountNumber === acct)
        .reduce((a, e) => a + e.soll - e.haben, 0);
      expect(sum, `Konto ${acct}`).toBeCloseTo(map.get(acct)!.amount, 1);
    }
  });
});
