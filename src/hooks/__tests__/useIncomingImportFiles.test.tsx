import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIncomingImportFiles } from '../useIncomingImportFiles';
import { setPending, clearAllPending, hasPending } from '@/lib/unified-import/pending-files';

const file = (name: string) => new File(['x'], name);

describe('useIncomingImportFiles', () => {
  beforeEach(() => clearAllPending());

  it('delivers files that were handed over before the flow mounted (route change / collapsed section)', () => {
    const f = file('a.csv');
    setPending('foratable-gaeste', [f]);
    const onFiles = vi.fn();
    renderHook(() => useIncomingImportFiles('foratable-gaeste', onFiles));
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(hasPending('foratable-gaeste')).toBe(false);
  });

  it('delivers files handed over while the flow is mounted', () => {
    const onFiles = vi.fn();
    renderHook(() => useIncomingImportFiles('tagesdaten', onFiles));
    expect(onFiles).not.toHaveBeenCalled();
    const f = file('a.xlsx');
    act(() => setPending('tagesdaten', [f]));
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it('ignores files meant for another flow and leaves them waiting', () => {
    const onFiles = vi.fn();
    renderHook(() => useIncomingImportFiles('tagesdaten', onFiles));
    act(() => setPending('verkaufsdaten', [file('b.txt')]));
    expect(onFiles).not.toHaveBeenCalled();
    expect(hasPending('verkaufsdaten')).toBe(true);
  });

  it('always calls the latest callback (no stale closure)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useIncomingImportFiles('tagesdaten', cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    act(() => setPending('tagesdaten', [file('a.xlsx')]));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening after unmount', () => {
    const onFiles = vi.fn();
    const { unmount } = renderHook(() => useIncomingImportFiles('tagesdaten', onFiles));
    unmount();
    act(() => setPending('tagesdaten', [file('a.xlsx')]));
    expect(onFiles).not.toHaveBeenCalled();
    expect(hasPending('tagesdaten')).toBe(true);
  });
});
