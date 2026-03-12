import { useState } from 'react';
import { format } from 'date-fns';
import { Employee, TimeEntry, DailyBudget, HourlyRevenue } from '@/types/personnel';
import { SimpleRevenueInput } from '@/components/SimpleRevenueInput';
import { MonthlyRevenueComparison } from '@/components/MonthlyRevenueComparison';
import { PlannedRevenueEditor } from '@/components/PlannedRevenueEditor';
import { HourlyRevenueImport } from '@/components/HourlyRevenueImport';
import { ShiftRevenueComparison } from '@/components/ShiftRevenueComparison';
import { RevenueImportButton } from '@/components/RevenueImportButton';
import { RevenueExportDialog } from '@/components/RevenueExportDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Clock, ChevronDown, Receipt, FileDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';

interface RevenueTabProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue', value: number) => void;
  onImportRevenue: (data: any) => void;
  onUpdateHourlyRevenue: (date: string, hourlyRevenue: HourlyRevenue[], totalRevenue: number, totalFood?: number, totalBeverage?: number) => void;
  onSetFixedBudget?: (date: string, value: number) => void;
}

export const RevenueTab = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  onBudgetUpdate,
  onImportRevenue,
  onUpdateHourlyRevenue,
  onSetFixedBudget,
}: RevenueTabProps) => {
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const budget = dailyBudgets[dateString] || { plannedRevenue: 0, actualRevenue: 0, fixedBudget: undefined };
  
  // Use global Brutto/Netto context
  const { showNetRevenue, setShowNetRevenue } = useRevenueDisplay();
  const [showExportDialog, setShowExportDialog] = useState(false);

  return (
    <div className="space-y-6">
      {/* Quick Import/Export + Brutto/Netto Switch */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <RevenueImportButton onImport={onImportRevenue} />
          <Button variant="outline" size="sm" onClick={() => setShowExportDialog(true)} className="gap-2">
            <FileDown className="h-4 w-4" />
            Export
          </Button>
        </div>
        
        {/* Brutto/Netto Switch */}
        <div className="flex items-center gap-3 p-2 px-4 rounded-lg border bg-card">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          <div className="flex items-center gap-2">
            <Label 
              htmlFor="vat-toggle" 
              className={cn(
                "text-sm font-medium cursor-pointer transition-colors",
                !showNetRevenue ? "text-primary" : "text-muted-foreground"
              )}
            >
              Brutto
            </Label>
            <Switch
              id="vat-toggle"
              checked={showNetRevenue}
              onCheckedChange={setShowNetRevenue}
            />
            <Label 
              htmlFor="vat-toggle" 
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
      </div>

      {/* Simple Revenue Input - Ist, Budget, Vorjahr */}
      <SimpleRevenueInput
        selectedDate={selectedDate}
        dailyBudgets={dailyBudgets}
        onBudgetUpdate={onBudgetUpdate}
        showNetRevenue={showNetRevenue}
      />

      {/* Monthly Revenue Comparison */}
      <MonthlyRevenueComparison
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        showNetRevenue={showNetRevenue}
      />

      {/* Planned Revenue Editor - Monthly budget distribution */}
      <PlannedRevenueEditor
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        onBudgetUpdate={onBudgetUpdate}
        onImportRevenue={onImportRevenue}
        onSetFixedBudget={onSetFixedBudget}
        showNetRevenue={showNetRevenue}
      />

      {/* Shift Revenue & Hourly Analysis - Collapsible */}
      <Collapsible>
        <Card className="stat-card">
          <CollapsibleTrigger className="w-full">
            <CardHeader className="cursor-pointer group py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4" />
                  Schicht-Umsatz & Stündliche Analyse
                </CardTitle>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-6 pt-0">
              <HourlyRevenueImport
                onImport={onUpdateHourlyRevenue}
                dailyBudgets={dailyBudgets}
              />
              
              <ShiftRevenueComparison
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
                showNetRevenue={showNetRevenue}
              />
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Export Dialog */}
      <RevenueExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        selectedDate={selectedDate}
        dailyBudgets={dailyBudgets}
      />
    </div>
  );
};