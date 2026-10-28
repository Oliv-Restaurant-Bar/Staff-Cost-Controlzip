import { describe, it, expect } from 'vitest';
import { weeklySourcesFor, weeklyCoverage } from '../weekly-sources';
import { WEEKLY_SOURCES } from '@/lib/import-freshness';

describe('weeklySourcesFor', () => {
  it('maps every type to existing weekly source ids only', () => {
    const ids = new Set<string>(WEEKLY_SOURCES.map(s => s.id));
    const types = ['tagesdaten', 'zbericht-pdf', 'gn-kpi-pdf', 'verkaufsdaten', 'sales-upload', 'mirus-schedule',
      'ist-stunden', 'foratable-reservationen', 'rezensionen', 'umsatzkategorien'] as const;
    for (const t of types) {
      const keys = weeklySourcesFor(t, t === 'tagesdaten' ? 'umsatz' : null);
      expect(keys.length).toBeGreaterThan(0);
      keys.forEach(k => expect(ids.has(k)).toBe(true));
    }
  });

  it('daily data feeds the source of its sub-type', () => {
    expect(weeklySourcesFor('tagesdaten', 'gaeste')).toEqual(['gaeste']);
    expect(weeklySourcesFor('tagesdaten', 'durchschnitt')).toEqual(['avgcheck']);
    expect(weeklySourcesFor('tagesdaten', 'marketing')).toEqual([]);
  });

  it('both Mirus targets feed the Mirus source; one-off types feed none', () => {
    expect(weeklySourcesFor('mirus-schedule', null)).toEqual(['mirus']);
    expect(weeklySourcesFor('ist-stunden', null)).toEqual(['mirus']);
    expect(weeklySourcesFor('kontoblatt', null)).toEqual([]);
  });
});

describe('KPI reports cover exactly the weekly source they feed', () => {
  it('Anzahl Personen → Gäste only; Durchschnittsbon → Durchschnittsverkauf only; Umsatz pro Person → none', () => {
    expect(weeklySourcesFor('gn-kpi-pdf', null, 'anzahl_personen')).toEqual(['gaeste']);
    expect(weeklySourcesFor('gn-kpi-pdf', null, 'durchschnittsbon')).toEqual(['avgcheck']);
    expect(weeklySourcesFor('gn-kpi-pdf', null, 'umsatz_pro_person')).toEqual([]);
  });
  it('a user-picked KPI file of unknown kind still counts for either source', () => {
    expect(weeklySourcesFor('gn-kpi-pdf', null, null)).toEqual(['gaeste', 'avgcheck']);
  });
  it('coverage of three KPI files lists the right file under each row', () => {
    const c = weeklyCoverage([
      { typeId: 'gn-kpi-pdf', tagesdatenTyp: null, kpiKind: 'anzahl_personen', state: 'ready', name: 'Anzahl_Personen.csv' },
      { typeId: 'gn-kpi-pdf', tagesdatenTyp: null, kpiKind: 'durchschnittsbon', state: 'ready', name: 'Durchschnittsbon.csv' },
      { typeId: 'gn-kpi-pdf', tagesdatenTyp: null, kpiKind: 'umsatz_pro_person', state: 'ready', name: 'Umsatz_pro_Person.csv' },
    ]);
    expect(c.get('gaeste')?.names).toEqual(['Anzahl_Personen.csv']);
    expect(c.get('avgcheck')?.names).toEqual(['Durchschnittsbon.csv']);
  });
});
