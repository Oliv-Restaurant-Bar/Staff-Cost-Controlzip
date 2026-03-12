import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Lock, Eye, EyeOff, Shield, Percent, Save, RotateCcw, ShieldCheck, ShieldOff, Users, Trash2, ArrowRightLeft, AlertCircle, Pencil, Check, X, Download, Upload, Database, HardDrive, FileArchive, History, Mail, Clock, MoreVertical, Archive, CheckSquare, Square, Key, CloudUpload, Loader2, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { PasswordProtection, PASSWORD_PROTECTION_ENABLED_KEY } from '@/components/PasswordProtection';
import { GLOBAL_SITE_PROTECTION_ENABLED_KEY } from '@/components/GlobalSiteProtection';
import { Switch } from '@/components/ui/switch';
import { loadSavedNameMappings, deleteNameMapping, clearAllNameMappings, updateNameMapping, exportNameMappings, parseImportedMappings, applyImportWithConflicts, resetToDefaultMappings, SavedNameMapping, ImportConflict } from '@/lib/name-matching';
import { ImportConflictDialog } from '@/components/ImportConflictDialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { downloadBackup, parseBackupFile, getBackupSummary, restoreFromBackup, getStorageInfo, getCurrentBackupPreview, BackupData, ExportOptions, SavedBackupVersion, getSavedBackupVersions, saveBackupToBrowser, deleteBackupVersion, restoreFromBrowserBackup, downloadBrowserBackup, getBackupVersionData, sendBackupEmail, renameBackupVersion, exportBackupsAsZip } from '@/lib/full-backup';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DepartmentTokenManager } from '@/components/DepartmentTokenManager';
import { CronJobOverview } from '@/components/CronJobOverview';
import { migrateLocalStorageToSupabase } from '@/hooks/useSupabaseSchedule';
import { CapacitySettingsCard } from '@/components/CapacitySettingsCard';

const DEFAULT_PASSWORD = 'admin123';

// Default revenue distribution percentages
const DEFAULT_WEEKDAY_PERCENTAGES: Record<number, number> = {
  0: 10, // Sunday
  1: 10, // Monday
  2: 10, // Tuesday
  3: 10, // Wednesday
  4: 10, // Thursday
  5: 25, // Friday
  6: 25, // Saturday
};

const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAY_PERCENTAGES_KEY = 'revenue_weekday_percentages';
const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
const DEFAULT_LABOR_COST_THRESHOLD = 40;

