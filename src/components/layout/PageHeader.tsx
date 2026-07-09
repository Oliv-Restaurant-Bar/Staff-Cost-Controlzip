/**
 * PageHeader — einheitlicher, kompakter Seitenkopf (Design-System Phase 3.1).
 *
 * Sticky-Kopfzeile mit Icon + Titel + optionalem Info-Tooltip (statt
 * Erklärtext-Absätzen), Meta-Text (z. B. Zeitraum), Toolbar-Slot (children)
 * und Aktions-Slot rechts. Hintergrund OPAK (bg-card), damit beim Scrollen
 * nichts durchscheint.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { InfoTip } from '@/components/ui/info-tip';
import { PAGE_WIDTH, type PageWidth } from '@/components/layout/PageShell';

export function PageHeader({
  icon,
  title,
  info,
  meta,
  width = 'default',
  children,
  actions,
}: {
  /** Kleines Icon links vom Titel (Grösse wird gesetzt). */
  icon?: ReactNode;
  title: ReactNode;
  /** Erklärung als Tooltip hinter dem Info-Symbol — statt Textabsatz. */
  info?: ReactNode;
  /** Sekundärinfo, z. B. Datumsbereich (ab sm sichtbar). */
  meta?: ReactNode;
  width?: PageWidth;
  /** Toolbar-Elemente (Umschalter, Filter) — kompakt halten (h-7/h-8). */
  children?: ReactNode;
  /** Primäraktionen rechts (Buttons). */
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card shadow-sm">
      <div
        className={cn(
          'mx-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2',
          PAGE_WIDTH[width],
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
              {icon}
            </span>
          )}
          <h1 className="whitespace-nowrap text-sm font-semibold">{title}</h1>
          {info && <InfoTip text={info} />}
        </div>
        {meta && <span className="hidden text-xs text-muted-foreground sm:block">{meta}</span>}
        {children}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
