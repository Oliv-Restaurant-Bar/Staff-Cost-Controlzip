/**
 * Tests für die reine CRM-Profil-Logik (guest-crm-profile.ts).
 * Synthetische Daten, KEINE echten personenbezogenen Daten, kein Logging.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_CRM_PROFILE,
  normalizeText,
  normalizeBirthday,
  normalizeCrmProfile,
  rowToCrmProfile,
  crmProfileToRow,
  crmProfileEquals,
  isCrmProfileDirty,
  type GuestCrmProfile,
  type GuestCrmProfileRow,
} from '../guest-crm-profile';

const GUEST_ID = '00000000-0000-0000-0000-000000000001';

/** Vollständig befülltes, synthetisches Profil (keine echten Daten). */
function sampleProfile(): GuestCrmProfile {
  return {
    vipManual: true,
    stammgastManual: false,
    companyCustomer: true,
    newsletterOptIn: true,
    blockedGuest: false,
    birthday: '1990-05-17',
    company: 'Muster AG',
    language: 'DE',
    allergies: 'Nuesse',
    dietaryNotes: 'vegetarisch',
    favoriteTable: 'T12',
    favoriteArea: 'Terrasse',
    favoriteWine: 'Riesling',
    favoriteDish: 'Risotto',
    crmNotes: 'Bevorzugt Fensterplatz.',
  };
}

describe('EMPTY_CRM_PROFILE', () => {
  it('hat alle Booleans false und alle Textfelder null', () => {
    expect(EMPTY_CRM_PROFILE.vipManual).toBe(false);
    expect(EMPTY_CRM_PROFILE.stammgastManual).toBe(false);
    expect(EMPTY_CRM_PROFILE.companyCustomer).toBe(false);
    expect(EMPTY_CRM_PROFILE.newsletterOptIn).toBe(false);
    expect(EMPTY_CRM_PROFILE.blockedGuest).toBe(false);
    expect(EMPTY_CRM_PROFILE.birthday).toBeNull();
    expect(EMPTY_CRM_PROFILE.company).toBeNull();
    expect(EMPTY_CRM_PROFILE.crmNotes).toBeNull();
  });
});

describe('normalizeText', () => {
  it('trimmt und macht aus leer/whitespace null', () => {
    expect(normalizeText('  hallo  ')).toBe('hallo');
    expect(normalizeText('   ')).toBeNull();
    expect(normalizeText('')).toBeNull();
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });
});

describe('normalizeBirthday', () => {
  it('akzeptiert gültiges ISO-Datum', () => {
    expect(normalizeBirthday('1985-12-31')).toBe('1985-12-31');
  });
  it('schneidet Zeitanteil ab', () => {
    expect(normalizeBirthday('1985-12-31T10:00:00Z')).toBe('1985-12-31');
  });
  it('verwirft ungültige/leere Werte → null', () => {
    expect(normalizeBirthday('2021-02-30')).toBeNull(); // 30. Februar existiert nicht
    expect(normalizeBirthday('31.12.1985')).toBeNull();
    expect(normalizeBirthday('foo')).toBeNull();
    expect(normalizeBirthday('')).toBeNull();
    expect(normalizeBirthday(null)).toBeNull();
  });
});

describe('normalizeCrmProfile', () => {
  it('trimmt Texte, validiert Geburtstag, erzwingt Booleans', () => {
    const dirty = {
      ...sampleProfile(),
      company: '  Muster AG  ',
      language: '   ',
      birthday: 'kein-datum',
      vipManual: 1 as unknown as boolean,
    };
    const n = normalizeCrmProfile(dirty);
    expect(n.company).toBe('Muster AG');
    expect(n.language).toBeNull();
    expect(n.birthday).toBeNull();
    expect(n.vipManual).toBe(true);
  });
  it('ist idempotent', () => {
    const once = normalizeCrmProfile(sampleProfile());
    const twice = normalizeCrmProfile(once);
    expect(twice).toEqual(once);
  });
});

describe('rowToCrmProfile', () => {
  it('mappt snake_case → camelCase und NULL-Booleans → false', () => {
    const row: GuestCrmProfileRow = {
      guest_id: GUEST_ID,
      vip_manual: true,
      stammgast_manual: null,
      company_customer: null,
      newsletter_opt_in: false,
      blocked_guest: null,
      birthday: '1990-05-17',
      company: 'Muster AG',
      language: 'DE',
      allergies: null,
      dietary_notes: null,
      favorite_table: 'T1',
      favorite_area: null,
      favorite_wine: null,
      favorite_dish: null,
      crm_notes: 'Notiz',
    };
    const p = rowToCrmProfile(row);
    expect(p.vipManual).toBe(true);
    expect(p.stammgastManual).toBe(false); // null → false
    expect(p.blockedGuest).toBe(false);
    expect(p.birthday).toBe('1990-05-17');
    expect(p.company).toBe('Muster AG');
    expect(p.favoriteTable).toBe('T1');
    expect(p.allergies).toBeNull();
    expect(p.crmNotes).toBe('Notiz');
  });
});

describe('crmProfileToRow', () => {
  it('mappt camelCase → snake_case inkl. guest_id und ohne updated_at', () => {
    const row = crmProfileToRow(sampleProfile(), GUEST_ID);
    expect(row.guest_id).toBe(GUEST_ID);
    expect(row.vip_manual).toBe(true);
    expect(row.company_customer).toBe(true);
    expect(row.dietary_notes).toBe('vegetarisch');
    expect(row.favorite_area).toBe('Terrasse');
    expect('updated_at' in row).toBe(false);
    expect('created_at' in row).toBe(false);
  });
  it('normalisiert Texte beim Mappen (leer → null)', () => {
    const row = crmProfileToRow({ ...sampleProfile(), company: '   ', allergies: '  X  ' }, GUEST_ID);
    expect(row.company).toBeNull();
    expect(row.allergies).toBe('X');
  });
});

describe('Round-Trip row → profile → row', () => {
  it('erhält normalisierte Werte', () => {
    const original = sampleProfile();
    const row = crmProfileToRow(original, GUEST_ID);
    const back = rowToCrmProfile({ ...row });
    expect(normalizeCrmProfile(back)).toEqual(normalizeCrmProfile(original));
  });
});

describe('crmProfileEquals / isCrmProfileDirty', () => {
  it('gleiche Profile sind nicht dirty', () => {
    const a = sampleProfile();
    const b = sampleProfile();
    expect(crmProfileEquals(a, b)).toBe(true);
    expect(isCrmProfileDirty(a, b)).toBe(false);
  });
  it('reine Whitespace-Unterschiede zählen NICHT als Änderung', () => {
    const a = sampleProfile();
    const b = { ...sampleProfile(), company: '  Muster AG  ', crmNotes: 'Bevorzugt Fensterplatz.   ' };
    expect(isCrmProfileDirty(a, b)).toBe(false);
  });
  it('geänderter Boolean ist dirty', () => {
    const a = sampleProfile();
    const b = { ...sampleProfile(), blockedGuest: true };
    expect(isCrmProfileDirty(a, b)).toBe(true);
  });
  it('geänderter Text ist dirty', () => {
    const a = sampleProfile();
    const b = { ...sampleProfile(), favoriteWine: 'Pinot Noir' };
    expect(isCrmProfileDirty(a, b)).toBe(true);
  });
  it('leeres Profil vs. befülltes Profil ist dirty', () => {
    expect(isCrmProfileDirty(EMPTY_CRM_PROFILE, sampleProfile())).toBe(true);
  });
});
