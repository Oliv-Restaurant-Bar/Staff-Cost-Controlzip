// @vitest-environment node
/**
 * personalstamm-prefs — Defaults + defensive Normalisierung.
 * Fixiert: Default = Liste + Name A–Z; unbekannte Rohwerte fallen
 * einzeln auf die Defaults zurück (nie Crash, nie undefined).
 */

import { describe, it, expect } from 'vitest';
import {
  defaultPersonalstammPrefs,
  normalizePersonalstammPrefs,
  PERSONALSTAMM_PREFS_KEY,
} from '../personalstamm-prefs';

describe('personalstamm-prefs', () => {
  it('Default: Liste + Name A–Z', () => {
    expect(defaultPersonalstammPrefs()).toEqual({ view: 'liste', sort: 'name' });
  });

  it('normalisiert gültige Werte unverändert', () => {
    expect(normalizePersonalstammPrefs({ view: 'kacheln', sort: 'eintritt_neu' }))
      .toEqual({ view: 'kacheln', sort: 'eintritt_neu' });
  });

  it('unbekannte/kaputte Rohwerte ⇒ Defaults (einzeln je Feld)', () => {
    expect(normalizePersonalstammPrefs(null)).toEqual(defaultPersonalstammPrefs());
    expect(normalizePersonalstammPrefs('quatsch')).toEqual(defaultPersonalstammPrefs());
    expect(normalizePersonalstammPrefs([])).toEqual(defaultPersonalstammPrefs());
    expect(normalizePersonalstammPrefs({ view: 'grid', sort: 'name' }))
      .toEqual({ view: 'liste', sort: 'name' });
    expect(normalizePersonalstammPrefs({ view: 'kacheln', sort: 'lohn' }))
      .toEqual({ view: 'kacheln', sort: 'name' });
  });

  it('Storage-Key ist versioniert', () => {
    expect(PERSONALSTAMM_PREFS_KEY).toBe('personalstamm_prefs_v1');
  });
});
