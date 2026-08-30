/**
 * Isolated importer for MIRUS Kontrollliste (`report_test`) workbooks.
 * It deliberately does not share any of the existing Ist-hours import paths.
 */
import * as XLSX from 'xlsx';

export type ControlListDepartment = 'kueche' | 'service' | 'geschaeftsleitung';

export interface ShiftWindow {
  start: number;
  end: number;
}

export interface ControlListDay {
  date: string;
  rawTimeRecording: string;
  timeRecordingGross: number;
  timeRecordingTotal: number;
  effectiveWindows: ShiftWindow[];
  effectiveGross: number;
  netHours: number;
  difference: number;
  status: string;
  /** True when the corrected net hours or a late/end-after-midnight window requires attention. */
  danger: boolean;
}

export interface ControlListEmployee {
  name: string;
  inIst: boolean;
  days: ControlListDay[];
}

export interface ControlListDocument {
  period: string;
  tenant: string;
  employees: ControlListEmployee[];
}

export class ControlListParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlListParseError';
  }
}

const COLUMNS = {
  date: 3, rawTimeRecording: 6, timeRecordingGross: 9, timeRecordingTotal: 12,
  effectiveWindows: 15, effectiveGross: 18, netHours: 20, difference: 23, status: 26,
} as const;

function valueAt(sheet: XLSX.WorkSheet, row: number, column: number, merges: XLSX.Range[]): unknown {
  let anchorRow = row;
  let anchorCol = column;
  for (const range of merges) {
    if (row >= range.s.r && row <= range.e.r && column >= range.s.c && column <= range.e.c) {
      anchorRow = range.s.r;
      anchorCol = range.s.c;
      break;
    }
  }
  return sheet[XLSX.utils.encode_cell({ r: anchorRow, c: anchorCol })]?.v;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Excel's 1900 serial calendar, intentionally independent of workbook date flags. */
export function excelSerialToIsoDate(serial: number): string {
  if (!Number.isFinite(serial)) throw new ControlListParseError('Ungültiges Excel-Datum in Spalte 3.');
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** Parses corrected effective windows and applies the prescribed 30-minute bar rule. */
export function parseEffectiveWindows(value: unknown): ShiftWindow[] {
  const segments: ShiftWindow[] = [];
  const matcher = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
  const source = text(value);
  for (const match of source.matchAll(matcher)) {
    const start = Number(match[1]) + Number(match[2]) / 60;
    let end = Number(match[3]) + Number(match[4]) / 60;
    if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 23 || Number(match[4]) > 59) continue;
    if (end <= start) end += 24;
    segments.push({ start, end });
  }
  segments.sort((a, b) => a.start - b.start);
  const bars: ShiftWindow[] = [];
  for (const segment of segments) {
    const previous = bars[bars.length - 1];
    if (previous && segment.start - previous.end <= 0.5) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      bars.push({ ...segment });
    }
  }
  return bars;
}

export function parseControlListWorkbook(workbook: XLSX.WorkBook): ControlListDocument {
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== 'report_test') {
    throw new ControlListParseError('Die Datei muss genau ein Blatt namens „report_test“ enthalten.');
  }
  const sheet = workbook.Sheets.report_test;
  if (!sheet?.['!ref']) throw new ControlListParseError('Das Blatt „report_test“ ist leer.');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.c - range.s.c + 1 !== 30) {
    throw new ControlListParseError('Das Blatt „report_test“ muss genau 30 Spalten enthalten.');
  }
  const merges = sheet['!merges'] ?? [];
  const cell = (row: number, column: number) => valueAt(sheet, row, column, merges);
  const employees: ControlListEmployee[] = [];
  let employee: ControlListEmployee | undefined;
  for (let row = 7; row <= range.e.r; row++) {
    const name = text(cell(row, 2));
    const dateValue = cell(row, COLUMNS.date);
    if (name && !text(dateValue)) {
      if (name.toLowerCase() === 'total') break;
      employee = { name, inIst: false, days: [] };
      employees.push(employee);
      continue;
    }
    if (!employee || !Number.isFinite(numeric(dateValue)) || numeric(dateValue) <= 0) continue;
    const effectiveWindows = parseEffectiveWindows(cell(row, COLUMNS.effectiveWindows));
    const netHours = numeric(cell(row, COLUMNS.netHours));
    const day: ControlListDay = {
      date: excelSerialToIsoDate(numeric(dateValue)),
      rawTimeRecording: text(cell(row, COLUMNS.rawTimeRecording)),
      timeRecordingGross: numeric(cell(row, COLUMNS.timeRecordingGross)),
      timeRecordingTotal: numeric(cell(row, COLUMNS.timeRecordingTotal)),
      effectiveWindows,
      effectiveGross: numeric(cell(row, COLUMNS.effectiveGross)),
      netHours,
      difference: numeric(cell(row, COLUMNS.difference)),
      status: text(cell(row, COLUMNS.status)),
      danger: netHours >= 9 || effectiveWindows.some(window => window.end >= 23 + 50 / 60),
    };
    employee.inIst ||= day.timeRecordingTotal > 0;
    employee.days.push(day);
  }
  return { period: text(cell(0, 2)), tenant: text(cell(1, 2)), employees };
}

/** Reads BIFF/OLE2 files with numeric serial dates (never `cellDates:true`). */
export function parseControlListXls(data: ArrayBuffer | Uint8Array): ControlListDocument {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ole2Signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < ole2Signature.length || ole2Signature.some((value, index) => bytes[index] !== value)) {
    throw new ControlListParseError('Bitte eine echte MIRUS-.xls-Datei (BIFF/OLE2) auswählen.');
  }
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
  return parseControlListWorkbook(workbook);
}