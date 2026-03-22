/**
 * StaffingStatusBar
 * ─────────────────────────────────────────────────────────────────────────────
 * Compact per-day staffing status row shown above each dept grid.
 * Shows colored Früh/Spät badges for each visible day.
 */

import { useMemo } from 'react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { Department } from '@/types/personnel';
import { DaySchedule } from './ScheduleGrid';
import {
  StaffingTarget,
  computeStaffingStatus,
  StaffingStatusLevel,
  STATUS_CLASSES,
  STATUS_ICON,
  statusLabel,
} from '@/lib/staffing-targets';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  targets:      StaffingTarget[];
  employees:    Employee[];
  scheduleData: Record<string, DaySchedule>;
  displayDays:  Date[];
  department:   Department;
}

// ─── Einzelne Badge-Zelle ─────────────────────────────────────────────────────

function SlotBadge({
  actual, status, slot, title,
}: {
  actual:  number;
  status:  StaffingStatusLevel;
  slot:    'F' | 'S';
  title:   string;
}) {
  if (status === 'unconfigured') return null; // hide if no target set

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-0.5 px-1 py-0.5 rounded border text-[10px] font-bold leading-none cursor-default',
        STATUS_CLASSES[status],
      )}
    >
      <span className="opacity-60 text-[8px]">{slot}</span>
      {actual}
      <span className="text-[8px]">{STATUS_ICON[status]}</span>
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export function StaffingStatusBar({
  targets, employees, scheduleData, displayDays, department,
}: Props) {
  // Pre-compute statuses for all days × 2 slots
  const statuses = useMemo(() => {
    return displayDays.map(day => {
      const früh = computeStaffingStatus(targets, employees, scheduleData, day, department, 'früh');
      const spät = computeStaffingStatus(targets, employees, scheduleData, day, department, 'spät');
      return { day, früh, spät };
    });
  }, [targets, employees, scheduleData, displayDays, department]);

  // If no targets configured for this dept at all, don't render the bar
  const hasAnyTarget = targets.some(t => t.department === department);
  if (!hasAnyTarget) return null;

  const deptLabel = department === 'service' ? 'Service' : 'Küche';

  return (
    <div className="flex items-center gap-0 border-b border-border bg-muted/20">
      {/* Left label cell — must match the employee-name column width */}
      <div
        className="shrink-0 flex items-center px-3 py-1"
        style={{ width: 220, minWidth: 160 }}
      >
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Besetzung {deptLabel}
        </span>
      </div>

      {/* Day cells */}
      {statuses.map(({ day, früh, spät }) => {
        const hasAny = früh.status !== 'unconfigured' || spät.status !== 'unconfigured';
        const hasAlert =
          früh.status === 'under' || spät.status === 'under' ||
          früh.status === 'over'  || spät.status === 'over';

        return (
          <div
            key={format(day, 'yyyy-MM-dd')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 py-1 px-1 min-w-0',
              hasAlert ? 'bg-transparent' : '',
            )}
          >
            {hasAny ? (
              <>
                <SlotBadge
                  actual={früh.actual}
                  status={früh.status}
                  slot="F"
                  title={statusLabel(früh, 'früh', department)}
                />
                <SlotBadge
                  actual={spät.actual}
                  status={spät.status}
                  slot="S"
                  title={statusLabel(spät, 'spät', department)}
                />
              </>
            ) : (
              <span className="text-[10px] text-muted-foreground/30">–</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
