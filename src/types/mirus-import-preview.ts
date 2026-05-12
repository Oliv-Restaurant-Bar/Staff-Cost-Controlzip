/**
 * Mirus Import Preview — Typen
 * ============================
 * Datenstrukturen für die sichere Import-Vorschau-Pipeline.
 * KEIN Supabase-Write, KEINE Produktionsdaten — rein temporär im lokalen State.
 */

// ─── Warnung ─────────────────────────────────────────────────────────────────

export type PreviewWarningSeverity = 'error' | 'warning' | 'info';
export type PreviewWarningCategory =
  | 'name'
  | 'costCenter'
  | 'totals'
  | 'days'
  | 'hours'
  | 'quality'
  | 'merge'
  | 'meta';

export interface PreviewImportWarning {
  severity:  PreviewWarningSeverity;
  category:  PreviewWarningCategory;
  message:   string;
  employeeName?: string;
}

// ─── Tageseintrag ─────────────────────────────────────────────────────────────

export interface PreviewShift {
  from: string;
  to:   string;
  department?: string;
}

export interface PreviewDayEntry {
  date:         string | null;
  weekday:      string | null;
  shifts:       PreviewShift[];
  breakMinutes: number | null;
  totalHours:   number | null;
  absenceCode:  string | null;
  notes:        string | null;
  rawCells: {
    dateCell?:     string;
    workTimeCell?: string;
    pauseCell?:    string;
    totalCell?:    string;
    remarkCell?:   string;
  };
  confidence: 'high' | 'medium' | 'low';
}

// ─── Monatstotale ────────────────────────────────────────────────────────────

export interface PreviewTotals {
  totalHours?:          string;
  pauseTotal?:          string;
  nettoTotal?:          string;
  sollStunden?:         string;
  zeitzuschlag?:        string;
  ueberzeit?:           string;
  saldo?:               string;
  ferien?:              string;
  feiertag?:            string;
  kompensation?:        string;
  krankheit?:           string;
  calculatedTotalHours?: number;
  totalsValidated?:     boolean;
  totalsDiff?:          number;
}

// ─── Mitarbeiter ─────────────────────────────────────────────────────────────

export type PreviewImportStatus = 'ready' | 'check' | 'excluded';

export interface PreviewEmployee {
  tempId:           string;
  name:             string | null;
  department:       string | null;
  costCenter:       string | null;
  weeklyHours:      number | null;
  employmentPeriod: string | null;
  quality:          number;
  importSelected:   boolean;
  importStatus:     PreviewImportStatus;
  warnings:         PreviewImportWarning[];
  days:             PreviewDayEntry[];
  totals:           PreviewTotals;
  rawSource: {
    sheetName:       string;
    blockStartRow:   number;
    blockEndRow:     number | null;
    mergedFromCount: number;
    mergedBlockRows: [number, number][];
  };
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type PreviewSessionStatus = 'preview';

export interface PreviewImportSession {
  id:               string;
  sourceFileName:   string;
  month:            number | null;
  monthName:        string | null;
  year:             number | null;
  restaurant:       string | null;
  createdAt:        string;
  employees:        PreviewEmployee[];
  globalWarnings:   PreviewImportWarning[];
  averageQuality:   number;
  totalHours:       number;
  selectedCount:    number;
  status:           PreviewSessionStatus;
}

// ─── Import Payload ───────────────────────────────────────────────────────────

export interface ImportPayloadDay {
  employeeName:     string;
  costCenter:       string | null;
  department:       string | null;
  date:             string;
  weekday:          string | null;
  shifts:           PreviewShift[];
  breakMinutes:     number | null;
  totalHours:       number | null;
  absenceCode:      string | null;
  notes:            string | null;
}

export interface ImportPayloadEmployee {
  name:             string;
  department:       string | null;
  costCenter:       string | null;
  weeklyHours:      number | null;
  employmentPeriod: string | null;
  totalHours:       number;
  dayCount:         number;
  days:             ImportPayloadDay[];
  totals:           PreviewTotals;
}

export interface ImportPayload {
  sourceFileName:  string;
  month:           number | null;
  year:            number | null;
  restaurant:      string | null;
  preparedAt:      string;
  employees:       ImportPayloadEmployee[];
  totalDayLines:   number;
  totalHours:      number;
  warnings:        PreviewImportWarning[];
}
