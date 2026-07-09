/**
 * InfoTip — kleines Info-Symbol mit Tooltip (Design-System Phase 3.1).
 *
 * Ersetzt lange Erklärtext-Absätze auf den Seiten: arbeitsrelevanter Inhalt
 * steht zuerst, Erklärungen erst auf Nachfrage (Hover/Fokus).
 * TooltipProvider ist app-weit gemountet.
 */
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function InfoTip({
  text,
  className,
  side,
}: {
  text: ReactNode;
  className?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Info"
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[20rem] text-xs leading-snug">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
