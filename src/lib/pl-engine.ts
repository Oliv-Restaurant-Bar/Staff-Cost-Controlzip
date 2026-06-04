/**
 * P&L-Engine – Berechnung der Erfolgsrechnung
 * =============================================
 *
 * Transformation:
 *   MonthlyFinancialRecord[]  →  PLMonthResult / PLYearResult
 *
 * Die Struktur des P&L (PL_STRUCTURE) ist nach dem klassischen
 * Gastronomie-GuV-Schema (Schweiz/DACH) aufgebaut:
 *
 *   Betriebsertrag netto
 *   − Direkter Warenaufwand
 *   = Bruttogewinn 1
 *   − Personal (Löhne + Sozialleistungen + übriger Personalaufwand)
 *   = Bruttogewinn 2 / Deckungsbeitrag
 *   − Raum- & Betriebsaufwand
 *   = EBITDA
 *   − Abschreibungen
 *   = Betriebsergebnis (EBIT)
 *
 * Mapping der Ausgabenkategorien (categoryId → P&L-Zeile):
 *   Das Mapping ist großzügig – typische Buchhaltungs-IDs werden
 *   alle einer Zeile zugeordnet. Unbekannte Kategorien landen in
 *   "Übrige Betriebskosten" (catch-all).
 */

import { MonthlyFinancialRecord } from '@/types/reporting';
import {
  PLRowDef, PLCellValues, PLComputedRow, PLMonthResult,
  PLYearResult, PLSourceCategory, PLDrilldown,
} from '@/types/pl';
import { lookupAccount } from '@/lib/account-mapping-store';
import { PL_CATEGORY_TO_ROW_ID } from '@/lib/csv-import-engine';

/**
 * Gibt die P&L-Zeilen-ID für eine categoryId zurück.
 * Unterstützt:
 *   - Human-readable IDs (z.B. 'wareneinsatz_kueche') → CATEGORY_TO_ROW
 *   - 4-stellige Kontonummern aus CSV-Import → lookupAccount → PLCategory → Row
 */
function resolveRowId(categoryId: string): string | null {
  // Direkt-Mapping (human-readable)
  const direct = CATEGORY_TO_ROW[categoryId];
  if (direct) return direct;

  // Account-Nummern-Matching (CSV-Import): 3-5-stellige Zahl
  if (/^\d{3,5}$/.test(categoryId)) {
    const result = lookupAccount(categoryId);
    if (result.mapping) {
      return PL_CATEGORY_TO_ROW_ID[result.mapping.plCategory] ?? 'other_operating';
    }
  }

  return null; // unbekannt → landet in catch-all
}

// ─── Kategorie-Mapping ────────────────────────────────────────────────────────

/**
 * Ordnet bekannte categoryIds einer P&L-Zeile zu.
 * Mehrere categoryIds können dieselbe Zeile bedienen.
 */
