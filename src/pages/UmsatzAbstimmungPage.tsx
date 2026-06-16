import { useState, useCallback } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UmsatzAbstimmung } from '@/components/UmsatzAbstimmung';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { loadYear, availableYears } from '@/lib/reporting-store';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

const currentYear = new Date().getFullYear();

export default function UmsatzAbstimmungPage() {
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { tenantKey } = useTenant();

  const [year, setYear] = useState(currentYear);
  const [months, setMonths] = useState<MonthlyFinancialRecord[]>(() =>
    loadYear(year, tenantKey('reporting_v1')),
  );

  const handleYearChange = useCallback((y: number) => {
    setYear(y);
    setMonths(loadYear(y, tenantKey('reporting_v1')));
  }, [tenantKey]);

  const handleRefresh = useCallback(() => {
    setMonths(loadYear(year, tenantKey('reporting_v1')));
  }, [year, tenantKey]);

  if (isBeaulieuManager || !isAdmin) return <Navigate to="/" replace />;

  const years = availableYears(tenantKey('reporting_v1'));
  const yearOptions = years.includes(currentYear) ? years : [...years, currentYear].sort((a, b) => b - a);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-full px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Dashboard</span>
              </Button>
            </Link>
            <span className="text-muted-foreground text-xs">/</span>
            <h1 className="text-sm font-bold">Umsatzabstimmung</h1>
          </div>
          <Select value={String(year)} onValueChange={v => handleYearChange(Number(v))}>
            <SelectTrigger className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map(y => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <main className="max-w-screen-xl mx-auto px-4 py-6">
        <UmsatzAbstimmung
          year={year}
          months={months}
          dailyBudgetsKey={tenantKey('dailyBudgets')}
          storeKey={tenantKey('reporting_v1')}
          onRefresh={handleRefresh}
        />
      </main>
    </div>
  );
}
