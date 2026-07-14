/**
 * ResetProductMonthDialog – Monatsdaten sicher zurücksetzen (Admin only)
 * ========================================================================
 * Erlaubt Admins, alle product_sales-Zeilen für einen bestimmten Monat
 * und eine Datenart (Food / Beverage / Beide) zu löschen.
 *
 * Flow:
 *   1. Felder auswählen (Jahr, Monat, Datenart)
 *   2. „Monat zurücksetzen" klicken → Bestätigungsdialog öffnet sich
 *   3. „LÖSCHEN" eintippen → Delete-Button wird aktiv
 *   4. Bestätigen → API-Aufruf → Ergebnis anzeigen
 *
 * Sicherheit:
 *   - Nur sichtbar für Admin (Prüfung im übergeordneten Component)
 *   - Typed confirmation: User muss „LÖSCHEN" eingeben
 *   - Audit-Log über resetProductSalesMonth()
 */

import { useState, useId } from 'react';
import { Trash2, AlertTriangle, Check, RefreshCw, ShieldAlert, Info } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { resetProductSalesMonth } from '@/lib/sales-db';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const SOURCE_OPTIONS = [
  { value: 'both',     label: 'Beide (Food + Beverage)', sources: ['food_csv_export', 'beverage_csv_export'] },
  { value: 'food',     label: 'Food',                    sources: ['food_csv_export'] },
  { value: 'beverage', label: 'Beverage',                sources: ['beverage_csv_export'] },
] as const;

const CONFIRM_WORD = 'LÖSCHEN';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function currentYear() { return new Date().getFullYear(); }

function availableYears(): number[] {
  const yr = currentYear();
  return [yr + 1, yr, yr - 1, yr - 2, yr - 3];
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat('de-CH').format(n);
}

// ─── Typen ────────────────────────────────────────────────────────────────────

type SourceKey = typeof SOURCE_OPTIONS[number]['value'];
type DialogStep = 'idle' | 'confirming' | 'deleting' | 'done' | 'error';

interface Props {
  /** E-Mail des eingeloggten Admins (für Audit-Log) */
  userEmail: string;
  /** Callback nach erfolgreichem Reset (z.B. Produktanalyse neu laden) */
  onReset?: (year: number, month: number) => void;
}

// ─── Komponente ───────────────────────────────────────────────────────────────

