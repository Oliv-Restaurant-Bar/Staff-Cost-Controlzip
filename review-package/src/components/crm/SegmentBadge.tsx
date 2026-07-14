/**
 * SegmentBadge — einheitliche Darstellung eines CRM-Gästesegments.
 * Geteilt von Gästeliste (GaesteCrmPage) und CRM Auswertung (CrmAuswertungPage),
 * damit Farben, Icons und Labels überall identisch sind.
 */
import { Crown, Star, Repeat, UserPlus, Moon, CircleSlash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SEGMENT_LABEL, type GuestSegment } from '@/lib/reservation-crm';

const SEGMENT_CLASS: Record<GuestSegment, string> = {
  vip:           'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  stammgast:     'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  wiederkehrend: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  neukunde:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  inaktiv:       'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  ohne_besuch:   'bg-muted text-muted-foreground',
};

export const SEGMENT_ICON: Record<GuestSegment, React.FC<{ className?: string }>> = {
  vip:           Crown,
  stammgast:     Star,
  wiederkehrend: Repeat,
  neukunde:      UserPlus,
  inaktiv:       Moon,
  ohne_besuch:   CircleSlash,
};

export function SegmentBadge({ segment }: { segment: GuestSegment }) {
  const Icon = SEGMENT_ICON[segment];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
      SEGMENT_CLASS[segment],
    )}>
      <Icon className="h-3 w-3" />
      {SEGMENT_LABEL[segment]}
    </span>
  );
}
