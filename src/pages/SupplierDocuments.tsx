/**
 * Lieferantendokumente – Operative Warenkostenverfolgung
 * =======================================================
 * Nur für Administratoren.
 *
 * Zweck:
 *   Erfassung von Lieferscheinen und Rechnungen während des Monats,
 *   um eine laufende operative Schätzung der Warenkosten zu erhalten.
 *
 * Wichtige Regel:
 *   Diese Werte sind SCHÄTZWERTE und ersetzen niemals die offiziellen
 *   Buchhaltungswerte aus dem PDF/CSV-Import.
 *
 * Layout:
 *   - Monatsauswahl + Zusammenfassungskarten oben
 *   - Dokument hinzufügen (Inline-Formular)
 *   - Dokumentenliste (Tabelle, löschbar/editierbar)
 *   - Buchhaltungsvergleich (Struktur vorbereitet, sichtbar wenn Daten vorhanden)
 */

import { useState, useMemo } from 'react';
import { usePermissions } from '@/hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Truck, Plus, Trash2, Edit3, Info, AlertTriangle, ChevronDown,
  ShoppingCart, Package, Wine, ArrowUpDown, CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  addDocument, updateDocument, deleteDocument,
  loadDocumentsForMonth, getMonthSummary, buildCostComparison,
  availableYears, knownSuppliers,
} from '@/lib/supplier-documents-store';
import {
  SupplierDocument, DocumentType, DocumentCategory,
  DOCUMENT_TYPE_LABELS, CATEGORY_LABELS, CATEGORY_COLORS,
  CostComparisonRecord,
} from '@/types/supplier-documents';
import { toast } from 'sonner';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const CURRENT_YEAR  = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function chf(n: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(n);
}

function diffColor(diff: number | undefined): string {
  if (diff === undefined) return 'text-muted-foreground';
  if (Math.abs(diff) < 10) return 'text-green-700';
  return diff > 0 ? 'text-orange-600' : 'text-green-700';
}

function categoryIcon(cat: DocumentCategory) {
  if (cat === 'food')     return <ShoppingCart className="h-3.5 w-3.5" />;
  if (cat === 'beverage') return <Wine className="h-3.5 w-3.5" />;
  return <Package className="h-3.5 w-3.5" />;
}

// ─── Formular-State ───────────────────────────────────────────────────────────

interface FormState {
  supplier: string;
  documentType: DocumentType;
  date: string;
  category: DocumentCategory;
  amount: string;
  note: string;
}

const emptyForm = (): FormState => ({
  supplier:     '',
  documentType: 'delivery_note',
  date:         new Date().toISOString().split('T')[0],
  category:     'food',
  amount:       '',
  note:         '',
});

// ─── Kategorie-Badge ──────────────────────────────────────────────────────────

function CatBadge({ cat }: { cat: DocumentCategory }) {
  const c = CATEGORY_COLORS[cat];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
      c.bg, c.text, c.border,
    )}>
      {categoryIcon(cat)}
      {CATEGORY_LABELS[cat]}
    </span>
  );
}

// ─── Zusammenfassungskarten ───────────────────────────────────────────────────

interface SummaryCardsProps {
  foodCost: number;
  beverageCost: number;
  otherCost: number;
  totalCost: number;
  docCount: number;
}

