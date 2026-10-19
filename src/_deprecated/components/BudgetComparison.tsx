import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/personnel-utils';

interface BudgetComparisonProps {
  label: string;
  planned: number;
  actual: number;
  showPercentage?: boolean;
  invertColors?: boolean;
}

export const BudgetComparison = ({
  label,
  planned,
  actual,
  showPercentage = true,
  invertColors = false,
}: BudgetComparisonProps) => {
  const percentage = planned > 0 ? (actual / planned) * 100 : 0;
  const variance = actual - planned;
  const isOver = invertColors ? variance < 0 : variance > 0;
  const isUnder = invertColors ? variance > 0 : variance < 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Plan: {formatCurrency(planned)}</span>
        <span className="font-medium">Ist: {formatCurrency(actual)}</span>
      </div>
      
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="budget-bar h-1.5">
            <div
              className={cn(
                'budget-bar-fill',
                percentage <= 100 ? 'under' : 'over'
              )}
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
        </div>
        
        <span
          className={cn(
            'text-xs font-semibold font-mono min-w-[3.5rem] text-right',
            isOver && 'stat-negative',
            isUnder && 'stat-positive'
          )}
        >
          {variance >= 0 ? '+' : ''}{formatCurrency(variance)}
        </span>
        
        {showPercentage && (
          <span
            className={cn(
              'text-xs font-bold font-mono min-w-[2.5rem] text-right',
              isOver && 'stat-negative',
              isUnder && 'stat-positive'
            )}
          >
            {percentage.toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
};
