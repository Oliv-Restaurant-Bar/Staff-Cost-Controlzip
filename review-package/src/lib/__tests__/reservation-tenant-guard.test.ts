// @vitest-environment node
/**
 * Test: Reservationen-Import — Mandanten-Schutz
 * =============================================
 * Hintergrund: Foratable-Exporte wurden versehentlich unter dem falschen
 * Mandanten importiert (Res.Nr. lagen doppelt unter oliv UND beaulieu). Diese
 * Tests sichern die künftige Verhinderung ab — reine, DB-freie Logik:
 *   - Extraktion des dominanten Restaurant-Namens aus der CSV-Spalte «Restaurant».
 *   - Mapping Restaurant-Name → Mandant (Oliv/Beaulieu/unbekannt/leer),
 *     wort-/lowercase-basiert; Beaulieu vor Oliv geprüft.
 *   - Mismatch-Blockade-Logik: erkannter, abweichender Mandant → harter Stopp;
 *     unbekannter/fehlender Name → nur Warnung (kein Stopp); passend → i.O.
 */
import { describe, it, expect } from 'vitest';
import {
  parseReservationsCsv,
  dominantRestaurantName,
  mapRestaurantToTenant,
  checkTenantMatch,
} from '@/lib/reservation-import-parser';

const HEADER =
  'Restaurant;Res.Nr.;Personen;Zeit;Datum;Firma;Vorname;Nachname;Mobile;E-Mail;Status;"reserviert am";Kommentar;Notiz;Tisch;Auswahl;Gästeinformationen;Raum;Bereich';

function row(restaurant: string, resnr: string): string {
  return [restaurant, resnr, '2', '19:00', '15.07.2026', '', '', '', '', '', 'Bestätigt', '', '', '', '', '', '', '', '']
    .join(';');
}

// ── Extraktion des dominanten Restaurant-Namens ──────────────────────────────

describe('dominantRestaurantName', () => {
  it('liefert den häufigsten nicht-leeren Restaurant-Namen', () => {
    const res = [
      { restaurantName: 'Oliv Restaurant & Bar' },
      { restaurantName: 'Oliv Restaurant & Bar' },
      { restaurantName: 'Beaulieu Restaurant' },
    ];
    expect(dominantRestaurantName(res)).toBe('Oliv Restaurant & Bar');
  });

  it('ignoriert leere Werte', () => {
    const res = [
      { restaurantName: '' },
      { restaurantName: '   ' },
      { restaurantName: 'Beaulieu Restaurant' },
    ];
    expect(dominantRestaurantName(res)).toBe('Beaulieu Restaurant');
  });

  it('gibt null zurück, wenn kein Restaurant-Name vorhanden ist', () => {
    expect(dominantRestaurantName([{ restaurantName: '' }, { restaurantName: null }])).toBeNull();
    expect(dominantRestaurantName([])).toBeNull();
  });

  it('extrahiert den dominanten Namen direkt aus einer geparsten CSV', () => {
    const csv = [
      HEADER,
      row('Oliv Restaurant & Bar', 'R1'),
      row('Oliv Restaurant & Bar', 'R2'),
      row('Beaulieu Restaurant', 'R3'),
    ].join('\n');
    const result = parseReservationsCsv('oliv.csv', csv);
    expect(result.headerOk).toBe(true);
    expect(result.dominantRestaurantName).toBe('Oliv Restaurant & Bar');
  });
});

// ── Mapping Restaurant-Name → Mandant ────────────────────────────────────────

describe('mapRestaurantToTenant', () => {
  it('erkennt Oliv (Substring, case-insensitiv)', () => {
    expect(mapRestaurantToTenant('Oliv Restaurant & Bar')).toBe('oliv');
    expect(mapRestaurantToTenant('OLIV')).toBe('oliv');
    expect(mapRestaurantToTenant('  oliv  ')).toBe('oliv');
  });

  it('erkennt Beaulieu (Substring, case-insensitiv)', () => {
    expect(mapRestaurantToTenant('Beaulieu Restaurant')).toBe('beaulieu');
    expect(mapRestaurantToTenant('restaurant beaulieu')).toBe('beaulieu');
    expect(mapRestaurantToTenant('BEAULIEU')).toBe('beaulieu');
  });

  it('Beaulieu wird vor Oliv geprüft (kein Fehlmatch)', () => {
    // Falls beide Tokens vorkämen, gewinnt Beaulieu (Reihenfolge).
    expect(mapRestaurantToTenant('Beaulieu Oliv Test')).toBe('beaulieu');
  });

  it('unbekannter / leerer Name → null', () => {
    expect(mapRestaurantToTenant('Irgendein Café')).toBeNull();
    expect(mapRestaurantToTenant('')).toBeNull();
    expect(mapRestaurantToTenant(null)).toBeNull();
    expect(mapRestaurantToTenant(undefined)).toBeNull();
  });
});

// ── Mismatch-Blockade-Logik ──────────────────────────────────────────────────

describe('checkTenantMatch — Blockade / Warnung', () => {
  it('passender Mandant → kein Block, keine Warnung', () => {
    const r = checkTenantMatch('Oliv Restaurant & Bar', 'oliv');
    expect(r.block).toBe(false);
    expect(r.warn).toBe(false);
    expect(r.message).toBeNull();
    expect(r.fileTenant).toBe('oliv');
    expect(r.activeTenant).toBe('oliv');
  });

  it('erkannter, ABWEICHENDER Mandant → HARTER STOPP', () => {
    const r = checkTenantMatch('Beaulieu Restaurant', 'oliv');
    expect(r.block).toBe(true);
    expect(r.warn).toBe(false);
    expect(r.fileTenant).toBe('beaulieu');
    expect(r.activeTenant).toBe('oliv');
    expect(r.message).toContain('Beaulieu');
    expect(r.message).toContain('Oliv');
  });

  it('umgekehrte Richtung: Oliv-Datei bei aktivem Beaulieu → Stopp', () => {
    const r = checkTenantMatch('Oliv Restaurant & Bar', 'beaulieu');
    expect(r.block).toBe(true);
    expect(r.fileTenant).toBe('oliv');
  });

  it('unbekannter Restaurant-Name → nur Warnung, KEIN Stopp', () => {
    const r = checkTenantMatch('Irgendein Café', 'oliv');
    expect(r.block).toBe(false);
    expect(r.warn).toBe(true);
    expect(r.fileTenant).toBeNull();
    expect(r.message).toContain('Oliv');
  });

  it('fehlender / leerer Restaurant-Name → nur Warnung, KEIN Stopp', () => {
    const r = checkTenantMatch(null, 'beaulieu');
    expect(r.block).toBe(false);
    expect(r.warn).toBe(true);
    expect(r.fileTenant).toBeNull();
    expect(r.fileRestaurant).toBeNull();
    expect(r.message).toContain('Beaulieu');
  });

  it('Vorschau-Felder immer belegt: fileRestaurant + activeTenant', () => {
    const r = checkTenantMatch('Beaulieu Restaurant', 'oliv');
    expect(r.fileRestaurant).toBe('Beaulieu Restaurant');
    expect(r.activeTenant).toBe('oliv');
  });
});
