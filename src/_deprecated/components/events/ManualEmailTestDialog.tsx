import { useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileText, TestTube, Loader2, CheckCircle, XCircle, Upload, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface ParsedResult {
  success: boolean;
  id?: string;
  needs_review?: boolean;
  guest_count?: number;
  parsed?: {
    reservation_number: string | null;
    guest_name: string;
    guest_email: string | null;
    guest_phone: string | null;
    date: string;
    time: string;
    guest_count: number;
    comment: string | null;
    location: string | null;
  };
  error?: string;
  message?: string; // For "already imported" messages
  alreadyExists?: boolean;
}

interface BatchResult {
  fileName: string;
  result: ParsedResult;
}

const EXAMPLE_EMAIL = `Neue Reservation

Reservationsnummer: 12345

Name: Max Mustermann
E-Mail: max@beispiel.ch
Telefon: +41 79 123 45 67

Datum: 30.01.2026
Zeit: 19:00
Gäste: 8

Kommentar: Fensterplatz bevorzugt

Ort: EG Restaurant`;

// Parse .eml file content to extract the text/plain body
function parseEmlFile(emlContent: string): string {
  // Find the text/plain part
  const boundaryMatch = emlContent.match(/boundary="?([^"\r\n]+)"?/);
  
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = emlContent.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    
    for (const part of parts) {
      if (part.includes('Content-Type: text/plain')) {
        // Extract content after headers (after double newline)
        const contentMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
        if (contentMatch) {
          let content = contentMatch[1];
          
          // Handle quoted-printable encoding
          if (part.includes('quoted-printable')) {
            content = content
              // Decode soft line breaks (= at end of line)
              .replace(/=\r?\n/g, '')
              // Decode hex-encoded characters
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => 
                String.fromCharCode(parseInt(hex, 16))
              );
          }
          
          // Clean up whitespace while preserving structure
          return content
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n /g, '\n')
            .trim();
        }
      }
    }
  }
  
  // Fallback: try to find content after headers
  const simpleMatch = emlContent.match(/\r?\n\r?\n([\s\S]+)/);
  return simpleMatch ? simpleMatch[1].trim() : emlContent;
}

