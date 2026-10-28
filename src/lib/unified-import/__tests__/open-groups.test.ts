import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { addEntries, clearQueue, getEntries, markHanded } from '../queue-store';
import { buildOpenGroups, filesForGroupButton } from '../open-groups';
import { setPending, takePending, hasPending, clearAllPending, PENDING_TTL_MS } from '../pending-files';
import type { ClassifyResult } from '../types';

const res = (typeId: ClassifyResult['typeId'], status: ClassifyResult['status'] = 'recognised'): ClassifyResult => ({
  status, typeId, tagesdatenTyp: null, alternatives: [], tagesdatenAlternatives: [], reasons: [], fallbackEligible: false,
} as ClassifyResult);
const file = (n: string, size = 1, modified = 1) => new File([new Uint8Array(size)], n, { lastModified: modified });
const all = () => true;

describe('open groups: a handed-over file stays openable until the user is done', () => {
  beforeEach(() => clearQueue());

  it('ready files are offered first', () => {
    addEntries('oliv', [{ file: file('a.csv'), result: res('rezensionen') }]);
    const [g] = buildOpenGroups(getEntries(), all);
    const { files, reopen } = filesForGroupButton(g);
    expect(reopen).toBe(false);
    expect(files.map(e => e.file.name)).toEqual(['a.csv']);
  });

  it('after hand-over (user came back without importing) the type is offered as «open again» — not dropped', () => {
    addEntries('oliv', [{ file: file('a.csv'), result: res('rezensionen') }]);
    markHanded([getEntries()[0].id]);
    const groups = buildOpenGroups(getEntries(), all);
    expect(groups).toHaveLength(1);
    const { files, reopen } = filesForGroupButton(groups[0]);
    expect(reopen).toBe(true);
    expect(files.map(e => e.file.name)).toEqual(['a.csv']);
  });

  it('a type with both handed and ready files offers the ready ones; handed ones stay reachable via their own row', () => {
    addEntries('oliv', [
      { file: file('a.csv', 1), result: res('foratable-reservationen') },
      { file: file('b.csv', 2), result: res('foratable-reservationen') },
    ]);
    markHanded([getEntries()[0].id]);
    const [g] = buildOpenGroups(getEntries(), all);
    expect(g.handed.map(e => e.file.name)).toEqual(['a.csv']);
    expect(filesForGroupButton(g)).toMatchObject({ reopen: false });
    expect(filesForGroupButton(g).files.map(e => e.file.name)).toEqual(['b.csv']);
  });

  it('files without a chosen type and types the role may not use are not offered', () => {
    addEntries('oliv', [
      { file: file('x.csv'), result: res(null, 'unknown') },
      { file: file('y.csv', 2), result: res('rezensionen') },
    ]);
    expect(buildOpenGroups(getEntries(), id => id !== 'rezensionen')).toHaveLength(0);
    expect(buildOpenGroups(getEntries(), all).map(g => g.typeId)).toEqual(['rezensionen']);
  });
});

describe('queue: dropping the same file twice', () => {
  beforeEach(() => clearQueue());
  it('does not add a duplicate (same name, size and date) and reports how many were new', () => {
    expect(addEntries('oliv', [{ file: file('a.csv'), result: res('rezensionen') }])).toBe(1);
    expect(addEntries('oliv', [{ file: file('a.csv'), result: res('rezensionen') }])).toBe(0);
    expect(getEntries()).toHaveLength(1);
  });
  it('same name but different content is a different file', () => {
    addEntries('oliv', [{ file: file('a.csv', 1), result: res('rezensionen') }]);
    expect(addEntries('oliv', [{ file: file('a.csv', 2), result: res('rezensionen') }])).toBe(1);
  });
});

describe('pending hand-over expiry', () => {
  beforeEach(() => clearAllPending());
  afterEach(() => vi.restoreAllMocks());

  it('a hand-over nobody picked up must not surprise a later manual visit', () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    setPending('rezensionen', [file('a.csv')]);
    spy.mockReturnValue(now + PENDING_TTL_MS + 1000);
    expect(hasPending('rezensionen')).toBe(false);
    expect(takePending('rezensionen')).toEqual([]);
  });

  it('a fresh hand-over is delivered', () => {
    setPending('rezensionen', [file('a.csv')]);
    expect(takePending('rezensionen')).toHaveLength(1);
  });
});