const CATEGORY_TO_ROW: Record<string, string> = {
  // Wareneinsatz
  wareneinsatz_kueche:    'cogs_food',
  warenaufwand_kueche:    'cogs_food',
  food_cost:              'cogs_food',
  wareneinsatz_bar:       'cogs_bev',
  wareneinsatz_getraenke: 'cogs_bev',
  warenaufwand_getraenke: 'cogs_bev',
  beverage_cost:          'cogs_bev',
  wareneinsatz_diverses:  'cogs_other',
  warenaufwand_diverses:  'cogs_other',
  // Sozialleistungen
  sozialleistungen:       'personnel_social',
  ahv:                    'personnel_social',
  bvg:                    'personnel_social',
  uvg:                    'personnel_social',
  social_costs:           'personnel_social',
  // Übriger Personalaufwand
  personal_sonstiges:     'personnel_other',
  ausbildung:             'personnel_other',
  weiterbildung:          'personnel_other',
  personalverpflegung:    'personnel_other',
  // Raumaufwand
  miete:                  'rent',
  raumaufwand:            'rent',
  nebenkosten:            'rent',
  mietnebenkosten:        'rent',
  // Energie
  energie:                'utilities',
  strom:                  'utilities',
  gas:                    'utilities',
  wasser:                 'utilities',
  // Reinigung
  reinigung:              'cleaning',
  hygiene:                'cleaning',
  reinigungsmittel:       'cleaning',
  // Unterhalt
  unterhalt:              'maintenance',
  reparaturen:            'maintenance',
  kleininventar:          'maintenance',
  instandhaltung:         'maintenance',
  // Versicherungen
  versicherung:           'insurance',
  gebuehren:              'insurance',
  lizenzen:               'insurance',
  // Marketing
  marketing:              'marketing',
  werbung:                'marketing',
  promotionen:            'marketing',
  events:                 'marketing',
  // Verwaltung
  verwaltung:             'admin',
  buero:                  'admin',
  buchhaltung:            'admin',
  beratung:               'admin',
  bank:                   'admin',
  bankgebuehren:          'admin',
  rechtsberatung:         'admin',
  telefon:                'admin',
  // Abschreibungen
  abschreibungen:         'depreciation',
  afa:                    'depreciation',
  amortisation:           'depreciation',
  // Catch-all (alles andere → Sonstiges)
  sonstiges:              'other_operating',
  diverses:               'other_operating',
  // Gastronovi-Kategorien (Kassensystem-Import)
  gnv_food:               'revenue_total',
  gnv_beverage:           'revenue_total',
  gnv_other:              'revenue_total',
};

/** Alle categoryIds, die einer definierten Zeile zugeordnet sind */
const KNOWN_CATEGORY_IDS = new Set(Object.keys(CATEGORY_TO_ROW));

// ─── P&L-Struktur-Definition ──────────────────────────────────────────────────

