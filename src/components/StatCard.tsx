import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon?: LucideIcon;
  trend?: 'positive' | 'negative' | 'neutral';
  trendValue?: string;
  className?: string;
}

export const StatCard = ({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendValue,
  className,
}: StatCardProps) => {
  return (
    <div className={cn('stat-card animate-fade-in', className)}>
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="stat-label">{title}</p>
          <p className="stat-value">{value}</p>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className="rounded-lg bg-primary/10 p-2.5">
            <Icon className="h-5 w-5 text-primary" />
          </div>
        )}
      </div>
      {trend && trendValue && (
        <div className="mt-4 flex items-center gap-2">
          <span
            className={cn(
              'text-sm font-medium',
              trend === 'positive' && 'stat-positive',
              trend === 'negative' && 'stat-negative',
              trend === 'neutral' && 'text-muted-foreground'
            )}
          >
            {trend === 'positive' ? '↓' : trend === 'negative' ? '↑' : '→'}{' '}
            {trendValue}
          </span>
          <span className="text-sm text-muted-foreground">vs. Plan</span>
        </div>
      )}
    </div>
  );
};
