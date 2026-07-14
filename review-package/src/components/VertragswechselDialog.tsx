/**
 * VertragswechselDialog
 * =====================
 * Dialog für den Wechsel des Vertragstyps (Stundenlohn ↔ Monatslohn).
 *
 * - Zeigt aktuellen Vertrag
 * - Formular für neuen Vertrag
 * - Archiviert alte Phase in contractHistory (localStorage)
 * - Berechnet und zeigt Übergangsmonat-Warnung bei Wechsel mitten im Monat
 * - Gibt updatetes Employee-Objekt via onSaved zurück
 *
 * Der Aufrufer ist verantwortlich für:
 *   1. upsertEmployee(updatedEmp) aufrufen
 *   2. lokale employees-Liste aktualisieren
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  AlertTriangle, CheckCircle2, ArrowRight, RefreshCw,
  Calculator, Calendar, Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Employee, EmploymentType } from '@/types/personnel';
import {
  archiveContractPhase, phaseFromEmployee, ContractPhase,
} from '@/lib/contract-history-store';
import { calcSL, calcML, LGAV } from '@/lib/salaryCalc';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { socialCostFactorFromRates, totalSocialRatePct } from '@/lib/social-costs';

// ─── Typen & Konstanten ───────────────────────────────────────────────────────

interface Props {
  employee: Employee;
  tenantKeyFn: (k: string) => string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Wird mit dem komplett aktualisierten Employee aufgerufen. Aufrufer speichert. */
  onSaved: (updated: Employee) => Promise<void>;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtCHF(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', minimumFractionDigits: 2,
  }).format(v);
}

function contractLabel(emp: Employee): string {
  const isMonthly = emp.contractType === 'monthly'
    || (!emp.contractType && (emp.monthlySalary ?? 0) > 0);
  if (isMonthly) {
    const base = emp.monthlySalary ?? 0;
    const incl = emp.monthlySalaryWith13th ?? (emp.has13thSalary ? base * 13 / 12 : 0);
    const display = incl > 0 ? `${fmtCHF(incl)}/Mt. inkl. 13.` : `${fmtCHF(base)}/Mt.`;
    return `Monatslohn ${display}`;
  }
  const sl = emp.hourlyWage ?? 0;
  return sl > 0 ? `Stundenlohn ${fmtCHF(sl)}/h` : 'Kein Lohn erfasst';
}

function employmentTypeLabel(t: EmploymentType): string {
  return { vollzeit: 'Vollzeit', teilzeit: 'Teilzeit', minijob: 'Minijob', aushilfe: 'Aushilfe' }[t] ?? t;
}

