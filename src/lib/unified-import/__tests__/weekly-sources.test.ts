import { describe, it, expect } from 'vitest';
import { weeklySourcesFor } from '../weekly-sources';
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
