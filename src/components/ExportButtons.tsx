import { UnifiedExportButton } from '@/components/UnifiedExportButton';
import { Employee, TimeEntry, DailyBudget, DailySummary } from '@/types/personnel';
import { exportDailyReport, exportWeeklyReport } from '@/lib/pdf-export';
import { toast } from 'sonner';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';

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
  const { rates } = useSocialCostRates();

  const handleDailyExport = () => {
    try {
      exportDailyReport(selectedDate, employees, timeEntries, dailyBudgets, dailySummary, rates, showNetRevenue);
      toast.success('Tagesbericht wurde exportiert');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Erstellen des PDF');
    }
  };

  const handleWeeklyExport = () => {
    try {
      exportWeeklyReport(selectedDate, employees, timeEntries, dailyBudgets, rates, showNetRevenue);
      toast.success('Wochenbericht wurde exportiert');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Erstellen des PDF');
    }
  };

  return (
    <UnifiedExportButton
      data-testid="dashboard-export"
      actions={[
        { key: 'tagesbericht', label: 'Tagesbericht (PDF)', kind: 'pdf', onSelect: handleDailyExport },
        { key: 'wochenbericht', label: 'Wochenbericht (PDF)', kind: 'pdf', onSelect: handleWeeklyExport },
      ]}
    />
  );
};