/**
 * SmartSegmentBadges — einheitliche Darstellung der dynamischen Smart-Segmente.
 * Geteilt von Gästeliste (GaesteCrmPage) und Gäste-Detailseite (GaesteDetailPage),
 * damit Farben, Icons und Labels überall identisch sind.
 *
 * Smart-Segmente sind MEHRFACH-zuordenbar (ein Gast kann mehrere Badges tragen)
 * und strikt getrennt vom berechneten Einzel-Segment (siehe SegmentBadge.tsx).
 */
import {
  Crown, Star, Sparkles, Cake, UserMinus, AlertTriangle, Ghost,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SMART_SEGMENT_LABEL,
  SMART_SEGMENT_DESCRIPTION,
  type SmartSegment,
} from '@/lib/guest-smart-segments';

const SMART_SEGMENT_CLASS: Record<SmartSegment, string> = {
  vip:               'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  regular:           'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  new:               'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  upcoming_birthday: 'bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300',
  never_returned:    'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  at_risk:           'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  lost:              'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
};

export const SMART_SEGMENT_ICON: Record<SmartSegment, React.FC<{ className?: string }>> = {
  vip:               Crown,
  regular:           Star,
  new:               Sparkles,
  upcoming_birthday: Cake,
  never_returned:    UserMinus,
  at_risk:           AlertTriangle,
  lost:              Ghost,
};

/** Einzelnes Smart-Segment-Badge (Icon + Label, mit Tooltip-Beschreibung). */
export function SmartSegmentBadge({ segment }: { segment: SmartSegment }) {
  const Icon = SMART_SEGMENT_ICON[segment];
  return (
    <span
      title={SMART_SEGMENT_DESCRIPTION[segment]}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        SMART_SEGMENT_CLASS[segment],
      )}
    >
      <Icon className="h-3 w-3" />
      {SMART_SEGMENT_LABEL[segment]}
    </span>
  );
}

/** Reihe aller zutreffenden Smart-Segmente eines Gastes (nichts bei leerer Liste). */
export function SmartSegmentBadges({
  segments,
  className,
}: {
  segments: SmartSegment[];
  className?: string;
}) {
  if (segments.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {segments.map(seg => <SmartSegmentBadge key={seg} segment={seg} />)}
    </div>
  );
}
