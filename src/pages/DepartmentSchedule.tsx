import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, getISOWeek, addDays, isWeekend, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  ChevronLeft, ChevronRight, Calendar, Save, 
  Users, Clock, CheckCircle, Loader2, ShieldAlert, Building2, RefreshCw,
  Smartphone, X, Share, PlusSquare, MoreVertical, Home, Monitor, CalendarPlus
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ShiftDropdown } from '@/components/schedule-planner/ShiftDropdown';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { useSupabaseSchedule, TimeSlot, DaySchedule } from '@/hooks/useSupabaseSchedule';
import { useWeekSync } from '@/hooks/useWeekSync';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type Department = 'service' | 'kueche';
type CalendarView = 'week' | 'month';

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const DepartmentSchedule = () => {
  const { department } = useParams<{ department: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  
  const [isValidating, setIsValidating] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenRole, setTokenRole] = useState<string>('department');
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [installGuideDismissed, setInstallGuideDismissed] = useState(() => {
    return localStorage.getItem('pwa-install-dismissed') === 'true';
  });
  const { shifts, shiftMap } = useShiftConfig();

  // Use global week/month sync hook for synchronization with main page
  const {
    currentWeekStart,
    currentMonthStart,
    navigateWeek,
    navigateMonth,
    weekNumber,
    setWeek,
  } = useWeekSync('DepartmentSchedule', new Date());
  
  // Derive selectedWeekIndex from currentWeekStart
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);

  // Use Supabase hook for data
  const dbDepartment = department === 'service' ? 'service' : department === 'kueche' ? 'kueche' : null;
  
  const {
    employees,
    scheduleData,
    isLoading,
    error,
    updateScheduleEntry,
    refresh,
  } = useSupabaseSchedule({
    token,
    department: tokenRole === 'admin' ? null : dbDepartment,
    currentMonth: currentMonthStart,
  });

  // Validate token on mount
  useEffect(() => {
    const validateToken = async () => {
      if (!token || !department) {
        setIsValidating(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('department_access_tokens')
          .select('*')
          .eq('token', token)
          .eq('is_active', true)
          .maybeSingle();

        console.log('Token validation result:', { data, error, token, department });

        if (error || !data) {
          setIsAuthorized(false);
        } else {
          // For admin tokens, allow any department
          const isAdmin = data.role === 'admin';
          const departmentMatch = data.department === department || isAdmin;
          
          if (!departmentMatch) {
            setIsAuthorized(false);
          } else if (data.expires_at && new Date(data.expires_at) < new Date()) {
            setIsAuthorized(false);
          } else {
            setIsAuthorized(true);
            setTokenName(data.name);
            setTokenRole(data.role || 'department');
            
            // Update last_used_at
            await supabase
              .from('department_access_tokens')
              .update({ last_used_at: new Date().toISOString() })
              .eq('id', data.id);
          }
        }
      } catch (err) {
        console.error('Token validation error:', err);
        setIsAuthorized(false);
      }
      
      setIsValidating(false);
    };

    validateToken();
  }, [token, department]);

  // Show install guide after successful auth (works on mobile and desktop)
  useEffect(() => {
    if (isAuthorized && !installGuideDismissed) {
      // Check if not already installed as PWA
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
      
      if (!isStandalone) {
        // Show after a short delay
        const timer = setTimeout(() => setShowInstallGuide(true), 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [isAuthorized, installGuideDismissed]);

  const dismissInstallGuide = (permanent: boolean) => {
    setShowInstallGuide(false);
    if (permanent) {
      localStorage.setItem('pwa-install-dismissed', 'true');
      setInstallGuideDismissed(true);
    }
  };

  // Calculate weeks in month - sync with currentMonthStart from hook
  const weeksInMonth = useMemo(() => {
    const start = startOfMonth(currentMonthStart);
    const end = endOfMonth(currentMonthStart);
    const weeks: Date[] = [];
    let current = startOfWeek(start, { weekStartsOn: 1 });
    
    while (current <= end) {
      weeks.push(current);
      current = addDays(current, 7);
    }
    
    return weeks;
  }, [currentMonthStart]);

  // Sync selectedWeekIndex when currentWeekStart changes
  useEffect(() => {
    const weekIndex = weeksInMonth.findIndex(
      w => startOfWeek(w, { weekStartsOn: 1 }).getTime() === startOfWeek(currentWeekStart, { weekStartsOn: 1 }).getTime()
    );
    if (weekIndex >= 0) {
      setSelectedWeekIndex(weekIndex);
    }
  }, [currentWeekStart, weeksInMonth]);

  // Get display days based on view - use synced dates
  const displayDays = useMemo(() => {
    if (calendarView === 'week') {
      // Use currentWeekStart directly from sync hook
      return eachDayOfInterval({
        start: currentWeekStart,
        end: endOfWeek(currentWeekStart, { weekStartsOn: 1 })
      });
    }
    
    const start = startOfMonth(currentMonthStart);
    const end = endOfMonth(currentMonthStart);
    return eachDayOfInterval({ start, end });
  }, [calendarView, currentMonthStart, currentWeekStart]);

  // Navigation now uses the sync hook - changes propagate to main page
  const handleNavigateWeek = (direction: 'prev' | 'next') => {
    navigateWeek(direction);
  };

  const handleNavigateMonth = (direction: 'prev' | 'next') => {
    navigateMonth(direction);
  };

  const handleSlotChange = async (employeeId: string, dateKey: string, slotType: 'früh' | 'spät', shiftCode: string | null) => {
    if (!shiftCode || shiftCode === 'none') {
      await updateScheduleEntry(employeeId, dateKey, slotType, null, null);
      return;
    }
    
    if (shiftCode.startsWith('absence-')) {
      const absenceType = shiftCode.replace('absence-', '');
      await updateScheduleEntry(employeeId, dateKey, slotType, null, absenceType);
      return;
    }
    
    const shiftConfig = shiftMap[shiftCode];
    if (shiftConfig) {
      await updateScheduleEntry(
        employeeId, 
        dateKey, 
        slotType, 
        { start: shiftConfig.start, end: shiftConfig.end },
        null
      );
    }
  };

  const calculateEmployeeHours = (employeeId: string): number => {
    let total = 0;
    const monthStart = startOfMonth(currentMonthStart);
    const monthEnd = endOfMonth(currentMonthStart);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    
    days.forEach(day => {
      const key = `${employeeId}-${format(day, 'yyyy-MM-dd')}`;
      const schedule = scheduleData[key];
      
      if (schedule) {
        ['früh', 'spät'].forEach(slot => {
          const timeSlot = schedule[slot as 'früh' | 'spät'];
          if (timeSlot && timeSlot.start && timeSlot.end) {
            const [startH, startM] = timeSlot.start.split(':').map(Number);
            const [endH, endM] = timeSlot.end.split(':').map(Number);
            const hours = (endH * 60 + endM - startH * 60 - startM) / 60;
            if (hours > 0) total += hours;
          }
        });
      }
    });
    
    return total;
  };

  const getShiftForSlot = (employeeId: string, dateKey: string, slotType: 'früh' | 'spät'): string | null => {
    const key = `${employeeId}-${dateKey}`;
    const schedule = scheduleData[key];
    if (!schedule) return null;
    
    const absenceKey = slotType === 'früh' ? 'frühAbsence' : 'spätAbsence';
    const absence = schedule[absenceKey];
    if (absence) return `absence-${absence}`;
    
    const timeSlot = schedule[slotType];
    if (!timeSlot) return null;
    
    // Find matching shift
    for (const [code, config] of Object.entries(shiftMap)) {
      if (config.start === timeSlot.start && config.end === timeSlot.end) {
        return code;
      }
    }
    
    return null;
  };

  // Filter employees by department
  const filteredEmployees = employees.filter(emp => {
    const empDept = emp.department === 'küche' ? 'kueche' : 'service';
    return empDept === dbDepartment;
  });

  // Loading state
  if (isValidating || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
          <p className="text-muted-foreground">
            {isValidating ? 'Zugang wird überprüft...' : 'Daten werden geladen...'}
          </p>
        </div>
      </div>
    );
  }

  // Unauthorized state
  if (!isAuthorized || !department) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <ShieldAlert className="h-16 w-16 mx-auto text-destructive mb-4" />
            <CardTitle className="text-xl">Zugriff verweigert</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-muted-foreground">
              Der Zugangslink ist ungültig, abgelaufen oder wurde deaktiviert.
            </p>
            <p className="text-sm text-muted-foreground">
              Bitte kontaktieren Sie die Verwaltung für einen neuen Zugangslink.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const departmentLabel = department === 'service' ? 'Service' : 'Küche';
  const departmentColor = department === 'service' ? 'bg-blue-500' : 'bg-orange-500';

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 glass-effect border-b border-border">
        <div className="container mx-auto px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left: Department Info */}
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${departmentColor}`}>
                <Building2 className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold">Dienstplan {departmentLabel}</h1>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">{tokenName}</p>
                  {tokenRole === 'admin' && (
                    <Badge variant="outline" className="text-xs">Admin</Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Navigation */}
            <div className="flex items-center gap-2">
              {/* Week Navigation - uses sync hook */}
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg px-2 py-1">
                <Button variant="ghost" size="sm" onClick={() => handleNavigateWeek('prev')} className="h-7 w-7 p-0">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium min-w-[60px] text-center">KW {weekNumber}</span>
                <Button variant="ghost" size="sm" onClick={() => handleNavigateWeek('next')} className="h-7 w-7 p-0">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <span className="text-muted-foreground hidden sm:inline">·</span>

              {/* Month Navigation - uses sync hook */}
              <div className="hidden sm:flex items-center gap-1 bg-muted/50 rounded-lg px-2 py-1">
                <Button variant="ghost" size="sm" onClick={() => handleNavigateMonth('prev')} className="h-7 w-7 p-0">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium min-w-[80px] text-center">
                  {format(currentMonthStart, 'MMMM', { locale: de })}
                </span>
                <Button variant="ghost" size="sm" onClick={() => handleNavigateMonth('next')} className="h-7 w-7 p-0">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2">
              {/* View Toggle */}
              <div className="hidden sm:flex items-center bg-muted rounded-lg p-0.5">
                <Button
                  variant={calendarView === 'week' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setCalendarView('week')}
                  className="h-7 px-2 text-xs"
                >
                  Woche
                </Button>
                <Button
                  variant={calendarView === 'month' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setCalendarView('month')}
                  className="h-7 px-2 text-xs"
                >
                  Monat
                </Button>
              </div>
              
              <Button size="sm" variant="outline" onClick={refresh} className="gap-1">
                <RefreshCw className="h-4 w-4" />
                <span className="hidden sm:inline">Aktualisieren</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-4 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Mitarbeiter</span>
            </div>
            <p className="text-2xl font-bold mt-1">{filteredEmployees.length}</p>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Geplante Std.</span>
            </div>
            <p className="text-2xl font-bold mt-1">
              {filteredEmployees.reduce((sum, emp) => sum + calculateEmployeeHours(emp.id), 0).toFixed(0)}h
            </p>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Zeitraum</span>
            </div>
            <p className="text-sm font-medium mt-1">
              {calendarView === 'week' && displayDays.length > 0
                ? `${format(displayDays[0], 'd.', { locale: de })} - ${format(displayDays[displayDays.length - 1], 'd. MMM', { locale: de })}`
                : format(currentMonthStart, 'MMMM yyyy', { locale: de })
              }
            </p>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Status</span>
            </div>
            <Badge variant="outline" className="mt-1 bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
              Live-Sync aktiv
            </Badge>
          </Card>
        </div>

        {/* Schedule Grid */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="sticky left-0 bg-muted/50 p-2 text-left font-medium min-w-[150px]">
                    Mitarbeiter
                  </th>
                  {displayDays.map(day => (
                    <th 
                      key={day.toISOString()} 
                      className={cn(
                        "p-2 text-center font-medium min-w-[100px]",
                        isWeekend(day) && "bg-muted/30"
                      )}
                    >
                      <div className="text-xs text-muted-foreground">
                        {WEEKDAY_NAMES[getDay(day)]}
                      </div>
                      <div>{format(day, 'd.')}</div>
                    </th>
                  ))}
                  <th className="p-2 text-center font-medium min-w-[80px]">Stunden</th>
                </tr>
              </thead>
              <tbody>
                {filteredEmployees.map(employee => {
                  const totalHours = calculateEmployeeHours(employee.id);
                  return (
                    <tr key={employee.id} className="border-b hover:bg-muted/20">
                      <td className="sticky left-0 bg-background p-2 font-medium">
                        <div className="truncate max-w-[140px]" title={employee.name}>
                          {employee.name}
                        </div>
                        <div className="text-xs text-muted-foreground capitalize">{employee.employmentType}</div>
                      </td>
                      {displayDays.map(day => {
                        const dateKey = format(day, 'yyyy-MM-dd');
                        return (
                          <td 
                            key={dateKey} 
                            className={cn(
                              "p-1",
                              isWeekend(day) && "bg-muted/30"
                            )}
                          >
                            <div className="space-y-1">
                              <ShiftDropdown
                                value={getShiftForSlot(employee.id, dateKey, 'früh')}
                                onChange={(val) => handleSlotChange(employee.id, dateKey, 'früh', val)}
                                department={department === 'service' ? 'service' : 'küche'}
                              />
                              <ShiftDropdown
                                value={getShiftForSlot(employee.id, dateKey, 'spät')}
                                onChange={(val) => handleSlotChange(employee.id, dateKey, 'spät', val)}
                                department={department === 'service' ? 'service' : 'küche'}
                              />
                            </div>
                          </td>
                        );
                      })}
                      <td className="p-2 text-center font-medium">
                        {totalHours.toFixed(1)}h
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            
            {filteredEmployees.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Keine Mitarbeiter in dieser Abteilung gefunden.</p>
                <p className="text-sm mt-2">Bitte fügen Sie zuerst Mitarbeiter in der Hauptverwaltung hinzu.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Employee Hours Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mitarbeiter-Übersicht</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredEmployees.map(employee => {
                const hours = calculateEmployeeHours(employee.id);
                const target = employee.weeklyHours ? employee.weeklyHours * 4.33 : 173;
                const percentage = Math.min((hours / target) * 100, 100);
                
                return (
                  <div key={employee.id} className="p-3 border rounded-lg">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium text-sm">{employee.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{employee.employmentType}</p>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {hours.toFixed(1)}h
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div 
                          className={cn(
                            "h-full transition-all",
                            percentage >= 100 ? "bg-amber-500" : "bg-primary"
                          )}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>0h</span>
                        <span>Ziel: {target.toFixed(0)}h</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-2">
          {/* Link to Schedule Planner */}
          <Button 
            variant="default" 
            className="flex-1 gap-2"
            asChild
          >
            <Link to="/schedule-planner">
              <CalendarPlus className="h-4 w-4" />
              Dienstplan erstellen
            </Link>
          </Button>
          
          {/* Install Guide Button */}
          {!installGuideDismissed && (
            <Button 
              variant="outline" 
              className="flex-1 gap-2"
              onClick={() => setShowInstallGuide(true)}
            >
              <Smartphone className="h-4 w-4" />
              Zum Startbildschirm hinzufügen
            </Button>
          )}
          
          {/* Link to Homepage */}
          <Button 
            variant="outline" 
            className="flex-1 gap-2"
            asChild
          >
            <Link to="/">
              <Home className="h-4 w-4" />
              Zur Hauptübersicht
            </Link>
          </Button>
        </div>
      </main>

      {/* PWA Install Guide Dialog */}
      <Dialog open={showInstallGuide} onOpenChange={setShowInstallGuide}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-primary" />
              App installieren
            </DialogTitle>
            <DialogDescription>
              Füge den Dienstplan zum Startbildschirm hinzu für schnellen Zugriff wie eine echte App.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Desktop Instructions */}
            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <Monitor className="h-4 w-4" />
                <span>Desktop (Chrome/Edge)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">1.</span>
                  <span>Klicke auf das Install-Symbol in der Adressleiste (⊕ oder App-Icon)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">2.</span>
                  <span>Oder: Menü → "App installieren" / "Verknüpfung erstellen"</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">3.</span>
                  <span>Bestätige mit "Installieren"</span>
                </li>
              </ol>
            </div>

            {/* iOS Instructions */}
            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <span className="text-lg">🍎</span>
                <span>iPhone / iPad (Safari)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">1.</span>
                  <span>Tippe auf <Share className="inline h-4 w-4 mx-1" /> (Teilen-Symbol unten)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">2.</span>
                  <span>Scrolle und wähle <PlusSquare className="inline h-4 w-4 mx-1" /> "Zum Home-Bildschirm"</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">3.</span>
                  <span>Tippe auf "Hinzufügen"</span>
                </li>
              </ol>
            </div>

            {/* Android Instructions */}
            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <span className="text-lg">🤖</span>
                <span>Android (Chrome)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">1.</span>
                  <span>Tippe auf <MoreVertical className="inline h-4 w-4 mx-1" /> (Menü oben rechts)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">2.</span>
                  <span>Wähle "Zum Startbildschirm hinzufügen"</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-primary">3.</span>
                  <span>Tippe auf "Hinzufügen"</span>
                </li>
              </ol>
            </div>

            <div className="text-xs text-muted-foreground text-center">
              Nach der Installation öffnet sich der Dienstplan wie eine normale App – ohne Browser-Leiste!
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => dismissInstallGuide(false)}>
              Später
            </Button>
            <Button className="flex-1" onClick={() => dismissInstallGuide(true)}>
              Verstanden
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DepartmentSchedule;
