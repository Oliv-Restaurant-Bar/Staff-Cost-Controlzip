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
import { isNoTimeTracking } from '@/lib/no-time-tracking';
import type {
  ExcelEmployee,
  ExcelParsedDocument,
  EmployeeTotals,
  DayRecord,
  MonthlyAccounts,
} from '@/lib/mirus-excel-parser';
import type {
  PreviewImportSession,
  PreviewEmployee,
  PreviewDayEntry,
  PreviewImportWarning,
  PreviewTotals,
  PreviewMonthlyAccounts,
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

  // Monatskonten erkannt: Vorsaldo+Endsaldo Stunden (+4), Ferien (+2)
  const ma = emp.monthlyAccounts;
  if (ma?.hours?.openingBalance && ma?.hours?.closingBalance) s += 4;
  if (ma?.vacation?.closingBalance)                           s += 2;

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

function mapMonthlyAccounts(ma: MonthlyAccounts | undefined): PreviewMonthlyAccounts {
  const empty = { hours: {}, vacation: {}, holiday: {}, overtime: {}, comp: {}, rawLines: [] };
  if (!ma) return empty;
  return {
    hours:    { ...ma.hours },
    vacation: { ...ma.vacation },
    holiday:  { ...ma.holiday },
    overtime: { ...ma.overtime },
    comp:     { ...ma.comp },
    rawLines: ma.rawLines ?? [],
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
      message: `Ungewöhnlich viele Stunden: ${formatHours(totalH)} — möglicher Mehrfachblock-Fehler, bitte prüfen. Import möglich.`,
      employeeName: label,
    });

  // Totale-Abweichung > 3 h
  if (totals.totalsDiff !== undefined && totals.totalsDiff > 3)
    warns.push({
      severity: 'warning', category: 'totals',
      message: `Totale weichen um ±${formatHours(totals.totalsDiff)} von Tageszeilen ab — Datei möglicherweise fehlerhaft. Import möglich, aber bitte prüfen.`,
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

  // Monatskonten: Info wenn keine Saldodaten erkannt
  const ma = emp.monthlyAccounts;
  const hasAnyAcct = ma && (
    Object.values(ma.hours).some(Boolean)    ||
    Object.values(ma.vacation).some(Boolean) ||
    Object.values(ma.holiday).some(Boolean)  ||
    Object.values(ma.overtime).some(Boolean)
  );
  if (!hasAnyAcct)
    warns.push({
      severity: 'info', category: 'accounts',
      message: 'Keine Monatskonten (Vorsaldi/Endsaldi) erkannt — Ketten-Prüfung für diesen Mitarbeiter nicht möglich.',
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
    // Zeilen-VALIDIERUNGSSTATUS vor dem Import (Datenqualität der Excel-Zeile).
    // NICHT die zentrale Import-Frische-Ampel (src/lib/import-center.ts) — anderes Konzept.
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
      monthlyAccounts:  mapMonthlyAccounts(emp.monthlyAccounts),
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
      monthlyAccounts:  emp.monthlyAccounts,
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

function WizardBar({ step }: { step: 1 | 2 | 3 | 4 }) {
  const STEPS: { n: 1 | 2 | 3 | 4; label: string }[] = [
    { n: 1, label: 'Datei hochladen' },
    { n: 2, label: 'Import prüfen' },
    { n: 3, label: 'Mitarbeiter kontrollieren' },
    { n: 4, label: 'Freigabe vorbereiten' },
  ];
  return (
    <div className="flex items-center justify-center gap-0">
      {STEPS.map((s, i) => (
        <div key={s.n} className="flex items-center">
          {i > 0 && (
            <div className={cn('h-px w-8 sm:w-12 shrink-0', s.n <= step ? 'bg-foreground/80' : 'bg-border')} />
          )}
          <div className="flex flex-col items-center gap-0.5">
            <div className={cn(
              'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2 transition-all',
              s.n < step  ? 'bg-foreground border-foreground text-background' :
              s.n === step ? 'bg-background border-foreground text-foreground' :
              'bg-background border-border text-muted-foreground',
            )}>
              {s.n < step ? '✓' : s.n}
            </div>
            <span className={cn(
              'text-[9px] whitespace-nowrap font-medium hidden sm:block',
              s.n === step ? 'text-foreground' : 'text-muted-foreground',
            )}>{s.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: PreviewEmployee['importStatus'] }) {
  const map = {
    ready:    { label: 'Importfähig', cls: 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400' },
    check:    { label: 'Prüfung nötig', cls: 'bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-400' },
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

function formatHours(value: number | null | undefined): string {
  if (value == null) return '—';
  return Number(value).toFixed(2) + ' h';
}

// ─── VERIFICATION LOGIC ────────────────────────────────────────────────────────

type VerificationChecks = {
  nameRecognized:   boolean;
  deptRecognized:   boolean;
  daysPresent:      boolean;
  totalsRecognized: boolean;
  hoursMatch:       boolean;
  noOpenWarnings:   boolean;
};

type VerificationResult = {
  verified:    boolean;
  checks:      VerificationChecks;
  calcHours:   number | null;
  mirusHours:  number | null;
  hoursDiff:   number | null;
  activeDays:  number;
  absenceDays: number;
  shiftCount:     number;
  noTimeTracking: boolean;
  messages:       string[];
};

function computeVerification(emp: PreviewEmployee): VerificationResult {
  const totals    = emp.totals;
  const calc      = totals.calculatedTotalHours ?? null;
  const mirus     = totals.totalHours ?? null;
  const hoursDiff = calc != null && mirus != null ? Math.abs(calc - mirus) : null;

  const activeDays  = emp.days.filter(d => d.shifts.length > 0).length;
  const absenceDays = emp.days.filter(d => !!d.absenceCode).length;
  const shiftCount  = emp.days.reduce((s, d) => s + d.shifts.length, 0);
  const openWarnCount = emp.warnings.filter(w => w.severity === 'error' || w.severity === 'warning').length;
  const hasErrors   = emp.warnings.some(w => w.severity === 'error');

  // ── Sonderfall: Keine Zeiterfassung erforderlich ─────────────────────────────
  // Nur wenn manuell im Personalstamm konfiguriert (Mock: NO_TIME_TRACKING_EMPLOYEES).
  // Keine Heuristik — ausschliesslich explizite Konfiguration.
  if (isNoTimeTracking(emp.name) && !hasErrors && activeDays === 0 && (calc === null || calc === 0)) {
    return {
      verified:       true,
      noTimeTracking: true,
      checks: {
        nameRecognized:   !!emp.name,
        deptRecognized:   true,
        daysPresent:      true,
        totalsRecognized: true,
        hoursMatch:       true,
        noOpenWarnings:   openWarnCount === 0,
      },
      calcHours:   calc,
      mirusHours:  mirus,
      hoursDiff:   null,
      activeDays:  0,
      absenceDays,
      shiftCount:  0,
      messages:    ['Keine Zeiterfassung erforderlich — im Personalstamm explizit konfiguriert.'],
    };
  }

  const nameRecognized   = !!emp.name;
  const deptRecognized   = !!(emp.department || emp.costCenter);
  const daysPresent      = emp.days.length > 0;
  const totalsRecognized = mirus != null;
  const hoursMatch       = !totalsRecognized ? true : (hoursDiff != null && hoursDiff <= 0.05);
  const noOpenWarnings   = openWarnCount === 0;

  const checks: VerificationChecks = {
    nameRecognized, deptRecognized, daysPresent, totalsRecognized, hoursMatch, noOpenWarnings,
  };
  const verified = Object.values(checks).every(Boolean);

  const messages: string[] = [];
  if (calc != null && mirus != null) {
    messages.push(
      `Mirus Total: ${formatHours(mirus)}, erkannte Tagesstunden: ${formatHours(calc)}, Differenz: ${(hoursDiff ?? 0).toFixed(2)} h`
    );
  } else if (calc != null) {
    messages.push(`Berechnete Tagesstunden: ${formatHours(calc)} (kein Mirus-Total vorhanden)`);
  }
  if (absenceDays > 0) {
    const codes = [...new Set(emp.days.filter(d => !!d.absenceCode).map(d => d.absenceCode!))];
    messages.push(`Absenzen erkannt: ${absenceDays} Tage (${codes.join(', ')})`);
  }
  if (shiftCount > activeDays) {
    messages.push(`Mehrere Schichten an ${activeDays} Arbeitstagen erkannt (${shiftCount} Schichten total)`);
  }
  if (!emp.department && emp.costCenter) {
    messages.push(`Abteilung nicht erkannt — Kostenstelle: ${emp.costCenter}`);
  }
  if (!emp.department && !emp.costCenter) {
    messages.push('Kostenstelle und Abteilung fehlen');
  }

  return { verified, noTimeTracking: false, checks, calcHours: calc, mirusHours: mirus, hoursDiff, activeDays, absenceDays, shiftCount, messages };
}

function VerificationBadge({ result, status }: { result: VerificationResult; status: PreviewEmployee['importStatus'] }) {
  if (status === 'excluded') {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded border bg-red-50 border-red-200 text-red-700 font-semibold whitespace-nowrap">
        Blockiert
      </span>
    );
  }
  if (result.noTimeTracking) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded border bg-blue-50 border-blue-200 text-blue-700 font-semibold whitespace-nowrap">
        Keine Zeiterfassung
      </span>
    );
  }
  if (result.verified) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded border bg-green-50 border-green-200 text-green-700 font-semibold whitespace-nowrap">
        ✓ 100 % verifiziert
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold whitespace-nowrap">
      Prüfung nötig
    </span>
  );
}

function KontrollBox({ result }: { result: VerificationResult }) {
  if (result.noTimeTracking) {
    return (
      <div className="rounded-lg border border-blue-200/60 bg-blue-50/30 px-3 py-2.5 text-[11px] text-blue-700 flex items-center gap-2">
        <span className="font-bold shrink-0">ℹ</span>
        Keine Zeiterfassung erforderlich — im Personalstamm explizit konfiguriert.
      </div>
    );
  }
  const rows: { label: string; ok: boolean; detail?: string }[] = [
    { label: 'Name erkannt',            ok: result.checks.nameRecognized },
    { label: 'Abteilung erkannt',       ok: result.checks.deptRecognized },
    {
      label: 'Tagesdaten vorhanden',
      ok: result.checks.daysPresent,
      detail: result.checks.daysPresent
        ? `${result.activeDays} Arbeitstage, ${result.absenceDays} Absenztage, ${result.shiftCount} Schichten`
        : undefined,
    },
    {
      label: 'Mirus-Total erkannt',
      ok: result.checks.totalsRecognized,
      detail: result.mirusHours != null ? formatHours(result.mirusHours) : undefined,
    },
    {
      label: 'Stunden abgestimmt',
      ok: result.checks.hoursMatch,
      detail: result.hoursDiff != null ? `Diff: ${result.hoursDiff.toFixed(2)} h` : undefined,
    },
    { label: 'Keine offenen Warnungen', ok: result.checks.noOpenWarnings },
  ];

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden text-[11px]">
      {rows.map(({ label, ok, detail }) => (
        <div
          key={label}
          className={cn(
            'flex items-center gap-2 px-3 py-2 border-b border-border/40 last:border-b-0',
            ok ? 'bg-background' : 'bg-yellow-50/50',
          )}
        >
          <span className={cn('font-bold shrink-0 w-4 text-center', ok ? 'text-green-600' : 'text-yellow-600')}>
            {ok ? '✓' : '⚠'}
          </span>
          <span className={cn('font-medium flex-1', ok ? 'text-foreground' : 'text-yellow-800')}>{label}</span>
          {detail && <span className="text-muted-foreground text-[10px] shrink-0">{detail}</span>}
        </div>
      ))}
    </div>
  );
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
              {formatHours((totals as Record<string, unknown>)[k] as number | undefined | null)}
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
          <span className="font-mono font-bold">{formatHours(calc)}</span>
          {diff !== undefined && totals.totalHours && (
            <>
              <span className="text-muted-foreground">Diff:</span>
              <span className={cn('font-mono font-bold', diff < 1 ? 'text-green-600' : diff < 3 ? 'text-yellow-600' : 'text-red-600')}>±{formatHours(diff)}</span>
            </>
          )}
          {valid && <span className="text-green-600 font-semibold">✓ validiert</span>}
          {diff !== undefined && diff >= 3 && <span className="text-red-600 font-semibold">⚠ Abweichung</span>}
        </div>
      )}
    </div>
  );
}

// ─── ACCOUNTS PANEL ──────────────────────────────────────────────────────────

function AccountsPanel({ accounts }: { accounts: PreviewMonthlyAccounts | undefined }) {
  if (!accounts) return <p className="text-[11px] text-muted-foreground italic">Keine Kontodaten verfügbar.</p>;

  type AcctKey = 'hours' | 'vacation' | 'holiday' | 'overtime' | 'comp';
  const SECTIONS: { key: AcctKey; label: string }[] = [
    { key: 'hours',    label: 'Stundenkonto' },
    { key: 'vacation', label: 'Ferienkonto' },
    { key: 'holiday',  label: 'Feiertagskonto' },
    { key: 'overtime', label: 'Überzeitkonto' },
    { key: 'comp',     label: 'Kompensation' },
  ];
  const SUB_LABELS: [string, string][] = [
    ['openingBalance', 'Vortr.'],
    ['correction',     'Korr.'],
    ['planned',        'Soll'],
    ['actual',         'Ist'],
    ['paidOut',        'Ausbez.'],
    ['difference',     'Diff.'],
    ['compensation',   'Komp.'],
    ['surcharge',      'Zus.'],
    ['days',           'Tage'],
    ['closingBalance', 'Saldo'],
  ];

  const hasSomeData = SECTIONS.some(({ key }) =>
    Object.values(accounts[key] ?? {}).some(Boolean)
  );

  return (
    <div className="space-y-3">
      {!hasSomeData && (
        <p className="text-[11px] text-muted-foreground italic">
          Keine Monatskonten erkannt — Layout in dieser Datei möglicherweise nicht unterstützt.
        </p>
      )}
      {hasSomeData && SECTIONS.map(({ key, label }) => {
        const acct = accounts[key] as Record<string, string | null | undefined>;
        const fields = SUB_LABELS.filter(([fk]) => !!acct[fk]);
        if (!fields.length) return null;
        return (
          <div key={key} className="rounded border border-border/60 overflow-hidden">
            <div className="px-3 py-1.5 bg-muted/30 border-b border-border/40">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
            </div>
            <div className="flex flex-wrap gap-2 px-3 py-2">
              {fields.map(([fk, fLabel]) => {
                const val = acct[fk];
                if (!val) return null;
                const isKey = fk === 'openingBalance' || fk === 'closingBalance';
                return (
                  <span key={fk} className={cn(
                    'inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border font-mono font-semibold',
                    isKey ? 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-300'
                          : 'bg-muted/60 border-border text-foreground',
                  )}>
                    <span className="text-muted-foreground font-normal text-[9px] uppercase tracking-wide mr-0.5">{fLabel}</span>
                    {val}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
      {accounts.rawLines.length > 0 && (
        <details className="text-[10px]">
          <summary className="text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
            Rohzellen ({accounts.rawLines.length})
          </summary>
          <div className="mt-1 overflow-x-auto rounded border border-border/40">
            <table className="text-[10px] border-collapse w-full">
              <thead>
                <tr className="bg-muted/40">
                  {['Konto', 'Label', 'Wert', 'Zelle'].map(h => (
                    <th key={h} className="px-2 py-1 text-left font-semibold text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accounts.rawLines.map((l, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="px-2 py-0.5 font-mono text-muted-foreground">{l.accountType}</td>
                    <td className="px-2 py-0.5">{l.label}</td>
                    <td className="px-2 py-0.5 font-mono font-semibold">{l.value || '—'}</td>
                    <td className="px-2 py-0.5 font-mono text-muted-foreground">{l.cellAddr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
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
                    {d.shifts.length > 1 && (
                      <span className="text-[9px] text-blue-600 font-semibold">{d.shifts.length} Blöcke</span>
                    )}
                  </div>
                ) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-2 py-1 font-mono whitespace-nowrap">
                {d.breakMinutes != null ? `${d.breakMinutes}'` : '—'}
              </td>
              <td className="px-2 py-1 font-mono font-semibold whitespace-nowrap">
                {formatHours(d.totalHours)}
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
// ─── EMPLOYEE DETAIL MODAL + CARD ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function EmployeeDetailModal({ emp, onClose }: { emp: PreviewEmployee; onClose: () => void }) {
  const [tab, setTab] = useState<'overview' | 'days' | 'accounts' | 'warnings' | 'technical'>('overview');

  const totals     = emp.totals;
  const calc       = totals.calculatedTotalHours;
  const diff       = totals.totalsDiff;
  const valid      = totals.totalsValidated;
  const warnCount  = emp.warnings.filter(w => w.severity !== 'info').length;
  const activeDays = emp.days.filter(d => d.shifts.length > 0).length;
  const absCount   = emp.days.filter(d => !!d.absenceCode).length;
  const vacCount   = emp.days.filter(d => d.absenceCode === 'FE').length;
  const sickCount  = emp.days.filter(d => d.absenceCode === 'KR').length;
  const vr         = computeVerification(emp);

  const TABS: [string, string][] = [
    ['overview',  'Übersicht'],
    ['days',      `Tagesdaten (${emp.days.length})`],
    ['accounts',  'Saldi & Konten'],
    ['warnings',  `Hinweise${warnCount > 0 ? ` (${warnCount})` : ''}`],
    ['technical', 'Technische Details'],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-t-2xl sm:rounded-xl border shadow-2xl w-full sm:max-w-3xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-base">{emp.name ?? <span className="text-red-500 italic">Kein Name</span>}</h3>
              <StatusBadge status={emp.importStatus} />
            </div>
            <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
              {emp.department       && <span>{emp.department}</span>}
              {emp.costCenter       && <span className="font-mono bg-muted/60 rounded px-1.5 py-0.5">{emp.costCenter}</span>}
              {emp.weeklyHours      && <span>{emp.weeklyHours} h/Wo</span>}
              {emp.employmentPeriod && <span>{emp.employmentPeriod}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0 mt-0.5">✕</button>
        </div>

        {/* Tab nav */}
        <div className="flex border-b border-border overflow-x-auto shrink-0">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t as typeof tab)}
              className={cn(
                'text-[11px] px-4 py-2.5 font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                tab === t
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
                t === 'warnings' && warnCount > 0 && tab !== t && 'text-yellow-600 hover:text-yellow-700',
              )}
            >{label}</button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {tab === 'overview' && (
            <div className="space-y-4">
              {/* Verification banner */}
              <div className={cn(
                'rounded-lg border p-4 flex items-center gap-3',
                vr.verified ? 'border-green-200 bg-green-50/40' : 'border-yellow-200 bg-yellow-50/30',
              )}>
                <div className={cn('text-2xl font-bold leading-none shrink-0', vr.verified ? 'text-green-600' : 'text-yellow-600')}>
                  {vr.verified ? '✓' : '⚠'}
                </div>
                <div>
                  <p className={cn('font-bold text-sm', vr.verified ? 'text-green-700' : 'text-yellow-700')}>
                    {vr.verified ? '100 % verifiziert' : 'Prüfung nötig'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {vr.verified
                      ? `${vr.activeDays} Arbeitstage · ${formatHours(vr.calcHours)} bestätigt`
                      : 'Mindestens eine Kontrollprüfung nicht bestanden'}
                  </p>
                </div>
              </div>

              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-3">
                {([
                  { label: 'Gesamtstunden', value: formatHours(vr.calcHours) },
                  { label: 'Arbeitstage',   value: `${vr.activeDays}` },
                  { label: 'Absenzen',      value: `${vr.absenceDays}` },
                ] as const).map(({ label, value }) => (
                  <div key={label} className="rounded-lg border bg-muted/20 px-3 py-2.5 space-y-0.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="text-lg font-bold font-mono">{value}</p>
                  </div>
                ))}
              </div>

              {/* Kontrollbox */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Automatische Kontrollprüfung</p>
                <KontrollBox result={vr} />
              </div>

              {/* Concrete messages */}
              {vr.messages.length > 0 && (
                <div className="rounded-lg border border-border/60 p-3 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Details</p>
                  {vr.messages.map((m, i) => (
                    <p key={i} className="text-[11px] text-foreground leading-relaxed">{m}</p>
                  ))}
                </div>
              )}

              {/* Warnings */}
              {warnCount > 0 && (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50/30 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-yellow-700 mb-2">⚠ {warnCount} Hinweis{warnCount > 1 ? 'e' : ''}</p>
                  <WarnList warnings={emp.warnings.filter(w => w.severity !== 'info')} />
                </div>
              )}
            </div>
          )}

          {tab === 'days'     && <DayTable days={emp.days} />}
          {tab === 'accounts' && <AccountsPanel accounts={emp.monthlyAccounts} />}
          {tab === 'warnings' && (
            emp.warnings.length
              ? <WarnList warnings={emp.warnings} />
              : <p className="text-[11px] text-green-600 font-semibold">✓ Keine Hinweise</p>
          )}

          {tab === 'technical' && (
            <div className="space-y-3">
              <div className="rounded border border-blue-100 bg-blue-50/30 p-3 space-y-1 text-[11px]">
                <p className="font-semibold text-blue-700 mb-1.5">Excel-Quellinfo</p>
                <p><span className="text-muted-foreground w-28 inline-block">Blatt:</span> <span className="font-mono">{emp.rawSource.sheetName}</span></p>
                <p><span className="text-muted-foreground w-28 inline-block">Zeilen:</span> <span className="font-mono">{emp.rawSource.blockStartRow}–{emp.rawSource.blockEndRow ?? '?'}</span></p>
                <p><span className="text-muted-foreground w-28 inline-block">Blöcke merged:</span> <span className="font-mono">{emp.rawSource.mergedFromCount}</span></p>
                {emp.rawSource.mergedBlockRows.length > 0 && (
                  <p><span className="text-muted-foreground w-28 inline-block">Block-Zeilen:</span> <span className="font-mono">{emp.rawSource.mergedBlockRows.join(', ')}</span></p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Monatstotale (Roh)</p>
                <MonatsTotaleRow totals={emp.totals} />
              </div>
              {emp.warnings.filter(w => w.severity === 'info').length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Technische Hinweise</p>
                  <WarnList warnings={emp.warnings.filter(w => w.severity === 'info')} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmployeeCard({
  emp,
  onToggleSelect,
}: {
  emp: PreviewEmployee;
  onToggleSelect: (id: string) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);

  const totals     = emp.totals;
  const calc       = totals.calculatedTotalHours;
  const valid      = totals.totalsValidated;
  const diff       = totals.totalsDiff;
  const warnCount  = emp.warnings.filter(w => w.severity !== 'info').length;
  const activeDays = emp.days.filter(d => d.shifts.length > 0).length;
  const absCount   = emp.days.filter(d => !!d.absenceCode).length;
  const vacCount   = emp.days.filter(d => d.absenceCode === 'FE').length;
  const sickCount  = emp.days.filter(d => d.absenceCode === 'KR').length;

  return (
    <>
      {showDetail && <EmployeeDetailModal emp={emp} onClose={() => setShowDetail(false)} />}
      <div className={cn(
        'rounded-lg border bg-card transition-shadow hover:shadow-sm',
        !emp.importSelected             ? 'border-dashed border-muted-foreground/30 opacity-60' :
        emp.importStatus === 'excluded' ? 'border-red-200/60 opacity-70' :
        emp.importStatus === 'check'    ? 'border-yellow-200' :
        'border-border',
      )}>
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Checkbox */}
          <input
            type="checkbox"
            checked={emp.importSelected}
            disabled={emp.importStatus === 'excluded'}
            onChange={() => onToggleSelect(emp.tempId)}
            className="h-4 w-4 rounded border-border cursor-pointer shrink-0"
          />

          {/* Left: Name + meta */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{emp.name ?? <span className="text-red-500 italic">Kein Name</span>}</span>
              <StatusBadge status={emp.importStatus} />
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap text-[11px] text-muted-foreground">
              {emp.department && <span>{emp.department}</span>}
              {emp.costCenter && <span className="font-mono bg-muted/50 rounded px-1.5 py-0.5">{emp.costCenter}</span>}
            </div>
          </div>

          {/* Middle: hours + days + absences */}
          <div className="hidden sm:flex flex-col items-center gap-0.5 min-w-[120px]">
            <span className="font-mono font-bold text-sm">{formatHours(calc)}</span>
            <div className="flex gap-2 text-[10px] text-muted-foreground">
              <span>{activeDays} Arbeitstage</span>
              {absCount > 0 && <span>· {absCount} Abs.</span>}
            </div>
            {(vacCount > 0 || sickCount > 0) && (
              <div className="flex gap-1 mt-0.5">
                {vacCount  > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 font-semibold">{vacCount} FE</span>}
                {sickCount > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-50 border border-orange-200 text-orange-700 font-semibold">{sickCount} KR</span>}
              </div>
            )}
          </div>

          {/* Right: verification badge + button */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:block">
              <VerificationBadge result={computeVerification(emp)} status={emp.importStatus} />
            </div>
            <button
              onClick={() => setShowDetail(true)}
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors font-medium whitespace-nowrap"
            >
              Details
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MONATSKETTEN-PRÜFUNG ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function MonthChainingValidation({ sessions }: { sessions: LoadedSession[] }) {
  if (sessions.length < 2) return null;

  // Sort sessions by year + month
  const sorted = [...sessions].sort((a, b) => {
    const ya = (a.session.year ?? 0) * 100 + (a.session.month ?? 0);
    const yb = (b.session.year ?? 0) * 100 + (b.session.month ?? 0);
    return ya - yb;
  });

  function parseBalance(s: string | null | undefined): number | null {
    if (!s) return null;
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const m = abs.match(/^(\d+):(\d+)$/);
    if (m) {
      const v = parseInt(m[1]) + parseInt(m[2]) / 60;
      return Math.round((neg ? -v : v) * 100) / 100;
    }
    const n = parseFloat(abs.replace(',', '.'));
    return isNaN(n) ? null : Math.round((neg ? -n : n) * 100) / 100;
  }

  function balanceDiff(closing?: string | null, opening?: string | null): number | null {
    const c = parseBalance(closing);
    const o = parseBalance(opening);
    if (c === null || o === null) return null;
    return Math.round(Math.abs(c - o) * 100) / 100;
  }

  type ChainAcctKey = 'hours' | 'vacation' | 'holiday' | 'overtime';
  const CHAIN_ACCTS: { key: ChainAcctKey; label: string }[] = [
    { key: 'hours',    label: 'Stunden' },
    { key: 'vacation', label: 'Ferien' },
    { key: 'holiday',  label: 'Feiertage' },
    { key: 'overtime', label: 'Überzeit' },
  ];

  // Collect all unique employee names across sessions
  const allNames = Array.from(new Set(
    sorted.flatMap(s => s.localEmployees.map(e => e.name).filter(Boolean) as string[])
  )).sort();

  type ChainCheck = {
    monthPair: string;
    acct: ChainAcctKey;
    acctLabel: string;
    closing: string | null;
    opening: string | null;
    diffVal: number | null;
    ok: boolean;
  };
  type EmpChain = { name: string; checks: ChainCheck[] };

  const chains: EmpChain[] = [];
  for (const name of allNames) {
    const checks: ChainCheck[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const mA = sorted[i];
      const mB = sorted[i + 1];
      const labelPair = `${mA.session.monthName ?? '?'} → ${mB.session.monthName ?? '?'}`;
      const empA = mA.localEmployees.find(e => e.name === name);
      const empB = mB.localEmployees.find(e => e.name === name);
      if (!empA?.monthlyAccounts && !empB?.monthlyAccounts) continue;
      for (const { key, label: aLabel } of CHAIN_ACCTS) {
        const closing = empA?.monthlyAccounts?.[key]?.closingBalance;
        const opening = empB?.monthlyAccounts?.[key]?.openingBalance;
        if (!closing && !opening) continue;
        const d = balanceDiff(closing, opening);
        checks.push({
          monthPair: labelPair,
          acct:      key,
          acctLabel: aLabel,
          closing:   closing ?? null,
          opening:   opening ?? null,
          diffVal:   d,
          ok:        d !== null && d < 0.1,
        });
      }
    }
    if (checks.length > 0) chains.push({ name, checks });
  }

  if (!chains.length) return null;

  const totalChecks = chains.reduce((s, c) => s + c.checks.length, 0);
  const okChecks    = chains.reduce((s, c) => s + c.checks.filter(ch => ch.ok).length, 0);
  const badChecks   = totalChecks - okChecks;

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between gap-4 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Monatsketten-Prüfung
        </span>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-green-600 font-semibold">✓ {okChecks} OK</span>
          {badChecks > 0 && (
            <span className="text-yellow-600 font-semibold">⚠ {badChecks} Prüfen</span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              {['Mitarbeiter', 'Zeitraum', 'Konto', 'Endsaldo', 'Vorsaldo', 'Diff.', 'Status'].map(h => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chains.flatMap(({ name, checks }) =>
              checks.map((ch, i) => (
                <tr
                  key={`${name}-${ch.monthPair}-${ch.acct}`}
                  className={cn('border-b border-border/50 transition-colors',
                    ch.ok       ? 'hover:bg-muted/10'
                    : ch.diffVal !== null ? 'bg-yellow-50/40 hover:bg-yellow-50/60 dark:bg-yellow-900/10'
                    : 'hover:bg-muted/10',
                  )}
                >
                  <td className="px-3 py-1.5 font-semibold whitespace-nowrap">
                    {i === 0 ? name : ''}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{ch.monthPair}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{ch.acctLabel}</td>
                  <td className="px-3 py-1.5 font-mono">{ch.closing ?? <span className="text-muted-foreground/40">—</span>}</td>
                  <td className="px-3 py-1.5 font-mono">{ch.opening ?? <span className="text-muted-foreground/40">—</span>}</td>
                  <td className="px-3 py-1.5 font-mono">
                    {ch.diffVal !== null
                      ? <span className={ch.ok ? 'text-green-600' : 'text-yellow-600 font-semibold'}>
                          {ch.ok ? '0.00' : `±${Number(ch.diffVal).toFixed(2)}`}
                        </span>
                      : <span className="text-muted-foreground/40">—</span>
                    }
                  </td>
                  <td className="px-3 py-1.5">
                    {ch.ok
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-green-200 bg-green-50 text-green-700 font-semibold dark:bg-green-900/20 dark:border-green-700 dark:text-green-400">OK</span>
                      : ch.diffVal !== null
                      ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-yellow-200 bg-yellow-50 text-yellow-700 font-semibold">⚠ Prüfen</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground font-semibold">—</span>
                    }
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
  const verResults  = session.employees.map(e => computeVerification(e));
  const verified    = verResults.filter(r => r.verified).length;
  const excluded    = session.employees.filter(e => e.importStatus === 'excluded').length;
  const needsCheck  = session.employees.length - verified;
  const selected    = session.employees.filter(e => e.importSelected).length;
  const totalCalcH  = verResults.reduce((s, r) => s + (r.calcHours ?? 0), 0);
  const totalMirusH = verResults.reduce((s, r) => s + (r.mirusHours ?? 0), 0);
  const totalDiff   = Math.abs(totalCalcH - totalMirusH);

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
      <div className={cn(
        'grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border px-4 py-3',
        verified === session.employees.length
          ? 'border-green-200 bg-green-50/20'
          : 'border-border/60 bg-muted/10',
      )}>
        <StatBox label="100 % verifiziert"  value={`${verified} / ${session.employees.length}`} color={verified === session.employees.length ? 'green' : 'default'} />
        <StatBox label="Prüfung nötig"      value={String(Math.max(0, needsCheck - excluded))}  color={needsCheck - excluded > 0 ? 'yellow' : 'green'} />
        <StatBox label="Blockiert"          value={String(excluded)}    color={excluded > 0 ? 'red' : 'default'} />
        <StatBox label="Differenz gesamt"   value={`${totalDiff.toFixed(2)} h`} color={totalDiff < 0.1 ? 'green' : 'yellow'} />
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
        <StatBox label="Ausgewählt"       value={`${selected} / ${session.employees.length}`} />
        <StatBox label="Stunden (berechn.)" value={formatHours(totalCalcH)} />
        <StatBox label="Mirus-Total"      value={formatHours(totalMirusH)} />
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
  onSendToReview,
}: {
  session:        PreviewImportSession;
  onExportJson:   () => void;
  onSendToReview: () => void;
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
          { label: 'Ausgewählt',     value: `${selected.length} MA` },
          { label: 'Ausgeschlossen', value: `${excluded.length} MA` },
          { label: 'Tageszeilen',    value: String(totalDays) },
          { label: 'Stunden total',  value: formatHours(totalH) },
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
          onClick={onSendToReview}
          className="px-4 py-2 rounded text-sm font-semibold bg-foreground text-background hover:opacity-90 transition-opacity"
        >
          Zum Review öffnen →
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPTSEITE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Multi-Session State ─────────────────────────────────────────────────────

interface LoadedSession {
  id:             string;
  session:        PreviewImportSession;
  localEmployees: PreviewEmployee[];
  localRestaurant: string | null;
}

// ─── Session Comparison Table ─────────────────────────────────────────────────

function SessionComparisonTable({
  sessions,
  activeId,
  onSwitch,
  onRemove,
}: {
  sessions:  LoadedSession[];
  activeId:  string | null;
  onSwitch:  (id: string) => void;
  onRemove:  (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Geladene Dateien — {sessions.length} Monat{sessions.length !== 1 ? 'e' : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border bg-muted/10">
              {['Monat', 'Restaurant', 'Datei', 'MA', 'Importfähig', 'Prüfen', 'Blockiert', 'Ø Qualität', 'Stunden', 'Warnungen', ''].map(h => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.map(({ id, session: s, localEmployees: emps, localRestaurant }) => {
              const restaurant = localRestaurant ?? s.restaurant;
              const ready    = emps.filter(e => e.importStatus === 'ready').length;
              const check    = emps.filter(e => e.importStatus === 'check').length;
              const excluded = emps.filter(e => e.importStatus === 'excluded').length;
              const warns    = emps.flatMap(e => e.warnings).filter(w => w.severity === 'warning' || w.severity === 'error').length;
              const avgQ     = emps.length ? Math.round(emps.reduce((a, e) => a + e.quality, 0) / emps.length) : 0;
              const totalH   = Math.round(emps.reduce((a, e) => a + (e.totals.calculatedTotalHours ?? 0), 0) * 10) / 10;
              const isActive = id === activeId;
              return (
                <tr
                  key={id}
                  onClick={() => onSwitch(id)}
                  className={cn(
                    'border-b border-border/50 cursor-pointer transition-colors',
                    isActive ? 'bg-blue-50/60 dark:bg-blue-900/10' : 'hover:bg-muted/20',
                  )}
                >
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">
                    {s.monthName ?? '—'} {s.year ?? ''}
                    {isActive && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-blue-100 border border-blue-200 text-blue-700 font-bold">aktiv</span>}
                  </td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{restaurant ?? <span className="text-yellow-600 font-semibold">Wählen</span>}</td>
                  <td className="px-3 py-2 text-muted-foreground max-w-[160px] truncate">{s.sourceFileName}</td>
                  <td className="px-3 py-2 font-mono font-semibold">{emps.length}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-green-600">{ready}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-yellow-600">{check}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-red-600">{excluded}</td>
                  <td className="px-3 py-2 font-mono font-semibold">
                    <span className={avgQ >= 90 ? 'text-green-600' : avgQ >= 80 ? 'text-yellow-600' : 'text-red-600'}>{avgQ}%</span>
                  </td>
                  <td className="px-3 py-2 font-mono">{formatHours(totalH)}</td>
                  <td className="px-3 py-2 font-mono">{warns > 0 ? <span className="text-yellow-600">⚠ {warns}</span> : <span className="text-green-600">✓ 0</span>}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={e => { e.stopPropagation(); onRemove(id); }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-red-50 hover:border-red-200 hover:text-red-600 transition-colors text-muted-foreground"
                      title="Entfernen"
                    >✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function MirusImportPreview() {
  const [loadedSessions, setLoadedSessions] = useState<LoadedSession[]>([]);
  const [activeId,       setActiveId]       = useState<string | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const parsed  = await parseMirusExcel(file);
      const session = buildPreviewSession(parsed, file);
      const entry: LoadedSession = {
        id:             session.id,
        session,
        localEmployees: session.employees,
        localRestaurant: null,
      };
      setLoadedSessions(prev => {
        // Gleiche Datei nicht doppelt laden (gleicher Hash / Name+Monat)
        const dup = prev.find(s => s.session.sourceFileName === session.sourceFileName &&
                                   s.session.month === session.month &&
                                   s.session.year  === session.year);
        if (dup) return prev.map(s => s.id === dup.id ? entry : s);
        return [...prev, entry];
      });
      setActiveId(session.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[MirusImportPreview] handleFile Fehler:', e);
      setError(`Parsing-Fehler: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateActive = useCallback((updater: (entry: LoadedSession) => LoadedSession) => {
    setLoadedSessions(prev => prev.map(s => s.id === activeId ? updater(s) : s));
  }, [activeId]);

  const toggleSelect = useCallback((empId: string) => {
    updateActive(entry => ({
      ...entry,
      localEmployees: entry.localEmployees.map(e =>
        e.tempId === empId ? { ...e, importSelected: !e.importSelected } : e
      ),
    }));
  }, [updateActive]);

  const setLocalRestaurant = useCallback((r: string) => {
    updateActive(entry => ({ ...entry, localRestaurant: r }));
  }, [updateActive]);

  const selectAll = () => updateActive(entry => ({
    ...entry,
    localEmployees: entry.localEmployees.map(e =>
      e.importStatus !== 'excluded' ? { ...e, importSelected: true } : e
    ),
  }));
  const deselectWarnings = () => updateActive(entry => ({
    ...entry,
    localEmployees: entry.localEmployees.map(e =>
      e.warnings.some(w => w.severity !== 'info') ? { ...e, importSelected: false } : e
    ),
  }));
  const selectReadyOnly = () => updateActive(entry => ({
    ...entry,
    localEmployees: entry.localEmployees.map(e => ({ ...e, importSelected: e.importStatus === 'ready' })),
  }));

  const activeEntry = loadedSessions.find(s => s.id === activeId) ?? null;

  const currentSession: PreviewImportSession | null = activeEntry
    ? {
        ...activeEntry.session,
        restaurant:    activeEntry.localRestaurant ?? activeEntry.session.restaurant,
        employees:     activeEntry.localEmployees,
        selectedCount: activeEntry.localEmployees.filter(e => e.importSelected).length,
      }
    : null;

  const localEmployees = activeEntry?.localEmployees ?? [];

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

  const handleSendToReview = () => {
    if (!currentSession) return;
    localStorage.setItem('mirus_review_session', JSON.stringify(currentSession));
    window.location.href = '/mirus-review';
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="border-b border-border bg-card/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 pt-3 pb-2 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-base font-bold">Monatsabschluss-Assistent</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold">
              Kein Supabase-Write
            </span>
          </div>
          <div className="flex gap-2">
            <a href="/mirus-excel-test"
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors text-muted-foreground">
              Diagnose
            </a>
            <a href="/mirus-review"
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors font-medium">
              Weiter zum Review →
            </a>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <WizardBar step={loadedSessions.length > 0 ? 2 : 1} />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">

        {/* Vergleichstabelle */}
        {loadedSessions.length > 0 && (
          <SessionComparisonTable
            sessions={loadedSessions}
            activeId={activeId}
            onSwitch={setActiveId}
            onRemove={id => {
              setLoadedSessions(prev => prev.filter(s => s.id !== id));
              if (activeId === id) {
                const remaining = loadedSessions.filter(s => s.id !== id);
                setActiveId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
              }
            }}
          />
        )}

        {/* Monatsketten-Prüfung: erst ab 2 geladenen Dateien */}
        {loadedSessions.length >= 2 && (
          <details className="rounded-lg border overflow-hidden">
            <summary className="px-4 py-2.5 bg-card cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/10 select-none flex items-center gap-2">
              <span>Monatsketten-Prüfung</span>
              <span className="text-muted-foreground/50 normal-case font-normal">(aufklappen)</span>
            </summary>
            <div>
              <MonthChainingValidation sessions={loadedSessions} />
            </div>
          </details>
        )}

        {/* Upload — immer sichtbar (kompakt wenn Sessions geladen) */}
        {loadedSessions.length === 0 ? (
          !loading && (
            <div className="max-w-xl mx-auto mt-12">
              <UploadZone onFile={handleFile} />
            </div>
          )
        ) : (
          <div className="flex items-center gap-3">
            <label className={cn(
              'flex items-center gap-2 px-4 py-2 rounded border text-sm font-medium cursor-pointer transition-colors',
              loading ? 'opacity-50 cursor-not-allowed' : 'border-border hover:bg-muted/40',
            )}>
              <span>+ Weiteren Monat hinzufügen</span>
              <input
                type="file" accept=".xlsx,.xls" className="hidden"
                disabled={loading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              />
            </label>
            {loading && <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin inline-block" />
              Analysiere…
            </span>}
          </div>
        )}

        {/* Loading (initial) */}
        {loading && loadedSessions.length === 0 && (
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

        {/* Aktive Session Detail */}
        {currentSession && (
          <>
            <SummaryPanel session={currentSession} onRestaurantChange={setLocalRestaurant} />

            {/* Auswahl-Controls */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground font-semibold mr-1">Auswahl:</span>
              {[
                { label: 'Alle auswählen',            fn: selectAll },
                { label: 'Alle mit Warnung abwählen', fn: deselectWarnings },
                { label: 'Nur importfähige',           fn: selectReadyOnly },
              ].map(({ label, fn }) => (
                <button key={label} onClick={fn}
                  className="text-[11px] px-2.5 py-1 rounded border border-border hover:bg-muted/40 transition-colors">
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
                <EmployeeCard key={emp.tempId} emp={emp} onToggleSelect={toggleSelect} />
              ))}
            </div>

            {/* Import Summary */}
            <ImportSummary
              session={currentSession}
              onExportJson={handleExportJson}
              onSendToReview={handleSendToReview}
            />
          </>
        )}

        {/* Kein aktiver Monat gewählt */}
        {loadedSessions.length > 0 && !currentSession && !loading && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            Monat in der Tabelle oben auswählen
          </div>
        )}
      </div>
    </div>
  );
}
