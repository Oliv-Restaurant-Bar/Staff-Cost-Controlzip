import { AlertTriangle, CheckCircle2, XCircle, Info, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExcelParseStats } from '@/lib/mirus-excel-parser';

interface Props {
  stats: ExcelParseStats;
}

function pct(num: number, den: number): number {
  if (den === 0) return 100;
  return Math.round((num / den) * 100);
}

function statusColor(percent: number): string {
  if (percent >= 95) return 'text-emerald-600 dark:text-emerald-400';
  if (percent >= 80) return 'text-amber-600  dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function statusBg(percent: number): string {
  if (percent >= 95) return 'bg-emerald-500 dark:bg-emerald-600';
  if (percent >= 80) return 'bg-amber-500  dark:bg-amber-500';
  return 'bg-red-500 dark:bg-red-600';
}

function StatusDot({ percent }: { percent: number }) {
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full shrink-0 mt-0.5',
        statusBg(percent),
      )}
    />
  );
}

interface MetricRowProps {
  label: string;
  num: number;
  den: number;
  showFraction?: boolean;
  hideIfPerfect?: boolean;
}

function MetricRow({ label, num, den, showFraction = true, hideIfPerfect = false }: MetricRowProps) {
  const p = pct(num, den);
  if (hideIfPerfect && p === 100) return null;
  return (
    <div className="flex items-center gap-2">
      <StatusDot percent={p} />
      <span className="text-muted-foreground flex-1 min-w-0 truncate">{label}:</span>
      <span className={cn('font-semibold tabular-nums shrink-0', statusColor(p))}>
        {showFraction && den > 0 ? `${num} / ${den} = ` : ''}{p} %
      </span>
    </div>
  );
}

export function DataQualityPanel({ stats }: Props) {
  const {
    finalEmployees,
    monthDetected,
    daysWithHours,
    daysWithTimeBlocks,
    employeesWithVacationBalance,
    employeesWithHolidayBalance,
    employeesMissingVacation,
    employeesMissingHoliday,
    employeesVacationRowFoundNoValue = [],
    employeesHolidayRowFoundNoValue  = [],
    incompleteTimeBlocks,
    qualityWarnings,
  } = stats;

  const blockPct   = pct(daysWithTimeBlocks, daysWithHours);
  const vacPct     = pct(employeesWithVacationBalance, finalEmployees);
  const holPct     = pct(employeesWithHolidayBalance,  finalEmployees);
  const monthPct   = monthDetected ? 100 : 0;

  const hasMissing =
    employeesMissingVacation.length > 0 ||
    employeesMissingHoliday.length  > 0 ||
    employeesVacationRowFoundNoValue.length > 0 ||
    employeesHolidayRowFoundNoValue.length  > 0 ||
    incompleteTimeBlocks > 0;

  return (
    <div className="rounded-lg border border-border bg-muted/20 text-xs">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-semibold text-foreground">Datenqualität / Erkennungsgrad</span>
      </div>

      {/* Quality warning banner */}
      {qualityWarnings.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-amber-50 dark:bg-amber-950/30">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-amber-800 dark:text-amber-300 space-y-0.5">
            <div className="font-semibold">Bitte Import prüfen — nicht alle Daten konnten sicher erkannt werden:</div>
            {qualityWarnings.map((w, i) => (
              <div key={i}>· {w}</div>
            ))}
          </div>
        </div>
      )}

      {/* Metric rows */}
      <div className="px-3 py-2.5 space-y-1.5">
        {/* Monat */}
        <div className="flex items-center gap-2">
          {monthDetected
            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            : <XCircle     className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />}
          <span className="text-muted-foreground flex-1">Monat erkannt:</span>
          <span className={cn('font-semibold', monthDetected ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {monthDetected ? '100 %' : '0 % — nicht erkannt'}
          </span>
        </div>

        <MetricRow
          label="Mitarbeiter erkannt"
          num={finalEmployees}
          den={finalEmployees}
          showFraction={false}
        />
        <MetricRow
          label={`Zeitblöcke (${daysWithTimeBlocks} / ${daysWithHours} Tage)`}
          num={daysWithTimeBlocks}
          den={daysWithHours}
          showFraction={false}
        />
        <MetricRow
          label={`Ferienguthaben (${employeesWithVacationBalance} / ${finalEmployees} MA)`}
          num={employeesWithVacationBalance}
          den={finalEmployees}
          showFraction={false}
        />
        <MetricRow
          label={`Feiertagguthaben (${employeesWithHolidayBalance} / ${finalEmployees} MA)`}
          num={employeesWithHolidayBalance}
          den={finalEmployees}
          showFraction={false}
        />
      </div>

      {/* Progress bars */}
      <div className="px-3 pb-2.5 space-y-1">
        {[
          { label: 'Zeitblöcke', pct: blockPct },
          { label: 'Ferien',     pct: vacPct },
          { label: 'Feiertage',  pct: holPct },
          { label: 'Monat',      pct: monthPct },
        ].map(({ label, pct: p }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground shrink-0">{label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', statusBg(p))}
                style={{ width: `${p}%` }}
              />
            </div>
            <span className={cn('w-10 text-right tabular-nums font-medium', statusColor(p))}>{p} %</span>
          </div>
        ))}
      </div>

      {/* Detail list — was fehlt? */}
      {hasMissing && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <div className="font-semibold text-foreground">Was fehlt?</div>

          {/* Zeile NICHT in Datei vorhanden */}
          {employeesMissingVacation.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                <XCircle className="h-3 w-3 shrink-0" />
                Ferienguthaben — Zeile nicht in Datei ({employeesMissingVacation.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">
                {employeesMissingVacation.join(', ')}
              </div>
            </div>
          )}

          {/* Zeile vorhanden, Wert nicht lesbar */}
          {employeesVacationRowFoundNoValue.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                <Search className="h-3 w-3 shrink-0" />
                Ferienguthaben — Zeile vorhanden, Wert nicht lesbar ({employeesVacationRowFoundNoValue.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">
                {employeesVacationRowFoundNoValue.join(', ')}
              </div>
            </div>
          )}

          {employeesMissingHoliday.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                <XCircle className="h-3 w-3 shrink-0" />
                Feiertagguthaben — Zeile nicht in Datei ({employeesMissingHoliday.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">
                {employeesMissingHoliday.join(', ')}
              </div>
            </div>
          )}

          {employeesHolidayRowFoundNoValue.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                <Search className="h-3 w-3 shrink-0" />
                Feiertagguthaben — Zeile vorhanden, Wert nicht lesbar ({employeesHolidayRowFoundNoValue.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">
                {employeesHolidayRowFoundNoValue.join(', ')}
              </div>
            </div>
          )}

          {incompleteTimeBlocks > 0 && (
            <div className="flex items-center gap-1 text-red-700 dark:text-red-400">
              <XCircle className="h-3 w-3 shrink-0" />
              <span>
                <strong>{incompleteTimeBlocks}</strong> Tag{incompleteTimeBlocks !== 1 ? 'e' : ''} mit unvollständiger Stempelung (Start ohne Ende)
              </span>
            </div>
          )}
        </div>
      )}

      {/* All good */}
      {!hasMissing && qualityWarnings.length === 0 && (
        <div className="border-t border-border px-3 py-2 flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Alle Bereiche vollständig erkannt</span>
        </div>
      )}
    </div>
  );
}
