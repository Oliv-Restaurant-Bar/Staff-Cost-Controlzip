/**
 * HoursCSVImportButton
 * ====================
 * Ist-Stunden-Import via CSV-Vorlage.
 *
 * - "Vorlage herunterladen": CSV mit allen Mitarbeitern × Tagen des gewählten Monats
 * - Upload + Parse + Vorschau → outputs MirusDailyImportEntry[]
 * - Format: Datum;Name;Abteilung;Stunden  (Semikolon-getrennt, CH-Locale)
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Download, Upload, FileSpreadsheet, AlertTriangle, CheckCircle2,
  XCircle, Info,
} from 'lucide-react';
import { Employee, MirusDailyImportEntry } from '@/types/personnel';
import { format, eachDayOfInterval, startOfMonth, endOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface HoursCSVImportButtonProps {
  employees: Employee[];
  selectedDate: Date;
  onImport: (entries: MirusDailyImportEntry[]) => void;
}

interface ParsedRow {
  date: string;
  name: string;
  department: string;
  hours: number;
  status: 'ok' | 'name_unmatched' | 'invalid';
  matchedEmployee?: Employee;
  error?: string;
}

function normalizeName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchEmployee(name: string, employees: Employee[]): Employee | undefined {
  const n = normalizeName(name);
  return (
    employees.find(e => normalizeName(`${e.firstName} ${e.lastName}`) === n) ||
    employees.find(e => normalizeName(`${e.lastName} ${e.firstName}`) === n) ||
    employees.find(e => normalizeName(e.lastName) === n) ||
    employees.find(e => {
      const full = normalizeName(`${e.firstName} ${e.lastName}`);
      return full.includes(n) || n.includes(full);
    })
  );
}

export function HoursCSVImportButton({ employees, selectedDate, onImport }: HoursCSVImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen]         = useState(false);
  const [rows, setRows]         = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [mode, setMode]         = useState<'replace' | 'update'>('update');

  // ── Download template ────────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const days = eachDayOfInterval({
      start: startOfMonth(selectedDate),
      end:   endOfMonth(selectedDate),
    });

    const lines: string[] = ['Datum;Name;Abteilung;Stunden'];

    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd');
      for (const emp of employees) {
        const dept = emp.department === 'küche' ? 'Küche' : 'Service';
        lines.push(`${dateStr};${emp.firstName} ${emp.lastName};${dept};`);
      }
    }

    const bom  = '\uFEFF';
    const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `Ist-Stunden_${format(selectedDate, 'yyyy-MM')}_Vorlage.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV-Vorlage heruntergeladen');
  };

  // ── Parse uploaded CSV ───────────────────────────────────────────────────────
  const handleFile = (file: File) => {
    if (!file.name.endsWith('.csv')) {
      toast.error('Nur CSV-Dateien (.csv) werden unterstützt');
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      let text = e.target?.result as string;
      // strip BOM
      if (text.startsWith('\uFEFF')) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { toast.error('CSV enthält keine Daten'); return; }

      // detect separator
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const idxDate  = headers.findIndex(h => h.includes('datum'));
      const idxName  = headers.findIndex(h => h.includes('name'));
      const idxDept  = headers.findIndex(h => h.includes('abteilung') || h.includes('dept'));
      const idxHours = headers.findIndex(h => h.includes('stunden') || h.includes('hours'));

      if (idxDate < 0 || idxName < 0 || idxHours < 0) {
        toast.error('CSV-Spalten nicht erkannt. Erwartet: Datum;Name;Abteilung;Stunden');
        return;
      }

      const parsed: ParsedRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols  = lines[i].split(sep);
        const date  = cols[idxDate]?.trim() ?? '';
        const name  = cols[idxName]?.trim() ?? '';
        const dept  = idxDept >= 0 ? (cols[idxDept]?.trim() ?? '') : '';
        const hRaw  = (cols[idxHours]?.trim() ?? '').replace(',', '.');
        const hours = parseFloat(hRaw);

        if (!date || !name) continue;
        if (isNaN(hours) || hours <= 0) continue; // skip empty rows

        // validate date
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          parsed.push({ date, name, department: dept, hours: 0, status: 'invalid', error: 'Datumsformat ungültig' });
          continue;
        }

        const matched = matchEmployee(name, employees);
        parsed.push({
          date,
          name,
          department: dept,
          hours,
          status: matched ? 'ok' : 'name_unmatched',
          matchedEmployee: matched,
        });
      }

      if (parsed.length === 0) {
        toast.error('Keine Zeilen mit Stunden gefunden (Stunden-Spalte leer oder 0?)');
        return;
      }

      setRows(parsed);
      setOpen(true);
    };
    reader.readAsText(file, 'utf-8');
  };

  // ── Confirm import ───────────────────────────────────────────────────────────
  const handleConfirm = () => {
    const entries: MirusDailyImportEntry[] = rows
      .filter(r => r.status === 'ok' && r.matchedEmployee)
      .map(r => ({
        name:       `${r.matchedEmployee!.firstName} ${r.matchedEmployee!.lastName}`,
        department: r.matchedEmployee!.department,
        date:       r.date,
        hours:      r.hours,
      }));

    onImport(entries);
    setOpen(false);
    setRows([]);
    setFileName('');
    toast.success(`${entries.length} Stunden-Einträge importiert`);
  };

  const okCount      = rows.filter(r => r.status === 'ok').length;
  const warnCount    = rows.filter(r => r.status === 'name_unmatched').length;
  const invalidCount = rows.filter(r => r.status === 'invalid').length;

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-1.5">
          <Download className="h-4 w-4" />
          Vorlage CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          className="gap-1.5"
        >
          <Upload className="h-4 w-4" />
          CSV importieren
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              CSV-Import Vorschau — {fileName}
            </DialogTitle>
          </DialogHeader>

          {/* Summary badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-green-100 text-green-800 border-green-200">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {okCount} Einträge OK
            </Badge>
            {warnCount > 0 && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {warnCount} Name nicht gefunden
              </Badge>
            )}
            {invalidCount > 0 && (
              <Badge variant="destructive">
                <XCircle className="h-3 w-3 mr-1" />
                {invalidCount} Fehler
              </Badge>
            )}
          </div>

          {warnCount > 0 && (
            <Alert className="text-sm py-2">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Nicht erkannte Namen werden beim Import übersprungen. Prüfe ob die Namen in der CSV exakt mit den Mitarbeiternamen im System übereinstimmen.
              </AlertDescription>
            </Alert>
          )}

          {/* Mode selector */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Import-Modus:</span>
            <Select value={mode} onValueChange={v => setMode(v as typeof mode)}>
              <SelectTrigger className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="update">Aktualisieren (bestehende behalten)</SelectItem>
                <SelectItem value="replace">Ersetzen (alles überschreiben)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Preview table */}
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Datum</TableHead>
                  <TableHead>Name (CSV)</TableHead>
                  <TableHead>Zugeordnet</TableHead>
                  <TableHead className="text-right">Stunden</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i} className={cn(r.status !== 'ok' ? 'opacity-60' : '')}>
                    <TableCell>
                      {r.status === 'ok' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      {r.status === 'name_unmatched' && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                      {r.status === 'invalid' && <XCircle className="h-4 w-4 text-destructive" />}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.date ? format(new Date(r.date + 'T00:00:00'), 'EEE, dd.MM.yy', { locale: de }) : r.date}
                    </TableCell>
                    <TableCell className="text-sm">{r.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.matchedEmployee
                        ? `${r.matchedEmployee.firstName} ${r.matchedEmployee.lastName}`
                        : r.error ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {r.hours > 0 ? `${r.hours.toFixed(2)} h` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); setRows([]); }}>Abbrechen</Button>
            <Button onClick={handleConfirm} disabled={okCount === 0}>
              <Upload className="h-4 w-4 mr-1.5" />
              {okCount} Einträge importieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
