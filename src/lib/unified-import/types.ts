/**
 * types.ts — shared types of the unified import (one drop zone, many existing imports).
 * =====================================================================================
 * The unified import only RECOGNISES a file and HANDS it to the existing import flow.
 * It never parses for saving and never saves. NO React / supabase / DOM here.
 */

import type { GnPdfLine } from '@/lib/gn-pdf-lines';
import type { TagesdatenTyp } from '@/lib/tagesdaten-auto-import';

/** One id per existing import flow a dropped file can be handed to. */
export type UnifiedImportTypeId =
  | 'tagesdaten'               // daily data xlsx (revenue, guests, avg. receipt, …) — sub-type in `tagesdatenTyp`
  | 'zbericht-pdf'             // Gastronovi Z-Bericht PDF
  | 'gn-kpi-pdf'               // Gastronovi KPI PDFs (Anzahl Personen, Umsatz pro Person, Durchschnittsbon)
  | 'verkaufsdaten'            // Food/Beverage totals export (tab-separated)
  | 'sales-upload'             // product sales export (tab-separated, per product)
  | 'foratable-reservationen'  // Foratable reservations CSV
  | 'foratable-gaeste'         // Foratable guest export CSV
  | 'kontoblatt'               // Sage account sheets (csv/pdf/xlsx) — manual pick only
  | 'annual-revenue'           // prior-year revenue xlsx — manual pick only
  | 'annual-cost'              // prior-year costs (Sage account sheet xlsx/pdf) — manual pick only
  | 'annual-personnel-cost'    // prior-year personnel costs xlsx — manual pick only
  | 'vj-daily'                 // prior-year daily revenue xlsx — manual pick only
  | 'ist-stunden'              // Mirus «Tägliche Stunden» xls/xlsx → Import-Center dialog (asks Ersetzen/Aktualisieren first)
  | 'mirus-schedule'           // Mirus «Tägliche Stunden» xls/xlsx → schedule screen, Ist view (reconcile plan, backup, undo)
  | 'ist-stunden-csv'          // actual hours csv — manual pick, navigate only
  | 'rezensionen'              // Lunchgate/Google feedback CSV (weekly source «Rezensionen»)
  | 'umsatzkategorien';        // «Umsatzanalyse Kategorien» xlsx (weekly source)

/** Why a file got its status. Codes only; the UI maps them to German texts. */
export type ReasonCode =
  | 'unsupported-extension'
  | 'legacy-xls'                 // old binary .xls, only .xlsx can be read
  | 'file-too-large'
  | 'read-error'
  | 'empty-file'
  | 'pdf-no-text-layer'          // scanned PDF — candidate for the later AI/OCR fallback (Feature 3)
  | 'pdf-kind-from-title'
  | 'pdf-kind-from-body-only'    // kind found only in the body text, title says nothing
  | 'pdf-kind-unknown'
  | 'name-matches-content'
  | 'name-contradicts-content'   // client's file-name keyword and the content point to different types
  | 'content-only'
  | 'amounts-without-chf-marker' // revenue guessed from plain numbers only
  | 'label-not-exact'            // «Gesamtanzahl …», «Zwischentotal …» instead of exact «Gesamt»
  | 'average-ambiguous'          // «Durchschnitt»: per receipt or per person
  | 'no-date-columns'
  | 'header-matches-one-foratable-type'
  | 'header-matches-both-foratable-types'
  | 'tab-file-totals-and-products' // fits both sales-data imports
  | 'tab-file-totals-only'
  | 'tab-file-products'
  | 'mirus-title-found'          // «Tägliche Stunden» title row: Mirus hours export
  | 'category-sheet-found'       // «> Kategorie» rows with day columns
  | 'feedback-csv-found'         // Lunchgate/Google feedback CSV header
  | 'kpi-csv-found'              // Gastronovi KPI CSV (Anzahl Personen / Umsatz pro Person / Durchschnittsbon)
  | 'nothing-recognised';

/**
 * recognised  → one clear type, pre-selected (the user still confirms in the existing preview)
 * confirm     → a suggestion exists but the evidence is weak or contradictory: user must pick
 * unknown     → nothing recognised; user may pick a type manually
 * unsupported → cannot be read at all (extension / legacy .xls / too large)
 */
export type ClassifyStatus = 'recognised' | 'confirm' | 'unknown' | 'unsupported';

export interface ClassifyResult {
  status: ClassifyStatus;
  /** Best guess (null for unknown/unsupported). For `confirm` it is only the pre-selection. */
  typeId: UnifiedImportTypeId | null;
  /** Only for typeId === 'tagesdaten': the client's own sub-type suggestion (null = none). */
  tagesdatenTyp: TagesdatenTyp | null;
  /** Other types the user may pick (already limited to types that accept this extension). */
  alternatives: UnifiedImportTypeId[];
  /** Sub-type alternatives for tagesdaten (e.g. «Durchschnitt» is per receipt OR per person). */
  tagesdatenAlternatives: TagesdatenTyp[];
  reasons: ReasonCode[];
  /**
   * True when the file is readable but nothing was recognised and an AI/OCR fallback could try
   * (Feature 3). Today no fallback is registered, so this only controls the wording.
   */
  fallbackEligible: boolean;
  /** Facts the hand-over needs (e.g. the month of a Mirus file, so the schedule opens on it). */
  /** `kpiKind`: which Gastronovi KPI report a KPI file is (decides which weekly source it covers). */
  meta?: { mirusMonth?: string; kpiKind?: 'anzahl_personen' | 'umsatz_pro_person' | 'durchschnittsbon' };
}

/** What was read from a file; produced by `readFileProbe`, consumed by the pure `classifyProbe`. */
export type ProbeContent =
  /** `legacy`: read from a binary .xls (only Mirus files are accepted from it; every other flow needs .xlsx). */
  | { kind: 'sheet'; rows: string[][]; legacy?: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; lines: GnPdfLine[]; hasTextLayer: boolean }
  | { kind: 'legacy-xls' }
  | { kind: 'too-large' }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

export interface FileProbe {
  name: string;
  /** lower-case, without dot */
  ext: string;
  size: number;
  content: ProbeContent;
}

/** Optional hook for Feature 3: receives files nothing recognised; returns a classification or null. */
export type UnifiedImportFallback = (probe: FileProbe) => Promise<ClassifyResult | null>;
