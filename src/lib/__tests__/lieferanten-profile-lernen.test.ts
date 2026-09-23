// @vitest-environment node
/**
 * Profil-Lernen OHNE MWST-Nr (C2): manuell zugeordnete Lieferanten müssen
 * beim Re-Import wiedererkannt werden — via Namens-Tokens (auto-abgeleitet).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => (kv.has(key) ? kv.get(key) : null)),
  kvGetStrict: vi.fn(async (key: string) => (kv.has(key) ? kv.get(key) : null)),
  kvSet: vi.fn(async (key: string, value: unknown) => { kv.set(key, JSON.parse(JSON.stringify(value))); }),
  kvSetConfirmed: vi.fn(async (key: string, value: unknown) => { kv.set(key, JSON.parse(JSON.stringify(value))); }),
  kvRemove: vi.fn(async (key: string) => { kv.delete(key); }),
}));

import { lerneProfil, findeProfilImText } from '@/lib/lieferanten-profile';

const TENANT = 'beaulieu' as never;
beforeEach(() => kv.clear());

describe('lerneProfil ohne MWST-Nr', () => {
  it('leitet Namens-Tokens ab → Re-Import erkennt das Profil im PDF-Text', async () => {
    const profile = await lerneProfil(TENANT, { mwstNr: '', name: 'Bäckerei Sutter', konto: '4000', kategorie: 'Food' });
    const p = profile.find(x => x.name === 'Bäckerei Sutter')!;
    expect(p.erkennungTokens).toEqual(['bäckerei', 'sutter']);
    const treffer = findeProfilImText('Lieferschein\nBäckerei Sutter AG, Bern\nTotal CHF 120.00', profile);
    expect(treffer.profil?.id).toBe(p.id);
  });

  it('explizit übergebene Tokens/IBAN gewinnen; bestehende Tokens werden nie überschrieben', async () => {
    await lerneProfil(TENANT, { mwstNr: '', name: 'Hofladen Muster', konto: '4000', kategorie: 'Food', erkennungTokens: ['hofladen muster'], iban: 'CH000' });
    const nach = await lerneProfil(TENANT, { mwstNr: '', name: 'Hofladen Muster', konto: '4010', kategorie: 'Food' });
    const p = nach.find(x => x.name === 'Hofladen Muster')!;
    expect(p.erkennungTokens).toEqual(['hofladen muster']);
    expect(p.iban).toBe('CH000');
    expect(p.konto).toBe('4010');
  });

  it('mit MWST-Nr werden KEINE Auto-Tokens angelegt (MWST-Nr reicht)', async () => {
    const profile = await lerneProfil(TENANT, { mwstNr: 'CHE-108.008.709 MWST', name: 'Terravigna AG', konto: '4020', kategorie: 'Beverage' });
    expect(profile.find(x => x.name === 'Terravigna AG')!.erkennungTokens).toBeUndefined();
  });
});
