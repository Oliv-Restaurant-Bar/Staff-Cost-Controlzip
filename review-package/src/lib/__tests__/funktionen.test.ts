// @vitest-environment node
/**
 * Tests: zentrale Funktionsliste (Anpassung 1) — Kanon + Alt-Wert-Durchreichung.
 */
import { describe, it, expect } from 'vitest';

import { FUNKTIONEN, FUNKTION_ALT_ALIASE, funktionOptionen, istKanonischeFunktion } from '../funktionen';

describe('FUNKTIONEN', () => {
  it('enthält genau die 10 vorgegebenen Funktionen', () => {
    expect(FUNKTIONEN).toEqual([
      'Serviceangestellte', 'Runner', 'Barista', 'Buffet/Office', 'Küchenchef',
      'Koch', 'Hilfskoch', 'Pizzaiolo', 'Abwäscher', 'Aushilfe',
    ]);
  });
  it('Alt-Werte «Service»/«Servicemitarbeiterin» zeigen auf «Serviceangestellte»', () => {
    expect(FUNKTION_ALT_ALIASE['Service']).toBe('Serviceangestellte');
    expect(FUNKTION_ALT_ALIASE['Servicemitarbeiterin']).toBe('Serviceangestellte');
  });
});

describe('funktionOptionen', () => {
  it('ohne Bestandswert bzw. mit kanonischem Wert ⇒ nur die Kanon-Liste', () => {
    expect(funktionOptionen()).toEqual([...FUNKTIONEN]);
    expect(funktionOptionen('Koch')).toEqual([...FUNKTIONEN]);
  });
  it('abweichender Bestandswert wird als Zusatzoption durchgereicht (nie still verworfen)', () => {
    const opts = funktionOptionen('Servicemitarbeiterin');
    expect(opts[0]).toBe('Servicemitarbeiterin');
    expect(opts).toHaveLength(FUNKTIONEN.length + 1);
  });
  it('istKanonischeFunktion: leere/fremde Werte ⇒ false', () => {
    expect(istKanonischeFunktion(undefined)).toBe(false);
    expect(istKanonischeFunktion('Service')).toBe(false);
    expect(istKanonischeFunktion('Runner')).toBe(true);
  });
});
