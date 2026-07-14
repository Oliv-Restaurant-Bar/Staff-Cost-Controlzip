/**
 * Lieferantenvergleich – Admin-only
 * ====================================
 *
 * Vergleicht:
 *   Operative Lieferantendokumente (Lieferscheine / Rechnungen)
 *   vs.
 *   Offizielle Buchhaltungswerte (CSV/PDF-Import)
 *
 * Regel: Buchhaltungswerte sind immer die offiziellen Werte.
 * Lieferantendokumente sind nur operative Schätzwerte.
 */

import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  LayoutDashboard, ChevronRight, Scale, Info, AlertCircle,
  CheckCircle2, ArrowUpRight, ArrowDownRight, Minus,
  FileText, ChevronDown, Settings2, X, Plus, Trash2,
  PackageSearch, BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { usePermissions } from '@/hooks/usePermissions';
import {
  buildCostComparison,
  buildSupplierCostComparisons,
  getSupplierCostSummaries,
  loadDocumentsForMonth,
  loadSupplierMappings,
  upsertSupplierMapping,
  deleteSupplierMapping,
  availableYears,
  knownSuppliers,
} from '@/lib/supplier-documents-store';
import {
  SupplierCostComparison,
  AccountToSupplierMapping,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  DOCUMENT_TYPE_LABELS,
  DocumentCategory,
} from '@/types/supplier-documents';
import { MONTH_NAMES_DE } from '@/types/reporting';

// ─── Formatierung ─────────────────────────────────────────────────────────────

const fmt = (v: number, digits = 0) =>
  new Intl.NumberFormat('de-CH', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);

const fmtCHF = (v: number | undefined) =>
  v === undefined ? '—' : `CHF ${fmt(v)}`;

