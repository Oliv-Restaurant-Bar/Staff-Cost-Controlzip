/**
 * PastScheduleSuggestionCard — Aufstellung aus den GEPLANTEN Dienstplänen
 * (Juni + Juli) je Wochentag, als VORSCHLAG für den 'Standard'-Bedarf.
 *
 * WICHTIG: Basis sind die PLAN-Zeiten (start/end der Dienstplan-Slots) —
 * NIE Ist-/MIRUS-Stunden. Abwesenheiten werden übersprungen.
 *
 * Für Beaulieu gedacht: dort ist die Positionszuordnung der Mitarbeitenden noch
 * leer, deshalb wird je Wochentag pro POSITION aggregiert, wenn eine
 * Hauptposition vorhanden ist, sonst je ABTEILUNG (Hinweis wird angezeigt).
 * Netto-Stunden nach ArG/L-GAV-Pausenstaffel (15/30/60 min ab 5.5/7/9 h),
 * Splitschicht = Summe der Segmente.
 *
 * NUR Anzeige/Vorschlag: liest Dienstpläne read-only, schreibt NICHTS —
 * die Werte trägt der Nutzer selbst in den Bedarf-Editor ein.
 */
import { useState } from 'react';
import { Wand2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTenant } from '@/contexts/TenantContext';
import { loadEmployees, loadScheduleForMonth } from '@/lib/supabase-db';
import { usePositions } from '@/hooks/usePositions';
import { positionDisplayName, resolvePositionKey } from '@/lib/position-utils';
import { WEEKDAYS } from '@/lib/staffing-requirements-utils';
import { nettoMinutesForSlots } from '@/lib/staffing-check-utils';
import type { PlannedSlot } from '@/lib/staffing-comparison-utils';

interface SuggestionRow {
  weekday: number;
  /** Positions-Slug oder Abteilungs-Fallback ('dept:service' | 'dept:küche'). */
  groupKey: string;
  /** Ø eingeplante Personen an diesem Wochentag (nur Tage mit Einträgen). */
  avgHeads: number;
  /** Ø Netto-Stunden an diesem Wochentag. */
  avgNettoHours: number;
  /** Anzahl ausgewerteter Tage. */
  days: number;
}

const MONTHS: { label: string; date: Date }[] = [
  { label: 'Juni', date: new Date(2026, 5, 1) },
  { label: 'Juli', date: new Date(2026, 6, 1) },
];

