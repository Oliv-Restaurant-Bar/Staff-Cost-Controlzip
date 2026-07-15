import { useState, useCallback, useEffect } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UmsatzAbstimmung } from '@/components/UmsatzAbstimmung';
import type { MonthlyFinancialRecord } from '@/types/reporting';
import { loadYear, availableYears } from '@/lib/reporting-store';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { loadGnRevenueForYear } from '@/lib/gn-zbericht-db';
import { buildUmsatzYearOptions, parseUmsatzYearParam } from '@/lib/umsatzabstimmung-status';

const currentYear = new Date().getFullYear();

export default function UmsatzAbstimmungPage() {
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { tenantKey, tenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();

  const [year, setYear] = useState(() => parseUmsatzYearParam(searchParams.get('year')) ?? currentYear);
  const [months, setMonths] = useState<MonthlyFinancialRecord[]>(() =>
    loadYear(year, tenantKey('reporting_v1')),
  );
  const [gnRevByMonth, setGnRevByMonth] = useState<number[]>(() => new Array(12).fill(0) as number[]);

  const loadGnData = useCallback(async (y: number) => {
    const data = await loadGnRevenueForYear(tenantId, y);
    setGnRevByMonth(data);
  }, [tenantId]);

  useEffect(() => {
    loadGnData(year);
  }, [year, loadGnData]);

  const handleYearChange = useCallback((y: number) => {
    setYear(y);
    setMonths(loadYear(y, tenantKey('reporting_v1')));
    // Deep-Link-Param synchron halten (Equality-Guard gegen redundante History-Einträge).
    setSearchParams(prev => {
      if (prev.get('year') === String(y)) return prev;
      const next = new URLSearchParams(prev);
      next.set('year', String(y));
      return next;
    }, { replace: true });
  }, [tenantKey, setSearchParams]);

  // Back-/Forward-Navigation: URL-Param gewinnt (Equality-Guard verhindert Loops).
  useEffect(() => {
    const paramYear = parseUmsatzYearParam(searchParams.get('year'));
    if (paramYear !== null && paramYear !== year) {
      setYear(paramYear);
      setMonths(loadYear(paramYear, tenantKey('reporting_v1')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleRefresh = useCallback(() => {
    setMonths(loadYear(year, tenantKey('reporting_v1')));
    loadGnData(year);
  }, [year, tenantKey, loadGnData]);

  if (isBeaulieuManager || !isAdmin) return <Navigate to="/" replace />;

  // Jahresfenster: zentrale reine Logik (2024 auch ohne Daten wählbar, T506);
  // leere Jahre zeigen den sichtbaren Leerzustand statt gar nicht zu erscheinen.
  const yearOptions = buildUmsatzYearOptions(
    availableYears(tenantKey('reporting_v1')),
    currentYear,
    year,
  );

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
          gnRevenueByMonth={gnRevByMonth}
        />
      </main>
    </div>
  );
}