export function ResetProductMonthDialog({ userEmail, onReset }: Props) {
  const labelId = useId();

  // Auswahl-State
  const [year,      setYear]      = useState(currentYear());
  const [month,     setMonth]     = useState(new Date().getMonth() + 1);
  const [sourceKey, setSourceKey] = useState<SourceKey>('both');

  // Dialog-State
  const [open,        setOpen]        = useState(false);
  const [step,        setStep]        = useState<DialogStep>('idle');
  const [confirmText, setConfirmText] = useState('');
  const [deleted,     setDeleted]     = useState(0);
  const [auditLogged, setAuditLogged] = useState(false);
  const [errorMsg,    setErrorMsg]    = useState('');

  const sourceOption = SOURCE_OPTIONS.find(o => o.value === sourceKey) ?? SOURCE_OPTIONS[0];
  const monthName    = MONTH_NAMES[month - 1];
  const periodLabel  = `${monthName} ${year}`;
  const confirmed    = confirmText.trim() === CONFIRM_WORD;

  function openDialog() {
    setStep('idle');
    setConfirmText('');
    setDeleted(0);
    setAuditLogged(false);
    setErrorMsg('');
    setOpen(true);
  }

  function closeDialog() {
    if (step === 'deleting') return; // Nicht schliessen während Löschvorgang
    setOpen(false);
    setStep('idle');
    setConfirmText('');
  }

  async function handleDelete() {
    if (!confirmed) return;
    setStep('deleting');

    const result = await resetProductSalesMonth({
      year,
      month,
      sources:   Array.from(sourceOption.sources),
      deletedBy: userEmail,
    });

    if (result.error) {
      setErrorMsg(result.error);
      setStep('error');
      return;
    }

    setDeleted(result.deleted);
    setAuditLogged(result.auditLogged);
    setStep('done');

    // Produktanalyse + andere Listener benachrichtigen
    window.dispatchEvent(new CustomEvent('product_sales_updated'));
    onReset?.(year, month);
  }

  return (
    <>
      {/* ── Trigger-Bereich ───────────────────────────────────────────────── */}
      <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50/30 dark:bg-red-950/10 p-4 space-y-4">

        {/* Header */}
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">
              Monat zurücksetzen
            </p>
            <p className="text-[11px] text-red-600/80 dark:text-red-500/80 mt-0.5">
              Löscht alle Produktverkaufsdaten eines Monats — nur Admin. Danach sauber neu importieren.
            </p>
          </div>
          <Badge variant="outline" className="ml-auto text-[10px] text-red-600 border-red-300 dark:border-red-800 shrink-0">
            Admin only
          </Badge>
        </div>

        {/* Auswahl-Felder */}
        <div className="grid grid-cols-3 gap-3">
          {/* Jahr */}
          <div className="space-y-1">
            <Label htmlFor={`${labelId}-year`} className="text-xs">Jahr</Label>
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger id={`${labelId}-year`} className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears().map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Monat */}
          <div className="space-y-1">
            <Label htmlFor={`${labelId}-month`} className="text-xs">Monat</Label>
            <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
              <SelectTrigger id={`${labelId}-month`} className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Datenart */}
          <div className="space-y-1">
            <Label htmlFor={`${labelId}-src`} className="text-xs">Datenart</Label>
            <Select value={sourceKey} onValueChange={v => setSourceKey(v as SourceKey)}>
              <SelectTrigger id={`${labelId}-src`} className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Vorschau + Trigger-Button */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-red-600 dark:text-red-500">
            Wird gelöscht:{' '}
            <strong>Produktdaten {sourceOption.label} · {periodLabel}</strong>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
            onClick={openDialog}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Monat zurücksetzen
          </Button>
        </div>
      </div>

      {/* ── Bestätigungs-Dialog ───────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={v => { if (!v) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">

          {/* ── Schritt: idle/confirming ────────────────────────────────────── */}
          {(step === 'idle' || step === 'confirming') && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-5 w-5 shrink-0" />
                  Monatsdaten wirklich löschen?
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Bestätigung zum Löschen der Produktdaten
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-1">
                {/* Was wird gelöscht */}
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10 px-4 py-3 space-y-1.5">
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                    Folgendes wird gelöscht:
                  </p>
                  <ul className="space-y-0.5 text-sm text-red-600 dark:text-red-500">
                    <li>• Alle Produktverkaufsdaten für <strong>{periodLabel}</strong></li>
                    <li>• Datenart: <strong>{sourceOption.label}</strong></li>
                    <li>• Quellen: <code className="text-[11px] bg-red-100 dark:bg-red-950/40 px-1 rounded">{sourceOption.sources.join(', ')}</code></li>
                  </ul>
                </div>

                {/* Was NICHT gelöscht wird */}
                <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1 text-[11px] text-muted-foreground">
                  <p className="font-medium text-foreground/70">Nicht betroffen:</p>
                  <p>✓ Tagesumsätze &nbsp; ✓ Dienstplan &nbsp; ✓ Budget &nbsp; ✓ Erfolgsrechnung</p>
                  <p>✓ Andere Monate &nbsp; ✓ Warenrechnungen &nbsp; ✓ Personalstamm</p>
                </div>

                {/* Audit-Info */}
                <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <p>
                    Dieser Vorgang wird protokolliert:{' '}
                    <strong className="text-foreground/70">{userEmail}</strong>
                    {' '}löscht {periodLabel}.
                  </p>
                </div>

                {/* Typed confirmation */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Zur Bestätigung{' '}
                    <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono font-bold">
                      {CONFIRM_WORD}
                    </code>
                    {' '}eingeben:
                  </Label>
                  <Input
                    value={confirmText}
                    onChange={e => { setConfirmText(e.target.value); setStep('confirming'); }}
                    placeholder={CONFIRM_WORD}
                    className={`font-mono ${confirmed ? 'border-red-400 focus-visible:ring-red-300' : ''}`}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {confirmText && !confirmed && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      Bitte genau „{CONFIRM_WORD}" eingeben (Grossschreibung)
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={closeDialog}>
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  disabled={!confirmed}
                  onClick={handleDelete}
                  className="gap-2"
                >
                  <Trash2 className="h-4 w-4" />
                  Endgültig löschen
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Schritt: deleting ───────────────────────────────────────────── */}
          {step === 'deleting' && (
            <div className="py-8 flex flex-col items-center gap-3 text-center">
              <RefreshCw className="h-8 w-8 animate-spin text-primary" />
              <p className="font-semibold">Lösche Produktdaten…</p>
              <p className="text-sm text-muted-foreground">
                {sourceOption.label} · {periodLabel}
              </p>
            </div>
          )}

          {/* ── Schritt: done ───────────────────────────────────────────────── */}
          {step === 'done' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                  <Check className="h-5 w-5 shrink-0" />
                  Produktdaten gelöscht
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Löschvorgang erfolgreich abgeschlossen
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-1">
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 px-4 py-3 space-y-1">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    {fmtNum(deleted)} Datensätze gelöscht
                  </p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-500">
                    {sourceOption.label} · {periodLabel}
                  </p>
                  {auditLogged && (
                    <p className="text-[11px] text-emerald-600/70 dark:text-emerald-600/70 mt-1">
                      ✓ Audit-Log gespeichert
                    </p>
                  )}
                  {!auditLogged && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-1">
                      ⚠ Audit-Log nicht gespeichert (Migration noch ausstehend)
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-4 py-2.5">
                  <p className="text-[11px] text-blue-700 dark:text-blue-400">
                    <strong>Nächster Schritt:</strong> Du kannst {periodLabel} jetzt sauber neu importieren —
                    keine alten Daten, keine Duplikate.
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button onClick={closeDialog} className="w-full">
                  Schliessen
                </Button>
              </DialogFooter>
            </>
          )}

          {/* ── Schritt: error ──────────────────────────────────────────────── */}
          {step === 'error' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-5 w-5 shrink-0" />
                  Fehler beim Löschen
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Beim Löschvorgang ist ein Fehler aufgetreten
                </DialogDescription>
              </DialogHeader>

              <div className="py-2">
                <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/10 px-4 py-3">
                  <pre className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono">
                    {errorMsg}
                  </pre>
                </div>
                {deleted > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                    Hinweis: {fmtNum(deleted)} Zeilen wurden vor dem Fehler gelöscht.
                  </p>
                )}
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={closeDialog}>Schliessen</Button>
                <Button onClick={() => { setStep('idle'); setConfirmText(''); setErrorMsg(''); }}>
                  Nochmals versuchen
                </Button>
              </DialogFooter>
            </>
          )}

        </DialogContent>
      </Dialog>
    </>
  );
}
