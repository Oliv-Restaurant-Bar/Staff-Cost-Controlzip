// @vitest-environment node
/**
 * Tests der Profil-Logik (Defaults, Normalisierung, aktives Profil je Datum,
 * Festsetzen/Lock, Profil-Slug).
 */
import { describe, it, expect } from 'vitest';
import {
  defaultStaffingProfilesConfig,
  normalizeStaffingProfilesConfig,
  resolveActiveProfileForDate,
  isDateInMonthDayRange,
  isProfileLocked,
  profileKeyFromLabel,
  ugSurchargeApplies,
  dataSeasonForProfile,
  buildEffectiveRequirements,
} from '@/lib/staffing-profiles-utils';

describe('Defaults', () => {
  it('Oliv: Standard + Winter/UG, CdS Artin>Mendim>Ibrahim, Umsatzbudget', () => {
    const c = defaultStaffingProfilesConfig('oliv');
    expect(c.profiles.map((p) => p.key)).toEqual(['standard', 'winter']);
    expect(c.profiles[1].label).toBe('Winter/UG');
    expect(c.profiles[1].activeFrom).toBe('10-01');
    expect(c.cdsPriority).toEqual(['2', '103', '105']);
    expect(c.revenueBudgetByWeekday[1]).toBe(5000);
    expect(c.revenueBudgetByWeekday[5]).toBe(12000);
    expect(c.revenueBudgetByWeekday[7]).toBe(7000);
  });
  it('Beaulieu: leere CdS-Liste, kein Umsatzbudget, leerer UG-Zuschlag', () => {
    const c = defaultStaffingProfilesConfig('beaulieu');
    expect(c.cdsPriority).toEqual([]);
    expect(Object.keys(c.revenueBudgetByWeekday)).toHaveLength(0);
    expect(c.ugSurcharge.entries).toEqual([]);
  });
  it('Oliv: UG-Zuschlag Bar unten +1 / Service +2, Fr+Sa; Winter abgeleitet von Standard', () => {
    const c = defaultStaffingProfilesConfig('oliv');
    expect(c.ugSurcharge.entries).toEqual([
      { positionKey: 'bar_unten', count: 1 },
      { positionKey: 'service', count: 2 },
    ]);
    expect(c.ugSurcharge.weekdays).toEqual([5, 6]);
    expect(c.profiles.find((p) => p.key === 'winter')?.baseKey).toBe('standard');
    expect(c.profiles.find((p) => p.key === 'standard')?.baseKey).toBeNull();
  });
});

describe('normalizeStaffingProfilesConfig', () => {
  it('null/kaputt → Defaults', () => {
    expect(normalizeStaffingProfilesConfig(null, 'oliv').profiles).toHaveLength(2);
    expect(normalizeStaffingProfilesConfig('quatsch', 'oliv').profiles).toHaveLength(2);
  });
  it('gespeicherte Profile gewinnen, standard/winter bleiben immer vorhanden', () => {
    const c = normalizeStaffingProfilesConfig(
      {
        profiles: [
          { key: 'winter', label: 'Winter/UG', activeFrom: '11-15', activeTo: '02-28', locked: true },
          { key: 'profil_sommerfest', label: 'Sommerfest', activeFrom: '08-01', activeTo: '08-15', locked: false },
        ],
        cdsPriority: ['a', 'b'],
      },
      'oliv',
    );
    expect(c.profiles.map((p) => p.key)).toEqual(['standard', 'winter', 'profil_sommerfest']);
    expect(c.profiles[1].activeFrom).toBe('11-15');
    expect(c.profiles[1].locked).toBe(true);
    expect(c.cdsPriority).toEqual(['a', 'b']);
  });
  it('ungültige MM-TT-Werte werden verworfen', () => {
    const c = normalizeStaffingProfilesConfig(
      { profiles: [{ key: 'winter', label: 'W', activeFrom: '13-40', activeTo: 'xx' }] },
      'oliv',
    );
    expect(c.profiles[1].activeFrom).toBeNull();
    expect(c.profiles[1].activeTo).toBeNull();
  });
});

describe('isDateInMonthDayRange (inkl. Jahreswechsel)', () => {
  it('normaler Bereich', () => {
    expect(isDateInMonthDayRange(new Date(2026, 7, 5), '08-01', '08-15')).toBe(true);
    expect(isDateInMonthDayRange(new Date(2026, 7, 20), '08-01', '08-15')).toBe(false);
  });
  it('über Jahreswechsel (10-01..03-31)', () => {
    expect(isDateInMonthDayRange(new Date(2026, 11, 24), '10-01', '03-31')).toBe(true);
    expect(isDateInMonthDayRange(new Date(2026, 1, 10), '10-01', '03-31')).toBe(true);
    expect(isDateInMonthDayRange(new Date(2026, 6, 1), '10-01', '03-31')).toBe(false);
    // Grenztage einschliesslich
    expect(isDateInMonthDayRange(new Date(2026, 9, 1), '10-01', '03-31')).toBe(true);
    expect(isDateInMonthDayRange(new Date(2026, 2, 31), '10-01', '03-31')).toBe(true);
  });
  it('kein Bereich → false', () => {
    expect(isDateInMonthDayRange(new Date(2026, 0, 1), null, null)).toBe(false);
  });
});

describe('resolveActiveProfileForDate', () => {
  const config = defaultStaffingProfilesConfig('oliv');
  it('Winter/UG ab 01.10., sonst Standard', () => {
    expect(resolveActiveProfileForDate(config, new Date(2026, 9, 1))).toBe('winter');
    expect(resolveActiveProfileForDate(config, new Date(2026, 0, 15))).toBe('winter');
    expect(resolveActiveProfileForDate(config, new Date(2026, 6, 30))).toBe('standard');
  });
});

