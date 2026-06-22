// @vitest-environment node
/**
 * Tests für den Export der Gäste-Liste (typisierte Zellen + Tabellenaufbau).
 * Synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  GUEST_LIST_EXPORT_HEADERS,
  guestListRowToCells,
  guestListExportTable,
} from '../guest-list-export';
import { type GuestListMetrics } from '../reservation-crm';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '../guest-crm-profile';

function crm(over: Partial<GuestCrmProfile> = {}): GuestCrmProfile {
  return { ...EMPTY_CRM_PROFILE, ...over };
}

function metric(p: Partial<GuestListMetrics>): GuestListMetrics {
  return {
    id: 'g',
    displayName: 'Gast',
    email: null,
    mobile: null,
    visits: 0,
    totalReservations: 0,
    cancelledReservations: 0,
    firstVisit: null,
    lastVisit: null,
    daysSinceLastVisit: null,
    avgDaysBetweenVisits: null,
    avgPartySize: null,
    noShowCount: 0,
    segment: 'ohne_besuch',
    ...p,
  };
}

describe('guestListRowToCells', () => {
  it('bildet Datumswerte als echte Date-Zellen und Zahlen als Zahlen ab', () => {
    const cells = guestListRowToCells(metric({
      displayName: 'Anna',
      email: 'anna@example.test',
      mobile: '+41 79 000 00 00',
      visits: 12,
      avgPartySize: 3.27,
      firstVisit: '2025-01-10',
      lastVisit: '2026-03-05',
      avgDaysBetweenVisits: 30.6,
      daysSinceLastVisit: 109,
      segment: 'stammgast',
    }));
    expect(cells[0]).toBe('Anna');
    expect(cells[1]).toBe('anna@example.test');
    expect(cells[2]).toBe('+41 79 000 00 00');
    expect(cells[3]).toBe('Stammgast');
    expect(cells[6]).toBe(12);
    expect(cells[7]).toBe(3.3);            // gerundet auf eine Nachkommastelle
    expect(cells[8]).toBeInstanceOf(Date); // Erster Besuch
    expect(cells[9]).toBeInstanceOf(Date); // Letzter Besuch
    expect(cells[10]).toBe(31);            // Ø Intervall gerundet
    expect(cells[11]).toBe(109);
  });

  it('ohne CRM-Profil bleiben die manuellen Spalten leer', () => {
    const cells = guestListRowToCells(metric({ displayName: 'Ohne CRM' }));
    expect(cells).toHaveLength(GUEST_LIST_EXPORT_HEADERS.length);
    expect(cells[4]).toBeNull();   // Firma
    expect(cells[5]).toBeNull();   // Geburtstag
    expect(cells[12]).toBe('');    // VIP manuell
    expect(cells[13]).toBe('');    // Stammgast manuell
    expect(cells[14]).toBe('');    // Firmenkunde
    expect(cells[15]).toBe('');    // Newsletter
    expect(cells[16]).toBe('');    // Sperrliste
    expect(cells[17]).toBeNull();  // Allergien
  });

  it('übernimmt manuelle CRM-Felder (Ja/Text, Geburtstag als Date)', () => {
    const cells = guestListRowToCells(metric({
      displayName: 'Mit CRM',
      crm: crm({
        vipManual: true,
        stammgastManual: false,
        companyCustomer: true,
        newsletterOptIn: true,
        blockedGuest: false,
        company: 'Beispiel AG',
        birthday: '1985-07-09',
        allergies: 'Laktose',
      }),
    }));
    expect(cells[4]).toBe('Beispiel AG');
    expect(cells[5]).toBeInstanceOf(Date);
    expect(cells[12]).toBe('Ja');
    expect(cells[13]).toBe('');
    expect(cells[14]).toBe('Ja');
    expect(cells[15]).toBe('Ja');
    expect(cells[16]).toBe('');
    expect(cells[17]).toBe('Laktose');
  });
});

describe('guestListExportTable', () => {
  it('setzt Dateiname, Blattname, Kopfzeile und nur die übergebenen Zeilen', () => {
    const table = guestListExportTable([
      metric({ id: 'a', displayName: 'A' }),
      metric({ id: 'b', displayName: 'B' }),
    ]);
    expect(table.filename).toBe('gaeste-liste');
    expect(table.sheetName).toBe('Gäste');
    expect(table.headers).toEqual(GUEST_LIST_EXPORT_HEADERS);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toBe('A');
  });

  it('leere Liste → keine Datenzeilen', () => {
    expect(guestListExportTable([]).rows).toHaveLength(0);
  });
});
