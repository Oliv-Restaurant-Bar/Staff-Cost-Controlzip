// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { readFileProbe, extensionOf } from '../probe';
import { classifyProbe } from '../classify';
import { setPending, takePending, hasPending, clearAllPending } from '../pending-files';
import { canUseHandler, IMPORT_HANDLERS } from '../handlers';

async function xlsxFile(name: string, build: (ws: ExcelJS.Worksheet) => void): Promise<File> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('S'));
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf as ArrayBuffer], name);
}

describe('readFileProbe', () => {
  it('extensionOf', () => {
    expect(extensionOf('Anzahl Oliv 07.2026.XLSX')).toBe('xlsx');
    expect(extensionOf('ohne')).toBe('');
  });

  it('flags a real binary .xls even when it is named .xlsx', async () => {
    const f = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])], 'alt.xlsx');
    expect((await readFileProbe(f)).content.kind).toBe('legacy-xls');
  });

  it('reads an .xls as a legacy sheet (only Mirus accepts it later), never as a normal sheet', async () => {
    const c = (await readFileProbe(new File([new Uint8Array([1, 2, 3])], 'alt.xls'))).content;
    expect(c.kind === 'legacy-xls' || (c.kind === 'sheet' && c.legacy === true)).toBe(true);
  });

  it('unsupported extension is not read', async () => {
    expect((await readFileProbe(new File(['x'], 'bild.png'))).content.kind).toBe('none');
  });

  it('a corrupt .xlsx becomes a read error instead of throwing', async () => {
    expect((await readFileProbe(new File(['not a zip'], 'kaputt.xlsx'))).content.kind).toBe('error');
  });

  it('text files are read and the BOM is stripped', async () => {
    const p = await readFileProbe(new File(['﻿a;b\n1;2'], 'x.csv'));
    expect(p.content).toEqual({ kind: 'text', text: 'a;b\n1;2' });
  });

  it('real Excel DATE header cells become «TT.MM.» so a file with date headers is still recognised', async () => {
    const f = await xlsxFile('Anzahl Oliv 07.2026.xlsx', ws => {
      ws.addRow(['Bezeichnung', 'Zeitraum', new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 6, 2))]);
      ws.addRow(['Gesamt', '425 P.', '200 P.', '225 P.']);
    });
    const p = await readFileProbe(f);
    expect(p.content.kind === 'sheet' && p.content.rows[0].slice(2)).toEqual(['01.07.', '02.07.']);
    expect(classifyProbe(p)).toMatchObject({ status: 'recognised', typeId: 'tagesdaten', tagesdatenTyp: 'gaeste' });
  });
});

describe('pending-files handover', () => {
  beforeEach(() => clearAllPending());

  it('stores files per type and hands them out exactly once', () => {
    const f = new File(['x'], 'a.csv');
    setPending('foratable-gaeste', [f]);
    expect(hasPending('foratable-gaeste')).toBe(true);
    expect(hasPending('foratable-reservationen')).toBe(false);
    expect(takePending('foratable-gaeste')).toEqual([f]);
    expect(takePending('foratable-gaeste')).toEqual([]);
  });

  it('an empty list stores nothing', () => {
    setPending('tagesdaten', []);
    expect(hasPending('tagesdaten')).toBe(false);
  });

  it('notifies a mounted flow through the window event', () => {
    const listener = vi.fn();
    const g = globalThis as unknown as { window?: EventTarget & { dispatchEvent: (e: Event) => boolean } };
    const target = new EventTarget();
    g.window = Object.assign(target, { dispatchEvent: target.dispatchEvent.bind(target) });
    target.addEventListener('unified-import:handover', listener);
    setPending('tagesdaten', [new File(['x'], 'a.xlsx')]);
    expect(listener).toHaveBeenCalledTimes(1);
    delete g.window;
  });

  it('clearAllPending drops everything (tenant switch)', () => {
    setPending('tagesdaten', [new File(['x'], 'a.xlsx')]);
    clearAllPending();
    expect(hasPending('tagesdaten')).toBe(false);
  });
});

describe('handler access mirrors the existing role guards', () => {
  const admin = { isAdmin: true, isBeaulieuManager: false, isBeaulieuViewer: false };
  const beaulieu = { isAdmin: false, isBeaulieuManager: true, isBeaulieuViewer: false };
  const viewer = { isAdmin: false, isBeaulieuManager: false, isBeaulieuViewer: true };

  it('admin may use every handler', () => {
    for (const h of IMPORT_HANDLERS) expect(canUseHandler(h.id, admin)).toBe(true);
  });

  it('Beaulieu roles are limited like the Import Center cards (sales upload only for the manager)', () => {
    expect(canUseHandler('sales-upload', beaulieu)).toBe(true);
    expect(canUseHandler('sales-upload', viewer)).toBe(false);
    expect(canUseHandler('tagesdaten', beaulieu)).toBe(false);
    expect(canUseHandler('foratable-gaeste', beaulieu)).toBe(false);
    expect(canUseHandler('zbericht-pdf', beaulieu)).toBe(false);
  });
});
