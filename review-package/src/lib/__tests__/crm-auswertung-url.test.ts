// @vitest-environment node
/**
 * Tests für crm-auswertung-url — reine View-State ⇄ URL Logik.
 * Synthetische Daten, keine PII, kein supabase/DOM.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCrmViewState,
  crmViewStateToParams,
  crmReturnUrl,
  buildGuestHref,
  parseFromParam,
  CRM_AUSWERTUNG_PATH,
  EMPTY_CRM_VIEW_STATE,
  type CrmViewState,
} from '../crm-auswertung-url';

const sp = (s: string) => new URLSearchParams(s);

describe('parseCrmViewState', () => {
  it('liefert Defaults bei leerer URL', () => {
    expect(parseCrmViewState(sp(''))).toEqual(EMPTY_CRM_VIEW_STATE);
  });

  it('liest gültigen tab/range/campaign', () => {
    const s = parseCrmViewState(sp('tab=campaigns&range=next-30&campaign=vip-lange-nicht-da'));
    expect(s.tab).toBe('campaigns');
    expect(s.rangeKind).toBe('next-30');
    expect(s.campaign).toBe('vip-lange-nicht-da');
  });

  it('verwirft ungültigen tab → overview', () => {
    expect(parseCrmViewState(sp('tab=hacker')).tab).toBe('overview');
  });

  it('verwirft ungültige range-Kind → current-month', () => {
    expect(parseCrmViewState(sp('range=naechstesJahrtausend')).rangeKind).toBe('current-month');
  });

  it('akzeptiert alle gültigen Schnellauswahl-Kinds', () => {
    for (const k of ['current-month', 'next-7', 'next-14', 'next-30'] as const) {
      expect(parseCrmViewState(sp(`range=${k}`)).rangeKind).toBe(k);
    }
  });

  it('nimmt den individuellen Zeitraum nur bei range=custom + rfrom + rto', () => {
    const full = parseCrmViewState(sp('range=custom&rfrom=2026-01-01&rto=2026-02-01'));
    expect(full.rangeKind).toBe('custom');
    expect(full.rangeFrom).toBe('2026-01-01');
    expect(full.rangeTo).toBe('2026-02-01');
  });

  it('verwirft custom, wenn ein Datum fehlt oder ungültig ist → current-month', () => {
    expect(parseCrmViewState(sp('range=custom&rfrom=2026-01-01')).rangeKind).toBe('current-month');
    expect(parseCrmViewState(sp('range=custom&rfrom=2026-1-1&rto=2026-02-01')).rangeKind).toBe('current-month');
    const bad = parseCrmViewState(sp('range=custom&rfrom=böse&rto=2026-02-01'));
    expect(bad.rangeKind).toBe('current-month');
    expect(bad.rangeFrom).toBeNull();
    expect(bad.rangeTo).toBeNull();
  });

  it('ignoriert rfrom/rto ohne range=custom', () => {
    const s = parseCrmViewState(sp('rfrom=2026-01-01&rto=2026-02-01'));
    expect(s.rangeKind).toBe('current-month');
    expect(s.rangeFrom).toBeNull();
    expect(s.rangeTo).toBeNull();
  });

  it('degradiert alte URL-Parameter (future/rsel) auf Defaults', () => {
    const s = parseCrmViewState(sp('future=next30&rsel=active&rfrom=2026-01-01&rto=2026-02-01'));
    expect(s).toEqual(EMPTY_CRM_VIEW_STATE);
  });
});

describe('crmViewStateToParams', () => {
  it('lässt Defaults weg (leere URL)', () => {
    expect(crmViewStateToParams(EMPTY_CRM_VIEW_STATE).toString()).toBe('');
  });

  it('lässt tab=overview und range=current-month weg', () => {
    expect(crmViewStateToParams({ ...EMPTY_CRM_VIEW_STATE, tab: 'overview', rangeKind: 'current-month' }).toString()).toBe('');
  });

  it('emittiert nicht-Default tab/range/campaign', () => {
    const p = crmViewStateToParams({
      ...EMPTY_CRM_VIEW_STATE, tab: 'return', rangeKind: 'next-14', campaign: 'geburtstag',
    });
    expect(p.get('tab')).toBe('return');
    expect(p.get('range')).toBe('next-14');
    expect(p.get('campaign')).toBe('geburtstag');
  });

  it('emittiert den individuellen Zeitraum nur vollständig', () => {
    const partial = crmViewStateToParams({ ...EMPTY_CRM_VIEW_STATE, rangeKind: 'custom', rangeFrom: '2026-01-01' });
    expect(partial.has('range')).toBe(false);
    expect(partial.has('rfrom')).toBe(false);
    const full = crmViewStateToParams({
      ...EMPTY_CRM_VIEW_STATE, rangeKind: 'custom', rangeFrom: '2026-01-01', rangeTo: '2026-02-01',
    });
    expect(full.get('range')).toBe('custom');
    expect(full.get('rfrom')).toBe('2026-01-01');
    expect(full.get('rto')).toBe('2026-02-01');
  });
});

describe('round-trip parse ↔ serialize', () => {
  const cases: CrmViewState[] = [
    EMPTY_CRM_VIEW_STATE,
    { tab: 'campaigns', rangeKind: 'next-30', rangeFrom: null, rangeTo: null, campaign: 'vip-lange-nicht-da' },
    { tab: 'overview', rangeKind: 'custom', rangeFrom: '2026-03-01', rangeTo: '2026-03-31', campaign: null },
    { tab: 'return', rangeKind: 'next-7', rangeFrom: null, rangeTo: null, campaign: 'no-show-risiko' },
  ];
  it('bleibt unter parse(serialize(x)) === x stabil', () => {
    for (const state of cases) {
      expect(parseCrmViewState(crmViewStateToParams(state))).toEqual(state);
    }
  });
});

describe('crmReturnUrl', () => {
  it('liefert den reinen Pfad ohne Query bei Default-Zustand', () => {
    expect(crmReturnUrl(EMPTY_CRM_VIEW_STATE)).toBe(CRM_AUSWERTUNG_PATH);
  });
  it('hängt den Query-String bei Zustand an', () => {
    const url = crmReturnUrl({ ...EMPTY_CRM_VIEW_STATE, tab: 'campaigns' });
    expect(url).toBe(`${CRM_AUSWERTUNG_PATH}?tab=campaigns`);
  });
});

describe('buildGuestHref', () => {
  it('ohne from → reiner Gästepfad', () => {
    expect(buildGuestHref('g-123')).toBe('/gaeste/g-123');
  });
  it('encodiert die guestId', () => {
    expect(buildGuestHref('a/b?c')).toBe(`/gaeste/${encodeURIComponent('a/b?c')}`);
  });
  it('encodiert das from-Ziel als Parameter', () => {
    const from = `${CRM_AUSWERTUNG_PATH}?tab=return&range=next-30`;
    const href = buildGuestHref('g-1', from);
    expect(href).toBe(`/gaeste/g-1?from=${encodeURIComponent(from)}`);
    // Und ist wieder dekodierbar zum exakten Ziel:
    const back = parseFromParam(new URLSearchParams(href.split('?')[1]));
    expect(back).toBe(from);
  });
});

describe('parseFromParam — Sicherheit (Open-Redirect-Abwehr)', () => {
  it('null ohne from', () => {
    expect(parseFromParam(sp(''))).toBeNull();
  });

  it('akzeptiert die interne CRM-Auswertungsroute (mit Query)', () => {
    const target = `${CRM_AUSWERTUNG_PATH}?tab=campaigns&campaign=vip-lange-nicht-da`;
    const params = new URLSearchParams();
    params.set('from', target);
    expect(parseFromParam(params)).toBe(target);
  });

  it('gibt nur pathname + search zurück (kein Origin)', () => {
    const params = new URLSearchParams();
    params.set('from', `${CRM_AUSWERTUNG_PATH}?tab=return`);
    const out = parseFromParam(params)!;
    expect(out.startsWith('/gaeste/auswertung')).toBe(true);
    expect(out).not.toContain('crm.local.invalid');
  });

  it.each([
    ['protokoll-relativ', '//evil.com'],
    ['absolute http-URL', 'https://evil.com/gaeste/auswertung'],
    ['fremder Pfad', '/gaeste'],
    ['Unterpfad der Route', '/gaeste/auswertung/extra'],
    ['Pfad-Trick mit @', '/gaeste/auswertung@evil.com'],
    ['Backslash', '/gaeste/auswertung\\@evil'],
    ['Steuerzeichen', '/gaeste/auswertung\x01'],
    ['ganz anderer Pfad', '/admin'],
  ])('lehnt %s ab → null', (_label, raw) => {
    const params = new URLSearchParams();
    params.set('from', raw);
    expect(parseFromParam(params)).toBeNull();
  });
});
