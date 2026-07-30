/**
 * Balkendiagramm «Personal pro Tag» des Personalbedarfs (Service + Küche,
 * Mo–So, gestapelt). Die früheren Kennzahlen-Kacheln (Personentage/Spitzentage)
 * wurden durch die Vergleichs-Kacheln in StaffingWeekCompare ersetzt; dieses
 * Diagramm steht unterhalb der Vergleichstabellen.
 *
 * Werte kommen aus dem AKTIVEN Profil (buildWeekOverview → effektiver Bedarf
 * inkl. UG-Zuschlag bei Winter/UG), pro Mandant. Reine Anzeige, keine Writes.
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import type { WeekOverview } from '@/lib/staffing-week-utils';

const WEEKDAY_SHORT: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
};

const SERVICE_COLOR = 'hsl(24 90% 55%)';   // warmes Orange (Service)
const KUECHE_COLOR = 'hsl(200 70% 45%)';   // Blau (Küche)

/**
 * KOPFZAHL je Abteilung × Wochentag aus der Wochenübersicht aufsummieren —
 * eine Person zählt 1× pro Tag (cell.headcount), Blöcke werden nie summiert.
 */
export function summarizeWeekOverview(overview: WeekOverview) {
  const byDay: { weekday: number; tag: string; service: number; kueche: number }[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    let service = 0;
    let kueche = 0;
    for (const dep of overview.groups) {
      let sum = 0;
      for (const area of dep.areas) {
        for (const pos of area.positions) {
          const c = pos.cells[wd];
          if (c) sum += c.headcount;
        }
      }
      if (dep.department === 'service') service += sum;
      else kueche += sum;
    }
    byDay.push({ weekday: wd, tag: WEEKDAY_SHORT[wd], service, kueche });
  }
  const personDays = byDay.reduce((s, d) => s + d.service + d.kueche, 0);
  const nettoHours = Object.values(overview.totals).reduce((s, t) => s + t.nettoHours, 0);
  const maxPersons = Math.max(...byDay.map((d) => d.service + d.kueche));
  const peakDays = maxPersons > 0
    ? byDay.filter((d) => d.service + d.kueche === maxPersons).map((d) => d.tag)
    : [];
  return { byDay, personDays, nettoHours: Math.round(nettoHours * 10) / 10, maxPersons, peakDays };
}

export function StaffingWeekSummary({ overview, profileLabel }: {
  overview: WeekOverview;
  /** z.B. «Profil ‹Standard›» — erscheint als Untertitel des Diagramms. */
  profileLabel?: string;
}) {
  const s = useMemo(() => summarizeWeekOverview(overview), [overview]);
  if (!overview.hasAny) return null;

  return (
    <div className="space-y-3" data-testid="staffing-week-summary">
      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-semibold mb-2">
            Personal pro Tag (Bedarf)
            {profileLabel ? <span className="ml-2 text-xs font-normal text-muted-foreground">{profileLabel}</span> : null}
          </p>
          <div className="h-56" data-testid="chart-personal-pro-tag">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={s.byDay} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="tag" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip
                  formatter={(v: number, name: string) =>
                    [`${v} Personen`, name === 'service' ? 'Service' : 'Küche']}
                  labelFormatter={(t) => `Wochentag ${t}`}
                />
                <Legend
                  formatter={(v) => (v === 'service' ? 'Service' : 'Küche')}
                  iconType="circle" wrapperStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="service" stackId="p" fill={SERVICE_COLOR} radius={[0, 0, 0, 0]} />
                <Bar dataKey="kueche" stackId="p" fill={KUECHE_COLOR} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
