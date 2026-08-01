// @vitest-environment happy-dom
/** Diff-Vorschau + 1:1-Monatsersatz-Semantik des Gäste-Imports (dublettensicher). */
import { describe, it, expect } from 'vitest';
import { diffGaesteDaily } from '../gaeste-store';

describe('diffGaesteDaily', () => {
  const prior = {
    '2026-07-01': 100, '2026-07-02': 200, '2026-07-05': 50, // 05. nicht in Datei → entfernt
    '2026-06-30': 999, // anderer Monat → unberührt
  };
  it('klassifiziert neu / aktualisiert / unverändert und listet entfernte Alt-Tage', () => {
    const incoming = { '2026-07-01': 100, '2026-07-02': 250, '2026-07-03': 80 };
    const d = diffGaesteDaily(prior, incoming, ['2026-07']);
    expect(d).toEqual({ neu: 1, aktualisiert: 1, unveraendert: 1, entfernt: ['2026-07-05'] });
  });
  it('identischer Re-Import: alles unverändert, nichts entfernt — keine Verdopplung möglich', () => {
    const incoming = { '2026-07-01': 100, '2026-07-02': 200, '2026-07-05': 50 };
    const d = diffGaesteDaily(prior, incoming, ['2026-07']);
    expect(d).toEqual({ neu: 0, aktualisiert: 0, unveraendert: 3, entfernt: [] });
  });
  it('andere Monate zählen nie als entfernt', () => {
    const d = diffGaesteDaily(prior, { '2026-07-01': 1 }, ['2026-07']);
    expect(d.entfernt).toEqual(['2026-07-02', '2026-07-05']);
    expect(d.entfernt).not.toContain('2026-06-30');
  });
});
