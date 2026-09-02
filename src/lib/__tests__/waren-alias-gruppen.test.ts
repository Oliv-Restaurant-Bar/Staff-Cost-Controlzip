// @vitest-environment node
/**
 * Lieferanten-Alias-Gruppen: Resolver, applyAliasGruppen und FIBU-Abgleich-
 * Gruppierung (Summierung pro Gruppe, Mitglieder-Transparenz, Totale stabil).
 */
import { describe, it, expect } from 'vitest';
import {
  buildAliasResolver, applyAliasGruppen, normalizeAliasGruppen,
  DEFAULT_ALIAS_GRUPPEN_BEAULIEU, type AliasGruppe,
} from '@/lib/waren-alias-gruppen';
import { buildWarenAbgleich } from '@/lib/waren-abgleich';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';

const GRUPPEN: AliasGruppe[] = DEFAULT_ALIAS_GRUPPEN_BEAULIEU;

function inv(supplierName: string, amountNet: number): InvoiceEntry {
  return {
    id: `inv-${supplierName}-${amountNet}`, date: '2026-06-10', supplierName,
    amountGross: amountNet * 1.081, amountNet, mwstRate: 8.1, warenkonto: '4060',
  } as unknown as InvoiceEntry;
}
function jrn(text: string, soll: number): SageJournalEntry {
  return { accountNumber: '4060', date: '2026-06-15', text, soll, haben: 0 } as unknown as SageJournalEntry;
}

describe('buildAliasResolver', () => {
  it('mappt Aliasse und Gruppenname case-insensitiv auf den Gruppennamen', () => {
    const r = buildAliasResolver(GRUPPEN);
    expect(r('Prodega')).toBe('Prodega / Transgourmet');
    expect(r('TRANSGOURMET')).toBe('Prodega / Transgourmet');
    expect(r('Prodega / Transgourmet')).toBe('Prodega / Transgourmet');
    expect(r('Frigemo')).toBe('Gourmador (frigemo)');
    expect(r('Gourmador SA (frigemo)')).toBe('Gourmador (frigemo)');
    expect(r('Ambro Food SA')).toBe('Ambro Food');
    expect(r('Spahni')).toBe('Metzgerei Spahni');
    expect(r('Migros')).toBe('Migros'); // unbekannt bleibt unverändert
    expect(r('')).toBe('');
  });
  it('ohne Gruppen: Identität', () => {
    expect(buildAliasResolver([])('Prodega')).toBe('Prodega');
  });
});

describe('applyAliasGruppen', () => {
  it('ersetzt nur Namen, Beträge/Reihenfolge bleiben; Totale unverändert', () => {
    const list = [inv('Prodega', 100), inv('Migros', 50), inv('Frigemo', 25)];
    const out = applyAliasGruppen(list, GRUPPEN);
    expect(out.map(e => e.supplierName)).toEqual(['Prodega / Transgourmet', 'Migros', 'Gourmador (frigemo)']);
    expect(out.reduce((s, e) => s + e.amountNet, 0)).toBeCloseTo(175);
    expect(out[1]).toBe(list[1]); // unveränderte Einträge behalten Referenz
    expect(applyAliasGruppen(list, [])).toBe(list);
  });
});

describe('normalizeAliasGruppen', () => {
  it('verwirft kaputte Einträge tolerant', () => {
    expect(normalizeAliasGruppen(null)).toEqual([]);
    expect(normalizeAliasGruppen([{ name: '', aliases: ['x'] }, { name: 'A', aliases: [] }, { name: 'B', aliases: ['b1', ' '] }]))
      .toEqual([expect.objectContaining({ name: 'B', aliases: ['b1'] })]);
  });
});

describe('buildWarenAbgleich mit aliasGruppen', () => {
  const base = {
    warenkontoNummern: ['4060'],
    supplierNames: ['Prodega', 'Gourmador'],
    aliases: {},
    buchhaltungTotal: null,
  };

  it('summiert Erfasst+Buchhaltung pro Gruppe in EINER Zeile mit Mitglieder-Breakdown', () => {
    const res = buildWarenAbgleich({
      ...base,
      invoices: [inv('Prodega', 1000), inv('Prodega', 200)],
      journal: [jrn('Transgourmet AG Rechnung', 1150), jrn('Prodega Markt', 60)],
      aliasGruppen: GRUPPEN,
    });
    const zeile = res.zeilen.find(z => z.lieferant === 'Prodega / Transgourmet');
    expect(zeile).toBeDefined();
    expect(zeile!.erfasst).toBeCloseTo(1200);
    expect(zeile!.gebucht).toBeCloseTo(1210);
    expect(zeile!.diff).toBeCloseTo(10);
    expect(zeile!.status).toBe('ok'); // unter 50er-Schwelle
    // keine separate Transgourmet-Zeile
    expect(res.zeilen.some(z => z.lieferant === 'Transgourmet')).toBe(false);
    // Transparenz: Original-Namen mit Beträgen
    const namen = (zeile!.mitglieder ?? []).map(m => m.name).sort();
    expect(namen).toEqual(['Prodega', 'Transgourmet']);
    const tg = zeile!.mitglieder!.find(m => m.name === 'Transgourmet')!;
    expect(tg.erfasst).toBeNull();
    expect(tg.gebucht).toBeCloseTo(1150);
    // Totale unverändert
    expect(res.erfasstTotal).toBeCloseTo(1200);
    expect(res.gebuchtTotal).toBeCloseTo(1210);
  });

  it('Buchungs-Alias ohne erfassten Lieferanten wird via Gruppen-Alias gematcht', () => {
    const res = buildWarenAbgleich({
      ...base,
      supplierNames: [], // gar keine Stammdaten
      invoices: [],
      journal: [jrn('Frigemo AG', 500)],
      aliasGruppen: GRUPPEN,
    });
    const zeile = res.zeilen.find(z => z.lieferant === 'Gourmador (frigemo)');
    expect(zeile?.gebucht).toBeCloseTo(500);
    expect(zeile?.status).toBe('nur-gebucht');
    expect(res.nichtZugeordnet).toHaveLength(0);
  });

  it('ohne Gruppen unverändertes Verhalten (getrennte Zeilen)', () => {
    const res = buildWarenAbgleich({
      ...base,
      invoices: [inv('Prodega', 100)],
      journal: [jrn('Prodega Markt', 100)],
    });
    const zeile = res.zeilen.find(z => z.lieferant === 'Prodega');
    expect(zeile?.status).toBe('ok');
    expect(zeile?.mitglieder).toBeUndefined();
  });
});
