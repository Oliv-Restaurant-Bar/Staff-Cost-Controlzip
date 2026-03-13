/**
 * Kontenmapping-Store
 * ====================
 * Verwaltung aller 4-stelligen Kontonummer-Zuordnungen für die P&L-Logik.
 *
 * Architektur:
 *   DEFAULT_ACCOUNTS  → feste Standardzuordnungen (Swiss KMU Kontenrahmen,
 *                       angepasst für Gastronomie)
 *   customMappings    → Admin-Anpassungen (localStorage), überschreiben Defaults
 *   ACCOUNT_RANGES    → Fallback-Regeln für unbekannte Kontonummern
 *
 * Matching-Reihenfolge beim späteren CSV/PDF-Import:
 *   1. Exakter Treffer in customMappings
 *   2. Exakter Treffer in DEFAULT_ACCOUNTS
 *   3. Bereichstreffer in ACCOUNT_RANGES
 *   4. → requiresManualMapping = true
 */

import {
  AccountMapping, AccountRange, PLSectionDef, PLCategoryDef,
  PLSection, PLCategory, AccountLookupResult,
} from '@/types/account-mapping';

// ─── localStorage-Schlüssel ───────────────────────────────────────────────────

const STORAGE_KEY = 'account_mappings_v1';

// ─── P&L-Abschnitte (Reihenfolge = P&L-Struktur) ─────────────────────────────

export const PL_SECTIONS: PLSectionDef[] = [
  {
    id: 'net_revenue',
    label: 'Nettoumsatz',
    description: 'Gesamter Umsatz aus Speisen, Getränken und weiteren Leistungen',
    isCalculated: false,
    color: 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/30 dark:text-blue-300',
    order: 1,
  },
  {
    id: 'cogs',
    label: 'Wareneinsatz',
    description: 'Direkter Materialaufwand (Lebensmittel & Getränke)',
    isCalculated: false,
    color: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:text-red-300',
    order: 2,
  },
  {
    id: 'gross_profit_1',
    label: 'Rohgewinn 1',
    description: 'Nettoumsatz − Wareneinsatz',
    isCalculated: true,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    order: 3,
  },
  {
    id: 'personnel',
    label: 'Personalkosten',
    description: 'Löhne, Sozialabgaben und weitere Personalkosten',
    isCalculated: false,
    color: 'bg-orange-50 border-orange-200 text-orange-800 dark:bg-orange-950/30 dark:text-orange-300',
    order: 4,
  },
  {
    id: 'gross_profit_2',
    label: 'Rohgewinn 2 / Deckungsbeitrag',
    description: 'Rohgewinn 1 − Personalkosten',
    isCalculated: true,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    order: 5,
  },
  {
    id: 'operating_expenses',
    label: 'Betriebskosten',
    description: 'Miete, Energie, Versicherungen, Marketing und sonstige Aufwände',
    isCalculated: false,
    color: 'bg-purple-50 border-purple-200 text-purple-800 dark:bg-purple-950/30 dark:text-purple-300',
    order: 6,
  },
  {
    id: 'ebitda',
    label: 'EBITDA',
    description: 'Deckungsbeitrag − Betriebskosten (vor Abschreibungen)',
    isCalculated: true,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    order: 7,
  },
  {
    id: 'depreciation_section',
    label: 'Abschreibungen',
    description: 'Planmässige Abschreibungen auf Sachanlagen und Einrichtung',
    isCalculated: false,
    color: 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400',
    order: 8,
  },
  {
    id: 'operating_result',
    label: 'Betriebsergebnis (EBIT)',
    description: 'EBITDA − Abschreibungen = operatives Ergebnis',
    isCalculated: true,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    order: 9,
  },
];

// ─── P&L-Kategorien ───────────────────────────────────────────────────────────