/** Anzahl Tage ab dem effectiveFrom-Datum bis Monatsende */
function daysRemainingInMonth(dateStr: string): { from: number; total: number } {
  const d = new Date(dateStr + 'T00:00:00');
  const total = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { from: d.getDate(), total };
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export function VertragswechselDialog({ employee, tenantKeyFn, open, onOpenChange, onSaved }: Props) {
  const today = format(new Date(), 'yyyy-MM-dd');

  // ── Neuer Vertrag — Formularfelder ─────────────────────────────────────────
  const [newContractType,   setNewContractType]   = useState<'monthly' | 'hourly'>('monthly');
  const [newMonthlySalary,  setNewMonthlySalary]  = useState<string>('');
  const [newHourlyWage,     setNewHourlyWage]      = useState<string>('');
  const [newEmploymentType, setNewEmploymentType] = useState<EmploymentType>('vollzeit');
  const [newWeeklyHours,    setNewWeeklyHours]    = useState<string>(String(employee.weeklyHours ?? 42));
  const [has13th,           setHas13th]           = useState(employee.has13thSalary ?? false);
  const [effectiveFrom,    setEffectiveFrom]      = useState(today);
  const [note,             setNote]               = useState('');
  const [saving,           setSaving]             = useState(false);

  // ── Berechnungen für Vorschau ──────────────────────────────────────────────
  // AG-Sozialkosten kommen ZENTRAL aus den Einstellungen (nicht pro MA).
  const { rates: socialCostRates } = useSocialCostRates();
  const factor    = socialCostFactorFromRates(socialCostRates);
  const socialPct = totalSocialRatePct(socialCostRates);
  const mlVal     = parseFloat(newMonthlySalary) || 0;
  const slVal     = parseFloat(newHourlyWage)    || 0;
  const hoursVal  = parseFloat(newWeeklyHours)   || 42;

  const mlCalc = useMemo(() =>
    mlVal > 0 ? calcML(mlVal, has13th, hoursVal, factor) : null,
    [mlVal, has13th, hoursVal, factor],
  );
  const slCalc = useMemo(() =>
    slVal > 0 ? calcSL(slVal, has13th, factor) : null,
    [slVal, has13th, factor],
  );

  // ── Übergangsmonat-Warnung ────────────────────────────────────────────────
  const { from, total } = useMemo(() => {
    try { return daysRemainingInMonth(effectiveFrom); }
    catch { return { from: 1, total: 30 }; }
  }, [effectiveFrom]);

  const isMidMonth  = from > 1;
  const daysAsNew   = total - from + 1;
  const daysAsOld   = from - 1;

  // Alten Lohn für Pro-rata-Warnung
  const oldIsMonthly = employee.contractType === 'monthly'
    || (!employee.contractType && (employee.monthlySalary ?? 0) > 0);
  const oldMonthly = employee.monthlySalaryWith13th
    ?? (employee.has13thSalary && employee.monthlySalary
      ? employee.monthlySalary * 13 / 12
      : (employee.monthlySalary ?? 0));

  const proRataOld = isMidMonth && oldIsMonthly
    ? Math.round(oldMonthly * (daysAsOld / total) * 100) / 100
    : null;
  const proRataNew = isMidMonth && newContractType === 'monthly' && mlVal > 0
    ? Math.round((has13th ? mlVal * 13 / 12 : mlVal) * (daysAsNew / total) * 100) / 100
    : null;

  // ── Validierung ───────────────────────────────────────────────────────────
  const valid = useMemo(() => {
    if (!effectiveFrom) return false;
    if (newContractType === 'monthly') return mlVal > 0;
    return slVal > 0;
  }, [newContractType, mlVal, slVal, effectiveFrom]);

  // ── Speichern ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      // 1. Alten Vertrag als Phase archivieren
      const oldPhase: Omit<ContractPhase, 'id' | 'createdAt'> = {
        ...phaseFromEmployee(employee),
        effectiveFrom: employee.contractStart ?? '2024-01-01',
        note: 'Archiviert bei Vertragswechsel',
      };
      archiveContractPhase(tenantKeyFn, employee.id, oldPhase);

      // 2. Neues Employee-Objekt aufbauen
      let updated: Employee = { ...employee };

      if (newContractType === 'monthly') {
        updated = {
          ...updated,
          contractType:           'monthly',
          employmentType:          newEmploymentType,
          monthlySalary:           mlVal,
          monthlySalaryWith13th:   has13th ? +(mlVal * 13 / 12).toFixed(2) : undefined,
          hourlyWage:              0,         // nicht mehr Stundenlohnbasis
          has13thSalary:           has13th,
          weeklyHours:             hoursVal,
        };
      } else {
        // Wechsel zu Stundenlohn
        updated = {
          ...updated,
          contractType:            undefined, // kein expliziter monthly mehr
          employmentType:          newEmploymentType,
          monthlySalary:           undefined,
          monthlySalaryWith13th:   undefined,
          hourlyWage:              slVal,
          has13thSalary:           has13th,
          weeklyHours:             hoursVal,
        };
      }

      // 3. Neue Phase in History anlegen
      const newPhase: Omit<ContractPhase, 'id' | 'createdAt'> = {
        effectiveFrom,
        contractType:          newContractType === 'monthly' ? 'monthly' : 'hourly',
        employmentType:        newEmploymentType,
        monthlySalary:         newContractType === 'monthly' ? mlVal : undefined,
        monthlySalaryWith13th: newContractType === 'monthly' && has13th ? +(mlVal * 13 / 12).toFixed(2) : undefined,
        hourlyWage:            newContractType === 'hourly' ? slVal : undefined,
        weeklyHours:           hoursVal,
        has13thSalary:         has13th,
        // Zentraler AG-Sozialkostenfaktor zum Zeitpunkt des Wechsels — rein
        // historische Dokumentation, wird von keiner Berechnung mehr gelesen.
        socialCostFactor:      factor,
        note:                  note.trim() || undefined,
      };
      archiveContractPhase(tenantKeyFn, employee.id, newPhase);

      await onSaved(updated);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // ─── Reset beim Öffnen ────────────────────────────────────────────────────

  const handleOpenChange = (o: boolean) => {
    if (o) {
      // Default: entgegengesetzter Vertragstyp als Vorschlag
      const currentlyMonthly = employee.contractType === 'monthly'
        || (!employee.contractType && (employee.monthlySalary ?? 0) > 0);
      setNewContractType(currentlyMonthly ? 'hourly' : 'monthly');
      setNewMonthlySalary('');
      setNewHourlyWage('');
      setNewEmploymentType(currentlyMonthly ? 'minijob' : 'vollzeit');
      setNewWeeklyHours(String(employee.weeklyHours ?? 42));
      setHas13th(employee.has13thSalary ?? false);
      setEffectiveFrom(today);
      setNote('');
    }
    onOpenChange(o);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[min(620px,95vw)] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
            Vertragswechsel — {employee.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">

          {/* ── Aktueller Vertrag ─────────────────────────────────────────── */}
          <div className="rounded-md border border-border bg-muted/30 p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
                Aktueller Vertrag
              </p>
              <p className="text-sm font-semibold">{contractLabel(employee)}</p>
              <p className="text-xs text-muted-foreground">
                {employmentTypeLabel(employee.employmentType)} · {employee.weeklyHours ?? 42} h/Woche
              </p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/70 mb-0.5">
                Neuer Vertrag
              </p>
              <p className="text-sm font-semibold text-primary">
                {newContractType === 'monthly'
                  ? mlVal > 0 ? `Monatslohn ${fmtCHF(mlVal)}/Mt.` : 'Monatslohn — Betrag eingeben'
                  : slVal > 0 ? `Stundenlohn ${fmtCHF(slVal)}/h` : 'Stundenlohn — Betrag eingeben'}
              </p>
              <p className="text-xs text-muted-foreground">
                {employmentTypeLabel(newEmploymentType)} · {hoursVal} h/Woche
              </p>
            </div>
          </div>

          {/* ── Neuer Vertragstyp ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <Label className="text-xs font-semibold">Neuer Vertragstyp</Label>
            <div className="flex gap-2">
              {(['monthly', 'hourly'] as const).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setNewContractType(type)}
                  className={cn(
                    'flex-1 py-2 px-3 rounded-md border text-sm font-medium transition-colors',
                    newContractType === type
                      ? type === 'monthly'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-orange-600 text-white border-orange-600'
                      : 'bg-muted text-muted-foreground border-border hover:bg-muted/80',
                  )}
                >
                  {type === 'monthly' ? 'Monatslohn (FIX)' : 'Stundenlohn (Flex)'}
                </button>
              ))}
            </div>
          </div>

          {/* ── Lohnfeld ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            {newContractType === 'monthly' ? (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">
                  Monatslohn brutto (CHF)
                  <span className="ml-1 text-[10px] italic opacity-60">exkl. 13. ML</span>
                </Label>
                <Input
                  type="number" min="0" step="50"
                  value={newMonthlySalary}
                  onChange={e => setNewMonthlySalary(e.target.value)}
                  placeholder="z.B. 4800"
                  className="h-9 text-sm"
                  autoFocus
                />
                {mlCalc && has13th && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    inkl. 13. ML: {fmtCHF(mlCalc.effectiveMonthlyGross)}/Mt.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">
                  Stundenlohn brutto (CHF)
                  <span className="ml-1 text-[10px] italic opacity-60">ohne L-GAV-Zuschläge</span>
                </Label>
                <Input
                  type="number" min="0" step="0.05"
                  value={newHourlyWage}
                  onChange={e => setNewHourlyWage(e.target.value)}
                  placeholder="z.B. 23.50"
                  className="h-9 text-sm"
                  autoFocus
                />
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Wochenstunden</Label>
              <Input
                type="number" min="1" max="60" step="0.5"
                value={newWeeklyHours}
                onChange={e => setNewWeeklyHours(e.target.value)}
                placeholder="42"
                className="h-9 text-sm"
              />
            </div>
          </div>

          {/* ── Beschäftigungsgrad & Einstellungen ────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Beschäftigungstyp</Label>
              <Select value={newEmploymentType} onValueChange={v => setNewEmploymentType(v as EmploymentType)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {newContractType === 'monthly' ? (
                    <>
                      <SelectItem value="vollzeit">Vollzeit</SelectItem>
                      <SelectItem value="teilzeit">Teilzeit</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="teilzeit">Teilzeit</SelectItem>
                      <SelectItem value="minijob">Minijob</SelectItem>
                      <SelectItem value="aushilfe">Aushilfe</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
              {newContractType === 'monthly' && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Vollzeit/Teilzeit → erscheint in Personal FIX
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">
                AG-Sozialkosten
                <span className="ml-1 text-[10px] italic opacity-60">zentral für alle MA</span>
              </Label>
              <div className="h-9 flex items-center px-3 rounded-md border border-input bg-muted/30 text-sm text-muted-foreground">
                {socialPct.toFixed(1)}% auf Bruttolohn
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Sätze in Einstellungen → Sozialkostensätze Arbeitgeber
              </p>
            </div>
          </div>

          {/* ── 13. Monatslohn ────────────────────────────────────────────── */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={has13th}
              onChange={e => setHas13th(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            <span className="text-sm">13. Monatslohn vereinbart</span>
            {has13th && newContractType === 'monthly' && mlVal > 0 && (
              <span className="text-xs text-muted-foreground ml-1">
                (+{fmtCHF(mlVal * LGAV.THIRTEENTH_RATE)}/Mt. ≈ {fmtCHF(mlVal * 13 / 12)}/Mt. effektiv)
              </span>
            )}
          </label>

          {/* ── Gültig ab ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Gültig ab
              </Label>
              <Input
                type="date"
                value={effectiveFrom}
                onChange={e => setEffectiveFrom(e.target.value)}
                className="h-9 text-sm"
                min="2024-01-01"
                max="2030-12-31"
              />
              {isMidMonth && (
                <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-0.5">
                  Wechsel Mitte Monat — Pro-rata-Berechnung (s. unten)
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Notiz (optional)</Label>
              <Input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="z.B. Beförderung, Pensumsreduktion"
                className="h-9 text-sm"
                maxLength={120}
              />
            </div>
          </div>

          {/* ── Kosten-Vorschau ───────────────────────────────────────────── */}
          {(mlCalc || slCalc) && (
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-3 space-y-1 text-xs">
              <p className="font-semibold text-blue-800 dark:text-blue-200 flex items-center gap-1 mb-2">
                <Calculator className="h-3 w-3" /> Vorschau Lohnkosten (neuer Vertrag)
              </p>
              {mlCalc && (
                <>
                  <div className="flex justify-between">
                    <span className="text-blue-700 dark:text-blue-400">Vollkosten / Monat</span>
                    <span className="font-bold">{fmtCHF(mlCalc.totalMonthlyEmployerCost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700 dark:text-blue-400">Jahresvollkosten</span>
                    <span className="font-medium">{fmtCHF(mlCalc.annualEmployerCost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700 dark:text-blue-400">Interner Stundenansatz</span>
                    <span className="font-medium">{fmtCHF(mlCalc.internalHourlyCost)}/h</span>
                  </div>
                </>
              )}
              {slCalc && (
                <>
                  <div className="flex justify-between">
                    <span className="text-blue-700 dark:text-blue-400">Auszahlbarer Stundenlohn</span>
                    <span className="font-bold">{fmtCHF(slCalc.totalPayableHourly)}/h</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-blue-700 dark:text-blue-400">Interner Stundenansatz</span>
                    <span className="font-medium">{fmtCHF(slCalc.internalHourlyCost)}/h</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Übergangsmonat-Warnung ────────────────────────────────────── */}
          {isMidMonth && (
            <Alert className="border-orange-200 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-800">
              <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              <AlertDescription className="text-xs space-y-1.5">
                <p className="font-semibold text-orange-800 dark:text-orange-300">
                  Wechsel am {from}.{effectiveFrom ? effectiveFrom.slice(5, 7) : '??'}. — Übergangsmonat
                </p>
                <p>
                  Dieser Monat hat {total} Tage.{' '}
                  {daysAsOld > 0 && `Die ersten ${daysAsOld} Tage gelten noch der alte Vertrag`}
                  {daysAsOld > 0 && daysAsNew > 0 && ', '}
                  {daysAsNew > 0 && `ab dem ${from}. gelten ${daysAsNew} Tage der neue Vertrag`}.
                </p>
                {(proRataOld !== null || proRataNew !== null) && (
                  <div className="font-mono space-y-0.5 text-[11px]">
                    {proRataOld !== null && oldIsMonthly && (
                      <p>Alter Vertrag (bis {from - 1}.): {fmtCHF(proRataOld)}</p>
                    )}
                    {proRataNew !== null && (
                      <p>Neuer Vertrag (ab {from}.): {fmtCHF(proRataNew)}</p>
                    )}
                  </div>
                )}
                <p className="text-orange-700 dark:text-orange-400">
                  Personal FIX erkennt den Wechsel automatisch und berechnet die Kosten anteilig.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {/* ── Sync-Hinweise ─────────────────────────────────────────────── */}
          <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Info className="h-3 w-3" /> Was ändert sich nach dem Wechsel
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-muted-foreground">
              {newContractType === 'monthly' ? (
                <>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Personal FIX: erscheint in FIX-Sektion</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Flex-Sektion: nicht mehr aufgeführt</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Wochenreport: Total Arbeitgeberkosten (Monatslohn)</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Forecast: Total Arbeitgeberkosten berücksichtigt</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Alte Reports: Vertragshistorie erhalten</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Iststunden: weiterhin sichtbar</p>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Flex-Sektion: Kosten zu Total Arbeitgeberkosten/h</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Personal FIX: nicht mehr in FIX</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Forecast: variable Kosten</p>
                  <p className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Alte Reports: Vertragshistorie erhalten</p>
                </>
              )}
            </div>
          </div>
        </div>

        <Separator />

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Abbrechen
          </Button>
          <Button
            onClick={handleSave}
            disabled={!valid || saving}
            className="gap-1.5"
          >
            {saving && (
              <div className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            )}
            <RefreshCw className="h-3.5 w-3.5" />
            Vertrag wechseln & speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
