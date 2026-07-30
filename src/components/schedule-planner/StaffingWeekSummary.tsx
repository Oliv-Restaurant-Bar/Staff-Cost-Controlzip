/**
 * Visuelle Übersicht des Personalbedarfs («Ganze Woche», oberhalb der Matrix):
 *  - Kennzahlen-Kacheln: Personentage/Woche, Netto-Stunden/Woche, Spitzentage
 *  - Gestapeltes Balkendiagramm «Personal pro Tag» (Service + Küche, Mo–So)
 *
 * Werte kommen aus dem AKTIVEN Profil (buildWeekOverview → effektiver Bedarf
 * inkl. UG-Zuschlag bei Winter/UG), pro Mandant. Reine Anzeige, keine Writes.
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Users, Clock, TrendingUp } from 'lucide-react';
import type { WeekOverview } from '@/lib/staffing-week-utils';

const WEEKDAY_SHORT: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
};

const SERVICE_COLOR = 'hsl(24 90% 55%)';   // warmes Orange (Service)
const KUECHE_COLOR = 'hsl(200 70% 45%)';   // Blau (Küche)

const fmtH = (h: number) =>
  `${h.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;

/** Personen je Abteilung × Wochentag aus der Wochenübersicht aufsummieren. */
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
          if (c) sum += c.mittag + c.abend;
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

function Kachel({ icon, label, value, sub, testid }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; testid: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums" data-testid={testid}>{value}</p>
          {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function StaffingWeekSummary({ overview, profileLabel }: {
  overview: WeekOverview;
  /** z.B. «Profil ‹Standard›» — erscheint als Untertitel der Kacheln. */
  profileLabel?: string;
}) {
  const s = useMemo(() => summarizeWeekOverview(overview), [overview]);
  if (!overview.hasAny) return null;

  return (
    <div className="space-y-3" data-testid="staffing-week-summary">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kachel
          icon={<Users className="h-4 w-4" />}
          label="Personentage / Woche"
          value={String(s.personDays)}
          sub={profileLabel}
          testid="tile-person-days"
        />
        <Kachel
          icon={<Clock className="h-4 w-4" />}
          label="Netto-Stunden / Woche"
          value={fmtH(s.nettoHours)}
          sub="Soll-Schichten × Dauer, ArG-Pausenabzug"
          testid="tile-netto-hours"
        />
        <Kachel
          icon={<TrendingUp className="h-4 w-4" />}
          label="Spitzentage"
          value={s.peakDays.length > 0 ? s.peakDays.join(' · ') : '—'}
          sub={s.maxPersons > 0 ? `${s.maxPersons} Personen-Einsätze` : undefined}
          testid="tile-peak-days"
        />
      </div>

      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-semibold mb-2">Personal pro Tag</p>
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
