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
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Info, Calculator, Clipboard, UserCheck, ChevronDown,
  Building, Phone, Mail, MapPin, CreditCard, Shield,
  Briefcase, Calendar, Clock, Link as LinkIcon,
} from 'lucide-react';
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

// ─── Erweiterte HR-Strukturen (alle lokal / localStorage) ────────────────────

/** Persönliche Daten für Onboarding-Vorbereitung */
interface PersonalInfo {
  birthDate?:     string;
  phone?:         string;
  email?:         string;
  addressStreet?: string;
  addressZip?:    string;
  addressCity?:   string;
  nationality?:   string;
  ahvNumber?:     string;   // AHV-Nummer
  iban?:          string;   // Für Lohnzahlung
}

/** Vertragliche Grundlagen (Architektur für spätere Vertragsgenerierung) */
interface ContractFoundation {
  contractType?:        'monthly' | 'hourly' | 'irregular';
  positionTitle?:       string;
  contractStart?:       string;  // ISO-Datum
  contractEnd?:         string;  // ISO-Datum (leer wenn unbefristet)
  isLimited?:           boolean;
  noticePeriodWeeks?:   number;  // Kündigungsfrist in Wochen
  trialPeriodMonths?:   number;  // Probezeit in Monaten
  probationEndDate?:    string;  // berechnet aus Eintrittsdatum + Probezeit
}

/** Onboarding-Vorbereitung (Status + Token für spätere Self-Service-Links) */
interface OnboardingPrep {
  status:       'none' | 'prepared' | 'sent' | 'completed';
  token?:       string;   // Eindeutiger Link-Token (UUID)
  sentAt?:      string;
  completedAt?: string;
  notes?:       string;
}

/** Erweiterte Lohn-/Kostendaten (lokal) */
interface SalaryExtension {
  has13thSalary?:       boolean;  // 13. Monatslohn?
  socialCostFactor?:    number;   // AG-Anteil Sozialkosten (z.B. 1.13 = 13%)
}

/** Lokal gespeicherte Felder (kein DB-Spalte nötig) */
interface LocalEmployeeData {
  active:              boolean;
  notes:               string;
  contract?:           ContractFields;
  contractFileName?:   string;
  // Neue Felder:
  personalInfo?:       PersonalInfo;
  contractFoundation?: ContractFoundation;
  onboarding?:         OnboardingPrep;
  salaryExt?:          SalaryExtension;
}

// ─── Standardwerte ────────────────────────────────────────────────────────────

const DEFAULT_SOCIAL_COST_FACTOR = 1.13; // 13% AG-Anteil (Schweizer Durchschnitt)

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

/** Vollständige Lohnkostenberechnung inkl. Sozialkosten */
interface SalaryCosts {
  mode:            'monthly' | 'hourly' | 'none';
  grossMonthly:    number | null;   // Brutto-Monatslohn (inkl. 13. wenn aktiv)
  annualGross:     number | null;   // Jahresbrutto
  socialFactor:    number;          // z.B. 1.13
  socialCostMonthly: number | null; // AG-Sozialkosten pro Monat
  totalAnnual:     number | null;   // Jahresvollkosten (Brutto * Faktor)
  internalHourly:  number | null;   // Interner Stundenansatz (für Dienstplan)
}

