/**
 * KpiCard — appweite Standard-KPI-Karte (Design-System Phase 3.1).
 *
 * Regeln:
 *  - max. 4 sichtbare Standard-KPIs pro Seite (KpiGrid), weitere Kennzahlen
 *    hinter <MoreKpis> (einklappbar; KPIs nie löschen, nur verlagern).
 *  - Ton-Semantik aus tones.ts (good/warn/critical/info/neutral).
 *  - Trend-Richtung/-Bewertung sind EXPLIZITE Props — die Karte kennt keine
 *    Fach-Semantik ("mehr = besser" entscheidet die Seite).
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/ui/tones';

export function KpiCard({
  label,
  value,
  sub,
  tone = 'neutral',
  trend,
  className,
  onClick,
  'data-testid': dataTestid,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Ampel-Punkt neben dem Label. */
  tone?: Tone;
  /** Expliziter Trend: Pfeilrichtung + Bewertung + Text, z. B. {direction:'up', tone:'good', label:'+4.2 %'} */
  trend?: { direction: 'up' | 'down' | 'flat'; tone: Tone; label: string };
  className?: string;
  /** Optional: macht die Karte klickbar (rendert als Button, z. B. für Drilldown-Dialoge). */
  onClick?: () => void;
  'data-testid'?: string;
}) {
  const arrow = trend?.direction === 'up' ? '↑' : trend?.direction === 'down' ? '↓' : '→';
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden />
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      </div>
      <p className="text-lg font-bold leading-tight tracking-tight tabular-nums">{value}</p>
      {(sub || trend) && (
        <p className="flex items-baseline gap-2 text-[11px] leading-tight text-muted-foreground">
          {trend && (
            <span className={cn('font-medium tabular-nums', TONE_TEXT[trend.tone])}>
              {arrow} {trend.label}
            </span>
          )}
          {sub}
        </p>
      )}
    </>
  );

  const base = 'flex min-h-[80px] flex-col gap-1 rounded-lg border border-border bg-card p-3';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={dataTestid}
        className={cn(
          base,
          'text-left transition-colors hover:border-primary/60 hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          className,
        )}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={cn(base, className)} data-testid={dataTestid}>
      {inner}
    </div>
  );
}

/** Standard-Raster für die (max. 4) KPI-Karten einer Seite. */
export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>;
}

/**
 * Einklappbarer Bereich „Weitere Kennzahlen" unter den Standard-KPIs.
 * Optional mit localStorage-Persistenz (storageKey), damit Nutzer, die den
 * Bereich offen halten, ihn nicht bei jedem Besuch neu aufklappen müssen.
 */
export function MoreKpis({
  label = 'Weitere Kennzahlen',
  defaultOpen = false,
  storageKey,
  children,
  className,
}: {
  label?: string;
  defaultOpen?: boolean;
  storageKey?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored === '1') return true;
        if (stored === '0') return false;
      } catch {
        /* localStorage nicht verfügbar → default */
      }
    }
    return defaultOpen;
  });

  const handleChange = (next: boolean) => {
    setOpen(next);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* best-effort */
      }
    }
  };

  return (
    <Collapsible open={open} onOpenChange={handleChange} className={className}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
