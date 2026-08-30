// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseControlListWorkbook, parseControlListXls, parseEffectiveWindows } from '@/lib/control-list-import';
import { aggregateProductivityDays, aggregateProductivityWeeks, lastFiveProductivityWeeks } from '@/lib/control-list-productivity';
import { mergeControlListHistory } from '@/lib/control-list-history';
import { departmentFromDailyHoursMeta } from '@/lib/control-list-department-seed';

function reportSheet(): XLSX.WorkBook {
  const rows: unknown[][] = Array.from({ length: 12 }, () => Array(30).fill(''));
  rows[0][2] = 'Kontrollliste 01.08.2026 - 07.08.2026';
  rows[1][2] = '3027 Restaurant OLIV';
  rows[7][2] = 'Muster Mia';
  rows[8][3] = 46235; // 2026-08-01, Excel 1899-12-30 epoch
  rows[8][6] = '1 Manuell';
  rows[8][9] = 9.5;
  rows[8][12] = 0; // deliberately not Ist
  rows[8][15] = '10:00 - 14:00\n17:30 - 23:00';
  rows[8][18] = 9.5;
  rows[8][20] = 8.4; // authoritative net (not the 9.5/segment span)
  rows[8][23] = -1.1;
  rows[8][26] = 'Manuell';
  rows[9][3] = 46236;
  rows[9][12] = 7;
  rows[9][15] = '17:39 - 00:17';
  rows[9][20] = 7;
  rows[10][2] = 'Total';
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [XLSX.utils.decode_range('C1:D1'), XLSX.utils.decode_range('C2:D2')];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'report_test');
  return workbook;
}

describe('Kontrollliste report_test importer', () => {
  it('uses merged anchors, fixed columns, serial dates, and stops at Total', () => {
    const document = parseControlListWorkbook(reportSheet());
    expect(document.period).toContain('01.08.2026');
    expect(document.tenant).toBe('3027 Restaurant OLIV');
    expect(document.employees).toHaveLength(1);
    const [employee] = document.employees;
    expect(employee.inIst).toBe(true);
    expect(employee.days).toHaveLength(2);
    expect(employee.days[0]).toMatchObject({
      date: '2026-08-01', rawTimeRecording: '1 Manuell', timeRecordingGross: 9.5,
      timeRecordingTotal: 0, effectiveGross: 9.5, netHours: 8.4, difference: -1.1, status: 'Manuell',
    });
    expect(employee.days[0].danger).toBe(false);
    expect(employee.days[1].effectiveWindows).toEqual([{ start: 17.65, end: 24 + 17 / 60 }]);
    expect(employee.days[1].danger).toBe(true);
  });

  it('merges corrected stamps only across gaps of 30 minutes or less', () => {
    expect(parseEffectiveWindows('10:35 - 11:10\n11:12 - 13:31\n13:34 - 15:27'))
      .toEqual([{ start: 10 + 35 / 60, end: 15 + 27 / 60 }]);
    expect(parseEffectiveWindows('10:00 - 14:00\n17:30 - 23:00')).toHaveLength(2);
    expect(parseEffectiveWindows('23:00 - 00:00')).toEqual([{ start: 23, end: 24 }]);
  });

  it('rejects renamed .xlsx or arbitrary input instead of silently accepting it as legacy .xls', () => {
    expect(() => parseControlListXls(new Uint8Array([0x50, 0x4b, 0x03, 0x04])))
      .toThrow('echte MIRUS-.xls-Datei');
  });
});

describe('pure productivity models', () => {
  it('aggregates net hours and supplied daily net revenue using the 100 CHF/h budget', () => {
    const daily = aggregateProductivityDays(
      [{ date: '2026-08-03', netHours: 8 }, { date: '2026-08-03', netHours: 2 }, { date: '2026-08-04', netHours: 4 }],
      { '2026-08-03': 1000, '2026-08-04': 300 },
    );
    expect(daily.map(day => [day.netHours, day.productivity, day.meetsBudget]))
      .toEqual([[10, 100, true], [4, 75, false]]);
    const weeks = aggregateProductivityWeeks(daily);
    expect(weeks[0]).toMatchObject({ netHours: 14, revenue: 1300, productivity: 1300 / 14 });
    expect(lastFiveProductivityWeeks([...weeks, ...weeks, ...weeks, ...weeks, ...weeks, ...weeks])).toHaveLength(5);
  });

  it('keeps five real imported weeks and replaces a re-imported week atomically', () => {
    const dates: Record<number, string> = {
      30: '2026-07-20', 31: '2026-07-27', 32: '2026-08-03',
      33: '2026-08-10', 34: '2026-08-17', 35: '2026-08-24',
    };
    const makeDocument = (week: number, hours: number) => ({
      tenant: '3027 Restaurant OLIV',
      period: `KW ${week}`,
      employees: [{ name: 'Muster Mia', inIst: true, days: [{
        date: dates[week], rawTimeRecording: '', timeRecordingGross: hours,
        timeRecordingTotal: hours, effectiveWindows: [], effectiveGross: hours,
        netHours: hours, difference: 0, status: '', danger: false,
      }] }],
    });
    let history = makeDocument(30, 1);
    for (let week = 31; week <= 35; week++) history = mergeControlListHistory(history, makeDocument(week, week));
    expect(new Set(history.employees[0].days.map(day => day.netHours))).toEqual(new Set([31, 32, 33, 34, 35]));
    history = mergeControlListHistory(history, makeDocument(35, 99));
    expect(history.employees[0].days.filter(day => day.netHours === 99)).toHaveLength(1);
    expect(history.employees[0].days).toHaveLength(5);
  });

  it('maps daily-hours department codes 1, 2 and 4 explicitly', () => {
    expect(departmentFromDailyHoursMeta('Küche', '1 Küche')).toBe('kueche');
    expect(departmentFromDailyHoursMeta('Service', '2 Service')).toBe('service');
    expect(departmentFromDailyHoursMeta(null, '4 Geschäftsleitung')).toBe('geschaeftsleitung');
  });
});