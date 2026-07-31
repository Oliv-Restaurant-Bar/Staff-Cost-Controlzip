// @vitest-environment happy-dom
/**
 * Integrationstest Lohnart-Wechsel MITTEN im Monat (Personalkosten-SSOT):
 *  (1) Fix-Kosten = Monatslohn × monthlyFraction,
 *  (2) Flex-Seite läuft ausschliesslich über die Pseudo-id `<empId>::flexsplit`,
 *  (3) nur die Tages-Stunden der Stundenlohn-Phase erzeugen Flex-Kosten.
 * Nutzt die puren Rechenfunktionen fixKosten/flexKostenProTagDetail mit einem
 * synthetischen PersonalkostenDaten-Objekt (wie es ladePersonalkostenDaten baut).
 */
import { describe, it, expect } from 'vitest';
import { fixKosten, flexKostenProTagDetail, type PersonalkostenDaten } from '../personalkosten';
import { getEffectiveHourlyRate } from '../employee-rate';
import type { Employee } from '@/types/personnel';
import type { MonthWageSplit } from '../wage-history';

const emp = (over: Partial<Employee>): Employee => ({
  id: '7', name: 'Split MA', department: 'service', employmentType: 'vollzeit',
  contractType: 'monthly', hourlyWage: 0, monthlySalary: 6000, monthlySalaryWith13th: 6500,
  ...over,
} as unknown as Employee);

// August 2026 (31 Tage): Stundenlohn 01.–15.08. (CHF 30/h), Monatslohn ab 16.08.
const split: MonthWageSplit = {
  monthly: { hourlyWage: 0, monthlySalary: 6000, monthlySalaryWith13th: 6500, salary13: true, source: 'history', wageType: 'monthly' },
  hourly:  { hourlyWage: 30, salary13: false, source: 'history', wageType: 'hourly' },
  monthlyFrom: '2026-08-16', monthlyTo: '2026-08-31',
  hourlyFrom:  '2026-08-01', hourlyTo:  '2026-08-15',
  monthlyFraction: 16 / 31, hourlyFraction: 15 / 31,
};

const fixEmp  = emp({});
const flexPseudo = emp({
  id: '7::flexsplit', contractType: 'hourly', hourlyWage: 30, monthlySalary: 0, monthlySalaryWith13th: 0,
});

const rates = { ahv: 0, alv: 0, nbu: 0, bu: 0, ktg: 0, bvg: 0, fak: 0, vk: 0 } as any; // agFactor = 1

const daten: PersonalkostenDaten = {
  year: 2026, month: 8, daysInMonth: 31,
  fixEmployees: [fixEmp],
  flexEmployees: [flexPseudo],
  wageSplits: { '7': split },
  agFactor: 1,
  rates,
  // Wie ladePersonalkostenDaten nach der Verschiebung: Stundenlohn-Tage auf
  // Pseudo-id, Monatslohn-Tage entfernt.
  planStdProTag: {
    '2026-08-10': { '7::flexsplit': 8 },   // Stundenlohn-Phase → Flex
    '2026-08-20': {},                       // Monatslohn-Phase → entfernt, keine Flex-Kosten
  },
  istStdProTag: {},
  istTage: new Set<string>(),
  umsatzIstProTag: {}, umsatzBudgetMonat: 0, zielQuotePct: 35.5, pkBudgetMonat: null,
  gewichte: {} as any,
} as PersonalkostenDaten;

describe('Personalkosten Lohnart-Wechsel (Split-Monat)', () => {
  it('(1) Fix-Kosten = Monatslohn inkl. 13. × monthlyFraction', () => {
    const fix = fixKosten(daten);
    expect(fix.zeilen).toHaveLength(1);
    expect(fix.zeilen[0].kostenMonat).toBeCloseTo(6500 * (16 / 31), 2);
    expect(fix.zeilen[0].label).toContain('Lohnart-Wechsel');
  });

  it('(2)+(3) Flex nur über Pseudo-id und nur Stundenlohn-Tage', () => {
    const flex = flexKostenProTagDetail(daten, { stichtag: 0 });
    const tag10 = flex.tage.find(t => t.date === '2026-08-10')!;
    const tag20 = flex.tage.find(t => t.date === '2026-08-20')!;
    expect(Object.keys(tag10.proMa)).toEqual(['7::flexsplit']);
    // Satz = Total-AG-Stundensatz (SL-Brutto inkl. Zuschläge), wie überall im SSOT
    const rate = getEffectiveHourlyRate(flexPseudo, rates) ?? 0;
    expect(rate).toBeGreaterThan(0);
    expect(tag10.planKosten).toBeCloseTo(8 * rate, 2);
    expect(tag20.planKosten).toBe(0);
    expect(Object.keys(tag20.proMa)).toHaveLength(0);
    // Reale id '7' erzeugt nirgends Flex-Kosten
    for (const t of flex.tage) expect(t.proMa['7']).toBeUndefined();
  });
});
