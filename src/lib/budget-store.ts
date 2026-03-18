/**
 * Budget Store – Datenzugriff und Berechnungslogik
 * ==================================================
 *
 * localStorage-Schlüssel: 'budget_v1'
 * Format: Record<year, BudgetYear>
 *
 * Wichtigste Funktionen:
 *   loadBudgetYear(year)            → Budgetjahr laden oder neu erstellen
 *   saveBudgetYear(data)            → Budgetjahr speichern
 *   copyBudgetYear(from, to)        → Jahr kopieren (optionale Regeln anwenden)
 *   applyRulesToBudget(data)        → Regeln auf alle Positionen anwenden
 *   resolveBudgetYear(data)         → % → CHF auflösen für Anzeige
 *   availableBudgetYears()          → alle gespeicherten Jahre
 */

import { v4 as uuidv4 } from 'uuid';
import {
  BudgetYear,
  BudgetPosition,
  BudgetRule,
  BudgetRuleType,
  BudgetPositionResolved,
  BudgetYearResolved,
  DEFAULT_BUDGET_POSITIONS,
  createDefaultPosition,
  BudgetPLCategory,
  BudgetPLLineItem,
  DEFAULT_PL_CATEGORIES,
  DEFAULT_PL_LINE_ITEMS,
  createDefaultPLLineItem,
} from '@/types/budget';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'budget_v1';

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

