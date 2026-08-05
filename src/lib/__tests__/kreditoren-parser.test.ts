// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseKreditorenAuszug, analysiereAuszug, istWarenKonto, parseChfAmount } from '@/lib/kreditoren-parser';
import type { PositionedPdfLine } from '@/lib/pdf-import-engine';

// Fixture: rohe pdfjs-Text-Items (x/y/str) → Zeilen wie extractPdfTextLines
function fixtureLines(): PositionedPdfLine[] {
  const raw = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'kreditoren-oliv-2026.json'), 'utf8',
  )) as { pages: { pageNumber: number; items: { x: number; y: number; str: string }[] }[] };
  const lines: PositionedPdfLine[] = [];
  for (const pg of raw.pages) {
    const rows = new Map<number, { x: number; text: string }[]>();
    for (const it of pg.items) {
      if (!it.str.trim()) continue;
      const key = Math.round(it.y);
      // nächster-Δy-Bucket (±2) statt exaktem Key
      let bucket = key;
      for (const k of rows.keys()) if (Math.abs(k - key) <= 2) { bucket = k; break; }
      if (!rows.has(bucket)) rows.set(bucket, []);
      rows.get(bucket)!.push({ x: it.x, text: it.str });
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const items = rows.get(y)!.sort((a, b) => a.x - b.x);
      lines.push({ text: items.map(i => i.text).join(' '), items });
    }
  }
  return lines;
}

const auszug = parseKreditorenAuszug(fixtureLines());
const analysen = analysiereAuszug(auszug);

describe('kreditoren-parser (Fixture Oliv 2026)', () => {
  it('Kopf: Firma, Mandant, Zeitraum, kein failureReason', () => {
    expect(auszug.firma).toContain('Oliv');
    expect(auszug.mandant).toBe('oliv');
    expect(auszug.vonDatum).toBe('2026-01-01');
    expect(auszug.debug.failureReason).toBeNull();
    expect(auszug.kreditoren.length).toBeGreaterThan(10);
  });

  it('Blaser Café: nur Haben-Buchungen auf 4070, Zahlungsläufe ignoriert', () => {
    const a = analysen.find(x => x.kreditor.name.startsWith('Blaser Café'))!;
    expect(a).toBeTruthy();
    expect(a.rechnungen.length).toBe(6);
    expect(a.rechnungen.every(r => r.gKonto === '4070')).toBe(true);
    expect(a.warenVorschlag).toBe(true);
    expect(a.standardKontoVorschlag).toBe('4070');
    // Zahlungsläufe (Soll/1021/div) sind keine Rechnungen
    const zahlungen = a.kreditor.buchungen.filter(b => b.typ === 'soll_zahlung');
    expect(zahlungen.length).toBeGreaterThan(0);
    // Erste Rechnung: 04.02.2026, 595.90, Referenz-Folgezeile 1072921
    const r1 = a.rechnungen[0];
    expect(r1.datum).toBe('2026-02-04');
    expect(r1.betrag).toBe(595.9);
    expect(r1.referenz).toBe('1072921');
  });

  it('Spahni: halbmonatliches Muster, 4060', () => {
    const a = analysen.find(x => x.kreditor.name.startsWith('Metzgerei Spahni'))!;
    expect(a.standardKontoVorschlag).toBe('4060');
    expect(a.modellVorschlag).toBe('halbmonatlich');
  });

  it('Transgourmet: reine div-Haben-Buchungen zählen für getaggte Waren-Lieferanten', () => {
    const a = analysen.find(x => x.kreditor.name.startsWith('Transgourmet'))!;
    expect(a.rechnungen.length).toBeGreaterThan(5);
    expect(a.hatDiv).toBe(true);
    // Rückvergütung (Soll, div, kein Zahlungslauf) ist keine Rechnung
    const rueck = a.kreditor.buchungen.find(b => b.text.includes('Rückvergütung'));
    expect(rueck?.typ).toBe('soll_sonstig');
    // Referenz aus Text «Transgourmet 63726180»
    expect(a.rechnungen.some(r => r.referenz === '63726180')).toBe(true);
  });

  it('Nicht-Waren-Kreditoren: Finanzverwaltung (6370) und Jäggi.digital (6510/div) kein Waren-Vorschlag', () => {
    const fin = analysen.find(x => x.kreditor.name.startsWith('Finanzverwaltung'))!;
    expect(fin.warenVorschlag).toBe(false);
    const jaeggi = analysen.find(x => x.kreditor.name.startsWith('Jäggi'))!;
    expect(jaeggi.warenVorschlag).toBe(false);
    expect(jaeggi.nurDiv).toBe(false); // hat 6510 → nicht «rein div»
  });

  it('Spec-Kontrolle: 16 Waren-Lieferanten automatisch vorgeschlagen', () => {
    const waren = analysen.filter(a => a.warenVorschlag).map(a => a.kreditor.name).sort();
    expect(waren.length).toBe(16);
    for (const erwartet of ['Transgourmet', 'Feldschl', 'Metzgerei Spahni', 'Terravigna', 'Obrist', 'Blaser Café', 'Hiestand', 'Siebe Dupf']) {
      expect(waren.some(n => n.includes(erwartet)), erwartet).toBe(true);
    }
    // Reine-div/Nicht-Waren nie dabei
    for (const nie of ['Energie Wasser', 'Jäggi', 'Macauda', 'Finanzverwaltung']) {
      expect(waren.some(n => n.includes(nie)), nie).toBe(false);
    }
  });

  it('Beträge: de-CH Apostroph, Summen konsistent (Blaser Haben-Total 3838.15)', () => {
    expect(parseChfAmount("3'838.15")).toBe(3838.15);
    expect(istWarenKonto('4090')).toBe(true);
    expect(istWarenKonto('4080')).toBe(false);
    expect(istWarenKonto('div')).toBe(false);
    const blaser = analysen.find(x => x.kreditor.name.startsWith('Blaser Café'))!;
    expect(blaser.habenSumme).toBe(3838.15);
  });
});
