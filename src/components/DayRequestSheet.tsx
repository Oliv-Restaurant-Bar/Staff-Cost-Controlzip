import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { MessageSquare, Clock, Loader2 } from 'lucide-react';
import { createEmployeeRequest } from '@/lib/timesheet-store';

export interface DayRequestSheetProps {
  open:           boolean;
  onClose:        () => void;
  date:           string;
  employeeId:     string;
  confirmationId: string;
  tenantId?:      string | null;
  year:           number;
  month:          number;
  onSubmitted?:   () => void;
}

const CATEGORIES = [
  { value: 'arbeitszeit', label: 'Arbeitszeit' },
  { value: 'pause',       label: 'Pause' },
  { value: 'ferien',      label: 'Ferien' },
  { value: 'krankheit',   label: 'Krankheit' },
  { value: 'unfall',      label: 'Unfall' },
  { value: 'sonstiges',   label: 'Sonstiges' },
];

const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export default function DayRequestSheet({
  open, onClose, date, employeeId, confirmationId, tenantId, year, month, onSubmitted,
}: DayRequestSheetProps) {
  const [category, setCategory]           = useState('arbeitszeit');
  const [message, setMessage]             = useState('');
  const [wantsCorrection, setWantsCorrection] = useState(false);
  const [reqStart, setReqStart]           = useState('');
  const [reqEnd, setReqEnd]               = useState('');
  const [reqHours, setReqHours]           = useState('');
  const [submitting, setSubmitting]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [done, setDone]                   = useState(false);

  function reset() {
    setCategory('arbeitszeit');
    setMessage('');
    setWantsCorrection(false);
    setReqStart('');
    setReqEnd('');
    setReqHours('');
    setError(null);
    setDone(false);
  }

  function handleClose() { reset(); onClose(); }

  async function handleSubmit() {
    if (!message.trim()) { setError('Bitte gib einen Kommentar ein.'); return; }
    setError(null);
    setSubmitting(true);
    try {
      const result = await createEmployeeRequest({
        confirmationId,
        tenantId:            tenantId ?? null,
        employeeId,
        date,
        month,
        year,
        requestType:         wantsCorrection ? 'correction_request' : 'question',
        category,
        message:             message.trim(),
        requestedStartTime:  reqStart || null,
        requestedEndTime:    reqEnd   || null,
        requestedHours:      reqHours ? parseFloat(reqHours) : null,
      });
      if (!result.ok) { setError(result.error ?? 'Fehler beim Absenden.'); return; }
      setDone(true);
      onSubmitted?.();
    } finally {
      setSubmitting(false);
    }
  }

  const d       = new Date(date + 'T12:00:00');
  const weekday = WEEKDAYS_SHORT[d.getDay()];
  const dateLabel = `${weekday}, ${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-xl pb-safe">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 text-primary shrink-0" />
            Rückfrage zu {dateLabel}
          </SheetTitle>
        </SheetHeader>

        {done ? (
          <div className="py-8 text-center space-y-2">
            <MessageSquare className="h-10 w-10 text-emerald-500 mx-auto" />
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">Rückfrage eingereicht</p>
            <p className="text-sm text-muted-foreground">Die Verwaltung wird sich bei dir melden.</p>
            <button onClick={handleClose} className="mt-4 h-10 px-6 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
              Schliessen
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Kategorie */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Kategorie</p>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setCategory(c.value)}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                      category === c.value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-muted-foreground border-border hover:bg-muted',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Kommentar */}
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                Kommentar <span className="text-red-500">*</span>
              </label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Was stimmt nicht? Bitte beschreibe das Problem kurz…"
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                rows={3}
              />
            </div>

            {/* Korrektur-Toggle */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={wantsCorrection}
                onChange={e => setWantsCorrection(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span className="text-sm text-muted-foreground">Ich möchte eine Zeitkorrektur beantragen</span>
            </label>

            {/* Korrektur-Felder */}
            {wantsCorrection && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />Gewünschte Korrektur (optional)
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Beginn</label>
                    <input
                      type="time"
                      value={reqStart}
                      onChange={e => setReqStart(e.target.value)}
                      className="w-full border border-border rounded-md px-2.5 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Ende</label>
                    <input
                      type="time"
                      value={reqEnd}
                      onChange={e => setReqEnd(e.target.value)}
                      className="w-full border border-border rounded-md px-2.5 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Gewünschte Stunden</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={reqHours}
                    onChange={e => setReqHours(e.target.value)}
                    placeholder="z.B. 8.5"
                    className="w-full border border-border rounded-md px-2.5 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            <div className="flex gap-3 pt-1 pb-2">
              <button
                onClick={handleClose}
                className="flex-1 h-11 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 h-11 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Absenden
              </button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
