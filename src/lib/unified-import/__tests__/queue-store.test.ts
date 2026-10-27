import { describe, it, expect, beforeEach } from 'vitest';
import { addEntries, clearQueue, getEntries, markHanded, removeEntry, setEntryType, getListTenant } from '../queue-store';
import type { ClassifyResult } from '../types';

const res = (over: Partial<ClassifyResult> = {}): ClassifyResult => ({
  status: 'recognised', typeId: 'foratable-gaeste', tagesdatenTyp: null, alternatives: [],
  tagesdatenAlternatives: [], reasons: [], fallbackEligible: false, ...over,
} as ClassifyResult);
const f = (n: string) => new File(['x'], n);

describe('queue-store', () => {
  beforeEach(() => clearQueue());

  it('pre-selects the type only for a recognised file', () => {
    addEntries('oliv', [
      { file: f('a.csv'), result: res() },
      { file: f('b.csv'), result: res({ status: 'confirm', typeId: 'foratable-gaeste' }) },
      { file: f('c.csv'), result: res({ status: 'unknown', typeId: null }) },
    ]);
    expect(getEntries().map(e => e.typeId)).toEqual(['foratable-gaeste', null, null]);
  });

  it('never mixes tenants: adding for another tenant starts a new list', () => {
    addEntries('oliv', [{ file: f('a.csv'), result: res() }]);
    addEntries('beaulieu', [{ file: f('b.csv'), result: res() }]);
    expect(getEntries().map(e => e.file.name)).toEqual(['b.csv']);
    expect(getListTenant()).toBe('beaulieu');
  });

  it('supports picking a type, marking handed and removing', () => {
    addEntries('oliv', [{ file: f('a.csv'), result: res({ status: 'unknown', typeId: null }) }]);
    const id = getEntries()[0].id;
    setEntryType(id, 'kontoblatt');
    expect(getEntries()[0].typeId).toBe('kontoblatt');
    markHanded([id]);
    expect(getEntries()[0].state).toBe('handed');
    removeEntry(id);
    expect(getEntries()).toHaveLength(0);
  });

  it('gives a new snapshot array only when something changed', () => {
    const a = getEntries();
    expect(getEntries()).toBe(a);
    addEntries('oliv', [{ file: f('a.csv'), result: res() }]);
    expect(getEntries()).not.toBe(a);
  });
});
