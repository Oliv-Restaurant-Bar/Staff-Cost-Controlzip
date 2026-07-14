// @vitest-environment node
/**
 * Tests für start-overview-utils — reine Logik der vereinfachten Startseite.
 * Frische-Regeln für Umsatz/Reservationen kommen 1:1 aus computeSourceStatus
 * (Import-Cockpit); hier wird die Abbildung auf Karten/Warnungen fixiert.
 */

import { describe, it, expect } from 'vitest';
import type { CockpitSignal } from '@/lib/import-cockpit';
import {
  buildStartOverview,
  dienstplanCard,
  startStatusFromCockpit,
  tagesabschlussCard,
  tagesabschlussFromConfirmations,
  DIENSTPLAN_MIN_DAYS_AHEAD,
  type StartOverviewInput,
} from '@/lib/start-overview-utils';

const TODAY = '2026-07-08';
const EMPTY: CockpitSignal = { latestDataDate: null };

function baseInput(overrides: Partial<StartOverviewInput> = {}): StartOverviewInput {
  return {
    todayIso: TODAY,
    signals: {
      zbericht: { latestDataDate: '2026-07-07', dataUntil: '2026-07-07' },
      reservationen: {
        latestDataDate: null,
        lastImport: { at: '2026-07-08T06:00:00Z', status: 'success' },
      },
      dienstplanung: { latestDataDate: '2026-07-20', dataUntil: '2026-07-20' },
    },
    tagesabschluss: { yesterdayConfirmed: true, lastConfirmedDate: '2026-07-07' },
    ...overrides,
  };
}

describe('startStatusFromCockpit', () => {
  it('bildet Cockpit-Status korrekt ab', () => {
    expect(startStatusFromCockpit('current')).toBe('ok');
    expect(startStatusFromCockpit('due_soon')).toBe('due_soon');
    expect(startStatusFromCockpit('overdue')).toBe('action');
    expect(startStatusFromCockpit('never')).toBe('action');
    expect(startStatusFromCockpit('uncheckable')).toBe('unknown');
  });
});

