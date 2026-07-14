/**
 * LoadingState / EmptyState — einheitliche Lade- und Leerzustände
 * (Design-System Phase 3.1). Kompakt, ohne Layout-Sprünge.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export function LoadingState({
  label = 'Lade Daten…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground',
        className,
      )}
      role="status"
    >
      <div
        className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
        aria-hidden
      />
      {label}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 py-16 text-center', className)}>
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/40" aria-hidden />}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="max-w-sm text-xs leading-snug text-muted-foreground/70">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
