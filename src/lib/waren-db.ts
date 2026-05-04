/**
 * waren-db – Warenrechnungen Datenschicht
 * =========================================
 * Speichert Lieferanten und Rechnungseinträge im Supabase app_settings KV-Store.
 * Mandantentrennung via tenantKey-Präfix (beaulieu: oder leer für oliv).
 *
 * Schlüssel:
 *   suppliers_v1              → Array<Supplier>
 *   supplier_invoices_YYYY-MM → Array<InvoiceEntry>
 *
 * Debug-Logs: [WAREN]
 */

import { kvGet, kvSet } from './supabase-kv';
import { tenantKey } from './tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface Supplier {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

/**
 * Kategorie einer Warenrechnung für die Kostenaufteilung Food/Beverage.
 */
export type WarenKategorie = 'Food' | 'Beverage' | 'Sonstiges';

/**
 * Zuordnung eines Rechnungsbetrags zu einem Warenkonto.
 * Wird für die optionale Kontoaufteilung (Split auf 2 Konten) verwendet.
 */
export interface KontoSplit {
  warenkonto: string;   // Kontonummer, z.B. "4000"
  amountGross: number;
  amountNet: number;
}

export interface InvoiceEntry {
  id: string;
  date: string;          // YYYY-MM-DD
  supplierName: string;
  amountGross: number;   // Betrag inkl. MWST (Gesamtbetrag)
  amountNet: number;     // Betrag exkl. MWST (Gesamtbetrag)
  vatIncluded: boolean;  // true = Eingabe war Brutto, false = Netto
  vatRate: number;       // z.B. 8.1 oder 2.6
  reference?: string;    // Rechnungs- oder Lieferscheinnummer
  note?: string;
  /** Optionales Warenkonto (einfache Zuweisung, kein Split) */
  warenkonto?: string;
  /** Optionale Kontoaufteilung auf 2 Konten (überschreibt warenkonto wenn vorhanden) */
  kontoSplits?: KontoSplit[];
  /** Kategorie für Food/Beverage-Auswertung (Standard: Sonstiges) */
  kategorie?: WarenKategorie;
  createdAt: string;
  updatedAt: string;
}

// ─── Warenkonto Schnellauswahl ────────────────────────────────────────────────

export const WARENKONTO_LIST: { value: string; label: string }[] = [
  { value: '4000', label: '4000 – Warenaufwand Lebensmittel' },
  { value: '4020', label: '4020 – Warenaufwand Getränke' },
  { value: '4030', label: '4030 – Warenaufwand Tiefkühl' },
  { value: '4040', label: '4040 – Warenaufwand Tabakwaren' },
  { value: '4050', label: '4050 – Warenaufwand Reinigung' },
  { value: '4060', label: '4060 – Warenaufwand Diverses' },
  { value: '4071', label: '4071 – Eigenverbrauch' },
  { value: '6040', label: '6040 – Betriebsaufwand' },
];

/**
 * Leitet die WarenKategorie automatisch vom Warenkonto ab (Fallback-Hilfe).
 * Wichtig: Die explizit gespeicherte `InvoiceEntry.kategorie` hat immer Vorrang.
 *
 * Mapping:
 *   4000 (Lebensmittel), 4030 (Tiefkühl) → Food
 *   4020 (Getränke)                       → Beverage
 *   alle anderen                          → Sonstiges
 */
export function kategorieFromKonto(konto: string | undefined): WarenKategorie {
  if (!konto) return 'Sonstiges';
  const n = parseInt(konto, 10);
  if (n === 4000 || n === 4030) return 'Food';
  if (n === 4020)               return 'Beverage';
  return 'Sonstiges';
}

// ─── Standard-Lieferanten ─────────────────────────────────────────────────────

export const DEFAULT_SUPPLIERS: string[] = [
  'Prodega',
  'Transgourmet',
  'Blaser Café',
  'Metzgerei Spahni',
  'Siebe Dupf',
  'Feldschlösschen',
  'Chocolats Camille',
  'Caporaso',
  'Ambro Food',
  'La Marra',
  'Asia Company',
  'Amarx Espro',
  'Terravigna',
  'Fideco',
  'Korngold',
  'Paul Ulrich',
  'Hiestand',
  'Frigemo',
  'Compagnie Desserts',
];

// ─── Schlüssel-Helfer ─────────────────────────────────────────────────────────

function suppliersKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'suppliers_v1');
}

function invoicesKey(tenantId: TenantId, monthKey: string): string {
  return tenantKey(tenantId, `supplier_invoices_${monthKey}`);
}

function monthKey(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

// ─── Lieferanten ─────────────────────────────────────────────────────────────

export async function loadSuppliers(tenantId: TenantId): Promise<Supplier[]> {
  const key = suppliersKey(tenantId);
  const raw = await kvGet(key);
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as Supplier[];
  }
  // Initialisierung mit Standard-Lieferanten
  const defaults = DEFAULT_SUPPLIERS.map((name, i) => ({
    id: `sup-${i + 1}`,
    name,
    active: true,
    createdAt: new Date().toISOString(),
  }));
  await kvSet(key, defaults);
  console.log(`[WAREN] supplier list initialized: ${defaults.length} default suppliers for tenant "${tenantId}"`);
  return defaults;
}

