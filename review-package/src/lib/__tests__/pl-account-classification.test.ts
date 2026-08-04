// @vitest-environment node
/**
 * P&L-Klassifikations-Defaults (Spec «Kosten-Import — P&L-Klassifikation korrigieren»):
 *  - 4701 Betriebsmaterial + 4800 Gebinde-Verrechnung = Betriebskosten (nicht Wareneinsatz/WKQ)
 *  - 6611 Kost & Logis = Personalaufwand (nicht Werbung/Marketing)
 *  - 4900 Veränderung Warenvorrat = cogs_lager (WES, nicht Einkaufs-WKQ)
 *  - Custom-Mapping (Stammdaten) überschreibt die Defaults
 *  - Budget-Default-Positionen folgen derselben Zuordnung; Alt-Budgets werden migriert
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
});
vi.mock('pdfjs-dist', () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { lookupAccount, saveMappingCustom, DEFAULT_ACCOUNTS } from '../account-mapping-store';
import { DEFAULT_PL_LINE_ITEMS } from '@/types/budget';
import { kontoKlasse } from '../waren-klassen';

beforeEach(() => { for (const k of Object.keys(localStorageStore)) delete localStorageStore[k]; });

describe('Konto-Klassifikations-Defaults', () => {
  it('4701 → Betriebskosten (other_operating), nicht Wareneinsatz', () => {
    const r = lookupAccount('4701');
    expect(r.matchType).toBe('exact');
    expect(r.mapping?.plCategory).toBe('other_operating');
    expect(r.mapping?.plSection).toBe('operating_expenses');
  });
  it('4800 → Betriebskosten (Verrechnungskonto), nicht Wareneinsatz', () => {
    const r = lookupAccount('4800');
    expect(r.matchType).toBe('exact');
    expect(r.mapping?.plCategory).toBe('other_operating');
  });
  it('6611 → Personalaufwand (personnel_other), nicht Marketing', () => {
    const r = lookupAccount('6611');
    expect(r.matchType).toBe('exact');
    expect(r.mapping?.plCategory).toBe('personnel_other');
    expect(r.mapping?.plSection).toBe('personnel');
  });
  it('4900 → cogs_lager (WES)', () => {
    expect(lookupAccount('4900').mapping?.plCategory).toBe('cogs_lager');
  });
  it('Warenkosten-Kern 4000–4090 bleibt cogs', () => {
    for (const n of ['4000', '4020', '4060', '4090']) {
      expect(lookupAccount(n).mapping?.plSection).toBe('cogs');
    }
  });
  it('WKQ-Kontoklasse: 4701/4800 = Betriebskosten, 4060 = Warenkosten', () => {
    expect(kontoKlasse('4701', 4090)).toBe('betriebskosten');
    expect(kontoKlasse('4800', 4090)).toBe('betriebskosten');
    expect(kontoKlasse('4060', 4090)).toBe('warenkosten');
  });
  it('Custom-Mapping überschreibt Default (konfigurierbar je Konto)', () => {
    const def = DEFAULT_ACCOUNTS.find(a => a.accountNumber === '4701')!;
    saveMappingCustom({ ...def, plCategory: 'cogs_other', plSection: 'cogs', source: 'custom' });
    expect(lookupAccount('4701').mapping?.plCategory).toBe('cogs_other');
  });
});

describe('Budget-Default-Positionen folgen der Klassifikation', () => {
  it('pli_betriebsmat/pli_gebinde_akt in pl_other_op, pli_kost_logis in pl_personnel_other', () => {
    const byId = new Map(DEFAULT_PL_LINE_ITEMS.map(i => [i.id, i]));
    expect(byId.get('pli_betriebsmat')?.categoryId).toBe('pl_other_op');
    expect(byId.get('pli_gebinde_akt')?.categoryId).toBe('pl_other_op');
    expect(byId.get('pli_kost_logis')?.categoryId).toBe('pl_personnel_other');
  });
});
