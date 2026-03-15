/**
 * Kontenplan – Zentrales Konto-Management
 * =========================================
 * Administrations-Seite für alle 4-stelligen Kontonummern.
 *
 * Funktionen:
 *   - Vollständige Übersicht aller Konten mit P&L-Zuordnung
 *   - CSV/PDF-Import aus dem Buchhaltungsprogramm
 *   - Manuelle Anlage, Bearbeitung und Deaktivierung von Konten
 *   - Automatische Kategorie-Zuweisung (3xxx→Umsatz, 4xxx→Warenaufwand, etc.)
 *   - Import-Matching testen
 *   - Integrations-Übersicht (welche Module nutzen den Kontenplan)
 *
 * Nur für Admin zugänglich.
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Search, X,
  Edit3, Save, RotateCcw, Plus, Info, CheckCircle2,
  AlertTriangle, Zap, Settings2, Upload, FileText, FileSpreadsheet,
  ChevronDown, ChevronUp, BookOpen, Building2, BarChart3,
  Truck, Calculator, ArrowRight, Hash,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { usePermissions } from '@/hooks/usePermissions';
import {
  AccountMapping as AccountMappingType,
  PLSection, PLCategory, DepartmentHint, AccountSign,
} from '@/types/account-mapping';
import {
  loadAllMappings, saveMappingCustom, deleteMappingCustom, resetToDefault,
  lookupAccount, PL_SECTIONS, PL_CATEGORIES, ACCOUNT_RANGES,
  getCategoryLabel, getSectionLabel, DEPARTMENT_LABELS,
  DEFAULT_ACCOUNTS, autoAssignFromNumber, importAccountsBatch,
} from '@/lib/account-mapping-store';

// ─── Farben ───────────────────────────────────────────────────────────────────

const DEPT_BADGE: Record<string, string> = {
  kitchen: 'border-orange-200 bg-orange-50 text-orange-700 dark:bg-orange-950/20',
  service: 'border-blue-200   bg-blue-50   text-blue-700   dark:bg-blue-950/20',
  general: 'border-gray-200   bg-gray-50   text-gray-600   dark:bg-gray-900/20',
  admin:   'border-purple-200 bg-purple-50 text-purple-700 dark:bg-purple-950/20',
};

const SIGN_BADGE: Record<AccountSign, string> = {
  income:  'border-green-200 bg-green-50 text-green-700 dark:bg-green-950/20',
  expense: 'border-red-200   bg-red-50   text-red-700   dark:bg-red-950/20',
};

const SOURCE_BADGE: Record<string, string> = {
  default: 'border-border bg-muted/50 text-muted-foreground',
  custom:  'border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-950/20',
};

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

const DataRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground w-28 flex-shrink-0">{label}:</span>
    <span className="font-medium">{value}</span>
  </div>
);

// ─── CSV-Parser ───────────────────────────────────────────────────────────────

interface ParsedRow {
  accountNumber: string;
  accountName:   string;
  selected:      boolean;
  plCategory:    PLCategory;
  plSection:     PLSection;
  sign:          AccountSign;
  department:    DepartmentHint;
  alreadyExists: boolean;
}

/**
 * CSV-Text parsen.
 * Unterstützte Formate:
 *   3000;Speiseumsatz
 *   3000,Speiseumsatz
 *   3000   Speiseumsatz   (Tab-separiert)
 * Zeilen ohne valide 4-stellige Kontonummer >= 3000 werden übersprungen.
 */
