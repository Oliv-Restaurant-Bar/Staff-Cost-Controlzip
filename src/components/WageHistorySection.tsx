/**
 * WageHistorySection
 * ==================
 * Zeigt die Lohnhistorie eines Mitarbeiters an und erlaubt
 * das Hinzufügen neuer Lohneinträge (kein Bearbeiten / Löschen).
 *
 * Wird im Personalstamm → Tab "Lohnhistorie" verwendet.
 */

import { useState, useEffect } from 'react';
import { Plus, Clock, ChevronUp, AlertCircle, CheckCircle2, Loader2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  getWageHistory,
  addWageEntry,
  formatWage,
  type WageEntry,
} from '@/lib/wage-history';
import type { Employee } from '@/types/personnel';
import { useAuth } from '@/hooks/useAuth';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-CH', {
      day:   '2-digit',
      month: '2-digit',
      year:  'numeric',
    });
  } catch { return iso; }
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-CH', {
      day:    '2-digit',
      month:  '2-digit',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
    });
  } catch { return iso; }
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface WageHistorySectionProps {
  employee:     Employee;
  restaurantId: string;
  isAdmin:      boolean;
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

export function WageHistorySection({ employee, restaurantId, isAdmin }: WageHistorySectionProps) {
  const { user } = useAuth();

  const [history,    setHistory]    = useState<WageEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [saving,     setSaving]     = useState(false);

  // Formularfelder
  const [wageType,   setWageType]   = useState<'hourly' | 'monthly'>('hourly');
  const [validFrom,  setValidFrom]  = useState('');
  const [hourlyWage, setHourlyWage] = useState('');
  const [monthlySal, setMonthlySal] = useState('');
  const [monthly13,  setMonthly13]  = useState('');
  const [salary13,   setSalary13]   = useState(false);
  const [notes,      setNotes]      = useState('');
  const [formError,  setFormError]  = useState<string | null>(null);

  // Lohnhistorie laden
  useEffect(() => {
    setLoading(true);
    getWageHistory(String(employee.id), restaurantId).then(entries => {
      setHistory(entries);
      setLoading(false);
    });
  }, [employee.id, restaurantId]);

  // Formular zurücksetzen
  const resetForm = () => {
    setValidFrom('');
    setHourlyWage('');
    setMonthlySal('');
    setMonthly13('');
    setSalary13(false);
    setNotes('');
    setFormError(null);
    setWageType(
      (employee.monthlySalary ?? 0) > 0 ? 'monthly' : 'hourly',
    );
  };

  const handleToggleForm = () => {
    if (showForm) {
      setShowForm(false);
      resetForm();
    } else {
      resetForm();
      setShowForm(true);
    }
  };

  const handleSave = async () => {
    setFormError(null);

    if (!validFrom) {
      setFormError('Bitte Gültig-ab-Datum angeben.');
      return;
    }

    const hw  = parseFloat(hourlyWage.replace(',', '.'));
    const ms  = parseFloat(monthlySal.replace(',', '.'));
    const m13 = parseFloat(monthly13.replace(',', '.'));

    if (wageType === 'hourly' && (isNaN(hw) || hw <= 0)) {
      setFormError('Bitte gültigen Stundenlohn eingeben (> 0).');
      return;
    }
    if (wageType === 'monthly' && (isNaN(ms) || ms <= 0)) {
      setFormError('Bitte gültigen Monatslohn eingeben (> 0).');
      return;
    }

    // Prüfen ob validFrom schon existiert
    const duplicate = history.find(e => e.validFrom === validFrom);
    if (duplicate) {
      setFormError(`Für ${fmtDate(validFrom)} existiert bereits ein Eintrag.`);
      return;
    }

    setSaving(true);
    const { error, userMessage } = await addWageEntry({
      employeeId:            String(employee.id),
      restaurantId,
      validFrom,
      hourlyWage:            wageType === 'hourly'  ? hw  : 0,
      monthlySalary:         wageType === 'monthly' ? ms  : 0,
      monthlySalaryWith13th: wageType === 'monthly' && !isNaN(m13) && m13 > 0 ? m13 : 0,
      salary13,
      notes,
      createdBy:             user?.email ?? '',
    });

    setSaving(false);

    if (error) {
      setFormError(userMessage ?? `Speichern fehlgeschlagen: ${error}`);
      toast.error(userMessage ?? 'Lohneintrag konnte nicht gespeichert werden.');
      return;
    }

    toast.success(`Lohneintrag ab ${fmtDate(validFrom)} gespeichert`);
    setShowForm(false);
    resetForm();

    // Liste neu laden
    setLoading(true);
    const fresh = await getWageHistory(String(employee.id), restaurantId);
    setHistory(fresh);
    setLoading(false);
  };

  // ── Fallback-Info: bestehender Lohn ──────────────────────────────────────

  const currentHourly  = employee.hourlyWage    ?? 0;
  const currentMonthly = employee.monthlySalary ?? 0;
  const hasFallback    = currentHourly > 0 || currentMonthly > 0;
  const fallbackLabel  = currentHourly > 0
    ? `CHF ${currentHourly.toFixed(2)}/h (Stundenlohn)`
    : currentMonthly > 0
      ? `CHF ${currentMonthly.toLocaleString('de-CH')}/Mt (Monatslohn)`
      : '–';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Info-Box: bestehender Basiswert */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 px-3 py-2.5 text-[11px] text-blue-700 dark:text-blue-400">
        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-medium">Aktueller Basislohn (employees-Tabelle, unverändert):</p>
          <p className="font-mono">{hasFallback ? fallbackLabel : 'Kein Lohn hinterlegt'}</p>
          <p className="text-[10px] opacity-80">Dieser Wert wird als Fallback verwendet, wenn keine Lohnhistorie vorhanden ist.</p>
        </div>
      </div>

      {/* Header + Button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Lohnhistorie</span>
          {history.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {history.length} Einträge
            </Badge>
          )}
        </div>
        {isAdmin && (
          <Button
            size="sm"
            variant={showForm ? 'secondary' : 'default'}
            className="h-7 text-xs gap-1.5"
            onClick={handleToggleForm}
          >
            {showForm
              ? <><ChevronUp className="h-3.5 w-3.5" />Abbrechen</>
              : <><Plus className="h-3.5 w-3.5" />Neuer Lohn ab Datum</>}
          </Button>
        )}
      </div>

      {/* Neuer Lohneintrag Form */}
      {showForm && isAdmin && (
        <Card className="border-dashed border-2 border-primary/30">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Neuen Lohn erfassen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">

            {/* Lohntyp */}
            <div className="flex items-center gap-3">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Lohntyp:</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setWageType('hourly')}
                  className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                    wageType === 'hourly'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  Stundenlohn
                </button>
                <button
                  type="button"
                  onClick={() => setWageType('monthly')}
                  className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                    wageType === 'monthly'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  Monatslohn
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Gültig ab */}
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Gültig ab *</Label>
                <Input
                  type="date"
                  value={validFrom}
                  onChange={e => setValidFrom(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>

              {/* Lohnwert */}
              {wageType === 'hourly' ? (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Stundenlohn CHF *</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.05"
                    placeholder="z.B. 27.50"
                    value={hourlyWage}
                    onChange={e => setHourlyWage(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              ) : (
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Monatslohn CHF (exkl. 13.) *</Label>
                  <Input
                    type="number"
                    min="0"
                    step="10"
                    placeholder="z.B. 4500"
                    value={monthlySal}
                    onChange={e => setMonthlySal(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              )}
            </div>

            {/* Monatslohn: 13. Monatsgehalt */}
            {wageType === 'monthly' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">Inkl. 13. Monatslohn CHF</Label>
                  <Input
                    type="number"
                    min="0"
                    step="10"
                    placeholder="z.B. 4875 (optional)"
                    value={monthly13}
                    onChange={e => setMonthly13(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex items-end pb-0.5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={salary13}
                      onChange={e => setSalary13(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    13. Monatslohn vereinbart
                  </label>
                </div>
              </div>
            )}

            {/* Bemerkung */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Bemerkung (optional)</Label>
              <Textarea
                rows={2}
                placeholder="z.B. Lohnerhöhung ab Mai 2026"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="text-xs resize-none"
              />
            </div>

            {/* Fehler */}
            {formError && (
              <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {formError}
              </div>
            )}

            {/* Speichern */}
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={handleSave}
                disabled={saving}
              >
                {saving
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Speichern…</>
                  : <><CheckCircle2 className="h-3.5 w-3.5" />Lohneintrag speichern</>}
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Bestehende Einträge bleiben unverändert
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lohnhistorie-Liste */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          Lade Lohnhistorie…
        </div>
      ) : history.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          <Clock className="h-5 w-5 mx-auto mb-2 opacity-50" />
          <p>Noch keine Lohnhistorie erfasst.</p>
          <p className="mt-0.5 text-[10px]">
            Als Fallback wird der Basislohn aus dem Mitarbeiterprofil verwendet.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {history.map((entry, idx) => (
            <div
              key={entry.id}
              className={`rounded-lg border px-3 py-2.5 ${
                idx === 0
                  ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20'
                  : 'border-border bg-muted/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {idx === 0 && (
                    <Badge className="text-[9px] h-4 px-1.5 bg-emerald-600 hover:bg-emerald-600">
                      Aktuell
                    </Badge>
                  )}
                  <span className="text-xs font-semibold font-mono">
                    {formatWage(entry)}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  ab {fmtDate(entry.validFrom)}
                </div>
              </div>
              {entry.notes && (
                <p className="text-[10px] text-muted-foreground mt-1 italic">{entry.notes}</p>
              )}
              <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                Erfasst: {fmtTs(entry.createdAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
