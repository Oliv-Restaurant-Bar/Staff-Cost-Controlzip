/**
 * StaffingWeekCompare — Wochen-Abgleich der Personalbedarf-Seite:
 *  - Vergleichs-Kacheln (Kopfzahl Plan/Bedarf · Stunden Plan/Bedarf · Ist/Bedarf)
 *  - Wochenansicht A: «Bedarf vs. Planung» (Kopfzahl je Position × Mo–So)
 *  - Wochenansicht B: «Stunden: Bedarf / Plan / Ist» (nur Tagestotale + Woche)
 *
 * Alle Zahlen kommen aus buildWeekCompare (gemeinsame Berechnung mit
 * Dienstplan-Live-Hinweis und Cockpit). NUR Anzeige — es wird nichts verändert.
 * Ampel-Konvention Kopfzahl: grün = passt, rot = über Bedarf, gelb = unter.
 * Stunden: rot = über Bedarf (Kosten), grün = im/unter Bedarf.
 */
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { Users, Clock, ClipboardCheck } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { WeekCompare } from '@/lib/staffing-week-compare';
import type { SchedulePlanProposal } from '@/lib/schedule-proposal-store';

const WEEKDAY_SHORT: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
};

const fmtH = (v: number) => v.toLocaleString('de-CH', { maximumFractionDigits: 1 });

/** Ampelfarbe Kopfzahl-Differenz: 0 grün · >0 rot (über) · <0 gelb (unter). */
function headDiffClass(diff: number): string {
  if (diff === 0) return 'text-emerald-600';
  return diff > 0 ? 'text-red-600' : 'text-amber-600';
}

function diffLabel(diff: number): string {
  if (diff === 0) return '±0';
  return diff > 0 ? `+${fmtH(diff)}` : `−${fmtH(Math.abs(diff))}`;
}

// ── Vergleichs-Kacheln ────────────────────────────────────────────────────────

