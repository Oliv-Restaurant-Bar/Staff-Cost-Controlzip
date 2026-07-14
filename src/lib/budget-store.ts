/**
 * Budget Store – Datenzugriff und Berechnungslogik
 * ==================================================
 *
 * localStorage-Schlüssel: 'budget_v1'
 * Format: Record<year, BudgetYear>
 *
 * Wichtigste Funktionen:
 *   loadBudgetYear(year, storeKey)            → Budgetjahr laden oder neu erstellen
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
import { createSeededBudget2026, SEED_2026_LINE_ITEMS } from '@/lib/budget-seed-2026';
import { createSeededBeaulieuBudget2026, SEED_BEAULIEU_2026_LINE_ITEMS } from '@/lib/budget-seed-beaulieu-2026';

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'budget_v1';

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

/**
 * Gespeicherter Blob-Eintrag: Budgetjahr ODER Jahr-Tombstone.
 * Tombstones (`deleted: true` + `updatedAt`) verhindern, dass ein stales Gerät
 * ein explizit gelöschtes Jahr über den Backup-Merge wiederbelebt (Befund 4).
 * Alle Leser filtern `deleted`; nur der Merge selbst sieht Tombstones.
 */
type StoredBudgetYear = BudgetYear & { deleted?: boolean };

/** Kontext jedes Speichervorgangs — Pflicht, damit der KV-Merge das Zieljahr kennt (Befund 1). */
type BudgetSaveAction = { year: number; deleted?: boolean };

/** Hat das Jahr echte (nicht-null) Budgetwerte in den P&L-Positionen? */
function hasRealBudgetValues(b: StoredBudgetYear | undefined | null): boolean {
  return !!b && !b.deleted && !!b.plLineItems?.some(i => i.monthlyValues.some(v => v !== 0));
}

/**
 * Deterministische Serialisierung (Schlüssel sortiert, `undefined`-Felder wie
 * bei JSON ausgelassen) — Grundlage des fachlichen Dirty-Checks.
 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Fachlicher Vergleich zweier Budgetjahre (Dirty-Check).
 *
 * `updatedAt` bedeutet ausschliesslich: «Dieser persistierte fachliche
 * Datensatz wurde tatsächlich geändert.» Deshalb zählen NICHT zum Vergleich:
 *  - createdAt/updatedAt (Zeitstempel sind Folge, nicht Teil der Änderung)
 *  - viewDefault (transientes UI-Flag, nie persistiert)
 *  - deleted (Tombstone-Status wird im Save-/Delete-Pfad separat behandelt)
 * Alles andere ist fachlich: Jahr, Monatswerte, Positionen, Regeln,
 * Prozentsätze, P&L-Kategorien/-Zuordnungen, copiedFromYear, wasAutoCalculated.
 */
