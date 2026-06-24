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

  it('liest gültigen tab/future/campaign', () => {
    const s = parseCrmViewState(sp('tab=campaigns&future=next30&campaign=vip-lange-nicht-da'));
    expect(s.tab).toBe('campaigns');
    expect(s.future).toBe('next30');
    expect(s.campaign).toBe('vip-lange-nicht-da');
  });

  it('verwirft ungültigen tab → overview', () => {
    expect(parseCrmViewState(sp('tab=hacker')).tab).toBe('overview');
  });

  it('verwirft ungültigen future-Key → null', () => {
    expect(parseCrmViewState(sp('future=naechstesJahrtausend')).future).toBeNull();
  });

  it('akzeptiert alle gültigen future-Keys', () => {
    for (const k of ['currentMonth', 'nextMonth', 'next30', 'next60', 'next90', 'openNext90']) {
      expect(parseCrmViewState(sp(`future=${k}`)).future).toBe(k);
    }
  });

  it('nimmt den Zeitraum nur bei vollständiger Auswahl (rsel + rfrom + rto)', () => {
    const full = parseCrmViewState(sp('rsel=active&rfrom=2026-01-01&rto=2026-02-01'));
    expect(full.rangeSel).toBe('active');
    expect(full.rangeFrom).toBe('2026-01-01');
    expect(full.rangeTo).toBe('2026-02-01');
  });

  it('verwirft den Zeitraum komplett, wenn rsel fehlt', () => {
    const s = parseCrmViewState(sp('rfrom=2026-01-01&rto=2026-02-01'));
    expect(s.rangeSel).toBeNull();
    expect(s.rangeFrom).toBeNull();
    expect(s.rangeTo).toBeNull();
  });

  it('verwirft den Zeitraum, wenn ein Datum fehlt oder ungültig ist', () => {
    expect(parseCrmViewState(sp('rsel=open&rfrom=2026-01-01')).rangeSel).toBeNull();
    expect(parseCrmViewState(sp('rsel=open&rfrom=2026-1-1&rto=2026-02-01')).rangeSel).toBeNull();
    expect(parseCrmViewState(sp('rsel=open&rfrom=böse&rto=2026-02-01')).rangeFrom).toBeNull();
  });

  it('verwirft ungültiges rsel', () => {
    expect(parseCrmViewState(sp('rsel=evil&rfrom=2026-01-01&rto=2026-02-01')).rangeSel).toBeNull();
  });
});

describe('crmViewStateToParams', () => {
  it('lässt Defaults weg (leere URL)', () => {
    expect(crmViewStateToParams(EMPTY_CRM_VIEW_STATE).toString()).toBe('');
  });

  it('lässt tab=overview weg', () => {
    expect(crmViewStateToParams({ ...EMPTY_CRM_VIEW_STATE, tab: 'overview' }).toString()).toBe('');
  });

  it('emittiert nicht-Default tab/future/campaign', () => {
    const p = crmViewStateToParams({
      ...EMPTY_CRM_VIEW_STATE, tab: 'return', future: 'next90', campaign: 'geburtstag',
    });
    expect(p.get('tab')).toBe('return');
    expect(p.get('future')).toBe('next90');
    expect(p.get('campaign')).toBe('geburtstag');
  });

  it('emittiert den Zeitraum nur vollständig', () => {
    const partial = crmViewStateToParams({ ...EMPTY_CRM_VIEW_STATE, rangeSel: 'active', rangeFrom: '2026-01-01' });
    expect(partial.has('rsel')).toBe(false);
    expect(partial.has('rfrom')).toBe(false);
    const full = crmViewStateToParams({
      ...EMPTY_CRM_VIEW_STATE, rangeSel: 'open', rangeFrom: '2026-01-01', rangeTo: '2026-02-01',
    });
    expect(full.get('rsel')).toBe('open');
    expect(full.get('rfrom')).toBe('2026-01-01');
    expect(full.get('rto')).toBe('2026-02-01');
  });
});

describe('round-trip parse ↔ serialize', () => {
  const cases: CrmViewState[] = [
    EMPTY_CRM_VIEW_STATE,
    { tab: 'campaigns', future: 'next30', rangeSel: null, rangeFrom: null, rangeTo: null, campaign: 'vip-lange-nicht-da' },
    { tab: 'overview', future: 'openNext90', rangeSel: 'active', rangeFrom: '2026-03-01', rangeTo: '2026-03-31', campaign: null },
    { tab: 'return', future: null, rangeSel: 'open', rangeFrom: '2025-12-01', rangeTo: '2026-01-15', campaign: 'no-show-risiko' },
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
    const from = `${CRM_AUSWERTUNG_PATH}?tab=return&future=next30`;
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
