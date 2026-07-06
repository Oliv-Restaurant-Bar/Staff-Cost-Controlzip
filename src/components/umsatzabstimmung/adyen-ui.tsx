/**
 * adyen-ui.tsx — Geteilte UI-Bausteine für den Adyen-Tages-Abgleich.
 * ==================================================================
 * Reine Darstellung + kleine Eingabe-Popovers. Sämtliche Logik (Overrides,
 * Diff-Status, Bestätigung) lebt in src/lib/adyen-abstimmung.ts.
 */

import { useState } from 'react';
import { MessageSquare, Pencil, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import type { AdyenComment, AdyenDiffStatus, EffectiveValue } from '@/lib/adyen-abstimmung';

// ── Formatierung ──────────────────────────────────────────────────────────────

export function fmtChf(n: number): string {
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function fmtDiffChf(n: number): string {
  const s = fmtChf(Math.abs(n));
  if (n > 0) return `+${s}`;
  if (n < 0) return `\u2212${s}`;
  return s;
}

export function parseAmountInput(raw: string): number | null {
  let s = raw.trim().replace(/['\u2019\s]/g, '');
  if (s === '') return null;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── Differenz-Farben ──────────────────────────────────────────────────────────

export function diffColorClass(status: AdyenDiffStatus | null | undefined): string {
  switch (status) {
    case 'ok':    return 'text-emerald-600 dark:text-emerald-400';
    case 'small': return 'text-orange-600 dark:text-orange-400';
    case 'large': return 'text-red-600 dark:text-red-400';
    default:      return 'text-muted-foreground/40';
  }
}

export function DiffCell({ diff, status }: { diff: number | null; status: AdyenDiffStatus | null }) {
  if (diff === null) return <span className="text-muted-foreground/40">—</span>;
  return <span className={cn('font-mono font-semibold', diffColorClass(status))}>{fmtDiffChf(diff)}</span>;
}

// ── Badges ────────────────────────────────────────────────────────────────────

export function OverrideBadge() {
  return (
    <Badge variant="outline" className="h-4 px-1 text-[9px] font-medium border-yellow-400 bg-yellow-50 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-700">
      manuell korrigiert
    </Badge>
  );
}

export function DayStateBadges({
  hasAdyen, hasOverrides, hasComments, confirmed,
}: { hasAdyen: boolean; hasOverrides: boolean; hasComments: boolean; confirmed: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {hasAdyen && !hasOverrides && (
        <Badge variant="outline" className="h-4 px-1 text-[9px] text-muted-foreground">automatisch</Badge>
      )}
      {hasOverrides && <OverrideBadge />}
      {hasComments && (
        <Badge variant="outline" className="h-4 px-1 text-[9px] border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800">
          kommentiert
        </Badge>
      )}
      {confirmed && (
        <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800">
          bestätigt
        </Badge>
      )}
    </span>
  );
}

// ── Kommentar-Button ──────────────────────────────────────────────────────────

export function CommentButton({
  comment, disabled, onSave, label,
}: {
  comment?: AdyenComment;
  disabled?: boolean;
  onSave: (text: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const has = !!comment?.text;

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (o) setText(comment?.text ?? ''); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Kommentar: ${label}`}
          title={has ? comment!.text : `Kommentar zu „${label}"`}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted transition-colors align-middle',
            has ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground/30 hover:text-muted-foreground',
          )}
        >
          <MessageSquare className={cn('h-3 w-3', has && 'fill-blue-100 dark:fill-blue-900')} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-2">
          <Label className="text-xs font-semibold">Kommentar — {label}</Label>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="z. B. Terminal-Ausfall, Beleg fehlt…"
            className="text-xs min-h-[64px]"
            disabled={disabled}
          />
          {comment?.updatedAt && (
            <p className="text-[10px] text-muted-foreground">
              Zuletzt geändert: {new Date(comment.updatedAt).toLocaleString('de-CH')}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {has && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled}
                onClick={() => { onSave(''); setOpen(false); }}>
                Löschen
              </Button>
            )}
            <Button size="sm" className="h-7 text-xs" disabled={disabled}
              onClick={() => { onSave(text); setOpen(false); }}>
              Speichern
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Betrag mit Override ───────────────────────────────────────────────────────

export function AmountCell({
  ev, label, disabled, onOverride,
}: {
  ev?: EffectiveValue;
  label: string;
  disabled?: boolean;
  /** corrected === null ⇒ Override entfernen. */
  onOverride: (originalValue: number, corrected: number | null, comment: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (!ev) return <span className="text-muted-foreground/40">—</span>;

  const openEditor = (o: boolean) => {
    setOpen(o);
    if (o) {
      setValue(fmtChf(ev.value).replace(/\u2019/g, "'"));
      setComment(ev.override?.comment ?? '');
      setInvalid(false);
    }
  };

  const save = () => {
    const parsed = parseAmountInput(value);
    if (parsed === null) { setInvalid(true); return; }
    // Gleicher Wert wie Original ⇒ Override überflüssig, entfernen.
    if (Math.abs(parsed - ev.original) < 0.005 && !comment.trim()) {
      onOverride(ev.original, null, '');
    } else {
      onOverride(ev.original, parsed, comment);
    }
    setOpen(false);
  };

  return (
    <span className="inline-flex flex-col items-end">
      <Popover open={open} onOpenChange={openEditor}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label} bearbeiten`}
            title={ev.overridden ? `Manuell korrigiert — Original: CHF ${fmtChf(ev.original)}` : `${label} — klicken zum Korrigieren`}
            className={cn(
              'group inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-xs transition-colors',
              ev.overridden
                ? 'bg-yellow-100 dark:bg-yellow-950/50 text-yellow-900 dark:text-yellow-200 font-semibold'
                : 'hover:bg-muted',
            )}
          >
            {fmtChf(ev.value)}
            <Pencil className={cn('h-2.5 w-2.5 shrink-0', ev.overridden ? 'opacity-70' : 'opacity-0 group-hover:opacity-40')} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="end">
          <div className="space-y-2">
            <Label className="text-xs font-semibold">Wert korrigieren — {label}</Label>
            <Input
              value={value}
              onChange={e => { setValue(e.target.value); setInvalid(false); }}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
              className={cn('h-8 text-xs font-mono text-right', invalid && 'border-red-500')}
              disabled={disabled}
              inputMode="decimal"
            />
            {invalid && <p className="text-[10px] text-red-600">Ungültiger Betrag.</p>}
            <p className="text-[10px] text-muted-foreground">Original: CHF {fmtChf(ev.original)}</p>
            <Textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Kommentar zur Korrektur (optional)…"
              className="text-xs min-h-[48px]"
              disabled={disabled}
            />
            <div className="flex justify-between gap-2">
              {ev.overridden ? (
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled}
                  onClick={() => { onOverride(ev.original, null, ''); setOpen(false); }}>
                  <RotateCcw className="h-3 w-3 mr-1" /> Zurücksetzen
                </Button>
              ) : <span />}
              <Button size="sm" className="h-7 text-xs" disabled={disabled} onClick={save}>
                Speichern
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {ev.overridden && (
        <span className="text-[9px] text-muted-foreground leading-tight">
          Original: CHF {fmtChf(ev.original)}
        </span>
      )}
    </span>
  );
}
