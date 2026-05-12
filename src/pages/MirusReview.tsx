/**
 * Mirus Review — /mirus-review
 * ==============================
 * Professionelles HR-Review-Tool für Monatsblätter.
 * Liest Session aus localStorage (gesetzt von /mirus-import-preview).
 * KEIN Supabase-Write — rein lokaler State.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { isNoTimeTracking } from '@/lib/no-time-tracking';
import type { PreviewImportSession, PreviewEmployee, PreviewDayEntry, PreviewShift, PreviewMonthlyAccounts } from '@/types/mirus-import-preview';
import type {
  ReviewState, ReviewEmployeeState, ReviewAction,
  ReviewStatus, DistributionStatus, AuditEntry, DayOverride,
} from '@/types/mirus-review';
import {
  makeAuditEntry, initEmployeeState,
  REVIEW_STATUS_LABELS, DISTRIBUTION_STATUS_LABELS,
} from '@/types/mirus-review';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HILFSFUNKTIONEN ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const ACTOR = 'Admin';  // mock — später aus Auth

function initReviewState(session: PreviewImportSession): ReviewState {
  const employeeStates: Record<string, ReviewEmployeeState> = {};
  for (const emp of session.employees) {
    employeeStates[emp.tempId] = {
      ...initEmployeeState(emp.tempId),
      auditLog: [makeAuditEntry('System', 'Session geladen', `Import-Vorschau: ${session.sourceFileName}`)],
    };
  }
  return {
    session,
    reviewStatus: 'in_review',
    employeeStates,
    globalComment: '',
    globalAuditLog: [makeAuditEntry('System', 'Review gestartet', `Datei: ${session.sourceFileName}`)],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function calcStats(state: ReviewState) {
  const emps    = state.session.employees;
  const states  = Object.values(state.employeeStates);
  const ready   = emps.filter(e => e.importStatus === 'ready').length;
  const check   = emps.filter(e => e.importStatus === 'check').length;
  const blocked = emps.filter(e => e.importStatus === 'excluded').length;
  const accepted = states.filter(s => s.action === 'accepted').length;
  const held    = states.filter(s => s.action === 'held').length;
  const excl    = states.filter(s => s.action === 'excluded').length;
  const corr    = states.filter(s => s.action === 'correction_needed').length;
  const noMatch = emps.filter(e => !e.name).length;
  const totalsDev = emps.filter(e => e.totals.totalsDiff !== undefined && (e.totals.totalsDiff ?? 0) > 3).length;
  const openWarns = emps.flatMap(e => e.warnings).filter(w => w.severity === 'warning' || w.severity === 'error').length;
  const avgQ    = emps.length ? Math.round(emps.reduce((a, e) => a + e.quality, 0) / emps.length) : 0;
  const totalH  = Math.round(emps.reduce((a, e) => a + (e.totals.calculatedTotalHours ?? 0), 0) * 10) / 10;
  const reviewed = states.filter(s => s.action !== null).length;
  return { ready, check, blocked, accepted, held, excl, corr, noMatch, totalsDev, openWarns, avgQ, totalH, reviewed, total: emps.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UI-HELFER ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, sub, color = 'default' }: {
  label: string; value: string | number; sub?: string; color?: 'green' | 'yellow' | 'red' | 'blue' | 'default';
}) {
  const cls = { green: 'text-green-600', yellow: 'text-yellow-600', red: 'text-red-500', blue: 'text-blue-600', default: 'text-foreground' }[color];
  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-xl font-bold font-mono', cls)}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

const ACTION_MAP: Record<ReviewAction, { label: string; cls: string; icon: string }> = {
  accepted:           { label: 'Akzeptiert',     cls: 'bg-green-50 border-green-300 text-green-700 dark:bg-green-900/20 dark:text-green-400',   icon: '✓' },
  held:               { label: 'Zurückgestellt', cls: 'bg-yellow-50 border-yellow-300 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400', icon: '⏸' },
  excluded:           { label: 'Ausgeschlossen', cls: 'bg-red-50 border-red-300 text-red-700 dark:bg-red-900/20 dark:text-red-400',           icon: '✕' },
  correction_needed:  { label: 'Korrektur',      cls: 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',      icon: '✎' },
};

const DIST_MAP: Record<DistributionStatus, { label: string; cls: string }> = {
  not_sent:  { label: 'Nicht gesendet', cls: 'text-muted-foreground' },
  sent:      { label: 'Gesendet',       cls: 'text-blue-600' },
  disputed:  { label: 'Beanstandet',    cls: 'text-red-600' },
  confirmed: { label: 'Bestätigt',      cls: 'text-green-600' },
};

const STATUS_FLOW: ReviewStatus[] = ['preview', 'in_review', 'approved', 'distributed', 'archived'];

function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const map: Record<ReviewStatus, string> = {
    preview:     'bg-gray-100 text-gray-600 border-gray-200',
    in_review:   'bg-yellow-50 text-yellow-700 border-yellow-200',
    approved:    'bg-green-50 text-green-700 border-green-200',
    distributed: 'bg-blue-50 text-blue-700 border-blue-200',
    archived:    'bg-muted text-muted-foreground border-border',
  };
  return (
    <span className={cn('text-[11px] px-2.5 py-1 rounded border font-semibold', map[status])}>
      {REVIEW_STATUS_LABELS[status]}
    </span>
  );
}

function QualityDot({ q }: { q: number }) {
  const cls = q >= 90 ? 'text-green-600' : q >= 80 ? 'text-yellow-600' : 'text-red-600';
  return <span className={cn('text-[11px] font-mono font-bold', cls)}>{q}%</span>;
}

function formatHours(value: number | null | undefined): string {
  if (value == null) return '—';
  return Number(value).toFixed(2) + ' h';
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DAY CORRECTION MODAL ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface ModalDayEdit {
  shifts:       { from: string; to: string }[];
  breakMinutes: string;
  absenceCode:  string;
  notes:        string;
  comment:      string;
}

function DayCorrectionModal({
  emp,
  day,
  existingOverride,
  onSave,
  onClose,
}: {
  emp:              PreviewEmployee;
  day:              PreviewDayEntry;
  existingOverride: DayOverride | null;
  onSave:           (override: DayOverride) => void;
  onClose:          () => void;
}) {
  const base = existingOverride ?? day;
  const [form, setForm] = useState<ModalDayEdit>({
    shifts:       (base.shifts ?? []).map(s => ({ from: s.from, to: s.to })),
    breakMinutes: base.breakMinutes != null ? String(base.breakMinutes) : '',
    absenceCode:  base.absenceCode ?? '',
    notes:        base.notes ?? '',
    comment:      existingOverride?.comment ?? '',
  });
  const [commentErr, setCommentErr] = useState(false);

  const handleSave = () => {
    if (!form.comment.trim()) { setCommentErr(true); return; }
    onSave({
      date:         day.date ?? '',
      shifts:       form.shifts.filter(s => s.from && s.to),
      breakMinutes: form.breakMinutes ? parseInt(form.breakMinutes) : null,
      absenceCode:  form.absenceCode || null,
      notes:        form.notes || null,
      comment:      form.comment.trim(),
    });
  };

  const addShift = () => setForm(f => ({ ...f, shifts: [...f.shifts, { from: '', to: '' }] }));
  const removeShift = (i: number) => setForm(f => ({ ...f, shifts: f.shifts.filter((_, j) => j !== i) }));
  const updateShift = (i: number, field: 'from' | 'to', val: string) =>
    setForm(f => ({ ...f, shifts: f.shifts.map((s, j) => j === i ? { ...s, [field]: val } : s) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg space-y-4 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold">Tageskorrektur</h3>
            <p className="text-[12px] text-muted-foreground mt-0.5">{emp.name} — {day.date} {day.weekday ? `(${day.weekday})` : ''}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">✕</button>
        </div>

        {/* Shifts */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Zeitblöcke</p>
          {form.shifts.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="time" value={s.from} onChange={e => updateShift(i, 'from', e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 flex-1 bg-background" />
              <span className="text-muted-foreground text-sm">–</span>
              <input type="time" value={s.to} onChange={e => updateShift(i, 'to', e.target.value)}
                className="text-sm border border-border rounded px-2 py-1 flex-1 bg-background" />
              <button onClick={() => removeShift(i)} className="text-muted-foreground hover:text-red-600 text-sm">✕</button>
            </div>
          ))}
          <button onClick={addShift} className="text-[11px] text-blue-600 hover:underline">+ Zeitblock hinzufügen</button>
        </div>

        {/* Pause + Absenz */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pause (Min.)</label>
            <input type="number" min="0" max="240" value={form.breakMinutes}
              onChange={e => setForm(f => ({ ...f, breakMinutes: e.target.value }))}
              className="text-sm border border-border rounded px-2 py-1 w-full bg-background" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Absenzcode</label>
            <select value={form.absenceCode} onChange={e => setForm(f => ({ ...f, absenceCode: e.target.value }))}
              className="text-sm border border-border rounded px-2 py-1 w-full bg-background">
              <option value="">—</option>
              {['FE', 'KR', 'KO', 'FR', 'Unfall', 'Feiertag', 'Kompensation'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Bemerkung */}
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bemerkung</label>
          <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="text-sm border border-border rounded px-2 py-1 w-full bg-background" />
        </div>

        {/* Kommentar (Pflicht) */}
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Kommentar <span className="text-red-500">*</span> (Pflichtfeld)
          </label>
          <textarea
            rows={2}
            value={form.comment}
            onChange={e => { setForm(f => ({ ...f, comment: e.target.value })); setCommentErr(false); }}
            placeholder="Begründung für die Änderung…"
            className={cn('text-sm border rounded px-2 py-1.5 w-full bg-background resize-none', commentErr ? 'border-red-400' : 'border-border')}
          />
          {commentErr && <p className="text-[11px] text-red-500">Kommentar ist Pflichtfeld.</p>}
        </div>

        <div className="flex gap-3 pt-1 border-t border-border">
          <button onClick={handleSave}
            className="flex-1 px-4 py-2 rounded bg-foreground text-background text-sm font-semibold hover:opacity-90 transition-opacity">
            Änderung speichern
          </button>
          <button onClick={onClose}
            className="px-4 py-2 rounded border border-border text-sm hover:bg-muted/40 transition-colors">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ACCOUNTS PANEL (Review) ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ReviewAccountsPanel({ accounts }: { accounts: PreviewMonthlyAccounts | undefined }) {
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
          Keine Monatskonten erkannt — Layout möglicherweise nicht unterstützt.
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EMPLOYEE REVIEW CARD ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function EmployeeReviewCard({
  emp,
  empState,
  onAction,
  onSetMatch,
  onOpenCorrection,
  onSetDistribution,
}: {
  emp:                PreviewEmployee;
  empState:           ReviewEmployeeState;
  onAction:           (action: ReviewAction | null) => void;
  onSetMatch:         (name: string, remember: boolean) => void;
  onOpenCorrection:   (day: PreviewDayEntry) => void;
  onSetDistribution:  (status: DistributionStatus) => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [tab,        setTab]        = useState<'days' | 'accounts' | 'audit' | 'distribute'>('days');
  const [matchInput, setMatchInput] = useState(empState.matchedName ?? '');
  const [remember,   setRemember]   = useState(empState.rememberMatch);

  const totals    = emp.totals;
  const calc      = totals.calculatedTotalHours;
  const diff      = totals.totalsDiff;
  const validated = totals.totalsValidated;
  const warns     = emp.warnings.filter(w => w.severity !== 'info');
  const overrideCount = Object.keys(empState.dayOverrides).length;

  const action         = empState.action;
  const actionInfo     = action ? ACTION_MAP[action] : null;
  const noTimeTracking = isNoTimeTracking(emp.name) && emp.days.filter(d => d.shifts.length > 0).length === 0;

  return (
    <div className={cn(
      'rounded-lg border bg-card transition-shadow',
      action === 'accepted'          ? 'border-green-200'  :
      action === 'held'              ? 'border-yellow-200' :
      action === 'excluded'          ? 'border-red-200 opacity-70' :
      action === 'correction_needed' ? 'border-blue-200'   :
      emp.importStatus === 'check'   ? 'border-yellow-100' :
      'border-border',
      open && 'shadow-md',
    )}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Status-Indikator */}
        <div className={cn('w-1.5 h-8 rounded-full shrink-0',
          action === 'accepted' ? 'bg-green-400' :
          action === 'held'     ? 'bg-yellow-400' :
          action === 'excluded' ? 'bg-red-400' :
          action === 'correction_needed' ? 'bg-blue-400' :
          emp.importStatus === 'check' ? 'bg-yellow-200' :
          'bg-muted',
        )} />

        <button onClick={() => setOpen(v => !v)} className="flex-1 flex items-center gap-4 text-left min-w-0">
          {/* Name + Meta */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm truncate">{emp.name ?? <span className="text-red-500 italic">Kein Name</span>}</span>
              {actionInfo && (
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded border font-semibold', actionInfo.cls)}>
                  {actionInfo.icon} {actionInfo.label}
                </span>
              )}
              {warns.length > 0 && !action && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold">
                  ⚠ {warns.length}
                </span>
              )}
              {overrideCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-50 border-blue-200 text-blue-700 font-semibold">
                  ✎ {overrideCount} Korrektur{overrideCount !== 1 ? 'en' : ''}
                </span>
              )}
              {noTimeTracking && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-50 border-blue-200 text-blue-700 font-semibold">
                  Keine Zeiterfassung
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              {emp.department  && <span className="text-[11px] text-muted-foreground">{emp.department}</span>}
              {emp.costCenter  && <span className="text-[11px] bg-muted/60 rounded px-1.5 py-0.5 font-mono">{emp.costCenter}</span>}
              {emp.weeklyHours && <span className="text-[11px] text-muted-foreground">{emp.weeklyHours} h/Wo</span>}
            </div>
          </div>

          {/* Stats rechts */}
          <div className="shrink-0 flex flex-col items-end gap-1 min-w-[140px]">
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              <span>{emp.days.length} Tage</span>
              {totals.sollStunden && <span>Soll: {totals.sollStunden}</span>}
            </div>
            {/* Plausibilitätsbox */}
            {calc !== undefined && (
              <div className={cn(
                'flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-mono',
                validated ? 'border-green-200 bg-green-50/70 text-green-700' :
                diff !== undefined && diff > 3 ? 'border-red-200 bg-red-50/70 text-red-700' :
                'border-border bg-muted/40 text-muted-foreground',
              )}>
                <span className="font-bold">{formatHours(calc)}</span>
                {totals.totalHours != null && <span className="opacity-60">/ {formatHours(totals.totalHours)}</span>}
                {validated ? <span className="text-green-600 font-bold">✓</span>
                  : diff !== undefined && <span>±{formatHours(diff)}</span>}
              </div>
            )}
            <QualityDot q={emp.quality} />
          </div>

          <span className="text-muted-foreground text-[11px] shrink-0">{open ? '▲' : '▼'}</span>
        </button>
      </div>

      {/* ── Aktionsleiste ─────────────────────────────────────────────────── */}
      <div className={cn('border-t border-border/50 px-4 py-2 flex flex-wrap items-center gap-2',
        action ? 'bg-muted/5' : 'bg-muted/10',
      )}>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1 shrink-0">Aktion:</span>
        {(['accepted', 'held', 'excluded', 'correction_needed'] as ReviewAction[]).map(a => (
          <button
            key={a}
            onClick={() => onAction(action === a ? null : a)}
            className={cn(
              'text-[11px] px-2.5 py-1 rounded border font-medium transition-all',
              action === a ? ACTION_MAP[a].cls + ' font-bold' : 'border-border text-muted-foreground hover:bg-muted/40',
            )}
          >
            {ACTION_MAP[a].icon} {ACTION_MAP[a].label}
          </button>
        ))}

        {/* Distribution status */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">Versand:</span>
          <select
            value={empState.distributionStatus}
            onChange={e => onSetDistribution(e.target.value as DistributionStatus)}
            className={cn('text-[11px] border border-border rounded px-1.5 py-0.5 bg-background font-medium',
              DIST_MAP[empState.distributionStatus].cls)}
          >
            {Object.entries(DISTRIBUTION_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Expanded ──────────────────────────────────────────────────────── */}
      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">

          {/* Matching panel: wenn Name fehlt oder kein Match */}
          {(!emp.name || !empState.matchedName) && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50/40 px-4 py-3 space-y-2">
              <p className="text-[11px] font-semibold text-yellow-800">
                {!emp.name ? '⚠ Kein Name erkannt — manuelle Zuordnung erforderlich' : '⚠ Mitarbeiter noch nicht dem Personalstamm zugeordnet'}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={matchInput}
                  onChange={e => setMatchInput(e.target.value)}
                  placeholder="Name im Personalstamm suchen…"
                  className="text-sm border border-border rounded px-2 py-1 flex-1 bg-background"
                />
                <button
                  onClick={() => { if (matchInput.trim()) onSetMatch(matchInput.trim(), remember); }}
                  className="text-[11px] px-3 py-1.5 rounded border border-blue-300 bg-blue-50 text-blue-700 font-semibold hover:bg-blue-100 transition-colors"
                >
                  Zuordnen
                </button>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
                  className="rounded" />
                Für zukünftige Importe merken
              </label>
              {empState.matchedName && (
                <p className="text-[11px] text-green-700 font-semibold">
                  ✓ Zugeordnet: {empState.matchedName}
                </p>
              )}
            </div>
          )}

          {/* Warnungen */}
          {warns.length > 0 && (
            <div className="space-y-1">
              {warns.map((w, i) => (
                <div key={i} className={cn('flex gap-2 text-[11px] rounded px-3 py-1.5 border',
                  w.severity === 'error' ? 'border-red-200 bg-red-50/50 text-red-700' : 'border-yellow-200 bg-yellow-50/50 text-yellow-700',
                )}>
                  <span className="font-bold shrink-0">{w.severity === 'error' ? '✗' : '⚠'}</span>
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border pb-2">
            {(['days', 'accounts', 'audit', 'distribute'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={cn('text-[11px] px-3 py-1 rounded border font-medium transition-colors',
                  tab === t ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'days'       ? `Tage (${emp.days.length})`                        : null}
                {t === 'accounts'   ? 'Konten & Saldi'                                   : null}
                {t === 'audit'      ? `Änderungsprotokoll (${empState.auditLog.length})` : null}
                {t === 'distribute' ? 'Verteilung'                                        : null}
              </button>
            ))}
          </div>

          {/* Tage-Tab */}
          {tab === 'days' && (
            <div className="overflow-x-auto rounded border border-border/60">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-muted/10">
                    {['Datum', 'Tag', 'Zeitblöcke', 'Pause', 'Stunden', 'Absenz', 'Bemerkung', ''].map(h => (
                      <th key={h} className="px-2 py-1.5 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {emp.days.map((d, i) => {
                    const ov = empState.dayOverrides[d.date ?? ''];
                    const effectiveShifts  = ov?.shifts       ?? d.shifts;
                    const effectivePause   = ov?.breakMinutes ?? d.breakMinutes;
                    const effectiveAbsence = ov?.absenceCode  ?? d.absenceCode;
                    const effectiveNotes   = ov?.notes        ?? d.notes;
                    return (
                      <tr key={i} className={cn('border-b border-border/50 hover:bg-muted/20 transition-colors',
                        ov ? 'bg-blue-50/30' : effectiveAbsence ? 'bg-yellow-50/30' : '',
                      )}>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">{d.date ?? '—'}</td>
                        <td className="px-2 py-1 text-muted-foreground">{d.weekday ?? '—'}</td>
                        <td className="px-2 py-1">
                          {effectiveShifts.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {effectiveShifts.map((s, j) => (
                                <span key={j} className="font-mono bg-blue-50 border border-blue-100 rounded px-1 py-0.5 text-blue-800 whitespace-nowrap">
                                  {s.from}–{s.to}
                                </span>
                              ))}
                              {effectiveShifts.length > 1 && (
                                <span className="text-[9px] text-blue-600 font-semibold">{effectiveShifts.length} Blöcke</span>
                              )}
                            </div>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">{effectivePause != null ? `${effectivePause}'` : '—'}</td>
                        <td className="px-2 py-1 font-mono font-semibold whitespace-nowrap">
                          {formatHours(d.totalHours)}
                        </td>
                        <td className="px-2 py-1">
                          {effectiveAbsence ? (
                            <span className="bg-yellow-100 border border-yellow-200 text-yellow-800 rounded px-1 py-0.5 font-semibold">{effectiveAbsence}</span>
                          ) : '—'}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground max-w-[120px] truncate">{effectiveNotes ?? '—'}</td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => onOpenCorrection(d)}
                            className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700 transition-colors text-muted-foreground"
                            title="Korrigieren"
                          >✎</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {emp.days.length === 0 && (
                <p className="text-center py-6 text-[11px] text-muted-foreground italic">Keine Tageszeilen erkannt.</p>
              )}
            </div>
          )}

          {/* Konten-Tab */}
          {tab === 'accounts' && (
            <ReviewAccountsPanel accounts={emp.monthlyAccounts} />
          )}

          {/* Audit-Tab */}
          {tab === 'audit' && (
            <div className="space-y-2">
              {empState.auditLog.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">Keine Einträge.</p>
              ) : (
                [...empState.auditLog].reverse().map(entry => (
                  <div key={entry.id} className="flex gap-3 text-[11px] rounded border border-border/60 bg-muted/10 px-3 py-2">
                    <div className="shrink-0 text-muted-foreground min-w-[90px]">
                      <p className="font-semibold">{entry.who}</p>
                      <p>{new Date(entry.when).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground">{entry.what}</p>
                      {entry.comment && <p className="text-muted-foreground mt-0.5">{entry.comment}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Verteilungs-Tab */}
          {tab === 'distribute' && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Monatsblatt Versand</p>
              <div className="flex items-center gap-3">
                <div className={cn('text-sm font-semibold', DIST_MAP[empState.distributionStatus].cls)}>
                  {DISTRIBUTION_STATUS_LABELS[empState.distributionStatus]}
                </div>
                <div className="flex gap-2 ml-auto">
                  {(['not_sent', 'sent', 'disputed', 'confirmed'] as DistributionStatus[]).map(ds => (
                    <button
                      key={ds}
                      onClick={() => onSetDistribution(ds)}
                      className={cn('text-[11px] px-2.5 py-1 rounded border font-medium transition-colors',
                        empState.distributionStatus === ds ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >{DISTRIBUTION_STATUS_LABELS[ds]}</button>
                  ))}
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground border-t border-border/50 pt-2 space-y-1">
                <p>Persönlicher Link: <span className="font-mono bg-muted/60 px-1.5 py-0.5 rounded text-[10px]">/monatsblatt/{emp.tempId}</span></p>
                <p className="italic">WhatsApp-Versand wird im nächsten Schritt implementiert.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── REVIEW DASHBOARD ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ReviewDashboard({ state, onStatusChange }: {
  state:          ReviewState;
  onStatusChange: (s: ReviewStatus) => void;
}) {
  const stats = calcStats(state);
  const { session } = state;
  const restaurant = session.restaurant;

  return (
    <div className="space-y-4">
      {/* Kopfzeile */}
      <div className="rounded-lg border bg-card p-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-bold text-base">
              {session.monthName ?? '—'} {session.year ?? ''}
              {restaurant && <span className="ml-2 capitalize text-muted-foreground font-normal text-sm">— {restaurant}</span>}
            </h2>
            <ReviewStatusBadge status={state.reviewStatus} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">{session.sourceFileName}</p>
        </div>
        {/* Status-Workflow */}
        <div className="flex items-center gap-1.5">
          {STATUS_FLOW.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/40 text-[10px]">›</span>}
              <button
                onClick={() => onStatusChange(s)}
                className={cn('text-[11px] px-2.5 py-1 rounded border font-medium transition-all',
                  state.reviewStatus === s
                    ? 'bg-foreground text-background border-foreground'
                    : STATUS_FLOW.indexOf(s) < STATUS_FLOW.indexOf(state.reviewStatus)
                    ? 'border-border text-muted-foreground/50 line-through'
                    : 'border-border text-muted-foreground hover:bg-muted/40',
                )}
              >{REVIEW_STATUS_LABELS[s]}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Kennzahlen */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Geprüft"      value={`${stats.reviewed}/${stats.total}`} color={stats.reviewed === stats.total ? 'green' : 'yellow'} />
        <StatCard label="Akzeptiert"   value={stats.accepted}  color="green" />
        <StatCard label="Zurückgest."  value={stats.held}       color={stats.held > 0 ? 'yellow' : 'default'} />
        <StatCard label="Korrekturen"  value={stats.corr}       color={stats.corr > 0 ? 'blue' : 'default'} />
        <StatCard label="Ausgeschl."   value={stats.excl}       color={stats.excl > 0 ? 'red' : 'default'} />
        <StatCard label="Ø Qualität"   value={`${stats.avgQ}%`} color={stats.avgQ >= 90 ? 'green' : stats.avgQ >= 80 ? 'yellow' : 'red'} />
        <StatCard label="Std. total"   value={formatHours(stats.totalH)} />
        <StatCard label="Offene Warn." value={stats.openWarns}  color={stats.openWarns > 0 ? 'yellow' : 'green'} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPTSEITE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default function MirusReview() {
  const [reviewState, setReviewState] = useState<ReviewState | null>(null);
  const [loadError,   setLoadError]   = useState<string | null>(null);
  const [filter,      setFilter]      = useState<'all' | 'check' | 'accepted' | 'held' | 'unreviewed'>('all');
  const [corrModal,   setCorrModal]   = useState<{ emp: PreviewEmployee; day: PreviewDayEntry } | null>(null);

  // Load session from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('mirus_review_session');
      if (!raw) { setLoadError('Keine Session gefunden. Bitte zuerst eine Datei in /mirus-import-preview laden.'); return; }
      const session = JSON.parse(raw) as PreviewImportSession;
      setReviewState(initReviewState(session));
    } catch (e) {
      setLoadError('Session konnte nicht geladen werden: ' + String(e));
    }
  }, []);

  const updateEmpState = useCallback((tempId: string, updater: (s: ReviewEmployeeState) => ReviewEmployeeState) => {
    setReviewState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        updatedAt: new Date().toISOString(),
        employeeStates: {
          ...prev.employeeStates,
          [tempId]: updater(prev.employeeStates[tempId] ?? initEmployeeState(tempId)),
        },
      };
    });
  }, []);

  const handleAction = useCallback((tempId: string, empName: string | null, action: ReviewAction | null) => {
    updateEmpState(tempId, s => ({
      ...s,
      action,
      auditLog: [...s.auditLog, makeAuditEntry(ACTOR,
        action ? `Aktion: ${ACTION_MAP[action].label}` : 'Aktion zurückgesetzt',
        '',
      )],
    }));
  }, [updateEmpState]);

  const handleSetMatch = useCallback((tempId: string, empName: string | null, matchedName: string, remember: boolean) => {
    updateEmpState(tempId, s => ({
      ...s,
      matchedName,
      rememberMatch: remember,
      auditLog: [...s.auditLog, makeAuditEntry(ACTOR, `Zuordnung: ${matchedName}`, remember ? 'Für Zukunft gemerkt' : '')],
    }));
  }, [updateEmpState]);

  const handleSaveCorrection = useCallback((tempId: string, override: DayOverride) => {
    updateEmpState(tempId, s => ({
      ...s,
      dayOverrides: { ...s.dayOverrides, [override.date]: override },
      auditLog: [...s.auditLog, makeAuditEntry(ACTOR, `Tageskorrektur: ${override.date}`, override.comment)],
    }));
    setCorrModal(null);
  }, [updateEmpState]);

  const handleSetDistribution = useCallback((tempId: string, status: DistributionStatus) => {
    updateEmpState(tempId, s => ({
      ...s,
      distributionStatus: status,
      auditLog: [...s.auditLog, makeAuditEntry(ACTOR, `Versandstatus: ${DISTRIBUTION_STATUS_LABELS[status]}`, '')],
    }));
  }, [updateEmpState]);

  const handleStatusChange = (status: ReviewStatus) => {
    setReviewState(prev => prev ? {
      ...prev,
      reviewStatus: status,
      updatedAt: new Date().toISOString(),
      globalAuditLog: [...prev.globalAuditLog, makeAuditEntry(ACTOR, `Status → ${REVIEW_STATUS_LABELS[status]}`, '')],
    } : prev);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-red-600 font-semibold text-center max-w-md">{loadError}</p>
        <a href="/mirus-import-preview"
          className="px-4 py-2 rounded border border-border hover:bg-muted/40 transition-colors text-sm">
          ← Zurück zur Import-Vorschau
        </a>
      </div>
    );
  }

  if (!reviewState) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  const { session, employeeStates } = reviewState;

  // Filter
  const filteredEmps = session.employees.filter(emp => {
    const es = employeeStates[emp.tempId];
    if (filter === 'check')      return emp.importStatus === 'check';
    if (filter === 'accepted')   return es?.action === 'accepted';
    if (filter === 'held')       return es?.action === 'held';
    if (filter === 'unreviewed') return !es?.action;
    return true;
  }).sort((a, b) => {
    const priority = (emp: typeof a) => {
      const es = employeeStates[emp.tempId];
      if (emp.importStatus === 'check' && !es?.action) return 0;
      if (!es?.action) return 1;
      if (es.action === 'held') return 2;
      if (es.action === 'accepted') return 3;
      return 4;
    };
    return priority(a) - priority(b);
  });

  const stats = calcStats(reviewState);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="border-b border-border bg-card/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 pt-3 pb-2 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-base font-bold">Monatsabschluss-Assistent</span>
            <ReviewStatusBadge status={reviewState.reviewStatus} />
            <span className="text-[10px] px-2 py-0.5 rounded-full border bg-yellow-50 border-yellow-200 text-yellow-700 font-semibold">
              Kein Supabase-Write
            </span>
          </div>
          <div className="flex gap-2">
            <a href="/mirus-import-preview"
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors text-muted-foreground">
              ← Import-Vorschau
            </a>
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(reviewState, null, 2)], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = `mirus-review-${session.sourceFileName.replace(/\.[^.]+$/, '')}-${Date.now()}.json`;
                a.click(); URL.revokeObjectURL(url);
              }}
              className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted/40 transition-colors"
            >
              JSON exportieren
            </button>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <WizardBar step={3} />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">

        {/* Dashboard */}
        <ReviewDashboard state={reviewState} onStatusChange={handleStatusChange} />

        {/* Globales Audit-Log (aufklappbar) */}
        <details className="rounded-lg border bg-card">
          <summary className="px-4 py-3 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/10 select-none">
            Globales Änderungsprotokoll ({reviewState.globalAuditLog.length} Einträge)
          </summary>
          <div className="px-4 pb-4 space-y-2 border-t border-border">
            {[...reviewState.globalAuditLog].reverse().map(entry => (
              <div key={entry.id} className="flex gap-3 text-[11px] rounded border border-border/60 bg-muted/10 px-3 py-2 mt-2">
                <div className="shrink-0 text-muted-foreground min-w-[90px]">
                  <p className="font-semibold">{entry.who}</p>
                  <p>{new Date(entry.when).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}</p>
                </div>
                <div>
                  <p className="font-semibold text-foreground">{entry.what}</p>
                  {entry.comment && <p className="text-muted-foreground mt-0.5">{entry.comment}</p>}
                </div>
              </div>
            ))}
          </div>
        </details>

        {/* Mitarbeiter-Filter */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground font-semibold mr-1">Filter:</span>
          {([
            { key: 'all',        label: `Alle (${stats.total})` },
            { key: 'unreviewed', label: `Ungeprüft (${stats.total - stats.reviewed})` },
            { key: 'check',      label: `Prüfung nötig (${stats.check})` },
            { key: 'accepted',   label: `Akzeptiert (${stats.accepted})` },
            { key: 'held',       label: `Zurückgestellt (${stats.held})` },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn('text-[11px] px-2.5 py-1 rounded border font-medium transition-colors',
                filter === key ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
              )}
            >{label}</button>
          ))}
        </div>

        {/* Mitarbeiter-Karten */}
        <div className="space-y-2">
          {filteredEmps.map(emp => (
            <EmployeeReviewCard
              key={emp.tempId}
              emp={emp}
              empState={employeeStates[emp.tempId] ?? initEmployeeState(emp.tempId)}
              onAction={(action) => handleAction(emp.tempId, emp.name, action)}
              onSetMatch={(name, remember) => handleSetMatch(emp.tempId, emp.name, name, remember)}
              onOpenCorrection={(day) => setCorrModal({ emp, day })}
              onSetDistribution={(status) => handleSetDistribution(emp.tempId, status)}
            />
          ))}
          {filteredEmps.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Keine Mitarbeiter für diesen Filter.
            </div>
          )}
        </div>

        {/* Footer-Aktionen */}
        <div className="rounded-lg border bg-card p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="text-[12px] text-muted-foreground space-y-0.5">
            <p>Geprüft: <strong>{stats.reviewed}/{stats.total}</strong> Mitarbeiter</p>
            <p>Akzeptiert: <strong className="text-green-600">{stats.accepted}</strong> · Zurückgestellt: <strong className="text-yellow-600">{stats.held}</strong> · Ausgeschlossen: <strong className="text-red-600">{stats.excl}</strong></p>
          </div>
          <div className="flex gap-3">
            <button
              disabled={reviewState.reviewStatus !== 'in_review'}
              onClick={() => handleStatusChange('approved')}
              className={cn('px-5 py-2.5 rounded text-sm font-semibold transition-all',
                reviewState.reviewStatus === 'in_review'
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50 border border-border',
              )}
            >
              ✓ Monat freigeben
            </button>
            <button
              disabled={reviewState.reviewStatus !== 'approved'}
              onClick={() => handleStatusChange('distributed')}
              className={cn('px-5 py-2.5 rounded text-sm font-semibold transition-all',
                reviewState.reviewStatus === 'approved'
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50 border border-border',
              )}
            >
              Verteilen
            </button>
          </div>
        </div>

      </div>

      {/* Day Correction Modal */}
      {corrModal && (
        <DayCorrectionModal
          emp={corrModal.emp}
          day={corrModal.day}
          existingOverride={reviewState.employeeStates[corrModal.emp.tempId]?.dayOverrides[corrModal.day.date ?? ''] ?? null}
          onSave={(override) => handleSaveCorrection(corrModal.emp.tempId, override)}
          onClose={() => setCorrModal(null)}
        />
      )}
    </div>
  );
}
