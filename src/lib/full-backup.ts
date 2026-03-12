// Full data backup export/import functionality
// Exports ALL localStorage data for complete state restoration

import { supabase } from "@/integrations/supabase/client";

export interface BackupData {
  version: string;
  exportedAt: string;
  data: Record<string, string>;
}

export interface SavedBackupVersion {
  id: string;
  name: string;
  timestamp: string;
  size: string;
  itemCount: number;
  data: string; // JSON stringified backup
}

const BACKUP_VERSION = '1.0';
const BACKUP_VERSIONS_KEY = 'backup-versions';
const MAX_BROWSER_BACKUPS = 10;

// Keys that should always be excluded from backup (sensitive or temporary)
const EXCLUDED_KEYS = [
  'admin_password', // Security - don't export passwords
  'backup-versions', // Don't include backup versions in backups
];

export interface ExportOptions {
  employees?: boolean;
  schedules?: boolean;
  shiftConfig?: boolean;
  nameMappings?: boolean;
  revenues?: boolean;
  budgets?: boolean;
  settings?: boolean;
  other?: boolean;
}

/**
 * Get keys categorized by type
 */
export const categorizeKeys = (): {
  employees: string[];
  schedules: string[];
  shiftConfig: string[];
  nameMappings: string[];
  revenues: string[];
  budgets: string[];
  settings: string[];
  other: string[];
} => {
  const allKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && !EXCLUDED_KEYS.includes(key)) {
      allKeys.push(key);
    }
  }
  
  const employees = allKeys.filter(k => k === 'schedule-employees');
  const schedules = allKeys.filter(k => k.startsWith('schedule-') && !k.includes('employees'));
  const shiftConfig = allKeys.filter(k => k === 'shift-config');
  const nameMappings = allKeys.filter(k => k === 'name-mappings');
  const revenues = allKeys.filter(k => k.startsWith('revenue-') || k.startsWith('planned-revenue-'));
  const budgets = allKeys.filter(k => k.startsWith('daily-budgets-'));
  const settings = allKeys.filter(k => ['revenue_weekday_percentages', 'labor_cost_threshold', 'password_protection_enabled'].includes(k));
  
  const categorized = [...employees, ...schedules, ...shiftConfig, ...nameMappings, ...revenues, ...budgets, ...settings];
  const other = allKeys.filter(k => !categorized.includes(k));
  
  return { employees, schedules, shiftConfig, nameMappings, revenues, budgets, settings, other };
};

/**
 * Export localStorage data to a JSON backup file with optional filtering
 */
export const exportFullBackup = (options?: ExportOptions): string => {
  const data: Record<string, string> = {};
  const categories = categorizeKeys();
  
  // If no options provided, export everything
  const exportAll = !options || Object.keys(options).length === 0;
  
  const keysToExport: string[] = [];
  
  if (exportAll || options?.employees) keysToExport.push(...categories.employees);
  if (exportAll || options?.schedules) keysToExport.push(...categories.schedules);
  if (exportAll || options?.shiftConfig) keysToExport.push(...categories.shiftConfig);
  if (exportAll || options?.nameMappings) keysToExport.push(...categories.nameMappings);
  if (exportAll || options?.revenues) keysToExport.push(...categories.revenues);
  if (exportAll || options?.budgets) keysToExport.push(...categories.budgets);
  if (exportAll || options?.settings) keysToExport.push(...categories.settings);
  if (exportAll || options?.other) keysToExport.push(...categories.other);
  
  for (const key of keysToExport) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      data[key] = value;
    }
  }
  
  const backup: BackupData = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data
  };
  
  return JSON.stringify(backup, null, 2);
};

/**
 * Download the backup as a JSON file with optional filtering
 */
