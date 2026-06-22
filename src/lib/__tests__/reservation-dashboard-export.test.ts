// @vitest-environment node
/**
 * Tests für den Export der Rückkehrpotenzial-Liste (typisierte Zellen).
 * Synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  RETURN_POTENTIAL_HEADERS,
  returnPotentialRowToCells,
  type ReturnPotentialRow,
} from '../reservation-dashboard';
import { SEGMENT_LABEL, type GuestSegment } from '../reservation-crm';

const label = (s: GuestSegment) => SEGMENT_LABEL[s];

function row(over: Partial<ReturnPotentialRow> = {}): ReturnPotentialRow {
  return {
    id: 'g',
    displayName: 'Gast',
    segment: 'stammgast',
    visits: 10,
    avgDaysBetweenVisits: null,
    lastVisit: null,
    daysSinceLastVisit: null,
    overdueByDays: 0,
    ...over,
  };
}

describe('returnPotentialRowToCells', () => {
  it('bildet Name, Segmentlabel, Zahlen und Date-Zelle ab', () => {
    const cells = returnPotentialRowToCells(
      row({
        displayName: 'Berta',
        segment: 'vip',
        visits: 25,
        avgDaysBetweenVisits: 30.6,
        lastVisit: '2026-01-02',
        daysSinceLastVisit: 171,
        overdueByDays: 125.4,
      }),
      label,
    );
    expect(cells).toHaveLength(RETURN_POTENTIAL_HEADERS.length);
    expect(cells[0]).toBe('Berta');
    expect(cells[1]).toBe(SEGMENT_LABEL['vip']);
    expect(cells[2]).toBe(25);
    expect(cells[3]).toBe(31);            // Ø Intervall gerundet
    expect(cells[4]).toBeInstanceOf(Date); // Letzter Besuch
    expect(cells[5]).toBe(171);
    expect(cells[6]).toBe(125);           // Überfällig gerundet
  });

  it('lässt fehlendes Intervall/Datum leer', () => {
    const cells = returnPotentialRowToCells(
      row({ avgDaysBetweenVisits: null, lastVisit: null, daysSinceLastVisit: null }),
      label,
    );
    expect(cells[3]).toBeNull();
    expect(cells[4]).toBeNull();
    expect(cells[5]).toBeNull();
  });
});
