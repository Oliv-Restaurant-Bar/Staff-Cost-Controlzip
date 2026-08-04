// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildExecutiveWarnings, type ExecutiveWarningsInput } from '../executive-warnings';
import type { StartCard } from '../start-overview-utils';
import type { TypeCompletion } from '../import-tasks-priority';

const card = (over: Partial<StartCard>): StartCard => ({
  id: 'umsatz',
  title: 'Umsatzimport',
  status: 'ok',
  statusLabel: 'Aktuell',
  detail: 'Ist-Daten bis 13.07.2026',
  route: '/tagesabschluesse',
  ...over,
});

const tc = (over: Partial<TypeCompletion>): TypeCompletion => ({
  type: 'zbericht',
  label: 'Z-Berichte',
  status: 'done',
  detail: null,
  ...over,
} as TypeCompletion);

const base: ExecutiveWarningsInput = {
  cards: [],
  typeCompletions: [],
  coverageError: null,
  cogsRatioActual: null,
  personnelRatioActual: null,
  personnelRatioTarget: null,
};

describe('buildExecutiveWarnings', () => {
  it('leerer Input ⇒ allGood, keine Warnungen', () => {
    const r = buildExecutiveWarnings(base);
    expect(r.warnings).toEqual([]);
    expect(r.allGood).toBe(true);
    expect(r.criticalCount).toBe(0);
    expect(r.warnCount).toBe(0);
  });

  it('Karte action ⇒ rot mit Titel+Detail und Route (bestehende StartWarning-Semantik)', () => {
    const r = buildExecutiveWarnings({
      ...base,
      cards: [card({ id: 'tagesabschluss', title: 'Tagesabschluss', status: 'action', detail: 'Gestern nicht bestätigt', route: '/tagesabschluesse' })],
    });
    expect(r.warnings).toEqual([
      { id: 'card-tagesabschluss', tone: 'critical', text: 'Tagesabschluss: Gestern nicht bestätigt', route: '/tagesabschluesse' },
    ]);
    expect(r.criticalCount).toBe(1);
    expect(r.allGood).toBe(false);
  });

  it('Karte due_soon ⇒ orange; ok/unknown ⇒ keine Warnung', () => {
    const r = buildExecutiveWarnings({
      ...base,
      cards: [
        card({ id: 'dienstplan', title: 'Dienstplan', status: 'due_soon', detail: 'Nur 3 Tage vorausgeplant', route: '/personal/dienstplan' }),
        card({ id: 'umsatz', status: 'ok' }),
        card({ id: 'reservationen', status: 'unknown' }),
      ],
    });
    expect(r.warnings.map(w => w.id)).toEqual(['card-dienstplan']);
    expect(r.warnings[0].tone).toBe('warn');
  });

  it('TypeCompletion error ⇒ rot → /import-cockpit; open ⇒ orange → /import; done/later ⇒ nichts', () => {
    const r = buildExecutiveWarnings({
      ...base,
      typeCompletions: [
        tc({ type: 'zbericht', label: 'Z-Berichte', status: 'error', detail: 'Abfrage fehlgeschlagen' }),
        tc({ type: 'mirus', label: 'Mirus', status: 'open', detail: 'Fehlend: 10.07.–12.07.2026' }),
        tc({ type: 'budget', label: 'Budget', status: 'later' }),
        tc({ type: 'erfolgsrechnung', label: 'Erfolgsrechnung', status: 'done' }),
      ],
    });
    expect(r.warnings).toEqual([
      { id: 'import-zbericht', tone: 'critical', text: 'Z-Berichte: Abfrage fehlgeschlagen', route: '/import-cockpit' },
      { id: 'import-mirus', tone: 'warn', text: 'Mirus: Fehlend: 10.07.–12.07.2026', route: '/import' },
    ]);
  });

  it('open ohne detail ⇒ Label + «offen»', () => {
    const r = buildExecutiveWarnings({
      ...base,
      typeCompletions: [tc({ type: 'mirus', label: 'Mirus', status: 'open', detail: null })],
    });
    expect(r.warnings[0].text).toBe('Mirus: offen');
  });

  it('coverageError ohne TypeCompletions ⇒ EIN roter Eintrag (nie stilles Grün)', () => {
    const r = buildExecutiveWarnings({ ...base, typeCompletions: null, coverageError: 'Timeout' });
    expect(r.warnings).toEqual([
      { id: 'coverage-error', tone: 'critical', text: 'Import-Aufgaben: Timeout', route: '/import-cockpit' },
    ]);
  });

  it('Warenquote nutzt warenPctTone: >33 rot, >28 orange, ≤28 nichts (Rohwert entscheidet)', () => {
    const rot = buildExecutiveWarnings({ ...base, cogsRatioActual: 33.04 });
    expect(rot.warnings).toEqual([
      { id: 'kpi-warenquote', tone: 'critical', text: 'Warenquote 33.0 % — kritisch', route: '/erfolgsrechnung' },
    ]);
    const orange = buildExecutiveWarnings({ ...base, cogsRatioActual: 28.5 });
    expect(orange.warnings[0].tone).toBe('warn');
    const gruen = buildExecutiveWarnings({ ...base, cogsRatioActual: 28.0 });
    expect(gruen.allGood).toBe(true);
  });

  it('Personalquote nutzt personalPctTone mit Budget-Ziel; ohne Ziel KEINE Warnung (kein Default)', () => {
    const rot = buildExecutiveWarnings({ ...base, personnelRatioActual: 47.2, personnelRatioTarget: 42 });
    expect(rot.warnings).toEqual([
      { id: 'kpi-personalquote', tone: 'critical', text: 'Personalquote 47.2 % (Ziel 42.0 %)', route: '/personal-fix' },
    ]);
    const orange = buildExecutiveWarnings({ ...base, personnelRatioActual: 43.0, personnelRatioTarget: 42 });
    expect(orange.warnings[0].tone).toBe('warn');
    const ok = buildExecutiveWarnings({ ...base, personnelRatioActual: 41.9, personnelRatioTarget: 42 });
    expect(ok.allGood).toBe(true);
    const ohneZiel = buildExecutiveWarnings({ ...base, personnelRatioActual: 99, personnelRatioTarget: null });
    expect(ohneZiel.allGood).toBe(true);
  });

  it('fehlende Quoten (null) lösen NIE eine Warnung aus (fehlend ≠ 0)', () => {
    const r = buildExecutiveWarnings({ ...base, cogsRatioActual: null, personnelRatioActual: null, personnelRatioTarget: 42 });
    expect(r.allGood).toBe(true);
  });

  it('Sortierung: rot vor orange, innerhalb der Stufe Eingangsreihenfolge', () => {
    const r = buildExecutiveWarnings({
      ...base,
      cards: [card({ id: 'dienstplan', title: 'Dienstplan', status: 'due_soon', detail: 'Bald fällig', route: '/personal/dienstplan' })],
      typeCompletions: [tc({ type: 'zbericht', label: 'Z-Berichte', status: 'error', detail: 'Fehler' })],
      cogsRatioActual: 34,
    });
    expect(r.warnings.map(w => w.id)).toEqual(['import-zbericht', 'kpi-warenquote', 'card-dienstplan']);
    expect(r.criticalCount).toBe(2);
    expect(r.warnCount).toBe(1);
  });
});
