// @vitest-environment node
/**
 * Tests für die Import-Center-Gruppierung (import-groups.ts). Fixiert:
 *   - 4 Gruppen in fester Reihenfolge mit gültigen Cockpit-Quellen
 *   - Status kommt 1:1 aus computeSourceStatus (KEINE eigenen Schwellen):
 *     daily current ≤1 Tag, due_soon ≤3 Tage, darüber overdue → action
 *   - Gruppenstatus = schlechtester Mitglieds-Status
 *   - „Letzter Import" = spätester Datenstand über alle Mitglieder
 */

import { describe, it, expect } from 'vitest';
import type { CockpitSignal, CockpitSourceId } from '@/lib/import-cockpit';
import { IMPORT_GROUPS, buildImportGroupOverviews } from '@/lib/import-groups';

const NOW = new Date('2026-07-08T12:00:00');

function sig(latestDataDate: string | null, extra: Partial<CockpitSignal> = {}): CockpitSignal {
  return { latestDataDate, ...extra };
}

describe('IMPORT_GROUPS — Struktur', () => {
  it('enthält genau die 4 Gruppen in Anzeige-Reihenfolge', () => {
    expect(IMPORT_GROUPS.map((g) => g.id)).toEqual([
      'umsatz',
      'reservationen',
      'arbeitszeiten',
      'tagesabschluss',
    ]);
  });

  it('jede Gruppe hat entweder eine Start-Route oder einen Sektions-Anker', () => {
    for (const g of IMPORT_GROUPS) {
      expect(Boolean(g.startRoute) !== Boolean(g.startAnchor)).toBe(true);
    }
  });

  it('Arbeitszeiten öffnet die Inline-Sektion (Anker), Tagesabschluss die Seite', () => {
    const az = IMPORT_GROUPS.find((g) => g.id === 'arbeitszeiten')!;
    expect(az.startAnchor).toBe('ist-stunden');
    const ta = IMPORT_GROUPS.find((g) => g.id === 'tagesabschluss')!;
    expect(ta.startRoute).toBe('/tagesabschluesse');
  });

  it('alle Quellen-IDs existieren im Cockpit (buildImportGroupOverviews wirft nicht)', () => {
    expect(() => buildImportGroupOverviews({}, NOW)).not.toThrow();
  });
});

describe('buildImportGroupOverviews — Status aus computeSourceStatus', () => {
  it('ohne Signale → alle Gruppen „Handlungsbedarf" (nie importiert), kein letzter Import', () => {
    const groups = buildImportGroupOverviews({}, NOW);
    for (const g of groups) {
      expect(g.status).toBe('action');
      expect(g.detail).toContain('Noch nie importiert');
      expect(g.lastImportText).toBeNull();
    }
  });

  it('daily-Quelle 1 Tag hinten → ok (Cockpit-Schwelle current ≤ 1 Tag)', () => {
    const groups = buildImportGroupOverviews(
      { zbericht: sig('2026-07-07'), tagesumsatz: sig('2026-07-07') },
      NOW,
    );
    const umsatz = groups.find((g) => g.def.id === 'umsatz')!;
    expect(umsatz.status).toBe('ok');
    expect(umsatz.statusLabel).toBe('Aktuell');
  });

  it('daily-Quelle 2 Tage hinten → due_soon (Cockpit-Schwelle ≤ 3 Tage)', () => {
    const groups = buildImportGroupOverviews(
      { zbericht: sig('2026-07-06'), tagesumsatz: sig('2026-07-07') },
      NOW,
    );
    const umsatz = groups.find((g) => g.def.id === 'umsatz')!;
    expect(umsatz.status).toBe('due_soon');
    expect(umsatz.detail).toContain('Gastronovi Z-Bericht:');
  });

  it('daily-Quelle 5 Tage hinten → action (overdue), schlechtester Status gewinnt', () => {
    const groups = buildImportGroupOverviews(
      { zbericht: sig('2026-07-08'), tagesumsatz: sig('2026-07-03') },
      NOW,
    );
    const umsatz = groups.find((g) => g.def.id === 'umsatz')!;
    expect(umsatz.status).toBe('action');
    expect(umsatz.detail).toContain('Tagesumsatz:');
  });

  it('monatliche Quellen (Tagesabschluss-Gruppe) sind mit Monats-Frische ok', () => {
    const groups = buildImportGroupOverviews(
      { adyen: sig('2026-06-30'), umsatzabstimmung: sig('2026-06') },
      NOW,
    );
    const ta = groups.find((g) => g.def.id === 'tagesabschluss')!;
    expect(ta.status).toBe('ok');
  });
});

describe('buildImportGroupOverviews — Letzter Import & Mitglieder', () => {
  it('„Letzter Import" = spätester Datenstand (dataUntil vor latestDataDate)', () => {
    const groups = buildImportGroupOverviews(
      {
        reservationen: sig('2026-07-01', { dataUntil: '2026-07-10' }),
        gaeste_crm: sig('2026-07-05'),
      },
      NOW,
    );
    const res = groups.find((g) => g.def.id === 'reservationen')!;
    expect(res.lastImportText).toBe('10.07.2026');
  });

  it('liefert je Mitglied Label, Status und Route für die Aufklapp-Details', () => {
    const groups = buildImportGroupOverviews({ mirus: sig('2026-07-07') }, NOW);
    const az = groups.find((g) => g.def.id === 'arbeitszeiten')!;
    expect(az.members).toHaveLength(1);
    expect(az.members[0].label).toBe('Mirus Arbeitszeiten');
    expect(az.members[0].statusLabel).toBeTruthy();
  });

  it('Quellen-IDs der Gruppen sind eindeutig (keine Quelle in zwei Gruppen)', () => {
    const all: CockpitSourceId[] = IMPORT_GROUPS.flatMap((g) => g.sourceIds);
    expect(new Set(all).size).toBe(all.length);
  });
});
