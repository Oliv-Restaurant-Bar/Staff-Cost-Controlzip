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
  Info, Calculator, UserCheck, ChevronDown,
  Building, Phone, Mail, MapPin, CreditCard, Shield,
  Briefcase, Calendar, Clock, Link as LinkIcon,
  Paperclip, FileCheck, FileClock, FileSignature,
  Download, RefreshCw,
} from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadEmployees, upsertEmployee, deleteEmployee, activateEmployee,
  loadOnboardingSubmissions, deleteOnboardingSubmission, activateSubmissionAsEmployee,
  OnboardingSubmission,
} from '@/lib/supabase-db';
import { Employee, EmploymentType, Department } from '@/types/personnel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { generateContract, detectContractTemplate } from '@/lib/generateContract';
import { ContractDraft, defaultContractDraft } from '@/types/contract';
import { calcSL, calcML, LGAV } from '@/lib/salaryCalc';
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

// ── Legacy-Typen: nur noch für einmalige localStorage→Supabase-Migration ──────
/** @deprecated Migriert — Felder liegen jetzt in Employee (Supabase) */
interface PersonalInfo {
  birthDate?:     string;
  phone?:         string;
  email?:         string;
  addressStreet?: string;
  addressZip?:    string;
  addressCity?:   string;
  nationality?:   string;
  ahvNumber?:     string;
  iban?:          string;
}

/** @deprecated Migriert — Felder liegen jetzt in Employee (Supabase) */
interface ContractFoundation {
  contractType?:      'monthly' | 'hourly' | 'irregular';
  positionTitle?:     string;
  contractStart?:     string;
  contractEnd?:       string;
  isLimited?:         boolean;
  trialPeriodMonths?: number;  // 0-3 (alte Werte, werden beim Migrieren auf 0|1|2|3 geclampt)
  probationEndDate?:  string;
}

/** @deprecated Migriert — Felder liegen jetzt in Employee (Supabase) */
interface OnboardingPrep {
  status:       'none' | 'prepared' | 'sent' | 'completed';
  token?:       string;
  sentAt?:      string;
  completedAt?: string;
  notes?:       string;
}

/** @deprecated Migriert — Felder liegen jetzt in Employee (Supabase) */
interface SalaryExtension {
  has13thSalary?:    boolean;
  socialCostFactor?: number;
}

/** Lokal gespeicherte Felder (nur noch active, notes, contractFileName) */
interface LocalEmployeeData {
  active:              boolean;
  notes:               string;
  contract?:           ContractFields;
  contractFileName?:   string;
  // Legacy-Felder (nur für Migration, danach leer):
  personalInfo?:       PersonalInfo;
  contractFoundation?: ContractFoundation;
  onboarding?:         OnboardingPrep;
  salaryExt?:          SalaryExtension;
}

// ─── Standardwerte ────────────────────────────────────────────────────────────

const DEFAULT_SOCIAL_COST_FACTOR = 1.03; // 3% AG-Anteil

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
  mode:              'monthly' | 'hourly' | 'none';
  grossMonthly:      number | null;
  annualGross:       number | null;
  socialFactor:      number;
  socialCostMonthly: number | null;
  totalAnnual:       number | null;
  internalHourly:    number | null;
}

function calcSalaryCosts(emp: Employee): SalaryCosts {
  const factor  = emp.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR;
  const has13th = emp.has13thSalary ?? false;

  if ((emp.contractType === 'monthly' || (emp.weeklyHours && emp.weeklyHours > 0)) && emp.monthlySalary && emp.monthlySalary > 0) {
    const ml = calcML(emp.monthlySalary, has13th, emp.weeklyHours || 42, factor);
    return {
      mode: 'monthly',
      grossMonthly:      ml.effectiveMonthlyGross,
      annualGross:       ml.annualGross,
      socialFactor:      factor,
      socialCostMonthly: ml.socialCostMonthly,
      totalAnnual:       ml.annualEmployerCost,
      internalHourly:    ml.internalHourlyCost,
    };
  }

  if (emp.hourlyWage > 0) {
    const sl = calcSL(emp.hourlyWage, has13th, factor);
    return {
      mode: 'hourly',
      grossMonthly:      null,
      annualGross:       null,
      socialFactor:      factor,
      socialCostMonthly: sl.socialCostPerHour,
      totalAnnual:       null,
      internalHourly:    sl.internalHourlyCost,
    };
  }

  return { mode: 'none', grossMonthly: null, annualGross: null, socialFactor: factor, socialCostMonthly: null, totalAnnual: null, internalHourly: null };
}

function calcInternalHourlyCost(emp: Employee): number | null {
  return calcSalaryCosts(emp).internalHourly;
}

/** Pro-rata Ferien- und Feiertags-Anspruch */
interface ProRataEntitlement {
  pensum: number;        // Pensum in % (z.B. 80)
  vacationDays: number;  // Ferientage pro rata
  holidayDays: number;   // Feiertage pro rata
  totalDays: number;     // Gesamt (Ferien + Feiertage)
  isProRata: boolean;    // true wenn Eintritt unterjährig
  monthsWorked: number;  // Monate im laufenden Jahr
}

function calcProRataEntitlement(emp: Employee): ProRataEntitlement {
  const FULL_VACATION = 35;
  const FULL_HOLIDAYS = 6;
  const FULL_HOURS    = 42; // Stunden/Woche = 100% Pensum

  const pensum = emp.weeklyHours && emp.weeklyHours > 0
    ? Math.min(emp.weeklyHours / FULL_HOURS, 1.0)
    : 1.0;

  let monthsWorked = 12;
  let isProRata = false;
  if (emp.contractStart) {
    const start = new Date(emp.contractStart);
    const currentYear = new Date().getFullYear();
    if (start.getFullYear() === currentYear) {
      monthsWorked = 12 - start.getMonth(); // 0-indexed Monat
      isProRata = monthsWorked < 12;
    }
  }

  const fraction     = monthsWorked / 12;
  const vacationDays = Math.round(FULL_VACATION * pensum * fraction * 2) / 2;
  const holidayDays  = Math.round(FULL_HOLIDAYS  * pensum * fraction * 2) / 2;

  return {
    pensum: Math.round(pensum * 100),
    vacationDays,
    holidayDays,
    totalDays: Math.round((vacationDays + holidayDays) * 2) / 2,
    isProRata,
    monthsWorked,
  };
}


/**
 * Probezeit-Ende berechnen (contractStart + trialPeriodMonths).
 * Gibt ISO-Datum zurück oder null.
 */
function calcProbationEnd(contractStart?: string, trialPeriodMonths?: 0|1|2|3): string | null {
  if (!contractStart || !trialPeriodMonths || trialPeriodMonths === 0) return null;
  const d = new Date(contractStart);
  d.setMonth(d.getMonth() + trialPeriodMonths);
  return d.toISOString().split('T')[0];
}

/** Ist der Mitarbeiter aktuell noch in der Probezeit? */
function isInProbation(contractStart?: string, trialPeriodMonths?: 0|1|2|3, ref = new Date()): boolean {
  const end = calcProbationEnd(contractStart, trialPeriodMonths);
  if (!end) return false;
  return ref < new Date(end);
}

/**
 * Kündigungsfrist anzeigen:
 * – Während Probezeit: 3 Arbeitstage (OR Art. 335b)
 * – Nach Probezeit:    1 Monat auf Monatsende (OR Art. 335c)
 */
