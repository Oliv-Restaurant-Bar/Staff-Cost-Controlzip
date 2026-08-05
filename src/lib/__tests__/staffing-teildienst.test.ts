// @vitest-environment node
// Teildienst (geteilte Schicht, meta.splitGroup): rein präsentationale
// Gruppierung — Kopfzahl-Logik (max(Mittag, Abend)) bleibt unverändert.
import { describe, it, expect } from 'vitest';
import {
  groupShiftUnits,
  defaultSplitShiftDrafts,
  splitGroupOfMeta,
  formatShiftTimes,
  type ShiftDraft,
} from '@/lib/staffing-requirements-utils';
import { buildCellSaveDrafts, computeWeekCell, normalizeSplitGroups } from '@/lib/staffing-week-utils';
import type { StaffingRequirement } from '@/types/staffing';

function req(partial: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: 'r1',
    scopeType: 'weekly',
    season: 'standard',
    weekday: 1,
    scopeRef: null,
    positionKey: 'service',
    shiftStart: '11:00',
    shiftEnd: '22:00',
    requiredCount: 1,
    sortOrder: 0,
    meta: {},
    ...partial,
  } as StaffingRequirement;
}

describe('groupShiftUnits', () => {
  it('gruppiert Blöcke mit gemeinsamer splitGroup zu EINER Einheit (chronologisch)', () => {
    const drafts: ShiftDraft[] = [
      { shiftStart: '17:00', shiftEnd: '22:30', requiredCount: 1, splitGroup: 'g1' },
      { shiftStart: '11:00', shiftEnd: '15:00', requiredCount: 2 },
      { shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1, splitGroup: 'g1' },
    ];
    const units = groupShiftUnits(drafts);
    expect(units).toHaveLength(2);
    expect(units[0].split).toBe(true);
    // chronologisch: Mittag (Index 2) vor Abend (Index 0)
    expect(units[0].indices).toEqual([2, 0]);
    expect(units[1]).toEqual({ split: false, indices: [1] });
  });

  it('splitGroup mit nur einem Block zählt defensiv als Einzelblock', () => {
    const lone: ShiftDraft[] = [
      { shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1, splitGroup: 'einsam' },
    ];
    const units = groupShiftUnits(lone);
    expect(units).toEqual([{ split: false, indices: [0] }]);
  });

  it('defaultSplitShiftDrafts liefert zwei Blöcke mit gemeinsamer, frischer Gruppe', () => {
    const [a, b] = defaultSplitShiftDrafts();
    expect(a.splitGroup).toBeTruthy();
    expect(a.splitGroup).toBe(b.splitGroup);
    const [c] = defaultSplitShiftDrafts();
    expect(c.splitGroup).not.toBe(a.splitGroup);
  });

  it('formatShiftTimes nutzt den «/»-Trenner', () => {
    expect(formatShiftTimes([
      { start: '10:00', end: '14:00' },
      { start: '17:00', end: '22:30' },
    ])).toBe('10:00–14:00 / 17:00–22:30');
  });

  it('splitGroupOfMeta liest nur nicht-leere Strings', () => {
    expect(splitGroupOfMeta({ splitGroup: 'x' })).toBe('x');
    expect(splitGroupOfMeta({ splitGroup: '' })).toBeNull();
    expect(splitGroupOfMeta({})).toBeNull();
    expect(splitGroupOfMeta(null)).toBeNull();
  });
});

describe('buildCellSaveDrafts × splitGroup', () => {
  it('schreibt splitGroup in meta und erhält übriges meta per id', () => {
    const existing = [
      req({ id: 'a', shiftStart: '10:00', shiftEnd: '14:00', meta: { dayHeadcount: 3 } }),
    ];
    const drafts = buildCellSaveDrafts({
      existing, season: 'standard', weekday: 1, positionKey: 'service', part: 'day',
      partDrafts: [
        { id: 'a', shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1, splitGroup: 'g1' },
        { shiftStart: '17:00', shiftEnd: '22:30', requiredCount: 1, splitGroup: 'g1' },
      ],
    });
    const mine = drafts.filter((d) => d.positionKey === 'service');
    expect(mine).toHaveLength(2);
    expect(mine[0].meta.splitGroup).toBe('g1');
    expect(mine[1].meta.splitGroup).toBe('g1');
    // übriges meta bleibt erhalten
    expect(mine[0].meta.dayHeadcount).toBe(3);
  });

  it('entfernt splitGroup aus meta, wenn der Draft keinen mehr trägt', () => {
    const existing = [
      req({ id: 'a', shiftStart: '10:00', shiftEnd: '14:00', meta: { splitGroup: 'alt' } }),
    ];
    const drafts = buildCellSaveDrafts({
      existing, season: 'standard', weekday: 1, positionKey: 'service', part: 'day',
      partDrafts: [{ id: 'a', shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1 }],
    });
    const mine = drafts.filter((d) => d.positionKey === 'service');
    expect(mine[0].meta.splitGroup).toBeUndefined();
  });
});

