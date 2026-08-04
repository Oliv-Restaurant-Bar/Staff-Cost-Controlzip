/**
 * StaffingDayCheck — Anzeige der 3-Dimensionen-Tagesprüfung (Soll vs. Ist)
 * mit Ampel: Stunden je Position, Anzahl je Bedarfs-Schicht, Schichtabdeckung
 * (geschulte Person + Chef-de-Service-Regel).
 *
 * Reine Anzeige: erhält das fertige Prüfergebnis (computeDayCheck) und
 * Anzeigenamen-Helfer — lädt selbst NICHTS und verändert NICHTS.
 */
import { CheckCircle2, AlertTriangle, XCircle, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Ampel, DayCheckResult } from '@/lib/staffing-check-utils';

const AMPEL_PILL: Record<Ampel, string> = {
  gruen:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  gelb:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  rot: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
};

const AMPEL_LABEL: Record<Ampel, string> = { gruen: 'im Soll', gelb: 'knapp', rot: 'Abweichung' };

function AmpelIcon({ ampel, className }: { ampel: Ampel; className?: string }) {
  if (ampel === 'gruen') return <CheckCircle2 className={cn('text-emerald-600', className)} />;
  if (ampel === 'gelb') return <AlertTriangle className={cn('text-amber-600', className)} />;
  return <XCircle className={cn('text-red-600', className)} />;
}

export function AmpelBadge({ ampel, label }: { ampel: Ampel; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        AMPEL_PILL[ampel],
      )}
    >
      <AmpelIcon ampel={ampel} className="h-3 w-3" />
      {label ?? AMPEL_LABEL[ampel]}
    </span>
  );
}

function fmtH(n: number): string {
  return `${n.toLocaleString('de-CH', { maximumFractionDigits: 1 })} h`;
}

interface StaffingDayCheckProps {
  check: DayCheckResult;
  /** Positions-Slug → Anzeigename. */
  positionName: (key: string) => string;
  /** Mitarbeiter-ID → Anzeigename (für CdS/Gastgeber). */
  employeeName?: (id: string) => string;
  className?: string;
}

export function StaffingDayCheck({ check, positionName, employeeName, className }: StaffingDayCheckProps) {
  const empName = employeeName ?? ((id: string) => id);
  const { hours, counts, coverage } = check;

  if (!check.hasRequirements) {
    return (
      <div className={cn('text-xs text-muted-foreground italic', className)}>
        Für diesen Tag ist im aktiven Profil kein Personalbedarf definiert.
        {coverage.cds.warning && (
          <span className="not-italic block mt-1 text-amber-700 dark:text-amber-400">
            {coverage.cds.warning}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)} data-testid="staffing-day-check">
      {/* Gesamt-Ampel */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tagesprüfung
        </span>
        <AmpelBadge ampel={check.overall} label={`Gesamt: ${AMPEL_LABEL[check.overall]}`} />
        <AmpelBadge ampel={hours.ampel} label={`Stunden: ${AMPEL_LABEL[hours.ampel]}`} />
        <AmpelBadge ampel={counts.ampel} label={`Positionen: ${AMPEL_LABEL[counts.ampel]}`} />
        <AmpelBadge ampel={coverage.ampel} label={`Abdeckung: ${AMPEL_LABEL[coverage.ampel]}`} />
      </div>

      {/* CdS-Status */}
      {(coverage.cds.warning || coverage.cds.activeCdsId) && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-xs flex items-start gap-2',
            coverage.cds.ok
              ? 'border-border bg-muted/30'
              : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20',
          )}
        >
          <UserCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          {coverage.cds.ok ? (
            <span>
              Chef de Service: <strong>{empName(coverage.cds.activeCdsId!)}</strong>
              {coverage.cds.gastgeberId && (
                <> · Gastgeber/GF: <strong>{empName(coverage.cds.gastgeberId)}</strong></>
              )}
            </span>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">{coverage.cds.warning}</span>
          )}
        </div>
      )}

      {/* Kalte-Küche/Sushi-Status (dynamische Küchen-Stationsregel) */}
      {coverage.kitchenCold.mode !== 'not_configured' && (
        <div
          data-testid="daycheck-kitchen-cold-status"
          className={cn(
            'rounded-md border px-3 py-2 text-xs flex items-start gap-2',
            coverage.kitchenCold.ok
              ? 'border-border bg-muted/30'
              : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20',
          )}
        >
          <UserCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          {coverage.kitchenCold.ok ? (
            coverage.kitchenCold.mode === 'weak_day' ? (
              <span>
                Kalte Küche/Sushi: keine eigene Station ({coverage.kitchenCold.hotCookCount} Köche
                geplant — die Köche decken alles ab)
              </span>
            ) : (
              <span>
                Kalte Küche/Sushi: <strong>{empName(coverage.kitchenCold.coldId!)}</strong>
                {coverage.kitchenCold.mode === 'fallback' && <> (Vertretung)</>}
              </span>
            )
          ) : (
            <span className="text-amber-700 dark:text-amber-400">{coverage.kitchenCold.warning}</span>
          )}
        </div>
      )}

      {/* 1) Stunden je Position */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="py-1 pr-3 font-medium">Netto-Stunden je Position</th>
              <th className="py-1 px-3 font-medium text-right">Soll</th>
              <th className="py-1 px-3 font-medium text-right">Ist</th>
              <th className="py-1 px-3 font-medium text-right">Differenz</th>
              <th className="py-1 pl-3 font-medium text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {hours.rows.map((r) => (
              <tr key={r.positionKey} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pr-3">{positionName(r.positionKey)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{fmtH(r.sollHours)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{fmtH(r.istHours)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">
                  {r.diffHours > 0 ? '+' : ''}{fmtH(r.diffHours)}
                </td>
                <td className="py-1.5 pl-3 text-right"><AmpelBadge ampel={r.ampel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3) Abdeckung — nur Problemfälle auflisten (kompakt) */}
      {coverage.rows.some((r) => !r.covered || r.coveredOnlyBySecondary) && (
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Schichtabdeckung
          </span>
          {coverage.rows
            .filter((r) => !r.covered || r.coveredOnlyBySecondary)
            .map((r, i) => (
              <div key={`${r.positionKey}-${r.shiftStart}-${i}`} className="flex items-center gap-2 text-xs">
                <AmpelIcon ampel={r.covered ? 'gelb' : 'rot'} className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {positionName(r.positionKey)} {r.shiftStart}–{r.shiftEnd}:{' '}
                  {r.covered
                    ? 'nur über Zweitposition abgedeckt'
                    : 'keine geschulte Person eingeplant'}
                </span>
              </div>
            ))}
        </div>
      )}
      {!coverage.rows.some((r) => !r.covered || r.coveredOnlyBySecondary) &&
        coverage.cds.ok &&
        coverage.kitchenCold.ok && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            Alle geforderten Schichten sind mit geschulten Personen besetzt.
          </p>
        )}

      {/* Hinweis auf abweichende Anzahl (Detailzeilen stehen in der Soll/Ist-Tabelle) */}
      {counts.ampel !== 'gruen' && (
        <p className="text-[11px] text-muted-foreground">
          Anzahl-Abweichungen je Schicht: siehe Soll/Ist-Tabelle oben.{' '}
          <Badge variant="outline" className="text-[10px] align-middle">gelb = ±1 Person</Badge>
        </p>
      )}
    </div>
  );
}