function calcSalaryCosts(emp: Employee, salaryExt?: SalaryExtension): SalaryCosts {
  const factor   = salaryExt?.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR;
  const has13th  = salaryExt?.has13thSalary ?? false;

  // Monatslohn-Basis-MA (Vollzeit / Teilzeit)
  if (emp.monthlySalary && emp.monthlySalary > 0 && emp.weeklyHours && emp.weeklyHours > 0) {
    // Monatslohn inkl. 13. Monatslohn (1/12 pro Monat)
    const grossMonthly = has13th
      ? emp.monthlySalary * (13 / 12)
      : (emp.monthlySalaryWith13th ?? emp.monthlySalary);
    const annualGross       = grossMonthly * 12;
    const totalAnnual       = annualGross * factor;
    const socialCostMonthly = grossMonthly * (factor - 1);
    const internalHourly    = totalAnnual / (emp.weeklyHours * 52);
    return { mode: 'monthly', grossMonthly, annualGross, socialFactor: factor, socialCostMonthly, totalAnnual, internalHourly };
  }

  // Stundenlohn-MA
  if (emp.hourlyWage > 0) {
    const internalHourly    = emp.hourlyWage * factor;
    const socialCostHourly  = emp.hourlyWage * (factor - 1);
    return {
      mode: 'hourly',
      grossMonthly: null,
      annualGross:  null,
      socialFactor: factor,
      socialCostMonthly: socialCostHourly,
      totalAnnual: null,
      internalHourly,
    };
  }

  return { mode: 'none', grossMonthly: null, annualGross: null, socialFactor: factor, socialCostMonthly: null, totalAnnual: null, internalHourly: null };
}

/** @deprecated Verwende calcSalaryCosts */
function calcInternalHourlyCost(emp: Employee): number | null {
  return calcSalaryCosts(emp).internalHourly;
}

