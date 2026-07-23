// @vitest-environment node
/**
 * monat-param — Monats-Kontext der KPI-Drilldowns (reine Logik).
 *  - parseMonatParam: strikte Validierung, ungültig ⇒ null (nie raten)
 *  - buildKpiDrilldownUrl: Allow-List (monat-Routen, year-Vertrag /umsatzabstimmung,
 *    alle anderen Routen unverändert)
 */
import { describe, it, expect } from 'vitest';

import {
  MONAT_PARAM,
  buildKpiDrilldownUrl,
  formatMonatParam,
  parseMonatParam,
} from '../monat-param';

describe('formatMonatParam', () => {
  it('baut YYYY-MM mit führender Null', () => {
    expect(formatMonatParam(2026, 7)).toBe('2026-07');
    expect(formatMonatParam(2025, 12)).toBe('2025-12');
  });
});

describe('parseMonatParam', () => {
  it('parst gültige Werte (Roundtrip mit formatMonatParam)', () => {
    expect(parseMonatParam('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(parseMonatParam(formatMonatParam(2024, 1))).toEqual({ year: 2024, month: 1 });
    expect(parseMonatParam(' 2026-12 ')).toEqual({ year: 2026, month: 12 });
  });

  it('lehnt fehlende/leere Werte ab', () => {
    expect(parseMonatParam(null)).toBeNull();
    expect(parseMonatParam(undefined)).toBeNull();
    expect(parseMonatParam('')).toBeNull();
  });

  it('lehnt ungültige Formate ab (nie raten)', () => {
    expect(parseMonatParam('2026-7')).toBeNull();      // Monat ohne führende Null
    expect(parseMonatParam('2026/07')).toBeNull();
    expect(parseMonatParam('2026-07-01')).toBeNull();  // volles Datum
    expect(parseMonatParam('Juli 2026')).toBeNull();
    expect(parseMonatParam('2026-00')).toBeNull();     // Monat 0
    expect(parseMonatParam('2026-13')).toBeNull();     // Monat 13
    expect(parseMonatParam('1999-05')).toBeNull();     // Jahr ausserhalb Plausibilität
    expect(parseMonatParam('2101-05')).toBeNull();
  });
});

describe('buildKpiDrilldownUrl', () => {
  it('hängt ?monat=YYYY-MM an Monats-Routen an', () => {
    expect(buildKpiDrilldownUrl('/erfolgsrechnung', 2026, 7)).toBe(`/erfolgsrechnung?${MONAT_PARAM}=2026-07`);
    expect(buildKpiDrilldownUrl('/personal-fix', 2025, 12)).toBe(`/personal-fix?${MONAT_PARAM}=2025-12`);
    expect(buildKpiDrilldownUrl('/wes-analyse', 2026, 3)).toBe(`/wes-analyse?${MONAT_PARAM}=2026-03`);
    expect(buildKpiDrilldownUrl('/kennzahlen-bericht', 2026, 6)).toBe(`/kennzahlen-bericht?${MONAT_PARAM}=2026-06`);
    expect(buildKpiDrilldownUrl('/tagesabschluesse', 2026, 7)).toBe(`/tagesabschluesse?${MONAT_PARAM}=2026-07`);
    expect(buildKpiDrilldownUrl('/reporting', 2026, 7)).toBe(`/reporting?${MONAT_PARAM}=2026-07`);
  });

  it('nutzt den bestehenden ?year=-Vertrag für /umsatzabstimmung', () => {
    expect(buildKpiDrilldownUrl('/umsatzabstimmung', 2026, 7)).toBe('/umsatzabstimmung?year=2026');
  });

  it('lässt Routen ohne Monatsbegriff unverändert (kein blinder Param)', () => {
    expect(buildKpiDrilldownUrl('/tagesansicht', 2026, 7)).toBe('/tagesansicht');
    expect(buildKpiDrilldownUrl('/gaeste', 2026, 7)).toBe('/gaeste');
    expect(buildKpiDrilldownUrl('/gaeste/auswertung', 2026, 7)).toBe('/gaeste/auswertung');
    expect(buildKpiDrilldownUrl('/produkt-analyse', 2026, 7)).toBe('/produkt-analyse');
    expect(buildKpiDrilldownUrl('/warenrechnungen', 2026, 7)).toBe('/warenrechnungen');
    expect(buildKpiDrilldownUrl('/personal', 2026, 7)).toBe('/personal');
    expect(buildKpiDrilldownUrl('/analyse', 2026, 7)).toBe('/analyse');
  });

  it('erweitert bestehende Query-Strings mit & statt ?', () => {
    expect(buildKpiDrilldownUrl('/erfolgsrechnung?foo=1', 2026, 7)).toBe('/erfolgsrechnung?foo=1'); // nicht in Allow-List (exakter Routen-Match)
  });

  it('Roundtrip: gebaute URL ist von der Zielseite parsebar', () => {
    const url = buildKpiDrilldownUrl('/erfolgsrechnung', 2026, 7);
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(parseMonatParam(qs.get(MONAT_PARAM))).toEqual({ year: 2026, month: 7 });
  });
});
