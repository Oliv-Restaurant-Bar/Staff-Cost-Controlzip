import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Pencil, Trash2, Plus, Save, X, Target } from 'lucide-react';
import { toast } from 'sonner';
import {
  loadZielwerte,
  saveZielwert,
  deleteZielwert,
  ZielwertEntry,
  ZielwertDepartment,
} from '@/lib/zielwerte-store';

const MONTH_NAMES = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const DEPT_LABELS: Record<ZielwertDepartment, string> = {
  all: 'Alle Abteilungen',
  service: 'Service',
  küche: 'Küche',
};

const currentYear = new Date().getFullYear();
const YEARS = [currentYear - 1, currentYear, currentYear + 1];

interface FormState {
  year: number;
  month: string;
  department: ZielwertDepartment;
  targetPercent: string;
  targetChf: string;
}

const EMPTY_FORM: FormState = {
  year: currentYear,
  month: 'all',
  department: 'all',
  targetPercent: '',
  targetChf: '',
};

export function ZielwerteCard() {
  const [entries, setEntries]         = useState<ZielwertEntry[]>([]);
  const [showForm, setShowForm]       = useState(false);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [form, setForm]               = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors]           = useState<Partial<FormState>>({});

  useEffect(() => { setEntries(loadZielwerte()); }, []);

  function reload() { setEntries(loadZielwerte()); }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setErrors({});
    setShowForm(false);
  }

  function startEdit(entry: ZielwertEntry) {
    setForm({
      year:          entry.year,
      month:         entry.month !== undefined ? String(entry.month) : 'all',
      department:    entry.department,
      targetPercent: String(entry.targetPercent),
      targetChf:     entry.targetChf !== undefined ? String(entry.targetChf) : '',
    });
    setEditingId(entry.id);
    setErrors({});
    setShowForm(true);
  }

  function validate(): boolean {
    const errs: Partial<FormState> = {};
    const pct = parseFloat(form.targetPercent);
    if (isNaN(pct) || pct <= 0 || pct > 100) errs.targetPercent = 'Ungültig (1–100)';
    if (form.targetChf && isNaN(parseFloat(form.targetChf))) errs.targetChf = 'Ungültig';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSave() {
    if (!validate()) return;

    const payload = {
      year:          form.year,
      month:         form.month !== 'all' ? Number(form.month) : undefined,
      department:    form.department,
      targetPercent: parseFloat(form.targetPercent),
      targetChf:     form.targetChf ? parseFloat(form.targetChf) : undefined,
    };

    saveZielwert(payload, editingId ?? undefined);
    reload();
    toast.success(editingId ? 'Zielwert aktualisiert' : 'Zielwert gespeichert');
    resetForm();
  }

  function handleDelete(id: string) {
    deleteZielwert(id);
    reload();
    toast.success('Zielwert gelöscht');
  }

  function scopeLabel(e: ZielwertEntry) {
    const m = e.month !== undefined ? MONTH_NAMES[e.month] : 'Ganzes Jahr';
    return `${m} ${e.year}`;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">Zielwerte</CardTitle>
          </div>
          {!showForm && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setErrors({}); setShowForm(true); }}
            >
              <Plus className="h-3.5 w-3.5" />
              Zielwert hinzufügen
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Personalkostenquoten-Ziele nach Jahr, Monat und Abteilung. Spezifischere Werte haben Vorrang.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">

        {/* ── Eingabe-Formular ─────────────────────────────────────── */}
        {showForm && (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
            <p className="text-sm font-medium">{editingId ? 'Zielwert bearbeiten' : 'Neuer Zielwert'}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {/* Jahr */}
              <div className="space-y-1">
                <Label className="text-xs">Jahr</Label>
                <Select value={String(form.year)} onValueChange={v => setForm(f => ({ ...f, year: Number(v) }))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {YEARS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Monat */}
              <div className="space-y-1">
                <Label className="text-xs">Monat</Label>
                <Select value={form.month} onValueChange={v => setForm(f => ({ ...f, month: v }))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Ganzes Jahr</SelectItem>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                      <SelectItem key={m} value={String(m)}>{MONTH_NAMES[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Abteilung */}
              <div className="space-y-1">
                <Label className="text-xs">Abteilung</Label>
                <Select value={form.department} onValueChange={v => setForm(f => ({ ...f, department: v as ZielwertDepartment }))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alle Abteilungen</SelectItem>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="küche">Küche</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Zielwert % */}
              <div className="space-y-1">
                <Label className="text-xs">Zielwert %</Label>
                <div className="relative">
                  <Input
                    type="number" min="1" max="100" step="0.1"
                    value={form.targetPercent}
                    onChange={e => setForm(f => ({ ...f, targetPercent: e.target.value }))}
                    placeholder="z.B. 32"
                    className="h-8 text-sm pr-6"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
                {errors.targetPercent && <p className="text-xs text-destructive">{errors.targetPercent}</p>}
              </div>

              {/* Zielwert CHF (optional) */}
              <div className="space-y-1">
                <Label className="text-xs">Zielwert CHF <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  type="number" min="0" step="100"
                  value={form.targetChf}
                  onChange={e => setForm(f => ({ ...f, targetChf: e.target.value }))}
                  placeholder="z.B. 25000"
                  className="h-8 text-sm"
                />
                {errors.targetChf && <p className="text-xs text-destructive">{errors.targetChf}</p>}
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={handleSave}>
                <Save className="h-3.5 w-3.5" />
                Speichern
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={resetForm}>
                <X className="h-3.5 w-3.5 mr-1" />
                Abbrechen
              </Button>
            </div>
          </div>
        )}

        {/* ── Tabelle ─────────────────────────────────────────────── */}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            Noch keine Zielwerte hinterlegt. Der globale Schwellenwert aus den Einstellungen gilt als Fallback.
          </p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="text-xs">Jahr</TableHead>
                  <TableHead className="text-xs">Monat</TableHead>
                  <TableHead className="text-xs">Abteilung</TableHead>
                  <TableHead className="text-xs text-right">Zielwert %</TableHead>
                  <TableHead className="text-xs w-20">Aktionen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...entries]
                  .sort((a, b) => {
                    if (a.year !== b.year) return b.year - a.year;
                    const am = a.month ?? 0;
                    const bm = b.month ?? 0;
                    return bm - am;
                  })
                  .map(e => (
                    <TableRow key={e.id} className="text-sm">
                      <TableCell className="font-medium tabular-nums">{e.year}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {e.month !== undefined ? MONTH_NAMES[e.month] : (
                          <span className="italic text-muted-foreground/70">Ganzes Jahr</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            e.department === 'service'
                              ? 'text-xs font-normal border-blue-300 text-blue-700 dark:text-blue-300'
                              : e.department === 'küche'
                              ? 'text-xs font-normal border-orange-300 text-orange-700 dark:text-orange-300'
                              : 'text-xs font-normal'
                          }
                        >
                          {DEPT_LABELS[e.department]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-semibold tabular-nums">{e.targetPercent.toFixed(1)} %</span>
                        {e.targetChf !== undefined && (
                          <span className="block text-[10px] text-muted-foreground tabular-nums">
                            {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(e.targetChf)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => startEdit(e)} title="Bearbeiten">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(e.id)} title="Löschen">
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

        <p className="text-xs text-muted-foreground">
          Priorität: Monat+Abteilung &gt; Jahr+Abteilung &gt; Monat global &gt; Jahr global &gt; Globaler Schwellenwert
        </p>
      </CardContent>
    </Card>
  );
}