export const ManualEmailTestDialog = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [emailContent, setEmailContent] = useState('');
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const processEmail = async (content: string): Promise<ParsedResult> => {
    const response = await supabase.functions.invoke('parse-reservation-email', {
      body: {
        'body-plain': content,
        subject: 'Test Import',
        from: 'test@manual-import.local'
      },
    });

    if (response.error) {
      return { success: false, error: response.error.message };
    }
    
    // Handle "already exists" as a special success case
    if (response.data?.message?.includes('already imported')) {
      return { 
        ...response.data, 
        success: true, 
        alreadyExists: true 
      };
    }
    
    return response.data;
  };

  const handleTest = async () => {
    if (!emailContent.trim()) {
      toast.error('Bitte E-Mail-Inhalt eingeben');
      return;
    }

    setIsTesting(true);
    setResult(null);
    setBatchResults([]);

    try {
      const result = await processEmail(emailContent);
      setResult(result);
      if (result.success) {
        toast.success('Reservation erfolgreich importiert!');
      } else {
        toast.error(result.error || 'Parsing fehlgeschlagen');
      }
    } catch (error: any) {
      console.error('Error testing email:', error);
      setResult({ success: false, error: error.message });
      toast.error('Fehler beim Testen');
    } finally {
      setIsTesting(false);
    }
  };

  const handleLoadExample = () => {
    setEmailContent(EXAMPLE_EMAIL);
    setResult(null);
    setBatchResults([]);
  };

  const handleReset = () => {
    setEmailContent('');
    setResult(null);
    setBatchResults([]);
    setBatchProgress(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    await processFiles(Array.from(files));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const processFiles = async (files: File[]) => {
    const emlFiles = files.filter(f => f.name.endsWith('.eml'));
    if (emlFiles.length === 0) {
      toast.error('Bitte nur .eml-Dateien hochladen');
      return;
    }

    // Single file: load into textarea
    if (emlFiles.length === 1) {
      try {
        const content = await emlFiles[0].text();
        const parsedContent = parseEmlFile(content);
        setEmailContent(parsedContent);
        setResult(null);
        setBatchResults([]);
        toast.success(`EML-Datei "${emlFiles[0].name}" geladen`);
      } catch (error) {
        console.error('Error reading file:', error);
        toast.error('Fehler beim Lesen der Datei');
      }
      return;
    }

    // Multiple files: batch import
    setIsTesting(true);
    setResult(null);
    setBatchResults([]);
    setBatchProgress({ current: 0, total: emlFiles.length });

    const results: BatchResult[] = [];

    for (let i = 0; i < emlFiles.length; i++) {
      const file = emlFiles[i];
      setBatchProgress({ current: i + 1, total: emlFiles.length });

      try {
        const content = await file.text();
        const parsedContent = parseEmlFile(content);
        const result = await processEmail(parsedContent);
        results.push({ fileName: file.name, result });
      } catch (error: any) {
        results.push({ 
          fileName: file.name, 
          result: { success: false, error: error.message } 
        });
      }
    }

    setBatchResults(results);
    setBatchProgress(null);
    setIsTesting(false);

    const successCount = results.filter(r => r.result.success && !r.result.alreadyExists).length;
    const duplicateCount = results.filter(r => r.result.success && r.result.alreadyExists).length;
    const errorCount = results.filter(r => !r.result.success).length;
    
    if (errorCount === 0 && duplicateCount === 0) {
      toast.success(`Alle ${successCount} Reservationen erfolgreich importiert!`);
    } else if (errorCount === 0) {
      toast.success(`${successCount} neu importiert, ${duplicateCount} bereits vorhanden`);
    } else if (successCount > 0 || duplicateCount > 0) {
      toast.warning(`${successCount} importiert, ${duplicateCount} bereits vorhanden, ${errorCount} fehlgeschlagen`);
    } else {
      toast.error('Keine Reservationen importiert');
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isTesting) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set to false if we're leaving the drop zone entirely
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (isTesting) return;

    const files = Array.from(e.dataTransfer.files);
    await processFiles(files);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      if (!open) {
        handleReset();
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <TestTube className="h-4 w-4" />
          Parser testen
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            E-Mail-Parser manuell testen
          </DialogTitle>
        </DialogHeader>

        <div 
          ref={dropZoneRef}
          className={`space-y-4 py-4 transition-colors ${isDragging ? 'bg-primary/5 rounded-lg' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drag & Drop Zone */}
          <div 
            className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-all ${
              isDragging 
                ? 'border-primary bg-primary/10 scale-[1.02]' 
                : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            } ${isTesting ? 'opacity-50 pointer-events-none' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".eml"
              multiple
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              disabled={isTesting}
            />
            <div className="flex flex-col items-center gap-2">
              <Upload className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
              <div>
                <p className={`text-sm font-medium ${isDragging ? 'text-primary' : ''}`}>
                  {isDragging ? 'Dateien hier ablegen' : 'EML-Dateien hierher ziehen'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  oder <span className="text-primary underline cursor-pointer">Dateien auswählen</span>
                </p>
              </div>
            </div>
            {batchProgress && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mt-3">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Verarbeite Datei {batchProgress.current} von {batchProgress.total}...</span>
              </div>
            )}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">oder</span>
            </div>
          </div>

          {/* Manual Text Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>E-Mail-Inhalt einfügen</Label>
              <Button variant="ghost" size="sm" onClick={handleLoadExample}>
                Beispiel laden
              </Button>
            </div>
            <Textarea
              placeholder={`Fügen Sie hier den E-Mail-Inhalt ein...

Beispiel:
Reservationsnummer: 12345
Name: Max Mustermann
E-Mail: max@beispiel.ch
Datum: 30.01.2026
Zeit: 19:00
Gäste: 4`}
              value={emailContent}
              onChange={(e) => {
                setEmailContent(e.target.value);
                setResult(null);
              }}
              rows={12}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Der Parser erkennt automatisch Reservationsnummer, Name, E-Mail, Telefon, Datum, Uhrzeit, Gästeanzahl, Kommentar und Ort.
            </p>
          </div>

          {result && (
            <Card className={result.success ? 'border-green-500/50 bg-green-50/50 dark:bg-green-950/20' : 'border-red-500/50 bg-red-50/50 dark:bg-red-950/20'}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  {result.success ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <span className="text-green-700 dark:text-green-400">Erfolgreich geparst</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-red-600" />
                      <span className="text-red-700 dark:text-red-400">Parsing fehlgeschlagen</span>
                    </>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.success && result.parsed ? (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Name:</span>
                      <p className="font-medium">{result.parsed.guest_name}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Datum:</span>
                      <p className="font-medium">{result.parsed.date}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Zeit:</span>
                      <p className="font-medium">{result.parsed.time}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Gäste:</span>
                      <p className="font-medium flex items-center gap-1">
                        {result.parsed.guest_count}
                        {result.needs_review && (
                          <Badge variant="outline" className="text-xs bg-amber-100 text-amber-800 border-amber-300">
                            Prüfen
                          </Badge>
                        )}
                      </p>
                    </div>
                    {result.parsed.reservation_number && (
                      <div>
                        <span className="text-muted-foreground">Res.-Nr.:</span>
                        <p className="font-medium">{result.parsed.reservation_number}</p>
                      </div>
                    )}
                    {result.parsed.guest_email && (
                      <div>
                        <span className="text-muted-foreground">E-Mail:</span>
                        <p className="font-medium truncate">{result.parsed.guest_email}</p>
                      </div>
                    )}
                    {result.parsed.guest_phone && (
                      <div>
                        <span className="text-muted-foreground">Telefon:</span>
                        <p className="font-medium">{result.parsed.guest_phone}</p>
                      </div>
                    )}
                    {result.parsed.location && (
                      <div>
                        <span className="text-muted-foreground">Ort:</span>
                        <p className="font-medium">{result.parsed.location}</p>
                      </div>
                    )}
                    {result.parsed.comment && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Kommentar:</span>
                        <p className="font-medium">{result.parsed.comment}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-red-600 dark:text-red-400">
                    {result.error || 'Konnte keine Reservationsdaten aus dem Text extrahieren. Stellen Sie sicher, dass Datum, Uhrzeit und Name enthalten sind.'}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Batch Results */}
          {batchResults.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Batch-Import Ergebnisse</h4>
                <Badge variant="outline">
                  {batchResults.filter(r => r.result.success).length} / {batchResults.length} erfolgreich
                </Badge>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {batchResults.map((item, index) => {
                  const isSuccess = item.result.success;
                  const isDuplicate = item.result.alreadyExists;
                  
                  let cardClass = 'border-red-500/50 bg-red-50/50 dark:bg-red-950/20';
                  if (isSuccess && isDuplicate) {
                    cardClass = 'border-blue-500/50 bg-blue-50/50 dark:bg-blue-950/20';
                  } else if (isSuccess) {
                    cardClass = 'border-green-500/50 bg-green-50/50 dark:bg-green-950/20';
                  }
                  
                  return (
                    <Card 
                      key={index} 
                      className={`p-3 ${cardClass}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {isSuccess && isDuplicate ? (
                            <AlertCircle className="h-4 w-4 text-blue-600 shrink-0" />
                          ) : isSuccess ? (
                            <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600 shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate">{item.fileName}</span>
                          {isDuplicate && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-blue-100 text-blue-700 border-blue-300">
                              Bereits vorhanden
                            </Badge>
                          )}
                        </div>
                        {isSuccess && item.result.parsed && (
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {item.result.parsed.guest_name} • {item.result.parsed.date}
                          </span>
                        )}
                      </div>
                      {!isSuccess && item.result.error && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1 ml-6">
                          {item.result.error}
                        </p>
                      )}
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Schliessen
          </Button>
          <Button 
            onClick={handleTest} 
            disabled={isTesting || !emailContent.trim()}
            className="gap-2"
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TestTube className="h-4 w-4" />
            )}
            Testen & Importieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
