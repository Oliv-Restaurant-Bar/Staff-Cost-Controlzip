/**
 * HintBox — kompakte Warn-/Hinweisbox (Design-System Phase 3.1).
 *
 * Eine Zeile Kernaussage + optionale Aktion; Ton-Semantik aus tones.ts
 * (good/warn/critical/info/neutral). Ersetzt schrittweise die frei
 * gestalteten Warn-Absätze der Module.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { TONE_BOX, type Tone } from '@/components/ui/tones';

const TONE_ICON: Record<Tone, typeof Info> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  critical: OctagonAlert,
  info: Info,
  neutral: Info,
};

export function HintBox({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        TONE_BOX[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 leading-snug">
        {title && <span className="font-medium">{title}</span>}
        {title && children && <span> — </span>}
        {children}
      </div>
      {action && <div className="ml-2 shrink-0">{action}</div>}
    </div>
  );
}
