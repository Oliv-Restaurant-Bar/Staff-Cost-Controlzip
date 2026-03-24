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
  SupplierMaster,
  DocumentType,
  DocumentCategory,
  DocumentMatchStatus,
  SupplierMonthSummary,
  CostComparisonRecord,
  SupplierCostSummary,
  SupplierCostComparison,
  AccountToSupplierMapping,
  CostAllocationTarget,
  AllocationSplit,
} from '@/types/supplier-documents';
import { loadMonth } from '@/lib/reporting-store';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const STORAGE_KEY         = 'supplier_docs_v1';
const MAPPING_KEY         = 'supplier_account_mapping_v1';
const SUPPLIER_MASTER_KEY = 'supplier_master_v1';

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

// ─── Datumslogik ──────────────────────────────────────────────────────────────

/**
 * Gibt das massgebliche Datum für Monatszuordnung, WES und Tracking zurück.
 *
 * Priorität:
 *   1. deliveryDate – Lieferdatum (wenn gesetzt)
 *   2. date         – Belegdatum (Rechnungs-/Lieferscheindatum)
 *
 * Warum wichtig:
 *   Eine Rechnung kann erst Wochen nach der Lieferung eintreffen.
 *   Beispiel: Lieferung 30. März, Rechnung 5. April.
 *   Ohne Lieferdatum würde der WES April statt März zugeordnet.
 *   Mit gesetztem deliveryDate wird der Beleg korrekt dem März zugeordnet.
 */
