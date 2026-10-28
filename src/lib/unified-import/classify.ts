/**
 * classify.ts — pure classification of a probed file (no React / supabase / DOM / IO).
 * ====================================================================================
 * Built ON TOP of the client's own detectors. Their answer is always the suggestion; this layer only
 * decides how sure we are:
 *   - the client's conventions (file-name keywords, «P.» suffix, plain or «CHF» amounts, PDF titles)
 *     keep working unchanged and are pinned by client-conventions.contract.test.ts
 *   - weak or contradictory evidence → status 'confirm' (user picks), never a silent guess
 *   - nothing here saves anything; the existing flow still shows its preview and asks for confirmation
 */

import {
  detectTagesdatenTyp, suggestTypFromFileName, suggestTagesdatenTyp, istDurchschnittMehrdeutig,
  analyzeWertemuster, isoFromDayMonth, type TagesdatenTyp,
} from '@/lib/tagesdaten-auto-import';
import { detectGnPdfReportKind, type GnPdfLine, type GnPdfReportKind } from '@/lib/gn-pdf-lines';
import { parseVerkaufsdatenFile } from '@/lib/verkaufsdaten-import';
import { parseReservationsCsv } from '@/lib/reservation-import-parser';
import { parseForatableGuestsCsv } from '@/lib/foratable-guest-import-parser';
import { isDateColumn } from '@/lib/gastronovi-csv-parser';
import { parseFeedbackCsv } from '@/lib/feedback-import';
import { parseGnKpiCsv } from '@/lib/gn-kpi-csv-parser';
import { handlersForExtension, SUPPORTED_EXTENSIONS } from './handlers';
import type {
  ClassifyResult, FileProbe, ReasonCode, UnifiedImportTypeId,
} from './types';

// ── result builders ──────────────────────────────────────────────────────────

const base = (): ClassifyResult => ({
  status: 'unknown', typeId: null, tagesdatenTyp: null, alternatives: [],
  tagesdatenAlternatives: [], reasons: [], fallbackEligible: false,
});

/** Types the user may pick by hand for this extension (the detected one excluded). */
function pickList(ext: string, exclude?: UnifiedImportTypeId | null): UnifiedImportTypeId[] {
  return handlersForExtension(ext).map(h => h.id).filter(id => id !== exclude);
}

const unsupported = (reason: ReasonCode): ClassifyResult =>
  ({ ...base(), status: 'unsupported', reasons: [reason] });

const unknown = (ext: string, reasons: ReasonCode[], fallbackEligible = true): ClassifyResult =>
  ({ ...base(), status: 'unknown', alternatives: pickList(ext), reasons, fallbackEligible });

// ── helpers on the sheet rows ────────────────────────────────────────────────

const norm = (s: string): string =>
  String(s ?? '').replace(/ /gu, ' ').trim().toLowerCase();

/** Labels the client's revenue files really use; anything else (substring hits) is weak evidence. */
const EXACT_REVENUE_LABEL = /^(gesamt|total|food|speisen|beverage|getränke|getraenke|take[\s-]?away|ausser haus|außer haus)(\s*[-–:].*)?$/u;

function hasExactRevenueLabel(rows: string[][]): boolean {
  return rows.some(r => EXACT_REVENUE_LABEL.test(norm(r?.[0] ?? '')));
}

/** At least one header cell that is a real «TT.MM.» calendar day (year only needed for validation). */
function hasDayColumns(rows: string[][]): boolean {
  const header = rows[0] ?? [];
  return header.some(h => isoFromDayMonth(String(h ?? ''), 2024) !== null);
}

const CHF_TYPES: TagesdatenTyp[] = ['umsatz', 'marketing', 'durchschnitt', 'umsatzprogast'];

// ── Mirus «Tägliche Stunden» and the weekly «Umsatzanalyse Kategorien» sheet ──

