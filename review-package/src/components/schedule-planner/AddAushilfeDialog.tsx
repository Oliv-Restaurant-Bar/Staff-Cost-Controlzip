import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UserPlus } from 'lucide-react';
import { Employee, Department } from '@/types/personnel';

interface AddAushilfeDialogProps {
  department: Department;
  onAdd: (employee: Omit<Employee, 'id'>) => void;
}

export const AddAushilfeDialog = ({ department, onAdd }: AddAushilfeDialogProps) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [hourlyWage, setHourlyWage] = useState('20');

  const handleSubmit = () => {
    if (name.trim()) {
      onAdd({
        name: name.trim(),
        department,
        employmentType: 'aushilfe',
        hourlyWage: parseFloat(hourlyWage) || 20,
      });
      setName('');
      setHourlyWage('20');
      setOpen(false);
    }
  };

  return (
    <>
      <Button 
        variant="outline" 
        size="sm" 
        onClick={() => setOpen(true)}
        className="gap-1"
      >
        <UserPlus className="h-4 w-4" />
        Aushilfe hinzufügen
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[350px]">
          <DialogHeader>
            <DialogTitle>
              Aushilfe hinzufügen ({department === 'service' ? 'Service' : 'Küche'})
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="z.B. Max Mustermann"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wage">Stundenlohn (CHF)</Label>
              <Input
                id="wage"
                type="number"
                step="0.50"
                value={hourlyWage}
                onChange={(e) => setHourlyWage(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
            <Button onClick={handleSubmit} disabled={!name.trim()}>
              Hinzufügen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
