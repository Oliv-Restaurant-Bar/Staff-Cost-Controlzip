/**
 * StichtagBanner
 * ==============
 * Zeigt einen prominenten Hinweis wenn ein globaler Stichtag gesetzt ist.
 * Importiert in Dashboard, PLView, Reporting, SollIstAnalyse etc.
 *
 * Usage:
 *   import { StichtagBanner } from '@/components/StichtagBanner';
 *   <StichtagBanner />   // zeigt nichts wenn kein Stichtag aktiv
 */

import { CalendarClock, X } from 'lucide-react';
import { useStichtag } from '@/contexts/StichtagContext';
import { cn } from '@/lib/utils';

interface StichtagBannerProps {
  /** Zusätzliche CSS-Klassen für den Container */
  className?: string;
  /** Kompakte Variante (weniger Padding) */
  compact?: boolean;
}

export const StichtagBanner = ({ className, compact = false }: StichtagBannerProps) => {
  const { isActive, formatted, formattedMonthYear, clearStichtag } = useStichtag();

  if (!isActive) return null;

  return (
    <div className={cn(
      'flex items-center gap-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30',
      compact ? 'px-3 py-1.5' : 'px-4 py-2.5',
      className,
    )}>
      <CalendarClock className={cn('flex-shrink-0 text-amber-600 dark:text-amber-400', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
      <div className="flex-1 min-w-0">
        <span className={cn('font-semibold text-amber-800 dark:text-amber-300', compact ? 'text-xs' : 'text-sm')}>
          Stichtag-Auswertung per {formatted}
        </span>
        <span className={cn('text-amber-700/70 dark:text-amber-400/70 ml-2', compact ? 'text-[10px]' : 'text-xs')}>
          Daten werden auf {formattedMonthYear} begrenzt
        </span>
      </div>
      <button
        onClick={clearStichtag}
        className={cn(
          'flex-shrink-0 flex items-center gap-1 rounded px-2 py-0.5 text-amber-700 dark:text-amber-300',
          'hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors',
          compact ? 'text-[10px]' : 'text-xs',
        )}
        title="Stichtag aufheben"
      >
        <X className="h-3 w-3" />
        <span className="hidden sm:inline">Aufheben</span>
      </button>
    </div>
  );
};
