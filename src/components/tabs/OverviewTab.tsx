import { useState } from 'react';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { CompactKPIWidget } from '@/components/CompactKPIWidget';
import { PlanVsActualVisual } from '@/components/PlanVsActualVisual';
import { UnifiedDashboard } from '@/components/UnifiedDashboard';
import { PrintableKPISummary } from '@/components/PrintableKPISummary';
import { MultiMonthTrendDashboard } from '@/components/MultiMonthTrendDashboard';
import { DepartmentSummary } from '@/components/DepartmentSummary';
import { ActualPerformanceKPI } from '@/components/ActualPerformanceKPI';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { BarChart3, ChevronDown, FileText, Receipt, ClipboardList } from 'lucide-react';
import { BalanceExportDialog, BalanceExportOptions } from '@/components/schedule-planner/BalanceExportDialog';
import { exportKPIReportPDF } from '@/lib/kpi-export';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { toast } from 'sonner';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { usePlanDisplay } from '@/contexts/PlanDisplayContext';
import { cn } from '@/lib/utils';

interface OverviewTabProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

export const OverviewTab = ({ employees, timeEntries, dailyBudgets, selectedDate }: OverviewTabProps) => {
  const [showExportDialog, setShowExportDialog] = useState(false);
  const { showNetRevenue, setShowNetRevenue } = useRevenueDisplay();
  const { showPlannedData, setShowPlannedData } = usePlanDisplay();
  const { rates: socialCostRates } = useSocialCostRates();

  const handleExport = async (options: BalanceExportOptions) => {
    try {
      await exportKPIReportPDF(
        employees,
        timeEntries,
        dailyBudgets,
        options.startDate,
        socialCostRates,
        options.endDate,
        options.periodLabel
      );
      toast.success(`PDF-Report für ${options.periodLabel} erstellt`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Export');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Export and Brutto/Netto Switch */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Brutto/Netto Switch */}
          <div className="flex items-center gap-3 p-2 px-4 rounded-lg border bg-card">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2">
              <Label 
                htmlFor="vat-toggle-overview" 
                className={cn(
                  "text-sm font-medium cursor-pointer transition-colors",
                  !showNetRevenue ? "text-primary" : "text-muted-foreground"
                )}
              >
                Brutto
              </Label>
              <Switch
                id="vat-toggle-overview"
                checked={showNetRevenue}
                onCheckedChange={setShowNetRevenue}
              />
              <Label 
                htmlFor="vat-toggle-overview" 
                className={cn(
                  "text-sm font-medium cursor-pointer transition-colors",
                  showNetRevenue ? "text-primary" : "text-muted-foreground"
                )}
              >
                Netto
              </Label>
            </div>
            <Badge variant="outline" className="text-xs ml-2">
              {showNetRevenue ? 'exkl. MWST' : 'inkl. MWST'}
            </Badge>
          </div>

          {/* Plan-Daten Toggle */}
          <div className="flex items-center gap-3 p-2 px-4 rounded-lg border bg-card">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2">
              <Label 
                htmlFor="plan-toggle-overview" 
                className={cn(
                  "text-sm font-medium cursor-pointer transition-colors",
                  !showPlannedData ? "text-primary" : "text-muted-foreground"
                )}
              >
                Nur Ist
              </Label>
              <Switch
                id="plan-toggle-overview"
                checked={showPlannedData}
                onCheckedChange={setShowPlannedData}
              />
              <Label 
                htmlFor="plan-toggle-overview" 
                className={cn(
                  "text-sm font-medium cursor-pointer transition-colors",
                  showPlannedData ? "text-primary" : "text-muted-foreground"
                )}
              >
                Plan + Ist
              </Label>
            </div>
          </div>
        </div>
        
        <Button variant="outline" size="sm" onClick={() => setShowExportDialog(true)} className="gap-2">
          <FileText className="h-4 w-4" />
          PDF-Report
        </Button>
      </div>

      {/* Export Dialog */}
      <BalanceExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        currentDate={selectedDate}
        onExport={handleExport}
      />

      {/* Compact KPI Widget */}
      <CompactKPIWidget
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
        showPlannedData={showPlannedData}
      />

      {/* Actual Performance KPI */}
      <ActualPerformanceKPI
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
      />

      {/* Plan vs. Ist Visual Overview - only show when plan data is enabled */}
      {showPlannedData && (
        <PlanVsActualVisual
          employees={employees}
          timeEntries={timeEntries}
          dailyBudgets={dailyBudgets}
          selectedDate={selectedDate}
          showNetRevenue={showNetRevenue}
        />
      )}

      {/* Unified Dashboard */}
      <UnifiedDashboard
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
        showPlannedData={showPlannedData}
      />

      {/* Department Summary */}
      <DepartmentSummary
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
        showPlannedData={showPlannedData}
      />

      {/* Actual Performance KPI - NEW */}
      <ActualPerformanceKPI
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
      />

      {/* Plan vs. Ist Visual Overview */}
      <PlanVsActualVisual
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
      />

      {/* Unified Dashboard */}
      <UnifiedDashboard
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
      />

      {/* Department Summary */}
      <DepartmentSummary
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
      />

      {/* Extended KPI Analysis - Collapsible */}
      <Collapsible>
        <Card className="stat-card">
          <CollapsibleTrigger className="w-full">
            <CardHeader className="cursor-pointer group py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="h-4 w-4" />
                  Erweiterte KPI-Analyse
                </CardTitle>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4 pt-0">
              <PrintableKPISummary
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
              />
              
              <MultiMonthTrendDashboard
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
              />
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
};