function loadAll(): Record<number, BudgetYear> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveAll(data: Record<number, BudgetYear>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Erstellt ein leeres Budgetjahr mit den Standard-Positionen */
function createEmptyBudgetYear(year: number): BudgetYear {
  const now = new Date().toISOString();
  return {
    year,
    positions: DEFAULT_BUDGET_POSITIONS.map(def => createDefaultPosition(def)),
    rules: [],
    wasAutoCalculated: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Budgetjahr laden.
 * Gibt ein leeres Budgetjahr zurück, falls noch keins für dieses Jahr existiert.
 */
export function loadBudgetYear(year: number): BudgetYear {
  const all = loadAll();
  return all[year] ?? createEmptyBudgetYear(year);
}

/**
 * Budgetjahr speichern.
 * Überschreibt das bestehende Jahr komplett.
 */
export function saveBudgetYear(data: BudgetYear): void {
  const all = loadAll();
  all[data.year] = {
    ...data,
    updatedAt: new Date().toISOString(),
  };
  saveAll(all);
}

/**
 * Alle Jahre mit gespeicherten Budgets.
 * Sortiert absteigend (neuestes Jahr zuerst).
 */
export function availableBudgetYears(): number[] {
  const all = loadAll();
  return Object.keys(all)
    .map(Number)
    .sort((a, b) => b - a);
}

/**
 * Budgetjahr löschen.
 */
export function deleteBudgetYear(year: number): void {
  const all = loadAll();
  delete all[year];
  saveAll(all);
}

// ─── Jahr-Kopie ───────────────────────────────────────────────────────────────

/**
 * Kopiert ein Budgetjahr in ein neues Jahr.
 *
 * Ablauf:
 *   1. Lädt das Quell-Budget (fromYear)
 *   2. Erstellt ein neues BudgetYear-Objekt für toYear
 *   3. Übernimmt alle Positionen (Werte + Typen)
 *   4. Optionale Regeln werden danach angewendet (wenn applyRules=true)
 *   5. Speichert das neue Budgetjahr
 *
 * Wichtig:
 *   Das Quell-Budget bleibt UNVERÄNDERT.
 *   Nur das Ziel-Budget wird neu erstellt / überschrieben.
 *
 * @param fromYear  Quell-Jahr (z.B. 2026)
 * @param toYear    Ziel-Jahr  (z.B. 2027)
 * @param applyRules  Sollen die kopierten Regeln auf das neue Jahr angewendet werden?
 */
export function copyBudgetYear(
  fromYear: number,
  toYear: number,
  applyRules: boolean = true,
): BudgetYear {
  const source = loadBudgetYear(fromYear);
  const now    = new Date().toISOString();

  // Positionen tief kopieren (damit Änderungen das Quell-Budget nicht betreffen)
  const copiedPositions: BudgetPosition[] = source.positions.map(p => ({
    ...p,
    monthlyValues: [...p.monthlyValues] as BudgetPosition['monthlyValues'],
  }));

  // Regeln übernehmen (neue IDs, damit sie unabhängig sind)
  const copiedRules: BudgetRule[] = source.rules.map(r => ({
    ...r,
    id: uuidv4(),
    createdAt: now,
  }));

  let newBudget: BudgetYear = {
    year:            toYear,
    positions:       copiedPositions,
    rules:           copiedRules,
    copiedFromYear:  fromYear,
    wasAutoCalculated: false,
    createdAt:       now,
    updatedAt:       now,
  };

  if (applyRules && copiedRules.length > 0) {
    newBudget = applyRulesToBudget(newBudget);
  }

  saveBudgetYear(newBudget);
  return newBudget;
}

// ─── Regel-Engine ─────────────────────────────────────────────────────────────

/**
 * Wendet alle Regeln eines Budgetjahres auf die Positionen an.
 *
 * Reihenfolge:
 *   1. increase_revenue_by_pct   – Umsatz anpassen
 *   2. set_cost_ratio            – Kosten-Quote setzen
 *   3. reduce_cost_by_pct        – Kosten-CHF reduzieren
 *   4. monthly_factor            – Monatlichen Faktor anwenden
 *   5. monthly_fixed_override    – Monatlichen CHF-Override anwenden (immer zuletzt)
 *
 * Gibt ein neues BudgetYear-Objekt zurück (original bleibt unverändert).
 */
export function applyRulesToBudget(budget: BudgetYear): BudgetYear {
  const positions = budget.positions.map(p => ({
    ...p,
    monthlyValues: [...p.monthlyValues] as BudgetPosition['monthlyValues'],
  }));

  const findPos = (id: string) => positions.find(p => p.id === id);

  // Reihenfolge: allgemeine Regeln zuerst, Overrides zuletzt
  const ruleOrder: BudgetRuleType[] = [
    'increase_revenue_by_pct',
    'set_cost_ratio',
    'reduce_cost_by_pct',
    'monthly_factor',
    'monthly_fixed_override',
  ];

  const sortedRules = [...budget.rules].sort(
    (a, b) => ruleOrder.indexOf(a.type) - ruleOrder.indexOf(b.type),
  );

  for (const rule of sortedRules) {
    const pos = findPos(rule.positionId);
    if (!pos) continue;

    switch (rule.type) {

      case 'increase_revenue_by_pct': {
        // Umsatz um X % erhöhen (nur CHF-Positionen)
        const factor = 1 + rule.value / 100;
        const months = rule.month ? [rule.month - 1] : Array.from({ length: 12 }, (_, i) => i);
        for (const m of months) {
          pos.monthlyValues[m] = Math.round(pos.monthlyValues[m] * factor);
        }
        break;
      }

      case 'set_cost_ratio': {
        // Kosten auf X % setzen → valueType zu 'percent' wechseln
        // Setzt ALLE 12 Monatswerte auf den Zielwert
        const months = rule.month ? [rule.month - 1] : Array.from({ length: 12 }, (_, i) => i);
        pos.valueType = 'percent';
        for (const m of months) {
          pos.monthlyValues[m] = rule.value;
        }
        break;
      }

      case 'reduce_cost_by_pct': {
        // CHF-Kosten um X % reduzieren
        const factor = 1 - rule.value / 100;
        const months = rule.month ? [rule.month - 1] : Array.from({ length: 12 }, (_, i) => i);
        for (const m of months) {
          pos.monthlyValues[m] = Math.round(pos.monthlyValues[m] * factor);
        }
        break;
      }

      case 'monthly_factor': {
        // Einzelmonat mit Faktor multiplizieren
        if (rule.month === undefined) break;
        const m = rule.month - 1;
        pos.monthlyValues[m] = Math.round(pos.monthlyValues[m] * rule.value);
        break;
      }

      case 'monthly_fixed_override': {
        // Einzelmonat auf fixen CHF-Wert setzen
        if (rule.month === undefined) break;
        const m = rule.month - 1;
        pos.valueType = 'chf';
        pos.monthlyValues[m] = rule.value;
        break;
      }
    }
  }

  return {
    ...budget,
    positions,
    wasAutoCalculated: budget.rules.length > 0,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Auflösung % → CHF ───────────────────────────────────────────────────────

/**
 * Löst alle %-Positionen in CHF-Werte auf.
 * Benötigt den budgetierten Monatsumsatz als Basis.
 *
 * Ablauf:
 *   1. Umsatz-Position (budget_revenue) als Basis
 *   2. Alle 'percent'-Positionen: Wert = % × Monatsumsatz / 100
 *   3. Alle 'chf'-Positionen: Wert direkt übernehmen
 *   4. Jahressummen berechnen
 */
export function resolveBudgetYear(budget: BudgetYear): BudgetYearResolved {
  const revenuePos = budget.positions.find(p => p.id === 'budget_revenue');
  const monthlyRevenue = revenuePos
    ? [...revenuePos.monthlyValues]
    : Array(12).fill(0);

  const resolvedPositions: BudgetPositionResolved[] = budget.positions.map(pos => {
    const resolvedCHF = pos.monthlyValues.map((val, m) => {
      if (pos.valueType === 'percent') {
        return Math.round((val / 100) * monthlyRevenue[m]);
      }
      return val;
    }) as BudgetPositionResolved['resolvedCHF'];

    const totalCHF = resolvedCHF.reduce((s, v) => s + v, 0);
    return { position: pos, resolvedCHF, totalCHF };
  });

  const totalRevenueBudget = resolvedPositions
    .filter(r => r.position.category === 'revenue')
    .reduce((s, r) => s + r.totalCHF, 0);

  const totalCostBudget = resolvedPositions
    .filter(r => r.position.isExpense)
    .reduce((s, r) => s + r.totalCHF, 0);

  return {
    year:                 budget.year,
    positions:            resolvedPositions,
    totalRevenueBudget,
    totalCostBudget,
    operatingResultBudget: totalRevenueBudget - totalCostBudget,
    monthlyRevenue,
  };
}

// ─── Positions-Verwaltung ─────────────────────────────────────────────────────

/**
 * Aktualisiert eine einzelne Position im Budgetjahr und speichert.
 */
export function updateBudgetPosition(
  year: number,
  updatedPosition: BudgetPosition,
): BudgetYear {
  const budget = loadBudgetYear(year);
  const positions = budget.positions.map(p =>
    p.id === updatedPosition.id ? updatedPosition : p,
  );
  const updated = { ...budget, positions, updatedAt: new Date().toISOString() };
  saveBudgetYear(updated);
  return updated;
}

// ─── Regeln-Verwaltung ────────────────────────────────────────────────────────

/**
 * Fügt eine neue Regel zum Budgetjahr hinzu und speichert.
 */
export function addBudgetRule(year: number, rule: Omit<BudgetRule, 'id' | 'createdAt'>): BudgetYear {
  const budget = loadBudgetYear(year);
  const newRule: BudgetRule = {
    ...rule,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  const updated = {
    ...budget,
    rules:     [...budget.rules, newRule],
    updatedAt: new Date().toISOString(),
  };
  saveBudgetYear(updated);
  return updated;
}

/**
 * Entfernt eine Regel aus dem Budgetjahr und speichert.
 */
export function removeBudgetRule(year: number, ruleId: string): BudgetYear {
  const budget = loadBudgetYear(year);
  const updated = {
    ...budget,
    rules:     budget.rules.filter(r => r.id !== ruleId),
    updatedAt: new Date().toISOString(),
  };
  saveBudgetYear(updated);
  return updated;
}

// ─── P&L Struktur (neue Budget-Erfolgsrechnung) ───────────────────────────────

/**
 * Initialisiert die P&L-Struktur in einem BudgetYear, falls noch nicht vorhanden.
 * Erstellt Standardkategorien und Standardpositionen.
 * Das bestehende Budget wird NICHT verändert.
 */
function initPLStructure(budget: BudgetYear): BudgetYear {
  if (budget.plCategories && budget.plLineItems) return budget;

  const categories: BudgetPLCategory[]  = [...DEFAULT_PL_CATEGORIES];
  const lineItems: BudgetPLLineItem[]    = DEFAULT_PL_LINE_ITEMS.map(createDefaultPLLineItem);

  return { ...budget, plCategories: categories, plLineItems: lineItems };
}

/**
 * Migriert alte Umsatz-Unterkonten (pli_wein, pli_bier, …) zu einem einzigen
 * pli_umsatz Konto 3000. Bestehendes Datenmaterial wird summiert.
 */
function migrateToSingleRevenueItem(budget: BudgetYear): BudgetYear {
  const OLD_IDS = ['pli_wein', 'pli_bier', 'pli_spirituosen', 'pli_kueche_ertrag', 'pli_kaffee'];
  const items = budget.plLineItems ?? [];

  const hasOldItems = items.some(i => OLD_IDS.includes(i.id));
  const hasNewItem  = items.some(i => i.id === 'pli_umsatz');

  if (!hasOldItems) return budget; // Bereits migriert

  // Monatswerte der alten Konten summieren
  const combined = Array(12).fill(0) as number[];
  items
    .filter(i => OLD_IDS.includes(i.id))
    .forEach(i => i.monthlyValues.forEach((v, m) => { combined[m] += v; }));

  // Bestehendes pli_umsatz aktualisieren oder neu anlegen
  const umsatzItem: BudgetPLLineItem = hasNewItem
    ? { ...items.find(i => i.id === 'pli_umsatz')!, monthlyValues: combined as BudgetPLLineItem['monthlyValues'] }
    : { id: 'pli_umsatz', categoryId: 'pl_revenue', accountNumber: '3000', label: 'Umsatz', valueType: 'chf', sortOrder: 1, isDefault: true, monthlyValues: combined as BudgetPLLineItem['monthlyValues'] };

  const newItems = [
    umsatzItem,
    ...items.filter(i => !OLD_IDS.includes(i.id) && i.id !== 'pli_umsatz'),
  ];

  return { ...budget, plLineItems: newItems };
}

const OBSOLETE_PL_IDS = [
  'pli_waren_wein', 'pli_waren_bier', 'pli_waren_spirit', 'pli_waren_mineral', 'pli_waren_kueche',
  'pli_lohn_flex', 'pli_lohn_13', 'pli_lohn_zulagen',
  'pli_ahv', 'pli_bvg', 'pli_uvg',
  'pli_weiterbildung', 'pli_personalverpf',
  'pli_nebenkosten', 'pli_verwaltung', 'pli_uebrig_aufwand',
];

function migrateObsoletePLItems(budget: BudgetYear): BudgetYear {
  const items = budget.plLineItems ?? [];
  const hasObsolete = items.some(i => OBSOLETE_PL_IDS.includes(i.id));
  if (!hasObsolete) return budget;

  const kept = items.filter(i => !OBSOLETE_PL_IDS.includes(i.id));
  const existingIds = new Set(kept.map(i => i.id));
  const toAdd = DEFAULT_PL_LINE_ITEMS
    .filter(d => !existingIds.has(d.id) && d.id !== 'pli_umsatz')
    .map(createDefaultPLLineItem);

  return { ...budget, plLineItems: [...kept, ...toAdd] };
}

/**
 * Budgetjahr laden und P&L-Struktur sicherstellen.
 */
export function loadBudgetWithPL(year: number): BudgetYear {
  let budget = loadBudgetYear(year);
  if (!budget.plCategories || !budget.plLineItems) {
    budget = initPLStructure(budget);
  }
  budget = migrateToSingleRevenueItem(budget);
  budget = migrateObsoletePLItems(budget);
  saveBudgetYear(budget);
  return budget;
}

/**
 * Löscht eine P&L-Zeile (auch Standard-Positionen).
 */
export function deletePLLineItem(year: number, itemId: string): BudgetYear {
  const budget = loadBudgetWithPL(year);
  const updated = syncPLToLegacyPositions({
    ...budget,
    plLineItems: budget.plLineItems!.filter(i => i.id !== itemId),
  });
  saveBudgetYear(updated);
  return updated;
}

/**
 * Berechnet monatliche Gesamtsummen pro Kategorie (CHF).
 *
 * Für %-Positionen: Wert = % × revenue_total[m] / 100
 * Für CHF-Positionen: Wert direkt
 *
 * Gibt ein Record<categoryId, number[12]> zurück.
 */
export function computePLCategoryTotals(
  lineItems: BudgetPLLineItem[],
): Record<string, number[]> {
  // Zuerst Revenue berechnen (wird als Basis für %-Positionen benötigt)
  const revenueTotals = Array(12).fill(0) as number[];
  lineItems
    .filter(item => item.categoryId === 'pl_revenue')
    .forEach(item => {
      item.monthlyValues.forEach((v, m) => { revenueTotals[m] += v; });
    });

  const totals: Record<string, number[]> = {};

  // Für jede Kategorie die Positionen summieren
  const categoryIds = [...new Set(lineItems.map(i => i.categoryId))];
  for (const catId of categoryIds) {
    const monthly = Array(12).fill(0) as number[];
    lineItems
      .filter(item => item.categoryId === catId)
      .forEach(item => {
        item.monthlyValues.forEach((v, m) => {
          if (item.valueType === 'percent') {
            monthly[m] += Math.round((v / 100) * revenueTotals[m]);
          } else {
            monthly[m] += v;
          }
        });
      });
    totals[catId] = monthly;
  }

  return totals;
}

/**
 * Berechnet Zwischenergebnis-Zeilen (type='result') anhand der Formel.
 */
export function computePLResultTotals(
  categories:    BudgetPLCategory[],
  categoryTotals: Record<string, number[]>,
): Record<string, number[]> {
  const results: Record<string, number[]> = {};

  const resultCats = categories
    .filter(c => c.type === 'result')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const cat of resultCats) {
    const monthly = Array(12).fill(0) as number[];
    for (const term of (cat.resultFormula ?? [])) {
      const source = categoryTotals[term.categoryId] ?? results[term.categoryId] ?? Array(12).fill(0);
      source.forEach((v, m) => { monthly[m] += term.sign * v; });
    }
    results[cat.id] = monthly;
  }

  return results;
}

/**
 * Speichert eine einzelne P&L-Zeile (update oder insert).
 */
export function savePLLineItem(year: number, item: BudgetPLLineItem): BudgetYear {
  const budget = loadBudgetWithPL(year);
  const exists = budget.plLineItems!.some(i => i.id === item.id);
  const lineItems = exists
    ? budget.plLineItems!.map(i => i.id === item.id ? item : i)
    : [...budget.plLineItems!, item];

  const updated = syncPLToLegacyPositions({ ...budget, plLineItems: lineItems });
  saveBudgetYear(updated);
  return updated;
}

/**
 * Fügt eine neue benutzerdefinierte P&L-Zeile hinzu.
 */
export function addCustomPLLineItem(
  year: number,
  item: Omit<BudgetPLLineItem, 'id' | 'isDefault'>,
): BudgetYear {
  const budget = loadBudgetWithPL(year);
  const newItem: BudgetPLLineItem = {
    ...item,
    monthlyValues: [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'],
    id: uuidv4(),
    isDefault: false,
  };
  const updated = syncPLToLegacyPositions({
    ...budget,
    plLineItems: [...budget.plLineItems!, newItem],
  });
  saveBudgetYear(updated);
  return updated;
}

/**
 * Entfernt eine benutzerdefinierte P&L-Zeile (nur nicht-Standard-Zeilen).
 */
export function removeCustomPLLineItem(year: number, itemId: string): BudgetYear {
  const budget = loadBudgetWithPL(year);
  const item   = budget.plLineItems!.find(i => i.id === itemId);
  if (item?.isDefault) {
    throw new Error('Standard-Positionen können nicht gelöscht werden.');
  }
  const updated = syncPLToLegacyPositions({
    ...budget,
    plLineItems: budget.plLineItems!.filter(i => i.id !== itemId),
  });
  saveBudgetYear(updated);
  return updated;
}

/**
 * Synchronisiert P&L-Gesamtsummen in die Legacy-Positionen.
 * Diese werden vom Dashboard und der Soll/Ist-Analyse verwendet.
 *
 * Mapping:
 *   pl_revenue            → budget_revenue
 *   pl_goods_cost(küche)  → budget_food_cost
 *   pl_goods_cost(rest)   → budget_bev_cost
 *   pl_wages + pl_social + pl_personnel_other → budget_personnel
 *   pl_rent               → budget_rent
 *   pl_maintenance        → budget_maintenance
 *   pl_admin              → budget_insurance + budget_other
 */
export function syncPLToLegacyPositions(budget: BudgetYear): BudgetYear {
  if (!budget.plLineItems) return budget;

  const items     = budget.plLineItems;
  const positions = budget.positions.map(p => ({ ...p, monthlyValues: [...p.monthlyValues] as BudgetPosition['monthlyValues'] }));
  const setPos    = (id: string, vals: number[]) => {
    const pos = positions.find(p => p.id === id);
    if (pos) { pos.monthlyValues = vals as BudgetPosition['monthlyValues']; pos.valueType = 'chf'; }
  };

  // Revenue total per month
  const revTotal = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_revenue').forEach(i => {
    i.monthlyValues.forEach((v, m) => { revTotal[m] += v; });
  });
  setPos('budget_revenue', revTotal);

  // Food cost (Küche Warenaufwand = account 4400)
  const foodCost = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_goods_cost' && i.accountNumber === '4400').forEach(i => {
    i.monthlyValues.forEach((v, m) => {
      foodCost[m] += i.valueType === 'percent' ? Math.round((v / 100) * revTotal[m]) : v;
    });
  });
  setPos('budget_food_cost', foodCost);

  // Beverage cost (all other goods cost)
  const bevCost = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_goods_cost' && i.accountNumber !== '4400').forEach(i => {
    i.monthlyValues.forEach((v, m) => {
      bevCost[m] += i.valueType === 'percent' ? Math.round((v / 100) * revTotal[m]) : v;
    });
  });
  setPos('budget_bev_cost', bevCost);

  // Personnel (wages + social + other)
  const personnelTotal = Array(12).fill(0) as number[];
  items.filter(i => ['pl_wages', 'pl_social', 'pl_personnel_other'].includes(i.categoryId)).forEach(i => {
    i.monthlyValues.forEach((v, m) => { personnelTotal[m] += v; });
  });
  // If legacy personnel is % type, switch to CHF
  setPos('budget_personnel', personnelTotal);

  // Rent
  const rentTotal = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_rent').forEach(i => {
    i.monthlyValues.forEach((v, m) => { rentTotal[m] += v; });
  });
  setPos('budget_rent', rentTotal);

  // Maintenance
  const maintTotal = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_maintenance').forEach(i => {
    i.monthlyValues.forEach((v, m) => { maintTotal[m] += v; });
  });
  setPos('budget_maintenance', maintTotal);

  // Admin (insurance + other)
  const adminTotal = Array(12).fill(0) as number[];
  items.filter(i => i.categoryId === 'pl_admin').forEach(i => {
    i.monthlyValues.forEach((v, m) => { adminTotal[m] += v; });
  });
  setPos('budget_insurance', adminTotal);

  return { ...budget, positions, updatedAt: new Date().toISOString() };
}
