import { useState, useEffect, useMemo } from 'react';
import { Employee, EmploymentType, Department } from '@/types/personnel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Calculator, Clock, Calendar } from 'lucide-react';

interface EmployeeFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (employee: Omit<Employee, 'id'> | Employee) => void;
  employee?: Employee | null;
}

export const EmployeeForm = ({ isOpen, onClose, onSubmit, employee }: EmployeeFormProps) => {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState<Department>('service');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('vollzeit');
  const [hourlyWage, setHourlyWage] = useState('');
  const [weeklyHours, setWeeklyHours] = useState('');
  
  // Monthly salary fields
  const [monthlySalary, setMonthlySalary] = useState('');
  const [monthlySalaryWith13th, setMonthlySalaryWith13th] = useState('');
  
  // Balance fields
  const [hoursBalance, setHoursBalance] = useState('0');
  const [vacationBalance, setVacationBalance] = useState('0');
  const [vacationDaysPerYear, setVacationDaysPerYear] = useState('25');
  
  // New fields for salary calculation
  const [wageInputMode, setWageInputMode] = useState<'hourly' | 'monthly'>('hourly');
  const [grossMonthlySalary, setGrossMonthlySalary] = useState('');
  const [include13thMonth, setInclude13thMonth] = useState(false);

  // Calculate hourly wage from monthly salary
  // Formula: Monthly salary / (weekly hours * 4.33 weeks per month)
  // If 13th month is included: Monthly salary * 13 / 12 / (weekly hours * 4.33)
  const calculatedHourlyWage = useMemo(() => {
    const monthly = parseFloat(grossMonthlySalary) || 0;
    const hours = parseFloat(weeklyHours) || 42; // Default 42 hours if not specified
    if (monthly <= 0 || hours <= 0) return 0;
    
    // Average weeks per month: 52 / 12 = 4.33
    const weeksPerMonth = 4.33;
    const effectiveMonthly = include13thMonth ? (monthly * 13) / 12 : monthly;
    return effectiveMonthly / (hours * weeksPerMonth);
  }, [grossMonthlySalary, weeklyHours, include13thMonth]);

  // Calculate monthly salary from hourly wage (reverse)
  const calculatedMonthlySalary = useMemo(() => {
    const hourly = parseFloat(hourlyWage) || 0;
    const hours = parseFloat(weeklyHours) || 42;
    if (hourly <= 0 || hours <= 0) return 0;
    
    const weeksPerMonth = 4.33;
    return hourly * hours * weeksPerMonth;
  }, [hourlyWage, weeklyHours]);

  // Auto-calculate 13th month salary when base salary changes
  useEffect(() => {
    const baseSalary = parseFloat(monthlySalary) || 0;
    if (baseSalary > 0 && employmentType === 'vollzeit') {
      // Calculate with 13th month: base * (1 + 1/12) = base * 13/12
      const with13th = baseSalary * (1 + 1/12);
      setMonthlySalaryWith13th(with13th.toFixed(2));
    }
  }, [monthlySalary, employmentType]);

  useEffect(() => {
    if (employee) {
      setName(employee.name);
      setDepartment(employee.department);
      setEmploymentType(employee.employmentType);
      setHourlyWage(employee.hourlyWage.toString());
      setWeeklyHours(employee.weeklyHours?.toString() || '');
      setMonthlySalary(employee.monthlySalary?.toString() || '');
      setMonthlySalaryWith13th(employee.monthlySalaryWith13th?.toString() || '');
      setHoursBalance(employee.hoursBalance?.toString() || '0');
      setVacationBalance(employee.vacationBalance?.toString() || '0');
      setVacationDaysPerYear(employee.vacationDaysPerYear?.toString() || '25');
      setWageInputMode('hourly');
      setGrossMonthlySalary('');
      setInclude13thMonth(false);
    } else {
      setName('');
      setDepartment('service');
      setEmploymentType('vollzeit');
      setHourlyWage('');
      setWeeklyHours('42');
      setMonthlySalary('');
      setMonthlySalaryWith13th('');
      setHoursBalance('0');
      setVacationBalance('0');
      setVacationDaysPerYear('25');
      setWageInputMode('hourly');
      setGrossMonthlySalary('');
      setInclude13thMonth(false);
    }
  }, [employee, isOpen]);

  // Auto-update hourly wage when monthly salary changes
  useEffect(() => {
    if (wageInputMode === 'monthly' && calculatedHourlyWage > 0) {
      setHourlyWage(calculatedHourlyWage.toFixed(2));
    }
  }, [calculatedHourlyWage, wageInputMode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const finalHourlyWage = wageInputMode === 'monthly' 
      ? calculatedHourlyWage 
      : parseFloat(hourlyWage) || 0;
    
    const parsedMonthlySalary = parseFloat(monthlySalary) || undefined;
    const parsedMonthlySalaryWith13th = parseFloat(monthlySalaryWith13th) || undefined;
    
    const data: Omit<Employee, 'id'> = {
      name: name.trim(),
      department,
      employmentType,
      hourlyWage: finalHourlyWage,
      weeklyHours: weeklyHours ? parseFloat(weeklyHours) : undefined,
      monthlySalary: employmentType === 'vollzeit' ? parsedMonthlySalary : undefined,
      monthlySalaryWith13th: employmentType === 'vollzeit' ? parsedMonthlySalaryWith13th : undefined,
      hoursBalance: parseFloat(hoursBalance) || 0,
      vacationBalance: parseFloat(vacationBalance) || 0,
      vacationDaysPerYear: parseFloat(vacationDaysPerYear) || 25,
    };

    if (employee) {
      onSubmit({ ...data, id: employee.id });
    } else {
      onSubmit(data);
    }
    
    onClose();
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('de-CH', {
      style: 'currency',
      currency: 'CHF',
    }).format(value);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>
            {employee ? 'Mitarbeiter bearbeiten' : 'Neuen Mitarbeiter hinzufügen'}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] px-6 pb-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Basic Info - Compact 3-column grid */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-3 sm:col-span-1 space-y-1.5">
                <Label htmlFor="name" className="text-xs">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Max Mustermann"
                  required
                  maxLength={100}
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="department" className="text-xs">Abteilung</Label>
                <Select value={department} onValueChange={(v) => setDepartment(v as Department)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="küche">Küche</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="employment" className="text-xs">Anstellung</Label>
                <Select value={employmentType} onValueChange={(v) => setEmploymentType(v as EmploymentType)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vollzeit">Vollzeit</SelectItem>
                    <SelectItem value="teilzeit">Teilzeit</SelectItem>
                    <SelectItem value="minijob">Minijob</SelectItem>
                    <SelectItem value="aushilfe">Aushilfe</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Hours & Wage - Compact row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hours" className="text-xs">Wochenstunden</Label>
                <Input
                  id="hours"
                  type="number"
                  step="0.5"
                  min="1"
                  max="60"
                  value={weeklyHours}
                  onChange={(e) => setWeeklyHours(e.target.value)}
                  placeholder="42"
                  required
                  className="h-9"
                />
              </div>

              {/* Wage Input Tabs - More compact */}
              <div className="space-y-1.5">
                <Label className="text-xs">Lohn</Label>
                <Tabs value={wageInputMode} onValueChange={(v) => setWageInputMode(v as 'hourly' | 'monthly')} className="w-full">
                  <TabsList className="grid w-full grid-cols-2 h-9">
                    <TabsTrigger value="hourly" className="text-xs">Stunde</TabsTrigger>
                    <TabsTrigger value="monthly" className="text-xs">
                      <Calculator className="h-3 w-3 mr-1" />
                      Brutto
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>

            {/* Wage Input Content */}
            {wageInputMode === 'hourly' ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="wage" className="text-xs">Stundenlohn (CHF)</Label>
                    <Input
                      id="wage"
                      type="number"
                      step="0.01"
                      min="0"
                      value={hourlyWage}
                      onChange={(e) => setHourlyWage(e.target.value)}
                      placeholder="25.00"
                      required={wageInputMode === 'hourly'}
                      className="h-9"
                    />
                  </div>
                  {parseFloat(hourlyWage) > 0 && parseFloat(weeklyHours) > 0 && (
                    <div className="flex items-end">
                      <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 w-full">
                        ≈ <strong>{formatCurrency(calculatedMonthlySalary)}</strong>/Mt.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="monthly" className="text-xs">Bruttolohn/Monat (CHF)</Label>
                    <Input
                      id="monthly"
                      type="number"
                      step="100"
                      min="0"
                      value={grossMonthlySalary}
                      onChange={(e) => setGrossMonthlySalary(e.target.value)}
                      placeholder="4500"
                      required={wageInputMode === 'monthly'}
                      className="h-9"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex items-center space-x-1.5">
                      <Checkbox 
                        id="include13th" 
                        checked={include13thMonth}
                        onCheckedChange={(checked) => setInclude13thMonth(checked === true)}
                      />
                      <Label htmlFor="include13th" className="text-xs cursor-pointer">
                        13. ML
                      </Label>
                    </div>
                  </div>
                </div>
                {calculatedHourlyWage > 0 && (
                  <div className="text-xs bg-primary/10 text-primary rounded-md p-2">
                    <Calculator className="h-3 w-3 inline mr-1" />
                    Stundenlohn: <strong>{formatCurrency(calculatedHourlyWage)}</strong>
                  </div>
                )}
              </div>
            )}

            {/* Monthly Salary Fields (only for Vollzeit) - Compact */}
            {employmentType === 'vollzeit' && (
              <div className="space-y-2 p-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/20">
                <Label className="text-xs text-green-700 dark:text-green-400 font-medium">Monatslohn (Kostenübersicht)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="monthlySalary" className="text-xs text-muted-foreground">Basis</Label>
                    <Input
                      id="monthlySalary"
                      type="number"
                      step="0.01"
                      min="0"
                      value={monthlySalary}
                      onChange={(e) => setMonthlySalary(e.target.value)}
                      placeholder="5000.00"
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="monthlySalaryWith13th" className="text-xs text-muted-foreground">inkl. 13. ML</Label>
                    <Input
                      id="monthlySalaryWith13th"
                      type="number"
                      step="0.01"
                      min="0"
                      value={monthlySalaryWith13th}
                      onChange={(e) => setMonthlySalaryWith13th(e.target.value)}
                      placeholder="5416.67"
                      className="h-9 border-green-300 dark:border-green-700"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Balance Fields Section - Compact horizontal layout */}
            <div className="space-y-2 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/20">
              <Label className="text-xs text-blue-700 dark:text-blue-400 font-medium flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Stunden- & Feriensaldo
              </Label>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="hoursBalance" className="text-xs text-muted-foreground">Stunden</Label>
                  <Input
                    id="hoursBalance"
                    type="number"
                    step="0.5"
                    value={hoursBalance}
                    onChange={(e) => setHoursBalance(e.target.value)}
                    placeholder="0"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="vacationBalance" className="text-xs text-muted-foreground">Ferien</Label>
                  <Input
                    id="vacationBalance"
                    type="number"
                    step="0.5"
                    min="0"
                    value={vacationBalance}
                    onChange={(e) => setVacationBalance(e.target.value)}
                    placeholder="0"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="vacationDaysPerYear" className="text-xs text-muted-foreground flex items-center gap-0.5">
                    <Calendar className="h-3 w-3" />
                    /Jahr
                  </Label>
                  <Input
                    id="vacationDaysPerYear"
                    type="number"
                    step="1"
                    min="0"
                    value={vacationDaysPerYear}
                    onChange={(e) => setVacationDaysPerYear(e.target.value)}
                    placeholder="25"
                    className="h-9"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-background pb-1">
              <Button type="button" variant="outline" onClick={onClose} size="sm">
                Abbrechen
              </Button>
              <Button type="submit" size="sm">
                {employee ? 'Speichern' : 'Hinzufügen'}
              </Button>
            </div>
          </form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
