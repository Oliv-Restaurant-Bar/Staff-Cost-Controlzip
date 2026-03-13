/**
 * Lieferantendokumente Store
 * ===========================
 *
 * Speicherung: localStorage (Schlüssel: 'supplier_docs_v1')
 * Zukünftig: Supabase-Tabelle 'supplier_documents'
 *
 * Wichtige Regel:
 *   Lieferantendokumente schreiben NIEMALS in den reporting-store.
 *   Die Buchhaltungswerte (reporting_v1) bleiben immer unberührt.
 *   Die Vergleichsstruktur (CostComparisonRecord) liest aus beiden
 *   Quellen, schreibt aber nur in supplier_docs_v1.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  SupplierDocument,
  DocumentType,
  DocumentCategory,
  SupplierMonthSummary,
  CostComparisonRecord,
  SupplierCostSummary,
  SupplierCostComparison,
} from '@/types/supplier-documents';
import { loadMonth } from '@/lib/reporting-store';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'supplier_docs_v1';

// ─── Persistenz ───────────────────────────────────────────────────────────────

type Store = Record<string, SupplierDocument>;

function loadAll(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAll(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Neues Lieferantendokument hinzufügen.
 */
export function addDocument(input: {
  supplier: string;
  documentType: DocumentType;
  date: string;          // YYYY-MM-DD
  category: DocumentCategory;
  amount: number;
  note?: string;
}): SupplierDocument {
  const all  = loadAll();
  const now  = new Date().toISOString();
  const d    = new Date(input.date);
  const doc: SupplierDocument = {
    id:           uuidv4(),
    supplier:     input.supplier.trim(),
    documentType: input.documentType,
    date:         input.date,
    year:         d.getFullYear(),
    month:        d.getMonth() + 1,
    category:     input.category,
    amount:       input.amount,
    note:         input.note?.trim() || undefined,
    createdAt:    now,
    updatedAt:    now,
  };
  all[doc.id] = doc;
  saveAll(all);
  return doc;
}

/**
 * Vorhandenes Dokument bearbeiten.
 */
export function updateDocument(
  id: string,
  changes: Partial<Pick<SupplierDocument,
    'supplier' | 'documentType' | 'date' | 'category' | 'amount' | 'note'
  >>,
): SupplierDocument | null {
  const all = loadAll();
  const doc = all[id];
  if (!doc) return null;

  const now = new Date().toISOString();
  const newDate = changes.date ?? doc.date;
  const d = new Date(newDate);

  const updated: SupplierDocument = {
    ...doc,
    ...changes,
    year:      d.getFullYear(),
    month:     d.getMonth() + 1,
    note:      changes.note !== undefined
               ? (changes.note.trim() || undefined)
               : doc.note,
    updatedAt: now,
  };
  all[id] = updated;
  saveAll(all);
  return updated;
}

/**
 * Dokument löschen.
 */
export function deleteDocument(id: string): void {
  const all = loadAll();
  delete all[id];
  saveAll(all);
}

/**
 * Alle Dokumente laden (nach Datum absteigend sortiert).
 */
export function loadDocuments(): SupplierDocument[] {
  const all = loadAll();
  return Object.values(all).sort((a, b) =>
    b.date.localeCompare(a.date),
  );
}

/**
 * Dokumente eines bestimmten Monats laden.
 */
export function loadDocumentsForMonth(year: number, month: number): SupplierDocument[] {
  return loadDocuments().filter(d => d.year === year && d.month === month);
}

/**
 * Alle eindeutigen Lieferantennamen (für Autocomplete).
 */
export function knownSuppliers(): string[] {
  const all = loadDocuments();
  return [...new Set(all.map(d => d.supplier))].sort();
}

/**
 * Alle Jahre, für die Dokumente existieren.
 */