export const PL_STRUCTURE: PLRowDef[] = [
  // ── BETRIEBSERTRAG ──────────────────────────────────────────────────────────
  { id: 'section_revenue', type: 'section', label: 'BETRIEBSERTRAG', indent: 0, showPercent: false },
  {
    id: 'revenue_total', type: 'line', label: 'Umsatz (netto)',
    indent: 1, showPercent: false, valueRole: 'positive',
    directField: 'revenue',
    // Gastronovi-Kategorien können zusätzlich zur directField-Summe für Drilldown genutzt werden
    categoryIds: ['gnv_food', 'gnv_beverage', 'gnv_other'],
  },
  {
    id: 'net_revenue', type: 'result', label: 'Betriebsertrag netto',
    indent: 0, showPercent: false, valueRole: 'positive',
    computedFrom: { type: 'sum', rowIds: ['revenue_total'] },
  },

  // ── DIREKTER WARENAUFWAND ────────────────────────────────────────────────────
  { id: 'spacer_1', type: 'spacer', label: '', indent: 0, showPercent: false },
  { id: 'section_cogs', type: 'section', label: 'DIREKTER WARENAUFWAND', indent: 0, showPercent: false },
  {
    id: 'cogs_food', type: 'line', label: 'Wareneinsatz Küche',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['wareneinsatz_kueche', 'warenaufwand_kueche', 'food_cost'],
  },
  {
    id: 'cogs_bev', type: 'line', label: 'Wareneinsatz Getränke',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['wareneinsatz_bar', 'wareneinsatz_getraenke', 'warenaufwand_getraenke', 'beverage_cost'],
  },
  {
    id: 'cogs_other', type: 'line', label: 'Warenaufwand Diverses',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['wareneinsatz_diverses', 'warenaufwand_diverses'],
  },
  {
    id: 'total_cogs', type: 'subtotal', label: 'Total Warenaufwand',
    indent: 0, showPercent: false, valueRole: 'negative',
    computedFrom: { type: 'sum', rowIds: ['cogs_food', 'cogs_bev', 'cogs_other'] },
  },
  {
    id: 'gross_profit_1', type: 'result', label: 'Bruttogewinn 1',
    indent: 0, showPercent: true, valueRole: 'positive',
    computedFrom: { type: 'subtract', rowIds: ['net_revenue', 'total_cogs'] },
  },

  // ── PERSONAL ────────────────────────────────────────────────────────────────
  { id: 'spacer_2', type: 'spacer', label: '', indent: 0, showPercent: false },
  { id: 'section_personnel', type: 'section', label: 'PERSONAL', indent: 0, showPercent: false },
  {
    id: 'personnel_wages', type: 'line', label: 'Löhne (Total)',
    indent: 1, showPercent: false, valueRole: 'negative',
    directField: 'personnel_actual',
  },
  {
    id: 'personnel_social', type: 'line', label: 'Sozialleistungen',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['sozialleistungen', 'ahv', 'bvg', 'uvg', 'social_costs'],
  },
  {
    id: 'personnel_other', type: 'line', label: 'Übriger Personalaufwand',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['personal_sonstiges', 'ausbildung', 'weiterbildung', 'personalverpflegung'],
  },
  {
    id: 'total_personnel', type: 'subtotal', label: 'Total Personal',
    indent: 0, showPercent: false, valueRole: 'negative',
    computedFrom: { type: 'sum', rowIds: ['personnel_wages', 'personnel_social', 'personnel_other'] },
  },
  {
    id: 'gross_profit_2', type: 'result', label: 'Bruttogewinn 2 / Deckungsbeitrag',
    indent: 0, showPercent: true, valueRole: 'positive',
    computedFrom: { type: 'subtract', rowIds: ['gross_profit_1', 'total_personnel'] },
  },

  // ── BETRIEBSKOSTEN ──────────────────────────────────────────────────────────
  { id: 'spacer_3', type: 'spacer', label: '', indent: 0, showPercent: false },
  { id: 'section_opex', type: 'section', label: 'RAUM- & BETRIEBSAUFWAND', indent: 0, showPercent: false },
  {
    id: 'rent', type: 'line', label: 'Raumaufwand',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['miete', 'raumaufwand', 'nebenkosten', 'mietnebenkosten'],
  },
  {
    id: 'utilities', type: 'line', label: 'Energie & Wasser',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['energie', 'strom', 'gas', 'wasser'],
  },
  {
    id: 'cleaning', type: 'line', label: 'Reinigung & Hygiene',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['reinigung', 'hygiene', 'reinigungsmittel'],
  },
  {
    id: 'maintenance', type: 'line', label: 'Unterhalt & Reparaturen',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['unterhalt', 'reparaturen', 'kleininventar', 'instandhaltung'],
  },
  {
    id: 'insurance', type: 'line', label: 'Versicherungen / Gebühren',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['versicherung', 'gebuehren', 'lizenzen'],
  },
  {
    id: 'marketing', type: 'line', label: 'Marketing & Werbung',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['marketing', 'werbung', 'promotionen', 'events'],
  },
  {
    id: 'admin', type: 'line', label: 'Verwaltung / Büro / Bankgebühren',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['verwaltung', 'buero', 'buchhaltung', 'beratung', 'bank', 'bankgebuehren', 'rechtsberatung', 'telefon'],
  },
  {
    id: 'other_operating', type: 'line', label: 'Übrige Betriebskosten',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['sonstiges', 'diverses'],
    // ⬆ catch-all: also receives unmapped categories (added dynamically by engine)
  },
  {
    id: 'total_opex', type: 'subtotal', label: 'Total Betriebskosten',
    indent: 0, showPercent: false, valueRole: 'negative',
    computedFrom: { type: 'sum', rowIds: ['rent','utilities','cleaning','maintenance','insurance','marketing','admin','other_operating'] },
  },
  {
    id: 'ebitda', type: 'result', label: 'Betriebsergebnis vor Abschreibungen (EBITDA)',
    indent: 0, showPercent: true, valueRole: 'positive',
    computedFrom: { type: 'subtract', rowIds: ['gross_profit_2', 'total_opex'] },
  },

  // ── ABSCHREIBUNGEN ──────────────────────────────────────────────────────────
  { id: 'spacer_4', type: 'spacer', label: '', indent: 0, showPercent: false },
  { id: 'section_depreciation', type: 'section', label: 'ABSCHREIBUNGEN', indent: 0, showPercent: false },
  {
    id: 'depreciation', type: 'line', label: 'Abschreibungen',
    indent: 1, showPercent: false, valueRole: 'negative',
    categoryIds: ['abschreibungen', 'afa', 'amortisation'],
  },
  {
    id: 'total_depreciation', type: 'subtotal', label: 'Total Abschreibungen',
    indent: 0, showPercent: false, valueRole: 'negative',
    computedFrom: { type: 'sum', rowIds: ['depreciation'] },
  },
  {
    id: 'ebit', type: 'result', label: 'Betriebsergebnis (EBIT)',
    indent: 0, showPercent: true, valueRole: 'positive',
    computedFrom: { type: 'subtract', rowIds: ['ebitda', 'total_depreciation'] },
  },
];

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function pct(value: number | undefined, base: number | undefined): number | undefined {
  if (!base || !value) return undefined;
  return (value / base) * 100;
}