export async function saveSuppliers(tenantId: TenantId, suppliers: Supplier[]): Promise<void> {
  const key = suppliersKey(tenantId);
  await kvSet(key, suppliers);
  console.log(`[WAREN] suppliers saved: ${suppliers.length} entries for tenant "${tenantId}"`);
}

// ─── Rechnungseinträge ────────────────────────────────────────────────────────

export async function loadMonthInvoices(
  tenantId: TenantId,
  month: string, // YYYY-MM
): Promise<InvoiceEntry[]> {
  const key = invoicesKey(tenantId, month);
  const raw = await kvGet(key);
  if (Array.isArray(raw)) return raw as InvoiceEntry[];
  return [];
}

export async function saveInvoiceEntry(
  tenantId: TenantId,
  entry: InvoiceEntry,
): Promise<void> {
  const month = monthKey(entry.date);
  const key = invoicesKey(tenantId, month);
  const existing = await loadMonthInvoices(tenantId, month);
  const idx = existing.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    existing[idx] = { ...entry, updatedAt: new Date().toISOString() };
    console.log(`[WAREN] entry updated: id=${entry.id} date=${entry.date} supplier=${entry.supplierName} net=${entry.amountNet.toFixed(2)} gross=${entry.amountGross.toFixed(2)}`);
  } else {
    existing.push(entry);
    console.log(`[WAREN] entry saved: id=${entry.id} date=${entry.date} supplier=${entry.supplierName} net=${entry.amountNet.toFixed(2)} gross=${entry.amountGross.toFixed(2)}`);
  }
  await kvSet(key, existing);
}

export async function deleteInvoiceEntry(
  tenantId: TenantId,
  entryId: string,
  date: string,
): Promise<void> {
  const month = monthKey(date);
  const key = invoicesKey(tenantId, month);
  const existing = await loadMonthInvoices(tenantId, month);
  const filtered = existing.filter(e => e.id !== entryId);
  await kvSet(key, filtered);
  console.log(`[WAREN] entry deleted: id=${entryId} date=${date} tenant="${tenantId}"`);
}

// ─── Tagesumsatz aus dailyBudgets ─────────────────────────────────────────────

export interface DailyRevenue {
  date: string;
  actualRevenue: number;
}

