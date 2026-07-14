import { useState } from 'react';
import { Employee } from '@/types/personnel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Clock, Calendar, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmployeeBalanceEditorProps {
  employee: Employee;
  isOpen: boolean;
  onClose: () => void;
  onSave: (employeeId: string, hoursBalance: number, vacationBalance: number) => void;
}

export const EmployeeBalanceEditor = ({
  employee,
  isOpen,
  onClose,
  onSave,
}: EmployeeBalanceEditorProps) => {
  const [hoursBalance, setHoursBalance] = useState(
    employee.hoursBalance?.toString() || '0'
  );
  const [vacationBalance, setVacationBalance] = useState(
    employee.vacationBalance?.toString() || '0'
  );

  const handleSave = () => {
    onSave(
      employee.id,
      parseFloat(hoursBalance) || 0,
      parseFloat(vacationBalance) || 0
    );
    onClose();
  };

  const hoursValue = parseFloat(hoursBalance) || 0;
  const vacationValue = parseFloat(vacationBalance) || 0;

  const getHoursIcon = () => {
    if (hoursValue > 0) return <TrendingUp className="h-4 w-4 text-green-500" />;
    if (hoursValue < 0) return <TrendingDown className="h-4 w-4 text-red-500" />;
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Saldo bearbeiten: {employee.name}
          </DialogTitle>
          <DialogDescription>
            Stunden- und Feriensaldo manuell anpassen. Diese Werte werden monatlich fortgeführt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Hours Balance */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-500" />
              <Label htmlFor="hoursBalance" className="font-medium">
                Stundensaldo
              </Label>
            </div>
            <div className="relative">
              <Input
                id="hoursBalance"
                type="number"
                step="0.5"
                value={hoursBalance}
                onChange={(e) => setHoursBalance(e.target.value)}
                className={cn(
                  "pr-12",
                  hoursValue > 0 && "border-green-300 focus-visible:ring-green-500",
                  hoursValue < 0 && "border-red-300 focus-visible:ring-red-500"
                )}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 text-sm text-muted-foreground">
                {getHoursIcon()}
                <span>Std.</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Positive Werte = Überstunden, Negative Werte = Minusstunden
            </p>
            {employee.weeklyHours && (
              <div className="text-xs bg-muted/50 rounded-md p-2">
                <span className="text-muted-foreground">Soll-Stunden/Woche:</span>{' '}
                <span className="font-medium">{employee.weeklyHours}h</span>
              </div>
            )}
          </div>

          {/* Vacation Balance */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-orange-500" />
              <Label htmlFor="vacationBalance" className="font-medium">
                Feriensaldo
              </Label>
            </div>
            <div className="relative">
              <Input
                id="vacationBalance"
                type="number"
                step="0.5"
                min="0"
                value={vacationBalance}
                onChange={(e) => setVacationBalance(e.target.value)}
                className="pr-12"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                Tage
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Verbleibende Ferientage für das aktuelle Jahr
            </p>
            {employee.vacationDaysPerYear && (
              <div className="text-xs bg-muted/50 rounded-md p-2">
                <span className="text-muted-foreground">Ferientage/Jahr (Vertrag):</span>{' '}
                <span className="font-medium">{employee.vacationDaysPerYear} Tage</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={handleSave}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
