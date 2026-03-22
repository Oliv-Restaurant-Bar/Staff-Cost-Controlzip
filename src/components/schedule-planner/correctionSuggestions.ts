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

function buildSlotDisplay(hasF: boolean, hasS: boolean, ds: DaySchedule): string {
  const parts: string[] = [];
  if (hasF && ds.früh) parts.push(`F: ${ds.früh.start}–${ds.früh.end}`);
  if (hasS && ds.spät) parts.push(`S: ${ds.spät.start}–${ds.spät.end}`);
  return parts.join(' | ');
}

/**
 * Computes actionable correction suggestions for a given overplanned day.
 *
 * Strategy (descending priority):
 *  1. Aushilfe (temp worker) → suggest removing entire day entry
 *  2. Double-shift → suggest removing the costlier of the two slots
 *  3. Single shift → suggest removing it (highest cost first)
 *
 * There is NO accumulated-savings early exit: all qualifying employees are shown
 * so the planner can choose which corrections to apply. Dismissed suggestions
 * are filtered out.
 */
export function computeSuggestions(
  dateStr: string,
  employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  dismissedIds: string[],
  _excessCostTarget: number,   // kept for backward compatibility; not used for early exit
): CorrectionSuggestion[] {
  const dismissed = new Set(dismissedIds);

  type Candidate = {
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
  };

  const candidates: Candidate[] = [];

  employees.forEach(emp => {
    const ds = scheduleData[`${emp.id}-${dateStr}`];
    if (!ds) return;

    const fH = calcSlot(ds.früh);
    const sH = calcSlot(ds.spät);
    // Only count slots that have actual times AND are not marked as absences
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

  // Priority sort:
  //  tier 0 = Aushilfe  (easiest to remove)
  //  tier 1 = Doppelschicht  (remove one slot)
  //  tier 2 = single shift  (consider removing)
  // Within same tier: highest cost first; tie-break by hours
  candidates.sort((a, b) => {
    const ta = a.isAushilfe ? 0 : a.isDoubleShift ? 1 : 2;
    const tb = b.isAushilfe ? 0 : b.isDoubleShift ? 1 : 2;
    if (ta !== tb) return ta - tb;
    if (b.cost !== a.cost) return b.cost - a.cost;
    return b.netH - a.netH;
  });

  const suggestions: CorrectionSuggestion[] = [];

  for (const { emp, fH, sH, hasF, hasS, netH, cost, isAushilfe, isDoubleShift, ds } of candidates) {
    if (suggestions.length >= 8) break;

    if (isAushilfe) {
      // Suggest removing the entire entry
      const id = `${emp.id}-${dateStr}-remove-all`;
      if (!dismissed.has(id)) {
        suggestions.push({
          id,
          employeeId: emp.id,
          employeeName: emp.name,
          badge: 'Aushilfe',
          description: `${emp.name} – Aushilfe-Einsatz streichen`,
          savingHours: netH,
          savingCost: cost,
          priority: 1,
          actionType: 'remove_all',
          slotDisplay: buildSlotDisplay(hasF, hasS, ds),
        });
      }
    } else if (isDoubleShift) {
      // Remove the more expensive of the two slots
      const frühCost = fH * (emp.hourlyWage || 0);
      const spätCost = sH * (emp.hourlyWage || 0);

      if (spätCost >= frühCost) {
        const id = `${emp.id}-${dateStr}-remove-spat`;
        if (!dismissed.has(id)) {
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
            slotDisplay: ds.spät ? `S: ${ds.spät.start}–${ds.spät.end}` : buildSlotDisplay(false, hasS, ds),
          });
        }
      } else {
        const id = `${emp.id}-${dateStr}-remove-frueh`;
        if (!dismissed.has(id)) {
          suggestions.push({
            id,
            employeeId: emp.id,
            employeeName: emp.name,
            badge: 'Doppelschicht',
            description: `${emp.name} – Frühschicht streichen`,
            savingHours: fH,
            savingCost: frühCost,
            priority: 2,
            actionType: 'remove_frueh',
            slotDisplay: ds.früh ? `F: ${ds.früh.start}–${ds.früh.end}` : buildSlotDisplay(hasF, false, ds),
          });
        }
      }
    } else {
      // Single shift – suggest removing it
      const actionType: SuggestionActionType = hasS ? 'remove_spat' : 'remove_frueh';
      const label = hasS ? 'Spät' : 'Früh';
      const id = `${emp.id}-${dateStr}-${actionType}`;
      if (!dismissed.has(id)) {
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
      }
    }
  }

  return suggestions;
}