export function PastScheduleSuggestionCard() {
  const { tenantId } = useTenant();
  const { positions } = usePositions();
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [usedDeptFallback, setUsedDeptFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compute = async () => {
    setLoading(true);
    setError(null);
    try {
      const employees = await loadEmployees(tenantId);
      const empById = new Map(employees.map((e) => [e.id, e]));
      // Tag → Gruppe → { heads:Set, nettoMin:number }
      const perDate = new Map<string, Map<string, { heads: Set<string>; nettoMin: number }>>();
      let anyDeptFallback = false;

      for (const m of MONTHS) {
        const schedule = await loadScheduleForMonth(m.date, tenantId);
        for (const [key, ds] of Object.entries(schedule ?? {})) {
          // Schlüsselformat `${employeeId}-${yyyy-MM-dd}` — Datum sind die letzten 10 Zeichen.
          const dateStr = key.slice(-10);
          const employeeId = key.slice(0, key.length - 11);
          const emp = empById.get(employeeId);
          if (!emp || emp.isActive === false) continue;
          const slots: PlannedSlot[] = [];
          if (ds.früh && !ds.frühAbsence && ds.früh.start && ds.früh.end) {
            slots.push({ start: ds.früh.start, end: ds.früh.end });
          }
          if (ds.spät && !ds.spätAbsence && ds.spät.start && ds.spät.end) {
            slots.push({ start: ds.spät.start, end: ds.spät.end });
          }
          if (slots.length === 0) continue;
          const posKey = resolvePositionKey(positions, emp.primaryStation) ?? null;
          const groupKey = posKey ?? `dept:${emp.department}`;
          if (!posKey) anyDeptFallback = true;

          let groups = perDate.get(dateStr);
          if (!groups) { groups = new Map(); perDate.set(dateStr, groups); }
          let g = groups.get(groupKey);
          if (!g) { g = { heads: new Set(), nettoMin: 0 }; groups.set(groupKey, g); }
          g.heads.add(employeeId);
          g.nettoMin += nettoMinutesForSlots(slots);
        }
      }

      // je (Wochentag × Gruppe) über die Tage mitteln.
      const agg = new Map<string, { heads: number; nettoMin: number; days: number }>();
      for (const [dateStr, groups] of perDate) {
        const d = new Date(`${dateStr}T00:00:00`);
        if (Number.isNaN(d.getTime())) continue;
        const wd = d.getDay() === 0 ? 7 : d.getDay();
        for (const [groupKey, g] of groups) {
          const k = `${wd}|${groupKey}`;
          const a = agg.get(k) ?? { heads: 0, nettoMin: 0, days: 0 };
          a.heads += g.heads.size;
          a.nettoMin += g.nettoMin;
          a.days += 1;
          agg.set(k, a);
        }
      }
      const out: SuggestionRow[] = [...agg.entries()].map(([k, a]) => {
        const [wdStr, groupKey] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
        return {
          weekday: Number(wdStr),
          groupKey,
          avgHeads: Math.round((a.heads / a.days) * 10) / 10,
          avgNettoHours: Math.round((a.nettoMin / a.days / 60) * 10) / 10,
          days: a.days,
        };
      });
      out.sort((x, y) => x.weekday - y.weekday || x.groupKey.localeCompare(y.groupKey, 'de'));
      setRows(out);
      setUsedDeptFallback(anyDeptFallback);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dienstpläne konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  };

  const groupName = (groupKey: string): string => {
    if (groupKey === 'dept:service') return 'Front (gesamt)';
    if (groupKey === 'dept:küche') return 'Küche (gesamt)';
    return positionDisplayName(positions, groupKey) || groupKey;
  };

  return (
    <Card>
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-violet-600" />
          Vorschlag aus Juni/Juli (Ist-Aufstellung je Wochentag)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-muted-foreground">
          Liest die GEPLANTEN Dienstpläne Juni + Juli (Plan-Zeiten, nicht Ist-/MIRUS-Stunden)
          und zeigt je Wochentag die durchschnittlich eingeplanten Personen und
          Netto-Plan-Stunden (ArG-Pausenstaffel, Splitschicht = Summe der Segmente)
          — als Vorschlag für das Profil «Standard». Es wird nichts automatisch übernommen.
        </p>
        <Button size="sm" variant="outline" onClick={compute} disabled={loading}>
          {loading ? 'Wertet aus…' : rows ? 'Neu berechnen' : 'Vorschlag berechnen'}
        </Button>

        {error && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {rows && rows.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            Keine Dienstplan-Einträge im Juni/Juli gefunden.
          </p>
        )}

        {rows && rows.length > 0 && (
          <>
            {usedDeptFallback && (
              <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700 dark:text-amber-400">
                Hinweis: Mitarbeitende ohne Hauptposition werden je Abteilung zusammengefasst —
                Positionszuordnung im Personalstamm ausfüllen für eine Aufstellung je Position.
              </Badge>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1 pr-3 font-medium">Wochentag</th>
                    <th className="py-1 px-3 font-medium">Position/Bereich</th>
                    <th className="py-1 px-3 font-medium text-right">Ø Personen</th>
                    <th className="py-1 px-3 font-medium text-right">Ø Netto-Plan-Std.</th>
                    <th className="py-1 pl-3 font-medium text-right">Tage</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="py-1 pr-3">
                        {WEEKDAYS.find((w) => w.value === r.weekday)?.label ?? r.weekday}
                      </td>
                      <td className="py-1 px-3">{groupName(r.groupKey)}</td>
                      <td className="py-1 px-3 text-right tabular-nums">{r.avgHeads.toLocaleString('de-CH')}</td>
                      <td className="py-1 px-3 text-right tabular-nums">{r.avgNettoHours.toLocaleString('de-CH')}</td>
                      <td className="py-1 pl-3 text-right tabular-nums">{r.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