function SummaryCards({ foodCost, beverageCost, otherCost, totalCost, docCount }: SummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card className="bg-orange-50 border-orange-200">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-orange-600 flex items-center gap-1">
            <ShoppingCart className="h-3 w-3" /> Küche (Food)
          </p>
          <p className="text-xl font-bold text-orange-800 mt-0.5">{chf(foodCost)}</p>
          <p className="text-[10px] text-orange-500 mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-blue-600 flex items-center gap-1">
            <Wine className="h-3 w-3" /> Getränke (Bev.)
          </p>
          <p className="text-xl font-bold text-blue-800 mt-0.5">{chf(beverageCost)}</p>
          <p className="text-[10px] text-blue-500 mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      <Card className="bg-muted/50">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Package className="h-3 w-3" /> Diverses
          </p>
          <p className="text-xl font-bold mt-0.5">{chf(otherCost)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Operative Schätzung</p>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-700">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-zinc-300 flex items-center gap-1">
            <Truck className="h-3 w-3" /> Total · {docCount} Belege
          </p>
          <p className="text-xl font-bold text-white mt-0.5">{chf(totalCost)}</p>
          <p className="text-[10px] text-zinc-400 mt-0.5">Gesamt Warenkosten</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Vergleich Buchhaltung vs. Operative ──────────────────────────────────────

function ComparisonSection({ comp }: { comp: CostComparisonRecord }) {
  if (!comp.hasAccountingData) {
    return (
      <Alert className="text-sm">
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>Buchhaltungsvergleich:</strong> Noch kein Buchhaltungsimport für{' '}
          {MONTHS[comp.month - 1]} {comp.year} vorhanden.
          Nach dem PDF/CSV-Import erscheint hier der Vergleich zwischen operativer Schätzung
          und offiziellem Buchhaltungsabschluss.
        </AlertDescription>
      </Alert>
    );
  }

  const rows = [
    {
      label:    'Küche (Food)',
      op:       comp.operationalFoodCost,
      acc:      comp.accountingFoodCost,
      diff:     comp.diffFoodCost,
    },
    {
      label:    'Getränke (Bev.)',
      op:       comp.operationalBeverageCost,
      acc:      comp.accountingBeverageCost,
      diff:     comp.diffBeverageCost,
    },
    {
      label:    'Total Warenaufwand',
      op:       comp.operationalTotalCost,
      acc:      comp.accountingTotalCost,
      diff:     comp.diffTotalCost,
      isBold:   true,
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4" />
          Vergleich: Operative Schätzung vs. Buchhaltung
          <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]">
            Buchhaltungsimport vorhanden
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kategorie</TableHead>
                <TableHead className="text-right">Lieferantendok. (operativ)</TableHead>
                <TableHead className="text-right">Buchhaltung (offiziell)</TableHead>
                <TableHead className="text-right">Differenz</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.label} className={row.isBold ? 'font-semibold bg-muted/30' : ''}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {chf(row.op)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.acc !== undefined ? chf(row.acc) : '—'}
                  </TableCell>
                  <TableCell className={cn('text-right font-mono text-sm', diffColor(row.diff))}>
                    {row.diff !== undefined
                      ? (row.diff > 0 ? '+' : '') + chf(row.diff)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {comp.diffTotalPct !== undefined && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-t">
            Abweichung: <strong className={diffColor(comp.diffTotalCost)}>
              {comp.diffTotalPct > 0 ? '+' : ''}{comp.diffTotalPct.toFixed(1)}%
            </strong>
            {' '}(operative Schätzung vs. Buchhaltungsabschluss)
            {Math.abs(comp.diffTotalPct) < 5 && (
              <span className="ml-2 text-green-600 font-medium">✓ Gute Übereinstimmung</span>
            )}
          </div>
        )}
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-700 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>Hinweis:</strong> Die Buchhaltungswerte sind die offiziellen Werte für das Reporting.
            Lieferantendokumente sind nur operative Schätzwerte und können vom Buchhaltungsabschluss abweichen
            (Skonto, Korrekturen, fehlende Belege, etc.).
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function SupplierDocumentsPage() {
  const { isAdmin } = usePermissions();

  const [year, setYear]   = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(CURRENT_MONTH);

  const years = availableYears();
  const suppliers = knownSuppliers();

  // Monatliche Daten
  const [docs, setDocs] = useState<SupplierDocument[]>(() =>
    loadDocumentsForMonth(CURRENT_YEAR, CURRENT_MONTH),
  );

  const summary    = useMemo(() => getMonthSummary(year, month),  [docs, year, month]);
  const comparison = useMemo(() => buildCostComparison(year, month), [docs, year, month]);

  // Daten neu laden
  function reload(y: number, m: number) {
    setDocs(loadDocumentsForMonth(y, m));
  }

  function handleMonthChange(y: number, m: number) {
    setYear(y);
    setMonth(m);
    reload(y, m);
  }

  // ── Add-Dialog ──────────────────────────────────────────────────────────────

  const [showAdd, setShowAdd]   = useState(false);
  const [addForm, setAddForm]   = useState<FormState>(emptyForm);
  const [addError, setAddError] = useState('');

  function openAdd() {
    setAddForm({
      ...emptyForm(),
      date: `${year}-${String(month).padStart(2,'0')}-${new Date().getDate().toString().padStart(2,'0')}`,
    });
    setAddError('');
    setShowAdd(true);
  }

  function handleAdd() {
    if (!addForm.supplier.trim()) { setAddError('Lieferant ist erforderlich'); return; }
    const amt = parseFloat(addForm.amount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) { setAddError('Betrag muss eine positive Zahl sein (CHF)'); return; }

    addDocument({
      supplier:     addForm.supplier,
      documentType: addForm.documentType,
      date:         addForm.date,
      category:     addForm.category,
      amount:       amt,
      note:         addForm.note || undefined,
    });

    const d = new Date(addForm.date);
    reload(d.getFullYear(), d.getMonth() + 1);
    setShowAdd(false);
    toast.success(`Beleg von «${addForm.supplier}» wurde gespeichert`);
  }

  // ── Edit-Dialog ─────────────────────────────────────────────────────────────

  const [editDoc, setEditDoc]   = useState<SupplierDocument | null>(null);
  const [editForm, setEditForm] = useState<FormState>(emptyForm);
  const [editError, setEditError] = useState('');

  function openEdit(doc: SupplierDocument) {
    setEditForm({
      supplier:     doc.supplier,
      documentType: doc.documentType,
      date:         doc.date,
      category:     doc.category,
      amount:       doc.amount.toFixed(2),
      note:         doc.note ?? '',
    });
    setEditError('');
    setEditDoc(doc);
  }

  function handleEdit() {
    if (!editDoc) return;
    if (!editForm.supplier.trim()) { setEditError('Lieferant ist erforderlich'); return; }
    const amt = parseFloat(editForm.amount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) { setEditError('Betrag muss eine positive Zahl sein'); return; }

    updateDocument(editDoc.id, {
      supplier:     editForm.supplier,
      documentType: editForm.documentType,
      date:         editForm.date,
      category:     editForm.category,
      amount:       amt,
      note:         editForm.note || undefined,
    });
    reload(year, month);
    setEditDoc(null);
    toast.success('Beleg wurde aktualisiert');
  }

  // ── Löschen ─────────────────────────────────────────────────────────────────

  function handleDelete(doc: SupplierDocument) {
    if (!confirm(`Beleg von «${doc.supplier}» (${chf(doc.amount)}) wirklich löschen?`)) return;
    deleteDocument(doc.id);
    reload(year, month);
    toast.success('Beleg gelöscht');
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Kein Zugriff</p>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="h-6 w-6" />
            Lieferantendokumente
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Lieferscheine & Rechnungen · operative Warenkostenschätzung
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-purple-700 border-purple-300 bg-purple-50">Admin</Badge>
          <Button onClick={openAdd} size="sm" className="gap-1">
            <Plus className="h-4 w-4" /> Beleg erfassen
          </Button>
        </div>
      </div>

      {/* Hinweis-Banner */}
      <Alert className="text-sm border-amber-200 bg-amber-50">
        <Info className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-amber-800">
          <strong>Operative Schätzwerte:</strong> Die hier erfassten Beträge sind laufende Schätzwerte
          aus Lieferscheinen und Rechnungen. Der offizielle Wareneinsatz kommt aus dem
          Buchhaltungsabschluss (PDF/CSV-Import) am Monatsende und hat immer Vorrang.
        </AlertDescription>
      </Alert>

      {/* Monat-Selektor */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-muted-foreground">Zeitraum:</span>
            <Select value={String(year)} onValueChange={v => handleMonthChange(Number(v), month)}>
              <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(month)} onValueChange={v => handleMonthChange(year, Number(v))}>
              <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {summary.documentCount} {summary.documentCount === 1 ? 'Beleg' : 'Belege'} erfasst
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Zusammenfassungskarten */}
      <SummaryCards
        foodCost={summary.foodCost}
        beverageCost={summary.beverageCost}
        otherCost={summary.otherCost}
        totalCost={summary.totalCost}
        docCount={summary.documentCount}
      />

      {/* Dokumententabelle */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Belege – {MONTHS[month - 1]} {year}</CardTitle>
          <Button variant="outline" size="sm" onClick={openAdd} className="h-8 text-xs gap-1">
            <Plus className="h-3.5 w-3.5" /> Hinzufügen
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {docs.length === 0 ? (
            <div className="py-14 text-center text-muted-foreground">
              <Truck className="h-10 w-10 mx-auto mb-3 opacity-25" />
              <p className="text-sm">Noch keine Belege für {MONTHS[month - 1]} {year}</p>
              <p className="text-xs mt-1">Klicken Sie auf «Beleg erfassen» um den ersten Eintrag hinzuzufügen</p>
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Datum</TableHead>
                    <TableHead>Lieferant</TableHead>
                    <TableHead>Typ</TableHead>
                    <TableHead>Kategorie</TableHead>
                    <TableHead className="text-right">Betrag CHF</TableHead>
                    <TableHead>Notiz</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => (
                    <TableRow key={doc.id}>
                      <TableCell className="text-sm font-mono">
                        {new Date(doc.date).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })}
                      </TableCell>
                      <TableCell className="text-sm font-medium">{doc.supplier}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {DOCUMENT_TYPE_LABELS[doc.documentType]}
                        </Badge>
                      </TableCell>
                      <TableCell><CatBadge cat={doc.category} /></TableCell>
                      <TableCell className="text-right font-mono text-sm font-medium">
                        {chf(doc.amount)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                        {doc.note ?? '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7"
                            onClick={() => openEdit(doc)}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDelete(doc)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Buchhaltungsvergleich */}
      <ComparisonSection comp={comparison} />

      {/* ── Add-Dialog ── */}
      <DocumentDialog
        open={showAdd}
        title="Beleg erfassen"
        form={addForm}
        error={addError}
        suppliers={suppliers}
        onFormChange={setAddForm}
        onSave={handleAdd}
        onClose={() => setShowAdd(false)}
      />

      {/* ── Edit-Dialog ── */}
      <DocumentDialog
        open={!!editDoc}
        title="Beleg bearbeiten"
        form={editForm}
        error={editError}
        suppliers={suppliers}
        onFormChange={setEditForm}
        onSave={handleEdit}
        onClose={() => setEditDoc(null)}
      />
    </div>
  );
}

// ─── Beleg-Dialog (Add + Edit) ────────────────────────────────────────────────

interface DocumentDialogProps {
  open: boolean;
  title: string;
  form: FormState;
  error: string;
  suppliers: string[];
  onFormChange: (f: FormState) => void;
  onSave: () => void;
  onClose: () => void;
}

function DocumentDialog({
  open, title, form, error, suppliers, onFormChange, onSave, onClose,
}: DocumentDialogProps) {
  function set(field: keyof FormState, value: string) {
    onFormChange({ ...form, [field]: value });
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Lieferant */}
          <div className="space-y-1.5">
            <Label>Lieferant *</Label>
            <Input
              placeholder="z.B. Pistor AG, Transgourmet, Feldschlösschen…"
              value={form.supplier}
              onChange={e => set('supplier', e.target.value)}
              list="supplier-list"
            />
            <datalist id="supplier-list">
              {suppliers.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>

          {/* Typ + Datum */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Dokumenttyp</Label>
              <Select value={form.documentType} onValueChange={v => set('documentType', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="delivery_note">Lieferschein</SelectItem>
                  <SelectItem value="invoice">Rechnung</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Datum *</Label>
              <Input
                type="date"
                value={form.date}
                onChange={e => set('date', e.target.value)}
              />
            </div>
          </div>

          {/* Kategorie + Betrag */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Kategorie</Label>
              <Select value={form.category} onValueChange={v => set('category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="food">Küche / Food</SelectItem>
                  <SelectItem value="beverage">Getränke / Beverage</SelectItem>
                  <SelectItem value="other">Diverses / Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Betrag CHF (netto) *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={e => set('amount', e.target.value)}
              />
            </div>
          </div>

          {/* Notiz */}
          <div className="space-y-1.5">
            <Label>Notiz (optional)</Label>
            <Textarea
              placeholder="Bestellnummer, Kommentar…"
              rows={2}
              value={form.note}
              onChange={e => set('note', e.target.value)}
            />
          </div>

          {error && (
            <Alert variant="destructive" className="text-sm py-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={onSave}>Speichern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
