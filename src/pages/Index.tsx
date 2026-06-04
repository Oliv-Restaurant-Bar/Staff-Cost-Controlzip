import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { format, startOfWeek, endOfWeek, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { motion, AnimatePresence } from 'framer-motion';
import { usePersonnelData } from '@/hooks/usePersonnelData';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { DateSelector } from '@/components/DateSelector';
import { ExportButtons } from '@/components/ExportButtons';
import { PasswordProtection } from '@/components/PasswordProtection';
import { PageNavigation } from '@/components/PageNavigation';
import { EmployeeForm } from '@/components/EmployeeForm';
import { MainTabNavigation, MainTab } from '@/components/MainTabNavigation';
import { OverviewTab } from '@/components/tabs/OverviewTab';
import { RevenueTab } from '@/components/tabs/RevenueTab';

import { PersonnelTab } from '@/components/tabs/PersonnelTab';
import { ScheduleTab } from '@/components/tabs/ScheduleTab';
import { Employee, TimeEntry } from '@/types/personnel';
import { Button } from '@/components/ui/button';
import { 
  Settings,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Check,
  Menu
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Storage key for active tab
const ACTIVE_TAB_KEY = 'dashboard-active-tab';

// Personnel tracking main page
const Index = () => {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isEmployeeFormOpen, setIsEmployeeFormOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { showNetRevenue } = useRevenueDisplay();
  const [activeTab, setActiveTab] = useState<MainTab>(() => {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    if (saved === 'übersicht' || saved === 'umsatz' || saved === 'personal' || saved === 'dienstplan') {
      return saved;
    }
    return 'übersicht';
  });

  // Persist active tab to localStorage
  useEffect(() => {
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
  }, [activeTab]);
  
  const {
    employees,
    timeEntries,
    dailyBudgets,
    addEmployee,
    updateEmployee,
    deleteEmployee,
    setAllEmployees,
    updateTimeEntry,
    updatePlannedTime,
    deleteTimeEntry,
    addTimeEntry,
    updateBudget,
    setFixedBudget,
    updateHourlyRevenue,
    getDailySummary,
    importScheduleData,
    importMirusData,
    importMirusDailyData,
    importSchedulePDF,
    importRevenueData,
    updateEmployeeBalance,
  } = usePersonnelData();

  // Listen for schedule-updated events to show sync indicator
  useEffect(() => {
    const handleScheduleUpdate = () => {
      setSyncStatus('syncing');
      setTimeout(() => {
        setSyncStatus('done');
        setTimeout(() => {
          setSyncStatus('idle');
        }, 1500);
      }, 300);
    };

    window.addEventListener('schedule-updated', handleScheduleUpdate);
    return () => window.removeEventListener('schedule-updated', handleScheduleUpdate);
  }, []);

  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const summary = getDailySummary(dateString);
  const budget = dailyBudgets[dateString] || { plannedRevenue: 0, actualRevenue: 0 };

  // Calculate active period info for header display
  const periodInfo = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekNum = getISOWeek(selectedDate);
    const monthName = format(selectedDate, 'MMMM', { locale: de });
    const weekRangeStr = `${format(weekStart, 'd.', { locale: de })}-${format(weekEnd, 'd. MMM', { locale: de })}`;
    const weekRangeFull = `${format(weekStart, 'EEEE, d. MMMM', { locale: de })} – ${format(weekEnd, 'EEEE, d. MMMM yyyy', { locale: de })}`;
    const monthStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    const monthEnd = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0);
    const monthRangeFull = `${format(monthStart, 'd.', { locale: de })} – ${format(monthEnd, 'd. MMMM yyyy', { locale: de })}`;
    
    return {
      weekNum,
      weekStart,
      weekEnd,
      weekRange: weekRangeStr,
      weekRangeFull,
      monthName,
      monthRangeFull,
      year: format(selectedDate, 'yyyy'),
    };
  }, [selectedDate]);

  // Navigate to previous/next week
  const navigateWeek = (direction: 'prev' | 'next') => {
    const days = direction === 'prev' ? -7 : 7;
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + days);
    setSelectedDate(newDate);
  };

  // Navigate to previous/next month
  const navigateMonth = (direction: 'prev' | 'next') => {
    const newDate = new Date(selectedDate);
    newDate.setMonth(newDate.getMonth() + (direction === 'prev' ? -1 : 1));
    setSelectedDate(newDate);
  };

  const handleEmployeeSubmit = (employee: Omit<Employee, 'id'> | Employee) => {
    if ('id' in employee) {
      updateEmployee(employee);
    } else {
      addEmployee(employee);
    }
  };

  const handleEditEmployee = (employee: Employee) => {
    setEditingEmployee(employee);
    setIsEmployeeFormOpen(true);
  };

  const handleAddNewEmployee = () => {
    setEditingEmployee(null);
    setIsEmployeeFormOpen(true);
  };

  const tabNavItems = [
    { id: 'übersicht' as MainTab, label: 'Übersicht' },
    { id: 'umsatz' as MainTab, label: 'Umsatz' },
    { id: 'personal' as MainTab, label: 'Personal' },
    { id: 'dienstplan' as MainTab, label: 'Dienstplan' },
  ];

  return (
    <PasswordProtection>
    <div className="min-h-screen bg-background">
      {/* Page Navigation */}
      <PageNavigation />

      {/* Header */}
      <header className="sticky top-0 z-50 glass-effect border-b border-border">
        <div className="container mx-auto px-4 py-2">
          {/* Single Header Row */}
          <div className="flex items-center gap-2">
            {/* Mobile Menu */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="md:hidden h-8 w-8 p-0">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <nav className="mt-6 flex flex-col gap-2">
                  {tabNavItems.map((item) => (
                    <Button
                      key={item.id}
                      variant={activeTab === item.id ? 'default' : 'ghost'}
                      className="justify-start gap-3 h-10"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                    >
                      {item.label}
                    </Button>
                  ))}
                  <hr className="my-2" />
                  <Link to="/settings" onClick={() => setMobileMenuOpen(false)}>
                    <Button variant="ghost" className="justify-start gap-3 h-10 w-full">
                      <Settings className="h-4 w-4" />
                      Einstellungen
                    </Button>
                  </Link>
                </nav>
              </SheetContent>
            </Sheet>

            {/* Title */}
            <h1 className="text-sm sm:text-base font-bold tracking-tight flex-shrink-0">
              <span className="hidden md:inline">Personalkostentracker</span>
              <span className="md:hidden">PKT</span>
            </h1>

            {/* Date Selector */}
            <DateSelector selectedDate={selectedDate} onDateChange={setSelectedDate} />

            {/* KW Navigation */}
            <div className="hidden sm:flex items-center gap-0.5 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={() => navigateWeek('prev')} className="h-6 w-6 p-0">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium px-1">KW {periodInfo.weekNum}</span>
              <Button variant="ghost" size="sm" onClick={() => navigateWeek('next')} className="h-6 w-6 p-0">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Month Navigation */}
            <div className="hidden sm:flex items-center gap-0.5 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={() => navigateMonth('prev')} className="h-6 w-6 p-0">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium px-1">{periodInfo.monthName}</span>
              <Button variant="ghost" size="sm" onClick={() => navigateMonth('next')} className="h-6 w-6 p-0">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right: Export, Sync, Settings */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <ExportButtons
                selectedDate={selectedDate}
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                dailySummary={summary}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.dispatchEvent(new CustomEvent('schedule-updated'))}
                disabled={syncStatus === 'syncing'}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`h-4 w-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
              </Button>
              {syncStatus === 'done' && (
                <Check className="h-4 w-4 text-green-500" />
              )}
              <Link to="/settings" className="hidden md:flex flex-shrink-0">
                <Button variant="ghost" size="icon" title="Einstellungen" className="h-8 w-8">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <MainTabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      </header>

      <main className="container mx-auto px-4 py-4 space-y-6 pb-24">
        {/* Tab Content with animated transitions */}
        <AnimatePresence mode="wait">
          {activeTab === 'übersicht' && (
            <motion.div
              key="übersicht"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <OverviewTab
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
              />
            </motion.div>
          )}

          {activeTab === 'umsatz' && (
            <motion.div
              key="umsatz"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <RevenueTab
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
                onBudgetUpdate={updateBudget}
                onImportRevenue={importRevenueData}
                onUpdateHourlyRevenue={updateHourlyRevenue}
                onSetFixedBudget={setFixedBudget}
              />
            </motion.div>
          )}

          {activeTab === 'personal' && (
            <motion.div
              key="personal"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <PersonnelTab
                employees={employees}
                timeEntries={timeEntries}
                dailyBudgets={dailyBudgets}
                selectedDate={selectedDate}
                dailySummary={summary}
                onImportPlannedHours={importSchedulePDF}
                onImportActualHours={importMirusDailyData}
                onImportRevenue={importRevenueData}
                onUpdateTimeEntry={updateTimeEntry}
                onUpdatePlannedTime={updatePlannedTime}
                onAddTimeEntry={addTimeEntry}
                onDeleteTimeEntry={deleteTimeEntry}
                onEditEmployee={handleEditEmployee}
                onDeleteEmployee={deleteEmployee}
                onSetAllEmployees={setAllEmployees}
                onAddNewEmployee={handleAddNewEmployee}
                onBudgetUpdate={updateBudget}
                onUpdateEmployeeBalance={updateEmployeeBalance}
              />
            </motion.div>
          )}

          {activeTab === 'dienstplan' && (
            <motion.div
              key="dienstplan"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <ScheduleTab selectedDate={selectedDate} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Employee Form Dialog */}
      <EmployeeForm
        isOpen={isEmployeeFormOpen}
        onClose={() => {
          setIsEmployeeFormOpen(false);
          setEditingEmployee(null);
        }}
        onSubmit={handleEmployeeSubmit}
        employee={editingEmployee}
      />
    </div>
    </PasswordProtection>
  );
};

export default Index;