function CompareTile({ icon, label, plan, soll, unit, diff, diffClass, sub, testid }: {
  icon: React.ReactNode;
  label: string;
  plan: string;
  soll: string;
  unit?: string;
  diff?: string | null;
  diffClass?: string;
  sub?: string;
  testid: string;
}) {
  return (
    <Card>
      <CardContent className="p-2.5 flex items-start gap-2">
        <div className="rounded-md bg-muted p-1.5 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-[11px] leading-tight text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums leading-tight" data-testid={testid}>
            {plan}<span className="text-muted-foreground font-normal text-base"> / {soll}{unit ? ` ${unit}` : ''}</span>
            {diff != null && (
              <span className={cn('ml-2 text-sm font-medium', diffClass)}>{diff}</span>
            )}
          </p>
          {sub ? <p className="text-[11px] leading-tight text-muted-foreground">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function WeekCompareTiles({ compare, weekLabel }: {
  compare: WeekCompare;
  /** z.B. «KW 31 · 27.07.–02.08.2026». */
  weekLabel?: string;
}) {
  const t = compare.totals;
  const personsDiff = t.planPersons != null ? t.planPersons - t.sollPersons : null;
  const hoursDiff = t.planHours != null ? Math.round((t.planHours - t.sollHours) * 10) / 10 : null;
  const hoursPct = t.planHours != null && t.sollHours > 0
    ? Math.round(((t.planHours - t.sollHours) / t.sollHours) * 100)
    : null;
  const istDiff = t.istHours != null ? Math.round((t.istHours - t.sollHours) * 10) / 10 : null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="week-compare-tiles">
      <CompareTile
        icon={<Users className="h-4 w-4" />}
        label="Kopfzahl: Plan vs. Bedarf"
        plan={t.planPersons != null ? String(t.planPersons) : '–'}
        soll={String(t.sollPersons)}
        diff={personsDiff != null ? diffLabel(personsDiff) : null}
        diffClass={personsDiff != null ? headDiffClass(personsDiff) : undefined}
        sub={weekLabel ? `${weekLabel} · Personen (Kopfzahl)` : 'Personen (Kopfzahl)'}
        testid="tile-persons-plan-soll"
      />
      <CompareTile
        icon={<Clock className="h-4 w-4" />}
        label="Stunden: Plan vs. Bedarf"
        plan={t.planHours != null ? fmtH(t.planHours) : '–'}
        soll={fmtH(t.sollHours)}
        unit="h"
        diff={hoursDiff != null
          ? `${diffLabel(hoursDiff)}${hoursPct != null ? ` (${hoursPct > 0 ? '+' : ''}${hoursPct}%)` : ''}`
          : null}
        diffClass={hoursDiff != null && hoursDiff > 0 ? 'text-red-600' : 'text-emerald-600'}
        sub="Netto-Stunden, ArG-Pausenabzug"
        testid="tile-hours-plan-soll"
      />
      <CompareTile
        icon={<ClipboardCheck className="h-4 w-4" />}
        label="Stunden: Ist vs. Bedarf"
        plan={t.istHours != null ? fmtH(t.istHours) : '–'}
        soll={fmtH(t.sollHours)}
        unit="h"
        diff={istDiff != null ? diffLabel(istDiff) : null}
        diffClass={istDiff != null && istDiff > 0 ? 'text-red-600' : 'text-emerald-600'}
        sub={t.istHours == null ? 'leer, solange kein MIRUS-Import' : 'Ist (MIRUS)'}
        testid="tile-hours-ist-soll"
      />
    </div>
  );
}

// ── Wochenansicht A: Bedarf vs. Planung (Kopfzahl je Position) ───────────────

export function WeekCompareMatrix({ compare, onSelectDate, onSelectCell, openProposals }: {
  compare: WeekCompare;
  /** Klick auf eine Tagesspalte → Einzeltag-Detail. */
  onSelectDate?: (dateStr: string) => void;
  /** Klick auf eine Datenzelle (Position × Tag) → Zell-Detail-Pop-up. */
  onSelectCell?: (positionKey: string, dateStr: string) => void;
  /** Offene Dienstplan-Vorschläge («+1 vorgeschlagen»-Marker; zählen NICHT als geplant). */
  openProposals?: SchedulePlanProposal[];
}) {
  if (!compare.hasAnyRequirement && !compare.hasAnyPlan) return null;
  /** Dezenter Marker offener Vorschläge einer Zelle (+n / −n). */
  const proposalMarker = (positionKey: string, dateStr: string) => {
    const cellProps = (openProposals ?? []).filter(
      (p) => p.positionKey === positionKey && p.date === dateStr && p.status === 'open');
    if (cellProps.length === 0) return null;
    const adds = cellProps.filter((p) => p.type === 'add').length;
    const removes = cellProps.length - adds;
    const label = [adds > 0 ? `+${adds}` : null, removes > 0 ? `−${removes}` : null]
      .filter(Boolean).join(' ');
    return (
      <span
        className="block text-[9px] leading-tight text-sky-600 dark:text-sky-400"
        title={`${label} vorgeschlagen — im Dienstplan bestätigen (zählt noch nicht als geplant)`}
        data-testid={`proposal-marker-${positionKey}-${dateStr}`}
      >
        {label} vorgeschlagen
      </span>
    );
  };
  return (
    <Card data-testid="week-compare-matrix">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm">Bedarf vs. Planung (Kopfzahl · Bedarf / Plan)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium">Position</th>
              {compare.days.map((d) => (
                <th key={d.dateStr} className="py-1 px-1 text-center font-medium border-b border-r border-border/40 last:border-r-0">
                  {onSelectDate ? (
                    <button
                      type="button"
                      onClick={() => onSelectDate(d.dateStr)}
                      className="rounded px-1 hover:bg-muted hover:text-foreground"
                      title={`${format(parseISO(d.dateStr), 'EEEE dd.MM.', { locale: de })}: Einzeltag-Detail öffnen`}
                      data-testid={`compare-col-${d.weekday}`}
                    >
                      {WEEKDAY_SHORT[d.weekday]} {format(parseISO(d.dateStr), 'dd.MM.')}
                    </button>
                  ) : (
                    <>{WEEKDAY_SHORT[d.weekday]} {format(parseISO(d.dateStr), 'dd.MM.')}</>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {compare.rows.map((row) => (
              <tr key={row.positionKey} className="border-t border-border/50">
                <td className="py-1 pr-2 whitespace-nowrap">{row.positionName}</td>
                {compare.days.map((d) => {
                  const c = row.cells[d.weekday];
                  return (
                    <td
                      key={d.dateStr}
                      className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0"
                      data-testid={`compare-cell-${row.positionKey}-${d.weekday}`}
                    >
                      {c ? (
                        onSelectCell ? (
                          <button
                            type="button"
                            onClick={() => onSelectCell(row.positionKey, d.dateStr)}
                            className="rounded px-1 -mx-1 cursor-pointer hover:bg-muted"
                            title={`${row.positionName}: Bedarf ${c.soll} · Plan ${c.planned} (${diffLabel(c.diff)}) — Detail öffnen`}
                          >
                            {c.soll} / <span className={cn('font-medium', headDiffClass(c.diff))}>{c.planned}</span>
                            {proposalMarker(row.positionKey, d.dateStr)}
                          </button>
                        ) : (
                          <span title={`Bedarf ${c.soll} · Plan ${c.planned} (${diffLabel(c.diff)})`}>
                            {c.soll} / <span className={cn('font-medium', headDiffClass(c.diff))}>{c.planned}</span>
                            {proposalMarker(row.positionKey, d.dateStr)}
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground/40">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2">
            <tr className="text-xs font-medium">
              <td className="py-1 pr-2">Total (Kopfzahl)</td>
              {compare.days.map((d) => {
                const t = d.hints.totals;
                const planned = d.hasPlan ? t.plannedPersons : null;
                return (
                  <td key={d.dateStr} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0" data-testid={`compare-total-${d.weekday}`}>
                    {t.sollPersons} / {planned != null
                      ? <span className={headDiffClass(planned - t.sollPersons)}>{planned}</span>
                      : <span className="text-muted-foreground/60">–</span>}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Je Zelle «Bedarf / Plan» in KOPFZAHL (eine Person zählt 1× pro Position
          und Tag). Grün = passt, rot = über Bedarf, gelb = unter Bedarf.
          Klick auf eine Tagesspalte öffnet das Einzeltag-Detail.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Wochenansicht B: Stunden Bedarf / Plan / Ist (Tagestotale) ───────────────

function HoursDiff({ value, bedarf }: { value: number | null; bedarf: number }) {
  if (value == null) return null;
  const diff = Math.round((value - bedarf) * 10) / 10;
  return (
    <span className={cn('block text-[10px] tabular-nums', diff > 0 ? 'text-red-600' : 'text-emerald-600')}>
      {diff > 0 ? '+' : ''}{fmtH(diff)}
    </span>
  );
}

export function WeekHoursTable({ compare, onSelectDate }: {
  compare: WeekCompare;
  onSelectDate?: (dateStr: string) => void;
}) {
  if (!compare.hasAnyRequirement && !compare.hasAnyPlan) return null;
  const t = compare.totals;
  return (
    <Card data-testid="week-hours-table">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm">Stunden: Bedarf / Plan / Ist (Netto, pro Tag)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium" />
              {compare.days.map((d) => (
                <th key={d.dateStr} className="py-1 px-1 text-center font-medium border-b border-r border-border/40">
                  {onSelectDate ? (
                    <button
                      type="button"
                      onClick={() => onSelectDate(d.dateStr)}
                      className="rounded px-1 hover:bg-muted hover:text-foreground"
                      data-testid={`hours-col-${d.weekday}`}
                    >
                      {WEEKDAY_SHORT[d.weekday]} {format(parseISO(d.dateStr), 'dd.MM.')}
                    </button>
                  ) : (
                    <>{WEEKDAY_SHORT[d.weekday]} {format(parseISO(d.dateStr), 'dd.MM.')}</>
                  )}
                </th>
              ))}
              <th className="py-1 px-1 text-center font-medium border-b">Woche</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border/50">
              <td className="py-1 pr-2 font-semibold whitespace-nowrap">Bedarf (Soll)</td>
              {compare.days.map((d) => (
                <td key={d.dateStr} className="py-1 px-1 text-center tabular-nums font-semibold border-r border-border/40" data-testid={`hours-bedarf-${d.weekday}`}>
                  {d.bedarfHours > 0 ? fmtH(d.bedarfHours) : <span className="text-muted-foreground/40">–</span>}
                </td>
              ))}
              <td className="py-1 px-1 text-center tabular-nums font-semibold">{fmtH(t.sollHours)}</td>
            </tr>
            <tr className="border-t border-border/50">
              <td className="py-1 pr-2 whitespace-nowrap">Dienstplan (Plan)</td>
              {compare.days.map((d) => (
                <td key={d.dateStr} className="py-1 px-1 text-center tabular-nums border-r border-border/40" data-testid={`hours-plan-${d.weekday}`}>
                  {d.planHours != null ? fmtH(d.planHours) : <span className="text-muted-foreground/40">–</span>}
                  <HoursDiff value={d.planHours} bedarf={d.bedarfHours} />
                </td>
              ))}
              <td className="py-1 px-1 text-center tabular-nums">
                {t.planHours != null ? fmtH(t.planHours) : '–'}
                <HoursDiff value={t.planHours} bedarf={t.sollHours} />
              </td>
            </tr>
            <tr className="border-t border-border/50 text-muted-foreground">
              <td className="py-1 pr-2 whitespace-nowrap">Ist (MIRUS)</td>
              {compare.days.map((d) => (
                <td key={d.dateStr} className="py-1 px-1 text-center tabular-nums border-r border-border/40" data-testid={`hours-ist-${d.weekday}`}>
                  {d.istHours != null ? fmtH(d.istHours) : ''}
                  <HoursDiff value={d.istHours} bedarf={d.bedarfHours} />
                </td>
              ))}
              <td className="py-1 px-1 text-center tabular-nums">
                {t.istHours != null ? fmtH(t.istHours) : ''}
                <HoursDiff value={t.istHours} bedarf={t.sollHours} />
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Netto-Stunden mit ArG-Pausenabzug. Δ zum Bedarf: grün = im/unter Bedarf,
          rot = über Bedarf (Kosten). Ist bleibt leer, solange kein MIRUS-Import
          vorliegt. Tagestotale ohne Positions-Aufschlüsselung — Details je
          Position in der Kopfzahl-Matrix darüber.
        </p>
      </CardContent>
    </Card>
  );
}
