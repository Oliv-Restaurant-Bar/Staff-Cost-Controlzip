// @vitest-environment node
/**
 * Tests für die CRM-Kampagnenlisten (reine Berechnung & CSV-Export).
 * Ausschliesslich synthetische Daten, keine PII, keine DB, keine DOM-Abhängigkeit.
 * Node-Umgebung (kein jsdom/canvas).
 */
import { describe, it, expect } from 'vitest';
import {
  CAMPAIGNS,
  CAMPAIGN_BY_ID,
  CSV_HEADERS,
  filterCampaign,
  summarizeCampaigns,
  buildCampaignCsv,
  campaignRowToCsvValues,
  campaignCsvFilename,
  type CampaignId,
} from '../reservation-campaigns';
import { type GuestListMetrics, type GuestSegment } from '../reservation-crm';

const TODAY = '2026-06-22';

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

/** Hilfsfunktion: welche Kampagnen-Ids treffen auf einen Gast zu? */
function matchingIds(m: GuestListMetrics): CampaignId[] {
  return CAMPAIGNS.filter(c => c.predicate(m, TODAY)).map(c => c.id);
}

// ── Vollständigkeit & Datei-Slugs ────────────────────────────────────────────

describe('Kampagnen-Katalog', () => {
  it('enthält genau die 11 vordefinierten Kampagnen', () => {
    expect(CAMPAIGNS).toHaveLength(11);
    expect(CAMPAIGNS.map(c => c.id)).toEqual([
      'ueberfaellige',
      'gefaehrdete-stammgaeste',
      'gefaehrdete-vip',
      'inaktiv-90',
      'inaktiv-180',
      'no-show-2plus',
      'wiederkehrende',
      'stammgaeste',
      'vip',
      'neukunden-30',
      'ohne-besuch',
    ]);
  });

  it('hat eindeutige Ids und Slugs sowie eine Beschreibung je Kampagne', () => {
    const ids = new Set(CAMPAIGNS.map(c => c.id));
    const slugs = new Set(CAMPAIGNS.map(c => c.slug));
    expect(ids.size).toBe(CAMPAIGNS.length);
    expect(slugs.size).toBe(CAMPAIGNS.length);
    for (const c of CAMPAIGNS) {
      expect(c.description.trim().length).toBeGreaterThan(0);
      expect(CAMPAIGN_BY_ID[c.id]).toBe(c);
    }
  });

  it('bildet sinnvolle Dateinamen', () => {
    expect(campaignCsvFilename(CAMPAIGN_BY_ID['ueberfaellige']))
      .toBe('crm-kampagne-ueberfaellige-gaeste.csv');
    expect(campaignCsvFilename(CAMPAIGN_BY_ID['inaktiv-180']))
      .toBe('crm-kampagne-inaktive-gaeste-180-tage.csv');
  });
});

// ── Prädikate ────────────────────────────────────────────────────────────────

describe('Kampagnen-Prädikate', () => {
  it('Überfällige Gäste: Tage seit letztem > Ø-Intervall × 1,5', () => {
    const overdue = metric({ visits: 5, daysSinceLastVisit: 100, avgDaysBetweenVisits: 30 });
    const onTrack = metric({ visits: 5, daysSinceLastVisit: 20, avgDaysBetweenVisits: 30 });
    expect(matchingIds(overdue)).toContain('ueberfaellige');
    expect(matchingIds(onTrack)).not.toContain('ueberfaellige');
  });

  it('Gefährdete Stammgäste: Stammgast-Tier UND > 90 Tage abwesend', () => {
    const atRisk = metric({ visits: 10, daysSinceLastVisit: 120, segment: 'inaktiv' });
    const active = metric({ visits: 10, daysSinceLastVisit: 40, segment: 'stammgast' });
    expect(matchingIds(atRisk)).toContain('gefaehrdete-stammgaeste');
    expect(matchingIds(active)).not.toContain('gefaehrdete-stammgaeste');
  });

  it('Gefährdete VIP: VIP-Tier UND > 90 Tage abwesend', () => {
    const atRisk = metric({ visits: 25, daysSinceLastVisit: 200, segment: 'inaktiv' });
    expect(matchingIds(atRisk)).toContain('gefaehrdete-vip');
    expect(matchingIds(atRisk)).not.toContain('gefaehrdete-stammgaeste');
  });

  it('Inaktiv > 90 / > 180 Tage rein datumsbasiert (auch Neukunden)', () => {
    const d100 = metric({ visits: 1, daysSinceLastVisit: 100 });
    const d200 = metric({ visits: 1, daysSinceLastVisit: 200 });
    const d50 = metric({ visits: 1, daysSinceLastVisit: 50 });
    expect(matchingIds(d100)).toContain('inaktiv-90');
    expect(matchingIds(d100)).not.toContain('inaktiv-180');
    expect(matchingIds(d200)).toEqual(expect.arrayContaining(['inaktiv-90', 'inaktiv-180']));
    expect(matchingIds(d50)).not.toContain('inaktiv-90');
  });

  it('Inaktiv schliesst Gäste ohne letzten Besuch aus', () => {
    const none = metric({ visits: 0, daysSinceLastVisit: null });
    expect(matchingIds(none)).not.toContain('inaktiv-90');
    expect(matchingIds(none)).not.toContain('inaktiv-180');
  });

  it('Grenzwert: genau 90 bzw. 180 Tage zählt NICHT (strikt >)', () => {
    const exactly90 = metric({ visits: 2, daysSinceLastVisit: 90 });
    const exactly180 = metric({ visits: 2, daysSinceLastVisit: 180 });
    expect(matchingIds(exactly90)).not.toContain('inaktiv-90');
    expect(matchingIds(exactly180)).not.toContain('inaktiv-180');
  });

  it('2+ No-Shows', () => {
    expect(matchingIds(metric({ noShowCount: 2 }))).toContain('no-show-2plus');
    expect(matchingIds(metric({ noShowCount: 1 }))).not.toContain('no-show-2plus');
  });

  it('Segmentbasierte Listen folgen dem Live-Segment', () => {
    expect(matchingIds(metric({ visits: 5, segment: 'wiederkehrend' }))).toContain('wiederkehrende');
    expect(matchingIds(metric({ visits: 10, segment: 'stammgast' }))).toContain('stammgaeste');
    expect(matchingIds(metric({ visits: 25, segment: 'vip' }))).toContain('vip');
    expect(matchingIds(metric({ visits: 0, segment: 'ohne_besuch' }))).toContain('ohne-besuch');
  });

  it('Stammgast/VIP-Kampagne enthält NICHT die bereits inaktiven (Live-Segment)', () => {
    const inactiveVip = metric({ visits: 25, daysSinceLastVisit: 200, segment: 'inaktiv' });
    expect(matchingIds(inactiveVip)).not.toContain('vip');
    expect(matchingIds(inactiveVip)).toContain('gefaehrdete-vip');
  });

  it('Neukunden letzte 30 Tage: erster Besuch innerhalb 30 Tage', () => {
    const fresh = metric({ visits: 1, firstVisit: '2026-06-10', segment: 'neukunde' }); // 12 Tage
    const old = metric({ visits: 1, firstVisit: '2026-04-01', segment: 'neukunde' });   // > 30 Tage
    expect(matchingIds(fresh)).toContain('neukunden-30');
    expect(matchingIds(old)).not.toContain('neukunden-30');
  });
});

