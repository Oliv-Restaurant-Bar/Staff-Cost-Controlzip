import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';

export type SuggestionActionType = 'remove_all' | 'remove_spat' | 'remove_frueh';

export interface CorrectionSuggestion {
  id: string;
  employeeId: string;
  employeeName: string;
  badge: string;
  description: string;
  savingHours: number;
  savingCost: number;
  priority: number;
  actionType: SuggestionActionType;
  slotDisplay?: string;
}

const calcSlot = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

export function computeSuggestions(
  dateStr: string,
  employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  dismissedIds: string[],
  excessCostTarget: number,
): CorrectionSuggestion[] {
  const suggestions: CorrectionSuggestion[] = [];
  let accumulatedSaving = 0;

  const dismissed = new Set(dismissedIds);

  const candidates: Array<{
    emp: Employee;
    fH: number;
    sH: number;
    hasF: boolean;
    hasS: boolean;
    netH: number;
    cost: number;
    isAushilfe: boolean;
    isDoubleShift: boolean;
    ds: DaySchedule;
  }> = [];

  employees.forEach(emp => {
    const cellKey = `${emp.id}-${dateStr}`;
    const ds = scheduleData[cellKey];
    if (!ds) return;

    const fH = calcSlot(ds.früh);
    const sH = calcSlot(ds.spät);
    const hasF = fH > 0 && !ds.frühAbsence;
    const hasS = sH > 0 && !ds.spätAbsence;
    if (!hasF && !hasS) return;

    const gross = (hasF ? fH : 0) + (hasS ? sH : 0);
    const breakD = calculateBreakDeduction(gross);
    const netH = Math.max(0, gross - breakD);
    const wage = emp.hourlyWage || 0;
    const cost = netH * wage;

    const isAushilfe =
      emp.employmentType === 'aushilfe' || emp.id.startsWith('aush_');
    const isDoubleShift = hasF && hasS;

    candidates.push({ emp, fH, sH, hasF, hasS, netH, cost, isAushilfe, isDoubleShift, ds });
  });

  candidates.sort((a, b) => {
    const pa = a.isAushilfe ? 1 : a.isDoubleShift ? 2 : 3;
    const pb = b.isAushilfe ? 1 : b.isDoubleShift ? 2 : 3;
    if (pa !== pb) return pa - pb;
    return b.cost - a.cost;
  });

  for (const { emp, fH, sH, hasF, hasS, netH, cost, isAushilfe, isDoubleShift, ds } of candidates) {
    if (suggestions.length >= 5) break;
    if (accumulatedSaving >= excessCostTarget * 1.1) break;

    if (isAushilfe) {
      const id = `${emp.id}-${dateStr}-remove-all`;
      if (!dismissed.has(id)) {
        suggestions.push({
          id,
          employeeId: emp.id,
          employeeName: emp.name,
          badge: 'Aushilfe',
          description: `${emp.name} – Einsatz streichen`,
          savingHours: netH,
          savingCost: cost,
          priority: 1,
          actionType: 'remove_all',
          slotDisplay: buildSlotDisplay(hasF, hasS, ds),
        });
        accumulatedSaving += cost;
      }
    } else if (isDoubleShift) {
      const id = `${emp.id}-${dateStr}-remove-spat`;
      if (!dismissed.has(id)) {
        const spätCost = sH * (emp.hourlyWage || 0);
        suggestions.push({
          id,
          employeeId: emp.id,
          employeeName: emp.name,
          badge: 'Doppelschicht',
          description: `${emp.name} – Spätschicht streichen`,
          savingHours: sH,
          savingCost: spätCost,
          priority: 2,
          actionType: 'remove_spat',
          slotDisplay: ds.spät ? `${ds.spät.start}–${ds.spät.end}` : undefined,
        });
        accumulatedSaving += spätCost;
      }
    } else {
      const actionType: SuggestionActionType =
        hasS && !hasF ? 'remove_spat' : hasF && !hasS ? 'remove_frueh' : 'remove_all';
      const id = `${emp.id}-${dateStr}-${actionType}`;
      if (!dismissed.has(id)) {
        const label = hasS ? 'Spät' : 'Früh';
        suggestions.push({
          id,
          employeeId: emp.id,
          employeeName: emp.name,
          badge: `${label}schicht`,
          description: `${emp.name} – ${label}schicht streichen`,
          savingHours: netH,
          savingCost: cost,
          priority: 3,
          actionType,
          slotDisplay: buildSlotDisplay(hasF, hasS, ds),
        });
        accumulatedSaving += cost;
      }
    }
  }

  return suggestions;
}

function buildSlotDisplay(hasF: boolean, hasS: boolean, ds: DaySchedule): string {
  const parts: string[] = [];
  if (hasF && ds.früh) parts.push(`F: ${ds.früh.start}–${ds.früh.end}`);
  if (hasS && ds.spät) parts.push(`S: ${ds.spät.start}–${ds.spät.end}`);
  return parts.join(' | ');
}
