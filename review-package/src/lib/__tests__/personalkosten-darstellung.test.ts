// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildPkqBruecke,
  buildKumulierterVerlauf,
  type VerlaufInput,
} from '@/lib/personalkosten-darstellung';
import type { FlexTag } from '@/lib/personalkosten';

// ── PKQ-Brücke ────────────────────────────────────────────────────────────────

describe('buildPkqBruecke — Wasserfall Ziel → Umsatz-Effekt → Zwischen → Personal-Effekt → HR', () => {
  it('zerlegt sauber: Effekte summieren exakt auf PKQ-Hochrechnung', () => {
    // Ziel 35.5 %, Budget 88'750, HR-Kosten 118'531, HR-Umsatz 253'000.
    const r = buildPkqBruecke({
      zielQuotePct: 35.5,
      pkBudgetCHF: 88_750,
      personalHochrechnungCHF: 118_531,
      umsatzHochrechnungCHF: 253_000,
    });
    expect(r.incomplete).toBe(false);
    // Zwischen-PKQ = 88'750 / 253'000 = 35.08 %
    expect(r.zwischenPkqPct).toBeCloseTo(35.1, 1);
    // PKQ-HR = 118'531 / 253'000 = 46.85 %
    expect(r.hochrechnungPkqPct).toBeCloseTo(46.9, 1);
    // Ampel: Umsatz unter Plan (zwischen < ziel → negativ → good), Personal drüber (warn).
    const ziel = r.steps.find(s => s.key === 'ziel')!;
    const umsatz = r.steps.find(s => s.key === 'umsatz')!;
    const personal = r.steps.find(s => s.key === 'personal')!;
    const hr = r.steps.find(s => s.key === 'hochrechnung')!;
    expect(ziel.valuePp).toBe(35.5);
    // Kette schliesst: ziel + umsatzEffekt + personalEffekt = HR (auf pp genau).
    const sum = ziel.valuePp + umsatz.valuePp + personal.valuePp;
    expect(sum).toBeCloseTo(hr.valuePp, 1);
    // Wasserfall-Offsets: Umsatz-Schritt beginnt bei Ziel, endet bei Zwischen.
    expect(umsatz.startPp).toBe(35.5);
    expect(umsatz.endPp).toBe(r.zwischenPkqPct);
    // Personal-Schritt beginnt bei Zwischen, endet bei HR.
    expect(personal.startPp).toBe(r.zwischenPkqPct);
    expect(personal.endPp).toBe(r.hochrechnungPkqPct);
    // Personal über Budget → warn.
    expect(personal.tone).toBe('warn');
    expect(personal.label).toBe('Personal über Budget');
  });

  it('Rundungs-Schluss: angezeigte Kette schliesst EXAKT auch bei ungünstiger Rundung', () => {
    // Werte so gewählt, dass separate Rundung der Effekte die Kette um 0.1 pp verfehlen würde.
    const r = buildPkqBruecke({
      zielQuotePct: 20.0,
      pkBudgetCHF: 9_040,       // zwischen = 9040/100450 = 8.9995... → 9.0
      personalHochrechnungCHF: 18_990, // hr = 18.9049... → 18.9
      umsatzHochrechnungCHF: 100_450,
    });
    const [ziel, umsatz, zwischen, personal, hr] = r.steps;
    // Kette schliesst exakt auf den gerundeten Levels:
    expect(ziel.valuePp + umsatz.valuePp).toBe(zwischen.valuePp);
    expect(zwischen.valuePp + personal.valuePp).toBe(hr.valuePp);
    expect(ziel.valuePp + umsatz.valuePp + personal.valuePp).toBe(hr.valuePp);
    // Start/End-Offsets konsistent:
    expect(umsatz.startPp).toBe(ziel.valuePp);
    expect(umsatz.endPp).toBe(zwischen.valuePp);
    expect(personal.startPp).toBe(zwischen.valuePp);
    expect(personal.endPp).toBe(hr.valuePp);
  });

  it('Umsatz über Plan → Umsatz-Effekt negativ, Label «Umsatz über Plan»', () => {
    const r = buildPkqBruecke({
      zielQuotePct: 35.5,
      pkBudgetCHF: 88_750,
      personalHochrechnungCHF: 90_000,
      umsatzHochrechnungCHF: 300_000, // Umsatz über Budget (250k)
    });
    const umsatz = r.steps.find(s => s.key === 'umsatz')!;
    expect(umsatz.valuePp).toBeLessThan(0);
    expect(umsatz.label).toBe('Umsatz über Plan');
    expect(umsatz.tone).toBe('good');
  });

  it('ohne Budget/Umsatz → incomplete, nur Ziel-Level', () => {
    const r = buildPkqBruecke({
      zielQuotePct: 40,
      pkBudgetCHF: null,
      personalHochrechnungCHF: 100_000,
      umsatzHochrechnungCHF: 0,
    });
    expect(r.incomplete).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].key).toBe('ziel');
    expect(r.steps[0].valuePp).toBe(40);
  });
});

