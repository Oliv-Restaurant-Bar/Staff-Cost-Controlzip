/**
 * employer-cost-info.tsx — Geteilte Aufschlüsselung „Total Arbeitgeberkosten"
 * (Design-System Phase 3).
 *
 * EINZIGE UI-Quelle für die Darstellung der Kostenzusammensetzung:
 *   Bruttolohn + Arbeitgeber-Sozialkosten = Total Arbeitgeberkosten
 * optional mit Einzelpositionen (AHV/ALV/FAK/VK/UVG-BU/KTG/BVG/L-GAV/weitere).
 *
 * Begriffe kommen zentral aus EMPLOYER_COST_LABELS (social-costs.ts) —
 * kein Modul definiert eigene Bezeichnungen oder eigene Aufschlüsselungen.
 */
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  EMPLOYER_COST_LABELS,
  EMPLOYER_COST_INFO,
  SOCIAL_COST_RATE_FIELDS,
  totalSocialRatePct,
  type SocialCostRates,
  type EmployerCostSplit,
} from '@/lib/social-costs';
import { cn } from '@/lib/utils';

const fmtChf = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Formelblock Brutto + Sozial = Total — mit oder ohne Zahlen. */
export function EmployerCostFormula({
  split,
  unit,
  className,
}: {
  split?: EmployerCostSplit;
  /** Einheiten-Suffix hinter den Beträgen, z.B. "CHF/h" oder "CHF/Mt." */
  unit?: string;
  className?: string;
}) {
  const u = unit ? ` ${unit}` : '';
  return (
    <div className={cn('space-y-0.5 tabular-nums text-xs', className)}>
      <div className="flex justify-between gap-6">
        <span>{EMPLOYER_COST_LABELS.gross}</span>
        {split && <span>{fmtChf(split.gross)}{u}</span>}
      </div>
      <div className="flex justify-between gap-6">
        <span>+ {EMPLOYER_COST_LABELS.social}</span>
        {split && <span>{fmtChf(split.social)}{u}</span>}
      </div>
      <div className="flex justify-between gap-6 border-t border-border pt-0.5 font-semibold">
        <span>= {EMPLOYER_COST_LABELS.total}</span>
        {split && <span>{fmtChf(split.total)}{u}</span>}
      </div>
    </div>
  );
}

/** Einzelpositionen der Arbeitgeber-Sozialkosten in % (nur Sätze > 0). */
export function SocialRateDetail({
  rates,
  className,
}: {
  rates: SocialCostRates;
  className?: string;
}) {
  return (
    <div className={cn('space-y-0.5 tabular-nums text-xs', className)}>
      {SOCIAL_COST_RATE_FIELDS.filter(f => (rates[f.key] || 0) > 0).map(f => (
        <div key={f.key} className="flex justify-between gap-6 text-muted-foreground">
          <span>{f.label}</span>
          <span>{(rates[f.key] || 0).toFixed(2)}%</span>
        </div>
      ))}
      <div className="flex justify-between gap-6 border-t border-border pt-0.5 font-medium">
        <span>{EMPLOYER_COST_LABELS.social}</span>
        <span>{totalSocialRatePct(rates).toFixed(2)}%</span>
      </div>
    </div>
  );
}

/**
 * Info-Symbol mit Standard-Tooltip zur Zusammensetzung der Total
 * Arbeitgeberkosten — für Spaltenköpfe/KPI-Titel.
 * Mit `rates` erscheinen zusätzlich die Einzelpositionen in %.
 */
export function EmployerCostInfoTip({
  rates,
  side,
  className,
}: {
  rates?: SocialCostRates;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Info: ${EMPLOYER_COST_LABELS.total}`}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[22rem] space-y-2 text-xs leading-snug">
        <p>{EMPLOYER_COST_INFO.total}</p>
        <EmployerCostFormula />
        {rates && <SocialRateDetail rates={rates} />}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Tooltip-Wrapper für einen Total-Arbeitgeberkosten-WERT (Tabellenzelle,
 * KPI-Zahl): zeigt beim Hover/Fokus die Zerlegung Brutto + Sozial = Total,
 * optional darunter die Einzelpositionen in %.
 */
export function EmployerCostValueTip({
  split,
  unit,
  rates,
  children,
}: {
  split: EmployerCostSplit;
  unit?: string;
  rates?: SocialCostRates;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[22rem] space-y-2 text-xs leading-snug">
        <EmployerCostFormula split={split} unit={unit} />
        {rates && <SocialRateDetail rates={rates} />}
      </TooltipContent>
    </Tooltip>
  );
}