function variance(actual: number | undefined, reference: number | undefined): number | undefined {
  if (actual === undefined || reference === undefined) return undefined;
  return actual - reference;
}

function variancePct(actual: number | undefined, reference: number | undefined): number | undefined {
  if (actual === undefined || reference === undefined || reference === 0) return undefined;
  return ((actual - reference) / Math.abs(reference)) * 100;
}

// ─── Haupt-Berechnungslogik ───────────────────────────────────────────────────

/**
 * Optionale Overrides für computePLForMonth:
 * - budgetByRow:   PL-row-ID → Budget-Betrag (aus Budget-Planung)
 * - prevYearByRow: PL-row-ID → Vorjahrswert (aus Vorjahresdaten)
 */
export interface PLMonthOverrides {
  budgetByRow?:   Map<string, number>;
  prevYearByRow?: Map<string, number>;
}

/**
 * Berechnet alle P&L-Werte für einen einzelnen Monat.
 */
export function computePLForMonth(
  record: MonthlyFinancialRecord,
  overrides?: PLMonthOverrides,
): PLMonthResult {
  const hasData = !!(
    record.revenueActual !== undefined ||
    record.personnelCostActual !== undefined ||
    record.expenseCategories.length > 0
  );

  // Schritt 1: Werte pro Zeile in einer Map sammeln (rowId → PLCellValues)
  const rowValues = new Map<string, { actual?: number; budget?: number; prevYear?: number }>();
  const rowSources = new Map<string, PLSourceCategory[]>();

  // Initialisieren
  for (const row of PL_STRUCTURE) {
    rowValues.set(row.id, {});
    rowSources.set(row.id, []);
  }

  // Schritt 2: Direktfelder zuordnen (Actual, Budget, PrevYear separat — verhindert doppeltes Zählen)

  // Vorberechnung: Ob individuelle 3xxx-Actual-Konten in expenseCategories vorhanden (Sage-Import)
  const _hasIndivRev = record.expenseCategories.some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 3000 && n <= 3999;
  });
  // Vorberechnung: Ob individuelle 3xxx-Vorjahr-Konten in expenseCategoriesPreviousYear vorhanden
  const _hasIndivPYRev = record.expenseCategoriesPreviousYear.some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 3000 && n <= 3999;
  });

  // Ist-Umsatz (Actual): nur wenn KEINE Sage 3xxx-Actual-Konten (würde sonst doppelt zählen)
  if (record.revenueActual !== undefined && !_hasIndivRev) {
    const existing = rowValues.get('revenue_total') ?? {};
    rowValues.set('revenue_total', { ...existing, actual: record.revenueActual, budget: record.revenueBudget });
    rowSources.get('revenue_total')!.push({
      categoryId: '_revenue',
      label: 'Umsatz (Gastronovi / manuell)',
      actualAmount: record.revenueActual,
      sourceType: 'direct_field',
      monthId: record.id,
    });
  } else if (record.revenueBudget !== undefined) {
    // Budget auch ohne Actual setzen
    const existing = rowValues.get('revenue_total') ?? {};
    rowValues.set('revenue_total', { ...existing, budget: record.revenueBudget });
  }

  // Vorjahr-Umsatz (PrevYear): nur wenn KEINE Sage 3xxx-PY-Konten
  if (record.revenuePreviousYear !== undefined && !_hasIndivPYRev) {
    const existing = rowValues.get('revenue_total') ?? {};
    rowValues.set('revenue_total', { ...existing, prevYear: record.revenuePreviousYear });
    // Source-Eintrag nur wenn noch nicht vorhanden
    const sources = rowSources.get('revenue_total')!;
    if (!sources.some(s => s.categoryId === '_revenue_py')) {
      sources.push({
        categoryId: '_revenue_py',
        label: 'Umsatz Vorjahr (Gastronovi / manuell)',
        actualAmount: 0,
        prevYearAmount: record.revenuePreviousYear,
        sourceType: 'direct_field',
        monthId: record.id,
      });
    }
  }

  // Personal (Löhne)
  if (record.personnelCostActual !== undefined) {
    rowValues.set('personnel_wages', {
      actual:   record.personnelCostActual,
      budget:   record.personnelCostPlanned,
      prevYear: record.personnelCostPreviousYear,
    });
    rowSources.get('personnel_wages')!.push({
      categoryId: '_personnel',
      label: 'Löhne (manuell erfasst)',
      actualAmount: record.personnelCostActual,
      prevYearAmount: record.personnelCostPreviousYear,
      sourceType: 'direct_field',
      monthId: record.id,
    });
  }

  // Schritt 3: Expense Categories zuordnen
  // Kategorien nach Typ trennen:
  //   - human-readable IDs (z.B. 'miete') → KNOWN_CATEGORY_IDS-Matching
  //   - numerische IDs  (z.B. '3000')     → Kontenplan-Lookup via resolveRowId
  //   - Rest                               → other_operating (catch-all)

  const humanActual     = record.expenseCategories.filter(c =>
    !(/^\d{3,5}$/.test(c.categoryId))
  );
  const numericActual   = record.expenseCategories.filter(c =>
    /^\d{3,5}$/.test(c.categoryId)
  );

  // Ob individuelle 3xxx-Konten in expenseCategories vorhanden (aus CSV-Import)
  const hasIndividualRevenueAccounts = numericActual.some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 3000 && n <= 3999;
  });

  const humanPY         = record.expenseCategoriesPreviousYear.filter(c =>
    !(/^\d{3,5}$/.test(c.categoryId))
  );
  const numericPY       = record.expenseCategoriesPreviousYear.filter(c =>
    /^\d{3,5}$/.test(c.categoryId)
  );

  // Unbekannte human-readable IDs → other_operating
  const unmappedCategories = humanActual.filter(c => !KNOWN_CATEGORY_IDS.has(c.categoryId));

  // Hilfsfunktion: fügt Kategorie zu einer Zeile hinzu
  function addCategoryToRow(
    rowId: string,
    cat: { categoryId: string; label: string; amount?: number },
    pyCat?: { categoryId: string; label: string; amount?: number } | null,
    source: 'manual_entry' | 'csv_import' = 'manual_entry',
  ) {
    const existing = rowValues.get(rowId) ?? {};
    rowValues.set(rowId, {
      ...existing,
      actual:   (existing.actual ?? 0) + (cat.amount ?? 0),
      prevYear: pyCat
        ? (existing.prevYear ?? 0) + (pyCat.amount ?? 0)
        : existing.prevYear,
    });
    const sources = rowSources.get(rowId) ?? [];
    sources.push({
      categoryId: cat.categoryId,
      label: cat.label,
      actualAmount: cat.amount ?? 0,
      prevYearAmount: pyCat?.amount,
      sourceType: source,
      monthId: record.id,
    });
    rowSources.set(rowId, sources);
  }

  // A) Human-readable IDs: wie bisher über PL_STRUCTURE-rowDef.categoryIds
  for (const rowDef of PL_STRUCTURE) {
    if (!rowDef.categoryIds || rowDef.categoryIds.length === 0) continue;

    const matchingActual = humanActual.filter(c => rowDef.categoryIds!.includes(c.categoryId));
    const matchingPY     = humanPY.filter(c => rowDef.categoryIds!.includes(c.categoryId));

    let allActual = matchingActual;
    let allPY     = matchingPY;
    if (rowDef.id === 'other_operating') {
      allActual = [...matchingActual, ...unmappedCategories];
      const unmappedPY = humanPY.filter(c => !KNOWN_CATEGORY_IDS.has(c.categoryId));
      allPY = [...matchingPY, ...unmappedPY];
    }

    const actualSum   = allActual.reduce((s, c) => s + (c.amount ?? 0), 0) || undefined;
    const prevYearSum = allPY.reduce((s, c) => s + (c.amount ?? 0), 0) || undefined;

    if (actualSum !== undefined || prevYearSum !== undefined) {
      const existing = rowValues.get(rowDef.id) ?? {};
      rowValues.set(rowDef.id, {
        ...existing,
        actual:   actualSum   !== undefined ? (existing.actual   ?? 0) + actualSum   : existing.actual,
        prevYear: prevYearSum !== undefined ? (existing.prevYear ?? 0) + prevYearSum : existing.prevYear,
      });
      const sources = rowSources.get(rowDef.id) ?? [];
      for (const cat of allActual) {
        const pyMatch = allPY.find(p => p.categoryId === cat.categoryId);
        sources.push({
          categoryId: cat.categoryId,
          label: cat.label,
          actualAmount: cat.amount ?? 0,
          prevYearAmount: pyMatch?.amount,
          sourceType: 'manual_entry',
          monthId: record.id,
        });
      }
      rowSources.set(rowDef.id, sources);
    }
  }

  // B) Numerische Kontonummern (CSV-Import): via resolveRowId zuordnen
  for (const cat of numericActual) {
    const rowId = resolveRowId(cat.categoryId) ?? 'other_operating';
    // Umsatzkonten (revenue_total): nur überspringen wenn revenueActual NICHT über individuelle Konten gesetzt
    // → hasIndividualRevenueAccounts=true: individuelle Konten verarbeiten (kein Skip)
    // → hasIndividualRevenueAccounts=false: revenueActual ist direkt gesetzt, also Skip
    if (rowId === 'revenue_total' && !hasIndividualRevenueAccounts && record.revenueActual !== undefined) continue;
    // Personalkonten (personnel_wages) überspringen – bereits via personnelCostActual gesetzt.
    // Ausnahme: Konten die NICHT im Dienstplan erfasst werden (z.B. 5004/5005 Personal-Karate)
    // sollen immer additiv dazugezählt werden → kein Skip für diese Konten.
    if (rowId === 'personnel_wages' && record.personnelCostActual !== undefined) {
      const acctKey = (cat.categoryId?.trim() ?? '').slice(0, 4);
      const ADDITIVE_WAGE_ACCOUNTS = new Set(['5004', '5005']);
      if (!ADDITIVE_WAGE_ACCOUNTS.has(acctKey)) continue;
    }

    const pyMatch = numericPY.find(p => p.categoryId === cat.categoryId);
    addCategoryToRow(rowId, cat, pyMatch ?? null, 'csv_import');
  }

  // PY-only numerische Konten (kein Actual-Gegenstück)
  for (const cat of numericPY) {
    const hasActualCounterpart = numericActual.some(a => a.categoryId === cat.categoryId);
    if (hasActualCounterpart) continue;
    const rowId = resolveRowId(cat.categoryId) ?? 'other_operating';
    // Vorjahr-Umsatz: nur überspringen wenn revenuePreviousYear direkt gesetzt UND KEINE individuellen PY-3xxx-Konten
    if (rowId === 'revenue_total' && !_hasIndivPYRev && record.revenuePreviousYear !== undefined) continue;
    if (rowId === 'personnel_wages' && record.personnelCostPreviousYear !== undefined) continue;
    const existing = rowValues.get(rowId) ?? {};
    rowValues.set(rowId, {
      ...existing,
      prevYear: (existing.prevYear ?? 0) + (cat.amount ?? 0),
    });
    const sources = rowSources.get(rowId) ?? [];
    sources.push({
      categoryId: cat.categoryId,
      label: cat.label,
      actualAmount: 0,
      prevYearAmount: cat.amount ?? 0,
      sourceType: 'csv_import',
      monthId: record.id,
    });
    rowSources.set(rowId, sources);
  }

  // Schritt 3b: Budget- und Vorjahr-Overrides aus Budget-Planung / Vorjahresdaten injizieren
  // Diese Overrides ersetzen allfällige Direktfeld-Werte (revenueBudget, personnelCostPlanned etc.)
  // und ergänzen fehlende Werte für alle anderen Zeilen.
  if (overrides?.budgetByRow) {
    for (const [rowId, val] of overrides.budgetByRow) {
      if (val === 0) continue;
      const existing = rowValues.get(rowId);
      if (existing === undefined) continue; // nur bekannte PL-Zeilen überschreiben
      rowValues.set(rowId, { ...existing, budget: val });
    }
  }
  if (overrides?.prevYearByRow) {
    for (const [rowId, val] of overrides.prevYearByRow) {
      if (val === 0) continue;
      const existing = rowValues.get(rowId);
      if (existing === undefined) continue;
      // Nur setzen wenn noch kein Vorjahreswert aus expenseCategories/directField vorhanden
      if (existing.prevYear === undefined) {
        rowValues.set(rowId, { ...existing, prevYear: val });
      }
    }
  }

  // Schritt 4: Berechnete Zeilen (subtotal / result) mit Topologischer Reihenfolge auflösen
  // (PL_STRUCTURE ist bereits in richtiger Reihenfolge – wir iterieren einfach durch)
  const resolvedActual = new Map<string, number | undefined>();
  const resolvedBudget = new Map<string, number | undefined>();
  const resolvedPY     = new Map<string, number | undefined>();

  for (const row of PL_STRUCTURE) {
    const raw = rowValues.get(row.id) ?? {};

    if (row.type === 'line') {
      resolvedActual.set(row.id, raw.actual);
      resolvedBudget.set(row.id, raw.budget);
      resolvedPY.set(row.id, raw.prevYear);
      continue;
    }

    if (row.type === 'spacer' || row.type === 'section') {
      resolvedActual.set(row.id, undefined);
      resolvedBudget.set(row.id, undefined);
      resolvedPY.set(row.id, undefined);
      continue;
    }

    const formula = row.computedFrom;
    if (!formula) continue;

    if (formula.type === 'sum') {
      const sumActual  = formula.rowIds.map(id => resolvedActual.get(id) ?? 0).reduce((a, b) => a + b, 0);
      const sumBudget  = formula.rowIds.map(id => resolvedBudget.get(id) ?? 0).reduce((a, b) => a + b, 0);
      const sumPY      = formula.rowIds.map(id => resolvedPY.get(id)     ?? 0).reduce((a, b) => a + b, 0);
      const hasActual  = formula.rowIds.some(id => resolvedActual.get(id) !== undefined);
      const hasBudget  = formula.rowIds.some(id => resolvedBudget.get(id) !== undefined);
      const hasPY      = formula.rowIds.some(id => resolvedPY.get(id)     !== undefined);
      resolvedActual.set(row.id, hasActual  ? sumActual  : undefined);
      resolvedBudget.set(row.id, hasBudget  ? sumBudget  : undefined);
      resolvedPY.set(row.id,     hasPY      ? sumPY      : undefined);
    }

    if (formula.type === 'subtract') {
      const [baseId, ...subIds] = formula.rowIds;
      const baseA = resolvedActual.get(baseId);
      const baseB = resolvedBudget.get(baseId);
      const basePY = resolvedPY.get(baseId);
      const subA  = subIds.map(id => resolvedActual.get(id) ?? 0).reduce((a, b) => a + b, 0);
      const subB  = subIds.map(id => resolvedBudget.get(id) ?? 0).reduce((a, b) => a + b, 0);
      const subPY = subIds.map(id => resolvedPY.get(id)     ?? 0).reduce((a, b) => a + b, 0);
      resolvedActual.set(row.id, baseA !== undefined ? baseA - subA : undefined);
      resolvedBudget.set(row.id, baseB !== undefined ? baseB - subB : undefined);
      resolvedPY.set(row.id,     basePY !== undefined ? basePY - subPY : undefined);
    }
  }

  // Schritt 5: PLCellValues zusammenbauen
  const revenueActual = resolvedActual.get('net_revenue');

  const rows: PLComputedRow[] = PL_STRUCTURE.map(def => {
    const actual   = resolvedActual.get(def.id);
    const budget   = resolvedBudget.get(def.id);
    const prevYear = resolvedPY.get(def.id);

    const values: PLCellValues = {
      actual,
      budget,
      prevYear,
      vsBudget:        variance(actual, budget),
      vsBudgetPct:     variancePct(actual, budget),
      vsPrevYear:      variance(actual, prevYear),
      vsPrevYearPct:   variancePct(actual, prevYear),
    };

    return {
      def,
      values,
      sourceCategories: rowSources.get(def.id) ?? [],
    };
  });

  return { year: record.year, month: record.month, monthId: record.id, rows, hasData };
}

