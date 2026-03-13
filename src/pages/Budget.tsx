/**
 * Budget-Seite – Admin-only
 * ==========================
 *
 * Zeigt alle Budgetjahre, ermöglicht:
 *   - Monatliche Werte anzeigen + bearbeiten
 *   - Jahr kopieren
 *   - Automatische Regeln definieren + anwenden
 *   - Jahreswechsel
 *
 * Zugriff: nur isAdmin (wird in App.tsx geprüft)
 */

import { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';

import {
  BudgetYear, BudgetPosition, BudgetRule, BudgetRuleType,
  BudgetValueType, BUDGET_MONTH_NAMES, BUDGET_MONTH_NAMES_FULL,
  DEFAULT_BUDGET_POSITIONS, createDefaultPosition,
} from '@/types/budget';

import {
  loadBudgetYear, saveBudgetYear, availableBudgetYears,
  copyBudgetYear, applyRulesToBudget, resolveBudgetYear,
  addBudgetRule, removeBudgetRule, updateBudgetPosition,
  deleteBudgetYear,
} from '@/lib/budget-store';

import { Button }  from '@/components/ui/button';
import { Badge }   from '@/components/ui/badge';
import { Input }   from '@/components/ui/input';
import { Label }   from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Calculator, Copy, Plus, Trash2, Settings2,
  ChevronDown, ChevronUp, AlertTriangle, CheckCircle2,
  TrendingUp, TrendingDown, Zap, RefreshCw,
} from 'lucide-react';

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

const CHF = (n: number) =>
  new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

const PCT = (n: number) => `${n.toFixed(1)} %`;

const RULE_LABELS: Record<BudgetRuleType, string> = {
  increase_revenue_by_pct:  'Umsatz erhöhen um %',
  set_cost_ratio:           'Kosten-Quote setzen (%)',
  reduce_cost_by_pct:       'Kosten reduzieren um %',
  monthly_factor:           'Monat-Faktor',
  monthly_fixed_override:   'Monat-CHF-Override',
};

const RULE_ICONS: Record<BudgetRuleType, React.ReactNode> = {
  increase_revenue_by_pct:  <TrendingUp   className="h-3.5 w-3.5 text-green-600" />,
  set_cost_ratio:           <Calculator   className="h-3.5 w-3.5 text-blue-600"  />,
  reduce_cost_by_pct:       <TrendingDown className="h-3.5 w-3.5 text-orange-600"/>,
  monthly_factor:           <Zap          className="h-3.5 w-3.5 text-violet-600"/>,
  monthly_fixed_override:   <Settings2    className="h-3.5 w-3.5 text-gray-600"  />,
};

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

export default function BudgetPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  return <BudgetContent />;
}

