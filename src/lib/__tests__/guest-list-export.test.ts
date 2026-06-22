// @vitest-environment node
/**
 * Tests für den spaltenbewussten Export der Gäste-Liste (typisierte Zellen +
 * Tabellenaufbau). Synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  guestListExportHeaders,
  guestListRowToCells,
  guestListExportTable,
  ALL_EXPORT_COLUMNS,
} from '../guest-list-export';
import { type GuestListMetrics } from '../reservation-crm';
import { DEFAULT_VISIBLE_COLUMNS, type GuestColumnKey } from '../guest-list-columns';
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

// Voll-Layout: alle Spalten. „name" expandiert zu 3 Zellen → 18 Spalten = 20 Zellen.
describe('guestListRowToCells (alle Spalten)', () => {
  it('bildet Datumswerte als Date-Zellen und Zahlen als Zahlen ab', () => {
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
    }), ALL_EXPORT_COLUMNS);
    expect(cells).toHaveLength(20);
    expect(cells[0]).toBe('Anna');                 // Name
    expect(cells[1]).toBe('anna@example.test');    // E-Mail
    expect(cells[2]).toBe('+41 79 000 00 00');     // Telefon
    expect(cells[3]).toBe('Stammgast');            // Segment
    expect(cells[6]).toBe(12);                     // Besuche
    expect(cells[7]).toBe(3.3);                    // Ø Gruppe gerundet
    expect(cells[8]).toBeInstanceOf(Date);         // Erster Besuch
    expect(cells[9]).toBeInstanceOf(Date);         // Letzter Besuch
    expect(cells[10]).toBe(31);                    // Ø Intervall gerundet
    expect(cells[11]).toBe(109);                   // Tage seit letztem
    expect(cells[12]).toBe(3.6);                   // Rückkehr-Risiko 109/30.6 ≈ 3.56 → 3.6
  });

  it('ohne CRM-Profil bleiben die manuellen Spalten leer', () => {
    const headers = guestListExportHeaders(ALL_EXPORT_COLUMNS);
    const cells = guestListRowToCells(metric({ displayName: 'Ohne CRM' }), ALL_EXPORT_COLUMNS);
    expect(cells).toHaveLength(headers.length);
    expect(cells[4]).toBeNull();   // Firma
    expect(cells[5]).toBeNull();   // Geburtstag
    expect(cells[13]).toBe('');    // VIP manuell
    expect(cells[14]).toBe('');    // Stammgast manuell
    expect(cells[15]).toBe('');    // Firmenkunde
    expect(cells[16]).toBe('');    // Newsletter
    expect(cells[17]).toBe('');    // Sperrliste
    expect(cells[18]).toBeNull();  // Allergien
    expect(cells[19]).toBeNull();  // CRM-Notiz
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
        crmNotes: 'Tisch am Fenster',
      }),
    }), ALL_EXPORT_COLUMNS);
    expect(cells[4]).toBe('Beispiel AG');
    expect(cells[5]).toBeInstanceOf(Date);
    expect(cells[13]).toBe('Ja');
    expect(cells[14]).toBe('');
    expect(cells[15]).toBe('Ja');
    expect(cells[16]).toBe('Ja');
    expect(cells[17]).toBe('');
    expect(cells[18]).toBe('Laktose');
    expect(cells[19]).toBe('Tisch am Fenster');
  });
});

describe('Spaltenauswahl (nur sichtbare Spalten)', () => {
  it('exportiert genau die gewählten Spalten; „name" expandiert zu 3 Zellen', () => {
    const visible: GuestColumnKey[] = ['name', 'visits'];
    expect(guestListExportHeaders(visible)).toEqual(['Name', 'E-Mail', 'Telefon', 'Besuche']);
    const cells = guestListRowToCells(metric({ displayName: 'X', visits: 5 }), visible);
    expect(cells).toEqual(['X', null, null, 5]);
  });

  it('eine Spalte ohne „name" liefert genau eine Zelle', () => {
    const cells = guestListRowToCells(metric({ segment: 'vip' }), ['segment']);
    expect(cells).toEqual(['VIP']);
  });
});

describe('guestListExportTable', () => {
  it('setzt Dateiname, Blattname, Kopfzeile und nur die übergebenen Zeilen', () => {
    const table = guestListExportTable([
      metric({ id: 'a', displayName: 'A' }),
      metric({ id: 'b', displayName: 'B' }),
    ], DEFAULT_VISIBLE_COLUMNS);
    expect(table.filename).toBe('gaeste-liste');
    expect(table.sheetName).toBe('Gäste');
    expect(table.headers).toEqual(guestListExportHeaders(DEFAULT_VISIBLE_COLUMNS));
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toBe('A');
  });

  it('leere Liste → keine Datenzeilen', () => {
    expect(guestListExportTable([], DEFAULT_VISIBLE_COLUMNS).rows).toHaveLength(0);
  });
});