export const downloadBackup = (options?: ExportOptions): void => {
  const json = exportFullBackup(options);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().split('T')[0];
  
  // Create descriptive filename based on what's exported
  let suffix = 'vollstaendig';
  if (options && Object.keys(options).length > 0) {
    const parts: string[] = [];
    if (options.employees) parts.push('mitarbeiter');
    if (options.schedules) parts.push('dienstplaene');
    if (options.shiftConfig) parts.push('schichten');
    if (options.nameMappings) parts.push('zuordnungen');
    if (options.revenues) parts.push('umsaetze');
    if (options.budgets) parts.push('budgets');
    if (options.settings) parts.push('einstellungen');
    suffix = parts.length > 0 ? parts.join('-') : 'auswahl';
  }
  
  a.download = `backup-${suffix}-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};


/**
 * Parse and validate a backup file
 */
export const parseBackupFile = (content: string): { 
  success: boolean; 
  backup?: BackupData; 
  error?: string;
  keyCount?: number;
} => {
  try {
    const parsed = JSON.parse(content);
    
    if (!parsed.version) {
      return { success: false, error: 'Ungültiges Backup-Format: Version fehlt' };
    }
    
    if (!parsed.data || typeof parsed.data !== 'object') {
      return { success: false, error: 'Ungültiges Backup-Format: Daten fehlen' };
    }
    
    const keyCount = Object.keys(parsed.data).length;
    
    return { 
      success: true, 
      backup: parsed as BackupData,
      keyCount
    };
  } catch (e) {
    return { success: false, error: 'Ungültige JSON-Datei' };
  }
};

/**
 * Get a summary of what's in the backup
 */
export const getBackupSummary = (backup: BackupData): {
  employees: boolean;
  employeeCount?: number;
  schedules: string[];
  nameMappings: boolean;
  nameMappingCount?: number;
  shiftConfig: boolean;
  settings: boolean;
  revenues: string[];
  budgets: string[];
  other: number;
  totalKeys: number;
  totalSize: string;
} => {
  const keys = Object.keys(backup.data);
  
  const schedules = keys.filter(k => k.startsWith('schedule-') && !k.includes('employees'));
  const revenues = keys.filter(k => k.startsWith('revenue-') || k.startsWith('planned-revenue-'));
  const budgets = keys.filter(k => k.startsWith('daily-budgets-'));
  
  // Calculate total size
  let totalBytes = 0;
  for (const value of Object.values(backup.data)) {
    totalBytes += value.length;
  }
  const sizeKB = totalBytes / 1024;
  const totalSize = sizeKB > 1024 
    ? `${(sizeKB / 1024).toFixed(2)} MB` 
    : `${sizeKB.toFixed(2)} KB`;
  
  // Count employees if present
  let employeeCount: number | undefined;
  if (backup.data['schedule-employees']) {
    try {
      const employees = JSON.parse(backup.data['schedule-employees']);
      employeeCount = Array.isArray(employees) ? employees.length : undefined;
    } catch {
      employeeCount = undefined;
    }
  }
  
  // Count name mappings if present
  let nameMappingCount: number | undefined;
  if (backup.data['name-mappings']) {
    try {
      const mappings = JSON.parse(backup.data['name-mappings']);
      nameMappingCount = Array.isArray(mappings) ? mappings.length : undefined;
    } catch {
      nameMappingCount = undefined;
    }
  }
  
  return {
    employees: keys.includes('schedule-employees'),
    employeeCount,
    schedules: schedules.map(k => k.replace('schedule-', '')),
    nameMappings: keys.includes('name-mappings'),
    nameMappingCount,
    shiftConfig: keys.includes('shift-config'),
    settings: keys.some(k => ['revenue_weekday_percentages', 'labor_cost_threshold', 'password_protection_enabled'].includes(k)),
    revenues: revenues.map(k => k.replace('revenue-', '').replace('planned-revenue-', '')),
    budgets: budgets.map(k => k.replace('daily-budgets-', '')),
    other: keys.length - schedules.length - revenues.length - budgets.length - 
           (keys.includes('schedule-employees') ? 1 : 0) - 
           (keys.includes('name-mappings') ? 1 : 0) -
           (keys.includes('shift-config') ? 1 : 0),
    totalKeys: keys.length,
    totalSize
  };
};

/**
 * Get current backup preview (what would be exported)
 */
export const getCurrentBackupPreview = (): { backup: BackupData; summary: ReturnType<typeof getBackupSummary> } => {
  const json = exportFullBackup();
  const backup = JSON.parse(json) as BackupData;
  const summary = getBackupSummary(backup);
  return { backup, summary };
};

/**
 * Restore data from a backup with optional filtering
 */
export const restoreFromBackup = (backup: BackupData, options?: ExportOptions): { 
  success: boolean; 
  restoredCount: number;
  error?: string;
} => {
  try {
    let restoredCount = 0;
    
    // Categorize backup keys
    const keys = Object.keys(backup.data);
    const employees = keys.filter(k => k === 'schedule-employees');
    const schedules = keys.filter(k => k.startsWith('schedule-') && !k.includes('employees'));
    const shiftConfig = keys.filter(k => k === 'shift-config');
    const nameMappings = keys.filter(k => k === 'name-mappings');
    const revenues = keys.filter(k => k.startsWith('revenue-') || k.startsWith('planned-revenue-'));
    const budgets = keys.filter(k => k.startsWith('daily-budgets-'));
    const settings = keys.filter(k => ['revenue_weekday_percentages', 'labor_cost_threshold', 'password_protection_enabled'].includes(k));
    const categorized = [...employees, ...schedules, ...shiftConfig, ...nameMappings, ...revenues, ...budgets, ...settings];
    const other = keys.filter(k => !categorized.includes(k));
    
    // Determine which keys to restore
    const restoreAll = !options || Object.keys(options).length === 0;
    const keysToRestore: string[] = [];
    
    if (restoreAll || options?.employees) keysToRestore.push(...employees);
    if (restoreAll || options?.schedules) keysToRestore.push(...schedules);
    if (restoreAll || options?.shiftConfig) keysToRestore.push(...shiftConfig);
    if (restoreAll || options?.nameMappings) keysToRestore.push(...nameMappings);
    if (restoreAll || options?.revenues) keysToRestore.push(...revenues);
    if (restoreAll || options?.budgets) keysToRestore.push(...budgets);
    if (restoreAll || options?.settings) keysToRestore.push(...settings);
    if (restoreAll || options?.other) keysToRestore.push(...other);
    
    // Only clear the categories we're restoring
    const categoriesToClear: string[] = [];
    if (restoreAll || options?.employees) categoriesToClear.push(...employees);
    if (restoreAll || options?.schedules) {
      // Clear existing schedules
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('schedule-') && !key.includes('employees')) {
          categoriesToClear.push(key);
        }
      }
    }
    if (restoreAll || options?.shiftConfig) categoriesToClear.push('shift-config');
    if (restoreAll || options?.nameMappings) categoriesToClear.push('name-mappings');
    if (restoreAll || options?.revenues) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('revenue-') || key.startsWith('planned-revenue-'))) {
          categoriesToClear.push(key);
        }
      }
    }
    if (restoreAll || options?.budgets) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('daily-budgets-')) {
          categoriesToClear.push(key);
        }
      }
    }
    if (restoreAll || options?.settings) {
      categoriesToClear.push('revenue_weekday_percentages', 'labor_cost_threshold', 'password_protection_enabled');
    }
    
    // Clear selected categories
    categoriesToClear.forEach(key => localStorage.removeItem(key));
    
    // Restore selected data
    for (const key of keysToRestore) {
      if (!EXCLUDED_KEYS.includes(key) && backup.data[key] !== undefined) {
        localStorage.setItem(key, backup.data[key]);
        restoredCount++;
      }
    }
    
    return { success: true, restoredCount };
  } catch (e) {
    return { 
      success: false, 
      restoredCount: 0, 
      error: e instanceof Error ? e.message : 'Unbekannter Fehler' 
    };
  }
};

/**
 * Get current storage usage info
 */
export const getStorageInfo = (): {
  itemCount: number;
  estimatedSize: string;
} => {
  let totalSize = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && !EXCLUDED_KEYS.includes(key)) {
      const value = localStorage.getItem(key);
      totalSize += key.length + (value?.length || 0);
    }
  }
  
  // Convert to KB or MB
  const sizeKB = totalSize / 1024;
  const estimatedSize = sizeKB > 1024 
    ? `${(sizeKB / 1024).toFixed(2)} MB` 
    : `${sizeKB.toFixed(2)} KB`;
  
  // Count items excluding backup versions
  let itemCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && !EXCLUDED_KEYS.includes(key)) {
      itemCount++;
    }
  }
  
  return {
    itemCount,
    estimatedSize
  };
};

// ============= BACKUP VERSIONING FUNCTIONS =============

/**
 * Get all saved backup versions from browser storage
 */
export const getSavedBackupVersions = (): SavedBackupVersion[] => {
  try {
    const saved = localStorage.getItem(BACKUP_VERSIONS_KEY);
    if (!saved) return [];
    return JSON.parse(saved);
  } catch {
    return [];
  }
};

/**
 * Save a backup version to browser storage
 */
export const saveBackupToBrowser = (name?: string, options?: ExportOptions): SavedBackupVersion => {
  const json = exportFullBackup(options);
  const backup = JSON.parse(json) as BackupData;
  const summary = getBackupSummary(backup);
  
  const timestamp = new Date().toISOString();
  const defaultName = `Backup ${new Date().toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })}`;
  
  const newVersion: SavedBackupVersion = {
    id: crypto.randomUUID(),
    name: name || defaultName,
    timestamp,
    size: summary.totalSize,
    itemCount: summary.totalKeys,
    data: json
  };
  
  // Get existing versions and add new one
  const versions = getSavedBackupVersions();
  versions.unshift(newVersion);
  
  // Keep only last MAX_BROWSER_BACKUPS versions
  const trimmedVersions = versions.slice(0, MAX_BROWSER_BACKUPS);
  
  localStorage.setItem(BACKUP_VERSIONS_KEY, JSON.stringify(trimmedVersions));
  
  return newVersion;
};

/**
 * Rename a saved backup version
 */
export const renameBackupVersion = (id: string, newName: string): void => {
  const versions = getSavedBackupVersions();
  const updated = versions.map(v => v.id === id ? { ...v, name: newName } : v);
  localStorage.setItem(BACKUP_VERSIONS_KEY, JSON.stringify(updated));
};

/**
 * Delete a saved backup version from browser storage
 */
export const deleteBackupVersion = (id: string): void => {
  const versions = getSavedBackupVersions();
  const filtered = versions.filter(v => v.id !== id);
  localStorage.setItem(BACKUP_VERSIONS_KEY, JSON.stringify(filtered));
};

/**
 * Restore from a saved browser backup version
 */
export const restoreFromBrowserBackup = (id: string, options?: ExportOptions): {
  success: boolean;
  restoredCount: number;
  error?: string;
} => {
  const versions = getSavedBackupVersions();
  const version = versions.find(v => v.id === id);
  
  if (!version) {
    return { success: false, restoredCount: 0, error: 'Backup-Version nicht gefunden' };
  }
  
  try {
    const backup = JSON.parse(version.data) as BackupData;
    return restoreFromBackup(backup, options);
  } catch (e) {
    return { 
      success: false, 
      restoredCount: 0, 
      error: e instanceof Error ? e.message : 'Fehler beim Parsen des Backups' 
    };
  }
};

/**
 * Get backup data for a specific saved version
 */
export const getBackupVersionData = (id: string): BackupData | null => {
  const versions = getSavedBackupVersions();
  const version = versions.find(v => v.id === id);
  if (!version) return null;
  try {
    return JSON.parse(version.data) as BackupData;
  } catch {
    return null;
  }
};

/**
 * Download a specific browser backup version as file
 */
export const downloadBrowserBackup = (id: string): void => {
  const versions = getSavedBackupVersions();
  const version = versions.find(v => v.id === id);
  if (!version) return;
  
  const blob = new Blob([version.data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date(version.timestamp).toISOString().split('T')[0];
  a.download = `backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Export multiple backup versions as a ZIP archive
 */
