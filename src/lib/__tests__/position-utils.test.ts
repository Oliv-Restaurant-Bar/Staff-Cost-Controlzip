// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Position } from '@/types/positions';
import {
  slugifyKey,
  defaultPositions,
  positionByKey,
  resolvePositionKey,
  positionDisplayName,
  employeeCoverableKeys,
  employeeCanCover,
  positionsForDepartment,
  activePositions,
  sortPositions,
  DEPARTMENTS,
} from '@/lib/position-utils';

function pos(p: Partial<Position> & { key: string; name: string }): Position {
  return {
    id: p.id ?? `id-${p.key}`,
    restaurantId: p.restaurantId ?? 'oliv',
    key: p.key,
    name: p.name,
    department: p.department ?? 'service',
    departmentGroup: p.departmentGroup,
    color: p.color,
    icon: p.icon,
    sortOrder: p.sortOrder ?? 0,
    active: p.active ?? true,
  };
}

describe('slugifyKey', () => {
  it('lowercases and joins words with underscores', () => {
    expect(slugifyKey('Chef de Rang')).toBe('chef_de_rang');
    expect(slugifyKey('Pizzaiolo')).toBe('pizzaiolo');
  });
  it('transliterates umlauts and accents', () => {
    expect(slugifyKey('Küche Warm')).toBe('kueche_warm');
    expect(slugifyKey('Gardemanger éà')).toBe('gardemanger_ea');
    expect(slugifyKey('Großküche')).toBe('grosskueche');
  });
  it('collapses separators and trims edges', () => {
    expect(slugifyKey('  Bar / Buffet  ')).toBe('bar_buffet');
    expect(slugifyKey('!!!')).toBe('');
  });
});

describe('defaultPositions', () => {
  const defaults = defaultPositions();
  it('produces entries for both departments', () => {
    const depts = new Set(defaults.map((d) => d.department));
    expect(depts.has('service')).toBe(true);
    expect(depts.has('küche')).toBe(true);
  });
  it('keys are unique across the seed set', () => {
    const keys = defaults.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('every seed has color, icon and ascending sortOrder per dept', () => {
    for (const dept of DEPARTMENTS) {
      const list = defaults.filter((d) => d.department === dept);
      expect(list.length).toBeGreaterThan(0);
      list.forEach((d, i) => {
        expect(d.color).toBeTruthy();
        expect(d.icon).toBeTruthy();
        expect(d.sortOrder).toBe(i);
        expect(d.active).toBe(true);
      });
    }
  });
  it('is exactly the real planning positions in order', () => {
    const keys = defaults.map((d) => d.key);
    expect(keys).toEqual([
      'bar_buffet_springer', 'service', 'piazzolo_take_away', 'abwasch', 'kueche',
    ]);
  });
});

describe('positionByKey / displayName / resolvePositionKey', () => {
  const positions = [
    pos({ key: 'grill', name: 'Grill', department: 'küche' }),
    pos({ key: 'chef_de_rang', name: 'Chef de Rang', department: 'service' }),
  ];
  it('finds by key', () => {
    expect(positionByKey(positions, 'grill')?.name).toBe('Grill');
    expect(positionByKey(positions, 'missing')).toBeUndefined();
    expect(positionByKey(positions, undefined)).toBeUndefined();
  });
  it('displays name from key, falls back to the raw value', () => {
    expect(positionDisplayName(positions, 'grill')).toBe('Grill');
    expect(positionDisplayName(positions, 'unknown')).toBe('unknown');
    expect(positionDisplayName(positions, '')).toBe('');
  });
  it('resolves legacy display names to keys, passes through unknowns', () => {
    expect(resolvePositionKey(positions, 'grill')).toBe('grill');         // already a key
    expect(resolvePositionKey(positions, 'Grill')).toBe('grill');         // legacy name
    expect(resolvePositionKey(positions, 'chef de rang')).toBe('chef_de_rang'); // case-insensitive
    expect(resolvePositionKey(positions, 'Custom')).toBe('Custom');       // unknown stays
    expect(resolvePositionKey(positions, '  ')).toBeUndefined();
  });
});

describe('employee coverage', () => {
  const emp = { primaryStation: 'grill', secondaryStations: ['pasta', 'kalt', 'grill'] };
  it('lists coverable keys deduped, primary first', () => {
    expect(employeeCoverableKeys(emp)).toEqual(['grill', 'pasta', 'kalt']);
  });
  it('reports whether a position is covered', () => {
    expect(employeeCanCover(emp, 'grill')).toBe(true);
    expect(employeeCanCover(emp, 'pasta')).toBe(true);
    expect(employeeCanCover(emp, 'bar')).toBe(false);
    expect(employeeCanCover(emp, '')).toBe(false);
  });
  it('handles employees without any stations', () => {
    expect(employeeCoverableKeys({})).toEqual([]);
    expect(employeeCanCover({}, 'grill')).toBe(false);
  });
});

describe('filtering & sorting', () => {
  const positions = [
    pos({ key: 'b', name: 'Beta', department: 'service', sortOrder: 2 }),
    pos({ key: 'a', name: 'Alpha', department: 'service', sortOrder: 1 }),
    pos({ key: 'k', name: 'Grill', department: 'küche', sortOrder: 0, active: false }),
    pos({ key: 'k2', name: 'Pasta', department: 'küche', sortOrder: 1 }),
  ];
  it('sorts by department, then sortOrder, then name', () => {
    const sorted = sortPositions(positions).map((p) => p.key);
    expect(sorted).toEqual(['a', 'b', 'k', 'k2']);
  });
  it('filters active only', () => {
    expect(activePositions(positions).map((p) => p.key).sort()).toEqual(['a', 'b', 'k2']);
  });
  it('positionsForDepartment respects activeOnly', () => {
    expect(positionsForDepartment(positions, 'küche').map((p) => p.key)).toEqual(['k', 'k2']);
    expect(positionsForDepartment(positions, 'küche', { activeOnly: true }).map((p) => p.key)).toEqual(['k2']);
  });
});
