// @vitest-environment node
/**
 * T510 — Datenstand-Zeilen: Deep-Links zur richtigen Arbeitsfläche.
 * Die hrefs kommen 1:1 aus buildImportTarget(buildFullMonthTask(...)) —
 * hier wird die Verdrahtung in buildDatenstandRows fixiert (kein Duplikat
 * der Routen-Logik, sondern Vergleich gegen die SSoT-Funktion selbst plus
 * fachliche Erwartung an Pfad und Params).
 */

import { describe, it, expect } from 'vitest';
import {
  buildFullMonthTask,
  buildImportTarget,
  TASK_TYPE_DEFS,
  type ImportTaskType,
} from '@/lib/import-tasks-engine';
import type { TypeCompletion } from '@/lib/import-tasks-priority';
import { buildDatenstandRows } from '@/lib/start-overview-utils';

const PERIOD = { year: 2026, month: 7 };

function completion(
  type: ImportTaskType,
  status: TypeCompletion['status'] = 'open',
): TypeCompletion {
  const def = TASK_TYPE_DEFS.find((d) => d.type === type)!;
  return { type, label: def.label, status, detail: null };
}

function rowFor(type: ImportTaskType, status: TypeCompletion['status'] = 'open') {
  const rows = buildDatenstandRows([completion(type, status)], {
    period: PERIOD,
    isGuest: false,
  });
  return rows[0];
}

describe('T510 — Datenstand-Deep-Links je Importtyp', () => {
  it('Z-Bericht führt zum Gastronovi-Import (Monats-Prefill)', () => {
    const row = rowFor('zbericht');
    expect(row.href).toBe(buildImportTarget(buildFullMonthTask('zbericht', PERIOD)).href);
    expect(row.href).toContain('/gastronovi-import?');
    expect(row.href).toContain('from=2026-07-01');
    expect(row.href).toContain('to=2026-07-31');
  });

  it('Reservationen führen zum Foratable-Import', () => {
    const row = rowFor('reservationen');
    expect(row.href).toContain('/foratable-import?');
    expect(row.href).toContain('from=2026-07-01');
  });

  it('Umsatz führt zum Import-Center mit target=tagesumsatz', () => {
    const row = rowFor('umsatz');
    expect(row.href).toContain('/import?');
    expect(row.href).toContain('target=tagesumsatz');
  });

  it('Verkaufsdaten führen zum Sales-Upload', () => {
    const row = rowFor('verkaufsdaten');
    expect(row.href).toContain('/sales-upload?');
  });

  it('Mirus Stunden führen zum Import-Center mit target=mirus', () => {
    const row = rowFor('mirus');
    expect(row.href).toContain('/import?');
    expect(row.href).toContain('target=mirus');
  });

  it('Marketing Umsatz führt zum Import-Center mit target=maison', () => {
    const row = rowFor('marketing');
    expect(row.href).toContain('/import?');
    expect(row.href).toContain('target=maison');
  });

  it('Erfolgsrechnung und Istkosten führen zum Reporting mit Jahr+Monat', () => {
    const er = rowFor('erfolgsrechnung');
    expect(er.href).toContain('/reporting?');
    expect(er.href).toContain('target=erfolgsrechnung');
    expect(er.href).toContain('year=2026');
    expect(er.href).toContain('month=7');
    const ik = rowFor('istkosten');
    expect(ik.href).toContain('/reporting?');
    expect(ik.href).toContain('target=istkosten');
  });

  it('Budget führt zur Budget-Seite mit Jahr', () => {
    const row = rowFor('budget');
    expect(row.href).toContain('/budget?');
    expect(row.href).toContain('year=2026');
  });
});

describe('T510 — Interaktivität und Gating', () => {
  it('jede Zeile trägt den href selbst (ganze Zeile interaktiv, kein Sub-Button)', () => {
    const rows = buildDatenstandRows(
      TASK_TYPE_DEFS.map((d) => completion(d.type, 'open')),
      { period: PERIOD, isGuest: false },
    );
    for (const row of rows) {
      expect(row.href).toBeTruthy();
      expect(row.href).toBe(buildImportTarget(buildFullMonthTask(row.type, PERIOD)).href);
    }
  });

  it('auch „Vollständig"- und „Noch nicht fällig"-Zeilen bleiben verlinkt (Nachimport möglich)', () => {
    expect(rowFor('zbericht', 'done').href).toContain('/gastronovi-import?');
    expect(rowFor('umsatz', 'later').href).toContain('target=tagesumsatz');
  });

  it('Fehler-Zeilen verweisen auf das Import-Cockpit', () => {
    expect(rowFor('zbericht', 'error').href).toBe('/import-cockpit');
  });

  it('Gast-Session: keine Zeile ist verlinkt (Import-/Schreibflächen gesperrt)', () => {
    const rows = buildDatenstandRows(
      TASK_TYPE_DEFS.map((d) => completion(d.type, 'open')),
      { period: PERIOD, isGuest: true },
    );
    expect(rows.every((r) => r.href === null)).toBe(true);
  });

  it('ohne Monats-Kontext gibt es keine Links (nie geratene Ziel-Params)', () => {
    const rows = buildDatenstandRows([completion('zbericht')], {});
    expect(rows[0].href).toBeNull();
  });

  it('Ziel-Params übernehmen exakt den übergebenen Monat (Dezember → 12/31.12.)', () => {
    const rows = buildDatenstandRows([completion('zbericht')], {
      period: { year: 2024, month: 12 },
      isGuest: false,
    });
    expect(rows[0].href).toContain('from=2024-12-01');
    expect(rows[0].href).toContain('to=2024-12-31');
  });

  it('Statustexte bleiben unverändert (reine Umformatierung, keine neue Statuslogik)', () => {
    expect(rowFor('zbericht', 'done').text).toBe('Vollständig');
    expect(rowFor('zbericht', 'later').text).toBe('Noch nicht fällig');
    expect(rowFor('zbericht', 'error').text).toBe('Status konnte nicht ermittelt werden');
    expect(rowFor('zbericht', 'open').text).toBe('Fehlt noch');
  });

  it('läuft ohne DOM/localStorage (Node-Umgebung) — die Ableitung ist rein und schreibt nie', () => {
    // In der Node-Umgebung existiert kein localStorage/window: Würde die
    // Ableitung irgendetwas persistieren oder lesen, würfe dieser Aufruf.
    expect(() =>
      buildDatenstandRows(
        TASK_TYPE_DEFS.map((d) => completion(d.type, 'open')),
        { period: PERIOD, isGuest: false },
      ),
    ).not.toThrow();
    expect(typeof globalThis.localStorage).toBe('undefined');
  });
});
