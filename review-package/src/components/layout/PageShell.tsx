/**
 * PageShell — einheitlicher Seitenrahmen (Design-System Phase 3.1).
 *
 * Drei Breiten-Varianten (KEIN Einheitszwang — Formularseiten bleiben schmal):
 *   narrow  = max-w-4xl   (z. B. Personalbedarf, Import-Center)
 *   default = max-w-7xl   (Standard-Arbeitsseiten)
 *   wide    = max-w-[1800px] (Dienstplanung)
 *
 * Seiten-Muster (UX-Leitlinie): kompakte Toolbar → Warnung nur wenn nötig →
 * max. 4 KPI-Karten → Hauptinhalt ohne langes Scrollen → Details per Klick/
 * Tooltip/Collapsible.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type PageWidth = 'narrow' | 'default' | 'wide';

export const PAGE_WIDTH: Record<PageWidth, string> = {
  narrow: 'max-w-4xl',
  default: 'max-w-7xl',
  wide: 'max-w-[1800px]',
};

export function PageShell({
  width = 'default',
  header,
  children,
  className,
}: {
  width?: PageWidth;
  /** Typischerweise ein <PageHeader> (sticky, ausserhalb des Containers). */
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-screen bg-background">
      {header}
      <main className={cn('mx-auto w-full space-y-4 px-4 py-4', PAGE_WIDTH[width], className)}>
        {children}
      </main>
    </div>
  );
}
