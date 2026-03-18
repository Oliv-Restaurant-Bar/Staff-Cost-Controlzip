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
  { accountNumber: '4020', accountName: 'Wein Warenaufwand',         plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4030', accountName: 'Bier Warenaufwand',         plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4040', accountName: 'Spirituosen Warenaufwand',  plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4050', accountName: 'Mineral / Softdrinks',      plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4060', accountName: 'Küche Warenaufwand',        plCategory: 'cogs_food',     plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '4100', accountName: 'Bestandesänderungen',       plCategory: 'cogs_other',    plSection: 'cogs', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default', notes: 'Kann positiv oder negativ sein' },
  // Betriebsmaterial, Verpackung, Diverses Wareneinsatz (4400–4899)
  { accountNumber: '4400', accountName: 'Betriebsmaterial allgemein',       plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4420', accountName: 'Reinigungsmaterial',               plCategory: 'cleaning',        plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4430', accountName: 'Gästebedarf / Verbrauchsmaterial', plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4500', accountName: 'Drucksachen / Büromaterial',       plCategory: 'admin_costs',     plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4700', accountName: 'Betriebsmaterial',                 plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4701', accountName: 'Betriebsmaterial Restauration',    plCategory: 'other_operating', plSection: 'operating_expenses', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4702', accountName: 'Betriebsmaterial Küche',           plCategory: 'other_operating', plSection: 'operating_expenses', department: 'kitchen', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4710', accountName: 'Reinigungs- und Hygienemittel',    plCategory: 'cleaning',        plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4720', accountName: 'Gästetoiletten / Verbrauch',       plCategory: 'cleaning',        plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4800', accountName: 'Emballagen / Verpackung',          plCategory: 'cogs_other',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4801', accountName: 'Gebinde',                          plCategory: 'cogs_other',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4810', accountName: 'Verpackungsmaterial',              plCategory: 'cogs_other',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },

  // ── Personalkosten (5xxx) ──────────────────────────────────────────────────
  { accountNumber: '5000', accountName: 'Löhne Küche',                plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'kitchen', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5001', accountName: 'Löhne Service',              plCategory: 'personnel_service', plSection: 'personnel', department: 'service', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5002', accountName: 'Löhne Verwaltung',           plCategory: 'personnel_admin',   plSection: 'personnel', department: 'admin',  sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5003', accountName: 'Aushilfen / Temporäre MA',   plCategory: 'personnel_service', plSection: 'personnel', department: 'general',sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5010', accountName: 'AHV/IV/EO Arbeitgeberanteil',plCategory: 'personnel_social',  plSection: 'personnel', department: 'general',sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  // Sonstige Personalkosten (5100–5499)
  { accountNumber: '5100', accountName: 'Aus- und Weiterbildung',          plCategory: 'personnel_other', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5110', accountName: 'Personalrekrutierung',            plCategory: 'personnel_other', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5200', accountName: 'Quellensteuer',                   plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5210', accountName: 'Lohnnebenkosten',                 plCategory: 'personnel_other', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5300', accountName: 'Personalverpflegung',             plCategory: 'personnel_other', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5310', accountName: 'Personalunterkunft',              plCategory: 'personnel_other', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '5400', accountName: 'Kinderzulagen / FAK',             plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Sozialabgaben (5700–5799) — Sage-typisch
  { accountNumber: '5700', accountName: 'AHV, IV, EO, ALV',               plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5710', accountName: 'Familienausgleich (FAK)',         plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5720', accountName: 'Vorsorgeeinrichtungen BVG',       plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5730', accountName: 'Unfallversicherungen UVG',        plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5740', accountName: 'Krankentaggeldvers. KVG',         plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5750', accountName: 'NBU-Prämien',                     plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5760', accountName: 'Unfallversicherung NBU',          plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5790', accountName: 'Sonstige Sozialleistungen',       plCategory: 'personnel_social', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
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
  { from: '4200', to: '4399', plCategory: 'cogs_other',       plSection: 'cogs',        department: 'general', sign: 'expense', description: 'Warenaufwand Diverses (allgemein)' },
  { from: '4400', to: '4699', plCategory: 'other_operating',  plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Betriebsmaterial / Verbrauchsgüter (allgemein)' },
  { from: '4700', to: '4799', plCategory: 'other_operating',  plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Betriebsmaterial (allgemein)' },
  { from: '4800', to: '4899', plCategory: 'cogs_other',       plSection: 'cogs',        department: 'general', sign: 'expense', description: 'Emballagen / Gebinde (allgemein)' },
  { from: '5000', to: '5049', plCategory: 'personnel_kitchen',plSection: 'personnel',   department: 'kitchen', sign: 'expense', description: 'Löhne (allgemein)' },
  { from: '5010', to: '5019', plCategory: 'personnel_social', plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sozialabgaben (allgemein)' },
  { from: '5050', to: '5099', plCategory: 'personnel_other',  plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sonstige Personalkosten (allgemein)' },
  { from: '5100', to: '5699', plCategory: 'personnel_other',  plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sonstige Personalkosten / Nebenkosten (allgemein)' },
  { from: '5700', to: '5799', plCategory: 'personnel_social', plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sozialabgaben Sage-Konten (AHV/BVG/UVG/KTG)' },
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

// ─── Auto-Zuweisung nach Kontonummer ──────────────────────────────────────────

/**
 * Automatische Kategorie-/Abschnitts-Zuweisung basierend auf Kontonummern-Bereich.
 * Wird beim CSV/PDF-Import des Kontenplans verwendet.
 *
 *   3000–3999 → Nettoumsatz (Ertrag)
 *   4000–4999 → Wareneinsatz (Aufwand)
 *   5000–5999 → Personalkosten (Aufwand)
 *   6000–6999 → Betriebskosten (Aufwand)
 */
export function autoAssignFromNumber(accountNumber: string): {
  plSection:  PLSection;
  plCategory: PLCategory;
  sign:       AccountSign;
  department: DepartmentHint;
} {
  const n = parseInt(accountNumber, 10);

  if (n >= 3000 && n <= 3099) return { plSection: 'net_revenue',       plCategory: 'revenue_food',      sign: 'income',  department: 'kitchen' };
  if (n >= 3100 && n <= 3199) return { plSection: 'net_revenue',       plCategory: 'revenue_beverage',  sign: 'income',  department: 'service' };
  if (n >= 3000 && n <= 3899) return { plSection: 'net_revenue',       plCategory: 'revenue_food',      sign: 'income',  department: 'general' };
  if (n >= 3900 && n <= 3999) return { plSection: 'net_revenue',       plCategory: 'revenue_other',     sign: 'income',  department: 'general' };

  if (n >= 4000 && n <= 4049) return { plSection: 'cogs',              plCategory: 'cogs_food',         sign: 'expense', department: 'kitchen' };
  if (n >= 4050 && n <= 4099) return { plSection: 'cogs',              plCategory: 'cogs_beverage',     sign: 'expense', department: 'service' };
  if (n >= 4000 && n <= 4999) return { plSection: 'cogs',              plCategory: 'cogs_other',        sign: 'expense', department: 'general' };

  if (n >= 5000 && n <= 5009) return { plSection: 'personnel',         plCategory: 'personnel_kitchen', sign: 'expense', department: 'kitchen' };
  if (n >= 5010 && n <= 5019) return { plSection: 'personnel',         plCategory: 'personnel_social',  sign: 'expense', department: 'general' };
  if (n >= 5000 && n <= 5049) return { plSection: 'personnel',         plCategory: 'personnel_service', sign: 'expense', department: 'service' };
  if (n >= 5000 && n <= 5999) return { plSection: 'personnel',         plCategory: 'personnel_other',   sign: 'expense', department: 'general' };

  if (n >= 6000 && n <= 6009) return { plSection: 'operating_expenses', plCategory: 'rent',             sign: 'expense', department: 'general' };
  if (n >= 6010 && n <= 6019) return { plSection: 'operating_expenses', plCategory: 'utilities',        sign: 'expense', department: 'general' };
  if (n >= 6020 && n <= 6029) return { plSection: 'operating_expenses', plCategory: 'cleaning',         sign: 'expense', department: 'general' };
  if (n >= 6030 && n <= 6039) return { plSection: 'operating_expenses', plCategory: 'maintenance',      sign: 'expense', department: 'general' };
  if (n >= 6100 && n <= 6119) return { plSection: 'operating_expenses', plCategory: 'insurance',        sign: 'expense', department: 'general' };
  if (n >= 6200 && n <= 6299) return { plSection: 'operating_expenses', plCategory: 'marketing',        sign: 'expense', department: 'general' };
  if (n >= 6300 && n <= 6399) return { plSection: 'operating_expenses', plCategory: 'bank_fees',        sign: 'expense', department: 'admin'   };
  if (n >= 6400 && n <= 6499) return { plSection: 'operating_expenses', plCategory: 'admin_costs',      sign: 'expense', department: 'admin'   };
  if (n >= 6900 && n <= 6999) return { plSection: 'depreciation_section', plCategory: 'depreciation',  sign: 'expense', department: 'general' };
  if (n >= 6000 && n <= 6999) return { plSection: 'operating_expenses', plCategory: 'other_operating',  sign: 'expense', department: 'general' };

  return { plSection: 'operating_expenses', plCategory: 'other_operating', sign: 'expense', department: 'general' };
}

/**
 * Mehrere Konten als Custom-Mappings importieren (Batch).
 * Bestehende Konten werden überschrieben.
 */
export function importAccountsBatch(accounts: Omit<AccountMapping, 'source'>[]): number {
  let count = 0;
  for (const acc of accounts) {
    saveMappingCustom({ ...acc, source: 'custom' });
    count++;
  }
  return count;
}