const fmtPct = (v: number | undefined) =>
  v === undefined ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)} %`;

// ─── Status-Logik ─────────────────────────────────────────────────────────────

type DiffStatus = 'balanced' | 'supplier_higher' | 'accounting_higher' | 'no_accounting';

function getDiffStatus(cmp: SupplierCostComparison): DiffStatus {
  if (!cmp.hasAccountingData || cmp.accountingTotal === undefined) return 'no_accounting';
  const diff = cmp.diff ?? 0;
  if (Math.abs(diff) < 1) return 'balanced';
  return diff > 0 ? 'supplier_higher' : 'accounting_higher';
}

const STATUS_CONFIG: Record<DiffStatus, {
  label: string; icon: React.ReactNode;
  bg: string; text: string; border: string;
}> = {
  balanced: {
    label: 'Ausgeglichen',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
  },
  supplier_higher: {
    label: 'Lieferant höher',
    icon: <ArrowUpRight className="h-3.5 w-3.5" />,
    bg: 'bg-amber-50 dark:bg-amber-950/20',
    text: 'text-amber-700 dark:text-amber-400',
    border: 'border-amber-200 dark:border-amber-800',
  },
  accounting_higher: {
    label: 'Buchhaltung höher',
    icon: <ArrowDownRight className="h-3.5 w-3.5" />,
    bg: 'bg-blue-50 dark:bg-blue-950/20',
    text: 'text-blue-700 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
  },
  no_accounting: {
    label: 'Kein Konto zugeordnet',
    icon: <Minus className="h-3.5 w-3.5" />,
    bg: 'bg-slate-50 dark:bg-slate-800/30',
    text: 'text-muted-foreground',
    border: 'border-border',
  },
};

const StatusBadge = ({ status }: { status: DiffStatus }) => {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border',
      cfg.bg, cfg.text, cfg.border,
    )}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
};

// ─── Drilldown-Dialog ─────────────────────────────────────────────────────────

const DrilldownDialog = ({
  cmp,
  month,
  year,
  mapping,
  onClose,
}: {
  cmp: SupplierCostComparison;
  month: number;
  year: number;
  mapping?: AccountToSupplierMapping;
  onClose: () => void;
}) => {
  const docs = useMemo(
    () => loadDocumentsForMonth(year, month).filter(d => d.supplier === cmp.supplier),
    [cmp.supplier, year, month],
  );
  const status = getDiffStatus(cmp);
  const cfg    = STATUS_CONFIG[status];

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <PackageSearch className="h-4 w-4 text-muted-foreground" />
            {cmp.supplier}
            <span className="text-muted-foreground font-normal text-xs">
              – {MONTH_NAMES_DE[month]} {year}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">

          {/* Summary */}
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-muted-foreground mb-1 flex items-center gap-1">
                <FileText className="h-3 w-3" /> Lieferantendokumente
              </p>
              <p className="text-lg font-bold">{fmtCHF(cmp.operationalTotal)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{docs.length} Belege</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-muted-foreground mb-1 flex items-center gap-1">
                <BookOpen className="h-3 w-3" /> Buchhaltung
              </p>
              <p className={cn('text-lg font-bold', !cmp.hasAccountingData && 'text-muted-foreground/50')}>
                {cmp.hasAccountingData ? fmtCHF(cmp.accountingTotal) : '—'}
              </p>
              {mapping && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Konto {mapping.accountId}
                  {(mapping.allocationPct ?? 100) < 100 && ` · ${mapping.allocationPct}%`}
                </p>
              )}
            </div>
            <div className={cn('rounded-lg border p-3', cfg.border, cfg.bg)}>
              <p className={cn('text-[10px] font-semibold mb-1', cfg.text)}>Abweichung</p>
              <p className={cn('text-lg font-bold', cfg.text)}>
                {cmp.diff !== undefined
                  ? `${cmp.diff > 0 ? '+' : ''}${fmtCHF(cmp.diff)}`
                  : '—'}
              </p>
              <p className={cn('text-[10px] mt-0.5', cfg.text)}>
                {cmp.diffPct !== undefined ? fmtPct(cmp.diffPct) : ''}
              </p>
            </div>
          </div>

          {/* Status + Erklärung */}
          <div className={cn('rounded-lg border p-3 flex items-start gap-2', cfg.border, cfg.bg)}>
            <div className={cn('mt-0.5', cfg.text)}>{cfg.icon}</div>
            <div className={cn('text-xs', cfg.text)}>
              <span className="font-semibold">{cfg.label}:</span>{' '}
              {status === 'balanced' && 'Lieferantendokumente und Buchhaltung stimmen überein (Differenz < CHF 1).'}
              {status === 'supplier_higher' && 'Lieferantendokumente übersteigen den Buchhaltungswert. Mögliche Gründe: offene Rechnungen, Timing-Unterschied, oder noch nicht gebuchte Belege.'}
              {status === 'accounting_higher' && 'Buchhaltungswert übersteigt die erfassten Lieferantendokumente. Mögliche Gründe: fehlende Belege oder Sammelkonto mit mehreren Lieferanten.'}
              {status === 'no_accounting' && 'Diesem Lieferanten ist noch kein Buchhaltungskonto zugeordnet. Bitte in der Kontozuordnung konfigurieren.'}
            </div>
          </div>

          {/* Kategorie-Aufschlüsselung */}
          {(cmp.operationalFoodCost > 0 || cmp.operationalBeverageCost > 0 || cmp.operationalOtherCost > 0) && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Aufschlüsselung nach Kategorie
              </h3>
              <div className="flex gap-2 flex-wrap">
                {cmp.operationalFoodCost > 0 && (
                  <div className={cn('rounded px-2 py-1 border text-xs', CATEGORY_COLORS.food.bg, CATEGORY_COLORS.food.text, CATEGORY_COLORS.food.border)}>
                    Küche: {fmtCHF(cmp.operationalFoodCost)}
                  </div>
                )}
                {cmp.operationalBeverageCost > 0 && (
                  <div className={cn('rounded px-2 py-1 border text-xs', CATEGORY_COLORS.beverage.bg, CATEGORY_COLORS.beverage.text, CATEGORY_COLORS.beverage.border)}>
                    Getränke: {fmtCHF(cmp.operationalBeverageCost)}
                  </div>
                )}
                {cmp.operationalOtherCost > 0 && (
                  <div className={cn('rounded px-2 py-1 border text-xs', CATEGORY_COLORS.other.bg, CATEGORY_COLORS.other.text, CATEGORY_COLORS.other.border)}>
                    Diverses: {fmtCHF(cmp.operationalOtherCost)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Einzelbelege */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Erfasste Belege ({docs.length})
            </h3>
            {docs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Keine Belege für diesen Monat.</p>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Datum</th>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Typ</th>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Kategorie</th>
                      <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Betrag (CHF)</th>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Notiz</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {docs.map(doc => (
                      <tr key={doc.id} className="hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono">{doc.date}</td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="text-[10px]">
                            {DOCUMENT_TYPE_LABELS[doc.documentType]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded border',
                            CATEGORY_COLORS[doc.category].bg,
                            CATEGORY_COLORS[doc.category].text,
                            CATEGORY_COLORS[doc.category].border,
                          )}>
                            {CATEGORY_LABELS[doc.category]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {fmt(doc.amount)}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground italic text-[10px]">
                          {doc.note ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/30 border-t border-border">
                    <tr>
                      <td colSpan={3} className="px-3 py-2 text-xs font-semibold">Total</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-sm">
                        {fmt(cmp.operationalTotal)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Quelle: Buchhaltung */}
          {cmp.hasAccountingData && mapping && (
            <div className="rounded-lg border border-border p-3 text-xs space-y-1">
              <p className="font-semibold text-muted-foreground uppercase tracking-wider text-[10px] mb-2">
                Buchhaltungsquelle
              </p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kontonummer</span>
                <span className="font-mono font-bold">{mapping.accountId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Anteil</span>
                <span>{mapping.allocationPct ?? 100} %</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Buchhaltungsbetrag (anteilig)</span>
                <span className="font-mono font-semibold">{fmtCHF(cmp.accountingTotal)}</span>
              </div>
              <div className="rounded bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-2 text-amber-700 dark:text-amber-400 flex items-start gap-1.5 mt-2">
                <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
                Der Buchhaltungswert ist der offizielle Wert. Lieferantendokumente ersetzen ihn nie.
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ─── Mapping-Konfiguration ────────────────────────────────────────────────────

const MappingPanel = ({
  suppliers,
  onClose,
}: {
  suppliers: string[];
  onClose: () => void;
}) => {
  const [mappings, setMappings] = useState<AccountToSupplierMapping[]>(() => loadSupplierMappings());
  const [editSupplier, setEditSupplier] = useState('');
  const [editAccount,  setEditAccount]  = useState('');
  const [editCategory, setEditCategory] = useState<DocumentCategory>('food');
  const [editPct,      setEditPct]      = useState<number>(100);
  const [addError,     setAddError]     = useState('');

  function handleAdd() {
    if (!editSupplier.trim()) { setAddError('Bitte Lieferant wählen.'); return; }
    if (!editAccount.trim())  { setAddError('Bitte Kontonummer eingeben.'); return; }
    const m: AccountToSupplierMapping = {
      supplier: editSupplier.trim(),
      accountId: editAccount.trim(),
      category: editCategory,
      allocationPct: editPct,
    };
    upsertSupplierMapping(m);
    setMappings(loadSupplierMappings());
    setEditSupplier(''); setEditAccount(''); setEditCategory('food'); setEditPct(100);
    setAddError('');
  }

  function handleDelete(supplier: string) {
    deleteSupplierMapping(supplier);
    setMappings(loadSupplierMappings());
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            Kontozuordnung: Lieferant → Buchaltungskonto
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 flex items-start gap-2 text-xs text-blue-700 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <p>Legen Sie fest, welcher Lieferant welchem Buchhaltungskonto (z.B. 4400 für Küche Warenaufwand) entspricht.
            Damit kann die Abweichung pro Lieferant berechnet werden.</p>
          </div>

          {/* Bestehende Mappings */}
          {mappings.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Lieferant</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Konto</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Kategorie</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Anteil %</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mappings.map(m => (
                    <tr key={m.supplier} className="hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium">{m.supplier}</td>
                      <td className="px-3 py-2 font-mono text-primary">{m.accountId}</td>
                      <td className="px-3 py-2">
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded border',
                          CATEGORY_COLORS[m.category].bg,
                          CATEGORY_COLORS[m.category].text,
                          CATEGORY_COLORS[m.category].border,
                        )}>
                          {CATEGORY_LABELS[m.category]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">{m.allocationPct ?? 100} %</td>
                      <td className="px-2 py-2">
                        <button
                          onClick={() => handleDelete(m.supplier)}
                          className="text-muted-foreground hover:text-red-600 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Neue Zuordnung */}
          <div className="rounded-lg border border-border p-3 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Neue Zuordnung
            </h3>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground font-medium">Lieferant</label>
                <input
                  list="supplier-list"
                  value={editSupplier}
                  onChange={e => setEditSupplier(e.target.value)}
                  placeholder="z.B. Pistor AG"
                  className="w-full border border-border rounded px-2 py-1.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <datalist id="supplier-list">
                  {suppliers.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground font-medium">Kontonummer</label>
                <input
                  value={editAccount}
                  onChange={e => setEditAccount(e.target.value)}
                  placeholder="z.B. 4400"
                  className="w-full border border-border rounded px-2 py-1.5 text-xs font-mono bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground font-medium">Kategorie</label>
                <select
                  value={editCategory}
                  onChange={e => setEditCategory(e.target.value as DocumentCategory)}
                  className="w-full border border-border rounded px-2 py-1.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="food">Küche / Food</option>
                  <option value="beverage">Getränke / Beverage</option>
                  <option value="other">Diverses / Other</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground font-medium">
                  Anteil des Kontos (%)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={editPct}
                  onChange={e => setEditPct(Number(e.target.value))}
                  className="w-full border border-border rounded px-2 py-1.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {addError && (
              <p className="text-xs text-red-600">{addError}</p>
            )}

            <Button size="sm" className="text-xs h-7" onClick={handleAdd}>
              <Plus className="h-3 w-3 mr-1" /> Zuordnung speichern
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Tipp: Falls ein Konto mehrere Lieferanten hat, teilen Sie den Anteil auf (z.B. 60% Pistor, 40% Transgourmet).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ─── Lieferanten-Zeile ────────────────────────────────────────────────────────

const SupplierRow = ({
  cmp,
  mapping,
  onClick,
}: {
  cmp: SupplierCostComparison;
  mapping?: AccountToSupplierMapping;
  onClick: () => void;
}) => {
  const status = getDiffStatus(cmp);

  const mainCategory = cmp.operationalFoodCost >= cmp.operationalBeverageCost &&
                       cmp.operationalFoodCost >= cmp.operationalOtherCost
    ? 'food'
    : cmp.operationalBeverageCost >= cmp.operationalOtherCost
    ? 'beverage'
    : 'other';

  return (
    <tr
      className="hover:bg-muted/30 cursor-pointer border-b border-slate-100 dark:border-slate-800 transition-colors"
      onClick={onClick}
      title="Klicken für Details"
    >
      {/* Lieferant */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{cmp.supplier}</span>
          {mapping && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1 rounded">
              Kto. {mapping.accountId}
            </span>
          )}
        </div>
      </td>

      {/* Kategorie */}
      <td className="px-2 py-2.5">
        <span className={cn(
          'text-[10px] px-1.5 py-0.5 rounded border',
          CATEGORY_COLORS[mainCategory].bg,
          CATEGORY_COLORS[mainCategory].text,
          CATEGORY_COLORS[mainCategory].border,
        )}>
          {CATEGORY_LABELS[mainCategory]}
        </span>
      </td>

      {/* Lieferantendokumente */}
      <td className="px-2 py-2.5 text-right font-mono text-sm font-semibold">
        {fmt(cmp.operationalTotal)}
      </td>

      {/* Buchhaltung */}
      <td className="px-2 py-2.5 text-right font-mono text-sm text-muted-foreground">
        {cmp.hasAccountingData && cmp.accountingTotal !== undefined
          ? fmt(cmp.accountingTotal)
          : <span className="text-muted-foreground/40">—</span>
        }
      </td>

      {/* Differenz */}
      <td className="px-2 py-2.5 text-right">
        {cmp.diff !== undefined ? (
          <span className={cn(
            'font-mono text-sm font-semibold',
            Math.abs(cmp.diff) < 1 ? 'text-emerald-600 dark:text-emerald-400' :
            cmp.diff > 0 ? 'text-amber-600 dark:text-amber-400' :
                           'text-blue-600 dark:text-blue-400',
          )}>
            {cmp.diff > 0 ? '+' : ''}{fmt(cmp.diff)}
            {cmp.diffPct !== undefined && (
              <span className="ml-1 text-[10px] opacity-70">{fmtPct(cmp.diffPct)}</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground/40 text-sm">—</span>
        )}
      </td>

      {/* Status */}
      <td className="px-2 py-2.5 text-right">
        <StatusBadge status={status} />
      </td>

      {/* Drilldown-Indicator */}
      <td className="px-2 py-2.5 w-6">
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground opacity-40" />
      </td>
    </tr>
  );
};

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const years = [currentYear - 1, currentYear, currentYear + 1];

export default function SupplierComparisonPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  const [year,        setYear]        = useState(currentYear);
  const [month,       setMonth]       = useState(currentMonth);
  const [drilldown,   setDrilldown]   = useState<SupplierCostComparison | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [_, forceUpdate]              = useState(0);

  const allSuppliers = useMemo(() => knownSuppliers(), []);

  const comparison  = useMemo(() => buildCostComparison(year, month),           [year, month, _]);
  const supplierCmp = useMemo(() => buildSupplierCostComparisons(year, month),   [year, month, _]);
  const mappings    = useMemo(() => loadSupplierMappings(),                       [year, month, _]);

  const totalOperational = supplierCmp.reduce((s, c) => s + c.operationalTotal, 0);

  const drilldownMapping = drilldown
    ? mappings.find(m => m.supplier === drilldown.supplier)
    : undefined;

  const handleMappingClose = () => {
    setShowMapping(false);
    forceUpdate(n => n + 1);
  };

  const statusCounts = useMemo(() => {
    const r = { balanced: 0, supplier_higher: 0, accounting_higher: 0, no_accounting: 0 };
    supplierCmp.forEach(c => r[getDiffStatus(c)]++);
    return r;
  }, [supplierCmp]);

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-full px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Dashboard</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Link to="/lieferanten">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <FileText className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Lieferantendokumente</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <Scale className="h-4 w-4 text-muted-foreground" />
              Lieferantenvergleich
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50">
              Admin
            </Badge>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setShowMapping(true)}
            >
              <Settings2 className="h-3 w-3 mr-1" />
              Kontozuordnung
            </Button>

            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_NAMES_DE.slice(1).map((name, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 py-5 space-y-5 pb-20">

        {/* Summary-Karten */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Total Lieferantendokumente */}
          <Card className="border">
            <CardContent className="p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="h-3 w-3 text-muted-foreground" />
                <p className="text-[11px] text-muted-foreground">Lieferantendokumente</p>
              </div>
              <p className="text-lg font-bold">{fmtCHF(comparison.operationalTotalCost)}</p>
              <p className="text-[10px] text-muted-foreground">{comparison.documentCount} Belege</p>
            </CardContent>
          </Card>

          {/* Total Buchhaltung */}
          <Card className={cn('border', comparison.hasAccountingData ? 'border-slate-200' : 'border-dashed')}>
            <CardContent className="p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <BookOpen className="h-3 w-3 text-muted-foreground" />
                <p className="text-[11px] text-muted-foreground">Buchhaltung Warenaufwand</p>
              </div>
              {comparison.hasAccountingData ? (
                <>
                  <p className="text-lg font-bold">{fmtCHF(comparison.accountingTotalCost)}</p>
                  <p className="text-[10px] text-muted-foreground">Aus Buchhaltungsimport</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">Kein Import</p>
              )}
            </CardContent>
          </Card>

          {/* Differenz Total */}
          <Card className={cn('border',
            comparison.diffTotalCost === undefined ? 'border-dashed' :
            Math.abs(comparison.diffTotalCost) < 1 ? 'border-emerald-200 dark:border-emerald-800' :
            comparison.diffTotalCost > 0 ? 'border-amber-200 dark:border-amber-800' :
                                           'border-blue-200 dark:border-blue-800',
          )}>
            <CardContent className="p-3">
              <p className="text-[11px] text-muted-foreground mb-1">Differenz Total</p>
              {comparison.diffTotalCost !== undefined ? (
                <>
                  <p className={cn('text-lg font-bold',
                    Math.abs(comparison.diffTotalCost) < 1 ? 'text-emerald-600' :
                    comparison.diffTotalCost > 0 ? 'text-amber-600' : 'text-blue-600'
                  )}>
                    {comparison.diffTotalCost > 0 ? '+' : ''}{fmtCHF(comparison.diffTotalCost)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {fmtPct(comparison.diffTotalPct)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">—</p>
              )}
            </CardContent>
          </Card>

          {/* Lieferanten */}
          <Card className="border">
            <CardContent className="p-3">
              <p className="text-[11px] text-muted-foreground mb-1">Lieferanten</p>
              <p className="text-lg font-bold">{supplierCmp.length}</p>
              <div className="flex gap-1 flex-wrap mt-1">
                {statusCounts.balanced > 0 && (
                  <span className="text-[10px] text-emerald-600">✓ {statusCounts.balanced} ausgeglichen</span>
                )}
                {statusCounts.supplier_higher > 0 && (
                  <span className="text-[10px] text-amber-600">↑ {statusCounts.supplier_higher} höher</span>
                )}
                {statusCounts.accounting_higher > 0 && (
                  <span className="text-[10px] text-blue-600">↓ {statusCounts.accounting_higher} niedriger</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Kategorie-Übersicht */}
        {comparison.hasAccountingData && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { cat: 'food',     label: 'Küche / Food',        op: comparison.operationalFoodCost,     acc: comparison.accountingFoodCost     },
              { cat: 'beverage', label: 'Getränke / Beverage', op: comparison.operationalBeverageCost, acc: comparison.accountingBeverageCost },
              { cat: 'other',    label: 'Diverses / Other',    op: comparison.operationalOtherCost,    acc: undefined },
            ].map(({ cat, label, op, acc }) => {
              const diff = acc !== undefined ? op - acc : undefined;
              const colors = CATEGORY_COLORS[cat as DocumentCategory];
              return (
                <div key={cat} className={cn('rounded-lg border p-3', colors.border, colors.bg)}>
                  <p className={cn('text-[11px] font-semibold mb-2', colors.text)}>{label}</p>
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Lieferantendokumente</span>
                      <span className="font-mono font-semibold">{fmtCHF(op)}</span>
                    </div>
                    {acc !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Buchhaltung</span>
                        <span className="font-mono">{fmtCHF(acc)}</span>
                      </div>
                    )}
                    {diff !== undefined && (
                      <div className="flex justify-between border-t border-current/20 pt-1 mt-1">
                        <span className="text-muted-foreground">Differenz</span>
                        <span className={cn('font-mono font-semibold',
                          Math.abs(diff) < 1 ? 'text-emerald-600' :
                          diff > 0 ? 'text-amber-600' : 'text-blue-600'
                        )}>
                          {diff > 0 ? '+' : ''}{fmtCHF(diff)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Keine Daten Hinweis */}
        {supplierCmp.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground">
            <PackageSearch className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Keine Lieferantendokumente für {MONTH_NAMES_DE[month]} {year}</p>
            <p className="text-sm mt-1">
              Erfassen Sie Dokumente unter{' '}
              <Link to="/lieferanten" className="text-primary underline">Lieferantendokumente</Link>.
            </p>
          </div>
        )}

        {/* Lieferanten-Tabelle */}
        {supplierCmp.length > 0 && (
          <div className="rounded-lg border border-border overflow-hidden shadow-sm">
            <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">
                  Vergleich pro Lieferant – {MONTH_NAMES_DE[month]} {year}
                </h2>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Lieferantendokumente (operativ) vs. Buchhaltung (offiziell) · Klicken für Details
                </p>
              </div>
              {!comparison.hasAccountingData && (
                <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-300 bg-amber-950/30">
                  Kein Buchhaltungsimport
                </Badge>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse min-w-[720px]">
                <thead>
                  <tr className="bg-slate-800 text-white text-xs">
                    <th className="text-left px-3 py-2.5 min-w-[200px]">Lieferant</th>
                    <th className="text-left px-2 py-2.5">Kategorie</th>
                    <th className="text-right px-2 py-2.5 min-w-[130px]">Lieferantendokumente</th>
                    <th className="text-right px-2 py-2.5 min-w-[120px]">Buchhaltung (CHF)</th>
                    <th className="text-right px-2 py-2.5 min-w-[130px]">Differenz (CHF)</th>
                    <th className="text-right px-2 py-2.5 min-w-[150px]">Status</th>
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody>
                  {supplierCmp.map(cmp => (
                    <SupplierRow
                      key={cmp.supplier}
                      cmp={cmp}
                      mapping={mappings.find(m => m.supplier === cmp.supplier)}
                      onClick={() => setDrilldown(cmp)}
                    />
                  ))}
                </tbody>
                <tfoot className="bg-slate-100 dark:bg-slate-800/60 border-t-2 border-slate-300 dark:border-slate-600">
                  <tr>
                    <td className="px-3 py-2.5 text-sm font-bold" colSpan={2}>Total</td>
                    <td className="px-2 py-2.5 text-right font-mono font-bold">
                      {fmt(totalOperational)}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-muted-foreground">
                      {comparison.accountingTotalCost !== undefined
                        ? fmt(comparison.accountingTotalCost)
                        : '—'}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono font-bold">
                      {comparison.diffTotalCost !== undefined
                        ? <span className={cn(
                            Math.abs(comparison.diffTotalCost) < 1 ? 'text-emerald-600' :
                            comparison.diffTotalCost > 0 ? 'text-amber-600' : 'text-blue-600'
                          )}>
                            {comparison.diffTotalCost > 0 ? '+' : ''}{fmt(comparison.diffTotalCost)}
                          </span>
                        : '—'}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Hinweis Buchhaltungsprimat */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/20 p-3 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            <span className="font-semibold">Wichtige Regel:</span> Buchhaltungswerte aus dem CSV/PDF-Import sind immer die offiziellen Werte.
            Lieferantendokumente (Lieferscheine / Rechnungen) sind nur operative Schätzwerte und ersetzen die Buchhaltung nie.
            Abweichungen zwischen den beiden Quellen müssen betrieblich überprüft werden.
          </p>
        </div>
      </div>

      {/* Dialoge */}
      {drilldown && (
        <DrilldownDialog
          cmp={drilldown}
          month={month}
          year={year}
          mapping={drilldownMapping}
          onClose={() => setDrilldown(null)}
        />
      )}

      {showMapping && (
        <MappingPanel
          suppliers={allSuppliers}
          onClose={handleMappingClose}
        />
      )}
    </div>
  );
}