const Settings = () => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  
  // Password protection enabled state (for sensitive areas)
  const [passwordProtectionEnabled, setPasswordProtectionEnabled] = useState<boolean>(() => {
    return localStorage.getItem(PASSWORD_PROTECTION_ENABLED_KEY) === 'true';
  });
  
  // Global site protection enabled state (for entire site login)
  const [globalSiteProtectionEnabled, setGlobalSiteProtectionEnabled] = useState<boolean>(() => {
    return localStorage.getItem(GLOBAL_SITE_PROTECTION_ENABLED_KEY) === 'true';
  });
  
  // Weekday percentages state
  const [weekdayPercentages, setWeekdayPercentages] = useState<Record<number, number>>(() => {
    const saved = localStorage.getItem(WEEKDAY_PERCENTAGES_KEY);
    return saved ? JSON.parse(saved) : DEFAULT_WEEKDAY_PERCENTAGES;
  });
  
  // Labor cost threshold state
  const [laborCostThreshold, setLaborCostThreshold] = useState<number>(() => {
    const saved = localStorage.getItem(LABOR_COST_THRESHOLD_KEY);
    return saved ? parseFloat(saved) : DEFAULT_LABOR_COST_THRESHOLD;
  });

  // Name mappings state
  const [nameMappings, setNameMappings] = useState<SavedNameMapping[]>([]);
  const [editingMapping, setEditingMapping] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  
  // Import conflict dialog state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [pendingNewMappings, setPendingNewMappings] = useState<SavedNameMapping[]>([]);
  const [pendingConflicts, setPendingConflicts] = useState<ImportConflict[]>([]);
  
  // Backup state
  const [storageInfo, setStorageInfo] = useState(() => getStorageInfo());
  const [backupPreview, setBackupPreview] = useState<{ backup: BackupData; summary: ReturnType<typeof getBackupSummary> } | null>(null);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [exportPreview, setExportPreview] = useState<ReturnType<typeof getBackupSummary> | null>(null);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    employees: true,
    schedules: true,
    shiftConfig: true,
    nameMappings: true,
    revenues: true,
    budgets: true,
    settings: true,
    other: true
  });
  const [importOptions, setImportOptions] = useState<ExportOptions>({
    employees: true,
    schedules: true,
    shiftConfig: true,
    nameMappings: true,
    revenues: true,
    budgets: true,
    settings: true,
    other: true
  });
  
  // Backup versioning state
  const [savedBackups, setSavedBackups] = useState<SavedBackupVersion[]>(() => getSavedBackupVersions());
  const [showBackupHistory, setShowBackupHistory] = useState(false);
  const [selectedBrowserBackup, setSelectedBrowserBackup] = useState<SavedBackupVersion | null>(null);
  const [showBrowserRestoreConfirm, setShowBrowserRestoreConfirm] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [renamingBackupId, setRenamingBackupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [selectedBackupIds, setSelectedBackupIds] = useState<Set<string>>(new Set());
  const [isExportingZip, setIsExportingZip] = useState(false);
  
  // Migration state
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationDone, setMigrationDone] = useState(() => {
    return localStorage.getItem('supabase-migration-done') === 'true';
  });

  useEffect(() => {
    setNameMappings(loadSavedNameMappings());
    setStorageInfo(getStorageInfo());
    setSavedBackups(getSavedBackupVersions());
  }, []);

  // Backup handlers
  const handleShowExportPreview = () => {
    const preview = getCurrentBackupPreview();
    setExportPreview(preview.summary);
    // Reset to all selected
    setExportOptions({
      employees: preview.summary.employees,
      schedules: preview.summary.schedules.length > 0,
      shiftConfig: preview.summary.shiftConfig,
      nameMappings: preview.summary.nameMappings,
      revenues: preview.summary.revenues.length > 0,
      budgets: preview.summary.budgets.length > 0,
      settings: preview.summary.settings,
      other: preview.summary.other > 0
    });
    setShowExportPreview(true);
  };

  const handleToggleExportOption = (key: keyof ExportOptions) => {
    setExportOptions(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectAllExport = () => {
    if (!exportPreview) return;
    setExportOptions({
      employees: exportPreview.employees,
      schedules: exportPreview.schedules.length > 0,
      shiftConfig: exportPreview.shiftConfig,
      nameMappings: exportPreview.nameMappings,
      revenues: exportPreview.revenues.length > 0,
      budgets: exportPreview.budgets.length > 0,
      settings: exportPreview.settings,
      other: exportPreview.other > 0
    });
  };

  const handleDeselectAllExport = () => {
    setExportOptions({
      employees: false,
      schedules: false,
      shiftConfig: false,
      nameMappings: false,
      revenues: false,
      budgets: false,
      settings: false,
      other: false
    });
  };

  const getSelectedCount = () => {
    if (!exportPreview) return 0;
    let count = 0;
    if (exportOptions.employees && exportPreview.employees) count++;
    if (exportOptions.schedules && exportPreview.schedules.length > 0) count += exportPreview.schedules.length;
    if (exportOptions.shiftConfig && exportPreview.shiftConfig) count++;
    if (exportOptions.nameMappings && exportPreview.nameMappings) count++;
    if (exportOptions.revenues && exportPreview.revenues.length > 0) count += exportPreview.revenues.length;
    if (exportOptions.budgets && exportPreview.budgets.length > 0) count += exportPreview.budgets.length;
    if (exportOptions.settings && exportPreview.settings) count++;
    if (exportOptions.other && exportPreview.other > 0) count += exportPreview.other;
    return count;
  };

  const hasAnySelected = Object.values(exportOptions).some(v => v);

  const handleConfirmExport = (saveToLocal: boolean = true) => {
    if (saveToLocal) {
      downloadBackup(exportOptions);
      const count = getSelectedCount();
      toast.success(`Backup mit ${count} Einträgen heruntergeladen`);
    }
    setShowExportPreview(false);
    setExportPreview(null);
  };

  const handleSaveToBrowser = () => {
    saveBackupToBrowser(undefined, exportOptions);
    setSavedBackups(getSavedBackupVersions());
    const count = getSelectedCount();
    toast.success(`Backup mit ${count} Einträgen im Browser gespeichert`);
    setShowExportPreview(false);
    setExportPreview(null);
  };

  const handleSendBackupEmail = async () => {
    setIsSendingEmail(true);
    const result = await sendBackupEmail(exportOptions);
    setIsSendingEmail(false);
    
    if (result.success) {
      toast.success('Backup per E-Mail an dine@malenas.ch gesendet');
      setShowExportPreview(false);
      setExportPreview(null);
    } else {
      toast.error(result.error || 'E-Mail-Versand fehlgeschlagen');
    }
  };

  const handleDeleteBrowserBackup = (id: string) => {
    deleteBackupVersion(id);
    setSavedBackups(getSavedBackupVersions());
    toast.success('Backup-Version gelöscht');
  };

  const handleRestoreBrowserBackup = (backup: SavedBackupVersion) => {
    setSelectedBrowserBackup(backup);
    const backupData = getBackupVersionData(backup.id);
    if (backupData) {
      const summary = getBackupSummary(backupData);
      setBackupPreview({ backup: backupData, summary });
      setImportOptions({
        employees: summary.employees,
        schedules: summary.schedules.length > 0,
        shiftConfig: summary.shiftConfig,
        nameMappings: summary.nameMappings,
        revenues: summary.revenues.length > 0,
        budgets: summary.budgets.length > 0,
        settings: summary.settings,
        other: summary.other > 0
      });
    }
    setShowBrowserRestoreConfirm(true);
  };

  const handleConfirmBrowserRestore = () => {
    if (!selectedBrowserBackup) return;
    
    const result = restoreFromBrowserBackup(selectedBrowserBackup.id, importOptions);
    if (result.success) {
      toast.success(`${result.restoredCount} Einträge wiederhergestellt. Seite wird neu geladen...`);
      setShowBrowserRestoreConfirm(false);
      setSelectedBrowserBackup(null);
      setBackupPreview(null);
      setTimeout(() => window.location.reload(), 1000);
    } else {
      toast.error(result.error || 'Wiederherstellung fehlgeschlagen');
    }
  };

  const handleDownloadBrowserBackup = (id: string) => {
    downloadBrowserBackup(id);
    toast.success('Backup heruntergeladen');
  };

  const handleStartRename = (backup: SavedBackupVersion) => {
    setRenamingBackupId(backup.id);
    setRenameValue(backup.name);
  };

  const handleConfirmRename = () => {
    if (!renamingBackupId || !renameValue.trim()) return;
    renameBackupVersion(renamingBackupId, renameValue.trim());
    setSavedBackups(getSavedBackupVersions());
    setRenamingBackupId(null);
    setRenameValue('');
    toast.success('Backup umbenannt');
  };

  const handleCancelRename = () => {
    setRenamingBackupId(null);
    setRenameValue('');
  };

  const handleToggleBackupSelection = (id: string) => {
    setSelectedBackupIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleSelectAllBackups = () => {
    if (selectedBackupIds.size === savedBackups.length) {
      setSelectedBackupIds(new Set());
    } else {
      setSelectedBackupIds(new Set(savedBackups.map(b => b.id)));
    }
  };

  const handleExportSelectedAsZip = async () => {
    if (selectedBackupIds.size === 0) {
      toast.error('Keine Backups ausgewählt');
      return;
    }
    
    setIsExportingZip(true);
    const result = await exportBackupsAsZip(Array.from(selectedBackupIds));
    setIsExportingZip(false);
    
    if (result.success) {
      toast.success(`${selectedBackupIds.size} Backup(s) als ZIP exportiert`);
      setSelectedBackupIds(new Set());
    } else {
      toast.error(result.error || 'Export fehlgeschlagen');
    }
  };

  const handleImportBackupFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const result = parseBackupFile(content);
      
      if (!result.success || !result.backup) {
        toast.error(result.error || 'Import fehlgeschlagen');
        return;
      }
      
      const summary = getBackupSummary(result.backup);
      setBackupPreview({ backup: result.backup, summary });
      // Reset import options based on what's in the backup
      setImportOptions({
        employees: summary.employees,
        schedules: summary.schedules.length > 0,
        shiftConfig: summary.shiftConfig,
        nameMappings: summary.nameMappings,
        revenues: summary.revenues.length > 0,
        budgets: summary.budgets.length > 0,
        settings: summary.settings,
        other: summary.other > 0
      });
      setShowBackupConfirm(true);
    };
    reader.readAsText(file);
    
    if (backupFileInputRef.current) {
      backupFileInputRef.current.value = '';
    }
  };

  const handleToggleImportOption = (key: keyof ExportOptions) => {
    setImportOptions(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectAllImport = () => {
    if (!backupPreview) return;
    setImportOptions({
      employees: backupPreview.summary.employees,
      schedules: backupPreview.summary.schedules.length > 0,
      shiftConfig: backupPreview.summary.shiftConfig,
      nameMappings: backupPreview.summary.nameMappings,
      revenues: backupPreview.summary.revenues.length > 0,
      budgets: backupPreview.summary.budgets.length > 0,
      settings: backupPreview.summary.settings,
      other: backupPreview.summary.other > 0
    });
  };

  const handleDeselectAllImport = () => {
    setImportOptions({
      employees: false,
      schedules: false,
      shiftConfig: false,
      nameMappings: false,
      revenues: false,
      budgets: false,
      settings: false,
      other: false
    });
  };

  const getImportSelectedCount = () => {
    if (!backupPreview) return 0;
    let count = 0;
    if (importOptions.employees && backupPreview.summary.employees) count++;
    if (importOptions.schedules && backupPreview.summary.schedules.length > 0) count += backupPreview.summary.schedules.length;
    if (importOptions.shiftConfig && backupPreview.summary.shiftConfig) count++;
    if (importOptions.nameMappings && backupPreview.summary.nameMappings) count++;
    if (importOptions.revenues && backupPreview.summary.revenues.length > 0) count += backupPreview.summary.revenues.length;
    if (importOptions.budgets && backupPreview.summary.budgets.length > 0) count += backupPreview.summary.budgets.length;
    if (importOptions.settings && backupPreview.summary.settings) count++;
    if (importOptions.other && backupPreview.summary.other > 0) count += backupPreview.summary.other;
    return count;
  };

  const hasAnyImportSelected = Object.values(importOptions).some(v => v);

  const handleConfirmRestore = () => {
    if (!backupPreview) return;
    
    const result = restoreFromBackup(backupPreview.backup, importOptions);
    if (result.success) {
      toast.success(`${result.restoredCount} Einträge wiederhergestellt. Seite wird neu geladen...`);
      setShowBackupConfirm(false);
      setBackupPreview(null);
      setTimeout(() => window.location.reload(), 1000);
    } else {
      toast.error(result.error || 'Wiederherstellung fehlgeschlagen');
    }
  };

  const handleDeleteMapping = (importedName: string) => {
    deleteNameMapping(importedName);
    setNameMappings(loadSavedNameMappings());
    toast.success('Zuordnung gelöscht');
  };

  const handleClearAllMappings = () => {
    clearAllNameMappings();
    setNameMappings([]);
    toast.success('Alle Zuordnungen gelöscht');
  };

  const handleResetToDefaults = () => {
    resetToDefaultMappings();
    setNameMappings(loadSavedNameMappings());
    toast.success('Zuordnungen auf Standard zurückgesetzt');
  };

  const handleStartEdit = (mapping: SavedNameMapping) => {
    setEditingMapping(mapping.importedName);
    setEditValue(mapping.employeeName);
  };

  const handleCancelEdit = () => {
    setEditingMapping(null);
    setEditValue('');
  };

  const handleSaveEdit = (importedName: string) => {
    if (!editValue.trim()) {
      toast.error('Name darf nicht leer sein');
      return;
    }
    updateNameMapping(importedName, editValue.trim());
    setNameMappings(loadSavedNameMappings());
    setEditingMapping(null);
    setEditValue('');
    toast.success('Zuordnung aktualisiert');
  };

  const handleExportMappings = () => {
    const json = exportNameMappings();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `namenszuordnungen-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Zuordnungen exportiert');
  };

  const handleImportMappings = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const result = parseImportedMappings(content);
      
      if (!result.success) {
        toast.error(result.errors[0] || 'Import fehlgeschlagen');
        return;
      }
      
      // If there are conflicts, show the dialog
      if (result.conflicts.length > 0) {
        setPendingNewMappings(result.newMappings);
        setPendingConflicts(result.conflicts);
        setConflictDialogOpen(true);
      } else {
        // No conflicts, apply directly
        const imported = applyImportWithConflicts(result.newMappings, []);
        setNameMappings(loadSavedNameMappings());
        toast.success(`${imported} Zuordnung${imported !== 1 ? 'en' : ''} importiert`);
      }
      
      if (result.errors.length > 0) {
        toast.warning(`${result.errors.length} Einträge übersprungen`);
      }
    };
    reader.readAsText(file);
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleConflictResolution = (updatedConflicts: ImportConflict[]) => {
    setPendingConflicts(updatedConflicts);
  };

  const handleApplyImport = () => {
    const imported = applyImportWithConflicts(pendingNewMappings, pendingConflicts);
    setNameMappings(loadSavedNameMappings());
    setConflictDialogOpen(false);
    setPendingNewMappings([]);
    setPendingConflicts([]);
    toast.success(`${imported} Zuordnung${imported !== 1 ? 'en' : ''} importiert`);
  };

  const handlePasswordProtectionToggle = (enabled: boolean) => {
    setPasswordProtectionEnabled(enabled);
    localStorage.setItem(PASSWORD_PROTECTION_ENABLED_KEY, enabled.toString());
    if (enabled) {
      toast.success('Passwortschutz aktiviert');
    } else {
      toast.success('Passwortschutz deaktiviert');
    }
  };
  
  const handleGlobalSiteProtectionToggle = (enabled: boolean) => {
    setGlobalSiteProtectionEnabled(enabled);
    localStorage.setItem(GLOBAL_SITE_PROTECTION_ENABLED_KEY, enabled.toString());
    if (enabled) {
      toast.success('Globaler Passwortschutz aktiviert - Die Seite erfordert nun beim Laden ein Passwort');
    } else {
      // Clear the session unlock status so user doesn't stay logged in
      sessionStorage.removeItem('global_site_unlocked');
      toast.success('Globaler Passwortschutz deaktiviert');
    }
  };

  const totalPercentage = Object.values(weekdayPercentages).reduce((sum, val) => sum + val, 0);

  const handlePercentageChange = (weekday: number, value: string) => {
    const numValue = parseFloat(value) || 0;
    setWeekdayPercentages(prev => ({
      ...prev,
      [weekday]: Math.max(0, Math.min(100, numValue))
    }));
  };

  const savePercentages = () => {
    if (Math.abs(totalPercentage - 100) > 0.1) {
      toast.error(`Summe muss 100% ergeben (aktuell: ${totalPercentage}%)`);
      return;
    }
    localStorage.setItem(WEEKDAY_PERCENTAGES_KEY, JSON.stringify(weekdayPercentages));
    toast.success('Umsatzverteilung gespeichert');
  };

  const resetPercentages = () => {
    setWeekdayPercentages(DEFAULT_WEEKDAY_PERCENTAGES);
    localStorage.setItem(WEEKDAY_PERCENTAGES_KEY, JSON.stringify(DEFAULT_WEEKDAY_PERCENTAGES));
    toast.success('Umsatzverteilung auf Standard zurückgesetzt');
  };

  const saveLaborThreshold = () => {
    if (laborCostThreshold <= 0 || laborCostThreshold > 100) {
      toast.error('Schwellenwert muss zwischen 1 und 100% liegen');
      return;
    }
    localStorage.setItem(LABOR_COST_THRESHOLD_KEY, laborCostThreshold.toString());
    toast.success('Personalkostenquote-Schwellenwert gespeichert');
  };

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    
    const storedPassword = localStorage.getItem('admin_password') || DEFAULT_PASSWORD;
    
    if (currentPassword !== storedPassword) {
      toast.error('Aktuelles Passwort ist falsch');
      return;
    }
    
    if (newPassword.length < 4) {
      toast.error('Neues Passwort muss mindestens 4 Zeichen haben');
      return;
    }
    
    if (newPassword !== confirmPassword) {
      toast.error('Passwörter stimmen nicht überein');
      return;
    }
    
    localStorage.setItem('admin_password', newPassword);
    toast.success('Passwort wurde erfolgreich geändert');
    
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleResetPassword = () => {
    localStorage.removeItem('admin_password');
    toast.success('Passwort wurde auf Standard zurückgesetzt (admin123)');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <PasswordProtection storageKey="settings_unlocked">
      <div className="min-h-screen bg-background">
        {/* Import Conflict Dialog */}
        <ImportConflictDialog
          open={conflictDialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setConflictDialogOpen(false);
              setPendingNewMappings([]);
              setPendingConflicts([]);
            }
          }}
          conflicts={pendingConflicts}
          newMappings={pendingNewMappings}
          onConfirm={(updatedConflicts) => {
            handleConflictResolution(updatedConflicts);
            handleApplyImport();
          }}
        />
        
        {/* Backup Restore Confirm Dialog with selective import */}
        <Dialog open={showBackupConfirm} onOpenChange={(open) => {
          if (!open) {
            setBackupPreview(null);
            setShowBackupConfirm(false);
          }
        }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-green-500" />
                Backup wiederherstellen
              </DialogTitle>
              <DialogDescription>
                Backup vom <strong>{backupPreview?.backup.exportedAt ? new Date(backupPreview.backup.exportedAt).toLocaleDateString('de-DE', { 
                  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
                }) : ''}</strong> - Wähle aus, was wiederhergestellt werden soll:
              </DialogDescription>
            </DialogHeader>
            
            {backupPreview && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Verfügbare Daten:</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={handleSelectAllImport} className="h-7 text-xs">
                      Alle auswählen
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleDeselectAllImport} className="h-7 text-xs">
                      Keine
                    </Button>
                  </div>
                </div>
                
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {backupPreview.summary.employees && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${importOptions.employees ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={importOptions.employees} 
                          onCheckedChange={() => handleToggleImportOption('employees')}
                        />
                        <Users className="h-4 w-4 text-blue-500" />
                        <span>Mitarbeiterdaten</span>
                      </div>
                      {backupPreview.summary.employeeCount && (
                        <Badge variant="outline">{backupPreview.summary.employeeCount} Mitarbeiter</Badge>
                      )}
                    </label>
                  )}
                  
                  {backupPreview.summary.schedules.length > 0 && (
                    <label className={`block p-2 rounded cursor-pointer transition-colors ${importOptions.schedules ? 'bg-green-500/10 border border-green-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Checkbox 
                            checked={importOptions.schedules} 
                            onCheckedChange={() => handleToggleImportOption('schedules')}
                          />
                          <Database className="h-4 w-4 text-green-500" />
                          <span>Dienstpläne</span>
                        </div>
                        <Badge variant="outline">{backupPreview.summary.schedules.length} Monat(e)</Badge>
                      </div>
                      <div className="mt-1 ml-9 text-xs text-muted-foreground flex flex-wrap gap-1">
                        {backupPreview.summary.schedules.slice(0, 6).map(s => (
                          <span key={s} className="bg-background px-1.5 py-0.5 rounded">{s}</span>
                        ))}
                        {backupPreview.summary.schedules.length > 6 && (
                          <span className="text-muted-foreground">+{backupPreview.summary.schedules.length - 6} weitere</span>
                        )}
                      </div>
                    </label>
                  )}
                  
                  {backupPreview.summary.shiftConfig && (
                    <label className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${importOptions.shiftConfig ? 'bg-purple-500/10 border border-purple-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <Checkbox 
                        checked={importOptions.shiftConfig} 
                        onCheckedChange={() => handleToggleImportOption('shiftConfig')}
                      />
                      <Shield className="h-4 w-4 text-purple-500" />
                      <span>Schicht-Konfiguration</span>
                    </label>
                  )}
                  
                  {backupPreview.summary.nameMappings && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${importOptions.nameMappings ? 'bg-purple-500/10 border border-purple-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={importOptions.nameMappings} 
                          onCheckedChange={() => handleToggleImportOption('nameMappings')}
                        />
                        <ArrowRightLeft className="h-4 w-4 text-purple-500" />
                        <span>Namenszuordnungen</span>
                      </div>
                      {backupPreview.summary.nameMappingCount && (
                        <Badge variant="outline">{backupPreview.summary.nameMappingCount} Einträge</Badge>
                      )}
                    </label>
                  )}
                  
                  {backupPreview.summary.revenues.length > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${importOptions.revenues ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={importOptions.revenues} 
                          onCheckedChange={() => handleToggleImportOption('revenues')}
                        />
                        <Percent className="h-4 w-4 text-amber-500" />
                        <span>Umsatzdaten</span>
                      </div>
                      <Badge variant="outline">{backupPreview.summary.revenues.length} Monat(e)</Badge>
                    </label>
                  )}
                  
                  {backupPreview.summary.budgets.length > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${importOptions.budgets ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={importOptions.budgets} 
                          onCheckedChange={() => handleToggleImportOption('budgets')}
                        />
                        <HardDrive className="h-4 w-4 text-cyan-500" />
                        <span>Budget-Daten</span>
                      </div>
                      <Badge variant="outline">{backupPreview.summary.budgets.length} Monat(e)</Badge>
                    </label>
                  )}
                  
                  {backupPreview.summary.settings && (
                    <label className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${importOptions.settings ? 'bg-gray-500/10 border border-gray-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <Checkbox 
                        checked={importOptions.settings} 
                        onCheckedChange={() => handleToggleImportOption('settings')}
                      />
                      <Shield className="h-4 w-4 text-gray-500" />
                      <span>Einstellungen</span>
                    </label>
                  )}
                  
                  {backupPreview.summary.other > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${importOptions.other ? 'bg-gray-400/10 border border-gray-400/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={importOptions.other} 
                          onCheckedChange={() => handleToggleImportOption('other')}
                        />
                        <FileArchive className="h-4 w-4 text-gray-400" />
                        <span>Weitere Daten</span>
                      </div>
                      <Badge variant="outline">{backupPreview.summary.other} Einträge</Badge>
                    </label>
                  )}
                </div>
                
                <div className="text-sm border-t pt-3 flex items-center justify-between">
                  <span className="text-muted-foreground">
                    <strong>Ausgewählt:</strong> {getImportSelectedCount()} von {backupPreview.summary.totalKeys} Einträgen
                  </span>
                  <Badge variant="secondary">{backupPreview.summary.totalSize}</Badge>
                </div>
                
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700 dark:text-amber-300">
                  ⚠️ Die ausgewählten Daten werden überschrieben!
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setBackupPreview(null);
                setShowBackupConfirm(false);
              }}>
                Abbrechen
              </Button>
              <Button onClick={handleConfirmRestore} disabled={!hasAnyImportSelected}>
                <Upload className="h-4 w-4 mr-2" />
                {hasAnyImportSelected ? 'Wiederherstellen' : 'Nichts ausgewählt'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Export Preview Dialog */}
        <Dialog open={showExportPreview} onOpenChange={setShowExportPreview}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileArchive className="h-5 w-5 text-blue-500" />
                Backup-Vorschau
              </DialogTitle>
              <DialogDescription>
                Wähle aus, welche Daten exportiert werden sollen:
              </DialogDescription>
            </DialogHeader>
            
            {exportPreview && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Verfügbare Daten:</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={handleSelectAllExport} className="h-7 text-xs">
                      Alle auswählen
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleDeselectAllExport} className="h-7 text-xs">
                      Keine
                    </Button>
                  </div>
                </div>
                
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {exportPreview.employees && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${exportOptions.employees ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={exportOptions.employees} 
                          onCheckedChange={() => handleToggleExportOption('employees')}
                        />
                        <Users className="h-4 w-4 text-blue-500" />
                        <span>Mitarbeiterdaten</span>
                      </div>
                      {exportPreview.employeeCount && (
                        <Badge variant="outline">{exportPreview.employeeCount} Mitarbeiter</Badge>
                      )}
                    </label>
                  )}
                  
                  {exportPreview.schedules.length > 0 && (
                    <label className={`block p-2 rounded cursor-pointer transition-colors ${exportOptions.schedules ? 'bg-green-500/10 border border-green-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Checkbox 
                            checked={exportOptions.schedules} 
                            onCheckedChange={() => handleToggleExportOption('schedules')}
                          />
                          <Database className="h-4 w-4 text-green-500" />
                          <span>Dienstpläne</span>
                        </div>
                        <Badge variant="outline">{exportPreview.schedules.length} Monat(e)</Badge>
                      </div>
                      <div className="mt-1 ml-9 text-xs text-muted-foreground flex flex-wrap gap-1">
                        {exportPreview.schedules.slice(0, 6).map(s => (
                          <span key={s} className="bg-background px-1.5 py-0.5 rounded">{s}</span>
                        ))}
                        {exportPreview.schedules.length > 6 && (
                          <span className="text-muted-foreground">+{exportPreview.schedules.length - 6} weitere</span>
                        )}
                      </div>
                    </label>
                  )}
                  
                  {exportPreview.shiftConfig && (
                    <label className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${exportOptions.shiftConfig ? 'bg-purple-500/10 border border-purple-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <Checkbox 
                        checked={exportOptions.shiftConfig} 
                        onCheckedChange={() => handleToggleExportOption('shiftConfig')}
                      />
                      <Shield className="h-4 w-4 text-purple-500" />
                      <span>Schicht-Konfiguration</span>
                    </label>
                  )}
                  
                  {exportPreview.nameMappings && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${exportOptions.nameMappings ? 'bg-purple-500/10 border border-purple-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={exportOptions.nameMappings} 
                          onCheckedChange={() => handleToggleExportOption('nameMappings')}
                        />
                        <ArrowRightLeft className="h-4 w-4 text-purple-500" />
                        <span>Namenszuordnungen</span>
                      </div>
                      {exportPreview.nameMappingCount && (
                        <Badge variant="outline">{exportPreview.nameMappingCount} Einträge</Badge>
                      )}
                    </label>
                  )}
                  
                  {exportPreview.revenues.length > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${exportOptions.revenues ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={exportOptions.revenues} 
                          onCheckedChange={() => handleToggleExportOption('revenues')}
                        />
                        <Percent className="h-4 w-4 text-amber-500" />
                        <span>Umsatzdaten</span>
                      </div>
                      <Badge variant="outline">{exportPreview.revenues.length} Monat(e)</Badge>
                    </label>
                  )}
                  
                  {exportPreview.budgets.length > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${exportOptions.budgets ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={exportOptions.budgets} 
                          onCheckedChange={() => handleToggleExportOption('budgets')}
                        />
                        <HardDrive className="h-4 w-4 text-cyan-500" />
                        <span>Budget-Daten</span>
                      </div>
                      <Badge variant="outline">{exportPreview.budgets.length} Monat(e)</Badge>
                    </label>
                  )}
                  
                  {exportPreview.settings && (
                    <label className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${exportOptions.settings ? 'bg-gray-500/10 border border-gray-500/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <Checkbox 
                        checked={exportOptions.settings} 
                        onCheckedChange={() => handleToggleExportOption('settings')}
                      />
                      <Shield className="h-4 w-4 text-gray-500" />
                      <span>Einstellungen</span>
                    </label>
                  )}
                  
                  {exportPreview.other > 0 && (
                    <label className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${exportOptions.other ? 'bg-gray-400/10 border border-gray-400/30' : 'bg-muted/50 hover:bg-muted'}`}>
                      <div className="flex items-center gap-3">
                        <Checkbox 
                          checked={exportOptions.other} 
                          onCheckedChange={() => handleToggleExportOption('other')}
                        />
                        <FileArchive className="h-4 w-4 text-gray-400" />
                        <span>Weitere Daten</span>
                      </div>
                      <Badge variant="outline">{exportPreview.other} Einträge</Badge>
                    </label>
                  )}
                </div>
                
                <div className="text-sm border-t pt-3 flex items-center justify-between">
                  <span className="text-muted-foreground">
                    <strong>Ausgewählt:</strong> {getSelectedCount()} von {exportPreview.totalKeys} Einträgen
                  </span>
                  <Badge variant="secondary">{exportPreview.totalSize}</Badge>
                </div>
              </div>
            )}
            
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setShowExportPreview(false)}>
                Abbrechen
              </Button>
              <Button variant="secondary" onClick={handleSaveToBrowser} disabled={!hasAnySelected}>
                <History className="h-4 w-4 mr-2" />
                Im Browser speichern
              </Button>
              <Button variant="secondary" onClick={handleSendBackupEmail} disabled={!hasAnySelected || isSendingEmail}>
                <Mail className="h-4 w-4 mr-2" />
                {isSendingEmail ? 'Sende...' : 'Per E-Mail senden'}
              </Button>
              <Button onClick={() => handleConfirmExport(true)} disabled={!hasAnySelected}>
                <Download className="h-4 w-4 mr-2" />
                Herunterladen
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <header className="sticky top-0 z-50 glass-effect border-b border-border">
          <div className="container mx-auto px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Link to="/">
                  <Button variant="ghost" size="icon">
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                </Link>
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
                  <p className="text-muted-foreground text-sm">
                    {storageInfo.itemCount} Einträge ({storageInfo.estimatedSize})
                  </p>
                </div>
              </div>
              
              {/* Backup buttons in header - prominent position */}
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={backupFileInputRef}
                  onChange={handleImportBackupFile}
                  accept=".json"
                  className="hidden"
                />
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowBackupHistory(true)}
                  className="gap-2"
                >
                  <History className="h-4 w-4" />
                  <span className="hidden sm:inline">{savedBackups.length > 0 ? `${savedBackups.length}` : ''}</span>
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => backupFileInputRef.current?.click()}
                  className="gap-2"
                >
                  <Upload className="h-4 w-4" />
                  <span className="hidden sm:inline">Importieren</span>
                </Button>
                <Button 
                  onClick={handleShowExportPreview} 
                  size="sm"
                  className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Download className="h-4 w-4" />
                  <span className="hidden sm:inline">Backup erstellen</span>
                </Button>
              </div>
            </div>
          </div>
        </header>

        {/* Backup History Dialog */}
        <Dialog open={showBackupHistory} onOpenChange={(open) => {
          setShowBackupHistory(open);
          if (!open) setSelectedBackupIds(new Set());
        }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-blue-500" />
                Gespeicherte Backup-Versionen
              </DialogTitle>
              <DialogDescription>
                {savedBackups.length === 0 
                  ? 'Keine Backups im Browser gespeichert.' 
                  : `${savedBackups.length} Backup(s) im Browser gespeichert (max. 10)`}
              </DialogDescription>
            </DialogHeader>
            
            {savedBackups.length > 0 && (
              <div className="flex items-center justify-between border-b pb-2">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={handleSelectAllBackups}
                  className="text-xs h-7 gap-1"
                >
                  {selectedBackupIds.size === savedBackups.length ? (
                    <CheckSquare className="h-4 w-4" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  {selectedBackupIds.size === savedBackups.length ? 'Keine' : 'Alle auswählen'}
                </Button>
                {selectedBackupIds.size > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {selectedBackupIds.size} ausgewählt
                  </Badge>
                )}
              </div>
            )}
            
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-2">
                {savedBackups.map((backup) => (
                  <div key={backup.id} className={`flex items-center gap-2 p-3 rounded-lg transition-colors ${
                    selectedBackupIds.has(backup.id) 
                      ? 'bg-primary/10 border border-primary/30' 
                      : 'bg-muted/50 hover:bg-muted'
                  }`}>
                    <Checkbox 
                      checked={selectedBackupIds.has(backup.id)}
                      onCheckedChange={() => handleToggleBackupSelection(backup.id)}
                      className="mr-1"
                    />
                    <div className="flex-1 min-w-0">
                      {renamingBackupId === backup.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className="h-7 text-sm"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleConfirmRename();
                              if (e.key === 'Escape') handleCancelRename();
                            }}
                          />
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleConfirmRename}>
                            <Check className="h-4 w-4 text-green-500" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancelRename}>
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      ) : (
                        <p className="font-medium text-sm truncate">{backup.name}</p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                        <Clock className="h-3 w-3" />
                        {new Date(backup.timestamp).toLocaleDateString('de-DE', {
                          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
                        })}
                        <Badge variant="outline" className="text-xs">{backup.size}</Badge>
                        <Badge variant="secondary" className="text-xs">{backup.itemCount} Einträge</Badge>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-popover">
                        <DropdownMenuItem onClick={() => handleStartRename(backup)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Umbenennen
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleRestoreBrowserBackup(backup)}>
                          <Upload className="h-4 w-4 mr-2" />
                          Wiederherstellen
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownloadBrowserBackup(backup.id)}>
                          <Download className="h-4 w-4 mr-2" />
                          Herunterladen
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleDeleteBrowserBackup(backup.id)} className="text-destructive">
                          <Trash2 className="h-4 w-4 mr-2" />
                          Löschen
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </ScrollArea>
            
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => {
                setShowBackupHistory(false);
                setSelectedBackupIds(new Set());
              }}>
                Schließen
              </Button>
              {selectedBackupIds.size > 0 && (
                <Button onClick={handleExportSelectedAsZip} disabled={isExportingZip}>
                  <Archive className="h-4 w-4 mr-2" />
                  {isExportingZip ? 'Erstelle ZIP...' : `${selectedBackupIds.size} als ZIP exportieren`}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Browser Backup Restore Confirm Dialog */}
        <Dialog open={showBrowserRestoreConfirm} onOpenChange={(open) => {
          if (!open) {
            setShowBrowserRestoreConfirm(false);
            setSelectedBrowserBackup(null);
            setBackupPreview(null);
          }
        }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-green-500" />
                Browser-Backup wiederherstellen
              </DialogTitle>
              <DialogDescription>
                {selectedBrowserBackup && (
                  <>Backup vom <strong>{new Date(selectedBrowserBackup.timestamp).toLocaleDateString('de-DE', { 
                    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
                  })}</strong></>
                )}
              </DialogDescription>
            </DialogHeader>
            
            <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700 dark:text-amber-300">
              ⚠️ Die ausgewählten Daten werden überschrieben!
            </div>
            
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setShowBrowserRestoreConfirm(false);
                setSelectedBrowserBackup(null);
                setBackupPreview(null);
              }}>
                Abbrechen
              </Button>
              <Button onClick={handleConfirmBrowserRestore}>
                <Upload className="h-4 w-4 mr-2" />
                Wiederherstellen
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <main className="container mx-auto px-4 py-6 max-w-2xl">
          {/* Global Site Protection Toggle */}
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 rounded-full flex items-center justify-center ${globalSiteProtectionEnabled ? 'bg-blue-500/10' : 'bg-muted'}`}>
                    {globalSiteProtectionEnabled ? (
                      <Lock className="h-5 w-5 text-blue-500" />
                    ) : (
                      <Lock className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <CardTitle>Globaler Passwortschutz</CardTitle>
                    <CardDescription>
                      Erfordert ein Passwort zum Aufrufen der gesamten Anwendung
                    </CardDescription>
                  </div>
                </div>
                <Switch
                  checked={globalSiteProtectionEnabled}
                  onCheckedChange={handleGlobalSiteProtectionToggle}
                />
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {globalSiteProtectionEnabled 
                  ? 'Globaler Schutz ist aktiv. Beim Laden der Seite wird ein Passwort abgefragt.'
                  : 'Globaler Schutz ist deaktiviert. Die Seite ist ohne Anmeldung zugänglich.'}
              </p>
            </CardContent>
          </Card>

          {/* Password Protection Toggle (for sensitive areas) */}
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 rounded-full flex items-center justify-center ${passwordProtectionEnabled ? 'bg-green-500/10' : 'bg-muted'}`}>
                    {passwordProtectionEnabled ? (
                      <ShieldCheck className="h-5 w-5 text-green-500" />
                    ) : (
                      <ShieldOff className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <CardTitle>Bereichs-Passwortschutz</CardTitle>
                    <CardDescription>
                      Schütze sensible Bereiche wie Einstellungen und Kostenanzeige zusätzlich
                    </CardDescription>
                  </div>
                </div>
                <Switch
                  checked={passwordProtectionEnabled}
                  onCheckedChange={handlePasswordProtectionToggle}
                />
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {passwordProtectionEnabled 
                  ? 'Bereichsschutz ist aktiv. Sensible Bereiche erfordern ein separates Entsperren.'
                  : 'Bereichsschutz ist deaktiviert. Alle Bereiche sind nach dem Login frei zugänglich.'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle>Passwort ändern</CardTitle>
                  <CardDescription>
                    Dieses Passwort wird für die Einstellungen und die Kostenanzeige im Dienstplan verwendet
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current">Aktuelles Passwort</Label>
                  <div className="relative">
                    <Input
                      id="current"
                      type={showCurrentPassword ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Aktuelles Passwort eingeben"
                      className="pr-10"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new">Neues Passwort</Label>
                  <div className="relative">
                    <Input
                      id="new"
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Neues Passwort eingeben"
                      className="pr-10"
                      required
                      minLength={4}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm">Passwort bestätigen</Label>
                  <div className="relative">
                    <Input
                      id="confirm"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Neues Passwort bestätigen"
                      className="pr-10"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex gap-2 pt-4">
                  <Button type="submit" className="flex-1">
                    <Lock className="h-4 w-4 mr-2" />
                    Passwort ändern
                  </Button>
                </div>
              </form>

              <div className="mt-6 pt-6 border-t">
                <p className="text-sm text-muted-foreground mb-3">
                  Falls Sie das Passwort vergessen haben, können Sie es auf den Standardwert zurücksetzen.
                </p>
                <Button variant="outline" onClick={handleResetPassword} className="w-full">
                  Auf Standard zurücksetzen (admin123)
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Revenue Distribution Settings */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Percent className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle>Umsatzverteilung pro Wochentag</CardTitle>
                  <CardDescription>
                    Prozentuale Verteilung des Monatsumsatzes auf die einzelnen Wochentage
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {WEEKDAY_NAMES.map((name, idx) => (
                  <div key={idx} className="space-y-1">
                    <Label className="text-xs">{name}</Label>
                    <div className="relative">
                      <Input
                        type="number"
                        value={weekdayPercentages[idx]}
                        onChange={(e) => handlePercentageChange(idx, e.target.value)}
                        className="pr-8"
                        step={1}
                        min={0}
                        max={100}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className={`text-sm font-medium ${Math.abs(totalPercentage - 100) > 0.1 ? 'text-destructive' : 'text-green-600'}`}>
                Summe: {totalPercentage}% {Math.abs(totalPercentage - 100) > 0.1 && '(muss 100% sein)'}
              </div>
              
              <div className="flex gap-2 pt-2">
                <Button onClick={savePercentages} className="flex-1" disabled={Math.abs(totalPercentage - 100) > 0.1}>
                  <Save className="h-4 w-4 mr-2" />
                  Speichern
                </Button>
                <Button variant="outline" onClick={resetPercentages}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Standard
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Labor Cost Threshold Settings */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-amber-500/10 flex items-center justify-center">
                  <Percent className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <CardTitle>Personalkostenquote-Schwellenwert</CardTitle>
                  <CardDescription>
                    Ab diesem Prozentsatz wird im Dienstplan eine Warnung angezeigt
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-[200px]">
                  <Input
                    type="number"
                    value={laborCostThreshold}
                    onChange={(e) => setLaborCostThreshold(parseFloat(e.target.value) || 0)}
                    className="pr-8"
                    step={1}
                    min={1}
                    max={100}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                </div>
                <Button onClick={saveLaborThreshold}>
                  <Save className="h-4 w-4 mr-2" />
                  Speichern
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Wenn die geplanten Personalkosten diesen Prozentsatz des Tagesumsatzes überschreiten, 
                wird im Dienstplan ein Hinweis angezeigt.
              </p>
            </CardContent>
          </Card>

          {/* Import Settings */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center">
                  <Upload className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <CardTitle>Import-Einstellungen</CardTitle>
                  <CardDescription>
                    Steuere wie Konflikte beim Datenimport behandelt werden
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Always Overwrite Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Immer überschreiben</p>
                  <p className="text-sm text-muted-foreground">
                    Beim Import werden bestehende Daten automatisch überschrieben ohne Nachfrage
                  </p>
                </div>
                <Switch
                  checked={localStorage.getItem('import-always-overwrite') === 'true'}
                  onCheckedChange={(checked) => {
                    localStorage.setItem('import-always-overwrite', checked.toString());
                    toast.success(checked ? 'Immer überschreiben aktiviert' : 'Konflikt-Dialog wieder aktiviert');
                  }}
                />
              </div>

              {/* Default Resolution */}
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">Standard-Auflösung bei Konflikten</p>
                  <p className="text-sm text-muted-foreground">
                    Welche Option soll im Konflikt-Dialog standardmässig vorausgewählt sein?
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={localStorage.getItem('import-default-resolution') !== 'keep' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      localStorage.setItem('import-default-resolution', 'replace');
                      toast.success('Standard: Neue Daten übernehmen');
                    }}
                  >
                    <ArrowRightLeft className="h-4 w-4 mr-2" />
                    Ersetzen (neue Daten)
                  </Button>
                  <Button
                    variant={localStorage.getItem('import-default-resolution') === 'keep' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      localStorage.setItem('import-default-resolution', 'keep');
                      toast.success('Standard: Bestehende Daten behalten');
                    }}
                  >
                    <Shield className="h-4 w-4 mr-2" />
                    Behalten (bestehende Daten)
                  </Button>
                </div>
              </div>

              {/* Show Import Summary Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Import-Zusammenfassung anzeigen</p>
                  <p className="text-sm text-muted-foreground">
                    Nach erfolgreichem Import eine detaillierte Zusammenfassung anzeigen
                  </p>
                </div>
                <Switch
                  checked={localStorage.getItem('import-show-summary') !== 'false'}
                  onCheckedChange={(checked) => {
                    localStorage.setItem('import-show-summary', checked.toString());
                    toast.success(checked ? 'Zusammenfassung wird angezeigt' : 'Zusammenfassung deaktiviert');
                  }}
                />
              </div>

              {/* Reset All Import Settings */}
              <div className="pt-4 border-t">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    localStorage.removeItem('import-always-overwrite');
                    localStorage.removeItem('import-default-resolution');
                    localStorage.removeItem('import-show-summary');
                    toast.success('Alle Import-Einstellungen zurückgesetzt');
                  }}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Alle Import-Einstellungen zurücksetzen
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Employee Data Reset */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-orange-500/10 flex items-center justify-center">
                  <Users className="h-5 w-5 text-orange-500" />
                </div>
                <div>
                  <CardTitle>Mitarbeiterdaten zurücksetzen</CardTitle>
                  <CardDescription>
                    Setzt die Mitarbeiterliste auf die Standardwerte zurück und lädt die aktuellen Daten neu
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Dies löscht alle gespeicherten Mitarbeiteränderungen und lädt die aktualisierten Standardmitarbeiter.
                Dienstpläne und Zeiteinträge bleiben erhalten.
              </p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="w-full">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Mitarbeiterliste zurücksetzen
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Mitarbeiterdaten zurücksetzen?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Alle manuellen Änderungen an Mitarbeitern (Namen, Stundenlöhne, Abteilungen) werden gelöscht und durch die Standardwerte ersetzt.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                    <AlertDialogAction 
                      onClick={() => {
                        localStorage.removeItem('schedule-employees');
                        // Dispatch event to trigger reload in other components
                        window.dispatchEvent(new CustomEvent('schedule-updated'));
                        toast.success('Mitarbeiterliste wurde zurückgesetzt. Seite wird neu geladen...');
                        setTimeout(() => window.location.reload(), 1000);
                      }}
                      className="bg-orange-500 text-white hover:bg-orange-600"
                    >
                      Zurücksetzen
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>

          {/* Supabase Migration */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className={`h-10 w-10 rounded-full flex items-center justify-center ${migrationDone ? 'bg-green-500/10' : 'bg-blue-500/10'}`}>
                  <CloudUpload className={`h-5 w-5 ${migrationDone ? 'text-green-500' : 'text-blue-500'}`} />
                </div>
                <div>
                  <CardTitle>Daten in Cloud migrieren</CardTitle>
                  <CardDescription>
                    Übertrage vorhandene Mitarbeiter- und Dienstplandaten aus dem Browser in die zentrale Datenbank
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {migrationDone ? (
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-700 dark:text-green-300 flex items-center gap-2">
                  <Check className="h-5 w-5" />
                  <span>Migration bereits durchgeführt. Alle Daten sind in der Cloud gespeichert.</span>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Diese einmalige Migration überträgt alle bestehenden Mitarbeiter und Dienstpläne (letzter Monat bis 2 Monate in der Zukunft) 
                    aus dem lokalen Browser-Speicher in die zentrale Datenbank. Danach können alle Geräte auf dieselben Daten zugreifen.
                  </p>
                  <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700 dark:text-amber-300">
                    ⚠️ Bestehende Daten in der Datenbank werden nicht überschrieben. Nur neue Einträge werden hinzugefügt.
                  </div>
                </>
              )}
              
              <div className="flex gap-2">
                <Button 
                  onClick={async () => {
                    setIsMigrating(true);
                    const result = await migrateLocalStorageToSupabase();
                    setIsMigrating(false);
                    
                    if (result.success) {
                      setMigrationDone(true);
                      toast.success(result.message);
                    } else {
                      toast.error(result.message);
                    }
                  }}
                  disabled={isMigrating}
                  className="flex-1"
                  variant={migrationDone ? 'outline' : 'default'}
                >
                  {isMigrating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Migration läuft...
                    </>
                  ) : migrationDone ? (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Erneut migrieren
                    </>
                  ) : (
                    <>
                      <CloudUpload className="h-4 w-4 mr-2" />
                      Jetzt migrieren
                    </>
                  )}
                </Button>
                
                {migrationDone && (
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => {
                      localStorage.removeItem('supabase-migration-done');
                      setMigrationDone(false);
                      toast.info('Migrations-Status zurückgesetzt');
                    }}
                    title="Migrations-Status zurücksetzen"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Name Mappings Management */}
          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-purple-500/10 flex items-center justify-center">
                    <ArrowRightLeft className="h-5 w-5 text-purple-500" />
                  </div>
                  <div>
                    <CardTitle>Gespeicherte Namenszuordnungen</CardTitle>
                    <CardDescription>
                      Verwalte die beim Import gespeicherten Zuordnungen zwischen importierten Namen und Mitarbeitern
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleImportMappings}
                    accept=".json"
                    className="hidden"
                  />
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="h-4 w-4 mr-2" />
                    Import
                  </Button>
                  {nameMappings.length > 0 && (
                    <>
                      <Button variant="outline" size="sm" onClick={handleExportMappings}>
                        <Download className="h-4 w-4 mr-2" />
                        Export
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleResetToDefaults}>
                        <RotateCcw className="h-4 w-4 mr-2" />
                        Standard
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />
                            Alle löschen
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Alle Zuordnungen löschen?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Diese Aktion kann nicht rückgängig gemacht werden. Alle {nameMappings.length} gespeicherten Namenszuordnungen werden dauerhaft gelöscht.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                            <AlertDialogAction onClick={handleClearAllMappings} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                              Alle löschen
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {nameMappings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
                    <Users className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-muted-foreground">
                    Keine gespeicherten Zuordnungen vorhanden.
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Zuordnungen werden automatisch beim Import erstellt.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="h-4 w-4" />
                    <span>{nameMappings.length} Zuordnung{nameMappings.length !== 1 ? 'en' : ''} gespeichert</span>
                  </div>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Importierter Name</TableHead>
                          <TableHead>Zugeordnet zu</TableHead>
                          <TableHead>Erstellt am</TableHead>
                          <TableHead className="w-[50px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {nameMappings.map((mapping) => (
                          <TableRow key={mapping.importedName}>
                            <TableCell className="font-medium">{mapping.importedName}</TableCell>
                            <TableCell>
                              {editingMapping === mapping.importedName ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    className="h-8 w-40"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveEdit(mapping.importedName);
                                      if (e.key === 'Escape') handleCancelEdit();
                                    }}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                                    onClick={() => handleSaveEdit(mapping.importedName)}
                                  >
                                    <Check className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                    onClick={handleCancelEdit}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <ArrowRightLeft className="h-4 w-4 text-purple-500" />
                                  {mapping.employeeName}
                                  {mapping.isDefault && (
                                    <Badge variant="secondary" className="text-xs">Standard</Badge>
                                  )}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {new Date(mapping.createdAt).toLocaleDateString('de-DE', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                {editingMapping !== mapping.importedName && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                    onClick={() => handleStartEdit(mapping)}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => handleDeleteMapping(mapping.importedName)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Capacity Settings */}
          <CapacitySettingsCard />

          {/* Cron Job Overview */}
          <CronJobOverview />

          {/* Department Access Tokens */}
          <DepartmentTokenManager />
        </main>
      </div>
    </PasswordProtection>
  );
};

export default Settings;