/**
 * Mirus Import Preview — /mirus-import-preview
 * =============================================
 * Sichere Import-Vorschau-Pipeline.
 * KEIN Supabase-Write, KEINE Produktionsdaten.
 * Nur lokaler State — rein diagnostisch + Vorschau.
 */

import { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { parseMirusExcel } from '@/lib/mirus-excel-parser';
import type {
  ExcelEmployee,
  ExcelParsedDocument,
  EmployeeTotals,
  DayRecord,
} from '@/lib/mirus-excel-parser';
import type {
  PreviewImportSession,
  PreviewEmployee,
  PreviewDayEntry,
  PreviewImportWarning,
  PreviewTotals,
  ImportPayload,
  ImportPayloadEmployee,
  ImportPayloadDay,
} from '@/types/mirus-import-preview';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BUILDER: Parser-Output → PreviewSession ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function qualityScore(emp: ExcelEmployee): number {
  let s = 0;
  const days   = emp.days   ?? [];
  const totals = emp.totals ?? {};
  const active = days.filter(d => (d.shifts ?? []).length > 0 || !!d.absenceCode).length;

  if (emp.name)                              s += 25;
  if (emp.weeklyHours)                       s += 8;
  if (emp.costCenter || emp.department)      s += 8;

  // Tagesdaten: validierte Totale → volle Punktzahl (egal wie viele Tage)
  // Aushilfen/Krankenmonaten/Eintritt haben oft weniger Tage — nicht bestrafen wenn Cross-Check ok
  if (totals.totalsValidated && days.length > 0) {
    s += 27;
  } else if (days.length >= 20) s += 27;
  else if   (days.length >= 14) s += 22;
  else if   (days.length >= 7)  s += 15;
  else if   (days.length >= 1)  s += 8;

  // Aktive Tage (Schichten oder Absenzen)
  if      (active >= 10) s += 14;
  else if (active >= 3)  s += 9;
  else if (active >= 1)  s += 4;

  if (totals.totalHours)      s += 8;
  if (totals.totalsValidated) s += 10;

  return Math.min(100, s);
}

function mapDay(d: DayRecord): PreviewDayEntry {
  return {
    date:         d.date        ?? null,
    weekday:      d.weekday     ?? null,
    shifts:       d.shifts      ?? [],
    breakMinutes: d.breakMinutes ?? null,
    totalHours:   d.totalHours  ?? null,
    absenceCode:  d.absenceCode ?? null,
    notes:        d.notes       ?? null,
    rawCells:     d.rawCells    ?? {},
    confidence:   d.confidence  ?? 'low',
  };
}

function mapTotals(t: EmployeeTotals | undefined): PreviewTotals {
  if (!t) return {};
  return {
    totalHours:           t.totalHours,
    pauseTotal:           t.pauseTotal,
    nettoTotal:           t.nettoTotal,
    sollStunden:          t.sollStunden,
    zeitzuschlag:         t.zeitzuschlag,
    ueberzeit:            t.ueberzeit,
    saldo:                t.saldo,
    ferien:               t.ferien,
    feiertag:             t.feiertag,
    kompensation:         t.kompensation,
    krankheit:            t.krankheit,
    calculatedTotalHours: t.calculatedTotalHours,
    totalsValidated:      t.totalsValidated,
    totalsDiff:           t.totalsDiff,
  };
}

function buildWarnings(emp: ExcelEmployee, idx: number): PreviewImportWarning[] {
  const label  = emp.name ?? `Block #${idx + 1}`;
  const warns: PreviewImportWarning[] = [];
  const days   = emp.days   ?? [];
  const totals = emp.totals ?? {};

  // Fehler: kein Name → ausgeschlossen
  if (!emp.name)
    warns.push({
      severity: 'error', category: 'name',
      message: 'Kein Name erkannt — Mitarbeiter wird ausgeschlossen.',
      employeeName: label,
    });

  // Warnung: weder Abteilung noch Kostenstelle bekannt
  if (!emp.costCenter && !emp.department)
    warns.push({
      severity: 'warning', category: 'costCenter',
      message: 'Keine Abteilung/Kostenstelle erkannt — bitte vor Import manuell ergänzen. Import ist trotzdem möglich.',
      employeeName: label,
    });

  // Keine Daten überhaupt
  const hasAnyData = days.length > 0 || !!totals.totalHours;
  if (!hasAnyData)
    warns.push({
      severity: 'warning', category: 'days',
      message: 'Keine Tages- und keine Totaldaten erkannt — Mitarbeiter wahrscheinlich unvollständig geparst.',
      employeeName: label,
    });

  // Wenig Tage UND keine Totale → kontextuell (nicht bei Aushilfen/Krankheit hinderlich)
  else if (days.length > 0 && days.length < 15 && !totals.totalHours)
    warns.push({
      severity: 'info', category: 'days',
      message: `${days.length} Tage erkannt, keine Monatstotale — mögliche Aushilfe, Eintritt/Austritt oder Krankenmonat. Import möglich.`,
      employeeName: label,
    });

  // Ungewöhnlich viele Stunden
  const totalH = totals.calculatedTotalHours ?? 0;
  if (totalH > 250)
    warns.push({
      severity: 'warning', category: 'hours',
      message: `Ungewöhnlich viele Stunden: ${totalH} h — möglicher Mehrfachblock-Fehler, bitte prüfen. Import möglich.`,
      employeeName: label,
    });

  // Totale-Abweichung > 3 h
  if (totals.totalsDiff !== undefined && totals.totalsDiff > 3)
    warns.push({
      severity: 'warning', category: 'totals',
      message: `Totale weichen um ±${totals.totalsDiff} h von Tageszeilen ab — Datei möglicherweise fehlerhaft. Import möglich, aber bitte prüfen.`,
      employeeName: label,
    });

  // Merge-Info (nur informativ, kein Hindernis)
  if ((emp.mergedFromCount ?? 0) > 1)
    warns.push({
      severity: 'info', category: 'merge',
      message: `Aus ${emp.mergedFromCount} Teilblöcken zusammengeführt (mehrseitiges Monatsblatt). Import möglich.`,
      employeeName: label,
    });

  // Qualität unter 80 %
  const q = qualityScore(emp);
  if (q < 80)
    warns.push({
      severity: 'warning', category: 'quality',
      message: `Qualität ${q}% — Daten möglicherweise unvollständig. Bitte prüfen, Import ist trotzdem möglich.`,
      employeeName: label,
    });

  return warns;
}

let _idCounter = 0;
function nextId() { return `prev-${Date.now()}-${++_idCounter}`; }

function buildPreviewSession(parsed: ExcelParsedDocument, file: File): PreviewImportSession {
  const rawEmployees = parsed?.employees ?? [];
  const rawWarnings  = parsed?.warnings  ?? [];

  const employees: PreviewEmployee[] = rawEmployees.map((emp, idx) => {
    const safeDays   = emp.days   ?? [];
    const safeTotals = emp.totals ?? {};
    const safeEmp    = { ...emp, days: safeDays, totals: safeTotals } as ExcelEmployee;

    const quality  = qualityScore(safeEmp);
    const warnings = buildWarnings(safeEmp, idx);
    // check nur bei echten Problemen (warning/error), nicht bei info-Hinweisen
    const hasWarn  = warnings.some(w => w.severity === 'warning' || w.severity === 'error');
    const importStatus: PreviewEmployee['importStatus'] =
      !emp.name ? 'excluded' : hasWarn || quality < 80 ? 'check' : 'ready';

    return {
      tempId:           nextId(),
      name:             emp.name             ?? null,
      department:       emp.department       ?? null,
      costCenter:       emp.costCenter       ?? null,
      weeklyHours:      emp.weeklyHours      ?? null,
      employmentPeriod: emp.employmentPeriod ?? null,
      quality,
      importSelected:   importStatus !== 'excluded',
      importStatus,
      warnings,
      days:             safeDays.map(mapDay),
      totals:           mapTotals(safeTotals),
      rawSource: {
        sheetName:       emp.sheetName       ?? '',
        blockStartRow:   emp.blockStartRow   ?? 0,
        blockEndRow:     emp.blockEndRow     ?? null,
        mergedFromCount: emp.mergedFromCount ?? 1,
        mergedBlockRows: emp.mergedBlockRows ?? [],
      },
    } satisfies PreviewEmployee;
  });

  const globalWarnings: PreviewImportWarning[] = rawWarnings.map(w => ({
    severity: 'warning' as const,
    category: 'meta'    as const,
    message:  w,
  }));

  const avgQ = employees.length
    ? Math.round(employees.reduce((s, e) => s + e.quality, 0) / employees.length)
    : 0;
  const totalHours    = employees.reduce((s, e) => s + (e.totals.calculatedTotalHours ?? 0), 0);
  const selectedCount = employees.filter(e => e.importSelected).length;

  return {
    id:             nextId(),
    sourceFileName: file.name,
    month:          parsed.month     ?? null,
    monthName:      parsed.monthName ?? null,
    year:           parsed.year      ?? null,
    restaurant:     parsed.restaurant ?? null,
    createdAt:      new Date().toISOString(),
    employees,
    globalWarnings,
    averageQuality: avgQ,
    totalHours:     Math.round(totalHours * 10) / 10,
    selectedCount,
    status:         'preview',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PREPARE IMPORT PAYLOAD (kein Speichern — nur Debug) ──────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function prepareImportPayload(session: PreviewImportSession): ImportPayload {
  const allEmps  = session.employees ?? [];
  const selected = allEmps.filter(e => e.importSelected);

  const employees: ImportPayloadEmployee[] = selected.map(emp => {
    const empDays = emp.days ?? [];
    const days: ImportPayloadDay[] = empDays
      .filter(d => d.date)
      .map(d => ({
        employeeName: emp.name ?? '(unbekannt)',
        costCenter:   emp.costCenter,
        department:   emp.department,
        date:         d.date!,
        weekday:      d.weekday,
        shifts:       d.shifts,
        breakMinutes: d.breakMinutes,
        totalHours:   d.totalHours,
        absenceCode:  d.absenceCode,
        notes:        d.notes,
      }));

    return {
      name:             emp.name ?? '(unbekannt)',
      department:       emp.department,
      costCenter:       emp.costCenter,
      weeklyHours:      emp.weeklyHours,
      employmentPeriod: emp.employmentPeriod,
      totalHours:       emp.totals.calculatedTotalHours ?? 0,
      dayCount:         days.length,
      days,
      totals:           emp.totals,
    };
  });

  const allDays       = employees.flatMap(e => e.days);
  const totalHours    = employees.reduce((s, e) => s + e.totalHours, 0);
  const allWarnings   = (session.employees ?? []).flatMap(e => e.warnings ?? []);

  const payload: ImportPayload = {
    sourceFileName: session.sourceFileName,
    month:          session.month,
    year:           session.year,
    restaurant:     session.restaurant,
    preparedAt:     new Date().toISOString(),
    employees,
    totalDayLines:  allDays.length,
    totalHours:     Math.round(totalHours * 10) / 10,
    warnings:       allWarnings,
  };

  console.log('[MirusImportPreview] prepareImportPayload:', JSON.stringify(payload, null, 2));
  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UI-HELFER ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function QualityBar({ pct }: { pct: number }) {
  const color = pct >= 85 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-[11px] font-mono font-bold tabular-nums shrink-0',
        pct >= 85 ? 'text-green-600' : pct >= 60 ? 'text-yellow-600' : 'text-red-600'
      )}>{pct}%</span>
    </div>
  );
}

function StatusBadge({ status }: { status: PreviewEmployee['importStatus'] }) {
  const map = {
    ready:    { label: 'Importfähig', cls: 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400' },
    check:    { label: 'Prüfen',     cls: 'bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-400' },
    excluded: { label: 'Ausgeschlossen', cls: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-400' },
  } as const;
  const { label, cls } = map[status];
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-semibold', cls)}>{label}</span>
  );
}

function SevBadge({ severity }: { severity: PreviewImportWarning['severity'] }) {
  const cls = severity === 'error'
    ? 'text-red-600'
    : severity === 'warning'
    ? 'text-yellow-600'
    : 'text-blue-500';
  const icon = severity === 'error' ? '✗' : severity === 'warning' ? '⚠' : 'ℹ';
  return <span className={cn('font-bold text-[11px]', cls)}>{icon}</span>;
}

function WarnList({ warnings }: { warnings: PreviewImportWarning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="space-y-0.5">
      {warnings.map((w, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11px]">
          <SevBadge severity={w.severity} />
          <span className="text-muted-foreground">{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

function MonatsTotaleRow({ totals }: { totals: PreviewTotals }) {
  const FIELDS: [keyof PreviewTotals, string][] = [
    ['totalHours',   'Total h'],
    ['pauseTotal',   'Pause'],
    ['nettoTotal',   'Netto'],
    ['sollStunden',  'Soll'],
    ['ueberzeit',    'Überzeit'],
    ['zeitzuschlag', 'Zuschlag'],
    ['saldo',        'Saldo'],
    ['ferien',       'Ferien'],
    ['feiertag',     'Feiertag'],
    ['kompensation', 'Komp.'],
    ['krankheit',    'Krank'],
  ];
  const found = FIELDS.filter(([k]) => !!(totals as Record<string, unknown>)[k]);
  const calc  = totals.calculatedTotalHours;
  const valid = totals.totalsValidated;
  const diff  = totals.totalsDiff;

  return (
    <div className="space-y-2">
      {found.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {found.map(([k, label]) => (
            <span key={k} className={cn(
              'inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border font-mono font-semibold',
              k === 'totalHours' && valid
                ? 'bg-green-50 border-green-300 text-green-800'
                : k === 'totalHours'
                ? 'bg-blue-50 border-blue-200 text-blue-800'
                : 'bg-muted/60 border-border text-foreground',
            )}>
              <span className="text-muted-foreground font-normal text-[9px] uppercase tracking-wide mr-0.5">{label}</span>
              {(totals as Record<string, unknown>)[k] as string}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">Keine Monatstotale erkannt.</p>
      )}
      {calc !== undefined && (
        <div className={cn(
          'flex flex-wrap items-center gap-3 text-[11px] rounded border px-3 py-2',
          valid ? 'border-green-200 bg-green-50/50' : diff !== undefined && diff > 3 ? 'border-red-200 bg-red-50/50' : 'border-border bg-muted/20',
        )}>
          <span className="text-muted-foreground">Berechnet:</span>
          <span className="font-mono font-bold">{calc} h</span>
          {diff !== undefined && totals.totalHours && (
            <>
              <span className="text-muted-foreground">Diff:</span>
              <span className={cn('font-mono font-bold', diff < 1 ? 'text-green-600' : diff < 3 ? 'text-yellow-600' : 'text-red-600')}>±{diff} h</span>
            </>
          )}
          {valid && <span className="text-green-600 font-semibold">✓ validiert</span>}
          {diff !== undefined && diff >= 3 && <span className="text-red-600 font-semibold">⚠ Abweichung</span>}
        </div>
      )}
    </div>
  );
}

function DayTable({ days }: { days: PreviewDayEntry[] }) {
  if (!days.length) return <p className="text-[11px] text-muted-foreground italic">Keine Tageszeilen.</p>;
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/40 border-b border-border">
            {['Datum', 'Tag', 'Zeitblöcke', 'Pause', 'Total', 'Absenz', 'Bemerkung'].map(h => (
              <th key={h} className="text-left px-2 py-1.5 font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={i} className={cn(
              'border-b border-border/50 hover:bg-muted/20 transition-colors',
              d.absenceCode ? 'bg-yellow-50/30' : '',
            )}>
              <td className="px-2 py-1 font-mono whitespace-nowrap">{d.date ?? '—'}</td>
              <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">{d.weekday ?? '—'}</td>
              <td className="px-2 py-1">
                {d.shifts.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {d.shifts.map((s, j) => (
                      <span key={j} className="font-mono bg-blue-50 border border-blue-100 rounded px-1 py-0.5 text-blue-800 whitespace-nowrap">
                        {s.from}–{s.to}{s.department ? ` (${s.department})` : ''}
                      </span>
                    ))}
                  </div>
                ) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-2 py-1 font-mono whitespace-nowrap">
                {d.breakMinutes != null ? `${d.breakMinutes}'` : '—'}
              </td>
              <td className="px-2 py-1 font-mono font-semibold whitespace-nowrap">
                {d.totalHours != null ? `${d.totalHours} h` : '—'}
              </td>
              <td className="px-2 py-1 whitespace-nowrap">
                {d.absenceCode ? (
                  <span className="bg-yellow-100 border border-yellow-200 text-yellow-800 rounded px-1 py-0.5 font-semibold">{d.absenceCode}</span>
                ) : '—'}
              </td>
              <td className="px-2 py-1 text-muted-foreground max-w-[180px] truncate">{d.notes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EMPLOYEE CARD ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function EmployeeCard({
  emp,
  onToggleSelect,
}: {
  emp: PreviewEmployee;
  onToggleSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab,  setTab]  = useState<'days' | 'totals' | 'warnings'>('days');

  const activeShifts = emp.days.reduce((s, d) => s + d.shifts.length, 0);
  const totalH       = emp.totals.calculatedTotalHours ?? 0;
  const warnCount    = emp.warnings.filter(w => w.severity !== 'info').length;

  return (
    <div className={cn(
      'rounded-lg border bg-card transition-shadow',
      emp.importSelected ? 'border-border' : 'border-dashed border-muted-foreground/30 opacity-60',
      open && 'shadow-md',
    )}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={emp.importSelected}
          disabled={emp.importStatus === 'excluded'}
          onChange={() => onToggleSelect(emp.tempId)}
          className="h-4 w-4 rounded border-border cursor-pointer"
        />

        <button
          onClick={() => setOpen(v => !v)}
          className="flex-1 flex items-center gap-3 text-left min-w-0"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm truncate">{emp.name ?? <span className="text-red-500 italic">Kein Name</span>}</span>
              <StatusBadge status={emp.importStatus} />
              {warnCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold">
                  {warnCount} Hinweis{warnCount > 1 ? 'e' : ''}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              {emp.department   && <span className="text-[11px] text-muted-foreground">{emp.department}</span>}
              {emp.costCenter   && <span className="text-[11px] bg-muted/60 rounded px-1.5 py-0.5 font-mono">{emp.costCenter}</span>}
              {emp.weeklyHours  && <span className="text-[11px] text-muted-foreground">{emp.weeklyHours} h/Wo</span>}
            </div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1.5 min-w-[130px]">
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              <span>{emp.days.length} Tage</span>
              <span>{activeShifts} Blöcke</span>
            </div>
            {/* Plausibilitätsbox: immer sichtbar */}
            {emp.totals.calculatedTotalHours !== undefined && (() => {
              const calc  = emp.totals.calculatedTotalHours;
              const mirus = emp.totals.totalHours;
              const diff  = emp.totals.totalsDiff;
              const valid = emp.totals.totalsValidated;
              return (
                <div className={cn(
                  'flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-mono',
                  valid
                    ? 'border-green-200 bg-green-50/70 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400'
                    : diff !== undefined && diff > 3
                    ? 'border-red-200 bg-red-50/70 text-red-700'
                    : 'border-border bg-muted/40 text-muted-foreground',
                )}>
                  <span className="font-bold">{calc}h</span>
                  {mirus && <span className="opacity-60">/ {mirus}</span>}
                  {valid
                    ? <span className="text-green-600 font-bold">✓</span>
                    : diff !== undefined && <span>±{diff}h</span>
                  }
                </div>
              );
            })()}
            <QualityBar pct={emp.quality} />
          </div>

          <span className="text-muted-foreground text-[11px] shrink-0">{open ? '▲' : '▼'}</span>
        </button>
      </div>

      {/* Expanded */}
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          {/* Tab nav */}
          <div className="flex gap-1">
            {(['days', 'totals', 'warnings'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'text-[11px] px-3 py-1 rounded border font-medium transition-colors',
                  tab === t
                    ? 'bg-foreground text-background border-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground',
                )}
              >
                {t === 'days'     ? `Tage (${emp.days.length})`         : null}
                {t === 'totals'   ? 'Monatstotale'                      : null}
                {t === 'warnings' ? `Hinweise (${emp.warnings.length})` : null}
              </button>
            ))}
          </div>

          {tab === 'days'     && <DayTable days={emp.days} />}
          {tab === 'totals'   && <MonatsTotaleRow totals={emp.totals} />}
          {tab === 'warnings' && (
            emp.warnings.length
              ? <WarnList warnings={emp.warnings} />
              : <p className="text-[11px] text-green-600 font-semibold">✓ Keine Hinweise</p>
          )}

          {/* Raw source info */}
          <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-2">
            Blatt: <span className="font-mono">{emp.rawSource.sheetName}</span>
            {' · '}Zeilen: <span className="font-mono">{emp.rawSource.blockStartRow}–{emp.rawSource.blockEndRow ?? '?'}</span>
            {emp.rawSource.mergedFromCount > 1 && (
              <span className="ml-2 text-muted-foreground">⊞ Merged ×{emp.rawSource.mergedFromCount}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UPLOAD ZONE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function UploadZone({ onFile }: { onFile: (f: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [onFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors p-16',
        dragging
          ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-900/10'
          : 'border-border hover:border-muted-foreground/40 hover:bg-muted/20',
      )}
    >
      <span className="text-4xl">📊</span>
      <div className="text-center">
        <p className="font-semibold">Mirus Excel-Datei hier ablegen</p>
        <p className="text-sm text-muted-foreground mt-0.5">oder klicken zum Auswählen (.xlsx)</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SUMMARY PANEL ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function StatBox({ label, value, color = 'default' }: {
  label: string; value: string; color?: 'green' | 'yellow' | 'red' | 'default';
}) {
  const cls = color === 'green' ? 'text-green-600 dark:text-green-400'
    : color === 'yellow' ? 'text-yellow-600 dark:text-yellow-400'
    : color === 'red'    ? 'text-red-600 dark:text-red-400'
    : 'text-foreground';
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-mono font-bold', cls)}>{value}</p>
    </div>
  );
}

function SummaryPanel({ session, onRestaurantChange }: {
  session: PreviewImportSession;
  onRestaurantChange: (r: string) => void;
}) {
  const ready    = session.employees.filter(e => e.importStatus === 'ready').length;
  const check    = session.employees.filter(e => e.importStatus === 'check').length;
  const excluded = session.employees.filter(e => e.importStatus === 'excluded').length;
  const openWarns = session.employees.flatMap(e => e.warnings).filter(w => w.severity === 'warning' || w.severity === 'error').length;
  const selected  = session.employees.filter(e => e.importSelected).length;
  const qColor = session.averageQuality >= 90 ? 'green' : session.averageQuality >= 80 ? 'yellow' : 'red';

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      {/* Titel + Periode */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm">Import-Vorschau</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-xs">{session.sourceFileName}</p>
        </div>
        {session.monthName && session.year && (
          <span className="text-[11px] font-semibold px-2 py-1 rounded border border-border bg-muted/30">
            {session.monthName} {session.year}
          </span>
        )}
      </div>

      {/* Statusübersicht */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-border/60 bg-muted/10 px-4 py-3">
        <StatBox label="Importfähig"      value={String(ready)}      color={ready > 0 ? 'green' : 'default'} />
        <StatBox label="Prüfen"           value={String(check)}      color={check > 0 ? 'yellow' : 'green'} />
        <StatBox label="Ausgeschlossen"   value={String(excluded)}   color={excluded > 0 ? 'red' : 'default'} />
        <StatBox label="Offene Warnungen" value={String(openWarns)}  color={openWarns > 0 ? 'yellow' : 'green'} />
      </div>

      {/* Weitere Felder */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Restaurant: entweder erkannt oder Dropdown */}
        <div className="space-y-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Restaurant</p>
          {session.restaurant ? (
            <p className="text-sm font-mono font-bold capitalize">{session.restaurant}</p>
          ) : (
            <select
              className="text-sm border border-yellow-300 rounded px-1.5 py-0.5 bg-background mt-0.5 w-full font-semibold"
              defaultValue=""
              onChange={e => { if (e.target.value) onRestaurantChange(e.target.value); }}
            >
              <option value="" disabled>Bitte wählen</option>
              <option value="oliv">Oliv</option>
              <option value="beaulieu">Beaulieu</option>
            </select>
          )}
        </div>
        <StatBox label="Ausgewählt"    value={`${selected} / ${session.employees.length}`} />
        <StatBox label="Gesamtstunden" value={`${session.totalHours} h`} />
        <StatBox label="Ø Qualität"    value={`${session.averageQuality}%`} color={qColor} />
      </div>

      {session.globalWarnings.length > 0 && (
        <div className="border-t border-border pt-2">
          <WarnList warnings={session.globalWarnings} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── IMPORT SUMMARY (unten) ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ImportSummary({
  session,
  onExportJson,
}: {
  session: PreviewImportSession;
  onExportJson: () => void;
}) {
  const selected   = session.employees.filter(e => e.importSelected);
  const excluded   = session.employees.filter(e => !e.importSelected);
  const totalDays  = selected.reduce((s, e) => s + e.days.filter(d => !!d.date).length, 0);
  const totalH     = selected.reduce((s, e) => s + (e.totals.calculatedTotalHours ?? 0), 0);
  const warnCount  = selected.flatMap(e => e.warnings).filter(w => w.severity !== 'info').length;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <h2 className="font-semibold text-sm">Import-Zusammenfassung</h2>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Ausgewählt',    value: `${selected.length} MA` },
          { label: 'Ausgeschlossen', value: `${excluded.length} MA` },
          { label: 'Tageszeilen',   value: String(totalDays) },
          { label: 'Stunden total', value: `${Math.round(totalH * 10) / 10} h` },
        ].map(({ label, value }) => (
          <div key={label} className="space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-sm font-mono font-semibold">{value}</p>
          </div>
        ))}
      </div>

      {warnCount > 0 && (
        <p className="text-[11px] text-yellow-600 font-semibold">
          ⚠ {warnCount} offene Hinweis{warnCount > 1 ? 'e' : ''} bei ausgewählten Mitarbeitern
        </p>
      )}

      <div className="flex flex-wrap gap-3 pt-2 border-t border-border">
        <button
          onClick={onExportJson}
          className="px-4 py-2 rounded border border-border text-sm font-medium hover:bg-muted/40 transition-colors"
        >
          Preview JSON exportieren
        </button>

        <button
          disabled
          title="Echter Import wird im nächsten Schritt aktiviert."
          className="px-4 py-2 rounded text-sm font-medium bg-muted text-muted-foreground cursor-not-allowed opacity-50 border border-border"
        >
          Echter Import — wird im nächsten Schritt aktiviert
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPTSEITE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default function MirusImportPreview() {
  const [session,  setSession]  = useState<PreviewImportSession | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // Lokale Kopie der Session für Checkbox-Änderungen
  const [localEmployees,  setLocalEmployees]  = useState<PreviewEmployee[]>([]);
  // Restaurant-Auswahl (falls aus Datei nicht erkennbar)
  const [localRestaurant, setLocalRestaurant] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setLocalRestaurant(null);
    try {
      const parsed  = await parseMirusExcel(file);
      const session = buildPreviewSession(parsed, file);
      setSession(session);
      setLocalEmployees(session.employees);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[MirusImportPreview] handleFile Fehler:', e);
      setError(`Parsing-Fehler: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setLocalEmployees(prev =>
      prev.map(e => e.tempId === id ? { ...e, importSelected: !e.importSelected } : e)
    );
  }, []);

  const selectAll = () => setLocalEmployees(prev =>
    prev.map(e => e.importStatus !== 'excluded' ? { ...e, importSelected: true } : e)
  );
  const deselectWarnings = () => setLocalEmployees(prev =>
    prev.map(e => e.warnings.some(w => w.severity !== 'info') ? { ...e, importSelected: false } : e)
  );
  const selectReadyOnly = () => setLocalEmployees(prev =>
    prev.map(e => ({ ...e, importSelected: e.importStatus === 'ready' }))
  );

  const currentSession: PreviewImportSession | null = session
    ? {
        ...session,
        restaurant:    localRestaurant ?? session.restaurant,
        employees:     localEmployees,
        selectedCount: localEmployees.filter(e => e.importSelected).length,
      }
    : null;

  const handleExportJson = () => {
    if (!currentSession) return;
    const payload = prepareImportPayload(currentSession);
    const blob    = new Blob([JSON.stringify({ session: currentSession, payload }, null, 2)], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `mirus-preview-${currentSession.sourceFileName.replace(/\.[^.]+$/, '')}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="border-b border-border bg-card/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold">Mirus Import-Vorschau</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold">
              Kein Supabase-Write
            </span>
          </div>
          <div className="flex gap-2">
            <a
              href="/mirus-excel-test"
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors text-muted-foreground"
            >
              → Diagnose-Test
            </a>
            {session && (
              <button
                onClick={() => { setSession(null); setLocalEmployees([]); setError(null); }}
                className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors"
              >
                Neue Datei
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">

        {/* Upload */}
        {!session && !loading && (
          <div className="max-w-xl mx-auto mt-12">
            <UploadZone onFile={handleFile} />
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
            <p className="text-sm">Datei wird analysiert…</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50/50 px-4 py-3 text-sm text-red-700">
            <strong>Fehler:</strong> {error}
          </div>
        )}

        {/* Preview */}
        {currentSession && (
          <>
            <SummaryPanel session={currentSession} onRestaurantChange={setLocalRestaurant} />

            {/* Auswahl-Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground font-semibold mr-1">Auswahl:</span>
              {[
                { label: 'Alle auswählen',           fn: selectAll },
                { label: 'Alle mit Warnung abwählen', fn: deselectWarnings },
                { label: 'Nur importfähige',          fn: selectReadyOnly },
              ].map(({ label, fn }) => (
                <button
                  key={label}
                  onClick={fn}
                  className="text-[11px] px-2.5 py-1 rounded border border-border hover:bg-muted/40 transition-colors"
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {localEmployees.filter(e => e.importSelected).length} / {localEmployees.length} ausgewählt
              </span>
            </div>

            {/* Employee Cards */}
            <div className="space-y-2">
              {localEmployees.map(emp => (
                <EmployeeCard
                  key={emp.tempId}
                  emp={emp}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>

            {/* Import Summary */}
            <ImportSummary
              session={currentSession}
              onExportJson={handleExportJson}
            />
          </>
        )}
      </div>
    </div>
  );
}
