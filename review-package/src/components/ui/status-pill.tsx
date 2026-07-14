/**
 * StatusPill — appweite Status-Ampel (Design-System Phase 3.1).
 *
 * Ein Baustein für alle Status-Anzeigen (grün = gut, orange = Achtung,
 * rot = kritisch, blau = Info, grau = neutral). Ersetzt schrittweise die
 * modul-eigenen Badge-Implementierungen (Staffing, Adyen, Import).
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { TONE_DOT, TONE_PILL, type Tone } from '@/components/ui/tones';

export function StatusPill({
  tone,
  children,
  size = 'sm',
  showDot = true,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  size?: 'sm' | 'xs';
  showDot?: boolean;
  className?: string;
}) {
  const sizing =
    size === 'xs' ? 'gap-1 px-1.5 py-px text-[10px]' : 'gap-1.5 px-2 py-0.5 text-xs';
  const dot = size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border font-medium',
        sizing,
        TONE_PILL[tone],
        className,
      )}
    >
      {showDot && <span className={cn('shrink-0 rounded-full', dot, TONE_DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}
