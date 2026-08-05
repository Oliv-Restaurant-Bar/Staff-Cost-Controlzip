// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { isAgSozOff, setAgSozOffFlag, loadAgSozOffMap, agSozBaseId } from '@/lib/ag-soz-flags';
import { getEmployerCostRate, getEffectiveHourlyRate } from '@/lib/employee-rate';
import type { Employee } from '@/types/personnel';
import type { SocialCostRates } from '@/lib/social-costs';

const rates: SocialCostRates = {
  ahvPct: 5.3, alvPct: 1.1, fakPct: 1.6, vkPct: 0.1, uvgBuPct: 1.0, ktgPct: 1.0, bvgPct: 3.5,
} as unknown as SocialCostRates;

const emp = {
  id: 'emp-22', name: 'Aushilfe', hourlyWage: 26.0, has13thSalary: false,
} as unknown as Employee;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('active_tenant', 'oliv');
});

describe('ag-soz-flags', () => {
  it('default: mit AG (flag aus, kein Eintrag)', () => {
    expect(isAgSozOff('emp-22')).toBe(false);
    const br = getEmployerCostRate(emp, rates)!;
    expect(br.agOff).toBeUndefined();
    expect(br.totalHourly).toBeGreaterThan(br.grossHourly);
    expect(br.totalHourly).toBeCloseTo(br.grossHourly + br.socialHourly, 6);
  });

  it('flag AN → totalHourly = grossHourly, socialHourly = 0, Stundenbasis egal', () => {
    const before = getEmployerCostRate(emp, rates)!;
    setAgSozOffFlag('oliv', 'emp-22', true);
    const br = getEmployerCostRate(emp, rates)!;
    expect(br.agOff).toBe(true);
    expect(br.totalHourly).toBeCloseTo(before.grossHourly, 6);
    expect(br.socialHourly).toBe(0);
    expect(getEffectiveHourlyRate(emp, rates)).toBeCloseTo(before.grossHourly, 6);
  });

  it('mandantengetrennt: beaulieu-Flag wirkt nicht für oliv', () => {
    setAgSozOffFlag('beaulieu', 'emp-22', true);
    expect(isAgSozOff('emp-22')).toBe(false); // aktiver Tenant oliv
    localStorage.setItem('active_tenant', 'beaulieu');
    expect(isAgSozOff('emp-22')).toBe(true);
  });

  it('Split-Pseudo-ID wird auf Basis-ID normalisiert', () => {
    setAgSozOffFlag('oliv', 'emp-22::flexsplit', true);
    expect(agSozBaseId('emp-22::flexsplit')).toBe('emp-22');
    expect(isAgSozOff('emp-22')).toBe(true);
    expect(isAgSozOff('emp-22::flexsplit')).toBe(true);
  });

  it('Flag löschen entfernt Key; Map-Load liefert nur aktive Flags', () => {
    setAgSozOffFlag('oliv', 'emp-22', true);
    expect(loadAgSozOffMap('oliv')).toEqual({ 'emp-22': true });
    setAgSozOffFlag('oliv', 'emp-22', false);
    expect(loadAgSozOffMap('oliv')).toEqual({});
    expect(localStorage.getItem('pfix_ag_soz_off_oliv')).toBeNull();
  });
});