describe('Teildienst-Integrität (normalizeSplitGroups)', () => {
  it('Teil-Edit einer Tageshälfte löst die verwaiste Partner-Hälfte auf', () => {
    const existing = [
      req({ id: 'm', shiftStart: '10:00', shiftEnd: '14:00', meta: { splitGroup: 'g1' } }),
      req({ id: 'a', shiftStart: '17:00', shiftEnd: '22:30', meta: { splitGroup: 'g1' } }),
    ];
    // Mittag-Hälfte wird OHNE den Teildienst-Block neu gespeichert …
    const drafts = buildCellSaveDrafts({
      existing, season: 'standard', weekday: 1, positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '11:00', shiftEnd: '15:00', requiredCount: 1 }],
    });
    // … die erhaltene Abend-Hälfte darf keine verwaiste splitGroup behalten.
    const abend = drafts.find((d) => d.id === 'a');
    expect(abend?.meta.splitGroup).toBeUndefined();
  });

  it('ungültige Gruppen (ungleiche Anzahl, gleiche Tageshälfte, 3+ Blöcke) werden gelöst', () => {
    const unequal = normalizeSplitGroups([
      req({ id: 'x', shiftStart: '10:00', requiredCount: 1, meta: { splitGroup: 'g' } }),
      req({ id: 'y', shiftStart: '17:00', requiredCount: 2, meta: { splitGroup: 'g' } }),
    ]);
    expect(unequal.every((r) => r.meta.splitGroup === undefined)).toBe(true);

    const sameHalf = normalizeSplitGroups([
      req({ id: 'x', shiftStart: '10:00', meta: { splitGroup: 'g' } }),
      req({ id: 'y', shiftStart: '11:00', meta: { splitGroup: 'g' } }),
    ]);
    expect(sameHalf.every((r) => r.meta.splitGroup === undefined)).toBe(true);

    const triple = normalizeSplitGroups([
      req({ id: 'x', shiftStart: '10:00', meta: { splitGroup: 'g' } }),
      req({ id: 'y', shiftStart: '17:00', meta: { splitGroup: 'g' } }),
      req({ id: 'z', shiftStart: '18:00', meta: { splitGroup: 'g' } }),
    ]);
    expect(triple.every((r) => r.meta.splitGroup === undefined)).toBe(true);

    // gültige Gruppe bleibt unangetastet (inkl. übriges meta)
    const ok = normalizeSplitGroups([
      req({ id: 'x', shiftStart: '10:00', meta: { splitGroup: 'g', dayHeadcount: 2 } }),
      req({ id: 'y', shiftStart: '17:00', meta: { splitGroup: 'g' } }),
    ]);
    expect(ok[0].meta.splitGroup).toBe('g');
    expect(ok[0].meta.dayHeadcount).toBe(2);
  });

  it('groupShiftUnits zeigt 3+-Mitglieder-Gruppen als Einzelblöcke (nichts versteckt)', () => {
    const drafts: ShiftDraft[] = [
      { shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1, splitGroup: 'g' },
      { shiftStart: '17:00', shiftEnd: '20:00', requiredCount: 1, splitGroup: 'g' },
      { shiftStart: '20:00', shiftEnd: '23:00', requiredCount: 1, splitGroup: 'g' },
    ];
    const units = groupShiftUnits(drafts);
    expect(units).toHaveLength(3);
    expect(units.every((u) => !u.split)).toBe(true);
  });
});

describe('Kopfzahl bleibt unverändert (Teildienst = 1 Kopf via max(M, A))', () => {
  it('Teildienst-Paar zählt 1 Kopf, splitGroup landet in cell.shifts', () => {
    const rows = [
      req({ id: 'a', shiftStart: '10:00', shiftEnd: '14:00', meta: { splitGroup: 'g1' } }),
      req({ id: 'b', shiftStart: '17:00', shiftEnd: '22:30', meta: { splitGroup: 'g1' } }),
    ];
    const cell = computeWeekCell(rows);
    expect(cell.mittag).toBe(1);
    expect(cell.abend).toBe(1);
    expect(cell.headcount).toBe(1);
    expect(cell.shifts.map((s) => s.splitGroup)).toEqual(['g1', 'g1']);
  });
});