/** UUID v4 einfach generieren (für Onboarding-Token) */
function generateToken(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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

  // ── Erweiterte HR-Daten (State) ────────────────────────────────────────────
  const [editPersonal,   setEditPersonal]   = useState<PersonalInfo>({});
  const [editContractF,  setEditContractF]  = useState<ContractFoundation>({});
  const [editSalaryExt,  setEditSalaryExt]  = useState<SalaryExtension>({ socialCostFactor: DEFAULT_SOCIAL_COST_FACTOR });
  const [editOnboarding, setEditOnboarding] = useState<OnboardingPrep>({ status: 'none' });

  // ── UI-Abschnitte aufklappbar ──────────────────────────────────────────────
  const [openPersonal,  setOpenPersonal]  = useState(false);
  const [openContractF, setOpenContractF] = useState(false);
  const [openOnboarding, setOpenOnboarding] = useState(false);

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
    // Neue HR-Felder aus localStorage laden
    setEditPersonal(local.personalInfo ?? {});
    setEditContractF(local.contractFoundation ?? {});
    setEditSalaryExt(local.salaryExt ?? { socialCostFactor: DEFAULT_SOCIAL_COST_FACTOR });
    setEditOnboarding(local.onboarding ?? { status: 'none' });
    setShowMobile('detail');
    setShowContractInfo(false);
    setOpenPersonal(false);
    setOpenContractF(false);
    setOpenOnboarding(false);
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
    setEditPersonal(local.personalInfo ?? {});
    setEditContractF(local.contractFoundation ?? {});
    setEditSalaryExt(local.salaryExt ?? { socialCostFactor: DEFAULT_SOCIAL_COST_FACTOR });
    setEditOnboarding(local.onboarding ?? { status: 'none' });
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
    setEditPersonal({});
    setEditContractF({});
    setEditSalaryExt({ socialCostFactor: DEFAULT_SOCIAL_COST_FACTOR });
    setEditOnboarding({ status: 'none' });
    setEditMode(true);
    setShowMobile('detail');
    setOpenPersonal(false);
    setOpenContractF(false);
    setOpenOnboarding(false);
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
      // Lokale Daten speichern (inkl. neuer HR-Felder)
      const newLocal = { ...localData };
      const prevLocal = getLocalEntry(newLocal, editData.id);
      newLocal[editData.id] = {
        ...prevLocal,
        active:              editActive,
        notes:               editNotes,
        personalInfo:        Object.keys(editPersonal).length  > 0 ? editPersonal  : undefined,
        contractFoundation:  Object.keys(editContractF).length > 0 ? editContractF : undefined,
        salaryExt:           editSalaryExt,
        onboarding:          editOnboarding,
      };
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
                <Card className="border-purple-200/50 dark:border-purple-800/30">
                  <CardHeader className="pb-3 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Calculator className="h-4 w-4 text-purple-600" />
                      Lohn & Kosten
                      <span className="text-[10px] font-normal text-muted-foreground bg-purple-50 dark:bg-purple-950/20 border border-purple-200 px-1.5 py-0.5 rounded">
                        Nur Admin
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-0">
                    {editMode ? (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">
                              Stundenlohn brutto (CHF)
                              <span className="ml-1 text-[10px] italic opacity-60">für Aushilfen / stundenweise</span>
                            </Label>
                            <Input
                              type="number" min="0" step="0.05"
                              value={editData?.hourlyWage || ''}
                              onChange={e => setEditData(d => d ? { ...d, hourlyWage: parseFloat(e.target.value) || 0 } : d)}
                              placeholder="z.B. 23.50"
                              className="h-9 text-sm"
                            />
                          </div>
                          {(editData?.employmentType === 'vollzeit' || editData?.employmentType === 'teilzeit') && (
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">
                                Monatslohn brutto Basis (CHF)
                                <span className="ml-1 text-[10px] italic opacity-60">ohne 13. Monatslohn</span>
                              </Label>
                              <Input
                                type="number" min="0"
                                value={editData?.monthlySalary ?? ''}
                                onChange={e => setEditData(d => d ? { ...d, monthlySalary: parseFloat(e.target.value) || undefined } : d)}
                                placeholder="z.B. 4800"
                                className="h-9 text-sm"
                              />
                            </div>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-2 block">13. Monatslohn</Label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editSalaryExt.has13thSalary ?? false}
                                onChange={e => setEditSalaryExt(s => ({ ...s, has13thSalary: e.target.checked }))}
                                className="h-4 w-4 rounded"
                              />
                              <span className="text-sm">Ja – 13. Monatslohn vereinbart</span>
                            </label>
                            {editSalaryExt.has13thSalary && editData?.monthlySalary && (
                              <p className="text-[11px] text-muted-foreground mt-1 ml-6">
                                ≈ {formatCHF(editData.monthlySalary * 13 / 12)}/Mt. effektiv
                              </p>
                            )}
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">
                              AG-Sozialkostenfaktor
                              <span className="ml-1 text-[10px] italic opacity-60">z.B. 1.13 = 13%</span>
                            </Label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number" min="1.00" max="1.40" step="0.01"
                                value={editSalaryExt.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR}
                                onChange={e => setEditSalaryExt(s => ({ ...s, socialCostFactor: parseFloat(e.target.value) || DEFAULT_SOCIAL_COST_FACTOR }))}
                                className="h-9 text-sm w-24"
                              />
                              <span className="text-xs text-muted-foreground">
                                = {(((editSalaryExt.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR) - 1) * 100).toFixed(1)}% AG
                              </span>
                            </div>
                          </div>
                        </div>

                        {editData && (() => {
                          const costs = calcSalaryCosts(editData, editSalaryExt);
                          if (costs.mode === 'none') return null;
                          return (
                            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 p-3 space-y-1.5 text-xs">
                              <p className="font-semibold text-purple-800 dark:text-purple-300 flex items-center gap-1">
                                <Calculator className="h-3 w-3" /> Berechnungsvorschau
                              </p>
                              {costs.mode === 'monthly' && costs.grossMonthly && (
                                <>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Brutto/Monat (effektiv)</span><span className="font-medium">{formatCHF(costs.grossMonthly)}</span></div>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">AG-Sozialkosten/Monat</span><span className="font-medium">{costs.socialCostMonthly ? formatCHF(costs.socialCostMonthly) : '–'}</span></div>
                                  <Separator className="my-1 bg-purple-200" />
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Jahresvollkosten</span><span className="font-semibold">{costs.totalAnnual ? formatCHF(costs.totalAnnual) : '–'}</span></div>
                                </>
                              )}
                              {costs.mode === 'hourly' && (
                                <>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Stundenlohn brutto</span><span className="font-medium">{formatCHF(editData.hourlyWage)}</span></div>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">AG-Sozialkosten/h</span><span className="font-medium">{costs.socialCostMonthly ? formatCHF(costs.socialCostMonthly) : '–'}</span></div>
                                  <Separator className="my-1 bg-purple-200" />
                                </>
                              )}
                              <div className="flex justify-between items-center">
                                <span className="font-bold text-purple-800 dark:text-purple-300">Interner Stundenansatz</span>
                                <span className="font-bold text-purple-800 dark:text-purple-300">{costs.internalHourly ? formatCHF(costs.internalHourly) : '–'}</span>
                              </div>
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      (() => {
                        const empForCost = selectedEmp ?? editData;
                        if (!empForCost) return null;
                        const salExt = selectedId ? localData[selectedId]?.salaryExt : editSalaryExt;
                        const costs = calcSalaryCosts(empForCost, salExt);
                        return (
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-y-2 text-sm">
                              {costs.mode === 'monthly' && costs.grossMonthly && (
                                <>
                                  <DataRow label="Brutto/Monat (effektiv)" value={formatCHF(costs.grossMonthly)} />
                                  <DataRow label="13. Monatslohn" value={salExt?.has13thSalary ? 'Ja' : 'Nein'} />
                                </>
                              )}
                              {costs.mode === 'hourly' && (
                                <DataRow label="Stundenlohn brutto" value={formatCHF(empForCost.hourlyWage)} />
                              )}
                              <DataRow
                                label="AG-Sozialkostenfaktor"
                                value={`${costs.socialFactor.toFixed(2)} (${((costs.socialFactor - 1) * 100).toFixed(1)}%)`}
                              />
                            </div>
                            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 p-3 space-y-1.5 text-xs">
                              <p className="font-semibold text-purple-800 dark:text-purple-300 flex items-center gap-1 mb-2">
                                <Calculator className="h-3 w-3" /> Vollkostenrechnung
                              </p>
                              {costs.mode === 'monthly' && costs.grossMonthly && (
                                <>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Brutto/Monat</span><span className="font-medium">{formatCHF(costs.grossMonthly)}</span></div>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">AG-Sozialkosten/Monat</span><span className="font-medium text-red-600">{costs.socialCostMonthly ? `+ ${formatCHF(costs.socialCostMonthly)}` : '–'}</span></div>
                                  <Separator className="my-1.5 bg-purple-200" />
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Jahresvollkosten</span><span className="font-semibold">{costs.totalAnnual ? formatCHF(costs.totalAnnual) : '–'}</span></div>
                                </>
                              )}
                              {costs.mode === 'hourly' && (
                                <>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">Stundenlohn brutto</span><span className="font-medium">{formatCHF(empForCost.hourlyWage)}</span></div>
                                  <div className="flex justify-between"><span className="text-purple-700 dark:text-purple-400">AG-Sozialkosten/h</span><span className="font-medium text-red-600">{costs.socialCostMonthly ? `+ ${formatCHF(costs.socialCostMonthly)}` : '–'}</span></div>
                                  <Separator className="my-1.5 bg-purple-200" />
                                </>
                              )}
                              <div className="flex justify-between items-center">
                                <span className="font-bold text-purple-800 dark:text-purple-300">Interner Stundenansatz</span>
                                <span className="font-bold text-purple-800 dark:text-purple-300 text-sm">{costs.internalHourly ? formatCHF(costs.internalHourly) : '–'}</span>
                              </div>
                              {costs.mode === 'monthly' && empForCost.weeklyHours && (
                                <p className="text-[10px] text-purple-600 italic mt-1">
                                  = Jahresvollkosten ÷ {empForCost.weeklyHours} h/W ÷ 52 Wochen
                                </p>
                              )}
                              {costs.mode === 'hourly' && (
                                <p className="text-[10px] text-purple-600 italic mt-1">
                                  = Stundenlohn × Sozialkostenfaktor ({costs.socialFactor.toFixed(2)})
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })()
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

              {/* ── Abschnitt 5: Persönliche Daten & Kontakt (Admin) ─────── */}
              {isAdmin && (
                <Card>
                  <CardHeader
                    className="pb-2 pt-4 cursor-pointer select-none"
                    onClick={() => setOpenPersonal(o => !o)}
                  >
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <UserCheck className="h-4 w-4 text-emerald-600" />
                        Persönliche Daten & Kontakt
                        <span className="text-[10px] font-normal text-muted-foreground bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 px-1.5 py-0.5 rounded">
                          Onboarding-Vorbereitung
                        </span>
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', openPersonal && 'rotate-180')} />
                    </CardTitle>
                  </CardHeader>
                  {openPersonal && (
                    <CardContent className="space-y-3 pt-0">
                      <Alert className="text-xs py-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20">
                        <Info className="h-3.5 w-3.5 text-emerald-600" />
                        <AlertDescription className="text-emerald-700 dark:text-emerald-400">
                          Diese Felder werden später für das Self-Onboarding des Mitarbeiters und die automatische Vertragsgenerierung verwendet.
                        </AlertDescription>
                      </Alert>
                      {editMode ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Calendar className="h-3 w-3" /> Geburtsdatum
                            </Label>
                            <Input type="date" className="h-9 text-sm"
                              value={editPersonal.birthDate ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, birthDate: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Shield className="h-3 w-3" /> Nationalität
                            </Label>
                            <Input className="h-9 text-sm" placeholder="z.B. Schweiz"
                              value={editPersonal.nationality ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, nationality: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Phone className="h-3 w-3" /> Telefon
                            </Label>
                            <Input className="h-9 text-sm" placeholder="+41 79 …"
                              value={editPersonal.phone ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, phone: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Mail className="h-3 w-3" /> E-Mail
                            </Label>
                            <Input type="email" className="h-9 text-sm" placeholder="name@beispiel.ch"
                              value={editPersonal.email ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, email: e.target.value || undefined }))} />
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> Strasse & Hausnummer
                            </Label>
                            <Input className="h-9 text-sm" placeholder="Musterstrasse 1"
                              value={editPersonal.addressStreet ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, addressStreet: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">PLZ</Label>
                            <Input className="h-9 text-sm" placeholder="3000"
                              value={editPersonal.addressZip ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, addressZip: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Ort</Label>
                            <Input className="h-9 text-sm" placeholder="Bern"
                              value={editPersonal.addressCity ?? ''}
                              onChange={e => setEditPersonal(p => ({ ...p, addressCity: e.target.value || undefined }))} />
                          </div>
                          {isAdmin && (
                            <>
                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                                  <Shield className="h-3 w-3" /> AHV-Nummer
                                  <span className="ml-1 text-[10px] opacity-60">vertraulich</span>
                                </Label>
                                <Input className="h-9 text-sm font-mono" placeholder="756.XXXX.XXXX.XX"
                                  value={editPersonal.ahvNumber ?? ''}
                                  onChange={e => setEditPersonal(p => ({ ...p, ahvNumber: e.target.value || undefined }))} />
                              </div>
                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                                  <CreditCard className="h-3 w-3" /> IBAN (Lohnkonto)
                                  <span className="ml-1 text-[10px] opacity-60">vertraulich</span>
                                </Label>
                                <Input className="h-9 text-sm font-mono" placeholder="CH56 …"
                                  value={editPersonal.iban ?? ''}
                                  onChange={e => setEditPersonal(p => ({ ...p, iban: e.target.value || undefined }))} />
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          {editPersonal.birthDate    && <DataRow label="Geburtsdatum"  value={editPersonal.birthDate} />}
                          {editPersonal.nationality  && <DataRow label="Nationalität"  value={editPersonal.nationality} />}
                          {editPersonal.phone        && <DataRow label="Telefon"       value={editPersonal.phone} />}
                          {editPersonal.email        && <DataRow label="E-Mail"        value={editPersonal.email} />}
                          {editPersonal.addressStreet && (
                            <DataRow label="Adresse" value={`${editPersonal.addressStreet}, ${editPersonal.addressZip ?? ''} ${editPersonal.addressCity ?? ''}`} />
                          )}
                          {isAdmin && editPersonal.ahvNumber && (
                            <DataRow label="AHV-Nummer" value={editPersonal.ahvNumber} />
                          )}
                          {isAdmin && editPersonal.iban && (
                            <DataRow label="IBAN" value={`****${editPersonal.iban.slice(-4)}`} />
                          )}
                          {!editPersonal.phone && !editPersonal.email && !editPersonal.birthDate && (
                            <p className="col-span-2 text-xs text-muted-foreground italic">Noch keine persönlichen Daten erfasst. Im Bearbeitungsmodus ergänzen.</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              )}

              {/* ── Abschnitt 6: Vertragliche Grundlagen (Admin) ─────────────── */}
              {isAdmin && (
                <Card>
                  <CardHeader
                    className="pb-2 pt-4 cursor-pointer select-none"
                    onClick={() => setOpenContractF(o => !o)}
                  >
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Briefcase className="h-4 w-4 text-blue-600" />
                        Vertragliche Grundlagen
                        <span className="text-[10px] font-normal text-muted-foreground bg-blue-50 dark:bg-blue-950/20 border border-blue-200 px-1.5 py-0.5 rounded">
                          Vorbereitung Vertragsgenerierung
                        </span>
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', openContractF && 'rotate-180')} />
                    </CardTitle>
                  </CardHeader>
                  {openContractF && (
                    <CardContent className="space-y-3 pt-0">
                      <Alert className="text-xs py-2 border-blue-200 bg-blue-50 dark:bg-blue-950/20">
                        <Info className="h-3.5 w-3.5 text-blue-600" />
                        <AlertDescription className="text-blue-700 dark:text-blue-400">
                          Diese Felder bilden die Grundlage für die spätere automatische Vertragsgenerierung.
                          Noch keine automatische Erzeugung — die Architektur wird hier vorbereitet.
                        </AlertDescription>
                      </Alert>
                      {editMode ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Vertragsart</Label>
                            <Select
                              value={editContractF.contractType ?? ''}
                              onValueChange={v => setEditContractF(c => ({ ...c, contractType: v as ContractFoundation['contractType'] || undefined }))}
                            >
                              <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="monthly">Monatslohn-Vertrag (Festanstellung)</SelectItem>
                                <SelectItem value="hourly">Stundenlohn-Vertrag (Pensum variabel)</SelectItem>
                                <SelectItem value="irregular">Aushilfe / unregelmässig</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Briefcase className="h-3 w-3" /> Stellenbezeichnung
                            </Label>
                            <Input className="h-9 text-sm" placeholder="z.B. Servicemitarbeiter"
                              value={editContractF.positionTitle ?? ''}
                              onChange={e => setEditContractF(c => ({ ...c, positionTitle: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Calendar className="h-3 w-3" /> Eintrittsdatum
                            </Label>
                            <Input type="date" className="h-9 text-sm"
                              value={editContractF.contractStart ?? ''}
                              onChange={e => setEditContractF(c => ({ ...c, contractStart: e.target.value || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-2 block">Befristeter Vertrag</Label>
                            <label className="flex items-center gap-2 cursor-pointer mb-1">
                              <input type="checkbox"
                                checked={editContractF.isLimited ?? false}
                                onChange={e => setEditContractF(c => ({ ...c, isLimited: e.target.checked }))}
                                className="h-4 w-4 rounded" />
                              <span className="text-sm">Ja – Vertrag ist befristet</span>
                            </label>
                            {editContractF.isLimited && (
                              <Input type="date" className="h-9 text-sm mt-1"
                                value={editContractF.contractEnd ?? ''}
                                onChange={e => setEditContractF(c => ({ ...c, contractEnd: e.target.value || undefined }))} />
                            )}
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Clock className="h-3 w-3" /> Probezeit (Monate)
                            </Label>
                            <Input type="number" min="0" max="12" className="h-9 text-sm"
                              placeholder="z.B. 3"
                              value={editContractF.trialPeriodMonths ?? ''}
                              onChange={e => setEditContractF(c => ({ ...c, trialPeriodMonths: parseInt(e.target.value) || undefined }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Clock className="h-3 w-3" /> Kündigungsfrist (Wochen)
                            </Label>
                            <Input type="number" min="0" max="52" className="h-9 text-sm"
                              placeholder="z.B. 4"
                              value={editContractF.noticePeriodWeeks ?? ''}
                              onChange={e => setEditContractF(c => ({ ...c, noticePeriodWeeks: parseInt(e.target.value) || undefined }))} />
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          {editContractF.contractType   && <DataRow label="Vertragsart"       value={editContractF.contractType === 'monthly' ? 'Monatslohn-Vertrag' : editContractF.contractType === 'hourly' ? 'Stundenlohn-Vertrag' : 'Aushilfe'} />}
                          {editContractF.positionTitle  && <DataRow label="Stellenbezeichnung" value={editContractF.positionTitle} />}
                          {editContractF.contractStart  && <DataRow label="Eintritt"           value={editContractF.contractStart} />}
                          {editContractF.isLimited && editContractF.contractEnd && <DataRow label="Austritt (befristet)" value={editContractF.contractEnd} />}
                          {editContractF.trialPeriodMonths  && <DataRow label="Probezeit"         value={`${editContractF.trialPeriodMonths} Monate`} />}
                          {editContractF.noticePeriodWeeks  && <DataRow label="Kündigungsfrist"   value={`${editContractF.noticePeriodWeeks} Wochen`} />}
                          {!editContractF.contractType && !editContractF.contractStart && (
                            <p className="col-span-2 text-xs text-muted-foreground italic">Noch keine Vertragsdaten erfasst. Im Bearbeitungsmodus ergänzen.</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              )}

              {/* ── Abschnitt 7: Onboarding-Vorbereitung (Admin) ─────────────── */}
              {isAdmin && (
                <Card>
                  <CardHeader
                    className="pb-2 pt-4 cursor-pointer select-none"
                    onClick={() => setOpenOnboarding(o => !o)}
                  >
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Clipboard className="h-4 w-4 text-amber-600" />
                        Onboarding-Vorbereitung
                        {editOnboarding.status !== 'none' && editOnboarding.status !== 'completed' && (
                          <Badge className="text-[10px] bg-amber-100 text-amber-800 border-amber-200 font-medium">
                            {editOnboarding.status === 'prepared' ? 'Vorbereitet' : 'Link versendet'}
                          </Badge>
                        )}
                        {editOnboarding.status === 'completed' && (
                          <Badge className="text-[10px] bg-green-100 text-green-800 border-green-200 font-medium">
                            Abgeschlossen
                          </Badge>
                        )}
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', openOnboarding && 'rotate-180')} />
                    </CardTitle>
                  </CardHeader>
                  {openOnboarding && (
                    <CardContent className="space-y-3 pt-0">
                      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2 text-xs text-amber-800 dark:text-amber-300">
                        <p className="font-semibold flex items-center gap-1">
                          <Info className="h-3.5 w-3.5" /> Was ist das Onboarding-System?
                        </p>
                        <p className="leading-relaxed">
                          Hier wird die Grundlage für den späteren Self-Service-Onboarding-Link vorbereitet.
                          Der Mitarbeiter erhält einen persönlichen Link, über den er seine eigenen Stammdaten
                          (Adresse, IBAN, AHV-Nummer, etc.) selbst erfasst.
                          Damit entfällt die manuelle Dateneingabe durch die Administration.
                        </p>
                        <div className="mt-2 space-y-0.5">
                          <p className="font-semibold">Was der Mitarbeiter später selbst ausfüllen kann:</p>
                          <ul className="list-disc list-inside space-y-0.5 text-amber-700 dark:text-amber-400">
                            <li>Persönliche Daten (Adresse, Geburtsdatum, Nationalität)</li>
                            <li>Kontaktdaten (Telefon, E-Mail)</li>
                            <li>Bankverbindung (IBAN)</li>
                            <li>AHV-Nummer</li>
                            <li>Notfall-Kontakt</li>
                            <li>Bestätigung der Vertragsbedingungen</li>
                          </ul>
                        </div>
                      </div>

                      {/* Status-Steuerung */}
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Onboarding-Status</Label>
                        <div className="flex flex-wrap gap-2">
                          {(['none', 'prepared', 'sent', 'completed'] as const).map(s => (
                            <button key={s}
                              onClick={() => {
                                const next: OnboardingPrep = { ...editOnboarding, status: s };
                                if (s === 'prepared' && !next.token) {
                                  next.token = generateToken();
                                }
                                setEditOnboarding(next);
                                // Sofort in localStorage speichern
                                if (selectedId) {
                                  const newLocal = { ...localData };
                                  const entry = getLocalEntry(newLocal, selectedId);
                                  newLocal[selectedId] = { ...entry, onboarding: next };
                                  setLocalData(newLocal);
                                  saveLocalData(newLocal);
                                }
                              }}
                              className={cn(
                                'px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors',
                                editOnboarding.status === s
                                  ? 'bg-amber-600 text-white border-amber-700'
                                  : 'bg-white dark:bg-gray-900 border-border text-muted-foreground hover:bg-muted',
                              )}
                            >
                              {s === 'none' ? '–' : s === 'prepared' ? 'Vorbereitet' : s === 'sent' ? 'Link versendet' : 'Abgeschlossen'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Token anzeigen wenn vorbereitet */}
                      {editOnboarding.status !== 'none' && editOnboarding.token && (
                        <div className="rounded-md border border-border bg-muted/40 p-3 space-y-1.5">
                          <p className="text-xs font-semibold flex items-center gap-1">
                            <LinkIcon className="h-3.5 w-3.5" /> Onboarding-Token (für späteren Link)
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1 flex-1 truncate">
                              {editOnboarding.token}
                            </code>
                            <Button variant="outline" size="sm" className="h-7 text-xs"
                              onClick={() => {
                                navigator.clipboard.writeText(editOnboarding.token ?? '');
                                toast.success('Token kopiert');
                              }}>
                              Kopieren
                            </Button>
                          </div>
                          <p className="text-[10px] text-muted-foreground italic">
                            Dieser Token wird später für den personalisierten Self-Onboarding-Link verwendet.
                            Noch kein aktiver Link — die E-Mail-Versand-Funktion folgt in einer nächsten Version.
                          </p>
                        </div>
                      )}

                      {editOnboarding.status === 'none' && (
                        <Button variant="outline" size="sm" className="h-8 gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50"
                          onClick={() => {
                            const next: OnboardingPrep = { status: 'prepared', token: generateToken() };
                            setEditOnboarding(next);
                            if (selectedId) {
                              const newLocal = { ...localData };
                              const entry = getLocalEntry(newLocal, selectedId);
                              newLocal[selectedId] = { ...entry, onboarding: next };
                              setLocalData(newLocal);
                              saveLocalData(newLocal);
                            }
                            toast.success('Onboarding-Token erstellt');
                          }}>
                          <Clipboard className="h-3.5 w-3.5" />
                          Onboarding vorbereiten
                        </Button>
                      )}
                    </CardContent>
                  )}
                </Card>
              )}

              {/* ── Abschnitt 8: Arbeitsvertrag (Platzhalter) ─────────────── */}
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