export const PL_CATEGORIES: PLCategoryDef[] = [
  { id: 'revenue_food',      label: 'Speiseumsatz',              section: 'net_revenue', sign: 'income' },
  { id: 'revenue_beverage',  label: 'Getränkeumsatz',            section: 'net_revenue', sign: 'income' },
  { id: 'revenue_catering',  label: 'Bankett / Catering',        section: 'net_revenue', sign: 'income' },
  { id: 'revenue_other',     label: 'Sonstiger Umsatz',          section: 'net_revenue', sign: 'income' },
  { id: 'cogs_food',         label: 'Warenaufwand Küche',        section: 'cogs',        sign: 'expense' },
  { id: 'cogs_beverage',     label: 'Warenaufwand Getränke',     section: 'cogs',        sign: 'expense' },
  { id: 'cogs_other',        label: 'Warenaufwand Diverses',     section: 'cogs',        sign: 'expense' },
  { id: 'personnel_kitchen', label: 'Löhne Küche',               section: 'personnel',   sign: 'expense' },
  { id: 'personnel_service', label: 'Löhne Service',             section: 'personnel',   sign: 'expense' },
  { id: 'personnel_admin',   label: 'Löhne Verwaltung',          section: 'personnel',   sign: 'expense' },
  { id: 'personnel_social',  label: 'Sozialabgaben (AHV/BVG/UVG)',section:'personnel',   sign: 'expense' },
  { id: 'personnel_other',   label: 'Sonstige Personalkosten',   section: 'personnel',   sign: 'expense' },
  { id: 'rent',              label: 'Miete & Nebenkosten',       section: 'operating_expenses', sign: 'expense' },
  { id: 'utilities',         label: 'Energie & Wasser',          section: 'operating_expenses', sign: 'expense' },
  { id: 'cleaning',          label: 'Reinigung & Hygiene',       section: 'operating_expenses', sign: 'expense' },
  { id: 'maintenance',       label: 'Unterhalt & Reparaturen',   section: 'operating_expenses', sign: 'expense' },
  { id: 'insurance',         label: 'Versicherungen',            section: 'operating_expenses', sign: 'expense' },
  { id: 'marketing',         label: 'Marketing & Werbung',       section: 'operating_expenses', sign: 'expense' },
  { id: 'admin_costs',       label: 'Verwaltungskosten',         section: 'operating_expenses', sign: 'expense' },
  { id: 'office',            label: 'Büro & Kommunikation',      section: 'operating_expenses', sign: 'expense' },
  { id: 'bank_fees',         label: 'Bankgebühren',              section: 'operating_expenses', sign: 'expense' },
  { id: 'other_operating',   label: 'Diverses Betrieblich',      section: 'operating_expenses', sign: 'expense' },
  { id: 'depreciation',      label: 'Abschreibungen',            section: 'depreciation_section', sign: 'expense' },
  { id: 'unmapped',          label: 'Nicht zugeordnet',          section: 'operating_expenses', sign: 'expense' },
];

// ─── Standard-Kontonummern (Swiss KMU / Gastronomie) ─────────────────────────

/**
 * Basiert auf dem Schweizer KMU-Kontenrahmen,
 * angepasst für den Restaurant- und Gastronomiebetrieb.
 *
 * Diese Konten entsprechen typischen Buchhaltungssystemen wie
 * Banana Accounting, AbaNinja, Sage 50, Bexio.
 */
