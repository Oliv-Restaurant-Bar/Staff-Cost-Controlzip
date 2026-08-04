// @vitest-environment node
/**
 * Gastronovi Z-Bericht PDF-Parser — Tests gegen die ECHTE PDF-Fixture
 * ====================================================================
 * Fixture: erweiterter Z-Bericht «Hauptkostenstelle 506» (Oliv, 30.06.2026
 * 23:54 – 01.07.2026 23:38, 10 Seiten) als extrahierte pdfjs-Text-Items.
 * Alle Erwartungswerte wurden manuell aus dem PDF verifiziert:
 *   Total 12225.20 · exkl. Aufladung 12145.20 · Positionsrabatte −135.10 ·
 *   Rabatte −818.60 · Aufladung +80.00 · Hauptwarengruppen 12963.80.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseGnZBerichtPdf } from '../gn-zbericht-pdf-parser';
import {
  reconstructGnPdfLines,
  stripGnPdfHeaderFooters,
  detectGnPdfReportKind,
  normalizeGnMoneyCell,
  isGnParenMoneyCell,
  extractGnParenMoney,
  type GnPdfPageItems,
} from '../gn-pdf-lines';

const fixturePath = fileURLToPath(
  new URL('./fixtures/gn-zbericht-extended-real.pdf-items.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  pageCount: number;
  pages: GnPdfPageItems[];
};

const parsed = parseGnZBerichtPdf(fixture.pages, 'z-bericht-506.pdf');

describe('gn-pdf-lines — Zeilenrekonstruktion und Normalisierung', () => {
  it('rekonstruiert Zeilen mit X-sortierten Zellen', () => {
    const lines = reconstructGnPdfLines(fixture.pages);
    expect(lines.length).toBeGreaterThan(300);
    const taxTotal = lines.find(l => l.pageNumber === 1 && l.cells[0]?.text === 'Total' && l.text.includes('858.30'));
    expect(taxTotal).toBeDefined();
    expect(taxTotal!.cells.map(c => c.text)).toEqual(
      ['Total', 'CHF 11366.90', 'CHF 858.30', 'CHF 12225.20'],
    );
  });

  it('entfernt wiederholte Seitenköpfe und Fusszeilen ohne Datenverlust', () => {
    const lines = reconstructGnPdfLines(fixture.pages);
    const { lines: kept, removedCount, repeatedHeaderText } = stripGnPdfHeaderFooters(lines);
    // 10 Seitenköpfe + 10 Fusszeilen
    expect(removedCount).toBe(20);
    expect(repeatedHeaderText).toContain('Z-Bericht - Hauptkostenstelle - 506');
    expect(kept.some(l => /gastronovi\s+office/i.test(l.text))).toBe(false);
    expect(kept.some(l => l.text === 'Z-Bericht - Hauptkostenstelle - 506 (Erweiterte Version)')).toBe(false);
    // Datenzeilen bleiben vollständig (z. B. letzte Zahlarten-Zeile über Seitenumbruch)
    expect(kept.some(l => l.text.includes('MasterCard') && l.text.includes('6824.60'))).toBe(true);
  });

  it('erkennt den Berichtstyp inhaltsbasiert (nie über den Dateinamen)', () => {
    const lines = reconstructGnPdfLines(fixture.pages);
    const det = detectGnPdfReportKind(lines);
    expect(det.kind).toBe('zbericht');
    expect(det.isExtendedHint).toBe(true);
  });

  it('normalisiert CHF-Zellen und Klammerbeträge', () => {
    expect(normalizeGnMoneyCell('CHF 12225.20')).toBe('12225.20');
    expect(normalizeGnMoneyCell('CHF -818.60')).toBe('-818.60');
    expect(normalizeGnMoneyCell('-434.60 CHF')).toBe('-434.60');
    expect(normalizeGnMoneyCell("CHF 1'843.70")).toBe("1'843.70");
    expect(normalizeGnMoneyCell('Hauptkostenstelle')).toBe('Hauptkostenstelle');
    expect(normalizeGnMoneyCell('0.00%')).toBe('0.00%');
    expect(isGnParenMoneyCell('(CHF 3404.90)')).toBe(true);
    expect(isGnParenMoneyCell('CHF 3404.90')).toBe(false);
    expect(extractGnParenMoney('(CHF 3404.90)')).toBe('3404.90');
    expect(extractGnParenMoney('(65.00)')).toBe('65.00');
  });
});

describe('parseGnZBerichtPdf — Metadaten und Geschäftstag', () => {
  it('liest Z-Zähler, Kostenstelle und Quellformat', () => {
    expect(parsed.sourceFormat).toBe('pdf');
    expect(parsed.reportType).toBe('extended');
    expect(parsed.zCounter).toBe('506');
    expect(parsed.costCenter).toBe('Hauptkostenstelle');
    expect(parsed.debug.delimiter).toBe('PDF');
  });

  it('wendet die Geschäftstagsregel an: 30.06 23:54 – 01.07 23:38 ⇒ 01.07.', () => {
    expect(parsed.periodFromTime).toBe('23:54');
    expect(parsed.periodToTime).toBe('23:38');
    expect(parsed.businessDay).toBe('2026-07-01');
    expect(parsed.periodFrom).toBe('2026-07-01');
    expect(parsed.periodTo).toBe('2026-07-01');
  });

  it('meldet keine Metadaten-Warnungen', () => {
    expect(parsed.warnings.join(' ')).not.toMatch(/Zeitraum|Z-Zähler|Kostenstelle/);
  });

  it('liefert einen stabilen Checksum (Idempotenz-Grundlage)', () => {
    const second = parseGnZBerichtPdf(fixture.pages, 'anderer-name.pdf');
    expect(second.checksum).toBe(parsed.checksum);
    expect(parsed.checksum).not.toBe('');
  });
});

describe('parseGnZBerichtPdf — Kernsektionen (SSoT-Kern, identisch zu CSV)', () => {
  it('liest die Umsatzbox: Total 12225.20, exkl. Aufladung 12145.20', () => {
    expect(parsed.revenue.totalGross).toBeCloseTo(12225.20, 2);
    expect(parsed.revenue.totalExclCardTopups).toBeCloseTo(12145.20, 2);
  });

  it('Steuerbericht: 3 Sätze, Brutto-Summe = Berichtstotal', () => {
    expect(parsed.taxes).toHaveLength(3);
    expect(parsed.taxes.map(t => t.taxRate)).toEqual(['0', '2.6', '8.1']);
    const gross = parsed.taxes.reduce((s, t) => s + t.grossAmount, 0);
    expect(gross).toBeCloseTo(12225.20, 2);
    expect(parsed.taxNetTotal).toBeCloseTo(11366.90, 2);
  });

  it('Kostenstellen: 2 Zeilen, Summe = Berichtstotal', () => {
    expect(parsed.costCenters).toHaveLength(2);
    expect(parsed.costCenters.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(12225.20, 2);
  });

  it('Kellner: 7 Zeilen, Bon-Anzahl 174, Durchschnittsbon aus Rohwerten', () => {
    expect(parsed.waiters).toHaveLength(7);
    expect(parsed.bonCount).toBe(174);
    expect(parsed.avgBon).toBeCloseTo(12225.20 / 174, 2);
  });

  it('Hauptwarengruppen: Betrag NACH Positionsrabatt + Original in Klammern', () => {
    expect(parsed.productGroups).toHaveLength(2);
    const bev = parsed.productGroups.find(g => g.name.startsWith('Beverage'))!;
    const food = parsed.productGroups.find(g => g.name.startsWith('Food'))!;
    expect(bev.amount).toBeCloseTo(3338.80, 2);
    expect(bev.originalAmount).toBeCloseTo(3404.90, 2);
    expect(food.amount).toBeCloseTo(9625.00, 2);
    expect(food.originalAmount).toBeCloseTo(9694.00, 2);
  });

  it('Rabatte: 2 Bestellrabatte (−818.60) und 9 Positionsrabatte (−135.10)', () => {
    const rabatte = parsed.discounts.filter(d => d.type === 'rabatt');
    const posRabatte = parsed.discounts.filter(d => d.type === 'positionsrabatt');
    expect(rabatte).toHaveLength(2);
    expect(rabatte.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(-818.60, 2);
    expect(posRabatte).toHaveLength(9);
    expect(posRabatte.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(-135.10, 2);
  });

  it('Stornierte Artikel: 1 Zeile (Bedienerfehler, 57.30)', () => {
    expect(parsed.cancellations).toHaveLength(1);
    expect(parsed.cancellations[0].name).toBe('Bedienerfehler');
    expect(parsed.cancellations[0].amount).toBeCloseTo(57.30, 2);
  });

  it('Buchungskonten: 27 Zeilen, Summe = Berichtstotal (inkl. negativer Zeilen)', () => {
    expect(parsed.accountingLines).toHaveLength(27);
    const sum = parsed.accountingLines.reduce((s, a) => s + a.grossAmount, 0);
    expect(sum).toBeCloseTo(12225.20, 2);
    // CHF-0.00-Zeilen bleiben erhalten
    expect(parsed.accountingLines.some(a => a.grossAmount === 0)).toBe(true);
  });

  it('Zahlungskonten: 6 Zeilen, Summe = Berichtstotal', () => {
    expect(parsed.paymentAccounts).toHaveLength(6);
    expect(parsed.paymentAccounts.reduce((s, a) => s + a.grossAmount, 0)).toBeCloseTo(12225.20, 2);
  });
});

describe('parseGnZBerichtPdf — Parent/Child-Zahlarten (keine Doppelzählung)', () => {
  it('zählt nur die 6 Parent-Zahlarten; Summe = Berichtstotal', () => {
    expect(parsed.paymentMethods).toHaveLength(6);
    expect(parsed.paymentMethods.map(m => m.name).sort()).toEqual(
      ['Bar', 'EC-Karte', 'Kartenzahlung', 'MasterCard', 'TWINT', 'Visa'],
    );
    expect(parsed.paymentMethods.reduce((s, m) => s + m.amount, 0)).toBeCloseTo(12225.20, 2);
    expect(parsed.paymentMethods.some(m => /gastronovi\s*pay/i.test(m.name))).toBe(false);
  });

  it('behält Kind-Zahlarten informativ als paymentMethodProviders', () => {
    expect(parsed.paymentMethodProviders).toHaveLength(5);
    for (const p of parsed.paymentMethodProviders!) {
      expect(p.name).toBe('Gastronovi Pay');
    }
    expect(parsed.paymentMethodProviders!.map(p => p.parent).sort()).toEqual(
      ['EC-Karte', 'Kartenzahlung', 'MasterCard', 'TWINT', 'Visa'],
    );
    // Kind über Seitenumbruch (MasterCard-Kind steht auf Seite 2)
    const mc = parsed.paymentMethodProviders!.find(p => p.parent === 'MasterCard')!;
    expect(mc.amount).toBeCloseTo(6824.60, 2);
  });
});

describe('parseGnZBerichtPdf — Aufladungen, Zeitabschnitte, Detailbericht', () => {
  it('Aufladung Kundenkarten: 2 Karten à 40.00, Total 80.00', () => {
    expect(parsed.customerCardTopups).toHaveLength(2);
    expect(parsed.customerCardTopups!.reduce((s, t) => s + t.amount, 0)).toBeCloseTo(80.00, 2);
    expect(parsed.customerCardTopupTotal).toBeCloseTo(80.00, 2);
  });

  it('Zeitabschnitte: 24 Stunden, negative Werte bleiben erhalten', () => {
    expect(parsed.hourlyRevenue).toHaveLength(24);
    const h23 = parsed.hourlyRevenue!.find(h => h.hour === 23)!;
    expect(h23.totalAmount).toBeCloseTo(-651.60, 2);
    expect(h23.sharePct).toBeCloseTo(-5.33, 2);
    const sum = parsed.hourlyRevenue!.reduce((s, h) => s + h.totalAmount, 0);
    expect(sum).toBeCloseTo(12225.20, 2);
    expect(parsed.hourlyRevenueTotal).toBeCloseTo(12225.20, 2);
  });

  it('Detailbericht: Inner/Ausser-Haus-Split und CHF-0.00-Positionen bleiben', () => {
    const ext = parsed.extendedData!;
    expect(ext.mainCategoriesByConsumptionType).toHaveLength(4);
    const bevOut = ext.mainCategoriesByConsumptionType.find(
      e => e.name.startsWith('Beverage') && e.consumptionType === 'takeaway',
    )!;
    expect(bevOut.grossAmount).toBeCloseTo(17.50, 2);
    // CHF-0.00-Positionen werden NICHT verworfen (z. B. Menu-Inklusivpositionen)
    const sushi = ext.positions.find(p => p.name === 'Sushi/Sashimi Teller')!;
    expect(sushi.quantity).toBe(9);
    expect(sushi.grossAmount).toBe(0);
    // Positions-Original vor Rabatt bleibt erhalten
    expect(ext.positions.some(p => p.originalAmount !== null && p.originalAmount > p.grossAmount)).toBe(true);
  });
});

describe('parseGnZBerichtPdf — Plausibilitätsprüfung', () => {
  it('führt alle 8 Pflicht-Checks aus', () => {
    const ids = parsed.validation!.checks.map(c => c.id);
    expect(ids).toEqual([
      'steuer_total', 'kostenstellen', 'zahlarten', 'hauptwarengruppen',
      'inner_ausser', 'zeitabschnitte', 'zahlungskonten', 'buchungskonten',
    ]);
  });

  it('bewertet den konsistenten Beispielbericht als plausibel', () => {
    expect(parsed.validation!.status).toBe('plausibel');
    for (const check of parsed.validation!.checks) {
      expect(check.status).toBe('plausibel');
      expect(check.diff).not.toBeNull();
      expect(Math.abs(check.diff!)).toBeLessThanOrEqual(0.05);
    }
  });

  it('Hauptwarengruppen-Check: 12963.80 − 818.60 + 80.00 = 12225.20', () => {
    const check = parsed.validation!.checks.find(c => c.id === 'hauptwarengruppen')!;
    expect(check.expected).toBeCloseTo(12225.20, 2);
    expect(check.actual).toBeCloseTo(12225.20, 2);
  });
});
