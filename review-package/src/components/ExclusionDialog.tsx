import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { BanIcon, UserCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type ExclusionDialogMode = 'exclude' | 'include';

export const EXCLUSION_REASONS: { value: string; label: string }[] = [
  { value: 'no_mirus',         label: 'Kein Mirus-Arbeitszeitblatt' },
  { value: 'not_required',     label: 'Nicht arbeitszeitpflichtig' },
  { value: 'period_mismatch',  label: 'Austritt / Eintritt ausserhalb Periode' },
  { value: 'other',            label: 'Sonstiges' },
];

interface Props {
  open:          boolean;
  onOpenChange:  (open: boolean) => void;
  mode:          ExclusionDialogMode;
  employeeName:  string;
  year:          number;
  month:         number;
  /** Aufgerufen mit scope + optionalem Grund. Wirft bei Fehler. */
  onConfirm:     (scope: 'month_only' | 'permanent', reason: string | null) => Promise<void>;
}

// ─── Komponente ───────────────────────────────────────────────────────────────

export default function ExclusionDialog({
  open, onOpenChange, mode, employeeName, year, month, onConfirm,
}: Props) {
  const [scope,   setScope]   = useState<'month_only' | 'permanent'>('permanent');
  const [reason,  setReason]  = useState('no_mirus');
  const [loading, setLoading] = useState(false);

  // Scope-Reset bei Öffnen
  useEffect(() => {
    if (open) {
      setScope('permanent');
      setReason('no_mirus');
      setLoading(false);
    }
  }, [open]);

  const monthName = MONTH_NAMES_DE[month - 1];

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm(scope, mode === 'exclude' ? reason : null);
      onOpenChange(false);
    } catch {
      // Toast wird vom Parent ausgegeben
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {mode === 'exclude'
              ? <><BanIcon className="h-4 w-4 text-amber-500 shrink-0" />Aus Monatslauf ausschliessen</>
              : <><UserCheck className="h-4 w-4 text-emerald-500 shrink-0" />Wieder einschliessen</>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{employeeName}</strong>
            {mode === 'exclude'
              ? ' wird vom Monatslauf ausgeschlossen.'
              : ' wird wieder in den Monatslauf eingeschlossen.'}
          </p>

          {/* Gültigkeitsbereich */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Gültigkeitsbereich</p>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="radio"
                  value="permanent"
                  checked={scope === 'permanent'}
                  onChange={() => setScope('permanent')}
                  className="mt-0.5 accent-primary"
                />
                <span className="text-sm leading-snug">
                  {mode === 'exclude'
                    ? <><strong>Ab {monthName} {year}</strong> dauerhaft ausschliessen</>
                    : <><strong>Ab {monthName} {year}</strong> dauerhaft einschliessen</>}
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    {mode === 'exclude'
                      ? 'Gilt für alle Folgemonate bis zur manuellen Reaktivierung'
                      : 'Beendet den laufenden Ausschluss'}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="radio"
                  value="month_only"
                  checked={scope === 'month_only'}
                  onChange={() => setScope('month_only')}
                  className="mt-0.5 accent-primary"
                />
                <span className="text-sm leading-snug">
                  Nur <strong>{monthName} {year}</strong>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    {mode === 'exclude'
                      ? 'Nur dieser Monat — Folgemonate unberührt'
                      : 'Nur dieser Monat — Ausschluss bleibt danach bestehen'}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* Grund (nur beim Ausschliessen) */}
          {mode === 'exclude' && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Grund (optional)</p>
              <select
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {EXCLUSION_REASONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={loading}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={loading}
            className={cn(
              'gap-1.5',
              mode === 'exclude'
                ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500 focus:ring-amber-500'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600',
            )}
          >
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Speichern…</>
              : mode === 'exclude'
                ? <><BanIcon className="h-3.5 w-3.5" />Ausschliessen</>
                : <><UserCheck className="h-3.5 w-3.5" />Einschliessen</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