export const exportBackupsAsZip = async (ids: string[]): Promise<{ success: boolean; error?: string }> => {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    
    const versions = getSavedBackupVersions();
    const selectedVersions = versions.filter(v => ids.includes(v.id));
    
    if (selectedVersions.length === 0) {
      return { success: false, error: 'Keine Backups ausgewählt' };
    }
    
    for (const version of selectedVersions) {
      const date = new Date(version.timestamp);
      const dateStr = date.toISOString().split('T')[0];
      const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-');
      const safeName = version.name.replace(/[^a-zA-Z0-9äöüÄÖÜß\-_]/g, '_').substring(0, 50);
      const fileName = `backup_${safeName}_${dateStr}_${timeStr}.json`;
      
      zip.file(fileName, version.data);
    }
    
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().split('T')[0];
    a.download = `backups-${selectedVersions.length}-versionen-${date}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    return { success: true };
  } catch (e) {
    console.error('Error creating ZIP:', e);
    return { 
      success: false, 
      error: e instanceof Error ? e.message : 'Fehler beim Erstellen des ZIP-Archivs' 
    };
  }
};

/**
 * Send backup via email using edge function
 */
export const sendBackupEmail = async (options?: ExportOptions): Promise<{ success: boolean; error?: string }> => {
  try {
    const json = exportFullBackup(options);
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];
    const backupName = `backup-${date}.json`;

    const { data, error } = await supabase.functions.invoke('send-backup-email', {
      body: {
        backupData: json,
        backupName,
        timestamp
      }
    });

    if (error) {
      console.error('Error sending backup email:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (e) {
    console.error('Error sending backup email:', e);
    return { 
      success: false, 
      error: e instanceof Error ? e.message : 'Unbekannter Fehler beim E-Mail-Versand' 
    };
  }
};
