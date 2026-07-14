// @vitest-environment happy-dom
/**
 * Tests für das Pause-Routing beim Split-Schicht-Commit in TimeInputCell.
 *
 * Kernregel: Die Pausen folgen den ZEITEN, nicht dem Slot-Mapping —
 * "Pause 1. Einsatz" (Row 1) gehört immer zum früh-Slot, "Pause 2. Einsatz"
 * (Row 2) immer zum spät-Slot. Das gilt auch im vertauschten Fall
 * slotType==='spät' (leere Zelle: primarySlot='spät', secondary='früh').
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { TimeInputCell } from '../TimeInputCell';

vi.mock('@/hooks/useShiftConfig', () => ({
  useShiftConfig: () => ({ shiftMap: {}, absenceShifts: [], workShifts: [] }),
}));

vi.mock('@/hooks/useQuickTimes', () => ({
  useQuickTimes: () => ({
    presets: [],
    addPreset: vi.fn(),
    updatePreset: vi.fn(),
    deletePreset: vi.fn(),
    movePreset: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
  DEFAULT_QUICK_PRESETS: [],
}));

afterEach(() => cleanup());

type Setup = {
  onChange: ReturnType<typeof vi.fn>;
  onSplitTimeSelect: ReturnType<typeof vi.fn>;
  onBreakMinutesChange: ReturnType<typeof vi.fn>;
  onSecondaryBreakMinutesChange: ReturnType<typeof vi.fn>;
};

function setup(
  slotType: 'früh' | 'spät',
  extraProps: Record<string, unknown> = {},
): Setup {
  const onChange = vi.fn();
  const onSplitTimeSelect = vi.fn();
  const onBreakMinutesChange = vi.fn();
  const onSecondaryBreakMinutesChange = vi.fn();
  const { container } = render(
    <TimeInputCell
      value={null}
      slotType={slotType}
      onChange={onChange}
      onSplitTimeSelect={onSplitTimeSelect}
      onBreakMinutesChange={onBreakMinutesChange}
      onSecondaryBreakMinutesChange={onSecondaryBreakMinutesChange}
      {...extraProps}
    />,
  );
  // Popover öffnen (Zellen-Button = erster Button)
  const trigger = container.querySelector('button');
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  return { onChange, onSplitTimeSelect, onBreakMinutesChange, onSecondaryBreakMinutesChange };
}

function typeTimes(s1: string, e1: string, s2: string, e2: string) {
  const starts = screen.getAllByPlaceholderText('Von 10:00');
  const ends = screen.getAllByPlaceholderText('Bis 23:00');
  expect(starts.length).toBe(2);
  expect(ends.length).toBe(2);
  fireEvent.change(starts[0], { target: { value: s1 } });
  fireEvent.change(ends[0], { target: { value: e1 } });
  fireEvent.change(starts[1], { target: { value: s2 } });
  fireEvent.change(ends[1], { target: { value: e2 } });
}

function pickBreak(groupLabel: string, optionLabel: string) {
  const group = screen.getByRole('radiogroup', { name: groupLabel });
  fireEvent.click(within(group).getByRole('radio', { name: optionLabel }));
}

function commit() {
  fireEvent.click(screen.getByText('Übernehmen'));
}

describe('TimeInputCell Split-Commit: Pause-Routing folgt den Zeiten', () => {
  it('leere Zelle (slotType=spät): Pause 1→früh (Row 1), Pause 2→spät (Row 2) — nie vertauscht', () => {
    const { onChange, onSplitTimeSelect } = setup('spät');

    typeTimes('10:00', '14:00', '17:30', '23:00');
    // Radiogruppe "2. Einsatz" muss schon bei frisch eingetippten Zeiten da sein
    pickBreak('Pause 1. Einsatz', 'Keine');
    pickBreak('Pause 2. Einsatz', '30 Min');
    commit();

    // secondary-Callback → früh-Slot: Row-1-Zeiten + "Pause 1. Einsatz" (0)
    expect(onSplitTimeSelect).toHaveBeenCalledTimes(1);
    expect(onSplitTimeSelect).toHaveBeenCalledWith({ start: '10:00', end: '14:00' }, 0);
    // onChange → spät-Slot (primary): Row-2-Zeiten + "Pause 2. Einsatz" (30)
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ start: '17:30', end: '23:00' }, null, 30);
  });

  it('bestehende Zelle (slotType=früh): Pause 1→onChange/früh, Pause 2→onSplitTimeSelect/spät', () => {
    const { onChange, onSplitTimeSelect } = setup('früh', {
      value: { start: '10:00', end: '14:00' },
      secondaryValue: { start: '17:30', end: '23:00' },
    });

    pickBreak('Pause 1. Einsatz', 'Keine');
    pickBreak('Pause 2. Einsatz', '30 Min');
    commit();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ start: '10:00', end: '14:00' }, null, 0);
    expect(onSplitTimeSelect).toHaveBeenCalledTimes(1);
    expect(onSplitTimeSelect).toHaveBeenCalledWith({ start: '17:30', end: '23:00' }, 30);
  });

  it('kein Doppel-Flush: nach dem Commit feuern die Break-Flush-Callbacks beim Schliessen nicht mehr', () => {
    const { onBreakMinutesChange, onSecondaryBreakMinutesChange } = setup('spät');

    typeTimes('10:00', '14:00', '17:30', '23:00');
    pickBreak('Pause 1. Einsatz', 'Keine');
    pickBreak('Pause 2. Einsatz', '30 Min');
    commit();

    // Popover schliessen (Escape) → flushBreakMinutes läuft, darf aber nichts senden
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onBreakMinutesChange).not.toHaveBeenCalled();
    expect(onSecondaryBreakMinutesChange).not.toHaveBeenCalled();
  });

  it('unberührte Pausen: Commit übergibt undefined (Pause unverändert lassen)', () => {
    const { onChange, onSplitTimeSelect } = setup('spät');

    typeTimes('10:00', '14:00', '17:30', '23:00');
    commit();

    expect(onSplitTimeSelect).toHaveBeenCalledWith({ start: '10:00', end: '14:00' }, undefined);
    expect(onChange).toHaveBeenCalledWith({ start: '17:30', end: '23:00' }, null, undefined);
  });
});