// ── Filterung & Sortierung ───────────────────────────────────────────────────

describe('filterCampaign & summarizeCampaigns', () => {
  const guests = [
    metric({ id: 'a', displayName: 'Anton', visits: 25, daysSinceLastVisit: 300, segment: 'inaktiv' }),
    metric({ id: 'b', displayName: 'Berta', visits: 10, daysSinceLastVisit: 150, segment: 'inaktiv' }),
    metric({ id: 'c', displayName: 'Cesar', visits: 1, daysSinceLastVisit: 200, segment: 'inaktiv' }),
    metric({ id: 'd', displayName: 'Dora', visits: 12, daysSinceLastVisit: 10, segment: 'stammgast' }),
  ];

  it('inaktiv-90 liefert die längste Abwesenheit zuerst', () => {
    const rows = filterCampaign(guests, CAMPAIGN_BY_ID['inaktiv-90'], TODAY);
    expect(rows.map(r => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('stammgaeste-Liste nutzt nur das Live-Segment (aktive Dora)', () => {
    const rows = filterCampaign(guests, CAMPAIGN_BY_ID['stammgaeste'], TODAY);
    expect(rows.map(r => r.id)).toEqual(['d']);
  });

  it('summarizeCampaigns zählt korrekt', () => {
    const summary = summarizeCampaigns(guests, TODAY);
    const byId = Object.fromEntries(summary.map(s => [s.def.id, s.count]));
    expect(byId['inaktiv-90']).toBe(3);
    expect(byId['gefaehrdete-vip']).toBe(1);
    expect(byId['gefaehrdete-stammgaeste']).toBe(1);
    expect(byId['stammgaeste']).toBe(1);
  });
});

// ── CSV-Export ───────────────────────────────────────────────────────────────

describe('buildCampaignCsv', () => {
  it('beginnt mit der deutschen Kopfzeile (Semikolon-getrennt)', () => {
    const csv = buildCampaignCsv([]);
    expect(csv).toBe(CSV_HEADERS.join(';'));
    expect(csv.startsWith('Name;E-Mail;Telefon;Segment;Besuche;')).toBe(true);
  });

  it('leerer Datenbestand → nur Kopfzeile, kein BOM', () => {
    const csv = buildCampaignCsv([]);
    expect(csv.split('\r\n')).toHaveLength(1);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('schreibt eine Datenzeile mit deutschem Datum und gerundetem Intervall', () => {
    const row = metric({
      displayName: 'Test Gast',
      email: 'test@example.test',
      mobile: '+41 79 000 00 00',
      visits: 12,
      lastVisit: '2026-03-05',
      daysSinceLastVisit: 109,
      avgDaysBetweenVisits: 30.6,
      noShowCount: 2,
      segment: 'stammgast',
    });
    const [, line] = buildCampaignCsv([row]).split('\r\n');
    expect(line).toBe('Test Gast;test@example.test;+41 79 000 00 00;Stammgast;12;05.03.2026;109;31;2');
  });

  it('lässt fehlende Werte leer (kein "null", keine Einheiten)', () => {
    const row = metric({ displayName: 'Ohne Daten', segment: 'ohne_besuch' });
    const values = campaignRowToCsvValues(row);
    // E-Mail, Telefon, Letzter Besuch, Tage seit, Ø Intervall → leer
    expect(values[1]).toBe('');
    expect(values[2]).toBe('');
    expect(values[5]).toBe('');
    expect(values[6]).toBe('');
    expect(values[7]).toBe('');
    expect(values[4]).toBe('0'); // Besuche
    expect(values[8]).toBe('0'); // No Shows
  });

  it('quotet Zellen mit Semikolon oder Anführungszeichen korrekt', () => {
    const row = metric({ displayName: 'Müller; "Chef"', segment: 'vip', visits: 20 });
    const values = campaignRowToCsvValues(row);
    const csvLine = buildCampaignCsv([row]).split('\r\n')[1];
    expect(values[0]).toBe('Müller; "Chef"');
    expect(csvLine.startsWith('"Müller; ""Chef""";')).toBe(true);
  });
});
