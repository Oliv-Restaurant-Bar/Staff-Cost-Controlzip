// @vitest-environment node
/**
 * Tests für Matching, Merge & Import-Plan des Foratable-Gästeimports.
 * Synthetische Daten, keine echten Gästedaten (Datenschutz).
 */
import { describe, it, expect } from 'vitest';
import {
  buildGuestIndex, matchGuestRow, mergeCrmProfile, rowToIncomingCrm,
  combineNotes, planGuestImport,
  type MatchableGuest, type IncomingCrm,
} from '../foratable-guest-import';
import type { ParsedGuestRow } from '../foratable-guest-import-parser';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '../guest-crm-profile';

/** Synthetische Zeile mit sinnvollen Defaults. */
function makeRow(p: Partial<ParsedGuestRow>): ParsedGuestRow {
  return {
    rowNumber: 1, title: null, company: null, firstName: null, lastName: null,
    birthday: null, guestInfo: null, favoriteTable: null, dishes: null, labels: null,
    vip: false, newsletter: false, blacklist: false,
    normEmail: null, normMobile: null, normName: null, matchTier: null,
    ...p,
  };
}

function profile(p: Partial<GuestCrmProfile>): GuestCrmProfile {
  return { ...EMPTY_CRM_PROFILE, ...p };
}

const GUESTS: MatchableGuest[] = [
  { id: 'g-email', email: 'Match@Example.test', mobile: null, firstName: 'A', lastName: 'One' },
  { id: 'g-phone', email: null, mobile: '+41 79 123 45 67', firstName: 'B', lastName: 'Two' },
  { id: 'g-name', email: null, mobile: null, firstName: 'Clara', lastName: 'Drei' },
  // zwei Gäste mit identischem Namen → Namensschlüssel ist mehrdeutig
  { id: 'g-dup1', email: null, mobile: null, firstName: 'Dup', lastName: 'Name' },
  { id: 'g-dup2', email: null, mobile: null, firstName: 'Dup', lastName: 'Name' },
];

describe('buildGuestIndex / matchGuestRow', () => {
  const index = buildGuestIndex(GUESTS);

  it('matcht über E-Mail (case-insensitiv)', () => {
    const m = matchGuestRow(makeRow({ normEmail: 'match@example.test', matchTier: 'email' }), index);
    expect(m).toEqual({ guestId: 'g-email', matchedBy: 'email', reason: null });
  });

  it('matcht über Telefon, wenn keine E-Mail vorhanden', () => {
    const m = matchGuestRow(makeRow({ normMobile: '41791234567', matchTier: 'mobile' }), index);
    expect(m.guestId).toBe('g-phone');
    expect(m.matchedBy).toBe('mobile');
  });

  it('matcht über Namen, wenn weder E-Mail noch Telefon vorhanden', () => {
    const m = matchGuestRow(makeRow({ normName: 'clara drei', matchTier: 'name' }), index);
    expect(m.guestId).toBe('g-name');
    expect(m.matchedBy).toBe('name');
  });

  it('markiert mehrdeutige Namen als nicht zuordenbar', () => {
    const m = matchGuestRow(makeRow({ normName: 'dup name', matchTier: 'name' }), index);
    expect(m.guestId).toBeNull();
    expect(m.reason).toBe('ambiguous');
  });

  it('liefert not-found bzw. no-key korrekt', () => {
    expect(matchGuestRow(makeRow({ normEmail: 'unknown@example.test', matchTier: 'email' }), index).reason).toBe('not-found');
    expect(matchGuestRow(makeRow({}), index).reason).toBe('no-key');
  });
});

describe('rowToIncomingCrm / combineNotes', () => {
  it('übernimmt nur positiv gesetzte/nicht-leere Felder', () => {
    const inc = rowToIncomingCrm(makeRow({
      vip: true, newsletter: false, blacklist: true,
      company: 'Firma X', favoriteTable: 'Tisch 7', birthday: '1990-01-01',
      guestInfo: 'mag Rotwein', labels: 'Stammtisch',
    }));
    expect(inc.vipManual).toBe(true);
    expect(inc.blockedGuest).toBe(true);
    expect('newsletterOptIn' in inc).toBe(false); // Nein → keine Info
    expect(inc.company).toBe('Firma X');
    expect(inc.favoriteTable).toBe('Tisch 7');
    expect(inc.birthday).toBe('1990-01-01');
    expect(inc.crmNotes).toBe('mag Rotwein · Stammtisch');
  });

  it('combineNotes ergibt null, wenn nichts vorhanden ist', () => {
    expect(combineNotes(makeRow({}))).toBeNull();
  });
});

