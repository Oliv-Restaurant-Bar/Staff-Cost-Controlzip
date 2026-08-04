// @vitest-environment node
/**
 * Tests: Übernahme in den Personalstamm (reine Logik).
 * Schwerpunkte: ML→vollzeit/teilzeit+monthly, SL→aushilfe+hourly (Basis OHNE
 * Zuschläge), Presence-Guards (kein ''-Clobber), Duplikat-Erkennung, Hinweise
 * statt geratener Werte.
 */
import { describe, it, expect } from 'vitest';

import { buildEmployeeFromEintritt, findeNamensDuplikate, normalisierterName } from '../uebernahme';
import type { PersonaleintrittRecord } from '../types';

function baseRecord(overrides: Partial<PersonaleintrittRecord> = {}): PersonaleintrittRecord {
  return {
    id: 'test-1',
    restaurantId: 'oliv',
    status: 'geprueft',
    vertragstyp: 'SL',
    funktion: 'Servicemitarbeiterin',
    eintritt: '2026-03-05',
    lohnBerechnet: 20.65,
    lohnEinheit: 'stunde',
    maDaten: {
      personalien: {
        name: 'Muster', vorname: 'Anna',
        strasse: 'Teststrasse 1', plz: '3000', ort: 'Bern',
        geburtsdatum: '2000-12-07', telefon: '076 000 00 00',
        email: 'anna@example.com', heimatort_nationalitaet: 'Bern BE',
      },
      lohnprogramm: { ahv_nr: '756.0000.0000.00', iban: 'CH00 0000 0000 0000 0000 0', kinder: [] },
      vertrag: {},
    },
    ...overrides,
  };
}

describe('buildEmployeeFromEintritt — SL', () => {
  const { employee, hinweise } = buildEmployeeFromEintritt(baseRecord(), 'service', ['1', '2', '10']);

  it('Aushilfe + hourly, Basis-Stundenlohn OHNE Zuschläge', () => {
    expect(employee.employmentType).toBe('aushilfe');
    expect(employee.contractType).toBe('hourly');
    expect(employee.hourlyWage).toBe(20.65);
    expect(employee.has13thSalary).toBe(false);
    expect(hinweise).toHaveLength(0);
  });

  it('übernimmt persönliche Daten + Eckdaten', () => {
    expect(employee.name).toBe('Anna Muster');
    expect(employee.birthDate).toBe('2000-12-07');
    expect(employee.ahvNumber).toBe('756.0000.0000.00');
    expect(employee.positionTitle).toBe('Servicemitarbeiterin');
    expect(employee.contractStart).toBe('2026-03-05');
    expect(employee.department).toBe('service');
  });

  it('setzt fehlende Felder NICHT (kein Leerstring-Clobber)', () => {
    const r = baseRecord();
    r.maDaten!.personalien = { name: 'Muster', vorname: 'Anna' };
    r.maDaten!.lohnprogramm = { kinder: [] };
    const { employee: e } = buildEmployeeFromEintritt(r, 'service', []);
    expect('phone' in e).toBe(false);
    expect('email' in e).toBe(false);
    expect('ahvNumber' in e).toBe(false);
    expect('iban' in e).toBe(false);
  });

  it('ohne Lohn ⇒ hourlyWage 0 + Hinweis', () => {
    const { employee: e, hinweise: h } = buildEmployeeFromEintritt(
      baseRecord({ lohnBerechnet: null }), 'service', []);
    expect(e.hourlyWage).toBe(0);
    expect(h.some(x => x.includes('Stundenlohn'))).toBe(true);
  });
});

describe('buildEmployeeFromEintritt — ML', () => {
  it('100 % ⇒ vollzeit + monthly + 13. ML', () => {
    const { employee: e } = buildEmployeeFromEintritt(
      baseRecord({ vertragstyp: 'ML', pensumProzent: 100, lohnBerechnet: 4600, lohnEinheit: 'monat' }),
      'küche', []);
    expect(e.employmentType).toBe('vollzeit');
    expect(e.contractType).toBe('monthly');
    expect(e.monthlySalary).toBe(4600);
    expect(e.has13thSalary).toBe(true);
    expect(e.monthlySalaryWith13th).toBeCloseTo(4600 * 1.0833, 1);
    expect(e.weeklyHours).toBe(42);
  });

  it('60 % ⇒ teilzeit, Wochenstunden anteilig wenn nicht erfasst', () => {
    const { employee: e } = buildEmployeeFromEintritt(
      baseRecord({ vertragstyp: 'ML', pensumProzent: 60, lohnBerechnet: 2760 }), 'service', []);
    expect(e.employmentType).toBe('teilzeit');
    expect(e.weeklyHours).toBe(25.2);
  });

  it('erfasste Wochenstunden gewinnen gegen den anteiligen Standard', () => {
    const r = baseRecord({ vertragstyp: 'ML', pensumProzent: 60, lohnBerechnet: 2760 });
    r.maDaten!.vertrag = { wochenstunden: 26 };
    const { employee: e } = buildEmployeeFromEintritt(r, 'service', []);
    expect(e.weeklyHours).toBe(26);
  });
});

describe('ID-Vergabe über gemeinsame Logik', () => {
  it('oliv: nächste freie numerische ID', () => {
    const { employee: e } = buildEmployeeFromEintritt(baseRecord(), 'service', ['1', '2', '10']);
    expect(e.id).toBe('11');
  });
  it('beaulieu: b-Präfix', () => {
    const { employee: e } = buildEmployeeFromEintritt(
      baseRecord({ restaurantId: 'beaulieu' }), 'service', ['b-11', 'b-12']);
    expect(e.id).toBe('b-13');
  });
});

describe('findeNamensDuplikate', () => {
  const bestehende = [
    { id: '1', name: 'Anna Muster' },
    { id: '2', name: 'Beat Beispiel' },
  ];
  it('findet Namensgleichheit case-/whitespace-tolerant', () => {
    expect(findeNamensDuplikate('anna  muster', bestehende)).toHaveLength(1);
    expect(findeNamensDuplikate('Anna Muster ', bestehende)[0].id).toBe('1');
  });
  it('leerer Name ⇒ keine Treffer', () => {
    expect(findeNamensDuplikate('  ', bestehende)).toHaveLength(0);
  });
  it('normalisierterName', () => {
    expect(normalisierterName('  Anna   MUSTER ')).toBe('anna muster');
  });
});