/** Mirus title row («Tägliche Stunden von TT.MM.JJJJ bis …») within the first rows — the parser's own anchor. */
function mirusTitleMonth(rows: string[][]): { found: boolean; month?: string } {
  const text = rows.slice(0, 40).map(r => (r ?? []).join(' ')).join('\n');
  if (!/t[äa]gliche\s+stunden/i.test(text)) return { found: false };
  const m = text.match(/von\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  return { found: true, month: m ? `${m[3]}-${m[2].padStart(2, '0')}` : undefined };
}

/** «> Kategorie» rows under group headers, day columns from column C: the category analysis export. */
function looksLikeCategorySheet(rows: string[][]): boolean {
  const catRows = rows.filter(r => /^>\s*\S/.test(String(r?.[0] ?? '').trim())).length;
  if (catRows < 3) return false;
  return rows.slice(0, 10).some(r => (r ?? []).slice(2).filter(c => /^\d{1,2}\.\d{1,2}\./.test(String(c ?? '').trim())).length >= 2);
}

function classifyMirusOrCategories(p: FileProbe, rows: string[][], legacy: boolean): ClassifyResult | null {
  const mirus = mirusTitleMonth(rows);
  if (mirus.found) {
    // Two existing Mirus importers exist; the user chooses (default: the schedule screen).
    return { ...base(), status: 'recognised', typeId: 'mirus-schedule',
      alternatives: pickList(p.ext, 'mirus-schedule'), reasons: ['mirus-title-found'],
      meta: mirus.month ? { mirusMonth: mirus.month } : undefined };
  }
  if (legacy) return unsupported('legacy-xls'); // every other flow needs a real .xlsx
  if (looksLikeCategorySheet(rows)) {
    return { ...base(), status: 'recognised', typeId: 'umsatzkategorien',
      alternatives: pickList(p.ext, 'umsatzkategorien'), reasons: ['category-sheet-found'] };
  }
  return null;
}

// ── xlsx: daily data ─────────────────────────────────────────────────────────

function classifySheet(p: FileProbe, rows: string[][], legacy = false): ClassifyResult {
  if (rows.length === 0) return unknown(p.ext, ['empty-file'], false);
  const special = classifyMirusOrCategories(p, rows, legacy);
  if (special) return special;

  const nameTyp = suggestTypFromFileName(p.name);
  const contentTyp = detectTagesdatenTyp(rows);
  const suggestion = suggestTagesdatenTyp(p.name, rows); // client's own combined answer
  const muster = analyzeWertemuster(rows);
  const reasons: ReasonCode[] = [];

  if (!hasDayColumns(rows)) {
    // The client's daily-data files always have «TT.MM.» day columns; without them this is another sheet type.
    return { ...unknown(p.ext, ['no-date-columns', 'nothing-recognised'], false) };
  }

  // «Durchschnitt»: per receipt or per person — the client's detector deliberately gives no answer.
  if (suggestion === null && istDurchschnittMehrdeutig(rows)) {
    return {
      ...base(), status: 'confirm', typeId: 'tagesdaten', tagesdatenTyp: null,
      tagesdatenAlternatives: ['durchschnitt', 'umsatzprogast'],
      alternatives: pickList(p.ext, 'tagesdaten'), reasons: ['average-ambiguous'],
    };
  }
  if (suggestion === null) return unknown(p.ext, ['nothing-recognised'], true);

  // Does the file name (client's keyword) agree with what the values look like?
  if (nameTyp !== null) {
    const nameSaysGuests = nameTyp === 'gaeste';
    const valuesContradict =
      (nameSaysGuests && muster === 'chf') ||
      (!nameSaysGuests && CHF_TYPES.includes(nameTyp) && muster === 'anzahl') ||
      (contentTyp !== null && contentTyp !== nameTyp && !(nameSaysGuests && contentTyp === 'umsatz' && muster !== 'chf'));
    if (valuesContradict) {
      return {
        ...base(), status: 'confirm', typeId: 'tagesdaten', tagesdatenTyp: suggestion,
        tagesdatenAlternatives: Array.from(new Set([suggestion, contentTyp].filter((t): t is TagesdatenTyp => t !== null))),
        alternatives: pickList(p.ext, 'tagesdaten'), reasons: ['name-contradicts-content'],
      };
    }
    reasons.push('name-matches-content');
  } else {
    reasons.push('content-only');
    // Revenue found only through plain numbers that look like head counts, or through labels that merely
    // CONTAIN «gesamt»/«total»: weak → confirm.
    if (suggestion === 'umsatz') {
      if (muster === 'anzahl') {
        return weakTagesdaten(p, suggestion, ['amounts-without-chf-marker']);
      }
      if (!hasExactRevenueLabel(rows)) {
        return weakTagesdaten(p, suggestion, ['label-not-exact']);
      }
    }
  }

  return {
    ...base(), status: 'recognised', typeId: 'tagesdaten', tagesdatenTyp: suggestion,
    alternatives: pickList(p.ext, 'tagesdaten'), reasons,
  };
}

function weakTagesdaten(p: FileProbe, suggestion: TagesdatenTyp, reasons: ReasonCode[]): ClassifyResult {
  return {
    ...base(), status: 'confirm', typeId: 'tagesdaten', tagesdatenTyp: suggestion,
    tagesdatenAlternatives: ['gaeste', suggestion],
    alternatives: pickList(p.ext, 'tagesdaten'), reasons,
  };
}

// ── csv / txt / tsv ──────────────────────────────────────────────────────────

/** Header with at least one «TT.MM.» day column in a tab-separated export. */
function tabHeaderHasDays(text: string): boolean {
  const first = text.split(/\r?\n/).find(l => l.trim() !== '') ?? '';
  const cells = first.split('\t').map(c => c.trim().replace(/^"|"$/g, '').trim());
  return cells.length >= 3 && cells.slice(2).some(c => isDateColumn(c));
}

function classifyText(p: FileProbe, text: string): ClassifyResult {
  if (text.trim() === '') return unknown(p.ext, ['empty-file'], false);

  // Feedback CSV (Lunchgate/Google): the importer's own parser decides, so recognition equals what it accepts.
  if (p.ext === 'csv' && /publish date/i.test(text.slice(0, 2000))) {
    try {
      const fb = parseFeedbackCsv(text);
      if (!fb.failureReason && fb.rows.length > 0) {
        return { ...base(), status: 'recognised', typeId: 'rezensionen',
          alternatives: pickList(p.ext, 'rezensionen'), reasons: ['feedback-csv-found'] };
      }
    } catch { /* fall through to the other CSV rules */ }
  }

  // Foratable CSVs: use the parsers' OWN header checks, so the recognition is exactly what the import accepts.
  if (p.ext === 'csv') {
    const isRes = parseReservationsCsv(p.name, text).headerOk;
    const isGuests = parseForatableGuestsCsv(p.name, text).headerOk;
    if (isRes !== isGuests) {
      const typeId: UnifiedImportTypeId = isRes ? 'foratable-reservationen' : 'foratable-gaeste';
      return { ...base(), status: 'recognised', typeId, alternatives: pickList(p.ext, typeId),
        reasons: ['header-matches-one-foratable-type'] };
    }
    if (isRes && isGuests) {
      return { ...base(), status: 'confirm', typeId: 'foratable-reservationen',
        alternatives: pickList(p.ext, 'foratable-reservationen'), reasons: ['header-matches-both-foratable-types'] };
    }
  }

  // Gastronovi KPI CSVs (Anzahl Personen / Umsatz pro Person / Durchschnittsbon): the import's own parser decides,
  // so recognition equals what the existing KPI import accepts (it rejects instead of guessing the report kind).
  if (p.ext === 'csv' && tabHeaderHasDays(text)) {
    try {
      const kpi = parseGnKpiCsv(text, p.name);
      if (!kpi.debug.failureReason && kpi.kind) {
        return { ...base(), status: 'recognised', typeId: 'gn-kpi-pdf',
          alternatives: pickList(p.ext, 'gn-kpi-pdf'), reasons: ['kpi-csv-found'], meta: { kpiKind: kpi.kind } };
      }
    } catch { /* fall through to the other rules */ }
  }

  // Tab-separated sales exports: «Gesamt - Food/Beverage» totals (Verkaufsdaten) vs per-product rows (Sales Upload).
  if (tabHeaderHasDays(text)) {
    const totals = parseVerkaufsdatenFile(text, p.name).ok;
    const dataRows = text.split(/\r?\n/).filter(l => l.trim() !== '').length - 1;
    const manyRows = dataRows > 12; // totals files have a handful of rows, product files hundreds
    if (totals && !manyRows) {
      return { ...base(), status: 'recognised', typeId: 'verkaufsdaten',
        alternatives: pickList(p.ext, 'verkaufsdaten'), reasons: ['tab-file-totals-only'] };
    }
    if (totals && manyRows) {
      // Contains the totals row AND many product rows: fits both existing imports.
      return { ...base(), status: 'confirm', typeId: 'sales-upload',
        alternatives: pickList(p.ext, 'sales-upload'), reasons: ['tab-file-totals-and-products'] };
    }
    if (manyRows) {
      return { ...base(), status: 'recognised', typeId: 'sales-upload',
        alternatives: pickList(p.ext, 'sales-upload'), reasons: ['tab-file-products'] };
    }
  }

  return unknown(p.ext, ['nothing-recognised'], true);
}

// ── pdf ──────────────────────────────────────────────────────────────────────

/** Kind judged from the TITLE line only (the client's detectors rank title above body text). */
function kindFromTitleOnly(lines: GnPdfLine[]): GnPdfReportKind {
  const first = lines[0]?.pageNumber;
  const page = lines.filter(l => l.pageNumber === first);
  if (page.length === 0) return 'unbekannt';
  const top = page.reduce((a, l) => (l.y > a.y ? l : a), page[0]);
  return detectGnPdfReportKind([{ ...top }]).kind;
}

function classifyPdf(p: FileProbe, lines: GnPdfLine[], hasTextLayer: boolean): ClassifyResult {
  if (!hasTextLayer) return unknown(p.ext, ['pdf-no-text-layer'], true);

  const kind = detectGnPdfReportKind(lines).kind; // client's answer
  if (kind === 'unbekannt') return unknown(p.ext, ['pdf-kind-unknown'], true);

  const typeId: UnifiedImportTypeId = kind === 'zbericht' ? 'zbericht-pdf' : 'gn-kpi-pdf';
  const fromTitle = kindFromTitleOnly(lines) === kind;
  return {
    ...base(), status: fromTitle ? 'recognised' : 'confirm', typeId,
    alternatives: pickList(p.ext, typeId),
    reasons: [fromTitle ? 'pdf-kind-from-title' : 'pdf-kind-from-body-only'],
    meta: kind === 'zbericht' ? undefined : { kpiKind: kind },
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

export function classifyProbe(p: FileProbe): ClassifyResult {
  if (!SUPPORTED_EXTENSIONS.includes(p.ext)) return unsupported('unsupported-extension');
  const c = p.content;
  switch (c.kind) {
    case 'none': return unsupported('unsupported-extension');
    case 'legacy-xls': return unsupported('legacy-xls');
    case 'too-large': return unsupported('file-too-large');
    case 'error': return unknown(p.ext, ['read-error'], false);
    case 'sheet': return classifySheet(p, c.rows, c.legacy === true);
    case 'text': return classifyText(p, c.text);
    case 'pdf': return classifyPdf(p, c.lines, c.hasTextLayer);
  }
}
