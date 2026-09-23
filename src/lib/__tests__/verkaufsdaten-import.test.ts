// @vitest-environment happy-dom
/**
 * Verkaufsdaten Food/Beverage-Import (Gastronovi Artikel-Jahresexport)
 * — Parser (Tab-getrennt, «CHF 1873993,50», Gesamt-Zeile), Kategorie/Typ-
 *   Erkennung aus Inhalt/Name, Plan (neu/aktualisiert/unverändert).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseVerkaufsdatenFile, parseVkNumber, buildVkPlan, commitVerkaufsdaten,
  type VkParsedFile, type VkPlan,
} from '@/lib/verkaufsdaten-import';

// ── Mocks für Commit-Tests (keine echten Supabase-Zugriffe) ─────────────────
vi.mock('@/lib/prior-year-lock', () => ({
  getLockState: vi.fn(async () => ({ locked: false })),
}));
vi.mock('@/lib/vj-daily-supabase', () => ({
  loadVjDailyYearStrict: vi.fn(async () => ({})),
  upsertVjDailyBatch: vi.fn(async (records: unknown[]) => ({ upserted: records.length })),
  vjDailyKey: (d: string, t?: string) => `vj_daily:${t && t !== 'oliv' ? t + ':' : ''}${d}`,
}));
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => undefined),
  kvGetStrict: vi.fn(async () => null),
  kvSetStrict: vi.fn(async () => undefined),
  kvSetConfirmed: vi.fn(async () => undefined),
  safeUpsertDailyBudgets: vi.fn(async () => undefined),
}));

import { getLockState } from '@/lib/prior-year-lock';
import { loadVjDailyYearStrict, upsertVjDailyBatch } from '@/lib/vj-daily-supabase';
import { kvGetStrict, kvSetStrict, kvSet, kvSetConfirmed, safeUpsertDailyBudgets } from '@/lib/supabase-kv';
import { isTakeAwayArticleName } from '@/lib/verkaufsdaten-import';
import { sumTaGaesteRange } from '@/lib/ta-gaeste-store';

const HEAD = ['Bezeichnung', 'Zeitraum', '01.01.', '02.01.', '15.03.', '31.12.'].join('\t');

const foodUmsatz = [
  HEAD,
  ['Gesamt - Food (Speisen)', 'CHF 1873993,50', 'CHF 5100,25', 'CHF 4890,00', '', 'CHF 6200,75'].join('\t'),
  ['Tagesteller', 'CHF 250000,00', 'CHF 800,00', 'CHF 750,00', '', 'CHF 900,00'].join('\t'),
].join('\n');

const foodAnzahl = [
  HEAD,
  ['Gesamt - Food (Speisen)', '412350', '317', '295', '', '402'].join('\t'),
  ['Tagesteller', '9000', '40', '38', '', '45'].join('\t'),
].join('\n');

const bevUmsatz = [
  HEAD,
  ['Gesamt - Beverage (Getränke)', 'CHF 950000,00', 'CHF 2100,50', '', 'CHF 1800,00', 'CHF 3000,00'].join('\t'),
].join('\n');

// Reales Gastronovi-Format: TAB-getrennt, JEDE Zelle in doppelten
// Anführungszeichen, Tagesspalten «"01.01."» (MIT End-Punkt, OHNE Jahr).
const q = (s: string) => `"${s}"`;
const HEAD_QUOTED = ['Bezeichnung', 'Zeitraum', '01.01.', '02.01.', '15.03.', '31.12.'].map(q).join('\t');
const foodUmsatzQuoted = [
  HEAD_QUOTED,
  ['Gesamt - Food (Speisen)', 'CHF 1467326,80', 'CHF 5100,25', 'CHF 4890,00', '', 'CHF 6200,75'].map(q).join('\t'),
  ['Pasta TA', 'CHF 250000,00', 'CHF 800,00', 'CHF 750,00', '', 'CHF 900,00'].map(q).join('\t'),
].join('\r\n');
const foodAnzahlQuoted = [
  HEAD_QUOTED,
  ['Gesamt - Food (Speisen)', '412350', '317', '295', '', '402'].map(q).join('\t'),
  ['Pasta TA', '9000', '40', '38', '', '45'].map(q).join('\t'),
].join('\r\n');

describe('parseVerkaufsdatenFile — gequotetes TSV (reales Gastronovi-Format)', () => {
  it('erkennt Tagesspalten «"01.01."» und parst die Gesamt-Zeile', () => {
    const r = parseVerkaufsdatenFile(foodUmsatzQuoted, 'export.csv');
    expect(r.ok).toBe(true);
    expect(r.category).toBe('food');
    expect(r.kind).toBe('umsatz');
    expect(r.debug.dayColumns).toBe(4);
    expect(r.days['01-01']).toBe(5100.25);
    expect(r.days['01-02']).toBe(4890);
    expect(r.days['03-15']).toBeUndefined(); // leere Zelle = nicht geliefert
    expect(r.days['12-31']).toBe(6200.75);
    expect(r.periodTotal).toBe(1467326.8);
  });
  it('zählt TA-Gäste auch in gequoteten Anzahl-Dateien', () => {
    const r = parseVerkaufsdatenFile(foodAnzahlQuoted, 'anzahl.csv');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('anzahl');
    expect(r.taArticleCount).toBe(1);
    expect(r.taGuests?.['01-01']).toBe(40);
    expect(r.taGuests?.['12-31']).toBe(45);
  });
  it('akzeptiert Tagesspalten auch OHNE End-Punkt («01.01»)', () => {
    const head = ['Bezeichnung', 'Zeitraum', '01.01', '02.01'].join('\t');
    const r = parseVerkaufsdatenFile(
      [head, ['Gesamt - Beverage (Getränke)', 'CHF 10,00', 'CHF 4,00', 'CHF 6,00'].join('\t')].join('\n'),
      'bev.csv',
    );
    expect(r.ok).toBe(true);
    expect(r.days['01-01']).toBe(4);
  });
});

describe('parseVkNumber', () => {
  it('parst gequotete Werte «"CHF 1467326,80"»', () => {
    expect(parseVkNumber('"CHF 1467326,80"')).toBe(1467326.8);
  });
  it('parst «CHF 1873993,50» (Komma = Dezimal, CHF-Präfix)', () => {
    expect(parseVkNumber('CHF 1873993,50')).toBe(1873993.5);
  });
  it('parst Varianten: Apostroph-Tausender, Punkt-Tausender mit Komma, ganze Zahlen', () => {
    expect(parseVkNumber("CHF 1'873'993,50")).toBe(1873993.5);
    expect(parseVkNumber('1.873.993,50')).toBe(1873993.5);
    expect(parseVkNumber('317')).toBe(317);
    expect(parseVkNumber('')).toBeNull();
    expect(parseVkNumber('abc')).toBeNull();
  });
});

describe('parseVerkaufsdatenFile', () => {
  it('Food-Umsatz: Kategorie/Typ aus Inhalt, Tageswerte aus Gesamt-Zeile, Zeitraum-Total (Abnahme 2024)', () => {
    const p = parseVerkaufsdatenFile(foodUmsatz, 'Umsatz Food 2024.txt');
    expect(p.ok).toBe(true);
    expect(p.category).toBe('food');
    expect(p.kind).toBe('umsatz');
    expect(p.periodTotal).toBe(1873993.5); // Kontrolle Food-Umsatz 2024 = CHF 1'873'993.50
    expect(p.days['01-01']).toBe(5100.25);
    expect(p.days['01-02']).toBe(4890);
    expect(p.days['12-31']).toBe(6200.75);
    expect(p.days['03-15']).toBeUndefined(); // leere Zelle = kein Tageswert
  });

  it('Anzahl-Datei (ohne CHF) → kind=anzahl', () => {
    const p = parseVerkaufsdatenFile(foodAnzahl, 'Anzahl Food 2025.txt');
    expect(p.ok).toBe(true);
    expect(p.kind).toBe('anzahl');
    expect(p.days['01-01']).toBe(317);
    expect(p.periodTotal).toBe(412350);
  });

  it('Beverage aus «Gesamt - Beverage (Getränke)»', () => {
    const p = parseVerkaufsdatenFile(bevUmsatz, 'export.txt');
    expect(p.ok).toBe(true);
    expect(p.category).toBe('beverage');
    expect(p.kind).toBe('umsatz');
  });

  it('Diagnostik: fehlende Gesamt-Zeile / falsches Format → failureReason + debug, nie ok', () => {
    const noGesamt = [HEAD, ['Tagesteller', 'CHF 100,00', 'CHF 1,00', '', '', ''].join('\t')].join('\n');
    const p1 = parseVerkaufsdatenFile(noGesamt, 'x.txt');
    expect(p1.ok).toBe(false);
    expect(p1.failureReason).toMatch(/Gesamt/);
    expect(p1.debug.dayColumns).toBe(4);

    const p2 = parseVerkaufsdatenFile('Bezeichnung;Zeitraum;01.01.\nGesamt - Food;CHF 1;CHF 1', 'x.csv');
    expect(p2.ok).toBe(false); // Semikolon statt Tab
    expect(p2.failureReason).toBeTruthy();

    const p3 = parseVerkaufsdatenFile('', 'leer.txt');
    expect(p3.ok).toBe(false);
  });

  it('explizite 0 ist ein Tageswert (ersetzt Bestand), leere Zelle nicht', () => {
    const withZero = [HEAD,
      ['Gesamt - Food (Speisen)', 'CHF 100,00', 'CHF 0,00', '', 'CHF 100,00', ''].join('\t'),
    ].join('\n');
    const p = parseVerkaufsdatenFile(withZero, 'Umsatz Food.txt');
    expect(p.ok).toBe(true);
    expect(p.days['01-01']).toBe(0);          // explizite 0 bleibt erhalten
    expect(p.days['01-02']).toBeUndefined();  // leer = nicht geliefert
    expect(p.days['03-15']).toBe(100);
  });

  it('Kategorie-Fallback über Dateinamen, wenn Gesamt-Zeile neutral', () => {
    const neutral = [HEAD, ['Gesamt', 'CHF 10,00', 'CHF 10,00', '', '', ''].join('\t')].join('\n');
    expect(parseVerkaufsdatenFile(neutral, 'Umsatz Beverage 2025.txt').category).toBe('beverage');
    expect(parseVerkaufsdatenFile(neutral, 'unbekannt.txt').ok).toBe(false); // keine Kategorie erkennbar
  });
});

describe('buildVkPlan', () => {
  const parsed = (over: Partial<VkParsedFile>): VkParsedFile => ({
    ok: true, category: 'food', kind: 'umsatz', days: {}, periodTotal: null,
    fileName: 'f', debug: { headerPreview: '', gesamtCell: null, dayColumns: 0, dataRows: 0 }, ...over,
  });

  it('vereint vier Dateien zu Tagesrecords des gewählten Jahres', () => {
    const plan = buildVkPlan(2025, [
      parsed({ category: 'food', kind: 'umsatz', days: { '01-01': 5100 } }),
      parsed({ category: 'food', kind: 'anzahl', days: { '01-01': 317 } }),
      parsed({ category: 'beverage', kind: 'umsatz', days: { '01-01': 2100, '01-02': 900 } }),
      parsed({ category: 'beverage', kind: 'anzahl', days: { '01-01': 88 } }),
    ], {});
    expect(plan.days['2025-01-01']).toEqual({ foodRevenue: 5100, foodCount: 317, beverageRevenue: 2100, beverageCount: 88 });
    expect(plan.days['2025-01-02']).toEqual({ beverageRevenue: 900 });
    expect(plan.neu).toBe(2);
    expect(plan.aktualisiert).toBe(0);
    expect(plan.unveraendert).toBe(0);
  });

  it('dublettensicher: Vergleich mit Bestand → neu/aktualisiert/unverändert', () => {
    const existing = {
      '2025-01-01': { foodRevenue: 5100, foodCount: 317 },
      '2025-01-02': { foodRevenue: 1000 },
    };
    const plan = buildVkPlan(2025, [
      parsed({ days: { '01-01': 5100, '01-02': 1200, '01-03': 700 } }),
      parsed({ kind: 'anzahl', days: { '01-01': 317 } }),
    ], existing);
    expect(plan.unveraendert).toBe(1); // 01-01 feldgleich
    expect(plan.aktualisiert).toBe(1); // 01-02 geändert (1000 → 1200)
    expect(plan.neu).toBe(1);          // 01-03
  });

  it('Teil-Import: nur mitgebrachte Felder vergleichen (Anzahl-only ändert Umsatz-Bestand nicht)', () => {
    const existing = { '2025-01-01': { foodRevenue: 5100 } };
    const plan = buildVkPlan(2025, [parsed({ kind: 'anzahl', days: { '01-01': 317 } })], existing);
    expect(plan.aktualisiert).toBe(1); // foodCount neu dazu = Änderung
    const plan2 = buildVkPlan(2025, [parsed({ kind: 'anzahl', days: { '01-01': 317 } })],
      { '2025-01-01': { foodRevenue: 5100, foodCount: 317 } });
    expect(plan2.unveraendert).toBe(1);
  });

  it('explizite 0 im Plan zählt als Änderung gegen alten Wert > 0', () => {
    const plan = buildVkPlan(2025, [parsed({ days: { '01-01': 0 } })],
      { '2025-01-01': { foodRevenue: 5100 } });
    expect(plan.aktualisiert).toBe(1);
    expect(plan.days['2025-01-01']).toEqual({ foodRevenue: 0 });
  });
});

describe('commitVerkaufsdaten (gemockte Persistenz)', () => {
  const basePlan = (days: VkPlan['days']): VkPlan =>
    ({ days, neu: 0, aktualisiert: 0, unveraendert: 0 });
  const opts = (plan: VkPlan, year: number) => ({
    archiveKey: `beaulieu:verkaufszahlen_${year}`,
    plan,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kvGetStrict).mockResolvedValue(null);
  });

  it('Datenquellen-Trennung: dailyBudgets und vj_daily werden NIE geschrieben (auch vergangene Jahre)', async () => {
    const res = await commitVerkaufsdaten(opts(basePlan({
      '2025-01-01': { foodRevenue: 0, beverageRevenue: 2100 },
      '2025-01-02': { foodRevenue: 4000 },
    }), 2025));
    expect(res.archivedDays).toBe(2);
    // Cockpit-Food/Beverage-Quellen bleiben komplett unangetastet:
    expect(vi.mocked(safeUpsertDailyBudgets)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertVjDailyBatch)).not.toHaveBeenCalled();
    expect(vi.mocked(loadVjDailyYearStrict)).not.toHaveBeenCalled();
    // Nur das Archiv wird geschrieben:
    const [key, blob] = vi.mocked(kvSetStrict).mock.calls[0] as [string, { days: Record<string, unknown> }];
    expect(key).toBe('beaulieu:verkaufszahlen_2025');
    expect(blob.days['2025-01-01']).toEqual({ foodRevenue: 0, beverageRevenue: 2100 });
  });

  it('festgeschriebenes Jahr (z. B. Beaulieu 2025): Import läuft TROTZ Sperre — Jahres-Sperre wird gar nicht konsultiert, gesperrte Cockpit-Quellen bleiben unberührt', async () => {
    vi.mocked(getLockState).mockResolvedValue({ locked: true } as never);
    const res = await commitVerkaufsdaten(opts(basePlan({ '2025-01-01': { foodRevenue: 1, taGuests: 2 } }), 2025));
    expect(res.archivedDays).toBe(1);
    expect(vi.mocked(getLockState)).not.toHaveBeenCalled();               // Sperre bewusst ausgenommen
    expect(vi.mocked(kvSetStrict)).toHaveBeenCalled();                    // Archiv geschrieben
    expect(vi.mocked(safeUpsertDailyBudgets)).not.toHaveBeenCalled();     // gesperrte Umsatzdaten unberührt
    expect(vi.mocked(upsertVjDailyBatch)).not.toHaveBeenCalled();         // gesperrtes Vorjahr unberührt
  });

  it('Archiv-Merge mit Bestand (Lesefehler ≠ leer: kvGetStrict)', async () => {
    vi.mocked(kvGetStrict).mockResolvedValue({ days: { '2026-02-01': { foodCount: 5 } }, updatedAt: 'x' });
    await commitVerkaufsdaten(opts(basePlan({ '2026-01-01': { foodRevenue: 100 } }), 2026));
    const [, blob] = vi.mocked(kvSetStrict).mock.calls[0] as [string, { days: Record<string, unknown> }];
    expect(blob.days['2026-02-01']).toEqual({ foodCount: 5 }); // Bestand bleibt
    expect(blob.days['2026-01-01']).toEqual({ foodRevenue: 100 });
  });

  it('Archiv-Lesefehler: Abbruch VOR dem ersten Write', async () => {
    vi.mocked(kvGetStrict).mockRejectedValue(new Error('read failed'));
    await expect(commitVerkaufsdaten(opts(basePlan({ '2025-01-01': { foodRevenue: 1 } }), 2025)))
      .rejects.toThrow('read failed');
    expect(vi.mocked(kvSetStrict)).not.toHaveBeenCalled();
  });
});

// ═══ «Gäste Take Away» aus Artikel-Anzahl-Dateien ═══════════════════════════

describe('isTakeAwayArticleName (strenge TA-Erkennung)', () => {
  it('matcht eigenständiges Grossbuchstaben-TA und Take Away-Varianten', () => {
    expect(isTakeAwayArticleName('Pizza Margherita TA')).toBe(true);
    expect(isTakeAwayArticleName('TA Menu klein')).toBe(true);
    expect(isTakeAwayArticleName('Sandwich (TA)')).toBe(true);
    expect(isTakeAwayArticleName('Kaffee Take Away')).toBe(true);
    expect(isTakeAwayArticleName('Salat take-away gross')).toBe(true);
    expect(isTakeAwayArticleName('Bowl TAKEAWAY')).toBe(true);
  });
  it('matcht NIE Teilwörter oder klein geschriebenes ta', () => {
    expect(isTakeAwayArticleName('Ricotta')).toBe(false);
    expect(isTakeAwayArticleName('RICOTTA')).toBe(false);
    expect(isTakeAwayArticleName('Vegetaria')).toBe(false);
    expect(isTakeAwayArticleName('Tagesmenu')).toBe(false);
    expect(isTakeAwayArticleName('TAgesmenu')).toBe(false);
    expect(isTakeAwayArticleName('Pasta al forno')).toBe(false);
    expect(isTakeAwayArticleName('Tarte Tatin')).toBe(false);
    expect(isTakeAwayArticleName('')).toBe(false);
  });
  it('Unicode-Buchstaben angrenzend zählen als Wortteil (kein Match)', () => {
    expect(isTakeAwayArticleName('ŠTA Spezial')).toBe(false);
    expect(isTakeAwayArticleName('PäSTA')).toBe(false);
    expect(isTakeAwayArticleName('TAöl')).toBe(false);
    expect(isTakeAwayArticleName('Menü TA')).toBe(true); // echte Grenze bleibt Match
  });
});

describe('parseVerkaufsdatenFile — taGuests (Anzahl-Dateien)', () => {
  const taFoodAnzahl = [
    HEAD,
    ['Gesamt - Food (Speisen)', '412350', '317', '295', '120', '402'].join('\t'),
    ['Pizza TA', '900', '4', '', '2', '10'].join('\t'),
    ['Take Away Menu', '500', '1', '3', '', '5'].join('\t'),
    ['Ricotta', '9999', '99', '99', '99', '99'].join('\t'), // zählt NICHT
  ].join('\n');

  it('summiert TA-Artikel je Tag; gelieferte Tage ohne TA = explizite 0', () => {
    const p = parseVerkaufsdatenFile(taFoodAnzahl, 'Anzahl Food 2025.txt');
    expect(p.ok).toBe(true);
    expect(p.taArticleCount).toBe(2);
    expect(p.taGuestsPeriodTotal).toBe(1400);
    expect(p.taGuests!['01-01']).toBe(5);  // 4 + 1
    expect(p.taGuests!['01-02']).toBe(3);  // nur Take Away Menu
    expect(p.taGuests!['03-15']).toBe(2);  // nur Pizza TA
    expect(p.taGuests!['12-31']).toBe(15); // 10 + 5
  });

  it('ohne TA-Artikel (Beaulieu) → taGuests undefined; Umsatz-Dateien nie taGuests', () => {
    const p = parseVerkaufsdatenFile(foodAnzahl, 'Anzahl Food 2025.txt');
    expect(p.taGuests).toBeUndefined();
    const u = parseVerkaufsdatenFile(foodUmsatz, 'Umsatz Food 2024.txt');
    expect(u.taGuests).toBeUndefined();
  });

  it('buildVkPlan ADDIERT taGuests aus Food- und Beverage-Anzahl', () => {
    const food = parseVerkaufsdatenFile(taFoodAnzahl, 'Anzahl Food 2025.txt');
    const bev = parseVerkaufsdatenFile([
      HEAD,
      ['Gesamt - Beverage (Getränke)', '5000', '10', '20', '', '30'].join('\t'),
      ['Cola TA', '100', '2', '', '', '1'].join('\t'),
    ].join('\n'), 'Anzahl Beverage 2025.txt');
    const plan = buildVkPlan(2025, [food, bev], {});
    expect(plan.days['2025-01-01'].taGuests).toBe(7);  // 5 + 2
    expect(plan.days['2025-01-02'].taGuests).toBe(3);  // 3 + 0
    expect(plan.days['2025-12-31'].taGuests).toBe(16); // 15 + 1
  });
});

describe('commitVerkaufsdaten — ta-gaeste-daily-Store', () => {
  const opts = (plan: VkPlan, year: number) => ({
    archiveKey: `verkaufszahlen_${year}`,
    taGaesteKey: 'ta-gaeste-daily',
    plan,
  });
  const plan = (days: VkPlan['days']): VkPlan => ({ days, neu: 0, aktualisiert: 0, unveraendert: 0 });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kvGetStrict).mockResolvedValue(null);
  });

  it('schreibt TA-Gäste-Tage per Merge (andere Jahre bleiben erhalten)', async () => {
    vi.mocked(kvGetStrict).mockImplementation(async (key: string) =>
      key === 'ta-gaeste-daily' ? { '2024-05-01': 12 } : null);
    const res = await commitVerkaufsdaten(opts(plan({
      '2025-01-01': { foodCount: 317, taGuests: 5 },
      '2025-01-02': { foodCount: 295, taGuests: 0 }, // explizite 0 wird geschrieben
    }), 2025));
    expect(res.taGuestDays).toBe(2);
    const taCall = vi.mocked(kvSetConfirmed).mock.calls.find(([k]) => k === 'ta-gaeste-daily')!;
    expect(taCall[1]).toEqual({ '2024-05-01': 12, '2025-01-01': 5, '2025-01-02': 0 });
  });

  it('ohne taGuests im Plan (Beaulieu): Store bleibt unberührt', async () => {
    const res = await commitVerkaufsdaten(opts(plan({ '2025-01-01': { foodCount: 317 } }), 2025));
    expect(res.taGuestDays).toBe(0);
    expect(vi.mocked(kvSet).mock.calls.some(([k]) => k === 'ta-gaeste-daily')).toBe(false);
  });

  it('Strict-Lesefehler der Merge-Basis bricht VOR dem ersten Write ab (kein Teil-Import)', async () => {
    vi.mocked(kvGetStrict).mockImplementation(async (key: string) => {
      if (key === 'ta-gaeste-daily') throw new Error('kv read failed');
      return null;
    });
    await expect(commitVerkaufsdaten(opts(plan({ '2026-01-01': { foodRevenue: 100, taGuests: 3 } }), 2026)))
      .rejects.toThrow('kv read failed');
    expect(vi.mocked(kvSet)).not.toHaveBeenCalled();
    expect(vi.mocked(kvSetStrict)).not.toHaveBeenCalled();          // Archiv unangetastet
    expect(vi.mocked(safeUpsertDailyBudgets)).not.toHaveBeenCalled(); // dailyBudgets unangetastet
  });
});

describe('sumTaGaesteRange', () => {
  const map = { '2025-01-01': 5, '2025-01-02': 0, '2025-02-01': 7, '2024-12-31': 9 };
  it('summiert nur Tage im Zeitraum; explizite 0 zählt als geliefert', () => {
    expect(sumTaGaesteRange(map, '2025-01-01', '2025-01-31')).toBe(5);
    expect(sumTaGaesteRange(map, '2025-01-02', '2025-01-02')).toBe(0);
    expect(sumTaGaesteRange(map, '2024-01-01', '2025-12-31')).toBe(21);
  });
  it('null wenn kein gelieferter Tag im Zeitraum (Fallback product_sales)', () => {
    expect(sumTaGaesteRange(map, '2026-01-01', '2026-12-31')).toBeNull();
    expect(sumTaGaesteRange({}, '2025-01-01', '2025-01-31')).toBeNull();
    expect(sumTaGaesteRange(map, null, '2025-01-31')).toBeNull();
  });
});