describe('buildStartOverview — Karten', () => {
  it('liefert genau 4 Karten in fester Reihenfolge', () => {
    const { cards } = buildStartOverview(baseInput());
    expect(cards.map((c) => c.id)).toEqual(['umsatz', 'reservationen', 'dienstplan', 'tagesabschluss']);
  });

  it('alles aktuell → alle Karten ok, keine Warnungen', () => {
    const { cards, warnings } = buildStartOverview(baseInput());
    expect(cards.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(warnings).toEqual([]);
  });

  it('Umsatzimport überfällig (daily, 5 Tage alt) → action + Warnung mit Route', () => {
    const { cards, warnings } = buildStartOverview(
      baseInput({
        todayIso: TODAY,
        signals: {
          ...baseInput().signals,
          zbericht: { latestDataDate: '2026-07-03', dataUntil: '2026-07-03' },
        },
      }),
    );
    const umsatz = cards.find((c) => c.id === 'umsatz')!;
    expect(umsatz.status).toBe('action');
    const warn = warnings.find((w) => w.id === 'umsatz')!;
    expect(warn.text).toContain('Umsatzimport');
    expect(warn.route).toBe('/gastronovi-import');
  });

  it('Umsatzimport 2 Tage alt (due_soon) → KEINE Warnung (kein echter Handlungsbedarf)', () => {
    const { cards, warnings } = buildStartOverview(
      baseInput({
        signals: {
          ...baseInput().signals,
          zbericht: { latestDataDate: '2026-07-06', dataUntil: '2026-07-06' },
        },
      }),
    );
    expect(cards.find((c) => c.id === 'umsatz')!.status).toBe('due_soon');
    expect(warnings.find((w) => w.id === 'umsatz')).toBeUndefined();
  });

  it('Reservationen nie importiert → action „Noch nie importiert"', () => {
    const { cards, warnings } = buildStartOverview(
      baseInput({ signals: { ...baseInput().signals, reservationen: EMPTY } }),
    );
    const res = cards.find((c) => c.id === 'reservationen')!;
    expect(res.status).toBe('action');
    expect(res.detail).toBe('Noch nie importiert');
    expect(warnings.some((w) => w.id === 'reservationen')).toBe(true);
  });

  it('Reservationen: Frische über letzten Importlauf (heute) → ok', () => {
    const { cards } = buildStartOverview(baseInput());
    expect(cards.find((c) => c.id === 'reservationen')!.status).toBe('ok');
    expect(cards.find((c) => c.id === 'reservationen')!.route).toBe('/foratable-import');
  });
});

describe('dienstplanCard', () => {
  it('kein Plan vorhanden → action', () => {
    const card = dienstplanCard(EMPTY, TODAY);
    expect(card.status).toBe('action');
    expect(card.detail).toBe('Noch kein Dienstplan erfasst');
    expect(card.route).toBe('/personal');
  });

  it('Plan endet in der Vergangenheit → action', () => {
    const card = dienstplanCard({ latestDataDate: '2026-07-05', dataUntil: '2026-07-05' }, TODAY);
    expect(card.status).toBe('action');
    expect(card.detail).toContain('05.07.2026');
  });

  it(`Plan reicht weniger als ${DIENSTPLAN_MIN_DAYS_AHEAD} Tage → due_soon (keine Warnung)`, () => {
    const card = dienstplanCard({ latestDataDate: '2026-07-10', dataUntil: '2026-07-10' }, TODAY);
    expect(card.status).toBe('due_soon');
    expect(card.detail).toContain('10.07.2026');
  });

  it('Plan bis heute+7 oder weiter → ok', () => {
    // Grenzfall: exakt heute+7 (15.07.) gilt als ok.
    expect(dienstplanCard({ latestDataDate: '2026-07-15', dataUntil: '2026-07-15' }, TODAY).status).toBe('ok');
    expect(dienstplanCard({ latestDataDate: '2026-08-01', dataUntil: '2026-08-01' }, TODAY).status).toBe('ok');
  });

  it('fällt ohne dataUntil auf latestDataDate zurück', () => {
    const card = dienstplanCard({ latestDataDate: '2026-08-01' }, TODAY);
    expect(card.status).toBe('ok');
  });
});

describe('tagesabschlussCard', () => {
  it('gestern bestätigt → ok', () => {
    const card = tagesabschlussCard({ yesterdayConfirmed: true, lastConfirmedDate: '2026-07-07' }, TODAY);
    expect(card.status).toBe('ok');
    expect(card.detail).toContain('07.07.2026');
  });

  it('gestern NICHT bestätigt → action mit Hinweis auf letzte Bestätigung', () => {
    const card = tagesabschlussCard({ yesterdayConfirmed: false, lastConfirmedDate: '2026-07-04' }, TODAY);
    expect(card.status).toBe('action');
    expect(card.detail).toContain('noch nicht bestätigt');
    expect(card.detail).toContain('04.07.2026');
    expect(card.route).toBe('/tagesabschluesse');
  });

  it('keine Daten (null) → unknown, KEINE Warnung', () => {
    const card = tagesabschlussCard({ yesterdayConfirmed: null, lastConfirmedDate: null }, TODAY);
    expect(card.status).toBe('unknown');
    const { warnings } = buildStartOverview(
      baseInput({ tagesabschluss: { yesterdayConfirmed: null, lastConfirmedDate: null } }),
    );
    expect(warnings.some((w) => w.id === 'tagesabschluss')).toBe(false);
  });
});

describe('tagesabschlussFromConfirmations', () => {
  it('keine Adyen-Daten und keine Bestätigungen → null (nicht eingerichtet)', () => {
    expect(tagesabschlussFromConfirmations({}, false, TODAY)).toEqual({
      yesterdayConfirmed: null,
      lastConfirmedDate: null,
    });
  });

  it('gestern bestätigt → true + letzter bestätigter Tag', () => {
    const result = tagesabschlussFromConfirmations(
      { '2026-07-06': { confirmed: true }, '2026-07-07': { confirmed: true } },
      true,
      TODAY,
    );
    expect(result).toEqual({ yesterdayConfirmed: true, lastConfirmedDate: '2026-07-07' });
  });

  it('Adyen-Daten vorhanden, gestern nicht bestätigt → false', () => {
    const result = tagesabschlussFromConfirmations({ '2026-07-05': { confirmed: true } }, true, TODAY);
    expect(result).toEqual({ yesterdayConfirmed: false, lastConfirmedDate: '2026-07-05' });
  });

  it('confirmed=false zählt nicht als Bestätigung; kaputte Keys werden ignoriert', () => {
    const result = tagesabschlussFromConfirmations(
      { '2026-07-07': { confirmed: false }, 'kaputt': { confirmed: true } },
      true,
      TODAY,
    );
    expect(result).toEqual({ yesterdayConfirmed: false, lastConfirmedDate: null });
  });
});

describe('Warnungen — nur echte Handlungsbedarfe', () => {
  it('mehrere action-Karten → Warnungen in Kartenreihenfolge mit Titel-Präfix', () => {
    const { warnings } = buildStartOverview({
      todayIso: TODAY,
      signals: { zbericht: EMPTY, reservationen: EMPTY, dienstplanung: EMPTY },
      tagesabschluss: { yesterdayConfirmed: false, lastConfirmedDate: null },
    });
    expect(warnings.map((w) => w.id)).toEqual(['umsatz', 'reservationen', 'dienstplan', 'tagesabschluss']);
    expect(warnings[0].text).toMatch(/^Umsatzimport: /);
    expect(warnings[3].text).toMatch(/^Tagesabschluss: /);
  });
});
