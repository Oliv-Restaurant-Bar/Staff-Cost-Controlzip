import { useState } from 'react';
import { Employee } from '@/types/personnel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { CalendarOff } from 'lucide-react';

type DayOfWeek = 'montag' | 'dienstag' | 'mittwoch' | 'donnerstag' | 'freitag' | 'samstag' | 'sonntag';

const WEEKDAYS: { value: DayOfWeek; label: string }[] = [
  { value: 'montag', label: 'Montag' },
  { value: 'dienstag', label: 'Dienstag' },
  { value: 'mittwoch', label: 'Mittwoch' },
  { value: 'donnerstag', label: 'Donnerstag' },
  { value: 'freitag', label: 'Freitag' },
  { value: 'samstag', label: 'Samstag' },
  { value: 'sonntag', label: 'Sonntag' },
];

interface DaysOffConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: Employee;
  onSave: (employeeId: string, daysOff: DayOfWeek[]) => void;
}

export const DaysOffConfigDialog = ({
  open,
  onOpenChange,
  employee,
  onSave,
}: DaysOffConfigDialogProps) => {
  const [selectedDays, setSelectedDays] = useState<DayOfWeek[]>(
    (employee.daysOff as DayOfWeek[]) || []
  );

  const handleToggleDay = (day: DayOfWeek) => {
    setSelectedDays(prev =>
      prev.includes(day)
        ? prev.filter(d => d !== day)
        : [...prev, day]
    );
  };

  const handleSave = () => {
    onSave(employee.id, selectedDays);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarOff className="h-5 w-5" />
            Freie Tage konfigurieren
          </DialogTitle>
          <DialogDescription>
            Wähle die wöchentlichen freien Tage für <strong>{employee.name}</strong>.
            Diese Tage werden automatisch als "Frei" markiert.
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-4">
          <div className="grid grid-cols-2 gap-3">
            {WEEKDAYS.map(day => (
              <div key={day.value} className="flex items-center space-x-2">
                <Checkbox
                  id={`day-${day.value}`}
                  checked={selectedDays.includes(day.value)}
                  onCheckedChange={() => handleToggleDay(day.value)}
                />
                <Label
                  htmlFor={`day-${day.value}`}
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                >
                  {day.label}
                </Label>
              </div>
            ))}
          </div>
          
          {selectedDays.length > 0 && (
            <div className="mt-4 p-3 bg-muted rounded-md">
              <p className="text-sm text-muted-foreground">
                <strong>{employee.name}</strong> hat jeden{' '}
                {selectedDays.map((day, i) => (
                  <span key={day}>
                    {WEEKDAYS.find(d => d.value === day)?.label}
                    {i < selectedDays.length - 2 && ', '}
                    {i === selectedDays.length - 2 && ' und '}
                  </span>
                ))}{' '}
                frei.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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