// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('@/lib/app-settings-table', () => ({
  appSettingsTable: () => ({ upsert }),
}));

import { saveControlListState, type ControlListTenantState } from '@/lib/control-list-store';

const state: ControlListTenantState = {
  version: 1,
  departments: {},
  helperSelections: {},
};

describe('control-list-store', () => {
  beforeEach(() => {
    upsert.mockClear();
  });

  it('upserts by the unique app_settings key so repeated saves stay idempotent', async () => {
    await saveControlListState('oliv', state);
    await saveControlListState('oliv', state);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      { key: 'control-list:v1:oliv', value: state },
      { onConflict: 'key' },
    );
  });

  it('keeps OLIV and Beaulieu in separate app_settings keys', async () => {
    await saveControlListState('oliv', state);
    await saveControlListState('beaulieu', state);

    expect(upsert.mock.calls.map(([row]) => row.key)).toEqual([
      'control-list:v1:oliv',
      'control-list:v1:beaulieu',
    ]);
  });
});