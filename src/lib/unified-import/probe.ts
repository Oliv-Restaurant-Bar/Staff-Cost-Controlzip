/**
 * probe.ts — the only IO of the unified import classifier: reads just enough of a file to classify it.
 * ====================================================================================================
 * Everything is read with the SAME readers the existing imports use (`readFirstSheetRows`,
 * `extractGnPdfTextItems`), so a file is judged on what the existing flow will later see.
 * The result (`FileProbe`) is handed to the pure `classifyProbe`.
 */

import { readFirstSheetRows } from '@/lib/tagesdaten-auto-import';
import { reconstructGnPdfLines } from '@/lib/gn-pdf-lines';
import { stripBom } from '@/lib/reservation-import-parser';
import { SUPPORTED_EXTENSIONS } from './handlers';
import type { FileProbe, ProbeContent } from './types';

/** Larger files are not read for classification (the existing flows are not built for them either). */
export const MAX_PROBE_BYTES = 25 * 1024 * 1024;

/** First bytes of an old binary Excel (OLE2 compound file) — ExcelJS cannot read these. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
}

async function isLegacyXls(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return OLE2_MAGIC.every((b, i) => head[i] === b);
}

async function readLegacySheetRows(file: File): Promise<string[][]> {
  const XLSX = await import('xlsx'); // lazy: same library the Mirus parser uses
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
  return rows.map(r => r.map(c => String(c ?? '')));
}

export async function readFileProbe(file: File): Promise<FileProbe> {
  const ext = extensionOf(file.name);
  const base = { name: file.name, ext, size: file.size };
  const done = (content: ProbeContent): FileProbe => ({ ...base, content });

  if (!SUPPORTED_EXTENSIONS.includes(ext)) return done({ kind: 'none' });
  if (file.size > MAX_PROBE_BYTES) return done({ kind: 'too-large' });

  try {
    if (ext === 'xls' || ext === 'xlsx') {
      // Many «.xlsx» exports from old tools are really binary .xls — check the content, not the name.
      if (ext === 'xls' || await isLegacyXls(file)) {
        // Binary .xls: only the Mirus importer reads it (SheetJS). Read it the same way so the classifier can
        // recognise a Mirus export; for every other type the classifier reports «legacy .xls».
        try { return done({ kind: 'sheet', rows: await readLegacySheetRows(file), legacy: true }); }
        catch { return done({ kind: 'legacy-xls' }); }
      }
      return done({ kind: 'sheet', rows: await readFirstSheetRows(file) });
    }
    if (ext === 'pdf') {
      // Lazy: pdf.js is heavy and only needed when a PDF is dropped.
      const { extractGnPdfTextItems } = await import('@/lib/gn-pdf-text');
      const extract = await extractGnPdfTextItems(file);
      return done({
        kind: 'pdf',
        lines: reconstructGnPdfLines(extract.pages),
        hasTextLayer: extract.hasTextLayer,
      });
    }
    return done({ kind: 'text', text: stripBom(await file.text()) });
  } catch (e) {
    return done({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
