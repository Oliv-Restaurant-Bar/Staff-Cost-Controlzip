// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthorizationHandler,
  isServerCapabilityAllowed,
} from '../../../server/authorization.js';

afterEach(() => vi.unstubAllGlobals());

function responseRecorder() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { this.headers[name] = value; },
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = body; },
  };
}

describe('server capability authorization', () => {
  it('erlaubt Finanzen und Cockpit-Export nur dem Admin', () => {
    expect(isServerCapabilityAllowed('admin', 'finance')).toBe(true);
    expect(isServerCapabilityAllowed('admin', 'cockpit-export')).toBe(true);

    expect(isServerCapabilityAllowed('beaulieu_manager', 'finance')).toBe(false);
    expect(isServerCapabilityAllowed('beaulieu_manager', 'cockpit-export')).toBe(false);
    expect(isServerCapabilityAllowed('service_manager', 'cockpit-export')).toBe(false);
  });

  it('liefert für den Geschäftsführer an geschützten Endpunkten HTTP 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => 'beaulieu_manager',
    }));
    const handle = createAuthorizationHandler({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'public-test-key',
    });

    for (const path of ['/api/authz/finance', '/api/authz/cockpit-export']) {
      const res = responseRecorder();
      const handled = await handle({
        url: path,
        method: 'POST',
        headers: { authorization: 'Bearer test-jwt' },
      } as never, res as never);
      expect(handled).toBe(true);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
    }
  });
});