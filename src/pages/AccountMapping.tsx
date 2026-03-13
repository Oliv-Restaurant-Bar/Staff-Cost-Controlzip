/**
 * Kontenplan / Account Mapping – Admin-Übersicht
 * ===============================================
 * Zeigt alle 4-stelligen Kontonummern mit ihrer P&L-Zuordnung.
 *
 * Admin kann:
 *   - Alle Zuordnungen nach Abschnitt / Kategorie / Abteilung filtern
 *   - Einzelne Konten manuell anpassen (Custom-Mapping)
 *   - Custom-Mappings auf Default zurücksetzen
 *   - Neue Konten manuell hinzufügen
 *   - 4-stellige Kontonummer testen (Vorschau der Import-Logik)
 *
 * Nur für Admin zugänglich.
 */

import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Search, X,
  Edit3, Save, RotateCcw, Plus, Info, CheckCircle2,
  AlertTriangle, Zap, Settings2,
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
  DEFAULT_ACCOUNTS,
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

  // Automatisch Abschnitt aus Kategorie ableiten
  const handleCategoryChange = (cat: PLCategory) => {
    setPlCategory(cat);
    const catDef = PL_CATEGORIES.find(c => c.id === cat);
    if (catDef) {
      setPlSection(catDef.section);
      setSign(catDef.sign);
    }
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
              <Input
                value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="3000"
                maxLength={4}
                className="h-9 text-sm font-mono"
                disabled={!isNew}
              />
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
            <DataRow label="Kontoname"    value={result.mapping.accountName} />
            <DataRow label="P&L-Kategorie" value={getCategoryLabel(result.mapping.plCategory)} />
            <DataRow label="Abschnitt"    value={getSectionLabel(result.mapping.plSection)} />
            <DataRow label="Abteilung"    value={DEPARTMENT_LABELS[result.mapping.department ?? 'general'] ?? '–'} />
            <DataRow label="Vorzeichen"   value={result.mapping.sign === 'income' ? 'Ertrag (+)' : 'Aufwand (−)'} />
            {result.matchType === 'range' && (
              <p className="text-amber-600 text-[10px] mt-1 italic">
                Kein exaktes Konto gefunden – Bereichsregel verwendet.
                Beim Import: manuell bestätigen oder neue Regel anlegen.
              </p>
            )}
          </div>
        )}

        {testNumber.length === 4 && result?.requiresManualMapping && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 p-2 text-[11px] text-red-700 dark:text-red-400">
            Kein Mapping für Konto {testNumber} gefunden.
            Beim Import muss dieser Betrag manuell zugeordnet werden.
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const DataRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground w-28 flex-shrink-0">{label}:</span>
    <span className="font-medium">{value}</span>
  </div>
);

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const AccountMappingPage = () => {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  const [mappings,    setMappings]    = useState<AccountMappingType[]>(() => loadAllMappings());
  const [editTarget,  setEditTarget]  = useState<AccountMappingType | null>(null);
  const [showNew,     setShowNew]     = useState(false);
  const [search,      setSearch]      = useState('');
  const [filterSection, setFilterSection] = useState<PLSection | 'all'>('all');
  const [filterDept,  setFilterDept]  = useState<DepartmentHint | 'all'>('all');

  const reload = useCallback(() => setMappings(loadAllMappings()), []);

  const filtered = useMemo(() => mappings.filter(m => {
    if (filterSection !== 'all' && m.plSection !== filterSection) return false;
    if (filterDept    !== 'all' && m.department !== filterDept)   return false;
    if (search && !m.accountNumber.includes(search) &&
        !m.accountName.toLowerCase().includes(search.toLowerCase()) &&
        !getCategoryLabel(m.plCategory).toLowerCase().includes(search.toLowerCase())
    ) return false;
    return true;
  }), [mappings, filterSection, filterDept, search]);

  // Gruppiert nach P&L-Abschnitt
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

  const customCount  = mappings.filter(m => m.source === 'custom').length;
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
            <Link to="/reporting">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <TrendingUp className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">Reporting</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              Kontenplan & P&L-Zuordnung
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20">
              Admin
            </Badge>
          </div>
          <Button size="sm" className="h-8" onClick={() => setShowNew(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Konto hinzufügen
          </Button>
        </div>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-5 space-y-5 pb-20">

        {/* Info-Banner */}
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 p-4 flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-blue-800 dark:text-blue-300 space-y-1">
            <p className="font-bold">Kontenmapping – Fundament für den P&L-Import</p>
            <p>
              Diese Tabelle ordnet jede 4-stellige Kontonummer einer P&L-Position zu.
              Beim späteren CSV/PDF-Import aus dem Buchhaltungsprogramm werden die Beträge
              automatisch in die richtigen Abschnitte eingeteilt.
              Standard-Zuordnungen basieren auf dem Schweizer KMU-Kontenrahmen (Gastronomie).
            </p>
          </div>
        </div>

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
              {/* Abschnitt-Header */}
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

              {/* Berechnetes Zwischenergebnis anzeigen */}
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
    </div>
  );
};

export default AccountMappingPage;
