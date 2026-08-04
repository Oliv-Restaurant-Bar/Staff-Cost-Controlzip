// @vitest-environment happy-dom
// happy-dom (statt node), weil start-prefs → kpi-catalog → financial-metrics
// transitiv die P&L-Engine lädt, die den Supabase-Client (localStorage) beim
// Modul-Load braucht (gleiches Muster wie kpi-catalog.test.ts).
/**
 * Tests der neuen reinen Startseiten-Personalisierung:
 *  - start-prefs: Normalisierung (max. 4 Karten, unbekannte IDs, leere Auswahl
 *    ⇒ Defaults), Gast-Filter, moveItem.
 *  - start-widgets: Builder-Invarianten — fehlend/Fehler = «—» mit sichtbarem
 *    Grund (NIE stille 0), 0 nur bei echter 0 aus der Quelle, Gast ohne Link
 *    auf gastgesperrte Flächen.
 *  - kpi-targets: Union-Merge newer-wins, Tombstone statt Hard-Delete,
 *    Dirty-Check (identischer Wert = No-op), Leser filtern deleted.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultStartPrefs,
  moveItem,
  normalizeStartPrefs,
  MAX_KPI_CARDS,
} from '../start-prefs';
import {
  DEFAULT_HEUTE_WIDGET_IDS,
  buildKreditorenWidget,
  buildOffeneImporteWidget,
  buildPersonalausfaelleWidget,
  buildReservationenHeuteWidget,
  buildWarenrechnungenWidget,
  widgetFromStartCard,
} from '../start-widgets';
import type { StartCard } from '../start-overview-utils';
import type { TypeCompletion } from '../import-tasks-priority';
import {
  applyKpiTarget,
  getVisibleKpiTarget,
  mergeKpiTargets,
  normalizeKpiTargets,
  type KpiTargetsBlob,
} from '../kpi-targets';

// ─── start-prefs ─────────────────────────────────────────────────────────────

describe('start-prefs — Normalisierung & Defaults', () => {
  it('Defaults: 4 KPI-Karten (istKarte) und die 4 bisherigen Statuskarten-Widgets', () => {
    const d = defaultStartPrefs();
    expect(d.kpiCards).toEqual(['umsatz', 'warenquote', 'personalquote', 'ebit']);
    expect(d.heuteWidgets).toEqual([...DEFAULT_HEUTE_WIDGET_IDS]);
  });

  it('verwirft unbekannte IDs/Duplikate und kappt Karten auf MAX_KPI_CARDS', () => {
    const p = normalizeStartPrefs({
      kpiCards: ['umsatz', 'umsatz', 'quatsch', 'ebit', 'gaeste', 'warenquote', 'ebitda'],
      heuteWidgets: ['umsatz', 'nope', 'kreditoren'],
    });
    expect(p.kpiCards).toEqual(['umsatz', 'ebit', 'gaeste', 'warenquote']);
    expect(p.kpiCards.length).toBe(MAX_KPI_CARDS);
    expect(p.heuteWidgets).toEqual(['umsatz', 'kreditoren']);
  });

  it('leere/kaputte Auswahl ⇒ Defaults (nie eine leere Startseite)', () => {
    expect(normalizeStartPrefs(null)).toEqual(defaultStartPrefs());
    expect(normalizeStartPrefs({ kpiCards: [], heuteWidgets: [] })).toEqual(defaultStartPrefs());
    expect(normalizeStartPrefs({ kpiCards: ['nur-quatsch'] }).kpiCards).toEqual(defaultStartPrefs().kpiCards);
  });

  it('moveItem verschiebt immutable und klemmt an den Grenzen', () => {
    const l = ['a', 'b', 'c'];
    expect(moveItem(l, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(l, 0, -1)).toEqual(l);
    expect(moveItem(l, 2, 1)).toEqual(l);
    expect(l).toEqual(['a', 'b', 'c']);
  });
});

// ─── start-widgets ───────────────────────────────────────────────────────────

const CARD: StartCard = {
  id: 'umsatz',
  title: 'Umsatzimport',
  status: 'ok',
  statusLabel: 'Aktuell',
  detail: 'Aktuell – Ist-Daten bis 07.07.2026',
  route: '/gastronovi-import',
};

describe('start-widgets — Builder-Invarianten (fehlend ≠ 0)', () => {
  it('widgetFromStartCard übernimmt Status 1:1; hideRoute entfernt den Link (Gast)', () => {
    const w = widgetFromStartCard(CARD);
    expect(w.status).toBe('ok');
    expect(w.route).toBe('/gastronovi-import');
    expect(widgetFromStartCard(CARD, { hideRoute: true }).route).toBeNull();
  });

  it('offene Importe: null-Coverage ⇒ «—» + Fehlergrund; 0 nur bei echter 0', () => {
    const err = buildOffeneImporteWidget(null, 'Coverage kaputt');
    expect(err.value).toBe('—');
    expect(err.error).toBe('Coverage kaputt');
    const done: TypeCompletion[] = [
      { type: 'zbericht', label: 'Z-Bericht', status: 'done', detail: null },
    ];
    expect(buildOffeneImporteWidget(done, null).value).toBe('0');
    const open: TypeCompletion[] = [
      { type: 'zbericht', label: 'Z-Bericht', status: 'open', detail: null },
      { type: 'mirus', label: 'Mirus', status: 'error', detail: null },
    ];
    const w = buildOffeneImporteWidget(open, null);
    expect(w.value).toBe('2');
    expect(w.detail).toContain('1 offen');
    expect(w.detail).toContain('1 ohne Status');
  });

  it('Reservationen heute: PII-frei mit CRM-Link; Ladefehler sichtbar', () => {
    const admin = buildReservationenHeuteWidget({ count: 3, persons: 11 }, null);
    expect(admin.value).toBe('3');
    expect(admin.detail).toContain('11 Personen');
    expect(admin.route).toBe('/gaeste');
    const err = buildReservationenHeuteWidget(null, 'DB weg');
    expect(err.value).toBe('—');
    expect(err.error).toBe('DB weg');
  });

  it('Abwesenheiten: kein Dienstplan ⇒ «—» (NIE 0); geplanter Tag ohne Ausfälle ⇒ 0', () => {
    expect(buildPersonalausfaelleWidget({ dayPlanned: false, absenceCount: 0 }, null).value).toBe('—');
    expect(buildPersonalausfaelleWidget({ dayPlanned: true, absenceCount: 0 }, null).value).toBe('0');
    expect(buildPersonalausfaelleWidget({ dayPlanned: true, absenceCount: 2 }, null).value).toBe('2');
  });

  it('Warenrechnungen/Kreditoren: leere Quelle ⇒ «—» mit Grund, echte Werte formatiert', () => {
    expect(buildWarenrechnungenWidget({ count: 0, totalNet: 0 }, null, 'Juli 2026').value).toBe('—');
    expect(buildWarenrechnungenWidget({ count: 2, totalNet: 850 }, null, 'Juli 2026').value).toBe('CHF 850');
    expect(buildKreditorenWidget({ tableAvailable: false, latest: null }, null).value).toBe('—');
    expect(buildKreditorenWidget({ tableAvailable: true, latest: null }, null).detail).toContain('keine OP-Liste');
    const w = buildKreditorenWidget(
      { tableAvailable: true, latest: { snapshotDate: '2026-07-20', totalOpenAmount: 900, totalItems: 4 } },
      null,
    );
    expect(w.value).toBe('CHF 900');
    expect(w.detail).toContain('4 Posten');
  });
});

// ─── kpi-targets ─────────────────────────────────────────────────────────────

describe('kpi-targets — Merge, Tombstones, Dirty-Check', () => {
  it('normalizeKpiTargets verwirft kaputte Einträge, behält Tombstones', () => {
    const b = normalizeKpiTargets({
      warenquote: { value: 29, updatedAt: '2026-07-01T00:00:00Z' },
      kaputt1: { value: 'x', updatedAt: '2026-07-01T00:00:00Z' },
      kaputt2: { value: Infinity, updatedAt: '2026-07-01T00:00:00Z' },
      geloescht: { value: 0, updatedAt: '2026-07-02T00:00:00Z', deleted: true },
    });
    expect(Object.keys(b).sort()).toEqual(['geloescht', 'warenquote']);
    expect(b.geloescht.deleted).toBe(true);
  });

  it('mergeKpiTargets: Union, je KPI gewinnt der neuere Eintrag (auch Tombstones)', () => {
    const a: KpiTargetsBlob = {
      umsatz: { value: 100, updatedAt: '2026-07-01T00:00:00Z' },
      ebit: { value: 5, updatedAt: '2026-07-03T00:00:00Z' },
    };
    const b: KpiTargetsBlob = {
      umsatz: { value: 0, updatedAt: '2026-07-02T00:00:00Z', deleted: true },
      warenquote: { value: 29, updatedAt: '2026-07-01T00:00:00Z' },
    };
    const m = mergeKpiTargets(a, b);
    expect(m.umsatz.deleted).toBe(true); // neuerer Tombstone gewinnt
    expect(m.ebit.value).toBe(5);
    expect(m.warenquote.value).toBe(29);
  });

  it('applyKpiTarget: identischer Wert = No-op; Löschen = Tombstone; nicht-finite abgewiesen', () => {
    const t0 = applyKpiTarget({}, 'warenquote', 29, '2026-07-01T00:00:00Z', 'u1');
    expect(t0.changed).toBe(true);
    expect(t0.blob.warenquote.updatedBy).toBe('u1');

    const noop = applyKpiTarget(t0.blob, 'warenquote', 29, '2026-07-05T00:00:00Z');
    expect(noop.changed).toBe(false);
    expect(noop.blob.warenquote.updatedAt).toBe('2026-07-01T00:00:00Z'); // kein Bump

    expect(applyKpiTarget(t0.blob, 'warenquote', NaN, '2026-07-05T00:00:00Z').changed).toBe(false);

    const del = applyKpiTarget(t0.blob, 'warenquote', null, '2026-07-06T00:00:00Z');
    expect(del.changed).toBe(true);
    expect(del.blob.warenquote.deleted).toBe(true);
    expect(getVisibleKpiTarget(del.blob, 'warenquote')).toBeNull();

    // Löschen ohne sichtbaren Eintrag = No-op (kein sinnloser Tombstone)
    expect(applyKpiTarget(del.blob, 'warenquote', null, '2026-07-07T00:00:00Z').changed).toBe(false);
  });

  it('erneutes Setzen nach Tombstone reaktiviert den Zielwert', () => {
    const del: KpiTargetsBlob = { ebit: { value: 0, updatedAt: '2026-07-02T00:00:00Z', deleted: true } };
    const re = applyKpiTarget(del, 'ebit', 8, '2026-07-03T00:00:00Z');
    expect(re.changed).toBe(true);
    expect(getVisibleKpiTarget(re.blob, 'ebit')?.value).toBe(8);
  });
});