function BudgetContent() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear]   = useState(currentYear);
  const [budget, setBudget]               = useState<BudgetYear>(() => loadBudgetYear(currentYear));
  const [savedYears, setSavedYears]       = useState<number[]>(() => availableBudgetYears());
  const [activeTab, setActiveTab]         = useState<'table' | 'rules'>('table');
  const [expandedPos, setExpandedPos]     = useState<string | null>(null);

  // Dialoge
  const [copyDialog, setCopyDialog]   = useState(false);
  const [ruleDialog, setRuleDialog]   = useState(false);
  const [editDialog, setEditDialog]   = useState<BudgetPosition | null>(null);
  const [deleteDialog, setDeleteDialog] = useState(false);

  const resolved = resolveBudgetYear(budget);

  const reload = useCallback((year: number) => {
    setBudget(loadBudgetYear(year));
    setSavedYears(availableBudgetYears());
  }, []);

  useEffect(() => { reload(selectedYear); }, [selectedYear, reload]);

  const handleSave = (updated: BudgetYear) => {
    saveBudgetYear(updated);
    setBudget(updated);
    setSavedYears(availableBudgetYears());
    toast.success('Budget gespeichert');
  };

  const handleApplyRules = () => {
    if (budget.rules.length === 0) {
      toast.info('Keine Regeln definiert. Füge zuerst eine Regel hinzu.');
      return;
    }
    const updated = applyRulesToBudget(budget);
    handleSave(updated);
    toast.success(`${budget.rules.length} Regel(n) angewendet`);
  };

  // Kategoriefarben
  const getCategoryColor = (cat: string) => {
    if (cat === 'revenue')   return 'bg-green-50 border-l-4 border-l-green-500';
    if (cat.includes('cost')) return 'bg-orange-50 border-l-4 border-l-orange-400';
    if (cat === 'personnel') return 'bg-blue-50 border-l-4 border-l-blue-500';
    return 'bg-gray-50 border-l-4 border-l-gray-300';
  };

  const getValueTypeBadge = (vt: BudgetValueType) =>
    vt === 'chf'
      ? <Badge className="text-xs bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-100">CHF</Badge>
      : <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-100">%</Badge>;

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calculator className="h-6 w-6 text-primary" />
            Budget-Planung
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Jahresbudget verwalten · CHF und %-Positionen · Automatische Regeln
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Jahr-Auswahl */}
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Aktuelle + nächste 2 Jahre immer verfügbar */}
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(y => (
                <SelectItem key={y} value={String(y)}>
                  {y} {savedYears.includes(y) ? '✓' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="sm" onClick={() => setCopyDialog(true)} className="gap-1.5">
            <Copy className="h-4 w-4" />
            Jahr kopieren
          </Button>

          <Button variant="outline" size="sm" onClick={handleApplyRules} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Regeln anwenden
          </Button>

          {savedYears.includes(selectedYear) && (
            <Button
              variant="outline" size="sm"
              onClick={() => setDeleteDialog(true)}
              className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ── Jahres-KPIs ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border p-4 bg-green-50">
          <p className="text-xs text-muted-foreground mb-1">Umsatz Budget {selectedYear}</p>
          <p className="text-xl font-bold text-green-700">CHF {CHF(resolved.totalRevenueBudget)}</p>
        </div>
        <div className="rounded-lg border p-4 bg-orange-50">
          <p className="text-xs text-muted-foreground mb-1">Gesamtaufwand Budget</p>
          <p className="text-xl font-bold text-orange-700">CHF {CHF(resolved.totalCostBudget)}</p>
        </div>
        <div className={`rounded-lg border p-4 ${resolved.operatingResultBudget >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
          <p className="text-xs text-muted-foreground mb-1">Betriebsergebnis Budget</p>
          <p className={`text-xl font-bold ${resolved.operatingResultBudget >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            CHF {CHF(resolved.operatingResultBudget)}
          </p>
        </div>
      </div>

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={v => setActiveTab(v as 'table' | 'rules')}>
        <TabsList>
          <TabsTrigger value="table">Monatliche Werte</TabsTrigger>
          <TabsTrigger value="rules">
            Anpassungsregeln
            {budget.rules.length > 0 && (
              <Badge className="ml-1.5 h-4 px-1 text-xs">{budget.rules.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: Monatstabelle ── */}
        <TabsContent value="table" className="mt-4">
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted">
                  <TableHead className="w-[200px] sticky left-0 bg-muted z-10">Position</TableHead>
                  <TableHead className="w-16 text-center">Typ</TableHead>
                  {BUDGET_MONTH_NAMES.map(m => (
                    <TableHead key={m} className="text-right min-w-[80px]">{m}</TableHead>
                  ))}
                  <TableHead className="text-right min-w-[100px] font-bold">Total</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {budget.positions
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map(pos => {
                    const resolvedPos = resolved.positions.find(r => r.position.id === pos.id)!;
                    const isExpanded  = expandedPos === pos.id;

                    return [
                      // ── Hauptzeile ──
                      <TableRow
                        key={pos.id}
                        className={`cursor-pointer hover:brightness-95 transition-colors ${getCategoryColor(pos.category)}`}
                        onClick={() => setExpandedPos(isExpanded ? null : pos.id)}
                      >
                        <TableCell className="font-medium sticky left-0 bg-inherit z-10 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {isExpanded ? <ChevronUp className="h-3 w-3 opacity-50" /> : <ChevronDown className="h-3 w-3 opacity-50" />}
                            {pos.label}
                          </div>
                        </TableCell>
                        <TableCell className="text-center py-2.5">
                          {getValueTypeBadge(pos.valueType)}
                        </TableCell>
                        {pos.monthlyValues.map((val, m) => {
                          const chfVal = resolvedPos.resolvedCHF[m];
                          return (
                            <TableCell key={m} className="text-right py-2.5 font-mono text-xs">
                              {pos.valueType === 'percent'
                                ? <span className="text-blue-700">{PCT(val)}</span>
                                : <span>{CHF(val)}</span>
                              }
                              {pos.valueType === 'percent' && chfVal > 0 && (
                                <div className="text-muted-foreground text-[10px]">= {CHF(chfVal)}</div>
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right py-2.5 font-bold font-mono">
                          {pos.valueType === 'percent'
                            ? CHF(resolvedPos.totalCHF)
                            : CHF(pos.monthlyValues.reduce((s, v) => s + v, 0))
                          }
                        </TableCell>
                        <TableCell className="py-2.5">
                          <Button
                            variant="ghost" size="icon" className="h-6 w-6"
                            onClick={e => { e.stopPropagation(); setEditDialog(pos); }}
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>,

                      // ── Erweiterte Zeile: Bearbeitung ──
                      isExpanded && (
                        <TableRow key={`${pos.id}-edit`} className="bg-white dark:bg-background">
                          <TableCell colSpan={17} className="p-0">
                            <PositionInlineEditor
                              position={pos}
                              monthlyRevenue={resolved.monthlyRevenue}
                              onSave={updated => {
                                const upd = updateBudgetPosition(selectedYear, updated);
                                setBudget(upd);
                                setExpandedPos(null);
                                toast.success('Position aktualisiert');
                              }}
                              onCancel={() => setExpandedPos(null)}
                            />
                          </TableCell>
                        </TableRow>
                      ),
                    ];
                  })}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground mt-2">
            Klick auf eine Zeile zum Bearbeiten · CHF = fixer Betrag · % = Anteil am Monats-Umsatz
          </p>
        </TabsContent>

        {/* ── TAB: Regeln ── */}
        <TabsContent value="rules" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Regeln werden beim Klick auf «Regeln anwenden» auf die Budgetwerte angewendet.
              Die Originalwerte bleiben gespeichert – Regeln sind nicht destruktiv.
            </p>
            <Button size="sm" onClick={() => setRuleDialog(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Neue Regel
            </Button>
          </div>

          {budget.rules.length === 0 ? (
            <Alert>
              <AlertDescription>
                Keine Regeln definiert. Erstelle eine Regel um das Budget automatisch anzupassen
                (z.B. Umsatz nächstes Jahr +5 %, Personalkosten-Quote 32 %).
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2">
              {budget.rules.map(rule => {
                const pos = budget.positions.find(p => p.id === rule.positionId);
                return (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="flex items-center gap-2.5">
                      {RULE_ICONS[rule.type]}
                      <div>
                        <p className="text-sm font-medium">{rule.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {RULE_LABELS[rule.type]} · Position: {pos?.label ?? rule.positionId}
                          {rule.month && ` · Monat: ${BUDGET_MONTH_NAMES_FULL[rule.month - 1]}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">
                        {rule.type.includes('override') ? `CHF ${CHF(rule.value)}` : `${rule.value}%`}
                      </Badge>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:bg-red-50"
                        onClick={() => {
                          const upd = removeBudgetRule(selectedYear, rule.id);
                          setBudget(upd);
                          toast.success('Regel entfernt');
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {budget.wasAutoCalculated && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-700">
                Dieses Budget enthält Werte, die durch automatische Regeln berechnet wurden.
              </AlertDescription>
            </Alert>
          )}

          {budget.copiedFromYear && (
            <Alert>
              <AlertDescription>
                Dieses Budget ist eine Kopie von {budget.copiedFromYear}.
                Erstellt am {format(new Date(budget.createdAt), 'dd.MM.yyyy', { locale: de })}.
              </AlertDescription>
            </Alert>
          )}

          <div className="pt-2">
            <Button onClick={handleApplyRules} className="gap-2" disabled={budget.rules.length === 0}>
              <RefreshCw className="h-4 w-4" />
              Regeln jetzt anwenden
            </Button>
            <p className="text-xs text-muted-foreground mt-1.5">
              Anwenden überschreibt die Monatswerte der betroffenen Positionen.
              Speichere das Budget danach.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Dialoge ── */}

      <CopyYearDialog
        open={copyDialog}
        onClose={() => setCopyDialog(false)}
        currentYear={selectedYear}
        savedYears={savedYears}
        onCopy={(from, to, applyRules) => {
          copyBudgetYear(from, to, applyRules);
          setSavedYears(availableBudgetYears());
          setSelectedYear(to);
          reload(to);
          setCopyDialog(false);
          toast.success(`Budget ${from} → ${to} kopiert`);
        }}
      />

      <AddRuleDialog
        open={ruleDialog}
        onClose={() => setRuleDialog(false)}
        positions={budget.positions}
        onAdd={rule => {
          const upd = addBudgetRule(selectedYear, rule);
          setBudget(upd);
          setRuleDialog(false);
          toast.success('Regel hinzugefügt');
        }}
      />

      {editDialog && (
        <PositionEditDialog
          position={editDialog}
          monthlyRevenue={resolved.monthlyRevenue}
          open
          onClose={() => setEditDialog(null)}
          onSave={updated => {
            const upd = updateBudgetPosition(selectedYear, updated);
            setBudget(upd);
            setEditDialog(null);
            toast.success('Position aktualisiert');
          }}
        />
      )}

      <Dialog open={deleteDialog} onOpenChange={setDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Budget {selectedYear} löschen?</DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Das Budget {selectedYear} wird vollständig gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(false)}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => {
              deleteBudgetYear(selectedYear);
              setSavedYears(availableBudgetYears());
              reload(selectedYear);
              setDeleteDialog(false);
              toast.success(`Budget ${selectedYear} gelöscht`);
            }}>
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Inline-Editor (expandiert in der Tabelle) ────────────────────────────────

function PositionInlineEditor({
  position, monthlyRevenue, onSave, onCancel,
}: {
  position: BudgetPosition;
  monthlyRevenue: number[];
  onSave: (p: BudgetPosition) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<number[]>([...position.monthlyValues]);
  const [vType, setVType]   = useState<BudgetValueType>(position.valueType);

  const handleChange = (m: number, raw: string) => {
    const num = parseFloat(raw.replace(',', '.')) || 0;
    setValues(prev => { const n = [...prev]; n[m] = num; return n; });
  };

  const applyToAll = (val: number) =>
    setValues(Array(12).fill(val));

  return (
    <div className="p-4 border-t bg-blue-50/50 space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-sm">Werttyp:</Label>
          <Select value={vType} onValueChange={v => setVType(v as BudgetValueType)}>
            <SelectTrigger className="w-40 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chf">CHF (fixer Betrag)</SelectItem>
              <SelectItem value="percent">% (Anteil Umsatz)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Alle Monate auf:</span>
          <Input
            type="number" className="h-8 w-28"
            placeholder="Wert"
            onBlur={e => applyToAll(parseFloat(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className="grid grid-cols-6 md:grid-cols-12 gap-2">
        {BUDGET_MONTH_NAMES.map((name, m) => (
          <div key={m}>
            <Label className="text-xs text-muted-foreground">{name}</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={values[m]}
              onChange={e => handleChange(m, e.target.value)}
            />
            {vType === 'percent' && monthlyRevenue[m] > 0 && (
              <p className="text-[9px] text-muted-foreground mt-0.5">
                = {new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(Math.round(values[m] / 100 * monthlyRevenue[m]))}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave({
          ...position,
          valueType: vType,
          monthlyValues: values as BudgetPosition['monthlyValues'],
        })}>
          Speichern
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Abbrechen</Button>
        <p className="text-xs text-muted-foreground self-center ml-2">
          Total: {vType === 'chf'
            ? `CHF ${new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(values.reduce((s, v) => s + v, 0))}`
            : `Ø ${(values.reduce((s, v) => s + v, 0) / 12).toFixed(1)} %`
          }
        </p>
      </div>
    </div>
  );
}

// ─── Positions-Edit-Dialog ────────────────────────────────────────────────────

function PositionEditDialog({
  position, monthlyRevenue, open, onClose, onSave,
}: {
  position: BudgetPosition;
  monthlyRevenue: number[];
  open: boolean;
  onClose: () => void;
  onSave: (p: BudgetPosition) => void;
}) {
  const [values, setValues] = useState<number[]>([...position.monthlyValues]);
  const [vType, setVType]   = useState<BudgetValueType>(position.valueType);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Position bearbeiten: {position.label}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Label>Werttyp:</Label>
            <Select value={vType} onValueChange={v => setVType(v as BudgetValueType)}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chf">CHF – fixer Monatsbetrag</SelectItem>
                <SelectItem value="percent">% – Anteil am Monats-Umsatz</SelectItem>
              </SelectContent>
            </Select>
            {vType === 'percent' && (
              <p className="text-xs text-muted-foreground">
                Der CHF-Wert wird automatisch aus Umsatz × % berechnet.
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {BUDGET_MONTH_NAMES_FULL.map((name, m) => (
              <div key={m} className="space-y-1">
                <Label className="text-xs">{name}</Label>
                <Input
                  type="number" step="0.1"
                  value={values[m]}
                  onChange={e => {
                    const n = parseFloat(e.target.value.replace(',', '.')) || 0;
                    setValues(prev => { const copy = [...prev]; copy[m] = n; return copy; });
                  }}
                />
                {vType === 'percent' && monthlyRevenue[m] > 0 && (
                  <p className="text-xs text-muted-foreground">
                    = CHF {new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(
                      Math.round(values[m] / 100 * monthlyRevenue[m])
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={() => onSave({
            ...position,
            valueType: vType,
            monthlyValues: values as BudgetPosition['monthlyValues'],
          })}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Jahr-Kopier-Dialog ───────────────────────────────────────────────────────

function CopyYearDialog({
  open, onClose, currentYear, savedYears, onCopy,
}: {
  open: boolean;
  onClose: () => void;
  currentYear: number;
  savedYears: number[];
  onCopy: (from: number, to: number, applyRules: boolean) => void;
}) {
  const [fromYear, setFromYear]       = useState(currentYear);
  const [toYear, setToYear]           = useState(currentYear + 1);
  const [applyRules, setApplyRules]   = useState(true);

  const sourceYears = savedYears.length > 0 ? savedYears : [currentYear];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            Budget-Jahr kopieren
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Von Jahr (Quelle)</Label>
              <Select value={String(fromYear)} onValueChange={v => setFromYear(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sourceYears.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>In Jahr (Ziel)</Label>
              <Input
                type="number"
                value={toYear}
                onChange={e => setToYear(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30">
            <input
              type="checkbox"
              id="apply-rules"
              checked={applyRules}
              onChange={e => setApplyRules(e.target.checked)}
              className="mt-0.5"
            />
            <label htmlFor="apply-rules" className="text-sm cursor-pointer">
              <span className="font-medium">Regeln automatisch anwenden</span>
              <br />
              <span className="text-xs text-muted-foreground">
                Anpassungsregeln des Quell-Jahres werden auf das neue Budget angewendet
                (z.B. Umsatz +5 %, Personalkosten-Quote 32 %).
              </span>
            </label>
          </div>

          <Alert>
            <AlertDescription className="text-sm">
              Das Budget <strong>{fromYear}</strong> wird kopiert und als Budget <strong>{toYear}</strong> gespeichert.
              Das Quell-Budget <strong>{fromYear}</strong> bleibt unverändert.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={() => onCopy(fromYear, toYear, applyRules)} className="gap-1.5">
            <Copy className="h-4 w-4" />
            Kopieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Regel-Hinzufügen-Dialog ──────────────────────────────────────────────────

function AddRuleDialog({
  open, onClose, positions, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  positions: BudgetPosition[];
  onAdd: (rule: Omit<BudgetRule, 'id' | 'createdAt'>) => void;
}) {
  const [ruleType,    setRuleType]    = useState<BudgetRuleType>('increase_revenue_by_pct');
  const [positionId,  setPositionId]  = useState(positions[0]?.id ?? '');
  const [value,       setValue]       = useState<number>(5);
  const [month,       setMonth]       = useState<number | undefined>(undefined);

  const buildDescription = (): string => {
    const pos  = positions.find(p => p.id === positionId)?.label ?? positionId;
    const mStr = month ? ` (${BUDGET_MONTH_NAMES_FULL[month - 1]})` : '';
    switch (ruleType) {
      case 'increase_revenue_by_pct':  return `${pos} um ${value} % erhöhen${mStr}`;
      case 'set_cost_ratio':           return `${pos} auf ${value} % des Umsatzes setzen${mStr}`;
      case 'reduce_cost_by_pct':       return `${pos} um ${value} % reduzieren${mStr}`;
      case 'monthly_factor':           return `${pos}${mStr}: Faktor ${value}`;
      case 'monthly_fixed_override':   return `${pos}${mStr}: fix CHF ${value}`;
    }
  };

  const needsMonth = ruleType === 'monthly_factor' || ruleType === 'monthly_fixed_override';
  const isPercent  = ruleType !== 'monthly_fixed_override';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Neue Anpassungsregel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Regeltyp</Label>
            <Select value={ruleType} onValueChange={v => setRuleType(v as BudgetRuleType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(RULE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Betrifft Position</Label>
            <Select value={positionId} onValueChange={setPositionId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {positions.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{isPercent ? 'Prozentwert' : 'CHF-Betrag'}</Label>
              <Input
                type="number" step="0.5"
                value={value}
                onChange={e => setValue(parseFloat(e.target.value) || 0)}
              />
              <p className="text-xs text-muted-foreground">
                {isPercent ? 'z.B. 5 für +5 % oder 32 für 32%-Quote' : 'CHF-Betrag für diesen Monat'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Monat (optional)</Label>
              <Select
                value={month ? String(month) : 'all'}
                onValueChange={v => setMonth(v === 'all' ? undefined : Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Monate</SelectItem>
                  {BUDGET_MONTH_NAMES_FULL.map((name, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {needsMonth && month === undefined && (
            <Alert>
              <AlertDescription className="text-sm">
                «Monat-Faktor» und «Monat-CHF-Override» brauchen einen spezifischen Monat.
              </AlertDescription>
            </Alert>
          )}

          <div className="rounded-lg border p-3 bg-muted/30">
            <p className="text-xs text-muted-foreground mb-0.5">Vorschau:</p>
            <p className="text-sm font-medium">{buildDescription()}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button
            onClick={() => onAdd({
              type:        ruleType,
              positionId,
              value,
              month:       needsMonth ? month : (month ?? undefined),
              description: buildDescription(),
            })}
            disabled={needsMonth && month === undefined}
          >
            Regel hinzufügen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
