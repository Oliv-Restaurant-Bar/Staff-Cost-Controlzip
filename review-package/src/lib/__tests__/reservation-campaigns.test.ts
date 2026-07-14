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
  campaignRowToCells,
  campaignExportTable,
  campaignCsvFilename,
  type CampaignId,
} from '../reservation-campaigns';
import { type GuestListMetrics, type GuestSegment } from '../reservation-crm';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '../guest-crm-profile';

const TODAY = '2026-06-22';

/** Synthetisches CRM-Profil mit gezielten Overrides. */
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

/** Hilfsfunktion: welche Kampagnen-Ids treffen auf einen Gast zu? */
function matchingIds(m: GuestListMetrics): CampaignId[] {
  return CAMPAIGNS.filter(c => c.predicate(m, TODAY)).map(c => c.id);
}

// ── Vollständigkeit & Datei-Slugs ────────────────────────────────────────────

describe('Kampagnen-Katalog', () => {
  it('enthält genau die 18 vordefinierten Kampagnen', () => {
    expect(CAMPAIGNS).toHaveLength(18);
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
      'manuelle-vip',
      'manuelle-stammgaeste',
      'firmenkunden',
      'newsletter',
      'mit-allergien',
      'mit-geburtstag',
      'sperrliste',
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

  it('Manuelle CRM-Kampagnen greifen NUR bei gesetztem Flag', () => {
    expect(matchingIds(metric({ crm: crm({ vipManual: true }) }))).toContain('manuelle-vip');
    expect(matchingIds(metric({ crm: crm({ stammgastManual: true }) }))).toContain('manuelle-stammgaeste');
    expect(matchingIds(metric({ crm: crm({ companyCustomer: true }) }))).toContain('firmenkunden');
    expect(matchingIds(metric({ crm: crm({ newsletterOptIn: true }) }))).toContain('newsletter');
    expect(matchingIds(metric({ crm: crm({ blockedGuest: true }) }))).toContain('sperrliste');
    expect(matchingIds(metric({ crm: crm({ allergies: 'Nüsse' }) }))).toContain('mit-allergien');
    expect(matchingIds(metric({ crm: crm({ birthday: '1990-05-01' }) }))).toContain('mit-geburtstag');
  });

  it('Manuelle CRM-Kampagnen greifen NICHT ohne Profil oder ohne Flag', () => {
    const noProfile = metric({ visits: 5, segment: 'wiederkehrend' });
    const emptyProfile = metric({ visits: 5, segment: 'wiederkehrend', crm: crm() });
    for (const id of ['manuelle-vip', 'manuelle-stammgaeste', 'firmenkunden', 'newsletter', 'sperrliste', 'mit-allergien', 'mit-geburtstag'] as CampaignId[]) {
      expect(matchingIds(noProfile)).not.toContain(id);
      expect(matchingIds(emptyProfile)).not.toContain(id);
    }
    // leere/whitespace Allergien zählen nicht
    expect(matchingIds(metric({ crm: crm({ allergies: '   ' }) }))).not.toContain('mit-allergien');
  });

  it('Manuelle CRM-Merkmale sind unabhängig vom berechneten Segment', () => {
    // Gast ohne Besuch, aber manuell als VIP markiert → trifft manuelle-vip, nicht vip
    const m = metric({ visits: 0, segment: 'ohne_besuch', crm: crm({ vipManual: true }) });
    expect(matchingIds(m)).toContain('manuelle-vip');
    expect(matchingIds(m)).not.toContain('vip');
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
    // Ohne CRM-Profil bleiben die 8 angehängten CRM-Spalten leer (8 Semikolons).
    expect(line).toBe('Test Gast;test@example.test;+41 79 000 00 00;Stammgast;12;05.03.2026;109;31;2;;;;;;;;');
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
    // Ohne CRM-Profil sind alle 8 CRM-Spalten (Index 9–16) leer.
    expect(values).toHaveLength(CSV_HEADERS.length);
    expect(values.slice(9)).toEqual(['', '', '', '', '', '', '', '']);
  });

  it('schreibt manuelle CRM-Felder als „Ja"/Text in die angehängten Spalten', () => {
    const row = metric({
      displayName: 'CRM Gast',
      visits: 3,
      segment: 'wiederkehrend',
      crm: crm({
        vipManual: true,
        stammgastManual: false,
        companyCustomer: true,
        newsletterOptIn: true,
        blockedGuest: false,
        birthday: '1985-07-09',
        company: 'Beispiel AG',
        allergies: 'Laktose',
      }),
    });
    const values = campaignRowToCsvValues(row);
    expect(values.slice(9)).toEqual([
      'Ja',          // VIP (manuell)
      '',            // Stammgast (manuell) = false
      'Ja',          // Firmenkunde
      'Ja',          // Newsletter
      '',            // Sperrliste = false
      '09.07.1985',  // Geburtstag (deutsch)
      'Beispiel AG', // Firma
      'Laktose',     // Allergien
    ]);
  });

  it('Kopfzeile enthält die 8 CRM-Spalten in fester Reihenfolge', () => {
    expect(CSV_HEADERS.slice(9)).toEqual([
      'VIP (manuell)', 'Stammgast (manuell)', 'Firmenkunde', 'Newsletter',
      'Sperrliste', 'Geburtstag', 'Firma', 'Allergien',
    ]);
  });

  it('quotet Zellen mit Semikolon oder Anführungszeichen korrekt', () => {
    const row = metric({ displayName: 'Müller; "Chef"', segment: 'vip', visits: 20 });
    const values = campaignRowToCsvValues(row);
    const csvLine = buildCampaignCsv([row]).split('\r\n')[1];
    expect(values[0]).toBe('Müller; "Chef"');
    expect(csvLine.startsWith('"Müller; ""Chef""";')).toBe(true);
  });
});

// ── Typisierter Export (Excel) ───────────────────────────────────────────────

describe('campaignRowToCells & campaignExportTable', () => {
  it('führt Datum als Date-Zelle und Zahlen als Zahlen (für Excel)', () => {
    const cells = campaignRowToCells(metric({
      displayName: 'Test Gast',
      email: 'test@example.test',
      visits: 12,
      lastVisit: '2026-03-05',
      daysSinceLastVisit: 109,
      avgDaysBetweenVisits: 30.6,
      noShowCount: 2,
      segment: 'stammgast',
    }));
    expect(cells).toHaveLength(CSV_HEADERS.length);
    expect(cells[0]).toBe('Test Gast');
    expect(cells[3]).toBe('Stammgast');
    expect(cells[4]).toBe(12);
    expect(cells[5]).toBeInstanceOf(Date); // Letzter Besuch
    expect(cells[6]).toBe(109);
    expect(cells[7]).toBe(31);             // Ø Intervall gerundet
    expect(cells[8]).toBe(2);
  });

  it('manuelle CRM-Felder: Ja/Text + Geburtstag als Date, sonst leer', () => {
    const withCrm = campaignRowToCells(metric({
      displayName: 'CRM Gast',
      crm: crm({ vipManual: true, company: 'Beispiel AG', birthday: '1985-07-09', allergies: 'Laktose' }),
    }));
    expect(withCrm[9]).toBe('Ja');             // VIP manuell
    expect(withCrm[14]).toBeInstanceOf(Date);  // Geburtstag
    expect(withCrm[15]).toBe('Beispiel AG');   // Firma
    expect(withCrm[16]).toBe('Laktose');       // Allergien

    const noCrm = campaignRowToCells(metric({ displayName: 'Ohne CRM' }));
    expect(noCrm.slice(9)).toEqual(['', '', '', '', '', null, null, null]);
  });

  it('campaignExportTable setzt slug-basierten Dateinamen, Header und nur die übergebenen Zeilen', () => {
    const def = CAMPAIGN_BY_ID['ueberfaellige'];
    const table = campaignExportTable(def, [
      metric({ id: 'a', displayName: 'A' }),
      metric({ id: 'b', displayName: 'B' }),
    ]);
    expect(table.filename).toBe(`crm-kampagne-${def.slug}`);
    expect(table.sheetName).toBe('Kampagne');
    expect(table.headers).toEqual(CSV_HEADERS.slice());
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toBe('A');
  });
});
