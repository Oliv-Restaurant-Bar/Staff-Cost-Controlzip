/**
 * Tests für die reine CRM-Profil-Logik (guest-crm-profile.ts).
 * Synthetische Daten, KEINE echten personenbezogenen Daten, kein Logging.
 *
 * @vitest-environment node
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  EMPTY_CRM_PROFILE,
  normalizeText,
  normalizeBirthday,
  normalizeCrmProfile,
  rowToCrmProfile,
  crmProfileToRow,
  crmProfileEquals,
  isCrmProfileDirty,
  manualCrmBadges,
  type GuestCrmProfile,
  type GuestCrmProfileRow,
  type ManualBadge,
  type ManualBadgeKind,
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

describe('manualCrmBadges (VIP-/Stammgast-Badge)', () => {
  it('leeres/null/undefined Profil → keine Badges', () => {
    expect(manualCrmBadges(EMPTY_CRM_PROFILE)).toEqual([]);
    expect(manualCrmBadges(null)).toEqual([]);
    expect(manualCrmBadges(undefined)).toEqual([]);
  });
  it('vipManual=true → VIP-Badge', () => {
    const badges = manualCrmBadges({ ...EMPTY_CRM_PROFILE, vipManual: true });
    expect(badges).toHaveLength(1);
    expect(badges[0].kind).toBe('vip');
    expect(badges[0].label).toMatch(/VIP/i);
  });
  it('stammgastManual=true → Stammgast-Badge', () => {
    const badges = manualCrmBadges({ ...EMPTY_CRM_PROFILE, stammgastManual: true });
    expect(badges).toHaveLength(1);
    expect(badges[0].kind).toBe('stammgast');
    expect(badges[0].label).toMatch(/Stammgast/i);
  });
  it('beide Flags → beide Badges in Reihenfolge [vip, stammgast]', () => {
    const badges = manualCrmBadges({ ...EMPTY_CRM_PROFILE, vipManual: true, stammgastManual: true });
    expect(badges.map(b => b.kind)).toEqual(['vip', 'stammgast']);
  });
  it('hängt NUR an den manuellen Flags — andere Felder erzeugen keine Badges', () => {
    const badges = manualCrmBadges({
      ...EMPTY_CRM_PROFILE,
      companyCustomer: true, newsletterOptIn: true, blockedGuest: true,
      company: 'Muster AG', allergies: 'Nuesse',
    });
    expect(badges).toEqual([]);
  });
});

describe('Formular: Bearbeiten → Speichern → Verwerfen', () => {
  it('Bearbeiten macht dirty, Verwerfen (zurück auf saved) macht clean', () => {
    const saved = sampleProfile();
    const edited: GuestCrmProfile = { ...saved, company: 'Andere AG', vipManual: !saved.vipManual };
    expect(isCrmProfileDirty(edited, saved)).toBe(true);
    const discarded: GuestCrmProfile = { ...saved }; // „Änderungen verwerfen" = Form auf saved
    expect(isCrmProfileDirty(discarded, saved)).toBe(false);
  });
  it('erstes Speichern: leeres Formular ist gegen leeren saved-Stand nicht dirty', () => {
    expect(isCrmProfileDirty(EMPTY_CRM_PROFILE, EMPTY_CRM_PROFILE)).toBe(false);
  });
});

describe('Type Tests', () => {
  it('manualCrmBadges liefert ManualBadge[]', () => {
    expectTypeOf(manualCrmBadges(EMPTY_CRM_PROFILE)).toEqualTypeOf<ManualBadge[]>();
  });
  it('ManualBadgeKind ist auf vip|stammgast beschränkt', () => {
    expectTypeOf<ManualBadgeKind>().toEqualTypeOf<'vip' | 'stammgast'>();
  });
  it('EMPTY_CRM_PROFILE erfüllt GuestCrmProfile, crmProfileToRow liefert guest_id:string', () => {
    expectTypeOf(EMPTY_CRM_PROFILE).toMatchTypeOf<GuestCrmProfile>();
    const row = crmProfileToRow(EMPTY_CRM_PROFILE, GUEST_ID);
    expectTypeOf(row.guest_id).toBeString();
  });
});