function budgetBusinessEqual(a: StoredBudgetYear, b: StoredBudgetYear): boolean {
  const strip = (x: StoredBudgetYear): Record<string, unknown> => {
    const { createdAt: _c, updatedAt: _u, viewDefault: _v, deleted: _d, ...rest } =
      x as StoredBudgetYear & Record<string, unknown>;
    return rest;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

function loadAll(storeKey: string = STORAGE_KEY): Record<number, StoredBudgetYear> {
  try {
    return JSON.parse(localStorage.getItem(storeKey) || '{}');
  } catch {
    return {};
  }
}

/**
 * Serialisierte Backup-Queue: verhindert, dass zwei parallele KV-Backups
 * denselben Blob mit read→merge→write gegenseitig überschreiben (Race).
 */
let kvBackupQueue: Promise<void> = Promise.resolve();

/**
 * Sicheres KV-Backup für budget_v1 (read→merge→write statt Voll-Replace).
 *
 * PROBLEM (behoben): Der frühere naive `kvSet(storeKey, data)` ersetzte den
 * GESAMTEN Supabase-Stand durch den localStorage-Stand. War localStorage stale
 * (frischer Login, anderer Browser), verschwanden dort gespeicherte Budgetjahre.
 *
 * Merge-Regeln:
 *  - Das explizit geänderte Jahr (`action.year`) gewinnt lokal — als Daten
 *    ODER als Tombstone (`deleted`, kein Union-Resurrect). Jeder Save ist
 *    eine echte Benutzeraktion: der 2026-Seed ist seit Stabilisierungsrunde
 *    2.2 ein reiner View-Default und erreicht diesen Pfad nie automatisch.
 *  - Alle anderen Jahre: neueres `updatedAt` gewinnt (Tombstones inklusive);
 *    nur einseitig vorhandene Jahre bleiben erhalten.
 *  - Backup-Probleme sind sichtbar: offline/nicht konfiguriert → dezenter
 *    Hinweis, echter Fehler → Fehler-Toast mit Retry (Befund 2).
 */
async function backupBudgetsToKV(
  data: Record<number, StoredBudgetYear>,
  storeKey: string,
  action: BudgetSaveAction,
): Promise<void> {
  let notifyProblem: ((e: unknown) => Promise<void>) | null = null;
  try {
    const { kvGetStrict, kvSetStrict, notifyKVBackupProblem } = await import('./supabase-kv');
    notifyProblem = (e: unknown) =>
      notifyKVBackupProblem(e, 'Budget', {
        toastId: 'budget-kv-write-failed',
        retry: () => {
          // Beim Retry FRISCH aus localStorage lesen — der alte Snapshot könnte
          // einen inzwischen erfolgreichen neueren Save rückgängig machen.
          kvBackupQueue = kvBackupQueue.then(() =>
            backupBudgetsToKV(loadAll(storeKey), storeKey, action),
          );
          return kvBackupQueue;
        },
      });
    // kvGetStrict statt kvGet: Ein Lesefehler darf nicht wie «Remote ist leer»
    // aussehen — sonst würde der Merge remote-only Jahre verlieren. Bei
    // Lesefehler bricht das Backup sichtbar ab (localStorage bleibt intakt).
    const remote = await kvGetStrict(storeKey);
    const remoteMap: Record<string, StoredBudgetYear> =
      remote && typeof remote === 'object' && !Array.isArray(remote)
        ? (remote as Record<string, StoredBudgetYear>)
        : {};
    const localMap = data as unknown as Record<string, StoredBudgetYear>;

    const merged: Record<string, StoredBudgetYear> = {};
    const allYears = new Set([...Object.keys(remoteMap), ...Object.keys(localMap)]);
    for (const y of allYears) {
      const l = localMap[y];
      const r = remoteMap[y];
      if (Number(y) === action.year) {
        if (l) { merged[y] = l; continue; }     // lokale Aktion gewinnt (Daten oder Tombstone)
        if (r && !action.deleted) { merged[y] = r; }
        continue;
      }
      if (l && r) {
        const lTime = Date.parse(l.updatedAt ?? '') || 0;
        const rTime = Date.parse(r.updatedAt ?? '') || 0;
        merged[y] = lTime >= rTime ? l : r;
      } else {
        merged[y] = (l ?? r)!;
      }
    }

    await kvSetStrict(storeKey, merged);
  } catch (err) {
    console.error(`[BUDGET] KV-Backup fehlgeschlagen für ${storeKey}:`, err);
    if (notifyProblem) {
      await notifyProblem(err);
    }
  }
}

function saveAll(
  data: Record<number, StoredBudgetYear>,
  storeKey: string,
  action: BudgetSaveAction,
): void {
  localStorage.setItem(storeKey, JSON.stringify(data));
  // Snapshot der Daten für die asynchrone Queue (data kann danach mutiert werden)
  const snapshot = JSON.parse(JSON.stringify(data)) as Record<number, StoredBudgetYear>;
  kvBackupQueue = kvBackupQueue.then(() => backupBudgetsToKV(snapshot, storeKey, action));
}

/** Für Tests: wartet, bis alle ausstehenden KV-Backups abgeschlossen sind. */
export function flushBudgetKVBackups(): Promise<void> {
  return kvBackupQueue;
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
 * Für Jahr 2026: Existiert noch kein echtes Budget (keine Werte ≠ 0), werden
 * die Excel-Seed-Werte als reiner View-Default zurückgegeben — NICHT
 * persistiert (`viewDefault: true`): beim blossen Laden entsteht weder ein
 * localStorage-Record noch ein KV-Backup, kein updatedAt, kein Importstatus,
 * kein Tombstone-Resurrect. Persistiert wird erst bei einer echten
 * Benutzeraktion über die bestehenden Save-Pfade.
 * Für andere Jahre: Gibt ein leeres Budgetjahr zurück (ebenfalls nicht persistiert).
 */
export function loadBudgetYear(year: number, storeKey: string = STORAGE_KEY): BudgetYear {
  const all = loadAll(storeKey);
  const entry = all[year];
  // Tombstones (gelöschte Jahre) für alle Leser wie «nicht vorhanden» behandeln
  const existing = entry && !entry.deleted ? entry : undefined;
  if (year === 2026 && !hasRealBudgetValues(existing)) {
    // View-Default für Oliv bzw. Beaulieu (Werte aus den Budget-2026-Excels)
    if (storeKey === STORAGE_KEY) {
      return { ...createSeededBudget2026(), viewDefault: true };
    }
    if (storeKey === 'beaulieu:budget_v1') {
      return { ...createSeededBeaulieuBudget2026(), viewDefault: true };
    }
  }
  return existing ?? createEmptyBudgetYear(year);
}

/**
 * Budget 2026 auf Excel-Seed zurücksetzen (alle bestehenden Daten werden überschrieben).
 * Explizite Benutzeraktion — läuft über den normalen Save-Pfad (updatedAt wird
 * gesetzt, ein allfälliger Tombstone bewusst ersetzt, KV-Backup läuft).
 */
export function resetBudget2026ToSeed(storeKey: string = STORAGE_KEY): BudgetYear {
  const seeded = storeKey === 'beaulieu:budget_v1'
    ? createSeededBeaulieuBudget2026()
    : createSeededBudget2026();
  return saveBudgetYear(seeded, storeKey);
}

/**
 * Budgetjahr speichern.
 * Überschreibt das bestehende Jahr komplett.
 *
 * Dirty-Check (verbindliche Regel): `updatedAt` wird NUR neu gesetzt, wenn
 * sich die fachlichen Daten tatsächlich geändert haben. Ein identischer Save
 * (gleiche Werte, gleiche Struktur) erzeugt weder einen updatedAt-Bump noch
 * einen localStorage-/KV-Write — sonst würde ein wirkungsloser Klick in
 * newer-wins-Merges fälschlich gegen echte Remote-Änderungen gewinnen.
 * Ausnahmen, die IMMER speichern: Jahr existiert noch nicht, oder es liegt
 * ein Tombstone vor (bewusste Neuanlage ersetzt ihn mit neuerem updatedAt).
 *
 * @returns den tatsächlich persistierten Datensatz — bei unverändertem
 *          Inhalt der bestehende Record (alter updatedAt bleibt gültig).
 */
export function saveBudgetYear(data: BudgetYear, storeKey: string = STORAGE_KEY): BudgetYear {
  const all = loadAll(storeKey);
  const rec: StoredBudgetYear = { ...data };
  // Explizites Speichern ersetzt einen allfälligen Tombstone (Jahr-Neuanlage)
  delete rec.deleted;
  // Erste echte Benutzeraktion auf einem View-Default (2026-Seed) macht daraus
  // ein reguläres Budget — das transiente Flag wird nie mitpersistiert.
  delete rec.viewDefault;

  const existing = all[data.year];
  if (existing && !existing.deleted && budgetBusinessEqual(existing, rec)) {
    // Keine fachliche Änderung → kein updatedAt-Bump, kein Write.
    return existing;
  }

  rec.updatedAt = new Date().toISOString();
  all[data.year] = rec;
  saveAll(all, storeKey, { year: data.year });
  return rec;
}

/**
 * Alle Jahre mit gespeicherten Budgets.
 * Sortiert absteigend (neuestes Jahr zuerst).
 */
export function availableBudgetYears(storeKey: string = STORAGE_KEY): number[] {
  const all = loadAll(storeKey);
  return Object.entries(all)
    .filter(([, v]) => !v?.deleted)
    .map(([k]) => Number(k))
    .sort((a, b) => b - a);
}

/**
 * Budgetjahr löschen.
 */
export function deleteBudgetYear(year: number, storeKey: string = STORAGE_KEY): void {
  const all = loadAll(storeKey);
  // Wiederholtes Löschen eines bereits getilgten Jahres ist keine fachliche
  // Änderung: der bestehende Tombstone (samt updatedAt) bleibt unangetastet,
  // es gibt keinen weiteren Write.
  if (all[year]?.deleted) return;
  const now = new Date().toISOString();
  // Tombstone statt Hard-Delete: ein stales Gerät mit altem localStorage darf
  // das Jahr beim nächsten Backup-Merge nicht wiederbeleben (newer-wins gegen
  // das Tombstone-updatedAt). Alle Leser filtern `deleted`.
  all[year] = {
    year,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: all[year]?.createdAt ?? now,
    updatedAt: now,
    deleted: true,
  };
  saveAll(all, storeKey, { year, deleted: true });
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
  storeKey: string = STORAGE_KEY,
): BudgetYear {
  const source = loadBudgetYear(fromYear, storeKey);
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

  return saveBudgetYear(newBudget, storeKey);
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

  // Kein updatedAt-Bump: applyRulesToBudget ist eine reine Funktion — den
  // Änderungszeitstempel setzt ausschliesslich der Save-Pfad (saveBudgetYear),
  // und nur wenn sich fachlich etwas geändert hat.
  return {
    ...budget,
    positions,
    wasAutoCalculated: budget.rules.length > 0,
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
  storeKey: string = STORAGE_KEY,
): BudgetYear {
  const budget = loadBudgetYear(year, storeKey);
  const positions = budget.positions.map(p =>
    p.id === updatedPosition.id ? updatedPosition : p,
  );
  return saveBudgetYear({ ...budget, positions }, storeKey);
}

// ─── Regeln-Verwaltung ────────────────────────────────────────────────────────

/**
 * Fügt eine neue Regel zum Budgetjahr hinzu und speichert.
 */
export function addBudgetRule(year: number, rule: Omit<BudgetRule, 'id' | 'createdAt'>, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetYear(year, storeKey);
  const newRule: BudgetRule = {
    ...rule,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  return saveBudgetYear({ ...budget, rules: [...budget.rules, newRule] }, storeKey);
}

/**
 * Entfernt eine Regel aus dem Budgetjahr und speichert.
 */
export function removeBudgetRule(year: number, ruleId: string, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetYear(year, storeKey);
  return saveBudgetYear({ ...budget, rules: budget.rules.filter(r => r.id !== ruleId) }, storeKey);
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

/**
 * Wirklich veraltete IDs – diese wurden durch neue IDs/Strukturen ersetzt und
 * existieren NICHT mehr in DEFAULT_PL_LINE_ITEMS.
 */
const OBSOLETE_PL_IDS = [
  // Alte Rohbezeichnungen
  'pli_waren_wein', 'pli_waren_bier', 'pli_waren_spirit', 'pli_waren_mineral', 'pli_waren_kueche',
  'pli_lohn_zulagen',
  'pli_nebenkosten', 'pli_verwaltung', 'pli_uebrig_aufwand',
  'pli_reinigung',
  // Kontoplan-Umbau 2026 – entfernte / umbenannte Konten
  'pli_umsatz',        // 3000 → aufgeteilt in pli_ertrag_a / pli_ertrag_ta / …
  'pli_growa',         // 4000 GROWA → 4020 Wein
  'pli_alligro',       // 4001 Alligro → 4040 Spirituosen
  'pli_bier',          // 4002 → 4030 Bier
  'pli_wein',          // 4010 → 4020 Wein
  'pli_kueche',        // 4060 → pli_kueche_wa
  // NOTE: pli_bvg, pli_uvg, pli_ure_edv, pli_energie sind NICHT obsolet –
  //       sie existieren in DEFAULT_PL_LINE_ITEMS und im 2026-Seed mit gültigen Werten.
  'pli_ktg',           // 5730 KTG → entfällt (UVG übernimmt 5730)
  'pli_quellst',       // 5770 Quellensteuer → nicht mehr im Kontoplan
  'pli_personalverpf', // 5850 → nicht mehr im Kontoplan
  'pli_zulagen',       // 5010 war in pl_social → neu in pl_wages
  'pli_weiterbildung', // 5830 → neu 5810
  'pli_hauswart',      // 6002 Reinigung/Hauswart → entfernt
  'pli_miete_park',    // 6002 Parkplatz → entfernt
  'pli_unterhalt',     // 6200 Unterhalt Gebäude → nicht mehr im Kontoplan
  'pli_leasing',       // 6101 Leasing Maschinen → nicht mehr im Kontoplan
  'pli_versicherungen',// 6300 → neu 6310 Haftpflicht
  'pli_abschreibungen',// 6800 → neu pli_finance_6800 (Abschreibungen)
];

function migrateObsoletePLItems(budget: BudgetYear): BudgetYear {
  const items = budget.plLineItems ?? [];
  const hasObsolete = items.some(i => OBSOLETE_PL_IDS.includes(i.id));
  if (!hasObsolete) return budget;

  const kept = items.filter(i => !OBSOLETE_PL_IDS.includes(i.id));
  const existingIds = new Set(kept.map(i => i.id));
  const toAdd = DEFAULT_PL_LINE_ITEMS
    .filter(d => !existingIds.has(d.id))
    .map(createDefaultPLLineItem);

  return { ...budget, plLineItems: [...kept, ...toAdd] };
}

/**
 * Stellt sicher, dass alle Standard-P&L-Positionen (DEFAULT_PL_LINE_ITEMS)
 * im Budget vorhanden sind. Fügt fehlende hinzu, ohne bestehende Daten zu
 * überschreiben. Wird automatisch beim Laden und nach der Reparatur ausgeführt.
 */
function ensureDefaultPLItems(budget: BudgetYear): BudgetYear {
  const items = budget.plLineItems ?? [];
  const existingIds = new Set(items.map(i => i.id));
  const missing = DEFAULT_PL_LINE_ITEMS.filter(d => !existingIds.has(d.id));
  if (missing.length === 0) return budget;
  return {
    ...budget,
    plLineItems: [...items, ...missing.map(createDefaultPLLineItem)],
  };
}

/**
 * Stellt sicher, dass alle Standard-P&L-Kategorien im Budget vorhanden sind.
 * Fügt neue Kategorien hinzu (ohne bestehende zu löschen), aktualisiert
 * sortOrder und resultFormula falls geändert.
 */
function ensureDefaultPLCategories(budget: BudgetYear): BudgetYear {
  const existing = budget.plCategories ?? [];
  const existingMap = new Map(existing.map(c => [c.id, c]));
  let changed = false;
  const merged = DEFAULT_PL_CATEGORIES.map(def => {
    const ex = existingMap.get(def.id);
    if (!ex) { changed = true; return { ...def }; }
    // Update sortOrder + resultFormula if changed; keep user label edits
    const needsUpdate =
      ex.sortOrder !== def.sortOrder ||
      JSON.stringify(ex.resultFormula) !== JSON.stringify(def.resultFormula);
    if (needsUpdate) { changed = true; return { ...ex, sortOrder: def.sortOrder, resultFormula: def.resultFormula }; }
    return ex;
  });
  if (!changed) return budget;
  return { ...budget, plCategories: merged };
}

/**
 * Stellt für 2026-Budgets sicher, dass Positionen mit ausschliesslich Null-Werten
 * die korrekten Seed-Werte erhalten. Betrifft Konten, die früher fälschlicherweise
 * als "obsolet" markiert und durch leere Standardeinträge ersetzt wurden:
 * 5710 BVG (pli_bvg), 5730 UVG (pli_uvg), 6140 EDV (pli_ure_edv),
 * 6400 Energie (pli_energie), 6800 Abschreibungen (pli_finance_6800),
 * 6910 Zinsaufwand (pli_zinsaufwand).
 */
function migrateSeedZeroValues2026(budget: BudgetYear, storeKey: string = STORAGE_KEY): BudgetYear {
  if (budget.year !== 2026) return budget;

  // Seed-Map je nach Tenant
  let seedItems: BudgetPLLineItem[];
  if (storeKey === STORAGE_KEY) {
    seedItems = SEED_2026_LINE_ITEMS;
  } else if (storeKey === 'beaulieu:budget_v1') {
    seedItems = SEED_BEAULIEU_2026_LINE_ITEMS;
  } else {
    return budget;
  }

  const seedMap = new Map(seedItems.map(s => [s.id, s]));
  const items = budget.plLineItems ?? [];
  let changed = false;
  const healed = items.map(item => {
    const seedItem = seedMap.get(item.id);
    if (!seedItem) return item;
    const allZero = item.monthlyValues.every(v => v === 0);
    const seedHasValues = seedItem.monthlyValues.some(v => v !== 0);
    if (allZero && seedHasValues) {
      changed = true;
      return { ...item, monthlyValues: [...seedItem.monthlyValues] };
    }
    return item;
  });
  if (!changed) return budget;
  return { ...budget, plLineItems: healed };
}

/**
 * Budgetjahr laden und P&L-Struktur sicherstellen.
 */
export function loadBudgetWithPL(year: number, storeKey: string = STORAGE_KEY): BudgetYear {
  const original = loadBudgetYear(year, storeKey);
  let budget = original;
  if (!budget.plCategories || !budget.plLineItems) {
    budget = initPLStructure(budget);
  }
  budget = migrateToSingleRevenueItem(budget);
  budget = migrateObsoletePLItems(budget);
  budget = ensureDefaultPLCategories(budget);
  budget = ensureDefaultPLItems(budget);
  budget = migrateSeedZeroValues2026(budget, storeKey);
  // Immer Sync: plLineItems → legacy positions (damit Dashboard/SollIst budget_revenue findet)
  budget = syncPLToLegacyPositions(budget);
  // Reiner Ladepfad: schreibt NIE nach Supabase (kein saveBudgetYear, kein
  // KV-Backup). Der frühere saveBudgetYear-Aufruf hier stempelte updatedAt neu
  // und liess ein Gerät mit stalem localStorage beim blossen ÖFFNEN den
  // neueren Remote-Stand überschreiben (das Aktionsjahr gewinnt im Merge).
  // Migrations-/Sync-Ergebnisse werden nur LOKAL persistiert — und nur, wenn
  // eine Migration effektiv etwas geändert hat (alle Migrationsschritte geben
  // bei «keine Änderung» dieselbe Objektreferenz zurück).
  if (budget !== original) {
    persistMigratedBudgetLocally(budget, storeKey);
  }
  return budget;
}

/**
 * Persistiert ein beim Laden migriertes Budget NUR in localStorage:
 *  - nie nach Supabase (ein reiner Ladevorgang löst kein KV-Backup aus),
 *  - nie ein neues Jahr anlegen (nur bestehende Records werden migriert),
 *  - nie einen Tombstone überschreiben (gelöschte Jahre bleiben gelöscht),
 *  - createdAt/updatedAt bleiben unverändert — eine Migration ist keine
 *    Benutzeränderung; ein updatedAt-Bump würde stale Daten in
 *    newer-wins-Merges fälschlich gewinnen lassen.
 */
function persistMigratedBudgetLocally(budget: BudgetYear, storeKey: string): void {
  try {
    // View-Defaults (nicht persistierter 2026-Seed) NIE lokal ablegen — auch
    // dann nicht, wenn ein wertloser Alt-Record (alles 0) im Storage liegt:
    // der bliebe sonst still durch Seed-Werte ersetzt.
    if (budget.viewDefault) return;
    const all = loadAll(storeKey);
    const existing = all[budget.year];
    if (!existing || existing.deleted) return;
    all[budget.year] = {
      ...budget,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
    localStorage.setItem(storeKey, JSON.stringify(all));
  } catch {
    /* localStorage nicht verfügbar — Migration bleibt in-memory */
  }
}

/**
 * Lädt das Budget aus Supabase und speichert es in localStorage.
 * Gibt das Budget zurück wenn echte Daten gefunden wurden, sonst null.
 * Wird aufgerufen wenn localStorage leer ist (z.B. neuer Browser oder Cache geleert).
 */
export async function syncBudgetFromSupabase(year: number, storeKey: string = STORAGE_KEY): Promise<BudgetYear | null> {
  try {
    const { kvGet } = await import('./supabase-kv');
    const remote = await kvGet(storeKey);
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      console.log(`[BUDGET-SYNC] Supabase: kein Eintrag für storeKey="${storeKey}"`);
      return null;
    }
    const all = remote as Record<number, StoredBudgetYear>;
    const budget = all[year];
    if (!budget || budget.deleted) {
      console.log(`[BUDGET-SYNC] Supabase: kein Budget für Jahr=${year} in storeKey="${storeKey}"${budget?.deleted ? ' (gelöscht/Tombstone)' : ''}`);
      return null;
    }
    const hasRealData = budget.plLineItems?.some(i => i.monthlyValues.some(v => v !== 0));
    if (!hasRealData) {
      console.log(`[BUDGET-SYNC] Supabase: Budget für Jahr=${year} hat nur Nullwerte — kein Sync`);
      return null;
    }
    // In localStorage speichern (Supabase → localStorage)
    const localAll = loadAll(storeKey);
    localAll[year] = budget;
    localStorage.setItem(storeKey, JSON.stringify(localAll));
    console.log(`[BUDGET-SYNC] Supabase→localStorage: storeKey="${storeKey}" year=${year}, items=${budget.plLineItems?.length ?? 0}`);
    return budget;
  } catch (e) {
    console.error('[BUDGET-SYNC] Fehler beim Supabase-Sync:', e);
    return null;
  }
}

/**
 * Fügt alle fehlenden Standard-P&L-Positionen zum Budget hinzu (für den
 * expliziten "Standardkonten sicherstellen"-Button im Budget).
 * Gibt die Anzahl der hinzugefügten Positionen zurück.
 */
export function restoreMissingDefaultPLItems(year: number, storeKey: string = STORAGE_KEY): { budget: BudgetYear; added: number } {
  const budget = loadBudgetWithPL(year, storeKey);
  const items = budget.plLineItems ?? [];
  const existingIds = new Set(items.map(i => i.id));
  const missing = DEFAULT_PL_LINE_ITEMS.filter(d => !existingIds.has(d.id));
  if (missing.length === 0) return { budget, added: 0 };
  const updated = {
    ...budget,
    plLineItems: [...items, ...missing.map(createDefaultPLLineItem)],
  };
  return { budget: saveBudgetYear(updated, storeKey), added: missing.length };
}

/**
 * Setzt die P&L-Kontenstruktur vollständig zurück auf DEFAULT_PL_CATEGORIES
 * und DEFAULT_PL_LINE_ITEMS. Alle bestehenden Budgetwerte der P&L-Positionen
 * gehen verloren; Budgetpositionen, Regeln und Jahr bleiben erhalten.
 */
export function resetPLToDefaults(year: number, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetYear(year, storeKey);
  const reset: BudgetYear = {
    ...budget,
    plCategories: DEFAULT_PL_CATEGORIES.map(c => ({ ...c })),
    plLineItems: DEFAULT_PL_LINE_ITEMS.map(createDefaultPLLineItem),
  };
  return saveBudgetYear(reset, storeKey);
}

/**
 * Löscht eine P&L-Zeile (auch Standard-Positionen).
 */
export function deletePLLineItem(year: number, itemId: string, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetWithPL(year, storeKey);
  const updated = syncPLToLegacyPositions({
    ...budget,
    plLineItems: budget.plLineItems!.filter(i => i.id !== itemId),
  });
  return saveBudgetYear(updated, storeKey);
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
export function savePLLineItem(year: number, item: BudgetPLLineItem, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetWithPL(year, storeKey);
  const exists = budget.plLineItems!.some(i => i.id === item.id);
  const lineItems = exists
    ? budget.plLineItems!.map(i => i.id === item.id ? item : i)
    : [...budget.plLineItems!, item];

  const updated = syncPLToLegacyPositions({ ...budget, plLineItems: lineItems });
  return saveBudgetYear(updated, storeKey);
}

/**
 * Fügt eine neue benutzerdefinierte P&L-Zeile hinzu.
 */
export function addCustomPLLineItem(
  year: number,
  item: Omit<BudgetPLLineItem, 'id' | 'isDefault'>,
  storeKey: string = STORAGE_KEY,
): BudgetYear {
  const budget = loadBudgetWithPL(year, storeKey);
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
  return saveBudgetYear(updated, storeKey);
}

/**
 * Entfernt eine benutzerdefinierte P&L-Zeile (nur nicht-Standard-Zeilen).
 */
export function removeCustomPLLineItem(year: number, itemId: string, storeKey: string = STORAGE_KEY): BudgetYear {
  const budget = loadBudgetWithPL(year, storeKey);
  const item   = budget.plLineItems!.find(i => i.id === itemId);
  if (item?.isDefault) {
    throw new Error('Standard-Positionen können nicht gelöscht werden.');
  }
  const updated = syncPLToLegacyPositions({
    ...budget,
    plLineItems: budget.plLineItems!.filter(i => i.id !== itemId),
  });
  return saveBudgetYear(updated, storeKey);
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

  const items = budget.plLineItems;

  // Wenn positions leer ist (z.B. beim Seed-Budget), mit Standard-Positionen initialisieren
  const basePositions = budget.positions.length > 0
    ? budget.positions.map(p => ({ ...p, monthlyValues: [...p.monthlyValues] as BudgetPosition['monthlyValues'] }))
    : DEFAULT_BUDGET_POSITIONS.map(def => createDefaultPosition(def));

  const positions = basePositions;
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

  // Dirty Check (Objektidentität): Nur wenn sich die Legacy-Positionen
  // effektiv geändert haben, entsteht ein neues Objekt — sonst würde jeder
  // reine Ladevorgang das Budget als «geändert» behandeln.
  if (
    budget.positions.length > 0 &&
    JSON.stringify(budget.positions) === JSON.stringify(positions)
  ) {
    return budget;
  }

  // Kein updatedAt-Bump: der Legacy-Sync ist eine Ableitung, keine
  // Benutzeränderung. Den Änderungszeitstempel setzt ausschliesslich
  // saveBudgetYear — im reinen Ladepfad bleibt updatedAt unverändert
  // (persistMigratedBudgetLocally übernimmt den bestehenden Wert).
  return { ...budget, positions };
}
