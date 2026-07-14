// @vitest-environment node
/**
 * CRUD-Tests für die CRM-Profil-Datenschicht (guest-crm-profile-db.ts).
 * ====================================================================
 * Supabase-Client und der Mandanten-Check (fetchGuestById) werden gemockt,
 * damit Lese-/Schreibpfad, Mandanten-Gate und die „kein stilles Fallback"-Regel
 * (Schreibfehler werfen) ohne echte Datenbank geprüft werden können.
 *
 * Synthetische Daten, KEINE echten personenbezogenen Daten, kein Logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── steuerbarer Zustand der Mocks ────────────────────────────────────────────
let _guest: unknown = { id: 'g1' };
let _crmData: unknown = null;
let _crmError: unknown = null;
let _lastTable: string | null = null;
let _lastUpsertRow: Record<string, unknown> | null = null;
let _lastUpsertOpts: Record<string, unknown> | null = null;

function makeBuilder() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => {
      _lastUpsertRow = row;
      _lastUpsertOpts = opts;
      return builder;
    },
    // `await q.maybeSingle()` → { data, error }
    maybeSingle: () => Promise.resolve({ data: _crmData, error: _crmError }),
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => { _lastTable = t; return makeBuilder(); } },
}));

// Mandanten-Check: fetchGuestById liefert den steuerbaren `_guest`.
vi.mock('@/lib/reservation-crm-db', () => ({
  fetchGuestById: () => Promise.resolve(_guest),
}));

import { fetchGuestCrmProfile, upsertGuestCrmProfile } from '@/lib/guest-crm-profile-db';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '@/lib/guest-crm-profile';

const REST = 'oliv';
const GUEST_ID = '00000000-0000-0000-0000-000000000001';

function sampleRow(): Record<string, unknown> {
  return {
    guest_id: GUEST_ID,
    vip_manual: true,
    stammgast_manual: false,
    company_customer: true,
    newsletter_opt_in: false,
    blocked_guest: false,
    birthday: '1990-05-17',
    company: 'Muster AG',
    language: 'DE',
    allergies: 'Nuesse',
    dietary_notes: null,
    favorite_table: 'T12',
    favorite_area: 'Terrasse',
    favorite_wine: null,
    favorite_dish: null,
    crm_notes: 'Notiz',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };
}

function sampleProfile(): GuestCrmProfile {
  return {
    ...EMPTY_CRM_PROFILE,
    vipManual: true,
    companyCustomer: true,
    company: 'Muster AG',
    birthday: '1990-05-17',
    favoriteTable: 'T12',
  };
}

beforeEach(() => {
  _guest = { id: 'g1' };
  _crmData = null;
  _crmError = null;
  _lastTable = null;
  _lastUpsertRow = null;
  _lastUpsertOpts = null;
});

describe('fetchGuestCrmProfile', () => {
  it('fremder/unbekannter Gast (Mandanten-Check schlägt fehl) → null', async () => {
    _guest = null;
    const out = await fetchGuestCrmProfile(REST, GUEST_ID);
    expect(out).toBeNull();
  });

  it('Gast vorhanden, aber (noch) kein CRM-Profil → null', async () => {
    _crmData = null;
    const out = await fetchGuestCrmProfile(REST, GUEST_ID);
    expect(out).toBeNull();
    expect(_lastTable).toBe('guest_crm_profiles');
  });

  it('vorhandenes Profil wird gemappt (snake → camel)', async () => {
    _crmData = sampleRow();
    const out = await fetchGuestCrmProfile(REST, GUEST_ID);
    expect(out).not.toBeNull();
    expect(out!.vipManual).toBe(true);
    expect(out!.stammgastManual).toBe(false);
    expect(out!.company).toBe('Muster AG');
    expect(out!.favoriteTable).toBe('T12');
    expect(out!.dietaryNotes).toBeNull();
  });

  it('Lesefehler der CRM-Tabelle → Exception (kein stilles null)', async () => {
    _crmError = { message: 'boom' };
    await expect(fetchGuestCrmProfile(REST, GUEST_ID)).rejects.toThrow(/boom|geladen/i);
  });
});

describe('upsertGuestCrmProfile', () => {
  it('kein Zugriff für Mandanten → Exception, KEIN Schreibversuch', async () => {
    _guest = null;
    await expect(upsertGuestCrmProfile(REST, GUEST_ID, sampleProfile())).rejects.toThrow(/Zugriff|nicht gefunden/i);
    expect(_lastUpsertRow).toBeNull();
  });

  it('erstes Speichern/Update: UPSERT mit onConflict guest_id, guest_id & updated_at gesetzt', async () => {
    _crmData = sampleRow();
    const out = await upsertGuestCrmProfile(REST, GUEST_ID, sampleProfile());
    expect(_lastTable).toBe('guest_crm_profiles');
    expect(_lastUpsertOpts).toEqual({ onConflict: 'guest_id' });
    expect(_lastUpsertRow).not.toBeNull();
    expect(_lastUpsertRow!.guest_id).toBe(GUEST_ID);
    expect(_lastUpsertRow!.vip_manual).toBe(true);
    expect(_lastUpsertRow!.company_customer).toBe(true);
    expect(typeof _lastUpsertRow!.updated_at).toBe('string');
    // Rückgabe = gemapptes, gespeichertes Profil
    expect(out.vipManual).toBe(true);
    expect(out.company).toBe('Muster AG');
  });

  it('normalisiert beim Schreiben (leerer Text → null)', async () => {
    _crmData = sampleRow();
    await upsertGuestCrmProfile(REST, GUEST_ID, { ...sampleProfile(), company: '   ' });
    expect(_lastUpsertRow!.company).toBeNull();
  });

  it('Schreibfehler → Exception (kein stilles Fallback)', async () => {
    _crmError = { message: 'write failed' };
    await expect(upsertGuestCrmProfile(REST, GUEST_ID, sampleProfile())).rejects.toThrow(/write failed|gespeichert/i);
  });

  it('kein zurückgegebener Datensatz (data null, kein error) → Exception', async () => {
    _crmData = null;
    _crmError = null;
    await expect(upsertGuestCrmProfile(REST, GUEST_ID, sampleProfile())).rejects.toThrow(/gespeichert/i);
  });
});
