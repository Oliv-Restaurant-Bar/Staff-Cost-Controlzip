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
import { kvGet, kvSetConfirmed } from './supabase-kv';

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
    label: 'Betriebsergebnis 2 (vor Finanzaufw.)',
    description: 'Deckungsbeitrag − Betriebskosten',
    isCalculated: true,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    order: 7,
  },
  {
    id: 'finance_section',
    label: 'Finanzaufwand',
    description: 'Bankspesen und Finanzierungskosten (6900–6999)',
    isCalculated: false,
    color: 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400',
    order: 8,
  },
  {
    id: 'operating_result',
    label: 'Betriebsergebnis 3 (vor Steuern)',
    description: 'Betriebsergebnis 2 − Finanzaufwand',
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
  { id: 'cogs_lager',        label: 'Veränderung Warenvorrat',   section: 'cogs',        sign: 'expense' },
  { id: 'personnel_kitchen', label: 'Löhne Küche',               section: 'personnel',   sign: 'expense' },
  { id: 'personnel_service', label: 'Löhne Service',             section: 'personnel',   sign: 'expense' },
  { id: 'personnel_admin',   label: 'Löhne Verwaltung',          section: 'personnel',   sign: 'expense' },
  { id: 'personnel_social',  label: 'Sozialabgaben (AHV/BVG/UVG)',section:'personnel',   sign: 'expense' },
  { id: 'personnel_other',   label: 'Sonstige Personalkosten',   section: 'personnel',   sign: 'expense' },
  { id: 'rent',              label: 'Raumaufwand (6000–6099)',              section: 'operating_expenses', sign: 'expense' },
  { id: 'maintenance',       label: 'Unterhalt/Rep./Ersatz URE (6100–6199)', section: 'operating_expenses', sign: 'expense' },
  { id: 'vehicle_costs',     label: 'Fahrzeugaufwand (6200–6299)',          section: 'operating_expenses', sign: 'expense' },
  { id: 'insurance',         label: 'Sachversicherungen/Abgaben (6300–6399)', section: 'operating_expenses', sign: 'expense' },
  { id: 'utilities',         label: 'Energie & Wasser (6400–6499)',         section: 'operating_expenses', sign: 'expense' },
  { id: 'admin_costs',       label: 'Verwaltungsaufwand (6500–6599)',       section: 'operating_expenses', sign: 'expense' },
  { id: 'office',            label: 'Büro & Kommunikation (6500–6599)',     section: 'operating_expenses', sign: 'expense' },
  { id: 'marketing',         label: 'Werbung / Marketing (6600–6699)',      section: 'operating_expenses', sign: 'expense' },
  { id: 'cleaning',          label: 'Reinigung & Hygiene',                  section: 'operating_expenses', sign: 'expense' },
  { id: 'other_operating',   label: 'Übriger Betriebsaufwand (6700–6899)', section: 'operating_expenses', sign: 'expense' },
  { id: 'bank_fees',         label: 'Finanzaufwand / Bankspesen (6900–6999)', section: 'finance_section',  sign: 'expense' },
  { id: 'depreciation',      label: 'Abschreibungen',                       section: 'operating_expenses', sign: 'expense' },
  { id: 'unmapped',          label: 'Nicht zugeordnet',                     section: 'operating_expenses', sign: 'expense' },
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
  // ── Umsatz (3xxx) — Oliv Gastro AG ────────────────────────────────────────
  { accountNumber: '3000', accountName: 'Ertrag A',                     plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3001', accountName: 'DLK Umsatz CSV',               plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3010', accountName: 'Ertrag Take Away',             plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3020', accountName: 'Ertrag Wein',                  plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3030', accountName: 'Ertrag Bier',                  plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3040', accountName: 'Ertrag Spirituosen',           plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3050', accountName: 'Ertrag Mineral',               plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3060', accountName: 'Ertrag Küche',                 plCategory: 'revenue_food',     plSection: 'net_revenue', department: 'kitchen', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3070', accountName: 'Ertrag Kaffee, Tee',           plCategory: 'revenue_beverage', plSection: 'net_revenue', department: 'service', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3080', accountName: 'Ertrag Tabakwaren',            plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3090', accountName: 'Ertrag andere Handelswaren',   plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3290', accountName: 'Skonto',                       plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default', notes: 'Erlösminderung, meist negativ' },
  { accountNumber: '3295', accountName: 'Erlösminderung',               plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default', notes: 'Erlösminderung, meist negativ' },
  { accountNumber: '3500', accountName: 'Ertrag Personalverpflegungen', plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3800', accountName: 'Kreditkartenkommissionen',     plCategory: 'bank_fees',        plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '3801', accountName: 'REKA Kommission',              plCategory: 'bank_fees',        plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '3810', accountName: 'MWST Saldosteuersatz',         plCategory: 'other_operating',  plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '3900', accountName: 'Verluste bei Debitoren',       plCategory: 'other_operating',  plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '3910', accountName: 'Ausserordentlicher Ertrag',    plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '3990', accountName: 'Übriger Betriebsertrag',       plCategory: 'revenue_other',    plSection: 'net_revenue', department: 'general', sign: 'income',  canOverride: true,  isActive: true, source: 'default' },

  // ── Wareneinsatz (4xxx) — Oliv Gastro AG ──────────────────────────────────
  { accountNumber: '4000', accountName: 'Warenaufwand GROWA',               plCategory: 'cogs_food',     plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4001', accountName: 'Alligro Warenaufwand',             plCategory: 'cogs_food',     plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4002', accountName: 'Feldschlösschen Aufwand',          plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4010', accountName: 'Keller Warenaufwand',              plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4020', accountName: 'Wein Warenaufwand',                plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4030', accountName: 'Bier Warenaufwand',                plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4040', accountName: 'Spirituosen Warenaufwand',         plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4050', accountName: 'Mineral Warenaufwand',             plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4060', accountName: 'Küche Warenaufwand',               plCategory: 'cogs_food',     plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4070', accountName: 'Kaffee, Tee Warenaufwand',         plCategory: 'cogs_beverage', plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4080', accountName: 'Tabakwaren Warenaufwand',          plCategory: 'cogs_other',    plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4090', accountName: 'Übriger Handelswaren Aufwand',     plCategory: 'cogs_other',    plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4701', accountName: 'Betriebsmaterial Restauration',    plCategory: 'cogs_other',      plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default', notes: 'ER-Warenaufwand (formelle OR-Erfolgsrechnung); operativ NICHT WKQ (Warenkosten-Quote = nur 4000–Grenze)' },
  { accountNumber: '4702', accountName: 'Blumen / Dekoration Restauration', plCategory: 'cogs_other',      plSection: 'cogs', department: 'service', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4703', accountName: 'Brennmaterial (Pizzaofen)',         plCategory: 'cogs_other',      plSection: 'cogs', department: 'kitchen', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4800', accountName: 'Einkaufsabrechnungskonto Gebinde', plCategory: 'cogs_other',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default', notes: 'ER-Warenaufwand (formelle OR-ER, Gebinde-Verrechnung); operativ NICHT WKQ' },
  { accountNumber: '4801', accountName: 'Gebinde',                          plCategory: 'cogs_other',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '4900', accountName: 'Veränderung Warenvorrat',          plCategory: 'cogs_lager',      plSection: 'cogs', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default', notes: 'Lagerveränderung — Teil des Wareneinsatzes (WES), nicht des Wareneinkaufs; kann positiv oder negativ sein' },

  // ── Personalkosten (5xxx) — Oliv Gastro AG ────────────────────────────────
  { accountNumber: '5000', accountName: 'Löhne',                         plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'kitchen', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5001', accountName: 'Löhne Flex',                    plCategory: 'personnel_service', plSection: 'personnel', department: 'service', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5002', accountName: '13. Monatslohn',                plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'kitchen', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5003', accountName: 'Ferien- und Feiertage',         plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'kitchen', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5004', accountName: 'Personal Aushilfe',             plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5005', accountName: 'Personal Aushilfe',             plCategory: 'personnel_kitchen', plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5010', accountName: 'Zulagen / Soz. Vergütungen',    plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5020', accountName: 'Provisionen',                   plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  // Sozialabgaben (5700–5799) — exakte Sage-Kontonummern
  { accountNumber: '5700', accountName: 'AHV, IV, EO, ALV',              plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5710', accountName: 'FAK',                           plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5720', accountName: 'Vorsorgeeinrichtungen BVG',     plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5730', accountName: 'Unfallversicherungen UVG',      plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5740', accountName: 'Krankentaggeldvers. KVG',       plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '5750', accountName: 'Quellensteuer',                  plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5760', accountName: 'BU-Versicherung AG',            plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5770', accountName: 'Verbände-Beiträge AG',          plCategory: 'personnel_social',  plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  // Sonstige Personalkosten
  { accountNumber: '5800', accountName: 'Personalbeschaffung',           plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5810', accountName: 'Aus- und Weiterbildung',        plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5820', accountName: 'Verpflegung / Mittagszulagen',  plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5830', accountName: 'Spesenentschädigung effektiv',  plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5835', accountName: 'Berufswäsche',                  plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5840', accountName: 'Spesenentschädigung pauschal',  plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5841', accountName: 'Reisespesen',                   plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5850', accountName: 'Privatanteile Personalaufwand', plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '5890', accountName: 'Übriger Personalaufwand',       plCategory: 'personnel_other',   plSection: 'personnel', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },

  // ── Betriebskosten (6xxx) — Oliv Gastro AG ────────────────────────────────
  // Miete & Nebenkosten
  { accountNumber: '6000', accountName: 'Mietzins',                  plCategory: 'rent',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6001', accountName: 'Mietzins Lager',            plCategory: 'rent',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6002', accountName: 'Mietzins Parkplatz',        plCategory: 'rent',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6031', accountName: 'Nebenkosten',               plCategory: 'rent',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6032', accountName: 'Nebenkosten Lager',         plCategory: 'rent',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  // Reinigung & Entsorgung
  { accountNumber: '6040', accountName: 'Reinigung und Entsorgung',  plCategory: 'cleaning',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6460', accountName: 'Kehrichtabfuhr',            plCategory: 'cleaning',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  // Unterhalt & Reparaturen
  { accountNumber: '6050', accountName: 'Unterhalt Geschäftsräume',      plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6100', accountName: 'URE Maschinen und Apparate',    plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6101', accountName: 'Leasing von Maschinen',         plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6110', accountName: 'URE Mobiliar und Einrichtung',  plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6111', accountName: 'Leasing Mobiliar und Einr.',    plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6120', accountName: 'URE Installationen',            plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6130', accountName: 'URE Immobilien',                plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6140', accountName: 'URE Informatik EDV',            plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '61409',accountName: 'URE Informatik EDV',            plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6190', accountName: 'Übrige Reparaturen',            plCategory: 'maintenance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Fahrzeugkosten
  { accountNumber: '6200', accountName: 'Fahrzeug Service',           plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6210', accountName: 'Fahrzeug Benzin',            plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6220', accountName: 'Fahrzeug Versicherung',      plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6230', accountName: 'Verkehrsabgaben / Steuern',  plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6240', accountName: 'Fahrzeug Leasing',           plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6250', accountName: 'Fahrzeugmieten',             plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6280', accountName: 'Privatanteil Fahrzeugaufw.', plCategory: 'vehicle_costs',   plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Versicherungen
  { accountNumber: '6300', accountName: 'Versicherungen',            plCategory: 'insurance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6310', accountName: 'Betriebshaftpflicht',       plCategory: 'insurance', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  { accountNumber: '6360', accountName: 'Abgaben, Gebühren',         plCategory: 'insurance',       plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6370', accountName: 'Bewilligungen',             plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Energie
  { accountNumber: '6400', accountName: 'Strom, Gas, Heizöl und Wasser', plCategory: 'utilities', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6410', accountName: 'Heizung und Brennmaterial',     plCategory: 'utilities', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true,  isActive: true, source: 'default' },
  // Büro & Verwaltung
  { accountNumber: '6500', accountName: 'Büromaterial',                  plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6501', accountName: 'Drucksachen',                   plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6502', accountName: 'Fachliteratur, Zeitungen',      plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6510', accountName: 'Telefon, Internet',             plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6511', accountName: 'Porti',                         plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6520', accountName: 'Verbandsbeiträge',              plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6521', accountName: 'Zeitungen und Zeitschriften',   plCategory: 'office',      plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6530', accountName: 'Buchhaltungshonorar',           plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: false, isActive: true, source: 'default' },
  { accountNumber: '6531', accountName: 'Unternehmensberatung',          plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6532', accountName: 'Rechtsberatung',                plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6540', accountName: 'Aufwand Revisionsstelle',       plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6550', accountName: 'Verbrauchsmaterial',            plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6590', accountName: 'Sonstiger Verwaltungsaufwand',  plCategory: 'admin_costs', plSection: 'operating_expenses', department: 'admin',   sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Marketing & Werbung
  { accountNumber: '6600', accountName: 'Werbeinserate',         plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6610', accountName: 'Werbedrucksachen',      plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6611', accountName: 'Kost & Logis Personal', plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default', notes: 'Kost & Logis Personal — Werbeaufwand (6600–6690) analog formeller OR-ER; Personalaufwand = nur 5xxx' },
  { accountNumber: '6612', accountName: 'Beiträge und Spenden',  plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6620', accountName: 'Schaufenster, Dekoration', plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6640', accountName: 'Kundengeschenke',       plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6650', accountName: 'Sponsoring',            plCategory: 'marketing', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  // Sonstiger betrieblicher Aufwand
  { accountNumber: '6690', accountName: 'Diverse Auslagen',      plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6790', accountName: 'Sonst. betr. Aufwand',  plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6791', accountName: 'Privatanteile',         plCategory: 'other_operating', plSection: 'operating_expenses', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },

  // ── Abschreibungen (6800–6899) — Oliv Gastro AG ───────────────────────────
  { accountNumber: '6800', accountName: 'Abschreibungen & WB',           plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6802', accountName: 'Abschreibungen Kleininventar',  plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6810', accountName: 'Abschreibungen & WB Mobiliar',  plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6820', accountName: 'Abschreibungen & WB Maschinen', plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6830', accountName: 'Abschreibungen & WB Fahrzeuge', plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6870', accountName: 'Abschreibungen & WB Liegenschaften', plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6880', accountName: 'Abschreibungen Wäsche, Geschirr', plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6890', accountName: 'Wertberichtigungen übrige Fin.', plCategory: 'depreciation', plSection: 'depreciation_section', department: 'general', sign: 'expense', canOverride: true, isActive: true, source: 'default' },

  // ── Finanzaufwand / Bankkosten (6900–6960) ────────────────────────────────
  { accountNumber: '6900', accountName: 'Bankkreditzinsaufwand',   plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6901', accountName: 'Darlehenszinsaufwand',    plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6902', accountName: 'Hypothekarzinsaufwand',   plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6910', accountName: 'Zinsaufwand Darlehen A',  plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6911', accountName: 'Zinsaufwand Darlehen B',  plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: true, isActive: true, source: 'default' },
  { accountNumber: '6940', accountName: 'Bankspesen',              plCategory: 'bank_fees', plSection: 'operating_expenses', department: 'admin', sign: 'expense', canOverride: false, isActive: true, source: 'default' },
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
  { from: '4700', to: '4799', plCategory: 'cogs_other',       plSection: 'cogs',               department: 'general', sign: 'expense', description: 'Betriebsmaterial / Direktkosten (allgemein)' },
  { from: '4800', to: '4899', plCategory: 'cogs_other',       plSection: 'cogs',        department: 'general', sign: 'expense', description: 'Emballagen / Gebinde (allgemein)' },
  { from: '4900', to: '4999', plCategory: 'cogs_lager',       plSection: 'cogs',        department: 'general', sign: 'expense', description: 'Veränderung Warenvorrat / Bestandesänderungen (allgemein)' },
  { from: '5000', to: '5049', plCategory: 'personnel_kitchen',plSection: 'personnel',   department: 'kitchen', sign: 'expense', description: 'Löhne (allgemein)' },
  { from: '5010', to: '5019', plCategory: 'personnel_social', plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sozialabgaben (allgemein)' },
  { from: '5050', to: '5099', plCategory: 'personnel_other',  plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sonstige Personalkosten (allgemein)' },
  { from: '5100', to: '5699', plCategory: 'personnel_other',  plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sonstige Personalkosten / Nebenkosten (allgemein)' },
  { from: '5700', to: '5799', plCategory: 'personnel_social', plSection: 'personnel',   department: 'general', sign: 'expense', description: 'Sozialabgaben Sage-Konten (AHV/BVG/UVG/KTG)' },
  { from: '6000', to: '6009', plCategory: 'rent',             plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Miete (allgemein)' },
  { from: '6010', to: '6019', plCategory: 'utilities',        plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Energie & Wasser (allgemein)' },
  { from: '6020', to: '6029', plCategory: 'cleaning',         plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Reinigung (allgemein)' },
  { from: '6100', to: '6199', plCategory: 'maintenance',      plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Unterhalt / Reparaturen / URE / Leasing (allgemein)' },
  { from: '6200', to: '6299', plCategory: 'vehicle_costs',    plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Fahrzeugaufwand (allgemein)' },
  { from: '6300', to: '6399', plCategory: 'insurance',        plSection: 'operating_expenses', department: 'general', sign: 'expense', description: 'Versicherungen (allgemein)' },
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
  // Kept optimistic-local: callers (CSVImport/PLView/AccountMapping) are
  // synchronous UI actions that read back via loadCustomMappings() right
  // after calling this, so localStorage is written immediately. The
  // Supabase write is still fire-and-forget, but Issue #5 fixed the SILENT
  // part of that: a failed write used to be swallowed with no visible
  // signal at all (`kvSet(...).catch(() => {})`) — now it shows the same
  // error toast/retry used elsewhere in the app.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  void kvSetConfirmed(STORAGE_KEY, data, 'Kontenzuordnung').catch(() => { /* toast already shown */ });
}

/**
 * Custom-Mappings aus Supabase laden (async).
 * Wenn Supabase leer ist aber localStorage Daten hat: einmalige Auto-Migration.
 * Gibt true zurück wenn neue Daten geladen wurden (Seite sollte neu rendern).
 */
export async function loadCustomMappingsFromDB(): Promise<boolean> {
  try {
    const remote = await kvGet(STORAGE_KEY);
    if (remote !== null && typeof remote === 'object' && Object.keys(remote as object).length > 0) {
      const data = remote as Record<string, AccountMapping>;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      console.log(`[Konten] Aus Supabase geladen: ${Object.keys(data).length} Custom-Mappings`);
      return true;
    }
    const local = loadCustomMappings();
    if (Object.keys(local).length > 0) {
      console.log(`[Konten] Supabase leer – sync localStorage→Supabase: ${Object.keys(local).length} Mappings`);
      kvSetConfirmed(STORAGE_KEY, local, 'Kontenzuordnung').catch(() => { /* toast already shown */ });
    } else {
      console.log('[Konten] Keine Custom-Mappings in Supabase oder localStorage');
    }
    return false;
  } catch (err) {
    console.error('[Konten] loadCustomMappingsFromDB Fehler:', err);
    return false;
  }
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
