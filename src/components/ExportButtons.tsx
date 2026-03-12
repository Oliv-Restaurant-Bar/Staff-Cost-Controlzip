import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileDown, FileText, Calendar } from 'lucide-react';
import { Employee, TimeEntry, DailyBudget, DailySummary } from '@/types/personnel';
import { exportDailyReport, exportWeeklyReport } from '@/lib/pdf-export';
import { toast } from 'sonner';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';

interface ExportButtonsProps {
  selectedDate: Date;
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  dailySummary: DailySummary;
}

export const ExportButtons = ({
  selectedDate,
  employees,
  timeEntries,
  dailyBudgets,
  dailySummary,
}: ExportButtonsProps) => {
  const { showNetRevenue } = useRevenueDisplay();

  const handleDailyExport = () => {
    try {
      exportDailyReport(selectedDate, employees, timeEntries, dailyBudgets, dailySummary, showNetRevenue);
      toast.success('Tagesbericht wurde exportiert');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Erstellen des PDF');
    }
  };

  const handleWeeklyExport = () => {
    try {
      exportWeeklyReport(selectedDate, employees, timeEntries, dailyBudgets, showNetRevenue);
      toast.success('Wochenbericht wurde exportiert');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Erstellen des PDF');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2">
          <FileDown className="h-4 w-4" />
          PDF Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleDailyExport} className="gap-2 cursor-pointer">
          <FileText className="h-4 w-4" />
          Tagesbericht exportieren
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleWeeklyExport} className="gap-2 cursor-pointer">
          <Calendar className="h-4 w-4" />
          Wochenbericht exportieren
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};