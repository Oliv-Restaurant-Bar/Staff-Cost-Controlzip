import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, Check, X, AlertCircle } from "lucide-react";
import * as XLSX from "xlsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ParsedReservation {
  external_id?: string;
  guest_name: string;
  date: string;
  time: string;
  guest_count: number;
  guest_email?: string;
  guest_phone?: string;
  comment?: string;
  location?: string;
  menu_selection?: string;
  is_confirmed?: boolean;
  _error?: string;
  _row?: number;
}

// Try to parse various date formats to YYYY-MM-DD
function parseDate(value: any): string | null {
  if (!value) return null;
  
  // If it's an Excel date number
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
  }
  
  const str = String(value).trim();
  
  // DD.MM.YYYY
  const germanMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (germanMatch) {
    return `${germanMatch[3]}-${germanMatch[2].padStart(2, '0')}-${germanMatch[1].padStart(2, '0')}`;
  }
  
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  
  // DD/MM/YYYY
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[1].padStart(2, '0')}`;
  }
  
  return null;
}

// Parse time to HH:MM format
function parseTime(value: any): string | null {
  if (!value) return null;
  
  // Excel time fraction
  if (typeof value === 'number' && value < 1) {
    const totalMinutes = Math.round(value * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  
  const str = String(value).trim();
  
  // HH:MM or H:MM
  const match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  
  return null;
}

// Map column headers to our fields
const COLUMN_MAPPINGS: Record<string, keyof ParsedReservation> = {
  // German
  'name': 'guest_name',
  'gastname': 'guest_name',
  'gast': 'guest_name',
  'kundenname': 'guest_name',
  'datum': 'date',
  'reservierungsdatum': 'date',
  'uhrzeit': 'time',
  'zeit': 'time',
  'anzahl': 'guest_count',
  'personen': 'guest_count',
  'gäste': 'guest_count',
  'gaeste': 'guest_count',
  'pax': 'guest_count',
  'email': 'guest_email',
  'e-mail': 'guest_email',
  'mail': 'guest_email',
  'telefon': 'guest_phone',
  'tel': 'guest_phone',
  'phone': 'guest_phone',
  'mobil': 'guest_phone',
  'bemerkung': 'comment',
  'kommentar': 'comment',
  'anmerkung': 'comment',
  'notiz': 'comment',
  'ort': 'location',
  'tisch': 'location',
  'bereich': 'location',
  'raum': 'location',
  'menü': 'menu_selection',
  'menu': 'menu_selection',
  'auswahl': 'menu_selection',
  'id': 'external_id',
  'reservierungsnummer': 'external_id',
  'buchungsnummer': 'external_id',
  'bestätigt': 'is_confirmed',
  'bestaetigt': 'is_confirmed',
  'confirmed': 'is_confirmed',
  // English
  'guest_name': 'guest_name',
  'guest name': 'guest_name',
  'date': 'date',
  'time': 'time',
  'guest_count': 'guest_count',
  'guests': 'guest_count',
  'party_size': 'guest_count',
  'party size': 'guest_count',
  'guest_email': 'guest_email',
  'guest_phone': 'guest_phone',
  'notes': 'comment',
  'comment': 'comment',
  'table': 'location',
  'location': 'location',
  'menu_selection': 'menu_selection',
  'external_id': 'external_id',
  'reservation_id': 'external_id',
  'is_confirmed': 'is_confirmed',
};

function determineShift(time: string): 'mittag' | 'abend' {
  const hours = parseInt(time.split(':')[0], 10);
  return hours < 15 ? 'mittag' : 'abend';
}

export function FileImportReservations({ onImportComplete }: { onImportComplete?: () => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const [parsedData, setParsedData] = useState<ParsedReservation[]>([]);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const processFile = async (file: File) => {
    setFileName(file.name);
    
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array', cellDates: true });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as any[][];

      if (jsonData.length < 2) {
        toast.error('Die Datei enthält keine Daten');
        return;
      }

      // First row is headers
      const headers = jsonData[0].map(h => String(h || '').toLowerCase().trim());
      
      // Map headers to our fields
      const columnMap: Record<number, keyof ParsedReservation> = {};
      headers.forEach((header, index) => {
        const mapped = COLUMN_MAPPINGS[header];
        if (mapped) {
          columnMap[index] = mapped;
        }
      });

      // Check required columns
      const hasName = Object.values(columnMap).includes('guest_name');
      const hasDate = Object.values(columnMap).includes('date');
      const hasTime = Object.values(columnMap).includes('time');
      const hasCount = Object.values(columnMap).includes('guest_count');

      if (!hasName || !hasDate || !hasTime || !hasCount) {
        const missing = [];
        if (!hasName) missing.push('Name');
        if (!hasDate) missing.push('Datum');
        if (!hasTime) missing.push('Uhrzeit');
        if (!hasCount) missing.push('Anzahl');
        toast.error(`Fehlende Spalten: ${missing.join(', ')}`);
        return;
      }

      // Parse data rows
      const parsed: ParsedReservation[] = [];
      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || row.every(cell => cell === null || cell === undefined || cell === '')) {
          continue; // Skip empty rows
        }

        const reservation: ParsedReservation = {
          guest_name: '',
          date: '',
          time: '',
          guest_count: 0,
          _row: i + 1
        };

        for (const [colIndex, field] of Object.entries(columnMap)) {
          const value = row[parseInt(colIndex)];
          
          switch (field) {
            case 'guest_name':
              reservation.guest_name = String(value || '').trim();
              break;
            case 'date':
              reservation.date = parseDate(value) || '';
              break;
            case 'time':
              reservation.time = parseTime(value) || '';
              break;
            case 'guest_count':
              reservation.guest_count = parseInt(String(value), 10) || 0;
              break;
            case 'guest_email':
              reservation.guest_email = String(value || '').trim() || undefined;
              break;
            case 'guest_phone':
              reservation.guest_phone = String(value || '').trim() || undefined;
              break;
            case 'comment':
              reservation.comment = String(value || '').trim() || undefined;
              break;
            case 'location':
              reservation.location = String(value || '').trim() || undefined;
              break;
            case 'menu_selection':
              reservation.menu_selection = String(value || '').trim() || undefined;
              break;
            case 'external_id':
              reservation.external_id = String(value || '').trim() || undefined;
              break;
            case 'is_confirmed':
              const confirmVal = String(value || '').toLowerCase();
              reservation.is_confirmed = ['ja', 'yes', 'true', '1', 'x'].includes(confirmVal);
              break;
          }
        }

        // Validate
        const errors: string[] = [];
        if (!reservation.guest_name) errors.push('Name fehlt');
        if (!reservation.date) errors.push('Datum ungültig');
        if (!reservation.time) errors.push('Uhrzeit ungültig');
        if (reservation.guest_count < 1 || reservation.guest_count > 500) errors.push('Gästeanzahl ungültig');

        if (errors.length > 0) {
          reservation._error = errors.join(', ');
        }

        parsed.push(reservation);
      }

      if (parsed.length === 0) {
        toast.error('Keine gültigen Reservierungen gefunden');
        return;
      }

      setParsedData(parsed);
      toast.success(`${parsed.length} Reservierungen erkannt`);
    } catch (error) {
      console.error('Error parsing file:', error);
      toast.error('Fehler beim Lesen der Datei');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv'))) {
      processFile(file);
    } else {
      toast.error('Bitte eine Excel- oder CSV-Datei hochladen');
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const importReservations = async () => {
    const validReservations = parsedData.filter(r => !r._error);
    if (validReservations.length === 0) {
      toast.error('Keine gültigen Reservierungen zum Importieren');
      return;
    }

    setImporting(true);
    let successCount = 0;
    let errorCount = 0;

    for (const res of validReservations) {
      try {
        const shift = determineShift(res.time);
        const groupType = res.guest_count >= 10 ? 'laufzettel' : 'alacarte';

        // Check for existing by external_id
        if (res.external_id) {
          const { data: existing } = await supabase
            .from('group_reservations')
            .select('id')
            .eq('external_id', res.external_id)
            .single();

          if (existing) {
            // Update
            await supabase
              .from('group_reservations')
              .update({
                group_name: res.guest_name,
                date: res.date,
                shift,
                guest_count: res.guest_count,
                location: res.location || null,
                notes: [res.comment, res.menu_selection].filter(Boolean).join('\n') || null,
                is_confirmed: res.is_confirmed ?? true,
              })
              .eq('id', existing.id);
            
            successCount++;
            continue;
          }
        }

        // Insert new
        const { error } = await supabase
          .from('group_reservations')
          .insert({
            external_id: res.external_id || null,
            group_name: res.guest_name,
            date: res.date,
            shift,
            guest_count: res.guest_count,
            revenue_per_person: 50,
            location: res.location || null,
            notes: [res.comment, res.menu_selection].filter(Boolean).join('\n') || null,
            group_type: groupType,
            is_confirmed: res.is_confirmed ?? true,
            source: 'file_import'
          });

        if (error) throw error;
        successCount++;
      } catch (error) {
        console.error('Error importing reservation:', error);
        errorCount++;
      }
    }

    // Log the import
    await supabase
      .from('external_api_import_log')
      .insert({
        source_system: fileName || 'file',
        import_type: 'file',
        reservations_count: validReservations.length,
        success_count: successCount,
        error_count: errorCount
      });

    setImporting(false);
    setParsedData([]);
    setFileName(null);

    if (errorCount === 0) {
      toast.success(`${successCount} Reservierungen erfolgreich importiert`);
    } else {
      toast.warning(`${successCount} importiert, ${errorCount} Fehler`);
    }

    onImportComplete?.();
  };

  const validCount = parsedData.filter(r => !r._error).length;
  const errorCount = parsedData.filter(r => r._error).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5" />
          Datei-Import
        </CardTitle>
        <CardDescription>
          Reservierungen aus Excel oder CSV importieren
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {parsedData.length === 0 ? (
          <>
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
              }`}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-muted-foreground mb-2">
                Excel- oder CSV-Datei hier ablegen
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                oder
              </p>
              <Label htmlFor="file-upload" className="cursor-pointer">
                <Input
                  id="file-upload"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button variant="outline" asChild>
                  <span>Datei auswählen</span>
                </Button>
              </Label>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">Erwartete Spalten:</p>
              <p>Pflicht: Name, Datum, Uhrzeit, Anzahl/Personen/Gäste</p>
              <p>Optional: E-Mail, Telefon, Kommentar, Ort/Tisch, Menü, ID, Bestätigt</p>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{fileName}</Badge>
                <Badge variant="secondary" className="bg-green-100 text-green-800">
                  <Check className="h-3 w-3 mr-1" />
                  {validCount} gültig
                </Badge>
                {errorCount > 0 && (
                  <Badge variant="destructive">
                    <X className="h-3 w-3 mr-1" />
                    {errorCount} fehlerhaft
                  </Badge>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setParsedData([]); setFileName(null); }}>
                Zurücksetzen
              </Button>
            </div>

            <ScrollArea className="h-[300px] border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">Zeile</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Datum</TableHead>
                    <TableHead>Zeit</TableHead>
                    <TableHead>Gäste</TableHead>
                    <TableHead>Ort</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedData.map((res, i) => (
                    <TableRow key={i} className={res._error ? 'bg-red-50' : ''}>
                      <TableCell className="text-xs text-muted-foreground">{res._row}</TableCell>
                      <TableCell>
                        {res._error ? (
                          <div className="flex items-center gap-1 text-red-600">
                            <AlertCircle className="h-4 w-4" />
                            <span className="text-xs">{res._error}</span>
                          </div>
                        ) : (
                          <Check className="h-4 w-4 text-green-600" />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{res.guest_name || '-'}</TableCell>
                      <TableCell>{res.date || '-'}</TableCell>
                      <TableCell>{res.time || '-'}</TableCell>
                      <TableCell>{res.guest_count || '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{res.location || '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setParsedData([]); setFileName(null); }}>
                Abbrechen
              </Button>
              <Button onClick={importReservations} disabled={importing || validCount === 0}>
                {importing ? 'Importiere...' : `${validCount} Reservierungen importieren`}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