export const DEFAULT_ACCOUNTS: AccountMapping[] = [
  // ── Umsatz (3xxx) ──────────────────────────────────────────────────────────
  { accountNumber: '3000', accountName: 'Speiseumsatz',          plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '3001', accountName: 'Getränkeumsatz Bar',    plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '3002', accountName: 'Weinumsatz',            plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3010', accountName: 'Bankett / Catering',    plCategory: 'revenue_catering', plSection: 'net_revenue', department: 'general',sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3020', accountName: 'Lieferservice',         plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3900', accountName: 'Sonstiger Umsatz',      plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general',sign: 'income',  canOverride: true,  isActive: true, source: 'default' },

  // ── Wareneinsatz (4xxx) ────────────────────────────────────────────────────
  { accountNumber: '4000', accountName: 'Warenaufwand Lebensmittel', plCategory: 'cogs_food',     plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '4001', accountName: 'Warenaufwand Getränke',     plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '4002', accountName: 'Warenaufwand Wein',         plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4010', accountName: 'Warenaufwand Diverses',     plCategory: 'cogs_other',    plSection: 'cogs', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4100', accountName: 'Bestandesänderungen',       plCategory: 'cogs_other',    plSection: 'cogs', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default', notes: 'Kann positiv oder negativ sein' },

  // ── Personalkosten (5xxx) ──────────────────────────────────────────────────
  { accountNumber: '5000', accountName: 'Löhne Küche',                plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'kitchen', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5001', accountName: 'Löhne Service',              plCategory: 'personnel_service', plSection: 'personnel', department: 'service', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5002', accountName: 'Löhne Verwaltung',           plCategory: 'personnel_admin',   plSection: 'personnel', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5003', accountName: 'Aushilfen / Temporäre MA',   plCategory: 'personnel_service', plSection: 'personnel', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5010', accountName: 'AHV/IV/EO Arbeitgeberanteil',plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5011', accountName: 'ALV Arbeitgeberanteil',      plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5012', accountName: 'BVG Arbeitgeberanteil',      plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5013', accountName: 'UVG Prämien',                plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5014', accountName: 'KTG Prämien',                plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5020', accountName: 'Ausbildung & Schulungen',    plCategory: 'personnel_other',   plSection: 'personnel', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5030', accountName: 'Personalverpflegung intern', plCategory: 'personnel_other',   plSection: 'personnel', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default' },

  // ── Betriebskosten (6xxx) ──────────────────────────────────────────────────
  { accountNumber: '6000', accountName: 'Miete Betriebsräume',         plCategory: 'rent',           plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6001', accountName: 'Nebenkosten / Service charges',plCategory: 'rent',           plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6010', accountName: 'Wasser',                      plCategory: 'utilities',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6011', accountName: 'Energie / Strom',             plCategory: 'utilities',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6012', accountName: 'Gas / Heizung',               plCategory: 'utilities',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6020', accountName: 'Reinigung & Hygiene',         plCategory: 'cleaning',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6030', accountName: 'Unterhalt & Reparaturen',     plCategory: 'maintenance',    plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6031', accountName: 'Kleininventar / Verbrauchsmaterial',plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6040', accountName: 'Büromaterial',                plCategory: 'office',         plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6050', accountName: 'Telefon & Internet',          plCategory: 'office',         plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6060', accountName: 'Porto & Versand',             plCategory: 'office',         plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6100', accountName: 'Betriebsversicherungen',      plCategory: 'insurance',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6110', accountName: 'Gebühren & Lizenzen',         plCategory: 'insurance',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6200', accountName: 'Werbung & Marketing',         plCategory: 'marketing',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6210', accountName: 'Promotionen & Events',        plCategory: 'marketing',      plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6300', accountName: 'Bankgebühren & Zahlungsverkehr',plCategory: 'bank_fees',    plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6400', accountName: 'Buchhaltung & Steuerberatung',plCategory: 'admin_costs',    plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6410', accountName: 'Rechtsberatung',              plCategory: 'admin_costs',    plSection: 'operating_expenses', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6500', accountName: 'Reise & Repräsentation',      plCategory: 'other_operating',plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6800', accountName: 'Diverses Betrieblich',        plCategory: 'other_operating',plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },

  // ── Abschreibungen (6900+) ────────────────────────────────────────────────
  { accountNumber: '6900', accountName: 'Abschreibungen Sachanlagen',    plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6901', accountName: 'Abschreibungen Einrichtung',    plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6902', accountName: 'Abschreibungen Küchengeräte',   plCategory: 'depreciation', plSection: 'depreciation_section', department: 'kitchen', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
];

// ─── Fallback-Bereiche (Ranges) ───────────────────────────────────────────────

/**
 * Wenn kein exaktes Konto-Mapping gefunden wird, greift der Bereich-Fallback.
 * Reihenfolge: vom spezifischsten zum allgemeinsten.
 */
export const ACCOUNT_RANGES: AccountRange[] = [
  { from: '3000', to: '3099', plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  description: 'Speiseumsatz (allgemein)' },
  { from: '3100', to: '3199', plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  description: 'Getränkeumsatz (allgemein)' },
  { from: '3900', to: '3999', plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  description: 'Sonstiger Umsatz' },
  { from: '4000', to: '4099', plCategory: 'cogs_food',        plSection: 'cogs',        department: 'kitchen', sign: 'expense', description: 'Warenaufwand Lebensmittel (allgemein)' },
  { from: '4100', to: '4199', plCategory: 'cogs_beverage',    plSection: 'cogs',        department: 'service', sign: 'expense', description: 'Warenaufwand Getränke (allgemein)' },
  { from: '5000', to: '5049', plCategory: 'personnel_kitchen',plSection: 'personnel',   department: 'kitchen', sign: 'expense', description: 'Löhne (allgemein)' },
  { from: '5010', to: '5019', plCategory: 'personnel_social', plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sozialabgaben (allgemein)' },
  { from: '5050', to: '5099', plCategory: 'personnel_other',  plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sonstige Personalkosten (allgemein)' },
  { from: '6000', to: '6009', plCategory: 'rent',             plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Miete (allgemein)' },
  { from: '6010', to: '6019', plCategory: 'utilities',        plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Energie & Wasser (allgemein)' },
  { from: '6020', to: '6029', plCategory: 'cleaning',         plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Reinigung (allgemein)' },
  { from: '6100', to: '6119', plCategory: 'insurance',        plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Versicherungen (allgemein)' },
  { from: '6200', to: '6299', plCategory: 'marketing',        plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Marketing (allgemein)' },
  { from: '6400', to: '6499', plCategory: 'admin_costs',      plSection: 'operating_expenses', department: 'admin',  sign: 'expense', description: 'Verwaltungskosten (allgemein)' },
  { from: '6800', to: '6899', plCategory: 'other_operating',  plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Diverses Betrieblich (allgemein)' },
  { from: '6900', to: '6999', plCategory: 'depreciation',     plSection: 'depreciation_section', department: 'general', sign: 'expense', description: 'Abschreibungen (allgemein)' },
];

// ─── Laden / Speichern ────────────────────────────────────────────────────────

function loadCustomMappings(): Record<string, AccountMapping> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCustomMappings(data: Record<string, AccountMapping>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Alle Konten laden (Defaults + Custom-Überschreibungen zusammengeführt).
 * Custom-Mappings haben immer Vorrang.
 */
export function loadAllMappings(): AccountMapping[] {
  const custom = loadCustomMappings();
  const defaultMap = new Map(DEFAULT_ACCOUNTS.map(a => [a.accountNumber, a]));
  // Custom überschreibt Default
  for (const [num, mapping] of Object.entries(custom)) {
    defaultMap.set(num, mapping);
  }
  return Array.from(defaultMap.values()).sort((a, b) =>
    a.accountNumber.localeCompare(b.accountNumber),
  );
}

/**
 * Ein einzelnes Konto speichern (immer als 'custom' markiert).
 */
export function saveMappingCustom(mapping: AccountMapping): void {
  const custom = loadCustomMappings();
  custom[mapping.accountNumber] = { ...mapping, source: 'custom' };
  saveCustomMappings(custom);
}

/**
 * Custom-Mapping löschen (stellt Default wieder her, falls vorhanden).
 */
export function deleteMappingCustom(accountNumber: string): void {
  const custom = loadCustomMappings();
  delete custom[accountNumber];
  saveCustomMappings(custom);
}

/**
 * Konto zurücksetzen auf Default (löscht Custom-Eintrag).
 */
export function resetToDefault(accountNumber: string): void {
  deleteMappingCustom(accountNumber);
}

// ─── Matching / Lookup ────────────────────────────────────────────────────────

/**
 * Hauptfunktion für den späteren Import:
 * Gibt die P&L-Zuordnung für eine 4-stellige Kontonummer zurück.
 *
 * Suchreihenfolge:
 *   1. Custom-Mapping (Admin-Anpassung)
 *   2. Default-Mapping (Standardkonto)
 *   3. Bereichs-Fallback (Range-Regel)
 *   4. → kein Treffer → requiresManualMapping = true
 */
export function lookupAccount(accountNumber: string): AccountLookupResult {
  const num = accountNumber.trim().padStart(4, '0');

  // 1. Custom-Mappings
  const custom = loadCustomMappings();
  if (custom[num]?.isActive) {
    return { mapping: custom[num], matchType: 'exact', requiresManualMapping: false };
  }

  // 2. Default-Mappings
  const defaultMatch = DEFAULT_ACCOUNTS.find(a => a.accountNumber === num && a.isActive);
  if (defaultMatch) {
    return { mapping: defaultMatch, matchType: 'exact', requiresManualMapping: false };
  }

  // 3. Bereichs-Fallback
  const rangeMatch = ACCOUNT_RANGES.find(r => num >= r.from && num <= r.to);
  if (rangeMatch) {
    const syntheticMapping: AccountMapping = {
      accountNumber: num,
      accountName:   `Konto ${num} (Bereichszuordnung)`,
      plCategory:    rangeMatch.plCategory,
      plSection:     rangeMatch.plSection,
      department:    rangeMatch.department,
      sign:          rangeMatch.sign,
      canOverride:   true,
      isActive:      true,
      source:        'default',
      notes:         `Automatisch zugeordnet via Bereich ${rangeMatch.from}–${rangeMatch.to}`,
    };
    return { mapping: syntheticMapping, matchType: 'range', requiresManualMapping: false };
  }

  // 4. Kein Treffer
  return { mapping: null, matchType: 'none', requiresManualMapping: true };
}

/**
 * Batch-Lookup für mehrere Kontonummern (z.B. aus einem CSV-Import).
 * Gibt eine Map: accountNumber → LookupResult zurück.
 */
export function lookupAccountBatch(
  accountNumbers: string[],
): Map<string, AccountLookupResult> {
  const result = new Map<string, AccountLookupResult>();
  for (const num of accountNumbers) {
    result.set(num, lookupAccount(num));
  }
  return result;
}

/**
 * Alle Konten eines bestimmten P&L-Abschnitts zurückgeben.
 */
export function getMappingsBySection(section: PLSection): AccountMapping[] {
  return loadAllMappings().filter(m => m.plSection === section && m.isActive);
}

// ─── Label-Hilfsfunktionen ────────────────────────────────────────────────────

export function getCategoryLabel(category: PLCategory): string {
  return PL_CATEGORIES.find(c => c.id === category)?.label ?? category;
}

export function getSectionLabel(section: PLSection): string {
  return PL_SECTIONS.find(s => s.id === section)?.label ?? section;
}

export const DEPARTMENT_LABELS: Record<string, string> = {
  kitchen: 'Küche',
  service: 'Service',
  general: 'Allgemein',
  admin:   'Verwaltung',
};
