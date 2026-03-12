/**
 * Personalstamm
 * =============
 * Professionelles Mitarbeiterstammdaten-Modul mit rollenbasiertem Zugriff.
 *
 * Admin: alle Felder inkl. Löhne + Bearbeiten + Löschen + neuer MA
 * Manager: nur eigene Abteilung, keine Lohnfelder, nur lesend
 *
 * Vorbereitung Vertragsimport:
 *   - Platzhalter-Upload-Bereich pro Mitarbeiter
 *   - ContractFields-Interface für spätere OCR-Vorbefüllung
 *   - Notizfeld pro Mitarbeiter (localStorage)
 *   - Aktiv/Inaktiv-Status (localStorage)
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, X, Plus, Save, Trash2, Upload, ChevronRight,
  LayoutDashboard, Users, ChefHat, Utensils, FileText,
  AlertTriangle, CheckCircle2, Edit3, ArrowLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { usePermissions } from '@/hooks/usePermissions';
import { loadEmployees, upsertEmployee, deleteEmployee } from '@/lib/supabase-db';
import { Employee, EmploymentType, Department } from '@/types/personnel';
import { toast } from 'sonner';

// ─── Typen ────────────────────────────────────────────────────────────────────

/** Vorbereitung für zukünftigen Vertragsimport via OCR */
interface ContractFields {
  contractStart?: string;     // Eintrittsdatum
  contractEnd?: string;       // Austrittsdatum (bei befristet)
  weeklyHoursContract?: number; // Vertragliche Wochenstunden
  wageContract?: number;      // Lohn aus Vertrag
  positionTitle?: string;     // Stellenbezeichnung
  source: 'manual' | 'ocr';  // Woher kamen die Daten?
}

/** Lokal gespeicherte Felder (kein DB-Spalte nötig) */
interface LocalEmployeeData {
  active: boolean;
  notes: string;
  contract?: ContractFields;
  contractFileName?: string;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const DEPT_LABELS: Record<Department, string> = {
  service: 'Service',
  küche:   'Küche',
};

const TYPE_LABELS: Record<EmploymentType, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob:  'Minijob',
  aushilfe: 'Aushilfe',
};

const DEPT_BADGE_COLOR: Record<Department, string> = {
  service: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300',
  küche:   'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300',
};

const TYPE_BADGE_COLOR: Record<EmploymentType, string> = {
  vollzeit: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30',
  teilzeit: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30',
  minijob:  'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30',
  aushilfe: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900/30',
};

function formatCHF(v?: number): string {
  if (!v) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(v);
}

function calcInternalHourlyCost(emp: Employee): number | null {
  if (emp.employmentType === 'vollzeit' && emp.monthlySalaryWith13th && emp.weeklyHours) {
    return (emp.monthlySalaryWith13th * 12) / (emp.weeklyHours * 52);
  }
  if (emp.employmentType === 'teilzeit' && emp.monthlySalary && emp.weeklyHours) {
    return (emp.monthlySalary * 12) / (emp.weeklyHours * 52);
  }
  return emp.hourlyWage > 0 ? emp.hourlyWage : null;
}

function generateId(existing: Employee[]): string {
  const nums = existing.map(e => parseInt(e.id)).filter(n => !isNaN(n));
  const maxNum = nums.length > 0 ? Math.max(...nums) : 0;
  return String(maxNum + 1);
}

// ─── Lokale Daten (aktiv/inaktiv, Notizen, Vertrag) ──────────────────────────

const LOCAL_KEY = 'personalstamm_local';

function loadLocalData(): Record<string, LocalEmployeeData> {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); }
  catch { return {}; }
}

function saveLocalData(data: Record<string, LocalEmployeeData>) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
}

function getLocalEntry(data: Record<string, LocalEmployeeData>, id: string): LocalEmployeeData {
  return data[id] ?? { active: true, notes: '' };
}

// ─── Leerer Mitarbeiter ───────────────────────────────────────────────────────

function emptyEmployee(id: string): Employee {
  return {
    id,
    name: '',
    department: 'service',
    employmentType: 'aushilfe',
    hourlyWage: 0,
  };
}