/**
 * Berechnet das P&L für alle 12 Monate eines Jahres + Jahressumme.
 */
export function computePLForYear(
  records: MonthlyFinancialRecord[],
  overridesPerMonth?: PLMonthOverrides[],
): PLYearResult {
  const months = records.map((r, i) => computePLForMonth(r, overridesPerMonth?.[i]));
  const year = records[0]?.year ?? new Date().getFullYear();

  // Jahressumme: addiere alle Monatswerte Zeile für Zeile
  const totalRows: PLComputedRow[] = PL_STRUCTURE.map((def, idx) => {
    if (def.type === 'section' || def.type === 'spacer') {
      return { def, values: {}, sourceCategories: [] };
    }

    // Für Zeilentyp 'line': direkt summieren
    // Für 'subtotal' / 'result': aus den summierten Linien neu berechnen
    // Einfachste korrekte Lösung: Werte aus den Monats-PLs summieren
    const actualSum   = months.map(m => m.rows[idx].values.actual   ?? 0).reduce((a, b) => a + b, 0);
    const budgetSum   = months.map(m => m.rows[idx].values.budget    ?? 0).reduce((a, b) => a + b, 0);
    const prevYearSum = months.map(m => m.rows[idx].values.prevYear  ?? 0).reduce((a, b) => a + b, 0);
    const hasActual   = months.some(m => m.rows[idx].values.actual   !== undefined);
    const hasBudget   = months.some(m => m.rows[idx].values.budget   !== undefined);
    const hasPY       = months.some(m => m.rows[idx].values.prevYear !== undefined);

    const actual   = hasActual ? actualSum   : undefined;
    const budget   = hasBudget ? budgetSum   : undefined;
    const prevYear = hasPY     ? prevYearSum : undefined;

    const allSources = months.flatMap(m => m.rows[idx].sourceCategories);

    return {
      def,
      values: {
        actual,
        budget,
        prevYear,
        vsBudget:      variance(actual, budget),
        vsBudgetPct:   variancePct(actual, budget),
        vsPrevYear:    variance(actual, prevYear),
        vsPrevYearPct: variancePct(actual, prevYear),
      },
      sourceCategories: allSources,
    };
  });

  const total: PLMonthResult = {
    year,
    month: 0,  // 0 = Jahressumme
    monthId: `${year}-total`,
    rows: totalRows,
    hasData: months.some(m => m.hasData),
  };

  return { year, months, total };
}

/**
 * Erstellt die Drilldown-Daten für eine angeklickte P&L-Zeile.
 */
export function getDrilldown(
  rowId: string,
  result: PLMonthResult,
): PLDrilldown | null {
  const row = result.rows.find(r => r.def.id === rowId);
  if (!row) return null;
  return {
    rowId,
    rowLabel: row.def.label,
    month: result.month,
    year: result.year,
    values: row.values,
    sources: row.sourceCategories,
  };
}

/**
 * Hilfsfunktion: Gibt nur die sichtbaren Zeilen zurück (ohne spacer).
 */
export function visibleRows(rows: PLComputedRow[]): PLComputedRow[] {
  return rows.filter(r => r.def.type !== 'spacer');
}