export function getEffectiveDate(doc: Pick<SupplierDocument, 'date' | 'deliveryDate'>): string {
  return doc.deliveryDate || doc.date;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Neues Lieferantendokument hinzufügen.
 * year/month werden aus getEffectiveDate(deliveryDate ?? date) abgeleitet.
 */
export function addDocument(input: {
  supplier: string;
  documentType: DocumentType;
  date: string;             // YYYY-MM-DD  (Belegdatum, Pflicht)
  deliveryDate?: string;    // YYYY-MM-DD  (Lieferdatum, optional)
  category: DocumentCategory;
  amount: number;
  accountNumber?: string;
  note?: string;
  referenceNumber?: string;
  allocationTarget?: CostAllocationTarget;
  allocationSplits?: AllocationSplit[];
}): SupplierDocument {
  const all  = loadAll();
  const now  = new Date().toISOString();
  const eff  = input.deliveryDate || input.date;
  const d    = new Date(eff);
  const doc: SupplierDocument = {
    id:              uuidv4(),
    supplier:        input.supplier.trim(),
    documentType:    input.documentType,
    date:            input.date,
    deliveryDate:    input.deliveryDate?.trim() || undefined,
    year:            d.getFullYear(),
    month:           d.getMonth() + 1,
    category:        input.category,
    amount:          input.amount,
    accountNumber:   input.accountNumber?.trim() || undefined,
    note:            input.note?.trim() || undefined,
    referenceNumber: input.referenceNumber?.trim() || undefined,
    allocationTarget: input.allocationTarget,
    allocationSplits: input.allocationSplits,
    createdAt:       now,
    updatedAt:       now,
  };
  all[doc.id] = doc;
  saveAll(all);
  return doc;
}

/**
 * Vorhandenes Dokument bearbeiten.
 * year/month werden aus getEffectiveDate(deliveryDate ?? date) neu berechnet.
 */
export function updateDocument(
  id: string,
  changes: Partial<Pick<SupplierDocument,
    | 'supplier' | 'documentType' | 'date' | 'deliveryDate' | 'category'
    | 'amount' | 'accountNumber' | 'note' | 'referenceNumber'
    | 'linkedDocumentId' | 'matchStatus'
    | 'allocationTarget' | 'allocationSplits'
  >>,
): SupplierDocument | null {
  const all = loadAll();
  const doc = all[id];
  if (!doc) return null;

  const now = new Date().toISOString();
  const newDate         = changes.date         ?? doc.date;
  const newDeliveryDate = 'deliveryDate' in changes
    ? (changes.deliveryDate?.trim() || undefined)
    : doc.deliveryDate;
  const eff = newDeliveryDate || newDate;
  const d   = new Date(eff);

  const updated: SupplierDocument = {
    ...doc,
    ...changes,
    deliveryDate:    newDeliveryDate,
    year:            d.getFullYear(),
    month:           d.getMonth() + 1,
    accountNumber:   changes.accountNumber !== undefined
                     ? (changes.accountNumber.trim() || undefined)
                     : doc.accountNumber,
    note:            changes.note !== undefined
                     ? (changes.note.trim() || undefined)
                     : doc.note,
    referenceNumber: changes.referenceNumber !== undefined
                     ? (changes.referenceNumber.trim() || undefined)
                     : doc.referenceNumber,
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
 *
 * Duplikat-Prävention:
 *   Lieferscheine mit matchStatus === 'linked' (= verknüpft mit einer Rechnung)
 *   werden aus der Kostensumme AUSGESCHLOSSEN.
 *   Die zugehörige Rechnung zählt stattdessen – so entsteht keine Doppelzählung.
 *
 * documents[] enthält ALLE Dokumente (inkl. ausgeschlossener) für die UI-Darstellung.
 */
export function getMonthSummary(year: number, month: number): SupplierMonthSummary {
  const docs = loadDocumentsForMonth(year, month);

  // Ausschluss: Lieferscheine die bereits mit einer Rechnung verknüpft sind
  const countable = docs.filter(d =>
    !(d.documentType === 'delivery_note' && d.matchStatus === 'linked'),
  );

  const foodCost     = countable.filter(d => d.category === 'food')    .reduce((s, d) => s + d.amount, 0);
  const beverageCost = countable.filter(d => d.category === 'beverage').reduce((s, d) => s + d.amount, 0);
  const otherCost    = countable.filter(d => d.category === 'other')   .reduce((s, d) => s + d.amount, 0);

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

// ─── Duplikat-Prävention: Matching-Logik ─────────────────────────────────────

/**
 * Ein möglicher Match-Kandidat für ein Dokument.
 */
export interface MatchCandidate {
  /** Das potenzielle Gegenstück */
  document: SupplierDocument;
  /** Matching-Score 0–100 (höher = besser) */
  score: number;
  /** Konkrete Gründe für den Score */
  reasons: string[];
  /** Betragsdifferenz in CHF */
  amountDiff: number;
  /** Anzahl Tage zwischen den Dokumentdaten */
  daysDiff: number;
}

/**
 * Findet potenzielle Gegenstücke für ein Dokument (Lieferschein → Rechnung oder umgekehrt).
 *
 * Matching-Signale (Gewichtung):
 *   40 Pkt  – Gleicher Lieferant (zwingend, ohne Lieferant kein Match)
 *   30 Pkt  – Gleiches Datum oder ±1 Tag
 *   20 Pkt  – Datum ±2–7 Tage
 *   10 Pkt  – Datum ±8–30 Tage
 *   25 Pkt  – Identischer Betrag (< 0.01 CHF Differenz)
 *   15 Pkt  – Betrag ±2% Toleranz
 *    8 Pkt  – Betrag ±5% Toleranz
 *   10 Pkt  – Gleiche Kategorie
 *    5 Pkt  – Gleiche Referenznummer (wenn beide gesetzt)
 *
 * Schwellwert: Score ≥ 50 (= gleicher Lieferant + ähnliche Summe oder Datum)
 */
export function findMatchCandidates(
  doc: SupplierDocument,
  allDocs?: SupplierDocument[],
): MatchCandidate[] {
  const store = allDocs ?? loadDocuments();

  // Nur das Gegenstück-Typ suchen: invoice ↔ delivery_note
  const targetType = doc.documentType === 'invoice' ? 'delivery_note' : 'invoice';

  return store
    .filter(d =>
      d.id !== doc.id &&
      d.documentType === targetType &&
      d.matchStatus !== 'linked',   // bereits verknüpfte Dokumente ignorieren
    )
    .map(candidate => {
      let score = 0;
      const reasons: string[] = [];

      // Lieferant (Pflichtbedingung)
      const sameSupplier = candidate.supplier.toLowerCase() === doc.supplier.toLowerCase();
      if (!sameSupplier) return null; // kein Match ohne gleichen Lieferanten
      score += 40;
      reasons.push('Gleicher Lieferant');

      // Datumsnähe (Belegdatum des Kandidaten vs. effektives Datum des aktuellen Dokuments)
      const docDate       = new Date(doc.date).getTime();
      const candidateDate = new Date(candidate.date).getTime();
      const daysDiff      = Math.abs(docDate - candidateDate) / 86_400_000;
      const amountDiff    = Math.abs(candidate.amount - doc.amount);
      const amountPct     = doc.amount > 0 ? amountDiff / doc.amount : 1;

      if (daysDiff <= 1)       { score += 30; reasons.push('Datum identisch / ±1 Tag'); }
      else if (daysDiff <= 7)  { score += 20; reasons.push(`Datum ${Math.round(daysDiff)} Tage Abstand`); }
      else if (daysDiff <= 30) { score += 10; reasons.push(`Datum ${Math.round(daysDiff)} Tage Abstand`); }
      else                     { score -= 10; } // zu weit auseinander

      // Betragsähnlichkeit
      if (amountDiff < 0.01)       { score += 25; reasons.push('Betrag identisch'); }
      else if (amountPct <= 0.02)  { score += 15; reasons.push(`Betrag sehr ähnlich (±${amountDiff.toFixed(2)} CHF)`); }
      else if (amountPct <= 0.05)  { score +=  8; reasons.push(`Betrag ähnlich (±${amountDiff.toFixed(2)} CHF)`); }

      // Kategorie
      if (candidate.category === doc.category) { score += 10; reasons.push('Gleiche Kategorie'); }

      // Referenznummer (Bonus)
      if (
        candidate.referenceNumber && doc.referenceNumber &&
        candidate.referenceNumber.trim().toLowerCase() === doc.referenceNumber.trim().toLowerCase()
      ) {
        score += 5;
        reasons.push(`Referenz «${candidate.referenceNumber}» übereinstimmend`);
      }

      return { document: candidate, score, reasons, amountDiff, daysDiff } satisfies MatchCandidate;
    })
    .filter((c): c is MatchCandidate => c !== null && c.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // Top 5 Kandidaten
}

/**
 * Verknüpft zwei Dokumente (Lieferschein + Rechnung) miteinander.
 *
 * Regel:
 *   - Beide Dokumente erhalten matchStatus = 'linked' und je linkedDocumentId des anderen.
 *   - Der Lieferschein wird aus den Monatssummen ausgeschlossen (nur Rechnung zählt).
 */
export function linkDocuments(idA: string, idB: string): void {
  const all  = loadAll();
  const docA = all[idA];
  const docB = all[idB];
  if (!docA || !docB) return;

  const now = new Date().toISOString();
  all[idA] = { ...docA, linkedDocumentId: idB, matchStatus: 'linked', updatedAt: now };
  all[idB] = { ...docB, linkedDocumentId: idA, matchStatus: 'linked', updatedAt: now };
  saveAll(all);
}

/**
 * Hebt die Verknüpfung zwischen zwei Dokumenten wieder auf.
 * Beide Dokumente werden auf matchStatus = undefined und linkedDocumentId = undefined gesetzt.
 */
export function unlinkDocuments(idA: string): void {
  const all  = loadAll();
  const docA = all[idA];
  if (!docA) return;

  const now = new Date().toISOString();
  const idB = docA.linkedDocumentId;

  all[idA] = { ...docA, linkedDocumentId: undefined, matchStatus: undefined, updatedAt: now };
  if (idB && all[idB]) {
    all[idB] = { ...all[idB], linkedDocumentId: undefined, matchStatus: undefined, updatedAt: now };
  }
  saveAll(all);
}

/**
 * Markiert ein Dokument als "vorgeschlagener Match" (suggested) – noch nicht bestätigt.
 * Kann automatisch beim Speichern einer neuen Rechnung gesetzt werden,
 * wenn ein Kandidat gefunden wird.
 */
export function markSuggested(docId: string, candidateId: string): void {
  const all = loadAll();
  const doc = all[docId];
  if (!doc || doc.matchStatus === 'linked') return;
  const now = new Date().toISOString();
  all[docId] = { ...doc, linkedDocumentId: candidateId, matchStatus: 'suggested', updatedAt: now };
  saveAll(all);
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
  const summaries  = getSupplierCostSummaries(year, month);
  const mappings   = loadSupplierMappings();
  const accounting = loadMonth(year, month);

  const accountAmounts = new Map<string, number>();
  for (const cat of accounting.expenseCategories) {
    const id = cat.categoryId ?? '';
    if (/^\d{3,5}$/.test(id)) {
      accountAmounts.set(id, (accountAmounts.get(id) ?? 0) + (cat.amount ?? 0));
    }
    const humanMap: Record<string, string> = {
      wareneinsatz_kueche: '4400', warenaufwand_kueche: '4400', food_cost: '4400',
      wareneinsatz_bar: '4100', wareneinsatz_getraenke: '4100', beverage_cost: '4100',
      wareneinsatz_diverses: '4300', warenaufwand_diverses: '4300',
    };
    if (humanMap[id]) {
      const key = humanMap[id];
      accountAmounts.set(key, (accountAmounts.get(key) ?? 0) + (cat.amount ?? 0));
    }
  }

  return summaries.map(s => {
    const mapping = mappings.find(m => m.supplier === s.supplier);
    if (!mapping) {
      return {
        supplier: s.supplier, month: s.month, year: s.year,
        operationalTotal: s.totalCost,
        operationalFoodCost: s.foodCost,
        operationalBeverageCost: s.beverageCost,
        operationalOtherCost: s.otherCost,
        accountingTotal: undefined, diff: undefined, diffPct: undefined,
        hasAccountingData: false,
      };
    }
    const pct      = (mapping.allocationPct ?? 100) / 100;
    const rawAcc   = accountAmounts.get(mapping.accountId) ?? 0;
    const accTotal = rawAcc * pct;
    const has      = accountAmounts.has(mapping.accountId);
    const diff     = has ? s.totalCost - accTotal : undefined;
    return {
      supplier: s.supplier, month: s.month, year: s.year,
      operationalTotal: s.totalCost,
      operationalFoodCost: s.foodCost,
      operationalBeverageCost: s.beverageCost,
      operationalOtherCost: s.otherCost,
      accountingTotal:  has ? accTotal : undefined,
      diff,
      diffPct: has && accTotal !== 0 ? (diff! / Math.abs(accTotal)) * 100 : undefined,
      hasAccountingData: has,
    };
  });
}

// ─── Lieferanten-Stammdaten ───────────────────────────────────────────────────

/**
 * Alle Lieferanten-Stammdaten laden.
 */
export function loadSupplierMasters(): SupplierMaster[] {
  try {
    const raw = localStorage.getItem(SUPPLIER_MASTER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSupplierMasters(masters: SupplierMaster[]): void {
  localStorage.setItem(SUPPLIER_MASTER_KEY, JSON.stringify(masters));
}

/**
 * Einen Lieferanten-Stammdatensatz anlegen oder aktualisieren (upsert nach id).
 */
export function upsertSupplierMaster(master: Omit<SupplierMaster, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SupplierMaster {
  const all  = loadSupplierMasters();
  const now  = new Date().toISOString();
  const existing = master.id ? all.find(m => m.id === master.id) : undefined;
  const result: SupplierMaster = {
    id:        existing?.id ?? uuidv4(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    isActive:  master.isActive ?? true,
    name:      master.name.trim(),
    defaultCategory:      master.defaultCategory,
    defaultAccountNumber: master.defaultAccountNumber?.trim() || undefined,
    note:                 master.note?.trim() || undefined,
  };
  const updated = all.filter(m => m.id !== result.id);
  updated.push(result);
  saveSupplierMasters(updated);
  return result;
}

/**
 * Einen Lieferanten-Stammdatensatz löschen.
 */
export function deleteSupplierMaster(id: string): void {
  saveSupplierMasters(loadSupplierMasters().filter(m => m.id !== id));
}

/**
 * Lieferanten-Stammdaten nach Name suchen.
 */
export function findSupplierMasterByName(name: string): SupplierMaster | undefined {
  return loadSupplierMasters().find(m =>
    m.name.toLowerCase() === name.toLowerCase(),
  );
}

// ─── Supplier → Account Mapping ───────────────────────────────────────────────

export function loadSupplierMappings(): AccountToSupplierMapping[] {
  try {
    const raw = localStorage.getItem(MAPPING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveSupplierMappings(mappings: AccountToSupplierMapping[]): void {
  localStorage.setItem(MAPPING_KEY, JSON.stringify(mappings));
}

export function upsertSupplierMapping(mapping: AccountToSupplierMapping): void {
  const all = loadSupplierMappings().filter(m => m.supplier !== mapping.supplier);
  all.push(mapping);
  saveSupplierMappings(all);
}

export function deleteSupplierMapping(supplier: string): void {
  saveSupplierMappings(loadSupplierMappings().filter(m => m.supplier !== supplier));
}

/**
 * Alle Kontonummern aus expenseCategories eines Monats (für Autocomplete).
 */
export function getAccountingAccountsForMonth(year: number, month: number): string[] {
  const rec = loadMonth(year, month);
  return [...new Set(
    rec.expenseCategories
      .map(c => c.categoryId ?? '')
      .filter(id => /^\d{3,5}$/.test(id))
  )].sort();
}

// ─── Lunch-WES Analyse ────────────────────────────────────────────────────────

/**
 * Effektiver Anteil eines Dokuments für einen gegebenen Kostenpool.
 *
 * Wenn `allocationSplits` gesetzt → prozentualer Anteil des Pools.
 * Wenn `allocationTarget` gesetzt → 100% wenn Target stimmt, sonst 0.
 * Wenn nichts gesetzt → 0.
 */
export function getDocumentAllocationAmount(
  doc: SupplierDocument,
  target: CostAllocationTarget,
): number {
  if (doc.allocationSplits && doc.allocationSplits.length > 0) {
    const split = doc.allocationSplits.find(s => s.target === target);
    return split ? (doc.amount * split.pct) / 100 : 0;
  }
  if (doc.allocationTarget === target) return doc.amount;
  return 0;
}

/**
 * Gibt die monatliche Ist-WES-Summe pro Kostenpool zurück.
 * Schliesst verknüpfte Lieferscheine aus (nur Rechnungen zählen wenn linked).
 */
export interface AllocationTotals {
  lunch_basic: number;
  lunch_premium: number;
  lunch_total: number;
  a_la_carte: number;
  pizza: number;
  dessert: number;
  kinder: number;
  kueche_allgemein: number;
  beverage: number;
  unassigned: number;
}

export function getAllocationTotals(year: number, month: number): AllocationTotals {
  const docs = loadDocumentsForMonth(year, month).filter(
    d => !(d.matchStatus === 'linked' && d.documentType === 'delivery_note'),
  );

  const totals: AllocationTotals = {
    lunch_basic: 0, lunch_premium: 0, lunch_total: 0,
    a_la_carte: 0, pizza: 0, dessert: 0, kinder: 0,
    kueche_allgemein: 0, beverage: 0, unassigned: 0,
  };

  for (const doc of docs) {
    const targets: CostAllocationTarget[] = [
      'lunch_basic', 'lunch_premium', 'a_la_carte', 'pizza',
      'dessert', 'kinder', 'kueche_allgemein', 'beverage', 'unassigned',
    ];
    for (const t of targets) {
      (totals as Record<string, number>)[t] += getDocumentAllocationAmount(doc, t);
    }
  }

  totals.lunch_total = totals.lunch_basic + totals.lunch_premium;
  return totals;
}