describe('mergeCrmProfile', () => {
  it('füllt nur leere Felder (fill-empty-only)', () => {
    const existing = profile({ company: null, favoriteTable: null });
    const incoming: IncomingCrm = { company: 'Neu AG', favoriteTable: 'Tisch 1' };
    const res = mergeCrmProfile(existing, incoming);
    expect(res.merged.company).toBe('Neu AG');
    expect(res.merged.favoriteTable).toBe('Tisch 1');
    expect(res.changedFields.sort()).toEqual(['company', 'favoriteTable']);
    expect(res.conflictFields).toEqual([]);
  });

  it('überschreibt nie einen bestehenden Wert und meldet Konflikt', () => {
    const existing = profile({ company: 'Bestehend AG' });
    const res = mergeCrmProfile(existing, { company: 'Anders AG' });
    expect(res.merged.company).toBe('Bestehend AG'); // bleibt
    expect(res.changedFields).toEqual([]);
    expect(res.conflictFields).toEqual(['company']);
  });

  it('identischer Wert ist weder Änderung noch Konflikt', () => {
    const res = mergeCrmProfile(profile({ company: 'Gleich AG' }), { company: 'Gleich AG' });
    expect(res.changedFields).toEqual([]);
    expect(res.conflictFields).toEqual([]);
  });

  it('leeres Importfeld ändert nichts', () => {
    const res = mergeCrmProfile(profile({ company: 'Bestehend AG' }), {});
    expect(res.merged.company).toBe('Bestehend AG');
    expect(res.changedFields).toEqual([]);
  });

  it('Boolean: positiver Wert hebt false→true, lässt true unangetastet', () => {
    const a = mergeCrmProfile(profile({ vipManual: false }), { vipManual: true });
    expect(a.merged.vipManual).toBe(true);
    expect(a.changedFields).toEqual(['vipManual']);

    const b = mergeCrmProfile(profile({ vipManual: true }), { vipManual: true });
    expect(b.changedFields).toEqual([]);
    expect(b.conflictFields).toEqual([]);
  });
});

describe('planGuestImport', () => {
  const index = buildGuestIndex(GUESTS);

  it('gruppiert Treffer je Gast, berechnet Statistik und dedupliziert', () => {
    const rows: ParsedGuestRow[] = [
      // zwei Zeilen für denselben Gast (E-Mail) → ein einziger Plan-Eintrag
      makeRow({ rowNumber: 1, normEmail: 'match@example.test', matchTier: 'email', company: 'Firma A' }),
      makeRow({ rowNumber: 2, normEmail: 'match@example.test', matchTier: 'email', favoriteTable: 'Tisch 2' }),
      // bestehendes Profil mit Konflikt (company differs) + neue Info (vip)
      makeRow({ rowNumber: 3, normMobile: '41791234567', matchTier: 'mobile', company: 'Andere AG', vip: true }),
      // Namenstreffer auf Gast ohne bestehendes Profil
      makeRow({ rowNumber: 4, normName: 'clara drei', matchTier: 'name', newsletter: true }),
      // mehrdeutig → nicht zuordenbar
      makeRow({ rowNumber: 5, normName: 'dup name', matchTier: 'name', vip: true }),
      // kein Schlüssel → nicht zuordenbar
      makeRow({ rowNumber: 6 }),
    ];
    const existing = new Map<string, GuestCrmProfile>([
      ['g-phone', profile({ company: 'Bestehend AG' })], // company-Konflikt, vip wird ergänzt
    ]);

    const { plan, stats } = planGuestImport(rows, index, existing);

    expect(stats.rowsParsed).toBe(6);
    expect(stats.matchedRows).toBe(4);   // Zeilen 1,2,3,4
    expect(stats.matchedGuests).toBe(3); // g-email, g-phone, g-name
    expect(stats.unassignable).toBe(2);  // Zeilen 5,6
    expect(stats.created).toBe(2);       // g-email, g-name (kein bestehendes Profil)
    expect(stats.updated).toBe(1);       // g-phone (vip ergänzt)
    expect(stats.conflicts).toBe(1);     // g-phone company

    const byId = new Map(plan.map((e) => [e.guestId, e]));
    expect(byId.get('g-email')?.isCreate).toBe(true);
    expect(byId.get('g-email')?.profile.company).toBe('Firma A');
    expect(byId.get('g-email')?.profile.favoriteTable).toBe('Tisch 2'); // beide Zeilen kombiniert
    expect(byId.get('g-phone')?.isCreate).toBe(false);
    expect(byId.get('g-phone')?.profile.company).toBe('Bestehend AG');  // Konflikt → bleibt
    expect(byId.get('g-phone')?.profile.vipManual).toBe(true);          // ergänzt
    expect(byId.get('g-name')?.profile.newsletterOptIn).toBe(true);
  });

  it('erzeugt keinen Plan-Eintrag, wenn nichts zu schreiben ist', () => {
    const rows = [makeRow({ rowNumber: 1, normEmail: 'match@example.test', matchTier: 'email', company: 'Schon da AG' })];
    const existing = new Map<string, GuestCrmProfile>([['g-email', profile({ company: 'Schon da AG' })]]);
    const { plan, stats } = planGuestImport(rows, index, existing);
    expect(plan).toHaveLength(0);
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.matchedGuests).toBe(1);
  });
});