function noticePeriodLabel(inProb: boolean): string {
  return inProb ? '3 Arbeitstage' : '1 Monat auf Monatsende';
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
  const { tenantId } = useTenant();
  const {
    isAdmin, isManager, allowedDepartment, canEditEmployees,
  } = usePermissions();

  // ── Daten ──────────────────────────────────────────────────────────────────
  const [employees, setEmployees]         = useState<Employee[]>([]);
  const [localData, setLocalData]         = useState<Record<string, LocalEmployeeData>>({});
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [deleteTarget, setDeleteTarget]   = useState<Employee | null>(null);

  // ── Selbst-Anmeldungen (onboarding_submissions Tabelle) ───────────────────
  const [submissions, setSubmissions]                 = useState<OnboardingSubmission[]>([]);
  const [selectedSubmission, setSelectedSubmission]   = useState<OnboardingSubmission | null>(null);
  const [submissionsDbReady, setSubmissionsDbReady]   = useState<boolean | null>(null);
  const [submissionsPermissionError, setSubmissionsPermissionError] = useState(false);
  const [anonInsertBlocked, setAnonInsertBlocked]     = useState(false);
  const [employeeStatusMissing, setEmployeeStatusMissing] = useState(false);

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

  // ── Vertragsgenerator ──────────────────────────────────────────────────────
  const [contractBlobUrl,     setContractBlobUrl]     = useState<string | null>(null);
  const [contractPdfFileName, setContractPdfFileName] = useState<string | null>(null);
  const [generatingContract,  setGeneratingContract]  = useState(false);
  const [contractDraft,       setContractDraft]       = useState<ContractDraft | null>(null);
  const [showContractEditor,  setShowContractEditor]  = useState(true);
  const [activeDetailTab,     setActiveDetailTab]     = useState<'stammdaten' | 'vertrag'>('stammdaten');

  // ── UI-Abschnitte aufklappbar ──────────────────────────────────────────────
  const [openPersonal,   setOpenPersonal]   = useState(false);
  const [openContractF,  setOpenContractF]  = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep a ref so the initial load effect can access isAdmin without re-running
  // when the value changes (it is stable after auth resolves and the component mounts).
  const isAdminRef = useRef(isAdmin);
  isAdminRef.current = isAdmin;

  // ── Laden ──────────────────────────────────────────────────────────────────
  // Empty deps: run only once on mount.
  // By the time this component mounts, the global auth loading spinner has
  // already resolved, so isAdminRef.current holds the correct final value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const load = async () => {
      console.log('[Personalstamm] load() start — isAdmin:', isAdminRef.current);
      try {
      const emps = await loadEmployees(tenantId);
      console.log('[Personalstamm] loadEmployees result:', {
        isNull: emps === null,
        count: emps?.length ?? 'n/a',
      });
      const local = loadLocalData();
      console.log('[Personalstamm] localData keys:', Object.keys(local).length);

      if (emps) {
        // ── Einmalige Migration: localStorage HR-Daten → Supabase ──────────
        // Wenn alte Browserdaten vorhanden sind (personalInfo, contractFoundation,
        // salaryExt, onboarding), werden sie in die Supabase-Felder übertragen.
        const migrated: Employee[] = [];
        for (const emp of emps) {
          const loc = local[emp.id];
          if (!loc) continue;
          const hasSalaryExt  = loc.salaryExt  && Object.keys(loc.salaryExt).length  > 0;
          const hasPersonal   = loc.personalInfo && Object.keys(loc.personalInfo).length > 0;
          const hasContractF  = loc.contractFoundation && Object.keys(loc.contractFoundation).length > 0;
          const hasOnboarding = loc.onboarding  && loc.onboarding.status !== 'none';
          if (!hasSalaryExt && !hasPersonal && !hasContractF && !hasOnboarding) continue;

          let updated = { ...emp };
          if (hasSalaryExt && loc.salaryExt) {
            const s = loc.salaryExt;
            updated = {
              ...updated,
              socialCostFactor: emp.socialCostFactor ?? s.socialCostFactor,
              has13thSalary:    emp.has13thSalary    ?? s.has13thSalary,
            };
          }
          if (hasPersonal && loc.personalInfo) {
            const p = loc.personalInfo;
            updated = {
              ...updated,
              birthDate:     emp.birthDate     ?? p.birthDate,
              nationality:   emp.nationality   ?? p.nationality,
              phone:         emp.phone         ?? p.phone,
              email:         emp.email         ?? p.email,
              addressStreet: emp.addressStreet ?? p.addressStreet,
              addressZip:    emp.addressZip    ?? p.addressZip,
              addressCity:   emp.addressCity   ?? p.addressCity,
              ahvNumber:     emp.ahvNumber     ?? p.ahvNumber,
              iban:          emp.iban          ?? p.iban,
            };
          }
          if (hasContractF && loc.contractFoundation) {
            const c = loc.contractFoundation;
            updated = {
              ...updated,
              contractType:      emp.contractType      ?? c.contractType,
              positionTitle:     emp.positionTitle     ?? c.positionTitle,
              contractStart:     emp.contractStart     ?? c.contractStart,
              contractEnd:       emp.contractEnd       ?? c.contractEnd,
              isLimitedContract: emp.isLimitedContract ?? c.isLimited,
              trialPeriodMonths: (emp.trialPeriodMonths ?? Math.min(c.trialPeriodMonths ?? 0, 3)) as 0|1|2|3,
            };
          }
          if (hasOnboarding && loc.onboarding) {
            const o = loc.onboarding;
            updated = {
              ...updated,
              onboardingStatus: emp.onboardingStatus ?? o.status,
              onboardingToken:  emp.onboardingToken  ?? o.token,
            };
          }

          await upsertEmployee(updated, tenantId);
          migrated.push(updated);

          // Alte Felder aus localStorage entfernen
          const { personalInfo, contractFoundation, salaryExt, onboarding, ...rest } = local[emp.id] ?? {};
          local[emp.id] = rest as LocalEmployeeData;
        }
        saveLocalData(local);

        // Migrierte Records in die finale Liste einsetzen
        const finalEmps = emps.map(e => migrated.find(m => m.id === e.id) ?? e);
        console.log('[Personalstamm] setEmployees:', finalEmps.length, 'employees');
        setEmployees(finalEmps);
        if (tenantId === 'beaulieu') {
          const küche   = finalEmps.filter(e => e.department === 'küche');
          const service = finalEmps.filter(e => e.department === 'service');
          const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi', 'eduard', 'nahuel', 'nina'];
          const olivLeak = finalEmps.filter(e => olivNames.some(o => e.name.toLowerCase().includes(o)));
          console.log(`[BEAULIEU-STAFF] personalstamm visible count: ${finalEmps.length} (Küche=${küche.length}, Service=${service.length})`);
          console.log(`[BEAULIEU-STAFF] oliv leak detected: ${olivLeak.length > 0 ? 'yes – ' + olivLeak.map(e => e.name).join(', ') : 'no'}`);
          const missingWage = finalEmps.filter(e => (e.hourlyWage ?? 0) === 0 && (e.monthlySalary ?? 0) === 0);
          if (missingWage.length > 0) {
            console.log(`[BEAULIEU-WAGE] Fehlende Löhne bei: ${missingWage.map(e => e.name).join(', ')}`);
          }
        }
        if (migrated.length > 0) {
          console.info(`[Personalstamm] ${migrated.length} Mitarbeiter-Datensätze aus localStorage nach Supabase migriert.`);
        }
      } else {
        console.warn('[Personalstamm] loadEmployees returned null — employees will stay empty');
      }
      setLocalData(local);

      // Submissions laden (nur für Admin)
      if (isAdminRef.current) {
        console.log('[Personalstamm] loading onboarding submissions (admin)');
        const { data: subs, tableExists, permissionError, anonInsertBlocked: aib, employeeStatusMissing: esm } = await loadOnboardingSubmissions();
        console.log('[Personalstamm] submissions result:', { count: subs.length, tableExists, permissionError });
        setSubmissions(subs);
        setSubmissionsDbReady(tableExists);
        setSubmissionsPermissionError(permissionError);
        setAnonInsertBlocked(aib);
        setEmployeeStatusMissing(esm);
      }

      console.log('[Personalstamm] load() complete — calling setLoading(false)');
      setLoading(false);
      } catch (err) {
        // Safety: always clear loading even if something unexpected throws.
        // Without this, the left column would show "Wird geladen..." forever.
        console.error('[Personalstamm] load() threw unexpectedly — forcing setLoading(false):', err);
        setLoading(false);
      }
    };
    load();
  }, []); // intentionally empty — see comment above

  // ── Gefilterte Mitarbeiter ─────────────────────────────────────────────────
  const pendingEmployees = useMemo(() =>
    isAdmin
      ? employees.filter(e => e.employeeStatus === 'pending_review')
      : [],
  [employees, isAdmin]);

  const visibleBase = useMemo(() =>
    (isAdmin ? employees : employees.filter(e => e.department === allowedDepartment))
      .filter(e => e.employeeStatus !== 'pending_review'),
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
    setOpenPersonal(false);
    setOpenContractF(false);
    // Vertragsvorschau zurücksetzen
    if (contractBlobUrl) URL.revokeObjectURL(contractBlobUrl);
    setContractBlobUrl(null);
    setContractPdfFileName(null);
    setContractDraft(defaultContractDraft(emp));
    setShowContractEditor(true);
    setActiveDetailTab('stammdaten');
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

  // ── Submission Aktivieren / Ablehnen (gemeinsame Handler) ─────────────────
  const handleActivateSubmission = async (sub: OnboardingSubmission) => {
    const { id: newId, errorMessage } = await activateSubmissionAsEmployee(sub);

    if (errorMessage || !newId) {
      const msg = errorMessage ?? 'Unbekannter Fehler';
      console.error('[handleActivateSubmission] Fehler:', msg);
      toast.error(`Aktivierung fehlgeschlagen: ${msg}`, { duration: 10000 });
      return;
    }

    // Submission aus lokalem State entfernen, neuen Mitarbeiter laden
    setSubmissions(prev => prev.filter(s => s.id !== sub.id));
    setSelectedSubmission(null);

    // Einfacher Mitarbeiter-Stub für sofortige UI-Anzeige (vollständig nach Reload)
    const stub: Employee = {
      id:             newId,
      name:           sub.name,
      department:     'service',
      employmentType: ((sub.formData.preferredEmploymentType as string) || 'aushilfe') as EmploymentType,
      hourlyWage:     0,
      weeklyHours:    0,
    };
    setEmployees(prev => [...prev, stub]);
    setSelectedId(newId);
    toast.success(`${sub.name} wurde als Mitarbeiter angelegt!`);
  };

  const handleRejectSubmission = async (sub: OnboardingSubmission) => {
    if (!window.confirm(`Anmeldung von ${sub.name} wirklich ablehnen und löschen?`)) return;
    const ok = await deleteOnboardingSubmission(sub.id);
    if (ok) {
      setSubmissions(prev => prev.filter(s => s.id !== sub.id));
      if (selectedSubmission?.id === sub.id) setSelectedSubmission(null);
      toast.success(`Anmeldung von ${sub.name} abgelehnt.`);
    } else {
      toast.error('Ablehnen fehlgeschlagen.');
    }
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
    setOpenPersonal(false);
    setOpenContractF(false);
  };

  // ── Speichern ──────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!editData) return;
    if (!editData.name.trim()) { toast.error('Name ist erforderlich'); return; }
    setSaving(true);
    const ok = await upsertEmployee(editData, tenantId);
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
        active: editActive,
        notes:  editNotes,
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

  // ── Vertrag generieren ────────────────────────────────────────────────────
  const handleGenerateContract = () => {
    const emp = employees.find(e => e.id === selectedId) ?? editData;
    if (!emp) return;
    const draft = contractDraft ?? defaultContractDraft(emp);
    setGeneratingContract(true);
    try {
      // Alte Blob-URL freigeben (Memory-Leak vermeiden)
      if (contractBlobUrl) URL.revokeObjectURL(contractBlobUrl);
      const { blobUrl, fileName } = generateContract(emp, draft);
      setContractBlobUrl(blobUrl);
      setContractPdfFileName(fileName);
      setActiveDetailTab('vertrag');
    } catch (err) {
      console.error('Vertragsgenerierung fehlgeschlagen:', err);
      toast.error('Vertrag konnte nicht generiert werden. Bitte prüfe die Mitarbeiterdaten.');
    } finally {
      setGeneratingContract(false);
    }
  };

  const handleDownloadContract = () => {
    if (!contractBlobUrl || !contractPdfFileName) return;
    const a = document.createElement('a');
    a.href = contractBlobUrl;
    a.download = contractPdfFileName;
    a.click();
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
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs border-blue-300 text-blue-700 hover:bg-blue-50"
                onClick={() => {
                  const link = `${window.location.origin}/onboarding/new`;
                  navigator.clipboard.writeText(link).then(() => toast.success('Anmelde-Link kopiert!'));
                }}
              >
                <LinkIcon className="h-3.5 w-3.5 mr-1" />
                Anmelde-Link
                {(pendingEmployees.length + submissions.length) > 0 && (
                  <span className="ml-1.5 bg-amber-500 text-white rounded-full text-[10px] px-1.5 py-0 leading-4 font-bold">
                    {pendingEmployees.length + submissions.length}
                  </span>
                )}
              </Button>
            )}
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

      {/* ── DB-Setup Banner ──────────────────────────────────────────────────── */}
      {isAdmin && (() => {
        const needsTableSetup   = submissionsDbReady === false;
        const needsGrantFix     = (submissionsPermissionError || anonInsertBlocked) && !needsTableSetup;
        const needsStatusColumn = employeeStatusMissing;
        const hasAnyIssue       = needsTableSetup || needsGrantFix || needsStatusColumn;
        if (!hasAnyIssue) return null;

        // Build a single SQL block covering everything still needed
        const sqlParts: string[] = [];

        if (needsTableSetup) {
          sqlParts.push(`-- 1. Anmeldungs-Tabelle erstellen
CREATE TABLE IF NOT EXISTS public.onboarding_submissions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  name         TEXT         NOT NULL,
  form_data    JSONB        NOT NULL DEFAULT '{}'::jsonb
);`);
        }

        if (needsTableSetup || needsGrantFix) {
          sqlParts.push(`-- ${needsTableSetup ? '2' : '1'}. Zugriffsrechte & RLS für Anmeldungen
GRANT SELECT, INSERT, DELETE ON TABLE public.onboarding_submissions TO authenticated;
GRANT INSERT ON TABLE public.onboarding_submissions TO anon;
ALTER TABLE public.onboarding_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_insert"  ON public.onboarding_submissions;
CREATE POLICY "anon_insert"  ON public.onboarding_submissions FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "auth_select"  ON public.onboarding_submissions;
CREATE POLICY "auth_select"  ON public.onboarding_submissions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_delete"  ON public.onboarding_submissions;
CREATE POLICY "auth_delete"  ON public.onboarding_submissions FOR DELETE TO authenticated USING (true);`);
        }

        if (needsStatusColumn) {
          const n = sqlParts.length + 1;
          sqlParts.push(`-- ${n}. Mitarbeiterstatus-Spalte hinzufügen (Selbst-Anmeldung)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS employee_status VARCHAR DEFAULT 'active'
  CHECK (employee_status IN ('active', 'pending_review'));
DROP POLICY IF EXISTS "Anon self-register new employee" ON public.employees;
CREATE POLICY "Anon self-register new employee"
  ON public.employees FOR INSERT TO anon
  WITH CHECK (employee_status = 'pending_review');`);
        }

        const sql = sqlParts.join('\n\n');
        const issues: string[] = [];
        if (needsTableSetup)   issues.push('Anmeldungs-Tabelle fehlt');
        if (needsGrantFix)     issues.push('Anon-Zugriffsrechte (GRANT) fehlen');
        if (needsStatusColumn) issues.push('Spalte employee_status fehlt');

        return (
          <div className="bg-red-50 border-b border-red-200 px-4 py-3 max-w-7xl w-full mx-auto">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-900">
                  Einmaliges Datenbank-Setup erforderlich
                </p>
                <p className="text-xs text-red-700 mt-0.5">
                  Ausstehend: {issues.join(' · ')}.{' '}
                  Führen Sie das folgende SQL einmalig im{' '}
                  <a href="https://supabase.com/dashboard/project/ajflrvuzmkfspsxkdyfe/sql/new"
                     target="_blank" rel="noreferrer"
                     className="underline font-semibold text-red-800">
                    Supabase SQL-Editor ↗
                  </a>{' '}
                  aus, dann die Seite neu laden:
                </p>
                <div className="mt-2 relative">
                  <pre className="text-[10px] bg-slate-900 text-green-300 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
                    {sql}
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute top-2 right-2 h-6 text-[10px] bg-white/10 border-white/20 text-green-300 hover:bg-white/20"
                    onClick={() => {
                      navigator.clipboard.writeText(sql);
                      toast.success('SQL in Zwischenablage kopiert!');
                    }}
                  >
                    Kopieren
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Ausstehende Anmeldungen (vollbreite Kartenansicht) ──────────────── */}
      {isAdmin && submissions.length > 0 && (
        <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 overflow-y-auto" style={{ maxHeight: '320px' }}>
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <h2 className="text-sm font-semibold text-amber-800">Ausstehende Anmeldungen</h2>
              <span className="bg-amber-500 text-white text-[11px] font-bold rounded-full px-2 py-0.5 leading-none">
                {submissions.length}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {submissions.map(sub => {
                const fd = sub.formData;
                const permitType     = (fd.permitType as string)    || null;
                const maritalStatus  = (fd.maritalStatus as string) || null;
                const hasDocuments   = fd.documents != null && typeof fd.documents === 'object' && Object.keys(fd.documents as object).length > 0;
                const dateStr = new Date(sub.submittedAt).toLocaleString('de-CH', {
                  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
                });
                const permitLabel: Record<string, string> = {
                  CH: 'Schweizer/in', C: 'Ausweis C', B: 'Ausweis B',
                  L: 'Ausweis L', G: 'Grenzgänger G', other: 'Anderer',
                };
                const maritalLabel: Record<string, string> = {
                  single: 'Ledig', married: 'Verheiratet', divorced: 'Geschieden',
                  widowed: 'Verwitwet', partnership: 'Eingetr. Partnerschaft',
                };
                return (
                  <div key={sub.id} className="bg-white border border-amber-200 rounded-lg p-4 flex flex-col gap-3 shadow-sm">
                    {/* Name + Datum */}
                    <div className="flex items-start gap-2.5">
                      <div className="w-9 h-9 rounded-full bg-amber-200 flex items-center justify-center shrink-0 text-amber-800 font-bold text-sm">
                        {sub.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 leading-snug truncate">{sub.name}</p>
                        <p className="text-[11px] text-amber-700 mt-0.5">{dateStr}</p>
                      </div>
                    </div>

                    {/* Badges: Aufenthalt, Zivilstand, Dokumente */}
                    <div className="flex flex-wrap gap-1.5">
                      {permitType && (
                        <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5">
                          {permitLabel[permitType] ?? permitType}
                        </span>
                      )}
                      {maritalStatus && (
                        <span className="text-[11px] bg-slate-50 text-slate-600 border border-slate-200 rounded px-2 py-0.5">
                          {maritalLabel[maritalStatus] ?? maritalStatus}
                        </span>
                      )}
                      {hasDocuments && (
                        <span className="text-[11px] bg-green-50 text-green-700 border border-green-200 rounded px-2 py-0.5 flex items-center gap-1">
                          <FileText className="h-3 w-3 shrink-0" />
                          Dokumente
                        </span>
                      )}
                    </div>

                    {/* Aktions-Buttons */}
                    <div className="flex gap-2 mt-auto">
                      <Button size="sm" variant="outline"
                        className="flex-1 h-8 text-xs border-red-200 text-red-600 hover:bg-red-50"
                        onClick={() => handleRejectSubmission(sub)}>
                        Ablehnen
                      </Button>
                      <Button size="sm"
                        className="flex-1 h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => handleActivateSubmission(sub)}>
                        <CheckCircle2 className="h-3 w-3 mr-1 shrink-0" />
                        Übernehmen
                      </Button>
                    </div>

                    {/* Detail-Link */}
                    <button
                      className="text-[11px] text-amber-600 hover:text-amber-800 underline text-left -mt-1"
                      onClick={() => { setSelectedSubmission(sub); setSelectedId(null); setEditMode(false); setShowMobile('detail'); }}>
                      Vollständige Daten anzeigen →
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
          ) : (
            <>
              {/* ── Legacy: Mitarbeiter mit employee_status = pending_review ── */}
              {isAdmin && pendingEmployees.length > 0 && (
                <div className="border-b border-amber-200">
                  <div className="px-4 py-2 bg-amber-50 sticky top-0 z-10 flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    <span className="text-xs font-semibold text-amber-800">
                      Ausstehend ({pendingEmployees.length})
                    </span>
                  </div>
                  <ul className="divide-y divide-amber-100">
                    {pendingEmployees.map(emp => {
                      const isSelected = selectedId === emp.id;
                      return (
                        <li key={emp.id}>
                          <button
                            onClick={() => { selectEmployee(emp); setSelectedSubmission(null); }}
                            className={cn(
                              'w-full text-left px-4 py-3 hover:bg-amber-50/60 transition-colors flex items-center gap-3',
                              isSelected && 'bg-amber-100/60 border-l-2 border-amber-500',
                            )}
                          >
                            <div className="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0 text-amber-800 font-semibold text-sm">
                              {emp.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{emp.name}</p>
                              <p className="text-xs text-amber-700 truncate">
                                {emp.email ?? emp.phone ?? 'Ausstehend'}
                              </p>
                            </div>
                            <span className="text-[10px] bg-amber-100 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 font-semibold shrink-0">
                              NEU
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* ── Reguläre Mitarbeiter ── */}
              {filtered.length === 0 ? (
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
            </>
          )}
        </aside>

        {/* ── Detailbereich ──────────────────────────────────────────────────── */}
        <main className={cn(
          'flex-1 overflow-y-auto bg-background',
          showMobile === 'list' ? 'hidden md:block' : 'block',
        )}>
          {selectedSubmission && !selectedId && !editData ? (
            /* ── Submission-Detail-Panel ─────────────────────────────────── */
            <div className="max-w-2xl mx-auto p-6 space-y-5">
              {/* Zurück-Button (Mobile) */}
              <Button variant="ghost" size="sm" className="md:hidden -ml-1 mb-1 h-8 text-xs"
                onClick={() => { setSelectedSubmission(null); setShowMobile('list'); }}>
                <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Zurück
              </Button>

              {/* Header Banner */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-200 flex items-center justify-center shrink-0 text-amber-800 font-bold text-lg">
                    {selectedSubmission.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-base font-bold text-amber-900">{selectedSubmission.name}</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Selbst-Anmeldung vom {new Date(selectedSubmission.submittedAt).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline"
                    className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50"
                    onClick={() => handleRejectSubmission(selectedSubmission)}>
                    Ablehnen
                  </Button>
                  <Button size="sm"
                    className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => handleActivateSubmission(selectedSubmission)}>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Als Mitarbeiter anlegen
                  </Button>
                </div>
              </div>

              {/* Eingereichte Daten (read-only) */}
              {(() => {
                const fd = selectedSubmission.formData;
                const rows: [string, string][] = [
                  ['Gewünschte Stelle',      (fd.desiredPosition as string)      || '—'],
                  ['Gewünschter Start',       (fd.desiredStartDate as string)     || '—'],
                  ['Anstellungsart',          (fd.preferredEmploymentType as string) || '—'],
                  ['Geburtsdatum',            (fd.birthDate as string)             || '—'],
                  ['Nationalität',            (fd.nationality as string)           || '—'],
                  ['Aufenthaltsstatus',        (fd.permitType as string)            || '—'],
                  ['Zivilstand',              (fd.maritalStatus as string)         || '—'],
                  ['Telefon',                 (fd.phone as string)                 || '—'],
                  ['E-Mail',                  (fd.email as string)                 || '—'],
                  ['Strasse',                 (fd.addressStreet as string)         || '—'],
                  ['PLZ / Ort',               `${(fd.addressZip as string) || ''} ${(fd.addressCity as string) || ''}`.trim() || '—'],
                  ['AHV-Nummer',              (fd.ahvNumber as string)             || '—'],
                  ['IBAN',                    (fd.iban as string)                  || '—'],
                ].filter(([, v]) => v !== '—');
                return (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                      <p className="text-xs font-semibold text-slate-700">Eingereichte Daten (schreibgeschützt)</p>
                    </div>
                    <dl className="divide-y divide-slate-100">
                      {rows.map(([label, value]) => (
                        <div key={label} className="grid grid-cols-2 px-4 py-2.5 text-sm">
                          <dt className="text-slate-500 text-xs font-medium">{label}</dt>
                          <dd className="text-slate-900 text-xs">{value}</dd>
                        </div>
                      ))}
                      {rows.length === 0 && (
                        <div className="px-4 py-4 text-xs text-slate-400 text-center">Keine Angaben übermittelt.</div>
                      )}
                    </dl>
                  </div>
                );
              })()}
            </div>

          ) : !selectedId && !editData ? (
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

              {/* ── Aktivierungs-Banner für neue Selbst-Anmeldungen ── */}
              {!editMode && selectedEmp?.employeeStatus === 'pending_review' && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0 mt-0.5">
                      <AlertTriangle className="h-4 w-4 text-amber-700" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-amber-900">Neue Selbst-Anmeldung</p>
                      <p className="text-xs text-amber-700 mt-0.5">
                        Bitte interne Felder prüfen und ergänzen, dann Mitarbeiter aktivieren.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50"
                      onClick={async () => {
                        if (!selectedEmp) return;
                        if (!window.confirm(`Anmeldung von ${selectedEmp.name} wirklich ablehnen und löschen?`)) return;
                        await deleteEmployee(selectedEmp.id);
                        setEmployees(prev => prev.filter(e => e.id !== selectedEmp.id));
                        setSelectedId(null);
                        toast.success(`Anmeldung von ${selectedEmp.name} abgelehnt.`);
                      }}
                    >
                      Ablehnen
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                      disabled={employeeStatusMissing}
                      title={employeeStatusMissing ? 'Migration erforderlich – siehe Setup-Banner oben' : undefined}
                      onClick={async () => {
                        if (!selectedEmp) return;
                        if (employeeStatusMissing) {
                          toast.error('Datenbank-Migration fehlt. Bitte das SQL im roten Banner oben ausführen.');
                          return;
                        }
                        const ok = await activateEmployee(selectedEmp.id);
                        if (ok) {
                          const updated = { ...selectedEmp, employeeStatus: 'active' as const };
                          setEmployees(prev => prev.map(e => e.id === updated.id ? updated : e));
                          toast.success(`${selectedEmp.name} wurde aktiviert!`);
                        } else {
                          toast.error('Aktivierung fehlgeschlagen. Bitte nochmals versuchen.');
                        }
                      }}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      Aktivieren
                    </Button>
                  </div>
                </div>
              )}

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

              {/* ── Tab-Leiste ────────────────────────────────────────────── */}
              <Tabs
                value={activeDetailTab}
                onValueChange={(v) => setActiveDetailTab(v as 'stammdaten' | 'vertrag')}
              >
                <TabsList className="w-full grid grid-cols-2 mb-2">
                  <TabsTrigger value="stammdaten" className="text-xs">
                    Stammdaten
                  </TabsTrigger>
                  <TabsTrigger value="vertrag" className="text-xs flex items-center gap-1.5">
                    <FileSignature className="h-3.5 w-3.5" />
                    Arbeitsvertrag
                  </TabsTrigger>
                </TabsList>

                {/* ── Tab 1: Stammdaten ──────────────────────────────────── */}
                <TabsContent value="stammdaten" className="space-y-4 mt-0">

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
                            <SelectItem value="aushilfe">Aushilfe</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        {editData?.contractType === 'monthly' ? (
                          <>
                            <Label className="text-xs text-muted-foreground mb-1 block">
                              Beschäftigungsgrad (Pensum)
                              <span className="ml-1 text-[10px] italic opacity-60">100% = 42 h/Woche</span>
                            </Label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min="10" max="100" step="5"
                                value={editData?.weeklyHours ? Math.round(editData.weeklyHours / 42 * 100) : 100}
                                onChange={e => {
                                  const pct = Math.min(100, Math.max(10, parseFloat(e.target.value) || 100));
                                  const wh  = Math.round(42 * pct / 100 * 2) / 2;
                                  setEditData(d => d ? { ...d, weeklyHours: wh } : d);
                                }}
                                className="h-9 text-sm w-20"
                              />
                              <span className="text-xs text-muted-foreground">
                                % = {editData?.weeklyHours ? `${editData.weeklyHours} h/W` : '42 h/W'}
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <Label className="text-xs text-muted-foreground mb-1 block">Wochenstunden</Label>
                            <Input
                              type="number"
                              min="0" max="60" step="0.5"
                              value={editData?.weeklyHours ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, weeklyHours: parseFloat(e.target.value) || undefined } : d)}
                              placeholder="z.B. 42"
                              className="h-9 text-sm"
                            />
                          </>
                        )}
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
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-y-2 text-sm">
                        <DataRow label="Name"           value={selectedEmp?.name} />
                        <DataRow label="Abteilung"      value={selectedEmp ? DEPT_LABELS[selectedEmp.department] : undefined} />
                        <DataRow label="Art"            value={selectedEmp ? TYPE_LABELS[selectedEmp.employmentType] : undefined} />
                        {selectedEmp?.contractType === 'monthly'
                          ? <DataRow label="Pensum / Wochenstunden" value={selectedEmp?.weeklyHours ? `${Math.round(selectedEmp.weeklyHours / 42 * 100)}% = ${selectedEmp.weeklyHours} h/W` : '100% = 42 h/W'} />
                          : <DataRow label="Wochenstunden" value={selectedEmp?.weeklyHours ? `${selectedEmp.weeklyHours} h` : '–'} />
                        }
                      </div>
                      {selectedEmp && (() => {
                        const pr = calcProRataEntitlement(selectedEmp);
                        return (
                          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/20 p-3 space-y-2 text-xs">
                            <p className="font-semibold text-green-800 dark:text-green-300 flex items-center gap-1.5">
                              <Calendar className="h-3.5 w-3.5" />
                              Ferienlohn-Anspruch {pr.isProRata ? `(pro rata · ${pr.monthsWorked} Monate)` : '(volles Jahr)'}
                              {pr.pensum < 100 && (
                                <span className="ml-1 font-normal text-green-700 dark:text-green-400">Pensum {pr.pensum}%</span>
                              )}
                            </p>
                            <div className="grid grid-cols-3 gap-2">
                              <div className="rounded-md bg-white dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-2.5 py-2 text-center">
                                <p className="text-lg font-bold text-green-800 dark:text-green-200">{pr.vacationDays}</p>
                                <p className="text-[10px] text-green-600 dark:text-green-400 leading-tight mt-0.5">Ferientage</p>
                              </div>
                              <div className="rounded-md bg-white dark:bg-green-900/20 border border-green-200 dark:border-green-700 px-2.5 py-2 text-center">
                                <p className="text-lg font-bold text-green-800 dark:text-green-200">{pr.holidayDays}</p>
                                <p className="text-[10px] text-green-600 dark:text-green-400 leading-tight mt-0.5">Feiertage</p>
                              </div>
                              <div className="rounded-md bg-green-100 dark:bg-green-800/40 border border-green-300 dark:border-green-600 px-2.5 py-2 text-center">
                                <p className="text-lg font-bold text-green-900 dark:text-green-100">{pr.totalDays}</p>
                                <p className="text-[10px] text-green-700 dark:text-green-300 leading-tight mt-0.5">Total Tage</p>
                              </div>
                            </div>
                            <p className="text-[10px] text-green-600 dark:text-green-500 italic">
                              Basis: 100% Pensum ({42} h/W) = 35 Ferientage + 6 Feiertage pro Jahr.
                              {pr.isProRata ? ` Pro rata ${pr.monthsWorked}/12 Monate.` : ''}
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── Abschnitt 2: Persönliche Daten (Admin) ─────────────────── */}
              {isAdmin && (
                <Card>
                  <CardHeader
                    className="pb-2 pt-4 cursor-pointer select-none"
                    onClick={() => setOpenPersonal(o => !o)}
                  >
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <UserCheck className="h-4 w-4 text-emerald-600" />
                        Persönliche Daten
                        <span className="text-[10px] font-normal text-muted-foreground bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 px-1.5 py-0.5 rounded">
                          Nur Admin
                        </span>
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', openPersonal && 'rotate-180')} />
                    </CardTitle>
                  </CardHeader>
                  {openPersonal && (
                    <CardContent className="space-y-3 pt-0">
                      {editMode ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Calendar className="h-3 w-3" /> Geburtsdatum
                            </Label>
                            <Input type="date" className="h-9 text-sm"
                              value={editData?.birthDate ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, birthDate: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Shield className="h-3 w-3" /> Nationalität
                            </Label>
                            <Input className="h-9 text-sm" placeholder="z.B. Schweiz"
                              value={editData?.nationality ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, nationality: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Phone className="h-3 w-3" /> Telefon
                            </Label>
                            <Input className="h-9 text-sm" placeholder="+41 79 …"
                              value={editData?.phone ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, phone: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Mail className="h-3 w-3" /> E-Mail
                            </Label>
                            <Input type="email" className="h-9 text-sm" placeholder="name@beispiel.ch"
                              value={editData?.email ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, email: e.target.value || undefined } : d)} />
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> Strasse & Hausnummer
                            </Label>
                            <Input className="h-9 text-sm" placeholder="Musterstrasse 1"
                              value={editData?.addressStreet ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, addressStreet: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">PLZ</Label>
                            <Input className="h-9 text-sm" placeholder="3000"
                              value={editData?.addressZip ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, addressZip: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Ort</Label>
                            <Input className="h-9 text-sm" placeholder="Bern"
                              value={editData?.addressCity ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, addressCity: e.target.value || undefined } : d)} />
                          </div>
                          {isAdmin && (
                            <>
                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                                  <Shield className="h-3 w-3" /> AHV-Nummer
                                  <span className="ml-1 text-[10px] opacity-60">vertraulich</span>
                                </Label>
                                <Input className="h-9 text-sm font-mono" placeholder="756.XXXX.XXXX.XX"
                                  value={editData?.ahvNumber ?? ''}
                                  onChange={e => setEditData(d => d ? { ...d, ahvNumber: e.target.value || undefined } : d)} />
                              </div>
                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                                  <CreditCard className="h-3 w-3" /> IBAN (Lohnkonto)
                                  <span className="ml-1 text-[10px] opacity-60">vertraulich</span>
                                </Label>
                                <Input className="h-9 text-sm font-mono" placeholder="CH56 …"
                                  value={editData?.iban ?? ''}
                                  onChange={e => setEditData(d => d ? { ...d, iban: e.target.value || undefined } : d)} />
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          {selectedEmp?.birthDate    && <DataRow label="Geburtsdatum"  value={selectedEmp.birthDate} />}
                          {selectedEmp?.nationality  && <DataRow label="Nationalität"  value={selectedEmp.nationality} />}
                          {selectedEmp?.phone        && <DataRow label="Telefon"       value={selectedEmp.phone} />}
                          {selectedEmp?.email        && <DataRow label="E-Mail"        value={selectedEmp.email} />}
                          {selectedEmp?.addressStreet && (
                            <DataRow label="Adresse" value={`${selectedEmp.addressStreet}, ${selectedEmp.addressZip ?? ''} ${selectedEmp.addressCity ?? ''}`} />
                          )}
                          {isAdmin && selectedEmp?.ahvNumber && (
                            <DataRow label="AHV-Nummer" value={selectedEmp.ahvNumber} />
                          )}
                          {isAdmin && selectedEmp?.iban && (
                            <DataRow label="IBAN" value={`****${selectedEmp.iban.slice(-4)}`} />
                          )}
                          {!selectedEmp?.phone && !selectedEmp?.email && !selectedEmp?.birthDate && (
                            <p className="col-span-2 text-xs text-muted-foreground italic">Noch keine persönlichen Daten erfasst. Im Bearbeitungsmodus ergänzen.</p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              )}

              {/* ── Abschnitt 3: Vertragliche Grundlagen (Admin) ─────────────── */}
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
                          Nur Admin
                        </span>
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', openContractF && 'rotate-180')} />
                    </CardTitle>
                  </CardHeader>
                  {openContractF && (
                    <CardContent className="space-y-3 pt-0">
                      {editMode ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Vertragsart</Label>
                            <Select
                              value={editData?.contractType ?? ''}
                              onValueChange={v => setEditData(d => d ? { ...d, contractType: (v as Employee['contractType']) || undefined } : d)}
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
                              value={editData?.positionTitle ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, positionTitle: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Calendar className="h-3 w-3" /> Eintrittsdatum
                            </Label>
                            <Input type="date" className="h-9 text-sm"
                              value={editData?.contractStart ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, contractStart: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Calendar className="h-3 w-3" /> Austrittsdatum
                              <span className="ml-1 text-[10px] opacity-60">falls bekannt</span>
                            </Label>
                            <Input type="date" className="h-9 text-sm"
                              value={editData?.employmentEndDate ?? ''}
                              onChange={e => setEditData(d => d ? { ...d, employmentEndDate: e.target.value || undefined } : d)} />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                              <Clock className="h-3 w-3" /> Probezeit
                            </Label>
                            <Select
                              value={String(editData?.trialPeriodMonths ?? 0)}
                              onValueChange={v => setEditData(d => d ? { ...d, trialPeriodMonths: parseInt(v) as 0|1|2|3 } : d)}
                            >
                              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="0">Keine Probezeit</SelectItem>
                                <SelectItem value="1">1 Monat</SelectItem>
                                <SelectItem value="2">2 Monate</SelectItem>
                                <SelectItem value="3">3 Monate</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-2 block">Befristeter Vertrag</Label>
                            <label className="flex items-center gap-2 cursor-pointer mb-1">
                              <input type="checkbox"
                                checked={editData?.isLimitedContract ?? false}
                                onChange={e => setEditData(d => d ? { ...d, isLimitedContract: e.target.checked } : d)}
                                className="h-4 w-4 rounded" />
                              <span className="text-sm">Ja – Vertrag ist befristet</span>
                            </label>
                            {editData?.isLimitedContract && (
                              <>
                                <Label className="text-[11px] text-muted-foreground mb-1 block">Vertragsende (befristet)</Label>
                                <Input type="date" className="h-9 text-sm"
                                  value={editData?.contractEnd ?? ''}
                                  onChange={e => setEditData(d => d ? { ...d, contractEnd: e.target.value || undefined } : d)} />
                              </>
                            )}
                          </div>
                          <div className="sm:col-span-2">
                            <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-1 text-xs text-blue-800 dark:text-blue-300">
                              <p className="font-semibold flex items-center gap-1">
                                <Info className="h-3.5 w-3.5" /> Kündigungsfrist (automatisch)
                              </p>
                              {(() => {
                                const probEnd = calcProbationEnd(editData?.contractStart, editData?.trialPeriodMonths);
                                const inProb  = isInProbation(editData?.contractStart, editData?.trialPeriodMonths);
                                return (
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1">
                                    <div className="flex items-center gap-1">
                                      <span className={cn('w-2 h-2 rounded-full flex-shrink-0', inProb ? 'bg-amber-500' : 'bg-gray-300')} />
                                      <span className="font-medium">Während Probezeit:</span>
                                    </div>
                                    <span>3 Arbeitstage</span>
                                    <div className="flex items-center gap-1">
                                      <span className={cn('w-2 h-2 rounded-full flex-shrink-0', !inProb ? 'bg-green-500' : 'bg-gray-300')} />
                                      <span className="font-medium">Nach Probezeit:</span>
                                    </div>
                                    <span>1 Monat auf Monatsende</span>
                                    {probEnd && (
                                      <>
                                        <span className="font-medium text-blue-700 dark:text-blue-400">Probezeit endet am:</span>
                                        <span>{probEnd}</span>
                                      </>
                                    )}
                                    <span className="font-medium text-blue-700 dark:text-blue-400 col-span-2">
                                      Aktueller Status: <span className={cn('font-bold', inProb ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400')}>
                                        {(editData?.trialPeriodMonths ?? 0) === 0 ? 'Keine Probezeit' : inProb ? 'In Probezeit' : 'Nach Probezeit'}
                                      </span>
                                    </span>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      ) : (
                        (() => {
                          const emp = selectedEmp;
                          if (!emp) return null;
                          const probEnd = calcProbationEnd(emp.contractStart, emp.trialPeriodMonths);
                          const inProb  = isInProbation(emp.contractStart, emp.trialPeriodMonths);
                          const hasData = emp.contractType || emp.contractStart;
                          if (!hasData) return (
                            <p className="text-xs text-muted-foreground italic">Noch keine Vertragsdaten erfasst. Im Bearbeitungsmodus ergänzen.</p>
                          );
                          return (
                            <div className="space-y-3">
                              <div className="grid grid-cols-2 gap-y-2 text-sm">
                                {emp.contractType   && <DataRow label="Vertragsart"        value={emp.contractType === 'monthly' ? 'Monatslohn-Vertrag' : emp.contractType === 'hourly' ? 'Stundenlohn-Vertrag' : 'Aushilfe'} />}
                                {emp.positionTitle  && <DataRow label="Stellenbezeichnung" value={emp.positionTitle} />}
                                {emp.contractStart  && <DataRow label="Eintritt"           value={emp.contractStart} />}
                                {emp.employmentEndDate && <DataRow label="Austritt"        value={emp.employmentEndDate} />}
                                {emp.isLimitedContract && emp.contractEnd && <DataRow label="Vertragsende (befristet)" value={emp.contractEnd} />}
                                {(emp.trialPeriodMonths ?? 0) > 0
                                  ? <DataRow label="Probezeit" value={`${emp.trialPeriodMonths} Monat${emp.trialPeriodMonths === 1 ? '' : 'e'}`} />
                                  : <DataRow label="Probezeit" value="Keine Probezeit" />
                                }
                              </div>
                              <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1">
                                <p className="font-semibold flex items-center gap-1">
                                  <Clock className="h-3.5 w-3.5 text-muted-foreground" /> Kündigungsfrist
                                </p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                                  <span className="text-muted-foreground">Während Probezeit:</span>
                                  <span className="font-medium">3 Arbeitstage</span>
                                  <span className="text-muted-foreground">Nach Probezeit:</span>
                                  <span className="font-medium">1 Monat auf Monatsende</span>
                                  {probEnd && (
                                    <>
                                      <span className="text-muted-foreground">Probezeit endet:</span>
                                      <span className="font-medium">{probEnd}</span>
                                    </>
                                  )}
                                  <span className="text-muted-foreground">Aktuell gilt:</span>
                                  <span className={cn('font-semibold', inProb ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400')}>
                                    {noticePeriodLabel(inProb)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      )}
                    </CardContent>
                  )}
                </Card>
              )}

              {/* ── Abschnitt 4: Lohn & Kosten (nur Admin) ─────────────────── */}
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
                        {/* ── Lohneingabe abhängig von Vertragsart ─── */}
                        {editData?.contractType === 'monthly' ? (
                          <div className="space-y-3">
                            <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-3">
                              <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-2">
                                Monatslohn-Vertrag (ML) — Festanstellung
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                  <Label className="text-xs text-muted-foreground mb-1 block">
                                    Fixlohn / Monat (CHF)
                                    <span className="ml-1 text-[10px] italic opacity-60">exkl. 13. ML</span>
                                  </Label>
                                  <Input
                                    type="number" min="0" step="50"
                                    value={editData?.monthlySalary ?? ''}
                                    onChange={e => {
                                      const val = parseFloat(e.target.value) || undefined;
                                      setEditData(d => {
                                        if (!d) return d;
                                        const auto13 = val && d.has13thSalary && !d.monthlySalaryWith13th
                                          ? parseFloat((val * 13 / 12).toFixed(2))
                                          : d.monthlySalaryWith13th;
                                        return { ...d, monthlySalary: val, monthlySalaryWith13th: auto13 };
                                      });
                                    }}
                                    placeholder="z.B. 4800"
                                    className="h-9 text-sm"
                                    autoFocus
                                  />
                                </div>
                                <div>
                                  <Label className="text-xs text-muted-foreground mb-1 block">
                                    Fixlohn / Monat (CHF)
                                    <span className="ml-1 text-[10px] italic opacity-60">inkl. 13. ML</span>
                                  </Label>
                                  <Input
                                    type="number" min="0" step="50"
                                    value={editData?.monthlySalaryWith13th ?? (editData?.has13thSalary && editData?.monthlySalary ? parseFloat((editData.monthlySalary * 13 / 12).toFixed(2)) : '')}
                                    onChange={e => setEditData(d => d ? { ...d, monthlySalaryWith13th: parseFloat(e.target.value) || undefined } : d)}
                                    placeholder={editData?.monthlySalary && editData?.has13thSalary
                                      ? `≈ ${(editData.monthlySalary * 13 / 12).toFixed(0)}`
                                      : 'z.B. 5200'}
                                    className="h-9 text-sm"
                                  />
                                  {editData?.monthlySalary && editData?.has13thSalary && (
                                    <p className="text-[10px] text-muted-foreground mt-0.5">
                                      Berechnet: {formatCHF(editData.monthlySalary * 13 / 12)}/Mt.
                                    </p>
                                  )}
                                </div>
                                <div>
                                  <Label className="text-xs text-muted-foreground mb-1 block">
                                    Pensum
                                    <span className="ml-1 text-[10px] italic opacity-60">aus Stammdaten</span>
                                  </Label>
                                  <div className="h-9 flex items-center px-3 rounded-md border border-input bg-muted/30 text-sm text-muted-foreground">
                                    {editData?.weeklyHours
                                      ? `${Math.round(editData.weeklyHours / 42 * 100)}% = ${editData.weeklyHours} h/Woche`
                                      : '100% = 42 h/Woche (Standard)'}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-0.5">Pensum in «Beschäftigung» ändern</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <Label className="text-xs text-muted-foreground mb-1 block">
                                Basis-Stundenlohn brutto (CHF)
                                <span className="ml-1 text-[10px] italic opacity-60">ohne L-GAV-Zuschläge</span>
                              </Label>
                              <Input
                                type="number" min="0" step="0.05"
                                value={editData?.hourlyWage || ''}
                                onChange={e => setEditData(d => d ? { ...d, hourlyWage: parseFloat(e.target.value) || 0 } : d)}
                                placeholder="z.B. 23.50"
                                className="h-9 text-sm"
                              />
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-2 block">13. Monatslohn</Label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editData?.has13thSalary ?? false}
                                onChange={e => setEditData(d => d ? { ...d, has13thSalary: e.target.checked } : d)}
                                className="h-4 w-4 rounded"
                              />
                              <span className="text-sm">Ja – 13. Monatslohn vereinbart</span>
                            </label>
                            {editData?.has13thSalary && editData?.contractType !== 'monthly' && editData?.monthlySalary && (
                              <p className="text-[11px] text-muted-foreground mt-1 ml-6">
                                ≈ {formatCHF(editData.monthlySalary * 13 / 12)}/Mt. effektiv
                              </p>
                            )}
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">
                              AG-Sozialkostenfaktor
                              <span className="ml-1 text-[10px] italic opacity-60">z.B. 1.03 = 3%</span>
                            </Label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number" min="1.00" max="1.40" step="0.01"
                                value={editData?.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR}
                                onChange={e => setEditData(d => d ? { ...d, socialCostFactor: parseFloat(e.target.value) || DEFAULT_SOCIAL_COST_FACTOR } : d)}
                                className="h-9 text-sm w-24"
                              />
                              <span className="text-xs text-muted-foreground">
                                = {(((editData?.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR) - 1) * 100).toFixed(1)}% AG
                              </span>
                            </div>
                          </div>
                        </div>

                        {editData && (() => {
                          const factor   = editData.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR;
                          const has13th  = editData.has13thSalary ?? false;
                          const hasSL    = editData.hourlyWage > 0 && editData.contractType !== 'monthly';
                          const mlHours  = editData.weeklyHours || 42;
                          const hasML    = !!(editData.contractType === 'monthly' && editData.monthlySalary && editData.monthlySalary > 0);
                          if (!hasSL && !hasML) return null;

                          const LRow = ({ label, value, bold, sub }: { label: string; value: string; bold?: boolean; sub?: boolean }) => (
                            <div className={`flex justify-between ${sub ? 'pl-3' : ''}`}>
                              <span className={bold ? 'font-semibold text-purple-900 dark:text-purple-200' : 'text-purple-700 dark:text-purple-400'}>{label}</span>
                              <span className={bold ? 'font-semibold text-purple-900 dark:text-purple-200' : 'font-medium'}>{value}</span>
                            </div>
                          );
                          const Sep = () => <Separator className="my-1 bg-purple-200 dark:bg-purple-700" />;

                          return (
                            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 p-3 space-y-1 text-xs">
                              <p className="font-semibold text-purple-800 dark:text-purple-300 flex items-center gap-1 mb-2">
                                <Calculator className="h-3 w-3" /> L-GAV Kostenvorschau
                              </p>

                              {hasSL && (() => {
                                const sl = calcSL(editData.hourlyWage, has13th, factor);
                                return <>
                                  <LRow label="Basis-Stundenlohn brutto" value={formatCHF(editData.hourlyWage)} />
                                  <LRow label={`+ Ferienentschädigung (${(LGAV.VACATION_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.vacationComp)} sub />
                                  <LRow label={`+ Feiertagsentschädigung (${(LGAV.PUBLIC_HOLIDAY_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.holidayComp)} sub />
                                  <Sep />
                                  <LRow label="Zwischensumme" value={formatCHF(sl.subtotal)} bold />
                                  {has13th && <LRow label={`+ 13. Monatslohn (${(LGAV.THIRTEENTH_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.thirteenthComp)} sub />}
                                  <Sep />
                                  <LRow label="Auszahlbarer Stundenlohn" value={formatCHF(sl.totalPayableHourly)} bold />
                                  <LRow label={`+ AG-Sozialkosten (${((factor - 1) * 100).toFixed(1)}%)`} value={`+ ${formatCHF(sl.socialCostPerHour)}`} sub />
                                  <Sep />
                                  <LRow label="Interner Stundenansatz (Kostenstelle)" value={formatCHF(sl.internalHourlyCost)} bold />
                                  <p className="text-[10px] text-purple-500 italic pt-0.5">= Auszahlbarer Lohn × Sozialkostenfaktor {factor.toFixed(2)}</p>
                                </>;
                              })()}

                              {hasML && (() => {
                                const ml = calcML(editData.monthlySalary!, has13th, mlHours, factor);
                                const pensum = Math.round(mlHours / 42 * 100);
                                return <>
                                  <LRow label={`Monatslohn brutto — ${pensum}% Pensum (${mlHours} h/W)`} value={formatCHF(ml.baseSalaryMonthly)} />
                                  {has13th && <LRow label={`+ 13. Monatslohn (1/12 = ${(LGAV.THIRTEENTH_RATE * 100).toFixed(2)}%)`} value={formatCHF(ml.effectiveMonthlyGross - ml.baseSalaryMonthly)} sub />}
                                  {has13th && <><Sep /><LRow label="Effektiver Brutto/Monat (inkl. 13.)" value={formatCHF(ml.effectiveMonthlyGross)} bold /></>}
                                  <LRow label={`+ AG-Sozialkosten (${((factor - 1) * 100).toFixed(1)}%)`} value={`+ ${formatCHF(ml.socialCostMonthly)}`} sub />
                                  <Sep />
                                  <LRow label="Vollkosten pro Monat" value={formatCHF(ml.totalMonthlyEmployerCost)} bold />
                                  <LRow label="Jahresvollkosten" value={formatCHF(ml.annualEmployerCost)} sub />
                                  <Sep />
                                  <LRow label="Interner Stundenansatz (Kostenstelle)" value={formatCHF(ml.internalHourlyCost)} bold />
                                  <p className="text-[10px] text-purple-500 italic pt-0.5">= Vollkosten/Monat ({formatCHF(ml.totalMonthlyEmployerCost)}) ÷ 182 h</p>
                                </>;
                              })()}
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      (() => {
                        const empForCost = selectedEmp ?? editData;
                        if (!empForCost) return null;
                        const factor   = empForCost.socialCostFactor ?? DEFAULT_SOCIAL_COST_FACTOR;
                        const has13th  = empForCost.has13thSalary ?? false;
                        const hasSL    = empForCost.hourlyWage > 0 && empForCost.contractType !== 'monthly';
                        const mlHoursV = empForCost.weeklyHours || 42;
                        const hasML    = !!(empForCost.contractType === 'monthly' && empForCost.monthlySalary && empForCost.monthlySalary > 0)
                                      || !!(empForCost.monthlySalary && empForCost.monthlySalary > 0 && empForCost.weeklyHours && empForCost.weeklyHours > 0);
                        if (!hasSL && !hasML) return <p className="text-xs text-muted-foreground italic">Noch kein Lohn erfasst.</p>;

                        const LRow = ({ label, value, bold, sub }: { label: string; value: string; bold?: boolean; sub?: boolean }) => (
                          <div className={`flex justify-between text-xs ${sub ? 'pl-3' : ''}`}>
                            <span className={bold ? 'font-semibold text-purple-900 dark:text-purple-200' : 'text-purple-700 dark:text-purple-400'}>{label}</span>
                            <span className={bold ? 'font-semibold text-purple-900 dark:text-purple-200' : 'font-medium'}>{value}</span>
                          </div>
                        );
                        const Sep = () => <Separator className="my-1 bg-purple-200 dark:bg-purple-700" />;

                        return (
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
                              <DataRow
                                label="AG-Sozialkostenfaktor"
                                value={`${factor.toFixed(2)} (${((factor - 1) * 100).toFixed(1)}%)`}
                              />
                              <DataRow label="13. Monatslohn" value={has13th ? 'Ja – vereinbart' : 'Nicht vereinbart'} />
                              {hasML && empForCost.monthlySalary && (
                                <DataRow
                                  label="Fixlohn / Monat exkl. 13."
                                  value={formatCHF(empForCost.monthlySalary)}
                                />
                              )}
                              {hasML && (empForCost.monthlySalaryWith13th || (empForCost.monthlySalary && has13th)) && (
                                <DataRow
                                  label="Fixlohn / Monat inkl. 13."
                                  value={formatCHF(empForCost.monthlySalaryWith13th ?? (empForCost.monthlySalary! * 13 / 12))}
                                />
                              )}
                            </div>
                            <div className="rounded-lg bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 p-3 space-y-1">
                              <p className="font-semibold text-purple-800 dark:text-purple-300 flex items-center gap-1 mb-2 text-xs">
                                <Calculator className="h-3 w-3" />
                                {hasSL ? 'Stundenlohn-Aufschlüsselung (L-GAV)' : 'Monatslohn-Aufschlüsselung (L-GAV)'}
                              </p>

                              {hasSL && (() => {
                                const sl = calcSL(empForCost.hourlyWage, has13th, factor);
                                return <>
                                  <LRow label="Basis-Stundenlohn brutto" value={formatCHF(empForCost.hourlyWage)} />
                                  <LRow label={`+ Ferienentschädigung (${(LGAV.VACATION_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.vacationComp)} sub />
                                  <LRow label={`+ Feiertagsentschädigung (${(LGAV.PUBLIC_HOLIDAY_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.holidayComp)} sub />
                                  <Sep />
                                  <LRow label="Zwischensumme" value={formatCHF(sl.subtotal)} bold />
                                  {has13th && <LRow label={`+ 13. Monatslohn (${(LGAV.THIRTEENTH_RATE * 100).toFixed(2)}%)`} value={formatCHF(sl.thirteenthComp)} sub />}
                                  <Sep />
                                  <LRow label="Auszahlbarer Stundenlohn (Lohnzettel)" value={formatCHF(sl.totalPayableHourly)} bold />
                                  <LRow label={`+ AG-Sozialkosten (${((factor - 1) * 100).toFixed(1)}%)`} value={`+ ${formatCHF(sl.socialCostPerHour)}`} sub />
                                  <Sep />
                                  <LRow label="Interner Stundenansatz (Kostenstelle)" value={formatCHF(sl.internalHourlyCost)} bold />
                                  <p className="text-[10px] text-purple-500 italic pt-0.5">Gemäss L-GAV: Ferien + Feiertage bereits im Stundenlohn enthalten</p>
                                </>;
                              })()}

                              {hasML && (() => {
                                const ml     = calcML(empForCost.monthlySalary!, has13th, mlHoursV, factor);
                                const pensum = Math.round(mlHoursV / 42 * 100);
                                return <>
                                  <LRow label={`Monatslohn brutto — ${pensum}% Pensum (${mlHoursV} h/W)`} value={formatCHF(ml.baseSalaryMonthly)} />
                                  {has13th && <LRow label={`+ 13. Monatslohn (1/12 = ${(LGAV.THIRTEENTH_RATE * 100).toFixed(2)}%)`} value={formatCHF(ml.effectiveMonthlyGross - ml.baseSalaryMonthly)} sub />}
                                  {has13th && <><Sep /><LRow label="Effektiver Brutto/Monat (inkl. 13.)" value={formatCHF(ml.effectiveMonthlyGross)} bold /></>}
                                  <LRow label={`+ AG-Sozialkosten (${((factor - 1) * 100).toFixed(1)}%)`} value={`+ ${formatCHF(ml.socialCostMonthly)}`} sub />
                                  <Sep />
                                  <LRow label="Vollkosten pro Monat" value={formatCHF(ml.totalMonthlyEmployerCost)} bold />
                                  <LRow label="Jahresvollkosten" value={formatCHF(ml.annualEmployerCost)} sub />
                                  <Sep />
                                  <LRow label="Interner Stundenansatz (Kostenstelle)" value={formatCHF(ml.internalHourlyCost)} bold />
                                  <p className="text-[10px] text-purple-500 italic pt-0.5">= Vollkosten/Monat ({formatCHF(ml.totalMonthlyEmployerCost)}) ÷ 182 h</p>
                                </>;
                              })()}
                            </div>
                          </div>
                        );
                      })()
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ── Abschnitt 5: Salden & Konten ──────────────────────────── */}
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

              {/* ── Abschnitt 6: Notizen ──────────────────────────────────── */}
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

                </TabsContent>

                {/* ── Tab 2: Arbeitsvertrag ──────────────────────────────────── */}
                <TabsContent value="vertrag" className="space-y-4 mt-0">

              {/* ── Abschnitt 7: Arbeitsvertrag ───────────────────────────── */}
              {isAdmin && selectedEmp && contractDraft && (
                <Card>
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <FileSignature className="h-4 w-4 text-indigo-600" />
                        Vertragseinstellungen
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-normal border ${
                        detectContractTemplate(selectedEmp) === 'ML'
                          ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 text-blue-700'
                          : 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 text-orange-700'
                      }`}>
                        {detectContractTemplate(selectedEmp) === 'ML' ? 'ML – Monatslohn' : 'SL – Stundenlohn'}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">

                    {/* ── Interaktiver Vertragseditor ────────────────────── */}
                    {contractDraft && (
                      <div className="rounded-md border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-3 space-y-4 text-xs">

                        {/* Helper-Komponenten inline */}
                        {(() => {
                          const d = contractDraft;
                          const upd = (patch: Partial<ContractDraft>) => setContractDraft(prev => prev ? { ...prev, ...patch } : prev);

                          const CbRow = ({ checked, label, onClick }: { checked: boolean; label: string; onClick: () => void }) => (
                            <label className="flex items-start gap-2 cursor-pointer hover:bg-white/60 dark:hover:bg-white/5 rounded px-1 py-0.5">
                              <button
                                type="button"
                                onClick={onClick}
                                className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border text-center leading-none text-[10px] font-bold transition-colors ${
                                  checked
                                    ? 'bg-indigo-600 border-indigo-600 text-white'
                                    : 'bg-white dark:bg-background border-border'
                                }`}
                              >
                                {checked ? '✓' : ''}
                              </button>
                              <span className={checked ? 'font-medium text-foreground' : 'text-muted-foreground'}>{label}</span>
                            </label>
                          );

                          const SectionHead = ({ title }: { title: string }) => (
                            <p className="font-semibold text-indigo-700 dark:text-indigo-400 border-b border-indigo-200 dark:border-indigo-800 pb-0.5 mb-1.5">{title}</p>
                          );

                          return (
                            <>
                              {/* Art. 0 / Header: Vollzeit / Teilzeit (nur ML) */}
                              {detectContractTemplate(selectedEmp) === 'ML' && (
                                <div>
                                  <SectionHead title="Vertragsart (Kopfzeile)" />
                                  <CbRow checked={d.employmentMode === 'vollzeit'} label="a)  für Vollzeitmitarbeiter/in" onClick={() => upd({ employmentMode: 'vollzeit' })} />
                                  <CbRow checked={d.employmentMode === 'teilzeit'} label="b)  für Teilzeitmitarbeiter/in (mit regelmässigem, festgelegtem Arbeitspensum)" onClick={() => upd({ employmentMode: 'teilzeit' })} />
                                </div>
                              )}

                              {/* Art. 1c: Raucherbetrieb */}
                              <div>
                                <SectionHead title="Ziff. 1c – Raucherbetrieb" />
                                <CbRow checked={d.smokingConsent === 'aa'} label="aa)  Mitarbeitende/r stimmt Beschäftigung in Raucherbetrieb zu" onClick={() => upd({ smokingConsent: 'aa' })} />
                                <CbRow checked={d.smokingConsent === 'bb'} label="bb)  Mitarbeitende/r lehnt Beschäftigung in Raucherbetrieb ab" onClick={() => upd({ smokingConsent: 'bb' })} />
                              </div>

                              {/* Art. 2: Vertragsdauer */}
                              <div>
                                <SectionHead title="Ziff. 2 – Vertragsdauer" />
                                <CbRow checked={d.duration === 'unlimited'} label="a)  unbefristet, kündbar gemäss Ziff. 3 und 4" onClick={() => upd({ duration: 'unlimited' })} />
                                <CbRow checked={d.duration === 'limited_cancellable'} label={`b)  befristet bis ${d.endDate ?? '___________'}, kündbar`} onClick={() => upd({ duration: 'limited_cancellable' })} />
                                <CbRow checked={d.duration === 'limited_fixed'} label="c)  befristet, nicht kündbar" onClick={() => upd({ duration: 'limited_fixed' })} />
                                {(d.duration === 'limited_cancellable' || d.duration === 'limited_fixed') && (
                                  <div className="mt-1 ml-6">
                                    <Label className="text-[10px] text-muted-foreground mb-0.5 block">Vertragsende</Label>
                                    <Input type="date" className="h-6 text-xs w-36"
                                      value={d.endDate ?? ''}
                                      onChange={e => upd({ endDate: e.target.value || undefined })} />
                                  </div>
                                )}
                              </div>

                              {/* Art. 3: Probezeit */}
                              <div>
                                <SectionHead title="Ziff. 3 – Probezeit" />
                                <CbRow checked={d.probation === 'three_months_7d'} label="a)  3 Monate, 7 Tage Kündigungsfrist" onClick={() => upd({ probation: 'three_months_7d' })} />
                                <CbRow checked={d.probation === 'fourteen_days'}   label="b)  14 Tage, 3 Tage Kündigungsfrist" onClick={() => upd({ probation: 'fourteen_days' })} />
                                <CbRow checked={d.probation === 'none'}            label="c)  keine Probezeit" onClick={() => upd({ probation: 'none' })} />
                                <CbRow checked={d.probation === 'custom'}          label="d)  individuell (max. 3 Monate, min. 3 Tage Kündigungsfrist)" onClick={() => upd({ probation: 'custom' })} />
                                {d.probation === 'custom' && (
                                  <div className="mt-1 ml-6 flex gap-3">
                                    <div>
                                      <Label className="text-[10px] text-muted-foreground mb-0.5 block">Monate (1-3)</Label>
                                      <Input type="number" min={1} max={3} className="h-6 text-xs w-16"
                                        value={d.probationMonths ?? 3}
                                        onChange={e => upd({ probationMonths: Math.min(3, Math.max(1, +e.target.value || 1)) })} />
                                    </div>
                                    <div>
                                      <Label className="text-[10px] text-muted-foreground mb-0.5 block">Kündigung (Tage, min. 3)</Label>
                                      <Input type="number" min={3} className="h-6 text-xs w-16"
                                        value={d.probationNoticeDays ?? 3}
                                        onChange={e => upd({ probationNoticeDays: Math.max(3, +e.target.value || 3) })} />
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Art. 4: Kündigung */}
                              <div>
                                <SectionHead title="Ziff. 4 – Kündigung" />
                                <CbRow checked={d.notice === 'standard'} label="a)  Standard (1 Monat, ab 6. Dienstjahr 2 Monate, auf Monatsende)" onClick={() => upd({ notice: 'standard' })} />
                                <CbRow checked={d.notice === 'extended'} label="b)  längere Kündigungsfrist (individuell)" onClick={() => upd({ notice: 'extended' })} />
                                {d.notice === 'extended' && (
                                  <div className="mt-1 ml-6">
                                    <Label className="text-[10px] text-muted-foreground mb-0.5 block">Beschreibung</Label>
                                    <Input className="h-6 text-xs"
                                      value={d.noticeExtended ?? ''}
                                      onChange={e => upd({ noticeExtended: e.target.value })} />
                                  </div>
                                )}
                              </div>

                              {/* Art. 7: Berufsausbildung */}
                              <div>
                                <SectionHead title="Ziff. 7 – Berufsausbildung" />
                                {([
                                  ['eba',          'a) eidgenössisches Berufsattest (EBA)'],
                                  ['efz',          'b) eidgenössisches Fähigkeitszeugnis (EFZ)'],
                                  ['efz_plus',     'c) EFZ + mind. 6 Tage anerkannte Weiterbildung'],
                                  ['berufspruefung','d) Berufsprüfung nach Art. 27 lit. a BBG'],
                                  ['other_cert',   'e) anderes Zertifikat'],
                                  ['progresso',    'f) keine Lehre, aber Progresso-Ausbildung'],
                                  ['none',         'g) keine L-GAV-relevante Ausbildung'],
                                ] as [ContractDraft['education'], string][]).map(([val, label]) => (
                                  <CbRow key={val} checked={d.education === val} label={`${label}`} onClick={() => upd({ education: val })} />
                                ))}
                                {d.education === 'other_cert' && (
                                  <div className="mt-1 ml-6">
                                    <Label className="text-[10px] text-muted-foreground mb-0.5 block">Bezeichnung Zertifikat</Label>
                                    <Input className="h-6 text-xs"
                                      value={d.educationOtherText ?? ''}
                                      onChange={e => upd({ educationOtherText: e.target.value })} />
                                  </div>
                                )}
                              </div>

                              {/* Art. 9 Stufe I */}
                              <div>
                                <SectionHead title="Ziff. 9 – Lohnreduktion Stufe I (ungelernt)" />
                                <CbRow checked={d.wageRedI === 'first_12m'} label="a)  Erstanstellung – Reduktion 8% für erste 12 Monate" onClick={() => upd({ wageRedI: 'first_12m' })} />
                                <CbRow checked={d.wageRedI === 'first_3m'}  label="b)  Erfahren (> 4 Mt. in L-GAV) – Reduktion 8% für erste 3 Monate" onClick={() => upd({ wageRedI: 'first_3m' })} />
                                <CbRow checked={d.wageRedI === 'none'}      label="c)  kein Abzug während Einführungszeit" onClick={() => upd({ wageRedI: 'none' })} />
                              </div>

                              {/* Art. 9 Stufe II */}
                              <div>
                                <SectionHead title="Ziff. 9 – Lohnreduktion Stufe II/IIIa (EBA/EFZ)" />
                                <CbRow checked={d.wageRedII === 'first_3m'} label="a)  Erstanstellung nach Ausbildung – Reduktion 8% für erste 3 Monate" onClick={() => upd({ wageRedII: 'first_3m' })} />
                                <CbRow checked={d.wageRedII === 'none'}     label="b)  kein Abzug während Einführungszeit" onClick={() => upd({ wageRedII: 'none' })} />
                              </div>

                              {/* Art. 10d: Lohnauszahlung */}
                              <div>
                                <SectionHead title="Ziff. 10d – Lohnauszahlung" />
                                <CbRow checked={d.paymentTiming === 'last'}       label="a)  spätestens am letzten Tag des Monats" onClick={() => upd({ paymentTiming: 'last' })} />
                                <CbRow checked={d.paymentTiming === 'sixth'}      label="b)  spätestens am 6. des Folgemonats" onClick={() => upd({ paymentTiming: 'sixth' })} />
                                <CbRow checked={d.paymentTiming === 'collective'} label="c)  gemäss Art. 14 Ziff. 1 Abs. 2 L-GAV" onClick={() => upd({ paymentTiming: 'collective' })} />
                              </div>

                              {/* Art. 12a: Nachtarbeit */}
                              <div>
                                <SectionHead title="Ziff. 12a – Nachtarbeit" />
                                <CbRow checked={d.nightWork === 'aa'} label="aa)  24 – 7 Uhr" onClick={() => upd({ nightWork: 'aa' })} />
                                <CbRow checked={d.nightWork === 'bb'} label="bb)  22 – 5 Uhr" onClick={() => upd({ nightWork: 'bb' })} />
                                <CbRow checked={d.nightWork === 'cc'} label="cc)  23 – 6 Uhr" onClick={() => upd({ nightWork: 'cc' })} />
                                <CbRow checked={d.nightWork === 'dd'} label="dd)  23:30 – 6:30 Uhr" onClick={() => upd({ nightWork: 'dd' })} />
                              </div>

                              {/* Art. 12b: 6-Tage-Woche */}
                              <div>
                                <SectionHead title="Ziff. 12b – 6-Tage-Woche" />
                                <CbRow checked={d.sixDayWork}  label="b)  vorübergehend 6 Arbeitstage pro Woche (Einverständnis)" onClick={() => upd({ sixDayWork: !d.sixDayWork })} />
                              </div>

                              {/* Art. 13: Besondere Vereinbarungen */}
                              <div>
                                <SectionHead title="Ziff. 13 – Besondere Vereinbarungen" />
                                <Textarea
                                  className="text-xs min-h-[80px]"
                                  placeholder="Eine Vereinbarung pro Zeile…"
                                  value={d.specialAgreements}
                                  onChange={e => upd({ specialAgreements: e.target.value })}
                                />
                              </div>

                              {/* Zurücksetzen */}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[11px] text-muted-foreground w-full"
                                onClick={() => setContractDraft(defaultContractDraft(selectedEmp))}
                              >
                                ↺  Auf Standardwerte zurücksetzen
                              </Button>
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {/* Fehlende Pflichtfelder */}
                    {(() => {
                      const missing: string[] = [];
                      if (!selectedEmp.positionTitle) missing.push('Funktion / Stelle');
                      if (!selectedEmp.contractStart)  missing.push('Eintrittsdatum');
                      if (detectContractTemplate(selectedEmp) === 'ML' && !selectedEmp.monthlySalary) missing.push('Monatslohn');
                      if (detectContractTemplate(selectedEmp) === 'SL' && !selectedEmp.hourlyWage)    missing.push('Stundenlohn');
                      if (missing.length === 0) return null;
                      return (
                        <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                          <p className="font-semibold">Folgende Felder fehlen noch:</p>
                          <ul className="list-disc list-inside space-y-0.5">
                            {missing.map(f => <li key={f}>{f}</li>)}
                          </ul>
                          <p className="text-[11px] text-amber-600 dark:text-amber-500">Vertrag kann trotzdem generiert werden – fehlende Felder erscheinen als Lücken.</p>
                        </div>
                      );
                    })()}

                    {/* Generieren-Button */}
                    <Button
                      className="w-full h-9 text-sm bg-indigo-600 hover:bg-indigo-700 text-white"
                      onClick={handleGenerateContract}
                      disabled={generatingContract}
                    >
                      <FileSignature className="h-4 w-4 mr-2" />
                      {generatingContract ? 'Wird generiert…' : contractBlobUrl ? 'Vertrag neu generieren' : 'Vertrag generieren'}
                    </Button>

                    {/* Bereit-Banner + Download + Vorschau */}
                    {contractBlobUrl && (
                      <div className="space-y-2">
                        {/* Erfolgs-Banner */}
                        <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2 flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-emerald-800 dark:text-emerald-300">Vertrag generiert</p>
                            {contractPdfFileName && (
                              <p className="text-[11px] text-emerald-700 dark:text-emerald-400 truncate">{contractPdfFileName}</p>
                            )}
                          </div>
                        </div>

                        {/* Aktionsbuttons */}
                        <div className="flex gap-2">
                          <Button
                            variant="default"
                            size="sm"
                            className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={handleDownloadContract}
                          >
                            <Download className="h-3.5 w-3.5 mr-1.5" />
                            PDF herunterladen
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => window.open(contractBlobUrl, '_blank')}
                          >
                            <FileText className="h-3.5 w-3.5 mr-1.5" />
                            Im Browser öffnen
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs px-2"
                            onClick={handleGenerateContract}
                            title="Neu generieren"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        </div>

                        {/* Eingebettete Vorschau (object-Tag – breiter Browser-Support) */}
                        <div className="rounded-md border border-border overflow-hidden">
                          <object
                            data={contractBlobUrl}
                            type="application/pdf"
                            className="w-full"
                            style={{ height: '480px' }}
                          >
                            <div className="flex flex-col items-center justify-center h-32 text-xs text-muted-foreground gap-2 p-4">
                              <p>PDF-Vorschau nicht möglich — bitte herunterladen oder im Browser öffnen.</p>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleDownloadContract}>
                                <Download className="h-3 w-3 mr-1.5" /> PDF herunterladen
                              </Button>
                            </div>
                          </object>
                        </div>
                      </div>
                    )}

                    {/* Trennlinie & manuell hochladen */}
                    <div className="border-t border-border pt-2">
                      <p className="text-[11px] text-muted-foreground mb-1.5">Oder: bestehenden Vertrag manuell hochladen</p>
                      {selectedLocal.contractFileName && (
                        <div className="flex items-center gap-2 rounded-md bg-muted/30 border border-border px-3 py-1.5 mb-1.5">
                          <FileCheck className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />
                          <span className="text-xs text-foreground flex-1 truncate">{selectedLocal.contractFileName}</span>
                        </div>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs w-full border-dashed"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload className="h-3 w-3 mr-1.5" />
                        {selectedLocal.contractFileName ? 'Vertrag ersetzen' : 'Vertrag hochladen (.pdf)'}
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        className="hidden"
                        onChange={handleContractUpload}
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ── Abschnitt 8: Anhänge ──────────────────────────────────── */}
              <Card>
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Paperclip className="h-4 w-4 text-slate-500" />
                    Anhänge
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {(() => {
                    const docs: Array<{ type: string; name: string; url?: string; uploadedAt?: string }> =
                      (() => {
                        try {
                          return selectedEmp?.onboardingDocuments
                            ? JSON.parse(selectedEmp.onboardingDocuments)
                            : [];
                        } catch { return []; }
                      })();

                    const iconFor = (type: string) => {
                      if (type === 'permit') return <Shield className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />;
                      if (type === 'passport' || type === 'id') return <UserCheck className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />;
                      return <FileCheck className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />;
                    };

                    const labelFor = (type: string) => {
                      const map: Record<string, string> = {
                        permit: 'Aufenthaltsausweis',
                        passport: 'Reisepass',
                        id: 'Personalausweis',
                        contract: 'Arbeitsvertrag',
                        ahv: 'AHV-Ausweis',
                        other: 'Dokument',
                      };
                      return map[type] ?? type;
                    };

                    if (docs.length === 0) {
                      return (
                        <p className="text-xs text-muted-foreground italic">
                          Noch keine Dokumente hochgeladen. Werden nach Onboarding automatisch angezeigt.
                        </p>
                      );
                    }

                    return (
                      <div className="space-y-1.5">
                        {docs.map((doc, i) => (
                          <div key={i} className="flex items-center gap-2 rounded-md bg-muted/30 border border-border px-3 py-1.5">
                            {iconFor(doc.type)}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate">{doc.name || labelFor(doc.type)}</p>
                              <p className="text-[10px] text-muted-foreground">{labelFor(doc.type)}{doc.uploadedAt ? ` · ${new Date(doc.uploadedAt).toLocaleDateString('de-CH')}` : ''}</p>
                            </div>
                            {doc.url && (
                              <a href={doc.url} target="_blank" rel="noopener noreferrer">
                                <Button variant="ghost" size="sm" className="h-6 text-[10px]">Öffnen</Button>
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

                </TabsContent>
              </Tabs>

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
