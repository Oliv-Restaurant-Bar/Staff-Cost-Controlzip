import { useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, Info, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExcelParseStats } from '@/lib/mirus-excel-parser';
import type { QualityFieldEntry } from '@/lib/import-quality';

interface Props {
  stats:          ExcelParseStats;
  qualityFields?: QualityFieldEntry[];
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
    <span className={cn('inline-block w-2 h-2 rounded-full shrink-0 mt-0.5', statusBg(percent))} />
  );
}

// ─── Vollständige Qualitäts-Tabelle (neu) ─────────────────────────────────────

function QualityFieldRow({ f }: { f: QualityFieldEntry }) {
  const [open, setOpen] = useState(false);
  const hasMissing = f.missing.length > 0 || f.warnings.length > 0;
  const isCountOnly = f.detected === f.expected && f.percent === 100 && f.missing.length === 0;

  return (
    <>
      <tr
        className={cn(
          'border-b border-border/40 transition-colors',
          hasMissing && 'cursor-pointer hover:bg-muted/20',
          f.percent < 95 && 'bg-amber-50/30 dark:bg-amber-950/10',
          f.percent < 70 && 'bg-red-50/30 dark:bg-red-950/10',
        )}
        onClick={() => { if (hasMissing) setOpen(v => !v); }}
      >
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            {hasMissing
              ? (open
                ? <ChevronUp   className="h-3 w-3 text-muted-foreground shrink-0" />
                : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />)
              : <StatusDot percent={f.percent} />}
            <span className="text-foreground">{f.label}</span>
            {isCountOnly && <span className="text-[10px] text-muted-foreground/60">(Anzahl)</span>}
          </div>
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{f.detected}</td>
        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{f.expected}</td>
        <td className="px-3 py-1.5 text-right">
          <span className={cn('font-semibold tabular-nums', statusColor(f.percent))}>
            {f.percent} %
          </span>
        </td>
        <td className="px-3 py-1.5 text-center">
          <span className={cn('inline-block w-2 h-2 rounded-full', statusBg(f.percent))} />
        </td>
      </tr>
      {open && hasMissing && (
        <tr className="bg-muted/20 border-b border-border/40">
          <td colSpan={5} className="px-6 py-2">
            {f.missing.length > 0 && (
              <div className="space-y-0.5 text-[11px] text-muted-foreground mb-1">
                {f.missing.slice(0, 15).map((m, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <XCircle className="h-3 w-3 text-red-400 shrink-0" />{m}
                  </div>
                ))}
                {f.missing.length > 15 && (
                  <div className="text-muted-foreground/60">…und {f.missing.length - 15} weitere</div>
                )}
              </div>
            )}
            {f.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />{w}
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function FullQualityTable({ qualityFields }: { qualityFields: QualityFieldEntry[] }) {
  return (
    <div className="overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-semibold">Datenfeld</th>
            <th className="px-3 py-1.5 text-right font-semibold">Erkannt</th>
            <th className="px-3 py-1.5 text-right font-semibold">Erwartet</th>
            <th className="px-3 py-1.5 text-right font-semibold">Qualität</th>
            <th className="px-3 py-1.5 text-center font-semibold w-6">●</th>
          </tr>
        </thead>
        <tbody>
          {qualityFields.map(f => <QualityFieldRow key={f.key} f={f} />)}
        </tbody>
      </table>
    </div>
  );
}

// ─── Kompakte Metriken (wie bisher) ───────────────────────────────────────────

interface MetricRowProps {
  label:          string;
  num:            number;
  den:            number;
  showFraction?:  boolean;
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

// ─── Haupt-Komponente ─────────────────────────────────────────────────────────

export function DataQualityPanel({ stats, qualityFields }: Props) {
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

  const blockPct = pct(daysWithTimeBlocks, daysWithHours);
  const vacPct   = pct(employeesWithVacationBalance, finalEmployees);
  const holPct   = pct(employeesWithHolidayBalance,  finalEmployees);

  const hasMissing =
    employeesMissingVacation.length > 0 ||
    employeesMissingHoliday.length  > 0 ||
    employeesVacationRowFoundNoValue.length > 0 ||
    employeesHolidayRowFoundNoValue.length  > 0 ||
    incompleteTimeBlocks > 0;

  // Wenn qualityFields verfügbar → zeige die vollständige Tabelle
  if (qualityFields && qualityFields.length > 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 text-xs overflow-hidden">
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
              {qualityWarnings.map((w, i) => <div key={i}>· {w}</div>)}
            </div>
          </div>
        )}

        {/* Vollständige Tabelle */}
        <FullQualityTable qualityFields={qualityFields} />

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

  // Fallback: kompakte Ansicht (ohne qualityFields)
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
            {qualityWarnings.map((w, i) => <div key={i}>· {w}</div>)}
          </div>
        </div>
      )}

      {/* Metric rows */}
      <div className="px-3 py-2.5 space-y-1.5">
        <div className="flex items-center gap-2">
          {monthDetected
            ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            : <XCircle     className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />}
          <span className="text-muted-foreground flex-1">Monat erkannt:</span>
          <span className={cn('font-semibold', monthDetected ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {monthDetected ? '100 %' : '0 % — nicht erkannt'}
          </span>
        </div>
        <MetricRow label="Mitarbeiter erkannt" num={finalEmployees} den={finalEmployees} showFraction={false} />
        <MetricRow label={`Zeitblöcke (${daysWithTimeBlocks} / ${daysWithHours} Tage)`} num={daysWithTimeBlocks} den={daysWithHours} showFraction={false} />
        <MetricRow label={`Ferienguthaben (${employeesWithVacationBalance} / ${finalEmployees} MA)`} num={employeesWithVacationBalance} den={finalEmployees} showFraction={false} />
        <MetricRow label={`Feiertagguthaben (${employeesWithHolidayBalance} / ${finalEmployees} MA)`} num={employeesWithHolidayBalance} den={finalEmployees} showFraction={false} />
      </div>

      {/* Progress bars */}
      <div className="px-3 pb-2.5 space-y-1">
        {[
          { label: 'Zeitblöcke', pct: blockPct },
          { label: 'Ferien',     pct: vacPct },
          { label: 'Feiertage',  pct: holPct },
          { label: 'Monat',      pct: monthDetected ? 100 : 0 },
        ].map(({ label, pct: p }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-20 text-muted-foreground shrink-0">{label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', statusBg(p))} style={{ width: `${p}%` }} />
            </div>
            <span className={cn('w-10 text-right tabular-nums font-medium', statusColor(p))}>{p} %</span>
          </div>
        ))}
      </div>

      {/* Detail list */}
      {hasMissing && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <div className="font-semibold text-foreground">Was fehlt?</div>
          {employeesMissingVacation.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                <XCircle className="h-3 w-3 shrink-0" />
                Ferienguthaben — Zeile nicht in Datei ({employeesMissingVacation.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">{employeesMissingVacation.join(', ')}</div>
            </div>
          )}
          {employeesVacationRowFoundNoValue.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                <Search className="h-3 w-3 shrink-0" />
                Ferienguthaben — Zeile vorhanden, Wert nicht lesbar ({employeesVacationRowFoundNoValue.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">{employeesVacationRowFoundNoValue.join(', ')}</div>
            </div>
          )}
          {employeesMissingHoliday.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                <XCircle className="h-3 w-3 shrink-0" />
                Feiertagguthaben — Zeile nicht in Datei ({employeesMissingHoliday.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">{employeesMissingHoliday.join(', ')}</div>
            </div>
          )}
          {employeesHolidayRowFoundNoValue.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                <Search className="h-3 w-3 shrink-0" />
                Feiertagguthaben — Zeile vorhanden, Wert nicht lesbar ({employeesHolidayRowFoundNoValue.length}):
              </div>
              <div className="pl-4 text-muted-foreground leading-relaxed">{employeesHolidayRowFoundNoValue.join(', ')}</div>
            </div>
          )}
          {incompleteTimeBlocks > 0 && (
            <div className="flex items-center gap-1 text-red-700 dark:text-red-400">
              <XCircle className="h-3 w-3 shrink-0" />
              <span><strong>{incompleteTimeBlocks}</strong> Tag{incompleteTimeBlocks !== 1 ? 'e' : ''} mit unvollständiger Stempelung</span>
            </div>
          )}
        </div>
      )}

      {!hasMissing && qualityWarnings.length === 0 && (
        <div className="border-t border-border px-3 py-2 flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>Alle Bereiche vollständig erkannt</span>
        </div>
      )}
    </div>
  );
}
