// @vitest-environment node
/**
 * Tests für die reine Gäste-Duplikat-Logik (guest-duplicates.ts).
 * Node-Umgebung (keine DOM/Canvas-Abhängigkeit). Ausschliesslich SYNTHETISCHE
 * Daten — KEINE echten personenbezogenen Daten.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizePhoneKey,
  guestDisplayName,
  groupDuplicatesByPhone,
  mergeCrmProfiles,
  fillEmptyIdentity,
  type DuplicateGuest,
  type GuestIdentityRow,
} from '../guest-duplicates';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '../guest-crm-profile';

function guest(partial: Partial<DuplicateGuest> & { id: string }): DuplicateGuest {
  return {
    firstName: null, lastName: null, email: null, mobile: null,
    normalizedMobile: null, reservationCount: 0, lastReservationDate: null,
    createdAt: null,
    ...partial,
  };
}

function identity(partial: Partial<GuestIdentityRow> & { id: string }): GuestIdentityRow {
  return {
    first_name: null, last_name: null, email: null, mobile: null,
    normalized_email: null, normalized_mobile: null, normalized_name: null,
    ...partial,
  };
}

describe('normalizePhoneKey', () => {
  it('entfernt Leerzeichen, Formatierung und führende 00/+ (gleiche Nummer matcht)', () => {
    const a = normalizePhoneKey('+41 79 123 45 67');
    const b = normalizePhoneKey('0041791234567');
    const c = normalizePhoneKey('079-123 45 67'.replace('079', '0041 79')); // 0041 79 123 45 67
    expect(a).toBe('41791234567');
    expect(b).toBe('41791234567');
    expect(c).toBe('41791234567');
  });

  it('verlangt mindestens 7 Ziffern, sonst null', () => {
    expect(normalizePhoneKey('12345')).toBeNull();
    expect(normalizePhoneKey('  ')).toBeNull();
    expect(normalizePhoneKey(null)).toBeNull();
  });

  it('fällt auf den gespeicherten normalized_mobile zurück', () => {
    expect(normalizePhoneKey(null, '41791234567')).toBe('41791234567');
    expect(normalizePhoneKey('', ' 41791234567 ')).toBe('41791234567');
    // Live-Normalisierung hat Vorrang vor gespeichertem Wert
    expect(normalizePhoneKey('+41 79 123 45 67', 'stale')).toBe('41791234567');
  });
});

describe('guestDisplayName', () => {
  it('bevorzugt Name, dann E-Mail, dann Mobile, sonst —', () => {
    expect(guestDisplayName({ firstName: 'Max', lastName: 'Muster', email: 'x@y.z', mobile: '079' })).toBe('Max Muster');
    expect(guestDisplayName({ firstName: null, lastName: null, email: 'x@y.z', mobile: '079' })).toBe('x@y.z');
    expect(guestDisplayName({ firstName: null, lastName: null, email: null, mobile: '079' })).toBe('079');
    expect(guestDisplayName({ firstName: null, lastName: null, email: null, mobile: null })).toBe('—');
  });
});

describe('groupDuplicatesByPhone', () => {
  it('gruppiert ≥2 Gäste mit gleicher normalisierter Nummer, ignoriert Einzelgänger', () => {
    const guests = [
      guest({ id: 'a', mobile: '+41 79 123 45 67', reservationCount: 3 }),
      guest({ id: 'b', mobile: '0041791234567', reservationCount: 9 }),
      guest({ id: 'c', mobile: '079 999 88 77', reservationCount: 1 }), // einzeln
      guest({ id: 'd', mobile: null }),                                  // keine Nummer
    ];
    const groups = groupDuplicatesByPhone(guests);
    expect(groups).toHaveLength(1);
    expect(groups[0].phoneKey).toBe('41791234567');
    expect(groups[0].guests.map(g => g.id)).toEqual(['b', 'a']); // meiste Reservationen zuerst
    expect(groups[0].suggestedMasterId).toBe('b');
  });

  it('schlägt den Gast mit den meisten Reservationen als Master vor (Tiebreak: jüngster Besuch)', () => {
    const guests = [
      guest({ id: 'a', mobile: '079 123 45 67', reservationCount: 5, lastReservationDate: '2026-01-01' }),
      guest({ id: 'b', mobile: '079 123 45 67', reservationCount: 5, lastReservationDate: '2026-06-01' }),
    ];
    const groups = groupDuplicatesByPhone(guests);
    expect(groups[0].suggestedMasterId).toBe('b');
  });

  it('nutzt den gespeicherten normalized_mobile, wenn die Rohnummer fehlt', () => {
    const guests = [
      guest({ id: 'a', mobile: null, normalizedMobile: '41791234567' }),
      guest({ id: 'b', mobile: '+41 79 123 45 67' }),
    ];
    const groups = groupDuplicatesByPhone(guests);
    expect(groups).toHaveLength(1);
    expect(groups[0].guests.map(g => g.id).sort()).toEqual(['a', 'b']);
  });

  it('liefert keine Gruppen, wenn keine Nummern doppelt sind', () => {
    expect(groupDuplicatesByPhone([
      guest({ id: 'a', mobile: '079 111 11 11' }),
      guest({ id: 'b', mobile: '079 222 22 22' }),
    ])).toHaveLength(0);
  });
});

describe('mergeCrmProfiles', () => {
  const prof = (p: Partial<GuestCrmProfile>): GuestCrmProfile => ({ ...EMPTY_CRM_PROFILE, ...p });

  it('ODER-verknüpft boolesche Flags (true gewinnt, geht nie verloren)', () => {
    const master = prof({ vipManual: false, blockedGuest: true });
    const dup = prof({ vipManual: true, newsletterOptIn: true });
    const out = mergeCrmProfiles(master, dup);
    expect(out.vipManual).toBe(true);
    expect(out.blockedGuest).toBe(true);
    expect(out.newsletterOptIn).toBe(true);
  });

  it('fill-empty für einfache Textfelder (Master behält vorhandenen Wert)', () => {
    const master = prof({ company: 'Firma A', birthday: null });
    const dup = prof({ company: 'Firma B', birthday: '1990-05-05', favoriteWine: 'Riesling' });
    const out = mergeCrmProfiles(master, dup);
    expect(out.company).toBe('Firma A');     // Master gewinnt
    expect(out.birthday).toBe('1990-05-05'); // leer am Master → aus Duplikat
    expect(out.favoriteWine).toBe('Riesling');
  });

  it('vereint Notizen/Allergien zeilenweise und dedupliziert (idempotent)', () => {
    const master = prof({ crmNotes: 'Mag Fensterplatz', allergies: 'Nüsse' });
    const dup = prof({ crmNotes: 'Allergisch gegen Laktose\nMag Fensterplatz', allergies: 'nüsse\nGluten' });
    const once = mergeCrmProfiles(master, dup);
    expect(once.crmNotes).toBe('Mag Fensterplatz\nAllergisch gegen Laktose');
    expect(once.allergies).toBe('Nüsse\nGluten'); // case-insensitive dedupe

    // Idempotenz: erneuter Merge mit demselben Duplikat ändert nichts mehr
    const twice = mergeCrmProfiles(once, dup);
    expect(twice.crmNotes).toBe(once.crmNotes);
    expect(twice.allergies).toBe(once.allergies);
  });

  it('liefert leere Felder als null (kein leerer String)', () => {
    const out = mergeCrmProfiles(prof({}), prof({}));
    expect(out.crmNotes).toBeNull();
    expect(out.company).toBeNull();
    expect(out.vipManual).toBe(false);
  });
});

describe('fillEmptyIdentity', () => {
  it('ergänzt nur leere Master-Felder aus dem ersten Duplikat mit Wert', () => {
    const master = identity({ id: 'm', first_name: 'Max', email: null, normalized_email: null });
    const dups = [
      identity({ id: 'd1', email: null }),
      identity({ id: 'd2', email: 'max@example.test', normalized_email: 'max@example.test', mobile: '079' }),
    ];
    const patch = fillEmptyIdentity(master, dups);
    expect(patch.email).toBe('max@example.test');
    expect(patch.normalized_email).toBe('max@example.test');
    expect(patch.mobile).toBe('079');
    expect(patch.first_name).toBeUndefined(); // Master hatte bereits einen Vornamen
  });

  it('liefert ein leeres Patch, wenn nichts zu ergänzen ist (idempotent)', () => {
    const master = identity({ id: 'm', first_name: 'Max', last_name: 'Muster', email: 'a@b.c', mobile: '079', normalized_email: 'a@b.c', normalized_mobile: '079', normalized_name: 'max muster' });
    expect(fillEmptyIdentity(master, [identity({ id: 'd', email: 'x@y.z' })])).toEqual({});
  });

  it('berührt match_key nie (nicht Teil der Identitätsfelder)', () => {
    const master = identity({ id: 'm' });
    const dups = [identity({ id: 'd', first_name: 'A', last_name: 'B', email: 'a@b.c', mobile: '0791112233', normalized_email: 'a@b.c', normalized_mobile: '0791112233', normalized_name: 'a b' })];
    const patch = fillEmptyIdentity(master, dups) as Record<string, unknown>;
    expect('match_key' in patch).toBe(false);
    expect('id' in patch).toBe(false);
  });
});
