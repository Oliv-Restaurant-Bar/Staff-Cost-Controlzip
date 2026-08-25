function parseIsoLocal(value: string): Date {
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
}

function isoLocal(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function mondayOf(date: Date): Date {
  const result = new Date(date);
  const weekday = result.getDay() === 0 ? 7 : result.getDay();
  result.setDate(result.getDate() - weekday + 1);
  return result;
}

/**
 * Calendar-week source of truth used by the Cockpit and Flex evaluation.
 * Current period: the Monday-Sunday week immediately before the current week.
 * Past period: the final Monday-Sunday week ending no later than period end.
 * Future period: no completed week.
 */
export function getLastCompletedWeekRange(
  periodFromIso: string,
  periodToIso: string,
  todayIso: string,
): { from: string; to: string } | null {
  if (periodFromIso > todayIso) return null;

  const today = parseIsoLocal(todayIso);
  let from: Date;
  let to: Date;

  if (todayIso >= periodFromIso && todayIso <= periodToIso) {
    const thisMonday = mondayOf(today);
    from = new Date(thisMonday);
    from.setDate(from.getDate() - 7);
    to = new Date(thisMonday);
    to.setDate(to.getDate() - 1);
  } else {
    const periodEnd = parseIsoLocal(periodToIso);
    to = new Date(periodEnd);
    to.setDate(to.getDate() - (periodEnd.getDay() % 7));
    from = new Date(to);
    from.setDate(from.getDate() - 6);
  }

  return { from: isoLocal(from), to: isoLocal(to) };
}