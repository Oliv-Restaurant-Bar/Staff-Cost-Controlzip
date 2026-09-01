// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('@/lib/app-settings-table', () => ({
  appSettingsTable: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc },
}));

import { saveControlListState, type ControlListTenantState } from '@/lib/control-list-store';

const state: ControlListTenantState = {
  version: 1,
  departments: {},
  helperSelections: {},
};

describe('control-list-store', () => {
  beforeEach(() => {
    rpc.mockClear();
  });

  it('writes repeated saves through the role-checked RPC', async () => {
    await saveControlListState('oliv', state);
    await saveControlListState('oliv', state);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'save_control_list_state',
      { p_tenant: 'oliv', p_value: state },
    );
  });

  it('passes only the allow-listed tenant instead of an arbitrary settings key', async () => {
    await saveControlListState('oliv', state);
    await saveControlListState('beaulieu', state);

    expect(rpc.mock.calls.map(([, params]) => params.p_tenant)).toEqual([
      'oliv',
      'beaulieu',
    ]);
  });
});