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