describe('UG-Zuschlag', () => {
  const config = defaultStaffingProfilesConfig('oliv');

  it('alte Blobs ohne baseKey: winter wird trotzdem abgeleitet', () => {
    const c = normalizeStaffingProfilesConfig(
      { profiles: [{ key: 'winter', label: 'Winter/UG', activeFrom: '10-01' }] },
      'oliv',
    );
    expect(c.profiles.find((p) => p.key === 'winter')?.baseKey).toBe('standard');
    expect(c.ugSurcharge.entries).toHaveLength(2); // Default ergänzt
  });

  it('ugSurchargeApplies: Winter Fr/Sa ja, Winter Mo nein, Standard Fr nein', () => {
    expect(ugSurchargeApplies({ config, season: 'winter', weekday: 5, eventOpen: false })).toBe(true);
    expect(ugSurchargeApplies({ config, season: 'winter', weekday: 6, eventOpen: false })).toBe(true);
    expect(ugSurchargeApplies({ config, season: 'winter', weekday: 1, eventOpen: false })).toBe(false);
    expect(ugSurchargeApplies({ config, season: 'standard', weekday: 5, eventOpen: false })).toBe(false);
  });

  it('Event-Flag: ganzjährig, profil-unabhängig; ohne Zuschlags-Posten nie', () => {
    expect(ugSurchargeApplies({ config, season: 'standard', weekday: 2, eventOpen: true })).toBe(true);
    const beaulieu = defaultStaffingProfilesConfig('beaulieu');
    expect(ugSurchargeApplies({ config: beaulieu, season: 'winter', weekday: 5, eventOpen: true })).toBe(false);
  });

  it('dataSeasonForProfile: winter → standard, standard/custom bleiben', () => {
    expect(dataSeasonForProfile(config, 'winter')).toBe('standard');
    expect(dataSeasonForProfile(config, 'standard')).toBe('standard');
    expect(dataSeasonForProfile(config, 'profil_x')).toBe('profil_x');
  });

  const req = (over: Record<string, unknown>) => ({
    id: 'r1', season: 'standard', weekday: 5, positionKey: 'service',
    shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2,
    meta: {} as Record<string, unknown>, ...over,
  });

  it('buildEffectiveRequirements: Winter Fr = Standard-Zeilen + Zuschlag auf späteste Schicht', () => {
    const reqs = [
      req({ id: 'a', shiftStart: '11:00', shiftEnd: '14:00' }),
      req({ id: 'b', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3 }),
      req({ id: 'c', positionKey: 'kueche' }),
    ];
    const eff = buildEffectiveRequirements({ requirements: reqs, config, season: 'winter', weekday: 5, eventOpen: false });
    // umgeschlüsselt auf winter, damit Konsumenten nach season filtern können
    expect(eff.every((r) => r.season === 'winter')).toBe(true);
    expect(eff.find((r) => r.id === 'a')?.requiredCount).toBe(2); // Mittag unverändert
    expect(eff.find((r) => r.id === 'b')?.requiredCount).toBe(5); // 3 + Service+2 (späteste)
    // bar_unten hatte keine Zeile → synthetische Abend-Zeile +1
    const synth = eff.find((r) => r.positionKey === 'bar_unten');
    expect(synth?.requiredCount).toBe(1);
    expect(synth?.meta.synthetic).toBe(true);
    // Eingabe nicht mutiert
    expect(reqs.find((r) => r.id === 'b')?.requiredCount).toBe(3);
  });

  it('buildEffectiveRequirements: Standard ohne Event-Flag = unverändert; mit Flag = Zuschlag', () => {
    const reqs = [req({ id: 'b', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3, weekday: 2 })];
    const plain = buildEffectiveRequirements({ requirements: reqs, config, season: 'standard', weekday: 2, eventOpen: false });
    expect(plain.find((r) => r.id === 'b')?.requiredCount).toBe(3);
    const withEvent = buildEffectiveRequirements({ requirements: reqs, config, season: 'standard', weekday: 2, eventOpen: true });
    expect(withEvent.find((r) => r.id === 'b')?.requiredCount).toBe(5);
    expect(withEvent.find((r) => r.positionKey === 'bar_unten')?.requiredCount).toBe(1);
  });

  it('buildEffectiveRequirements: Zuschlag greift nur am angefragten Wochentag', () => {
    const reqs = [
      req({ id: 'fr', weekday: 5, shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3 }),
      req({ id: 'sa', weekday: 6, shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3 }),
    ];
    const eff = buildEffectiveRequirements({ requirements: reqs, config, season: 'winter', weekday: 5, eventOpen: false });
    expect(eff.find((r) => r.id === 'fr')?.requiredCount).toBe(5);
    expect(eff.find((r) => r.id === 'sa')?.requiredCount).toBe(3); // anderer Tag unverändert
  });
});

describe('Lock + Slug', () => {
  it('isProfileLocked', () => {
    const c = normalizeStaffingProfilesConfig(
      { profiles: [{ key: 'winter', label: 'W', locked: true }] },
      'oliv',
    );
    expect(isProfileLocked(c, 'winter')).toBe(true);
    expect(isProfileLocked(c, 'standard')).toBe(false);
    expect(isProfileLocked(c, 'gibtsnicht')).toBe(false);
  });
  it('profileKeyFromLabel', () => {
    expect(profileKeyFromLabel('Sommerfest 2026')).toBe('profil_sommerfest_2026');
    expect(profileKeyFromLabel('Ostern/Brunch')).toBe('profil_ostern_brunch');
    expect(profileKeyFromLabel('   ')).toBe('');
  });
});