function parseCSVText(text: string, existingNumbers: Set<string>): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const seen = new Set<string>();

  for (const line of lines) {
    let parts: string[];
    if (line.includes(';')) {
      parts = line.split(';');
    } else if (line.includes('\t')) {
      parts = line.split('\t');
    } else {
      parts = line.split(',');
    }

    if (parts.length < 2) continue;

    const rawNum = parts[0].trim().replace(/\D/g, '').slice(-4);
    const name   = parts[1].trim().replace(/^["'\s]+|["'\s]+$/g, '');

    if (rawNum.length !== 4) continue;
    const num = rawNum;
    const n = parseInt(num, 10);
    if (n < 3000) continue;
    if (seen.has(num)) continue;
    seen.add(num);

    const auto = autoAssignFromNumber(num);
    rows.push({
      accountNumber: num,
      accountName:   name || `Konto ${num}`,
      selected:      true,
      alreadyExists: existingNumbers.has(num),
      ...auto,
    });
  }
  return rows;
}

// ─── CSV/PDF Import-Dialog ────────────────────────────────────────────────────

interface ImportDialogProps {
  onClose: () => void;
  onImported: () => void;
  existingNumbers: Set<string>;
}

function ChartImportDialog({ onClose, onImported, existingNumbers }: ImportDialogProps) {
  const [step, setStep]           = useState<'input' | 'preview'>('input');
  const [csvText, setCsvText]     = useState('');
  const [pdfStatus, setPdfStatus] = useState<string>('');
  const [rows, setRows]           = useState<ParsedRow[]>([]);
  const [error, setError]         = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const activeCategories = PL_CATEGORIES.filter(c => c.id !== 'unmapped');

  function handleParse() {
    setError('');
    const parsed = parseCSVText(csvText, existingNumbers);
    if (parsed.length === 0) {
      setError('Keine gültigen Konten gefunden. Prüfen Sie das Format: «3000;Kontoname» (ab Konto 3000).');
      return;
    }
    setRows(parsed);
    setStep('preview');
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setPdfStatus('');

    if (file.name.endsWith('.csv') || file.name.endsWith('.txt')) {
      const text = await file.text();
      setCsvText(text);
      setPdfStatus(`CSV-Datei geladen: ${file.name} (${text.split('\n').length} Zeilen)`);
    } else if (file.name.endsWith('.pdf')) {
      setPdfStatus('PDF wird verarbeitet…');
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((it: any) => it.str).join(' ') + '\n';
        }
        setCsvText(fullText);
        setPdfStatus(`PDF geladen: ${file.name} (${pdf.numPages} Seiten). Text wurde extrahiert — prüfen Sie den Text vor dem Import.`);
      } catch (err) {
        setError('PDF konnte nicht gelesen werden. Nur Text-PDFs (keine gescannten) werden unterstützt. Verwenden Sie bitte den CSV-Export.');
        setPdfStatus('');
      }
    } else {
      setError('Nur CSV-, TXT- und Text-PDF-Dateien werden unterstützt.');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  function updateRow(idx: number, changes: Partial<ParsedRow>) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...changes } : r));
  }

  function handleCategoryChange(idx: number, cat: PLCategory) {
    const catDef = PL_CATEGORIES.find(c => c.id === cat);
    updateRow(idx, {
      plCategory: cat,
      plSection:  catDef?.section ?? rows[idx].plSection,
      sign:       catDef?.sign    ?? rows[idx].sign,
    });
  }

  function handleImport() {
    const selected = rows.filter(r => r.selected);
    if (selected.length === 0) { setError('Bitte wählen Sie mindestens ein Konto aus.'); return; }
    const mappings: Omit<AccountMappingType, 'source'>[] = selected.map(r => ({
      accountNumber: r.accountNumber,
      accountName:   r.accountName,
      plCategory:    r.plCategory,
      plSection:     r.plSection,
      sign:          r.sign,
      department:    r.department,
      canOverride:   true,
      isActive:      true,
    }));
    const count = importAccountsBatch(mappings);
    toast.success(`${count} Konten erfolgreich importiert`);
    onImported();
    onClose();
  }

  const selectedCount = rows.filter(r => r.selected).length;
  const newCount      = rows.filter(r => r.selected && !r.alreadyExists).length;
  const updateCount   = rows.filter(r => r.selected && r.alreadyExists).length;

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Kontenplan importieren
            {step === 'preview' && (
              <Badge variant="outline" className="text-xs ml-2">Schritt 2: Vorschau & Zuordnung</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Importieren Sie Ihre Konten aus dem Buchhaltungsprogramm (Banana, AbaNinja, Bexio, Sage 50).
            Es werden nur Konten ab 3000 importiert.
          </DialogDescription>
        </DialogHeader>

        {step === 'input' ? (
          <div className="space-y-4 py-2">
            {/* Format-Erklärung */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 space-y-1.5">
              <p className="font-semibold flex items-center gap-1">
                <Info className="h-3.5 w-3.5" /> So funktioniert der Import
              </p>
              <p>
                Exportieren Sie den Kontenplan aus Ihrem Buchhaltungsprogramm als CSV-Datei.
                Fügen Sie den Inhalt unten ein oder laden Sie die Datei hoch.
              </p>
              <p className="font-semibold mt-1">Unterstützte Formate:</p>
              <code className="block bg-white border border-blue-200 rounded p-2 font-mono text-[11px] text-blue-900 whitespace-pre">
{`3000;Speiseumsatz
3001;Getränkeumsatz Bar
4000;Warenaufwand Lebensmittel
4001;Warenaufwand Getränke
5000;Löhne Küche`}
              </code>
              <p className="text-blue-700 italic text-[10px]">
                Trennzeichen: Semikolon (;), Komma (,) oder Tab. Zeilen ohne 4-stellige Kontonummer werden ignoriert.
                Konten unter 3000 (z.B. Aktiven/Passiven) werden automatisch übersprungen.
              </p>
            </div>

            {/* Datei-Upload */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Datei hochladen (CSV oder Text-PDF)</Label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" /> CSV-Datei auswählen
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt,.pdf"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>
              {pdfStatus && (
                <p className="text-xs text-green-700 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> {pdfStatus}
                </p>
              )}
            </div>

            <Separator />

            {/* Text-Eingabe */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                Oder Text direkt einfügen (Copy & Paste aus Excel / Buchhaltung)
              </Label>
              <Textarea
                className="font-mono text-xs min-h-[200px]"
                placeholder={`3000;Speiseumsatz\n3001;Getränkeumsatz\n4000;Warenaufwand Lebensmittel\n4001;Warenaufwand Getränke\n5000;Löhne Küche\n...`}
                value={csvText}
                onChange={e => setCsvText(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                {csvText.split('\n').filter(l => l.trim()).length} Zeilen eingegeben
              </p>
            </div>

            {error && (
              <Alert variant="destructive" className="text-sm py-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Abbrechen</Button>
              <Button onClick={handleParse} disabled={!csvText.trim()}>
                Weiter: Konten prüfen
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* Schritt 2: Vorschau */
          <div className="space-y-3 py-2">
            {/* Zusammenfassung */}
            <div className="flex items-center gap-3 flex-wrap text-sm">
              <span className="text-muted-foreground">Gefunden:</span>
              <Badge className="bg-blue-100 text-blue-800 border-blue-200">{rows.length} Konten</Badge>
              <Badge className="bg-green-100 text-green-800 border-green-200">{newCount} neu</Badge>
              {updateCount > 0 && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200">{updateCount} werden aktualisiert</Badge>
              )}
              <Button variant="outline" size="sm" className="h-7 text-xs ml-auto"
                onClick={() => setStep('input')}>
                Zurück
              </Button>
            </div>

            <Alert className="text-xs py-2">
              <Info className="h-3.5 w-3.5" />
              <AlertDescription>
                Die Kategorie-Zuweisung wird automatisch aus der Kontonummer abgeleitet
                (3xxx→Umsatz, 4xxx→Warenaufwand, 5xxx→Personal, 6xxx→Betriebskosten).
                Sie können die Zuweisung vor dem Import individuell anpassen.
              </AlertDescription>
            </Alert>

            {/* Auswahl-Steuerung */}
            <div className="flex items-center gap-2 text-xs">
              <button className="text-blue-600 hover:underline"
                onClick={() => setRows(prev => prev.map(r => ({ ...r, selected: true })))}>
                Alle auswählen
              </button>
              <span className="text-muted-foreground">·</span>
              <button className="text-blue-600 hover:underline"
                onClick={() => setRows(prev => prev.map(r => ({ ...r, selected: false })))}>
                Alle abwählen
              </button>
              <span className="ml-auto text-muted-foreground">{selectedCount} ausgewählt</span>
            </div>

            {/* Vorschau-Tabelle */}
            <div className="border rounded-lg overflow-hidden">
              <div className="max-h-[380px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0 z-10">
                    <tr>
                      <th className="px-2 py-2 w-8 text-center">
                        <input type="checkbox"
                          checked={rows.every(r => r.selected)}
                          onChange={e => setRows(prev => prev.map(r => ({ ...r, selected: e.target.checked })))}
                          className="h-3.5 w-3.5"
                        />
                      </th>
                      <th className="px-2 py-2 text-left font-semibold text-muted-foreground w-16">Konto</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Bezeichnung</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted-foreground w-52">Kategorie</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted-foreground hidden md:table-cell w-32">Abschnitt</th>
                      <th className="px-2 py-2 text-left font-semibold text-muted-foreground w-16">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row, idx) => (
                      <tr key={row.accountNumber}
                        className={cn('hover:bg-muted/10', !row.selected && 'opacity-40')}>
                        <td className="px-2 py-1.5 text-center">
                          <input type="checkbox"
                            checked={row.selected}
                            onChange={e => updateRow(idx, { selected: e.target.checked })}
                            className="h-3.5 w-3.5"
                          />
                        </td>
                        <td className="px-2 py-1.5 font-mono font-bold">{row.accountNumber}</td>
                        <td className="px-2 py-1.5">
                          <Input
                            className="h-6 text-xs px-1.5 w-full min-w-[140px]"
                            value={row.accountName}
                            onChange={e => updateRow(idx, { accountName: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Select value={row.plCategory}
                            onValueChange={v => handleCategoryChange(idx, v as PLCategory)}>
                            <SelectTrigger className="h-6 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-48">
                              {activeCategories.map(c => (
                                <SelectItem key={c.id} value={c.id} className="text-xs">{c.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1.5 hidden md:table-cell text-muted-foreground text-[10px]">
                          {getSectionLabel(row.plSection)}
                        </td>
                        <td className="px-2 py-1.5">
                          {row.alreadyExists ? (
                            <span className="text-[10px] text-amber-600 font-medium">Update</span>
                          ) : (
                            <span className="text-[10px] text-green-600 font-medium">Neu</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && (
              <Alert variant="destructive" className="text-sm py-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Abbrechen</Button>
              <Button onClick={handleImport} disabled={selectedCount === 0}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                {selectedCount} Konten importieren
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit-Dialog ──────────────────────────────────────────────────────────────

interface EditDialogProps {
  mapping: AccountMappingType | null;
  isNew?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const EditDialog = ({ mapping, isNew, onClose, onSaved }: EditDialogProps) => {
  const [accountNumber, setAccountNumber] = useState(mapping?.accountNumber ?? '');
  const [accountName,   setAccountName]   = useState(mapping?.accountName ?? '');
  const [plCategory,    setPlCategory]    = useState<PLCategory>(mapping?.plCategory ?? 'other_operating');
  const [plSection,     setPlSection]     = useState<PLSection>(mapping?.plSection ?? 'operating_expenses');
  const [department,    setDepartment]    = useState<DepartmentHint>(mapping?.department ?? 'general');
  const [sign,          setSign]          = useState<AccountSign>(mapping?.sign ?? 'expense');
  const [canOverride,   setCanOverride]   = useState(mapping?.canOverride ?? true);
  const [isActive,      setIsActive]      = useState(mapping?.isActive ?? true);
  const [notes,         setNotes]         = useState(mapping?.notes ?? '');

  const handleCategoryChange = (cat: PLCategory) => {
    setPlCategory(cat);
    const catDef = PL_CATEGORIES.find(c => c.id === cat);
    if (catDef) {
      setPlSection(catDef.section);
      setSign(catDef.sign);
    }
  };

  const handleAutoAssign = () => {
    if (accountNumber.length !== 4) return;
    const auto = autoAssignFromNumber(accountNumber);
    setPlSection(auto.plSection);
    setPlCategory(auto.plCategory);
    setSign(auto.sign);
    setDepartment(auto.department);
  };

  const handleSave = () => {
    if (!accountNumber.trim() || accountNumber.trim().length !== 4) {
      toast.error('Kontonummer muss genau 4 Stellen haben');
      return;
    }
    if (!accountName.trim()) {
      toast.error('Kontobezeichnung ist erforderlich');
      return;
    }
    saveMappingCustom({
      accountNumber: accountNumber.trim(),
      accountName:   accountName.trim(),
      plCategory,
      plSection,
      department,
      sign,
      canOverride,
      isActive,
      source: 'custom',
      notes: notes || undefined,
    });
    toast.success(`Konto ${accountNumber} gespeichert`);
    onSaved();
    onClose();
  };

  const activeCategories = PL_CATEGORIES.filter(c => c.id !== 'unmapped');

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isNew ? <Plus className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
            {isNew ? 'Neues Konto anlegen' : `Konto ${mapping?.accountNumber} bearbeiten`}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'Neue Kontonummer mit P&L-Zuordnung anlegen.'
              : 'Anpassungen werden als "Custom" gespeichert und überschreiben die Standardzuordnung.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Kontonummer (4-stellig) *</Label>
              <div className="flex gap-1.5">
                <Input
                  value={accountNumber}
                  onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="3000"
                  maxLength={4}
                  className="h-9 text-sm font-mono"
                  disabled={!isNew}
                />
                {isNew && accountNumber.length === 4 && (
                  <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-xs"
                    onClick={handleAutoAssign} title="Kategorie automatisch zuweisen">
                    <Zap className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Kontobezeichnung *</Label>
              <Input
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder="Speiseumsatz"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">P&L-Kategorie</Label>
            <Select value={plCategory} onValueChange={v => handleCategoryChange(v as PLCategory)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activeCategories.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">P&L-Abschnitt</Label>
              <Select value={plSection} onValueChange={v => setPlSection(v as PLSection)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PL_SECTIONS.filter(s => !s.isCalculated).map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Abteilung</Label>
              <Select value={department ?? 'general'} onValueChange={v => setDepartment(v === 'general' ? 'general' : v as DepartmentHint)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DEPARTMENT_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Vorzeichen</Label>
              <Select value={sign} onValueChange={v => setSign(v as AccountSign)}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Ertrag (+)</SelectItem>
                  <SelectItem value="expense">Aufwand (−)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2 pt-5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="h-4 w-4 rounded" />
                Aktiv
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={canOverride} onChange={e => setCanOverride(e.target.checked)} className="h-4 w-4 rounded" />
                Manuell übersteuern erlaubt
              </label>
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Notiz (optional)</Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="z.B. früher Konto 3010 im alten System…"
              className="text-sm resize-none min-h-[60px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="h-3.5 w-3.5 mr-1" /> Abbrechen
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-3.5 w-3.5 mr-1" /> Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Matching-Test-Panel ──────────────────────────────────────────────────────

const MatchingTestPanel = () => {
  const [testNumber, setTestNumber] = useState('');

  const result = useMemo(() => {
    if (testNumber.length !== 4) return null;
    return lookupAccount(testNumber);
  }, [testNumber]);

  return (
    <Card className="border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4 text-blue-500" />
          Import-Matching testen
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Geben Sie eine 4-stellige Kontonummer ein um zu sehen, wie sie beim späteren CSV/PDF-Import zugeordnet wird.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={testNumber}
            onChange={e => setTestNumber(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="z.B. 3001"
            maxLength={4}
            className="h-8 text-sm font-mono w-28"
          />
          {testNumber.length === 4 && result && (
            <span className={cn('text-xs font-semibold flex items-center gap-1',
              result.matchType === 'exact' ? 'text-green-600' :
              result.matchType === 'range' ? 'text-amber-600' : 'text-red-600'
            )}>
              {result.matchType === 'exact' && <CheckCircle2 className="h-3.5 w-3.5" />}
              {result.matchType === 'range' && <AlertTriangle className="h-3.5 w-3.5" />}
              {result.matchType === 'none'  && <X className="h-3.5 w-3.5" />}
              {result.matchType === 'exact' ? 'Exakter Treffer' :
               result.matchType === 'range' ? 'Bereichstreffer' : 'Kein Treffer – manuelle Zuordnung nötig'}
            </span>
          )}
        </div>

        {result?.mapping && (
          <div className="rounded-md bg-muted/40 border border-border p-3 text-xs space-y-1.5">
            <DataRow label="Kontoname"     value={result.mapping.accountName} />
            <DataRow label="P&L-Kategorie" value={getCategoryLabel(result.mapping.plCategory)} />
            <DataRow label="Abschnitt"     value={getSectionLabel(result.mapping.plSection)} />
            <DataRow label="Abteilung"     value={DEPARTMENT_LABELS[result.mapping.department ?? 'general'] ?? '–'} />
            <DataRow label="Vorzeichen"    value={result.mapping.sign === 'income' ? 'Ertrag (+)' : 'Aufwand (−)'} />
            {result.matchType === 'range' && (
              <p className="text-amber-600 text-[10px] mt-1 italic">
                Kein exaktes Konto gefunden – Bereichsregel verwendet.
              </p>
            )}
          </div>
        )}

        {testNumber.length === 4 && result?.requiresManualMapping && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 p-2 text-[11px] text-red-700 dark:text-red-400">
            Kein Mapping für Konto {testNumber} gefunden.
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Integrations-Übersicht ───────────────────────────────────────────────────

function IntegrationOverview() {
  const [open, setOpen] = useState(false);

  const modules = [
    {
      icon: <FileText className="h-4 w-4 text-blue-600" />,
      title: 'Buchhaltungsimport (CSV/PDF)',
      path:  '/csv-import',
      desc:  'Beim Import von Buchhaltungsdaten werden alle Kontonummern automatisch anhand dieses Kontenplans den richtigen P&L-Positionen zugeordnet.',
      color: 'border-blue-200 bg-blue-50',
    },
    {
      icon: <BarChart3 className="h-4 w-4 text-emerald-600" />,
      title: 'Erfolgsrechnung (P&L)',
      path:  '/erfolgsrechnung',
      desc:  'Die Erfolgsrechnung berechnet alle Zwischenergebnisse (Rohgewinn, EBITDA, EBIT) basierend auf den Konto-Zuordnungen in diesem Kontenplan.',
      color: 'border-emerald-200 bg-emerald-50',
    },
    {
      icon: <Truck className="h-4 w-4 text-orange-600" />,
      title: 'Lieferantendokumente',
      path:  '/lieferanten',
      desc:  'Beim Erfassen von Lieferscheinen und Rechnungen kann jeder Beleg einer Kontonummer aus diesem Kontenplan zugeordnet werden.',
      color: 'border-orange-200 bg-orange-50',
    },
    {
      icon: <Calculator className="h-4 w-4 text-purple-600" />,
      title: 'Budget-Modul',
      path:  '/budget',
      desc:  'Budgets werden nach den gleichen Abschnitten (Nettoumsatz, Warenaufwand, etc.) strukturiert wie dieser Kontenplan.',
      color: 'border-purple-200 bg-purple-50',
    },
  ];

  return (
    <Card>
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            Integration: Welche Module nutzen diesen Kontenplan?
          </span>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Der Kontenplan ist das Fundament des gesamten Finanzsystems. Er bestimmt, wie Beträge
            aus dem Buchhaltungsprogramm in die Erfolgsrechnung einfliessen.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {modules.map(m => (
              <Link key={m.path} to={m.path}>
                <div className={cn('rounded-lg border p-3 hover:opacity-80 transition-opacity cursor-pointer', m.color)}>
                  <div className="flex items-center gap-2 mb-1">
                    {m.icon}
                    <span className="text-sm font-semibold">{m.title}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{m.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Erklärungsbereich ────────────────────────────────────────────────────────

function ExplanationPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
      <button
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <Info className="h-4 w-4 text-blue-600 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-bold text-blue-800 dark:text-blue-300">
            Was macht der Kontenplan-Modul?
          </p>
          {!open && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
              Klicken für ausführliche Erklärung
            </p>
          )}
        </div>
        <ChevronDown className={cn('h-4 w-4 text-blue-500 transition-transform flex-shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 text-sm text-blue-800 dark:text-blue-300">
          <Separator className="bg-blue-200" />

          <div>
            <p className="font-semibold mb-1">Was ist der Kontenplan?</p>
            <p className="text-xs leading-relaxed">
              Der Kontenplan ist eine Liste aller 4-stelligen Kontonummern Ihres Buchhaltungsprogramms
              (Banana, AbaNinja, Bexio, Sage 50, etc.). Jede Kontonummer wird einer bestimmten
              Position in der Erfolgsrechnung (P&L) zugeordnet – zum Beispiel geht Konto 3000
              (Speiseumsatz) in den Nettoumsatz, und Konto 4000 (Warenaufwand) in den Wareneinsatz.
            </p>
          </div>

          <div>
            <p className="font-semibold mb-1">Wie werden Konten importiert?</p>
            <p className="text-xs leading-relaxed">
              Mit dem Button «Kontenplan importieren» können Sie die Konten direkt aus Ihrem
              Buchhaltungsprogramm importieren. Exportieren Sie dort den Kontenplan als CSV-Datei
              (oft unter «Datei › Export › Kontenplan») und laden Sie diese Datei hoch.
              Das System erkennt die Kontonummern automatisch und schlägt die richtige Zuordnung vor.
              Konten unter 3000 (Aktiven/Passiven) werden automatisch ignoriert – nur
              Erfolgsrechnnungs-Konten (ab 3000) sind relevant.
            </p>
          </div>

          <div>
            <p className="font-semibold mb-1">Wie können Konten bearbeitet werden?</p>
            <p className="text-xs leading-relaxed">
              Klicken Sie auf das Bleistift-Symbol (✏) neben einem Konto, um es zu bearbeiten.
              Sie können den Kontonamen ändern, die Kategorie anpassen oder ein Konto deaktivieren.
              Ihre Änderungen werden als «Custom» gespeichert und überschreiben die Standardzuordnung.
              Mit dem Pfeil-Symbol (↺) können Sie jederzeit auf die Standardzuordnung zurücksetzen.
              Neue Konten, die in Ihrem Buchhaltungsprogramm noch nicht im Standard-Kontenplan vorhanden sind,
              können mit «Konto hinzufügen» manuell angelegt werden.
            </p>
          </div>

          <div>
            <p className="font-semibold mb-1">Wie wird der Kontenplan im System verwendet?</p>
            <p className="text-xs leading-relaxed">
              Wenn Sie am Monatsende Ihre Buchhaltungsdaten importieren (CSV oder PDF aus dem Treuhänder),
              liest das System die Kontonummern aus und ordnet sie automatisch den richtigen P&L-Positionen zu.
              So wird z.B. der Betrag auf Konto 4000 automatisch zum Wareneinsatz addiert.
              Ohne eine korrekte Kontozuordnung können Beträge nicht automatisch der Erfolgsrechnung zugeordnet werden.
            </p>
          </div>

          <div className="rounded-md bg-blue-100 dark:bg-blue-900/30 border border-blue-200 p-2.5 text-[11px]">
            <p className="font-semibold mb-1">Automatische Kategorie-Zuweisung nach Kontonummer-Bereich:</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              <span>3000–3999 → Nettoumsatz (Ertrag)</span>
              <span>4000–4999 → Wareneinsatz (Aufwand)</span>
              <span>5000–5999 → Personalkosten (Aufwand)</span>
              <span>6000–6999 → Betriebskosten (Aufwand)</span>
            </div>
            <p className="mt-1 italic">Diese Zuweisung kann für jedes einzelne Konto manuell überschrieben werden.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const AccountMappingPage = () => {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  const [mappings,    setMappings]    = useState<AccountMappingType[]>(() => loadAllMappings());
  const [editTarget,  setEditTarget]  = useState<AccountMappingType | null>(null);
  const [showNew,     setShowNew]     = useState(false);
  const [showImport,  setShowImport]  = useState(false);
  const [search,      setSearch]      = useState('');
  const [filterSection, setFilterSection] = useState<PLSection | 'all'>('all');
  const [filterDept,  setFilterDept]  = useState<DepartmentHint | 'all'>('all');

  const reload = useCallback(() => setMappings(loadAllMappings()), []);

  const existingNumbers = useMemo(
    () => new Set(mappings.map(m => m.accountNumber)),
    [mappings],
  );

  const filtered = useMemo(() => mappings.filter(m => {
    if (filterSection !== 'all' && m.plSection !== filterSection) return false;
    if (filterDept    !== 'all' && m.department !== filterDept)   return false;
    if (search && !m.accountNumber.includes(search) &&
        !m.accountName.toLowerCase().includes(search.toLowerCase()) &&
        !getCategoryLabel(m.plCategory).toLowerCase().includes(search.toLowerCase())
    ) return false;
    return true;
  }), [mappings, filterSection, filterDept, search]);

  const bySection = useMemo(() => {
    const groups = new Map<PLSection, AccountMappingType[]>();
    for (const section of PL_SECTIONS.filter(s => !s.isCalculated)) {
      groups.set(section.id, []);
    }
    for (const m of filtered) {
      const group = groups.get(m.plSection);
      if (group) group.push(m);
    }
    return groups;
  }, [filtered]);

  const handleReset = (m: AccountMappingType) => {
    resetToDefault(m.accountNumber);
    toast.success(`Konto ${m.accountNumber} auf Standard zurückgesetzt`);
    reload();
  };

  const customCount   = mappings.filter(m => m.source === 'custom').length;
  const inactiveCount = mappings.filter(m => !m.isActive).length;

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">Dashboard</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <Hash className="h-4 w-4 text-muted-foreground" />
              Kontenplan & P&L-Zuordnung
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20">
              Admin
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setShowImport(true)}>
              <Upload className="h-3.5 w-3.5" /> Kontenplan importieren
            </Button>
            <Button size="sm" className="h-8 gap-1" onClick={() => setShowNew(true)}>
              <Plus className="h-3.5 w-3.5" /> Konto hinzufügen
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-5 space-y-5 pb-20">

        {/* Erklärung */}
        <ExplanationPanel />

        {/* Statistik-Karten + Matching-Test */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Konten gesamt</p>
              <p className="text-2xl font-bold">{mappings.length}</p>
              <p className="text-[11px] text-muted-foreground">{DEFAULT_ACCOUNTS.length} Standard + {customCount} Custom</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Angepasst (Custom)</p>
              <p className="text-2xl font-bold text-amber-600">{customCount}</p>
              <p className="text-[11px] text-muted-foreground">Überschreiben Standard-Mapping</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Bereichsregeln</p>
              <p className="text-2xl font-bold text-blue-600">{ACCOUNT_RANGES.length}</p>
              <p className="text-[11px] text-muted-foreground">Fallback für unbekannte Konten</p>
            </CardContent>
          </Card>
        </div>

        <MatchingTestPanel />

        {/* Integrations-Übersicht */}
        <IntegrationOverview />

        {/* Filter-Bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Konto oder Name suchen…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Select value={filterSection} onValueChange={v => setFilterSection(v as PLSection | 'all')}>
            <SelectTrigger className="h-8 text-xs w-44">
              <SelectValue placeholder="Alle Abschnitte" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Abschnitte</SelectItem>
              {PL_SECTIONS.filter(s => !s.isCalculated).map(s => (
                <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterDept ?? 'all'} onValueChange={v => setFilterDept(v === 'all' ? 'all' : v as DepartmentHint)}>
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="Alle Abteilungen" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Abteilungen</SelectItem>
              {Object.entries(DEPARTMENT_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} Konten</span>
        </div>

        {/* Konten-Tabelle – gruppiert nach P&L-Abschnitt */}
        {PL_SECTIONS.filter(s => !s.isCalculated).map(section => {
          const sectionMappings = bySection.get(section.id) ?? [];
          if (sectionMappings.length === 0 && filterSection !== 'all') return null;
          return (
            <section key={section.id}>
              <div className={cn('rounded-t-lg border px-3 py-2 flex items-center gap-2', section.color)}>
                <span className="text-xs font-bold">{section.label}</span>
                <span className="text-[10px] opacity-70">({sectionMappings.length} Konten)</span>
                {!section.isCalculated && (
                  <span className="ml-auto text-[10px] opacity-60 italic">{section.description}</span>
                )}
              </div>

              {sectionMappings.length === 0 ? (
                <div className="rounded-b-lg border border-t-0 border-border px-3 py-3 text-xs text-muted-foreground/60 italic">
                  Keine Konten in diesem Abschnitt (aktuelle Filter)
                </div>
              ) : (
                <div className="rounded-b-lg border border-t-0 border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground w-16">Konto</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Bezeichnung</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden sm:table-cell">Kategorie</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden md:table-cell">Abteilung</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden md:table-cell">Vorzeichen</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden lg:table-cell">Herkunft</th>
                        <th className="text-center px-3 py-2 font-semibold text-muted-foreground w-24">Aktion</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sectionMappings.map(m => (
                        <tr
                          key={m.accountNumber}
                          className={cn(
                            'hover:bg-muted/20 transition-colors',
                            !m.isActive && 'opacity-40',
                          )}
                        >
                          <td className="px-3 py-2 font-mono font-bold text-sm">{m.accountNumber}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium">{m.accountName}</span>
                            {!m.isActive && (
                              <span className="ml-1.5 text-[10px] text-muted-foreground italic">inaktiv</span>
                            )}
                            {m.notes && (
                              <p className="text-[10px] text-muted-foreground/70 italic truncate max-w-[200px]">{m.notes}</p>
                            )}
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell text-muted-foreground">
                            {getCategoryLabel(m.plCategory)}
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell">
                            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', DEPT_BADGE[m.department ?? 'general'])}>
                              {DEPARTMENT_LABELS[m.department ?? 'general']}
                            </span>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell">
                            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', SIGN_BADGE[m.sign])}>
                              {m.sign === 'income' ? 'Ertrag' : 'Aufwand'}
                            </span>
                          </td>
                          <td className="px-3 py-2 hidden lg:table-cell">
                            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border', SOURCE_BADGE[m.source])}>
                              {m.source === 'custom' ? '✎ Custom' : 'Standard'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => setEditTarget(m)}
                                title="Bearbeiten"
                              >
                                <Edit3 className="h-3 w-3" />
                              </Button>
                              {m.source === 'custom' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 text-amber-600 hover:text-amber-700"
                                  onClick={() => handleReset(m)}
                                  title="Auf Standard zurücksetzen"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(() => {
                const nextSection = PL_SECTIONS.find(
                  s => s.isCalculated && s.order === section.order + 1
                );
                return nextSection ? (
                  <div className="mt-1 mb-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300">
                      = {nextSection.label}
                    </span>
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 italic">
                      {nextSection.description}
                    </span>
                  </div>
                ) : null;
              })()}
            </section>
          );
        })}

        {/* Bereichsregeln (Ranges) */}
        <section>
          <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
            Bereichsregeln (Fallback-Mapping)
            <Badge variant="outline" className="text-[10px]">{ACCOUNT_RANGES.length}</Badge>
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Wenn keine exakte Kontonummer gefunden wird, greift die erste passende Bereichsregel.
            Bereichsregeln können nicht bearbeitet werden – fügen Sie stattdessen ein exaktes Konto an.
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Von–Bis</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Beschreibung</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden sm:table-cell">Kategorie</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden md:table-cell">Abschnitt</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden md:table-cell">Abteilung</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ACCOUNT_RANGES.map(r => (
                  <tr key={`${r.from}-${r.to}`} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono font-bold">{r.from}–{r.to}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.description}</td>
                    <td className="px-3 py-2 hidden sm:table-cell">{getCategoryLabel(r.plCategory)}</td>
                    <td className="px-3 py-2 hidden md:table-cell text-muted-foreground">{getSectionLabel(r.plSection)}</td>
                    <td className="px-3 py-2 hidden md:table-cell">
                      <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', DEPT_BADGE[r.department ?? 'general'])}>
                        {DEPARTMENT_LABELS[r.department ?? 'general']}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Dialoge */}
      {editTarget && (
        <EditDialog
          mapping={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={reload}
        />
      )}
      {showNew && (
        <EditDialog
          mapping={null}
          isNew
          onClose={() => setShowNew(false)}
          onSaved={reload}
        />
      )}
      {showImport && (
        <ChartImportDialog
          onClose={() => setShowImport(false)}
          onImported={reload}
          existingNumbers={existingNumbers}
        />
      )}
    </div>
  );
};

export default AccountMappingPage;