// ─── Haupt-Komponente ─────────────────────────────────────────────────────────

const Personalstamm = () => {
  const {
    isAdmin, isManager, allowedDepartment, canEditEmployees,
  } = usePermissions();

  // ── Daten ──────────────────────────────────────────────────────────────────
  const [employees, setEmployees]         = useState<Employee[]>([]);
  const [localData, setLocalData]         = useState<Record<string, LocalEmployeeData>>({});
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [deleteTarget, setDeleteTarget]   = useState<Employee | null>(null);

  // ── Filter ─────────────────────────────────────────────────────────────────
  const [search, setSearch]               = useState('');
  const [filterDept, setFilterDept]       = useState<Department | 'all'>('all');
  const [filterType, setFilterType]       = useState<EmploymentType | 'all'>('all');
  const [filterActive, setFilterActive]   = useState<'all' | 'active' | 'inactive'>('active');

  // ── Detail / Bearbeiten ────────────────────────────────────────────────────
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [editMode, setEditMode]           = useState(false);
  const [editData, setEditData]           = useState<Employee | null>(null);
  const [editNotes, setEditNotes]         = useState('');
  const [editActive, setEditActive]       = useState(true);
  const [showMobile, setShowMobile]       = useState<'list' | 'detail'>('list');
  const [showContractInfo, setShowContractInfo] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Laden ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const emps = await loadEmployees();
      if (emps) setEmployees(emps);
      setLocalData(loadLocalData());
      setLoading(false);
    };
    load();
  }, []);

  // ── Gefilterte Mitarbeiter ─────────────────────────────────────────────────
  const visibleBase = useMemo(() =>
    isAdmin ? employees : employees.filter(e => e.department === allowedDepartment),
  [employees, isAdmin, allowedDepartment]);

  const filtered = useMemo(() => {
    return visibleBase.filter(emp => {
      const local = getLocalEntry(localData, emp.id);
      if (filterActive === 'active'   && !local.active)  return false;
      if (filterActive === 'inactive' && local.active)   return false;
      if (filterDept !== 'all' && emp.department !== filterDept) return false;
      if (filterType !== 'all' && emp.employmentType !== filterType) return false;
      if (search && !emp.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [visibleBase, localData, filterActive, filterDept, filterType, search]);

  // ── Mitarbeiter auswählen ──────────────────────────────────────────────────
  const selectEmployee = (emp: Employee) => {
    setSelectedId(emp.id);
    setEditMode(false);
    setEditData({ ...emp });
    const local = getLocalEntry(localData, emp.id);
    setEditNotes(local.notes);
    setEditActive(local.active);
    setShowMobile('detail');
    setShowContractInfo(false);
  };

  const startEdit = () => {
    if (!canEditEmployees) return;
    setEditMode(true);
  };

  const cancelEdit = () => {
    if (!selectedId) return;
    const emp = employees.find(e => e.id === selectedId);
    if (emp) setEditData({ ...emp });
    const local = getLocalEntry(localData, selectedId);
    setEditNotes(local.notes);
    setEditActive(local.active);
    setEditMode(false);
  };

  // ── Neuer Mitarbeiter ──────────────────────────────────────────────────────
  const handleNew = () => {
    const newId = generateId(employees);
    const blank = emptyEmployee(newId);
    setEditData(blank);
    setSelectedId(newId);
    setEditNotes('');
    setEditActive(true);
    setEditMode(true);
    setShowMobile('detail');
  };

  // ── Speichern ──────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!editData) return;
    if (!editData.name.trim()) { toast.error('Name ist erforderlich'); return; }
    setSaving(true);
    const ok = await upsertEmployee(editData);
    if (ok) {
      // Mitarbeiter-Liste aktualisieren
      setEmployees(prev => {
        const idx = prev.findIndex(e => e.id === editData.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = editData;
          return next;
        }
        return [...prev, editData];
      });
      // Lokale Daten speichern
      const newLocal = { ...localData };
      newLocal[editData.id] = { active: editActive, notes: editNotes };
      setLocalData(newLocal);
      saveLocalData(newLocal);
      setSelectedId(editData.id);
      setEditMode(false);
      toast.success('Mitarbeiter gespeichert');
    } else {
      toast.error('Fehler beim Speichern');
    }
    setSaving(false);
  };

  // ── Löschen ────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteEmployee(deleteTarget.id);
    if (ok) {
      setEmployees(prev => prev.filter(e => e.id !== deleteTarget.id));
      if (selectedId === deleteTarget.id) {
        setSelectedId(null);
        setEditData(null);
        setShowMobile('list');
      }
      toast.success(`${deleteTarget.name} gelöscht`);
    } else {
      toast.error('Fehler beim Löschen');
    }
    setDeleteTarget(null);
  };

  // ── Aktiv/Inaktiv schnell umschalten (ohne Edit-Modus) ────────────────────
  const toggleActive = (emp: Employee, active: boolean) => {
    const newLocal = { ...localData };
    const entry = getLocalEntry(newLocal, emp.id);
    newLocal[emp.id] = { ...entry, active };
    setLocalData(newLocal);
    saveLocalData(newLocal);
    if (selectedId === emp.id) setEditActive(active);
    toast.success(active ? `${emp.name} aktiviert` : `${emp.name} deaktiviert`);
  };

  // ── Vertrag-Upload Platzhalter ─────────────────────────────────────────────
  const handleContractUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    // Zukunft: OCR-Verarbeitung hier
    const newLocal = { ...localData };
    const entry = getLocalEntry(newLocal, selectedId);
    newLocal[selectedId] = {
      ...entry,
      contractFileName: file.name,
      contract: { source: 'ocr' }, // wird später durch OCR-Daten ersetzt
    };
    setLocalData(newLocal);
    saveLocalData(newLocal);
    toast.info(`Vertrag "${file.name}" hinterlegt. Automatische Auswertung folgt in einer späteren Version.`);
    setShowContractInfo(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const selectedEmp   = employees.find(e => e.id === selectedId) ?? (editMode ? editData : null);
  const selectedLocal = selectedId ? getLocalEntry(localData, selectedId) : { active: true, notes: '' };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm flex-shrink-0">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">Dashboard</span>
              </Button>
            </Link>
            <span className="text-muted-foreground text-xs">/</span>
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <Users className="h-4 w-4 text-muted-foreground" />
              Personalstamm
            </h1>
            {isManager && (
              <Badge variant="outline" className={cn(
                'text-xs ml-1',
                allowedDepartment === 'service'
                  ? 'border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/20'
                  : 'border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/20',
              )}>
                {allowedDepartment === 'service' ? <Utensils className="h-3 w-3 mr-1" /> : <ChefHat className="h-3 w-3 mr-1" />}
                {DEPT_LABELS[allowedDepartment as Department]}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canEditEmployees && (
              <Button size="sm" onClick={handleNew} className="h-8">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Neuer Mitarbeiter
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Filter-Bar */}
      <div className="bg-card border-b border-border flex-shrink-0">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center gap-2">
          {/* Suche */}
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Name suchen…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Abteilung (nur Admin) */}
          {isAdmin && (
            <Select value={filterDept} onValueChange={v => setFilterDept(v as Department | 'all')}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue placeholder="Abteilung" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Abteilungen</SelectItem>
                <SelectItem value="service">Service</SelectItem>
                <SelectItem value="küche">Küche</SelectItem>
              </SelectContent>
            </Select>
          )}

          {/* Beschäftigungsart */}
          <Select value={filterType} onValueChange={v => setFilterType(v as EmploymentType | 'all')}>
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="Art" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Arten</SelectItem>
              <SelectItem value="vollzeit">Vollzeit</SelectItem>
              <SelectItem value="teilzeit">Teilzeit</SelectItem>
              <SelectItem value="minijob">Minijob</SelectItem>
              <SelectItem value="aushilfe">Aushilfe</SelectItem>
            </SelectContent>
          </Select>

          {/* Aktiv/Inaktiv */}
          <div className="flex rounded-md overflow-hidden border border-border">
            {(['active', 'all', 'inactive'] as const).map(v => (
              <button
                key={v}
                onClick={() => setFilterActive(v)}
                className={cn(
                  'px-3 py-1 text-xs font-semibold transition-colors',
                  filterActive === v
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground',
                )}
              >
                {v === 'active' ? 'Aktiv' : v === 'inactive' ? 'Inaktiv' : 'Alle'}
              </button>
            ))}
          </div>

          <span className="text-xs text-muted-foreground ml-auto">
            {filtered.length} von {visibleBase.length} Mitarbeiter
          </span>
        </div>
      </div>

      {/* Haupt-Layout: Liste + Detail */}
      <div className="flex-1 flex max-w-7xl w-full mx-auto overflow-hidden" style={{ minHeight: 0 }}>

        {/* ── Mitarbeiterliste ───────────────────────────────────────────────── */}
        <aside className={cn(
          'flex-shrink-0 border-r border-border bg-card overflow-y-auto',
          'w-full md:w-80 lg:w-96',
          showMobile === 'detail' ? 'hidden md:flex md:flex-col' : 'flex flex-col',
        )}>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Wird geladen…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center gap-2">
              <Users className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Keine Mitarbeiter gefunden</p>
              {canEditEmployees && (
                <Button variant="outline" size="sm" onClick={handleNew} className="mt-2">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Neuer Mitarbeiter
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map(emp => {
                const local  = getLocalEntry(localData, emp.id);
                const isSelected = selectedId === emp.id;
                return (
                  <li key={emp.id}>
                    <button
                      onClick={() => selectEmployee(emp)}
                      className={cn(
                        'w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors flex items-center gap-3',
                        isSelected && 'bg-primary/5 border-l-2 border-primary',
                        !local.active && 'opacity-50',
                      )}
                    >
                      {/* Avatar */}
                      <div className={cn(
                        'w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold',
                        emp.department === 'service'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/50'
                          : 'bg-orange-100 text-orange-700 dark:bg-orange-950/50',
                      )}>
                        {emp.name.charAt(0).toUpperCase()}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">{emp.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className={cn(
                            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                            DEPT_BADGE_COLOR[emp.department],
                          )}>
                            {DEPT_LABELS[emp.department]}
                          </span>
                          <span className={cn(
                            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                            TYPE_BADGE_COLOR[emp.employmentType],
                          )}>
                            {TYPE_LABELS[emp.employmentType]}
                          </span>
                          {!local.active && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border border-red-200 bg-red-50 text-red-600">
                              Inaktiv
                            </span>
                          )}
                          {selectedLocal.contractFileName && selectedId === emp.id && (
                            <FileText className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* ── Detailbereich ──────────────────────────────────────────────────── */}
        <main className={cn(
          'flex-1 overflow-y-auto bg-background',
          showMobile === 'list' ? 'hidden md:block' : 'block',
        )}>
          {!selectedId && !editData ? (
            <div className="flex flex-col items-center justify-center h-full py-20 px-6 text-center gap-3">
              <Users className="h-12 w-12 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                Mitarbeiter aus der Liste auswählen
              </p>
              {canEditEmployees && (
                <Button variant="outline" size="sm" onClick={handleNew}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Neuen Mitarbeiter anlegen
                </Button>
              )}
            </div>
          ) : (
            <div className="max-w-2xl mx-auto p-5 space-y-5 pb-20">

              {/* Mobile: zurück zur Liste */}
              <Button
                variant="ghost"
                size="sm"
                className="md:hidden -ml-1 mb-1"
                onClick={() => { setShowMobile('list'); setEditMode(false); }}
              >
                <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Zurück
              </Button>

              {/* Kopfzeile */}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-xl font-bold">
                    {editMode ? (editData?.name || 'Neuer Mitarbeiter') : (selectedEmp?.name || 'Unbekannt')}
                  </h2>
                  {!editMode && selectedEmp && (
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border',
                        DEPT_BADGE_COLOR[selectedEmp.department],
                      )}>
                        {DEPT_LABELS[selectedEmp.department]}
                      </span>
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border',
                        TYPE_BADGE_COLOR[selectedEmp.employmentType],
                      )}>
                        {TYPE_LABELS[selectedEmp.employmentType]}
                      </span>
                      {editActive ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border border-green-200 bg-green-50 text-green-700 dark:bg-green-950/20">
                          <CheckCircle2 className="h-3 w-3" /> Aktiv
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border border-red-200 bg-red-50 text-red-600">
                          <AlertTriangle className="h-3 w-3" /> Inaktiv
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Aktions-Buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  {!editMode && canEditEmployees && selectedId && (
                    <>
                      {editActive ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => selectedEmp && toggleActive(selectedEmp, false)}
                        >
                          Deaktivieren
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs text-green-600 border-green-200 hover:bg-green-50"
                          onClick={() => selectedEmp && toggleActive(selectedEmp, true)}
                        >
                          Aktivieren
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="h-8" onClick={startEdit}>
                        <Edit3 className="h-3.5 w-3.5 mr-1" /> Bearbeiten
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-red-600 border-red-200 hover:bg-red-50"
                        onClick={() => selectedEmp && setDeleteTarget(selectedEmp)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  {editMode && (
                    <>
                      <Button variant="outline" size="sm" className="h-8" onClick={cancelEdit} disabled={saving}>
                        Abbrechen
                      </Button>
                      <Button size="sm" className="h-8" onClick={handleSave} disabled={saving}>
                        <Save className="h-3.5 w-3.5 mr-1" />
                        {saving ? 'Speichern…' : 'Speichern'}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* ── Abschnitt 1: Allgemeine Infos ──────────────────────────── */}
              <Card>
                <CardHeader className="pb-3 pt-4">
                  <CardTitle className="text-sm">Allgemeine Informationen</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  {editMode ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Name *</Label>
                        <Input
                          value={editData?.name ?? ''}
                          onChange={e => setEditData(d => d ? { ...d, name: e.target.value } : d)}
                          placeholder="Vorname Nachname"
                          className="h-9 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Abteilung</Label>
                        <Select
                          value={editData?.department}
                          onValueChange={v => setEditData(d => d ? { ...d, department: v as Department } : d)}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="service">Service</SelectItem>
                            <SelectItem value="küche">Küche</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Beschäftigungsart</Label>
                        <Select
                          value={editData?.employmentType}
                          onValueChange={v => setEditData(d => d ? { ...d, employmentType: v as EmploymentType } : d)}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="vollzeit">Vollzeit</SelectItem>
                            <SelectItem value="teilzeit">Teilzeit</SelectItem>
                            <SelectItem value="minijob">Minijob</SelectItem>
                            <SelectItem value="aushilfe">Aushilfe</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Wochenstunden</Label>
                        <Input
                          type="number"
                          min="0" max="60" step="0.5"
                          value={editData?.weeklyHours ?? ''}
                          onChange={e => setEditData(d => d ? { ...d, weeklyHours: parseFloat(e.target.value) || undefined } : d)}
                          placeholder="z.B. 42"
                          className="h-9 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Ferientage pro Jahr</Label>
                        <Input
                          type="number"
                          min="0" max="50"
                          value={editData?.vacationDaysPerYear ?? ''}
                          onChange={e => setEditData(d => d ? { ...d, vacationDaysPerYear: parseInt(e.target.value) || undefined } : d)}
                          placeholder="z.B. 20"
                          className="h-9 text-sm"
                        />
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type="checkbox"
                          id="activeCheck"
                          checked={editActive}
                          onChange={e => setEditActive(e.target.checked)}
                          className="h-4 w-4 rounded border-input"
                        />
                        <Label htmlFor="activeCheck" className="text-sm cursor-pointer">
                          Mitarbeiter aktiv
                        </Label>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-y-2 text-sm">
                      <DataRow label="Name"           value={selectedEmp?.name} />
                      <DataRow label="Abteilung"      value={selectedEmp ? DEPT_LABELS[selectedEmp.department] : undefined} />
                      <DataRow label="Art"            value={selectedEmp ? TYPE_LABELS[selectedEmp.employmentType] : undefined} />
                      <DataRow label="Wochenstunden"  value={selectedEmp?.weeklyHours ? `${selectedEmp.weeklyHours} h` : '–'} />
                      <DataRow label="Ferientage/Jahr" value={selectedEmp?.vacationDaysPerYear ? `${selectedEmp.vacationDaysPerYear} Tage` : '–'} />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Abschnitt 2: Lohn & Kosten (nur Admin) ─────────────────── */}
              {isAdmin && (
                <Card>
                  <CardHeader className="pb-3 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      Lohn & Kosten
                      <span className="text-[10px] font-normal text-muted-foreground bg-purple-50 dark:bg-purple-950/20 border border-purple-200 px-1.5 py-0.5 rounded">
                        Nur Admin
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-0">
                    {editMode ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1 block">Stundenlohn (CHF)</Label>
                          <Input
                            type="number"
                            min="0" step="0.05"
                            value={editData?.hourlyWage ?? ''}
                            onChange={e => setEditData(d => d ? { ...d, hourlyWage: parseFloat(e.target.value) || 0 } : d)}
                            className="h-9 text-sm"
                          />
                        </div>
                        {(editData?.employmentType === 'vollzeit' || editData?.employmentType === 'teilzeit') && (
                          <>
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Monatslohn Basis (CHF)</Label>
                              <Input
                                type="number"
                                min="0"
                                value={editData?.monthlySalary ?? ''}
                                onChange={e => setEditData(d => d ? { ...d, monthlySalary: parseFloat(e.target.value) || undefined } : d)}
                                className="h-9 text-sm"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">Monatslohn inkl. 13. Monatslohn (CHF)</Label>
                              <Input
                                type="number"
                                min="0"
                                value={editData?.monthlySalaryWith13th ?? ''}
                                onChange={e => setEditData(d => d ? { ...d, monthlySalaryWith13th: parseFloat(e.target.value) || undefined } : d)}
                                className="h-9 text-sm"
                              />
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-y-2 text-sm">
                        <DataRow label="Stundenlohn" value={selectedEmp ? formatCHF(selectedEmp.hourlyWage) : '–'} />
                        {selectedEmp?.monthlySalary && (
                          <DataRow label="Monatslohn Basis" value={formatCHF(selectedEmp.monthlySalary)} />
                        )}
                        {selectedEmp?.monthlySalaryWith13th && (
                          <DataRow label="inkl. 13. Monatslohn" value={formatCHF(selectedEmp.monthlySalaryWith13th)} />
                        )}
                        {selectedEmp && (
                          <DataRow
                            label="Interner Stundenansatz"
                            value={
                              (() => {
                                const cost = calcInternalHourlyCost(selectedEmp);
                                return cost ? formatCHF(cost) : '–';
                              })()
                            }
                            highlight
                          />
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Abschnitt 3: Konten / Salden ──────────────────────────── */}
              <Card>
                <CardHeader className="pb-3 pt-4">
                  <CardTitle className="text-sm">Salden & Konten</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {editMode ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Stundensaldo (h)</Label>
                        <Input
                          type="number"
                          step="0.25"
                          value={editData?.hoursBalance ?? ''}
                          onChange={e => setEditData(d => d ? { ...d, hoursBalance: parseFloat(e.target.value) || undefined } : d)}
                          placeholder="0.0"
                          className="h-9 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground mb-1 block">Feriensaldo (Tage)</Label>
                        <Input
                          type="number"
                          step="0.5"
                          value={editData?.vacationBalance ?? ''}
                          onChange={e => setEditData(d => d ? { ...d, vacationBalance: parseFloat(e.target.value) || undefined } : d)}
                          placeholder="0.0"
                          className="h-9 text-sm"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-y-2 text-sm">
                      <DataRow
                        label="Stundensaldo"
                        value={selectedEmp?.hoursBalance !== undefined
                          ? `${selectedEmp.hoursBalance >= 0 ? '+' : ''}${selectedEmp.hoursBalance.toFixed(1)} h`
                          : '–'
                        }
                        valueColor={
                          selectedEmp?.hoursBalance
                            ? selectedEmp.hoursBalance > 0 ? 'text-green-600' : 'text-red-600'
                            : undefined
                        }
                      />
                      <DataRow
                        label="Feriensaldo"
                        value={selectedEmp?.vacationBalance !== undefined
                          ? `${selectedEmp.vacationBalance.toFixed(1)} Tage`
                          : '–'
                        }
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Abschnitt 4: Notizen ──────────────────────────────────── */}
              <Card>
                <CardHeader className="pb-3 pt-4">
                  <CardTitle className="text-sm">Notizen</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {editMode || canEditEmployees ? (
                    <Textarea
                      value={editNotes}
                      onChange={e => setEditNotes(e.target.value)}
                      placeholder="Interne Notizen zu diesem Mitarbeiter…"
                      className="text-sm min-h-[80px] resize-none"
                      readOnly={!editMode && !canEditEmployees}
                      onBlur={() => {
                        // Notizen auch ohne Bearbeitungsmodus speichern
                        if (!editMode && selectedId) {
                          const newLocal = { ...localData };
                          const entry = getLocalEntry(newLocal, selectedId);
                          newLocal[selectedId] = { ...entry, notes: editNotes };
                          setLocalData(newLocal);
                          saveLocalData(newLocal);
                        }
                      }}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      {selectedLocal.notes || 'Keine Notizen vorhanden'}
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* ── Abschnitt 5: Arbeitsvertrag (Platzhalter) ─────────────── */}
              <Card className="border-dashed border-2 border-muted-foreground/20">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                    <FileText className="h-4 w-4" />
                    Arbeitsvertrag
                    <span className="text-[10px] bg-amber-50 dark:bg-amber-950/20 border border-amber-200 text-amber-700 px-1.5 py-0.5 rounded font-normal">
                      Automatisierung geplant
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {selectedLocal.contractFileName ? (
                    <div className="flex items-center gap-2 rounded-md bg-muted/40 border border-border px-3 py-2">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm text-muted-foreground flex-1 truncate">{selectedLocal.contractFileName}</span>
                      {canEditEmployees && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Ersetzen
                        </Button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Noch kein Vertrag hinterlegt.</p>
                  )}

                  {canEditEmployees && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs w-full border-dashed"
                        onClick={() => {
                          if (!showContractInfo) {
                            fileInputRef.current?.click();
                          }
                          setShowContractInfo(!showContractInfo);
                        }}
                      >
                        <Upload className="h-3.5 w-3.5 mr-1.5" />
                        Arbeitsvertrag hochladen
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        className="hidden"
                        onChange={handleContractUpload}
                      />
                    </>
                  )}

                  {/* Erklärung zur geplanten Funktion */}
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                    <p className="font-semibold">Was wird später automatisch erkannt?</p>
                    <ul className="list-disc list-inside space-y-0.5 text-amber-700 dark:text-amber-400">
                      <li>Name & Abteilung</li>
                      <li>Beschäftigungsart & Wochenstunden</li>
                      <li>Eintrittsdatum & Vertragsende</li>
                      <li>Vereinbarter Lohn</li>
                      <li>Ferientage pro Jahr</li>
                    </ul>
                    <p className="text-[11px] mt-1 text-amber-600 dark:text-amber-500">
                      Alle Felder bleiben danach manuell bearbeitbar.
                    </p>
                  </div>
                </CardContent>
              </Card>

            </div>
          )}
        </main>
      </div>

      {/* Löschen-Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mitarbeiter löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> wird dauerhaft aus der Datenbank entfernt.
              Der Dienstplan-Verlauf bleibt erhalten, kann aber diesem Mitarbeiter nicht mehr zugeordnet werden.
              Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// ─── Hilfs-Komponente: Datenwert-Zeile ───────────────────────────────────────

interface DataRowProps {
  label: string;
  value?: string;
  highlight?: boolean;
  valueColor?: string;
}

const DataRow = ({ label, value, highlight, valueColor }: DataRowProps) => (
  <>
    <span className="text-muted-foreground text-xs">{label}</span>
    <span className={cn(
      'text-sm font-medium',
      highlight && 'font-bold text-primary',
      valueColor,
    )}>
      {value ?? '–'}
    </span>
  </>
);

export default Personalstamm;