// ── Kumulierter Verlauf ─────────────────────────────────────────────────────

function makeFlexTag(date: string, istTag: boolean, istKosten: number, effektivKosten: number): FlexTag {
  return { date, istTag, proMa: {}, planKosten: effektivKosten, istKosten, effektivKosten };
}

describe('buildKumulierterVerlauf — Ist durchgezogen, Plan ab Stichtag, Budget-Linie', () => {
  const base: VerlaufInput = {
    year: 2026,
    month: 7,
    daysInMonth: 4,
    stichtag: 2,
    fixMonatCHF: 4000, // → 1000 pro Tag
    flexTage: [
      makeFlexTag('2026-07-01', true, 100, 100),
      makeFlexTag('2026-07-02', true, 200, 200),
      makeFlexTag('2026-07-03', false, 0, 300), // Zukunft → Plan
      makeFlexTag('2026-07-04', false, 0, 400),
    ],
    budgetProTag: [
      { date: '2026-07-01', betrag: 250 },
      { date: '2026-07-02', betrag: 250 },
      { date: '2026-07-03', betrag: 250 },
      { date: '2026-07-04', betrag: 250 },
    ],
  };

  it('Ist-Linie endet am Stichtag (danach null)', () => {
    const p = buildKumulierterVerlauf(base);
    expect(p).toHaveLength(4);
    // Tag 1: FIX 1000 + Flex-Ist 100 = 1100
    expect(p[0].istKum).toBe(1100);
    // Tag 2: FIX 2000 + Flex-Ist 300 = 2300
    expect(p[1].istKum).toBe(2300);
    // Nach Stichtag → istKum null
    expect(p[2].istKum).toBeNull();
    expect(p[3].istKum).toBeNull();
  });

  it('Plan-Linie beginnt am Stichtag (Anknüpfpunkt) und läuft weiter', () => {
    const p = buildKumulierterVerlauf(base);
    // Vor Stichtag keine Plan-Linie
    expect(p[0].planKum).toBeNull();
    // Am Stichtag (Tag 2): FIX 2000 + Flex-HR (100+200)=300 → 2300 (= Ist-Anschluss)
    expect(p[1].planKum).toBe(2300);
    // Tag 3: FIX 3000 + Flex-HR (100+200+300)=600 → 3600
    expect(p[2].planKum).toBe(3600);
    // Tag 4: FIX 4000 + Flex-HR 1000 → 5000
    expect(p[3].planKum).toBe(5000);
  });

  it('Budget-Linie = kumuliertes PK-Budget/Tag OHNE Fix-Anteil; Endpunkt == pkBudget.total', () => {
    const p = buildKumulierterVerlauf(base);
    // Tag 1: nur Budget 250 (kein Fix obendrauf)
    expect(p[0].budgetKum).toBe(250);
    // Tag 4 (Monatsende): Summe budgetProTag = 4×250 = 1000 = pkBudget.total
    const pkBudgetTotal = base.budgetProTag.reduce((s, b) => s + b.betrag, 0);
    expect(p[3].budgetKum).toBe(pkBudgetTotal);
    expect(p[3].budgetKum).toBe(1000);
    // Endpunkt Budget-Linie liegt UNTER Plan/HR-Endpunkt (5000) → korrekt.
    expect(p[3].budgetKum! < p[3].planKum!).toBe(true);
  });

  it('ohne Budget → budgetKum null', () => {
    const p = buildKumulierterVerlauf({ ...base, budgetProTag: [] });
    expect(p.every(x => x.budgetKum === null)).toBe(true);
  });

  it('stichtag 0 (Monat noch nicht begonnen) → keine Ist-Linie, Plan ab Tag 1', () => {
    const p = buildKumulierterVerlauf({ ...base, stichtag: 0 });
    expect(p.every(x => x.istKum === null)).toBe(true);
    expect(p[0].planKum).not.toBeNull();
  });
});
