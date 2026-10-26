import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { buildSchedulePdf, pdfCellText, pdfFileName, PDF_THEMES } from '../schedule-pdf';
import type { PublicDay, WeekPayload } from '../schedule-publish-payload';

function day(date: string, over: Partial<PublicDay> = {}): PublicDay {
  return { date, früh: null, spät: null, frühAbsence: null, spätAbsence: null, ...over };
}

function week(weekStart: string, kw: number, employeeCount: number): WeekPayload {
  const start = new Date(`${weekStart}T00:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  return {
    version: 1,
    department: 'service',
    weekStart,
    weekEnd: dates[6],
    kw,
    employees: Array.from({ length: employeeCount }, (_, i) => ({
      id: `e${i}`,
      name: `Mitarbeiter ${i + 1}`,
      days: dates.map((d, j) =>
        j % 3 === 0
          ? day(d, { früh: { start: '10:00', end: '14:00' }, spät: { start: '17:00', end: '22:00' } })
          : j % 3 === 1
            ? day(d, { frühAbsence: 'Ferien' })
            : day(d),
      ),
    })),
  };
}

const b64 = (f: string) => fs.readFileSync(`public/fonts/${f}`).toString('base64');
const FONTS = {
  jostRegular: b64('Jost_400Regular.ttf'),
  jostSemiBold: b64('Jost_600SemiBold.ttf'),
  cormorantBold: b64('CormorantGaramond_700Bold-latin.ttf'),
};

const opts = { department: 'service' as const, theme: PDF_THEMES.oliv };

describe('schedule-pdf', () => {
  it('Zellentext: Schichten untereinander, sonst Abwesenheit', () => {
    expect(pdfCellText(day('2026-10-19', { früh: { start: '10:00', end: '14:00' }, spät: { start: '17:00', end: '22:00' } }))).toBe(
      '10:00–14:00\n17:00–22:00',
    );
    expect(pdfCellText(day('2026-10-19', { spätAbsence: 'Abwesend' }))).toBe('Abwesend');
    expect(pdfCellText(day('2026-10-19'))).toBe('');
    expect(pdfCellText(undefined)).toBe('');
  });

  it('eine Woche pro Seite', () => {
    const doc = buildSchedulePdf(
      [{ payload: week('2026-10-19', 43, 12) }, { payload: week('2026-10-26', 44, 12) }, { payload: week('2026-11-02', 45, 12) }],
      opts,
    );
    expect(doc.getNumberOfPages()).toBe(3);
  });

  it('eine große Abteilung (35 Personen) passt auf eine Seite pro Woche', () => {
    const doc = buildSchedulePdf([{ payload: week('2026-10-19', 43, 35) }, { payload: week('2026-10-26', 44, 35) }], opts);
    expect(doc.getNumberOfPages()).toBe(2);
  });

  it('Seite ist A4 quer', () => {
    const doc = buildSchedulePdf([{ payload: week('2026-10-19', 43, 3) }], opts);
    const { width, height } = doc.internal.pageSize;
    expect(width).toBeGreaterThan(height);
  });

  it('Filter auf eine Person', () => {
    const doc = buildSchedulePdf([{ payload: week('2026-10-19', 43, 40) }], { ...opts, onlyName: 'Mitarbeiter 2' });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('mit eingebetteten Schriften (Umlaute, Beaulieu-Titel) ohne Fehler', () => {
    const w = { payload: { ...week('2026-10-19', 43, 5), department: 'kueche' as const } };
    const oliv = buildSchedulePdf([w], { department: 'kueche', theme: PDF_THEMES.oliv, fonts: FONTS });
    const beau = buildSchedulePdf([w], { department: 'kueche', theme: PDF_THEMES.beaulieu, fonts: FONTS });
    expect(oliv.getNumberOfPages()).toBe(1);
    expect(beau.getNumberOfPages()).toBe(1);
    expect(Object.keys(beau.getFontList())).toContain('Cormorant');
  });

  it('Dateiname', () => {
    expect(pdfFileName('kueche', [{ payload: week('2026-10-19', 43, 1) }], 'oliv')).toBe(
      'dienstplan-oliv-kueche-kw43.pdf',
    );
    expect(
      pdfFileName('service', [{ payload: week('2026-10-19', 43, 1) }, { payload: week('2026-10-26', 44, 1) }], 'beaulieu'),
    ).toBe('dienstplan-beaulieu-service-kw43-44.pdf');
  });
});
