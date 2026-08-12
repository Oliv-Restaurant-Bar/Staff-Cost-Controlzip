// @vitest-environment node
/**
 * Ignore-Liste (Privatbezug): dauerhaft & import-fest.
 * KV wird gemockt (In-Memory) — getestet werden Markieren/Reaktivieren und
 * die Import-Fence in saveInvoiceEntry/saveMonthInvoices.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('../supabase-kv', () => ({
  kvGet: vi.fn(async (k: string) => (kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : null)),
  kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, JSON.parse(JSON.stringify(v))); }),
}));

import {
  loadIgnorierteRechnungen, markiereRechnungIgnoriert, reaktiviereIgnorierteRechnung,
  saveInvoiceEntry, saveMonthInvoices, loadMonthInvoices, filtereIgnorierteRechnungen,
  type InvoiceEntry,
} from '../waren-db';

const T = 'oliv' as never;
const inv = (id: string, reference: string | undefined, net: number, date = '2026-07-03'): InvoiceEntry => ({
  id, date, supplierName: 'Transgourmet', amountGross: net, amountNet: net,
  vatIncluded: true, vatRate: 2.6, reference, warenkonto: '4020',
  createdAt: 'x', updatedAt: 'x',
} as InvoiceEntry);

beforeEach(() => { kv.clear(); vi.resetModules(); });

describe('Ignore-Liste (Privatbezug)', () => {
  it('markieren: Eintrag verschwindet aus dem Monat, Liste trägt Snapshot; reaktivieren stellt ihn wieder her', async () => {
    const e = inv('a', '26070302200058', 21.3);
    await saveInvoiceEntry(T, e);
    await markiereRechnungIgnoriert(T, e);

    expect(await loadMonthInvoices(T, '2026-07')).toHaveLength(0);
    const liste = await loadIgnorierteRechnungen(T);
    expect(liste['26070302200058']).toMatchObject({ lieferant: 'Transgourmet', betragNet: 21.3, datum: '2026-07-03' });

    const wieder = await reaktiviereIgnorierteRechnung(T, '26070302200058');
    expect(wieder?.id).toBe('a');
    expect(await loadMonthInvoices(T, '2026-07')).toHaveLength(1);
    expect(await loadIgnorierteRechnungen(T)).toEqual({});
  });

  it('ohne Rechnungsnummer: markieren wirft (nicht import-fest → nie raten)', async () => {
    await expect(markiereRechnungIgnoriert(T, inv('b', undefined, 50))).rejects.toThrow(/Rechnungsnummer/);
  });

  it('Import-Fence: saveInvoiceEntry überspringt ignorierte Nummern (Cache wird bei Änderung invalidiert)', async () => {
    const e = inv('c', '26070602200215', 150.35, '2026-07-06');
    await saveInvoiceEntry(T, e);
    await markiereRechnungIgnoriert(T, e);
    // Re-Import derselben Rechnung (neue ID, gleiche Nummer) → wird NICHT angelegt.
    await saveInvoiceEntry(T, inv('c2', '26070602200215', 150.35, '2026-07-06'));
    expect(await loadMonthInvoices(T, '2026-07')).toHaveLength(0);
    // Andere Nummer bleibt unberührt.
    await saveInvoiceEntry(T, inv('d', '999', 10, '2026-07-06'));
    expect(await loadMonthInvoices(T, '2026-07')).toHaveLength(1);
  });

  it('Import-Fence: saveMonthInvoices filtert ignorierte Nummern aus dem Monats-Set', async () => {
    const e = inv('e1', '26070302200059', 283.23);
    await saveInvoiceEntry(T, e);
    await markiereRechnungIgnoriert(T, e);
    await saveMonthInvoices(T, '2026-07', [
      inv('n1', '26070302200059', 283.23),
      inv('n2', '777', 42),
    ]);
    const monat = await loadMonthInvoices(T, '2026-07');
    expect(monat.map(x => x.id)).toEqual(['n2']);
  });

  it('Fence ist lieferantengebunden: gleiche kurze Nummer eines ANDEREN Lieferanten passiert', async () => {
    const e = inv('h', '58', 21.3);
    await saveInvoiceEntry(T, e);
    await markiereRechnungIgnoriert(T, e);
    // Gleiche Nummer, anderer Lieferant → wird angelegt.
    const fremd = { ...inv('h2', '58', 500), supplierName: 'Feldschlösschen' } as InvoiceEntry;
    await saveInvoiceEntry(T, fremd);
    expect((await loadMonthInvoices(T, '2026-07')).map(x => x.id)).toEqual(['h2']);
    // Namensvariante desselben Lieferanten (Token-Teilmenge) → bleibt gesperrt.
    const variante = { ...inv('h3', '58', 21.3), supplierName: 'Transgourmet bern' } as InvoiceEntry;
    await saveInvoiceEntry(T, variante);
    expect((await loadMonthInvoices(T, '2026-07')).map(x => x.id)).toEqual(['h2']);
    // KEIN Substring-Matching: «Gourmet AG» enthält «gourmet», ist aber ein anderer Lieferant.
    const substr = { ...inv('h4', '58', 77), supplierName: 'Gourmet AG' } as InvoiceEntry;
    await saveInvoiceEntry(T, substr);
    expect((await loadMonthInvoices(T, '2026-07')).map(x => x.id).sort()).toEqual(['h2', 'h4']);
    // Leerer eingehender Lieferant matcht NICHT (nie raten) → wird angelegt.
    const leer = { ...inv('h5', '58', 5), supplierName: '' } as InvoiceEntry;
    await saveInvoiceEntry(T, leer);
    expect((await loadMonthInvoices(T, '2026-07')).some(x => x.id === 'h5')).toBe(true);
  });

  it('Lese-Selbstheilung: race-wiederauferstandene Rechnung wird beim Laden ausgefiltert', async () => {
    const e = inv('r1', '26070302200059', 283.23);
    await saveInvoiceEntry(T, e);
    await markiereRechnungIgnoriert(T, e);
    const liste = await loadIgnorierteRechnungen(T);
    // Simulierter Race: stale Import-Snapshot enthält die ignorierte Rechnung wieder.
    const stale = [inv('r1b', '26070302200059', 283.23), inv('r2', '888', 10)];
    const heil = filtereIgnorierteRechnungen(liste, stale);
    expect(heil.entfernt).toBe(1);
    expect(heil.entries.map(x => x.id)).toEqual(['r2']);
  });

  it('mandantengetrennt: Beaulieu-Liste beeinflusst Oliv nicht', async () => {
    const B = 'beaulieu' as never;
    const e = inv('f', '555', 99);
    await saveInvoiceEntry(B, e);
    await markiereRechnungIgnoriert(B, e);
    // Anderer Mandant, gleiche Nummer → keine Fence (Cache tenant-gebunden).
    await saveInvoiceEntry(T, inv('g', '555', 99));
    expect(await loadMonthInvoices(T, '2026-07')).toHaveLength(1);
    expect(await loadMonthInvoices(B, '2026-07')).toHaveLength(0);
  });
});