export function availableYears(): number[] {
  const all = loadDocuments();
  const years = new Set(all.map(d => d.year));
  const cur = new Date().getFullYear();
  years.add(cur);
  return [...years].sort((a, b) => b - a);
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Monatliche Zusammenfassung aller Lieferantendokumente.
 * Berechnet operative Warenkostenschätzungen nach Kategorie.
 */
export function getMonthSummary(year: number, month: number): SupplierMonthSummary {
  const docs = loadDocumentsForMonth(year, month);

  const foodCost     = docs.filter(d => d.category === 'food')    .reduce((s, d) => s + d.amount, 0);
  const beverageCost = docs.filter(d => d.category === 'beverage').reduce((s, d) => s + d.amount, 0);
  const otherCost    = docs.filter(d => d.category === 'other')   .reduce((s, d) => s + d.amount, 0);

  return {
    year,
    month,
    foodCost,
    beverageCost,
    otherCost,
    totalCost:     foodCost + beverageCost + otherCost,
    documentCount: docs.length,
    documents:     docs,
  };
}

// ─── Buchhaltungsvergleich ────────────────────────────────────────────────────

/**
 * Baut einen CostComparisonRecord für einen Monat.
 *
 * Liest:
 *   - Operative Werte aus supplier_docs_v1 (dieser Store)
 *   - Buchhaltungswerte aus reporting_v1 (reporting-store, read-only)
 *
 * Schreibt NIEMALS in den reporting-store.
 *
 * Die Buchhaltungswerte werden aus expenseCategories gelesen.
 * Konten 4xxx (Wareneinsatz) werden nach Kategorie summiert:
 *   4000–4099 → food, 4100–4199 → beverage, 4200–4999 → other
 */
export function buildCostComparison(year: number, month: number): CostComparisonRecord {
  const operational = getMonthSummary(year, month);
  const accounting  = loadMonth(year, month);

  // Buchhaltungswerte aus expenseCategories extrahieren (4xxx-Konten)
  let accFood     = 0;
  let accBeverage = 0;
  let accOther    = 0;
  let hasAccData  = false;

  for (const cat of accounting.expenseCategories) {
    const id = cat.categoryId;

    // Kontonummer-basiert (CSV/PDF-Import): 4xxx
    if (/^\d{4}$/.test(id)) {
      const num = parseInt(id);
      if (num >= 4000 && num <= 4099)      { accFood     += cat.amount ?? 0; hasAccData = true; }
      else if (num >= 4100 && num <= 4199) { accBeverage += cat.amount ?? 0; hasAccData = true; }
      else if (num >= 4200 && num <= 4999) { accOther    += cat.amount ?? 0; hasAccData = true; }
    }
    // Human-readable IDs (manuelle Erfassung)
    else if (/wareneinsatz_kueche|warenaufwand_kueche|food_cost/.test(id)) {
      accFood += cat.amount ?? 0; hasAccData = true;
    }
    else if (/wareneinsatz_bar|wareneinsatz_getraenke|beverage_cost/.test(id)) {
      accBeverage += cat.amount ?? 0; hasAccData = true;
    }
    else if (/wareneinsatz_diverses|warenaufwand_diverses/.test(id)) {
      accOther += cat.amount ?? 0; hasAccData = true;
    }
  }

  const accTotal = accFood + accBeverage + accOther;
  const opTotal  = operational.totalCost;

  return {
    year,
    month,
    operationalFoodCost:     operational.foodCost,
    operationalBeverageCost: operational.beverageCost,
    operationalOtherCost:    operational.otherCost,
    operationalTotalCost:    opTotal,
    documentCount:           operational.documentCount,
    accountingFoodCost:      hasAccData ? accFood     : undefined,
    accountingBeverageCost:  hasAccData ? accBeverage : undefined,
    accountingTotalCost:     hasAccData ? accTotal    : undefined,
    diffFoodCost:            hasAccData ? operational.foodCost     - accFood     : undefined,
    diffBeverageCost:        hasAccData ? operational.beverageCost - accBeverage : undefined,
    diffTotalCost:           hasAccData ? opTotal - accTotal : undefined,
    diffTotalPct:            hasAccData && accTotal !== 0
                             ? ((opTotal - accTotal) / Math.abs(accTotal)) * 100
                             : undefined,
    hasAccountingData:       hasAccData,
  };
}

// ─── Architektur-Vorbereitung: Per-Lieferanten-Aggregation ───────────────────

/**
 * Aggregiert alle Lieferantendokumente eines Monats PRO LIEFERANT.
 *
 * Vorbereitung für das spätere Modul «Lieferantenvergleich».
 * Noch nicht in der UI eingebunden – dient als Daten-Fundament.
 *
 * Gibt für jeden Lieferanten eine SupplierCostSummary zurück,
 * sortiert nach Gesamtkosten absteigend.
 */
export function getSupplierCostSummaries(year: number, month: number): SupplierCostSummary[] {
  const docs = loadDocumentsForMonth(year, month);
  const bySupplier = new Map<string, SupplierCostSummary>();

  for (const doc of docs) {
    let s = bySupplier.get(doc.supplier);
    if (!s) {
      s = {
        supplier:          doc.supplier,
        year,
        month,
        foodCost:          0,
        beverageCost:      0,
        otherCost:         0,
        totalCost:         0,
        documentCount:     0,
        deliveryNoteCount: 0,
        invoiceCount:      0,
      };
      bySupplier.set(doc.supplier, s);
    }

    if (doc.category === 'food')         s.foodCost     += doc.amount;
    else if (doc.category === 'beverage') s.beverageCost += doc.amount;
    else                                  s.otherCost    += doc.amount;

    s.totalCost    += doc.amount;
    s.documentCount++;
    if (doc.documentType === 'delivery_note') s.deliveryNoteCount++;
    else                                      s.invoiceCount++;
  }

  return [...bySupplier.values()].sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * Vorbereitung Vergleich pro Lieferant vs. Buchhaltung.
 *
 * STUB: Gibt aktuell nur die operative Seite zurück (hasAccountingData = false),
 * weil die Konto→Lieferant-Zuordnung (AccountToSupplierMapping) noch nicht
 * konfiguriert wird. Sobald dieses Mapping eingerichtet ist, wird hier die
 * Buchhaltungsseite befüllt.
 *
 * Spätere Erweiterung:
 *   1. Lade AccountToSupplierMapping aus localStorage
 *   2. Lies den Buchhaltungswert des gemappten Kontos aus dem reporting-store
 *   3. Berechne Anteil (allocationPct) und befülle accountingTotal + diff
 */
export function buildSupplierCostComparisons(year: number, month: number): SupplierCostComparison[] {
  const summaries = getSupplierCostSummaries(year, month);

  return summaries.map(s => ({
    supplier:               s.supplier,
    month:                  s.month,
    year:                   s.year,
    operationalTotal:       s.totalCost,
    operationalFoodCost:    s.foodCost,
    operationalBeverageCost: s.beverageCost,
    operationalOtherCost:   s.otherCost,
    accountingTotal:        undefined,
    diff:                   undefined,
    diffPct:                undefined,
    hasAccountingData:      false,
  }));
}