export function loadDailyRevenueFromLocalStorage(
  tenantId: TenantId,
  month: string, // YYYY-MM
): Record<string, number> {
  const lsKey = tenantId === 'oliv' ? 'dailyBudgets' : 'beaulieu:dailyBudgets';
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { actualRevenue?: number }>;
    const result: Record<string, number> = {};
    for (const [date, val] of Object.entries(parsed)) {
      if (date.startsWith(month)) {
        result[date] = val.actualRevenue ?? 0;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Monatliches Umsatz-Budget (Warenrechnungen-Analyse) ──────────────────────

/**
 * Schlüssel für das monatliche Umsatz-Budget im KV-Store.
 * Format: { "YYYY-MM": CHF_Betrag, ... }
 * Beispiel Beaulieu 2026: beaulieu:waren_monthly_rev_2026 = { "2026-01": 120000, ... }
 */
function monthlyRevKey(tenantId: TenantId, year: number): string {
  return tenantKey(tenantId, `waren_monthly_rev_${year}`);
}

/**
 * Lädt das monatliche Umsatz-Budget für ein Jahr aus dem KV-Store.
 * Gibt ein leeres Objekt zurück wenn kein Budget gesetzt ist.
 */
export async function loadWarenMonthlyRevenue(
  tenantId: TenantId,
  year: number,
): Promise<Record<string, number>> {
  const key = monthlyRevKey(tenantId, year);
  const raw = await kvGet(key);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, number>;
  }
  return {};
}

/**
 * Speichert das monatliche Umsatz-Budget für ein Jahr im KV-Store.
 * @param data Record mit "YYYY-MM" → CHF-Betrag (z.B. { "2026-01": 120000 })
 */
export async function saveWarenMonthlyRevenue(
  tenantId: TenantId,
  year: number,
  data: Record<string, number>,
): Promise<void> {
  const key = monthlyRevKey(tenantId, year);
  await kvSet(key, data);
  console.log(`[WAREN] monthly revenue budget saved: year=${year} tenant="${tenantId}" months=${Object.keys(data).length}`);
}

/**
 * Tagesgewichte für die Umsatzverteilung.
 * Index = getDay() Rückgabewert: 0=So, 1=Mo, 2=Di, 3=Mi, 4=Do, 5=Fr, 6=Sa
 * Restaurant Beaulieu: Mo–Fr = 15, Sa = 10, So = 0 (geschlossen)
 */
export const WAREN_DAY_WEIGHTS = [0, 15, 15, 15, 15, 15, 10];

/**
 * Berechnet den tagesgenauen Budget-Umsatz basierend auf den Tagesgewichten.
 * @param monthBudget Monatlicher Gesamtbudget-Umsatz in CHF
 * @param dayStr Datum des Tages (YYYY-MM-DD)
 * @param allDaysInMonth Alle Tage des Monats (YYYY-MM-DD[])
 * @returns Anteil des Tages am Monatsbudget
 */
export function computeDailyBudgetRevenue(
  monthBudget: number,
  dayStr: string,
  allDaysInMonth: string[],
): number {
  const totalWeight = allDaysInMonth.reduce((s, d) => {
    const dow = new Date(d + 'T12:00:00').getDay();
    return s + WAREN_DAY_WEIGHTS[dow];
  }, 0);
  if (totalWeight === 0) return 0;
  const dow = new Date(dayStr + 'T12:00:00').getDay();
  const w = WAREN_DAY_WEIGHTS[dow];
  return w === 0 ? 0 : (w / totalWeight) * monthBudget;
}

/**
 * Vordefinierte monatliche Umsatz-Budgets.
 * Quelle: Budget_Beaulieu_2026.xlsx – BETRIEBSERTRAG NETTO
 */
const PRESET_MONTHLY_BUDGETS: Record<string, Record<string, number>> = {
  'beaulieu:waren_monthly_rev_2026': {
    '2026-01': 120000,
    '2026-02': 130000,
    '2026-03': 150000,
    '2026-04': 200000,
    '2026-05': 170000,
    '2026-06': 160000,
    '2026-07': 120000,
    '2026-08': 140000,
    '2026-09': 130000,
    '2026-10': 170000,
    '2026-11': 200000,
    '2026-12': 200000,
  },
};

/**
 * Seed-Funktion: Trägt vordefinierte Budgets automatisch ein wenn noch kein Eintrag vorhanden.
 * Wird beim ersten Laden des Analyse-Tabs aufgerufen (läuft im authentifizierten Browser-Client).
 */
export async function seedMonthlyRevenueIfMissing(
  tenantId: TenantId,
  year: number,
): Promise<void> {
  const key = monthlyRevKey(tenantId, year);
  const existing = await kvGet(key);
  if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
    console.log(`[WAREN] monthly revenue budget already exists for ${key}, skipping seed`);
    return;
  }
  const preset = PRESET_MONTHLY_BUDGETS[key];
  if (!preset) return;
  await kvSet(key, preset);
  console.log(`[WAREN] monthly revenue budget seeded for ${key}: ${Object.keys(preset).length} months`);
}

// ─── Berechnungshelfer ────────────────────────────────────────────────────────

export function calcAmounts(
  amount: number,
  vatIncluded: boolean,
  vatRate: number,
): { amountGross: number; amountNet: number } {
  if (vatIncluded) {
    const amountGross = amount;
    const amountNet = amount / (1 + vatRate / 100);
    return { amountGross, amountNet };
  } else {
    const amountNet = amount;
    const amountGross = amount * (1 + vatRate / 100);
    return { amountGross, amountNet };
  }
}

// ─── Monatsstatistik ──────────────────────────────────────────────────────────

export interface SupplierMonthTotal {
  supplierName: string;
  totalNet: number;
  totalGross: number;
  entryCount: number;
  byDate: Record<string, number>; // date → net amount
}

export interface MonthStats {
  totalNet: number;
  totalGross: number;
  supplierTotals: SupplierMonthTotal[];
  revenueByDate: Record<string, number>;
  entryCount: number;
}

export function computeMonthStats(
  entries: InvoiceEntry[],
  revenueByDate: Record<string, number>,
): MonthStats {
  const supplierMap = new Map<string, SupplierMonthTotal>();

  let totalNet = 0;
  let totalGross = 0;

  for (const e of entries) {
    totalNet += e.amountNet;
    totalGross += e.amountGross;

    if (!supplierMap.has(e.supplierName)) {
      supplierMap.set(e.supplierName, {
        supplierName: e.supplierName,
        totalNet: 0,
        totalGross: 0,
        entryCount: 0,
        byDate: {},
      });
    }
    const st = supplierMap.get(e.supplierName)!;
    st.totalNet += e.amountNet;
    st.totalGross += e.amountGross;
    st.entryCount++;
    st.byDate[e.date] = (st.byDate[e.date] ?? 0) + e.amountNet;
  }

  const supplierTotals = Array.from(supplierMap.values()).sort(
    (a, b) => b.totalNet - a.totalNet,
  );

  const totalRevenue = Object.values(revenueByDate).reduce((s, v) => s + v, 0);
  const totalRevenuePct = totalRevenue > 0 ? (totalNet / totalRevenue) * 100 : 0;

  console.log(`[WAREN] month total chf: ${totalNet.toFixed(2)} net / ${totalGross.toFixed(2)} gross`);
  console.log(`[WAREN] month total pct: ${totalRevenuePct.toFixed(1)}%`);
  console.log(`[WAREN] supplier totals: ${supplierTotals.map(s => `${s.supplierName}=${s.totalNet.toFixed(0)}`).join(', ')}`);

  return {
    totalNet,
    totalGross,
    supplierTotals,
    revenueByDate,
    entryCount: entries.length,
  };
}
