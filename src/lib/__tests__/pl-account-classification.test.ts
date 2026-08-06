// @vitest-environment node
/**
 * P&L-Klassifikations-Defaults (Spec «Kosten-Import — P&L-Klassifikation korrigieren»):
 *  - 4701-4703 + 4800-4900 = Material-/Warenaufwand (formelle OR-ER, Bruttogewinn 1);
 *    operativ zählen 4701/4800 weiterhin NICHT zur WKQ (Warenkosten = 4000–Grenze)
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
  it('4701-4703 → Material-/Warenaufwand (cogs, OR-ER)', () => {
    for (const n of ['4701', '4702', '4703']) {
      const r = lookupAccount(n);
      expect(r.matchType).toBe('exact');
      expect(r.mapping?.plSection).toBe('cogs');
      expect(r.mapping?.plCategory).toBe('cogs_other');
    }
  });
  it('4800/4801 → Material-/Warenaufwand (cogs, OR-ER)', () => {
    for (const n of ['4800', '4801']) {
      const r = lookupAccount(n);
      expect(r.matchType).toBe('exact');
      expect(r.mapping?.plSection).toBe('cogs');
      expect(r.mapping?.plCategory).toBe('cogs_other');
    }
  });
  it('6611 → Werbeaufwand (marketing, analog formeller OR-ER), nicht Personalaufwand', () => {
    const r = lookupAccount('6611');
    expect(r.matchType).toBe('exact');
    expect(r.mapping?.plCategory).toBe('marketing');
    expect(r.mapping?.plSection).toBe('operating_expenses');
  });
  it('5004/5005 «Personal Aushilfe» → Lohnaufwand (personnel)', () => {
    for (const n of ['5004', '5005']) {
      const r = lookupAccount(n);
      expect(r.mapping?.plSection).toBe('personnel');
      expect(r.mapping?.accountName).toBe('Personal Aushilfe');
    }
  });
  it('4900 → cogs_lager (WES)', () => {
    expect(lookupAccount('4900').mapping?.plCategory).toBe('cogs_lager');
  });
  it('Warenkosten-Kern 4000–4090 bleibt cogs', () => {
    for (const n of ['4000', '4020', '4060', '4090']) {
      expect(lookupAccount(n).mapping?.plSection).toBe('cogs');
    }
  });
  it('WKQ-Kontoklasse (operativ, unverändert): 4701/4800 = Betriebskosten, 4060 = Warenkosten', () => {
    expect(kontoKlasse('4701', 4090)).toBe('betriebskosten');
    expect(kontoKlasse('4800', 4090)).toBe('betriebskosten');
    expect(kontoKlasse('4060', 4090)).toBe('warenkosten');
  });
  it('Custom-Mapping überschreibt Default (konfigurierbar je Konto)', () => {
    const def = DEFAULT_ACCOUNTS.find(a => a.accountNumber === '4701')!;
    saveMappingCustom({ ...def, plCategory: 'other_operating', plSection: 'operating_expenses', source: 'custom' });
    expect(lookupAccount('4701').mapping?.plCategory).toBe('other_operating');
  });
});

describe('Budget-Default-Positionen folgen der Klassifikation', () => {
  it('pli_betriebsmat/pli_gebinde_akt in pl_goods_cost (OR-ER), pli_kost_logis in pl_marketing', () => {
    const byId = new Map(DEFAULT_PL_LINE_ITEMS.map(i => [i.id, i]));
    expect(byId.get('pli_betriebsmat')?.categoryId).toBe('pl_goods_cost');
    expect(byId.get('pli_gebinde_akt')?.categoryId).toBe('pl_goods_cost');
    expect(byId.get('pli_kost_logis')?.categoryId).toBe('pl_marketing');
  });
  it('pli_karate «Personal Aushilfe» (5004) ist feste, immer sichtbare Position in pl_wages', () => {
    const item = DEFAULT_PL_LINE_ITEMS.find(i => i.id === 'pli_karate');
    expect(item?.categoryId).toBe('pl_wages');
    expect(item?.accountNumber).toBe('5004');
    expect(item?.label).toBe('Personal Aushilfe');
    expect(item?.isForceVisible).toBe(true);
  });
});
