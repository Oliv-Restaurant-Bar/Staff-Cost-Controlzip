// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  computeFlexScopes,
  safePkQuote,
  toneForDiffPp,
  buildErfolgsrechnungVergleich,
  buildErfolgsVergleichPaar,
  buildPkqBreakdown,
  PERSONALAUFWAND_DIFF_PP_GOOD,
  PERSONALAUFWAND_DIFF_PP_WARN,
  MIN_REVENUE_FOR_QUOTE,
} from '../personal-fix-reconciliation';

describe('computeFlexScopes — die drei „Flex Ist"-Grössen stimmen ab', () => {
  it('leitet Auswertung / Tabelle / Summary aus denselben Bausteinen ab (beweist CHF 2\u2019641)', () => {
    // Reales Szenario: Flex-Auswertung 48\u2019982, Tabelle 51\u2019623 → Δ = Zusatzkosten Fix-MA
    const s = computeFlexScopes({ varArbeitIst: 48_982, zusatzIst: 2_641, ferienIst: 1_500 });
    expect(s.flexArbeitIst).toBe(48_982); // B (Flex-Auswertung) = nur variable MA
    expect(s.flexMitZusatzIst).toBe(51_623); // A (Tabelle) = + Zusatzkosten Fix-MA
    expect(s.totalFlexIst).toBe(53_123); // Summary = + Ferien
    // Die Deltas erklären exakt die Sprünge
    expect(s.zusatzDelta).toBe(2_641);
    expect(s.ferienDelta).toBe(1_500);
    expect(s.flexArbeitIst + s.zusatzDelta).toBe(s.flexMitZusatzIst);
    expect(s.flexMitZusatzIst + s.ferienDelta).toBe(s.totalFlexIst);
  });

  it('ohne Zusatzkosten/Ferien sind alle drei Werte gleich', () => {
    const s = computeFlexScopes({ varArbeitIst: 40_000, zusatzIst: 0, ferienIst: 0 });
    expect(s.flexArbeitIst).toBe(40_000);
    expect(s.flexMitZusatzIst).toBe(40_000);
    expect(s.totalFlexIst).toBe(40_000);
    expect(s.zusatzDelta).toBe(0);
    expect(s.ferienDelta).toBe(0);
  });
});

describe('safePkQuote — Quote mit Null-/Klein-Umsatz-Schutz', () => {
  it('berechnet Personal / Umsatz × 100', () => {
    expect(safePkQuote(50_000, 200_000)).toBeCloseTo(25, 6);
  });
  it('gibt null bei Umsatz < MIN_REVENUE_FOR_QUOTE', () => {
    expect(safePkQuote(500, MIN_REVENUE_FOR_QUOTE - 1)).toBeNull();
  });
  it('gibt null bei fehlendem/nicht-positivem Zähler', () => {
    expect(safePkQuote(0, 200_000)).toBeNull();
    expect(safePkQuote(null, 200_000)).toBeNull();
    expect(safePkQuote(undefined, 200_000)).toBeNull();
  });
  it('gibt null bei fehlendem Umsatz', () => {
    expect(safePkQuote(50_000, null)).toBeNull();
    expect(safePkQuote(50_000, 0)).toBeNull();
  });
});

describe('toneForDiffPp — Ampel anhand Prozentpunkte-Abweichung', () => {
  it('≤ 1 Pp → good, ≤ 3 Pp → warn, darüber → critical', () => {
    expect(toneForDiffPp(0)).toBe('good');
    expect(toneForDiffPp(PERSONALAUFWAND_DIFF_PP_GOOD)).toBe('good');
    expect(toneForDiffPp(-PERSONALAUFWAND_DIFF_PP_GOOD)).toBe('good');
    expect(toneForDiffPp(2)).toBe('warn');
    expect(toneForDiffPp(PERSONALAUFWAND_DIFF_PP_WARN)).toBe('warn');
    expect(toneForDiffPp(3.01)).toBe('critical');
    expect(toneForDiffPp(-8)).toBe('critical');
  });
  it('null → neutral', () => {
    expect(toneForDiffPp(null)).toBe('neutral');
  });
});

describe('buildErfolgsrechnungVergleich — Planung vs. Erfolgsrechnung', () => {
  it('missing, wenn weder personnelCostActual noch PL-5xxx vorhanden (niemals 0)', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 60_000,
      personnelCostActual: undefined,
      plTotalPersonnel: 0,
      plNetRevenue: null,
      effectiveRevenue: 200_000,
    });
    expect(r.status).toBe('missing');
  });

  it('nutzt personnelCostActual als FIBU-Wert OHNE Sozialkosten-Multiplikation', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 62_000,
      personnelCostActual: 60_000,
      plTotalPersonnel: 58_000, // wird ignoriert, weil explizit vorhanden
      plNetRevenue: 200_000,
      effectiveRevenue: 200_000,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.fibuSource).toBe('personnelCostActual');
    expect(r.fibuCHF).toBe(60_000); // exakt der FIBU-Wert, kein Faktor angewandt
    expect(r.diffCHF).toBe(2_000); // 62'000 − 60'000
    expect(r.berechnetPct).toBeCloseTo(31, 6);
    expect(r.fibuPct).toBeCloseTo(30, 6);
    expect(r.diffPp).toBeCloseTo(1, 6);
    expect(r.tone).toBe('good');
    expect(r.revenueMismatch).toBe(false);
  });

  it('fällt auf PL-5xxx zurück, wenn kein expliziter FIBU-Wert', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 70_000,
      personnelCostActual: undefined,
      plTotalPersonnel: 58_000,
      plNetRevenue: 200_000,
      effectiveRevenue: 200_000,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.fibuSource).toBe('pl5xxx');
    expect(r.fibuCHF).toBe(58_000);
    expect(r.diffCHF).toBe(12_000);
    expect(r.diffPp).toBeCloseTo(6, 6); // 35 % − 29 %
    expect(r.tone).toBe('critical');
  });

  it('Prozentpunkte nutzen denselben Umsatz für beide Quoten', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 50_000,
      personnelCostActual: 44_000,
      plTotalPersonnel: null,
      plNetRevenue: 200_000,
      effectiveRevenue: 200_000,
    });
    if (r.status !== 'ok') throw new Error('erwartet ok');
    // (50000-44000)/200000*100 = 3 Pp
    expect(r.diffPp).toBeCloseTo(3, 6);
    expect(r.tone).toBe('warn');
  });

  it('Quoten null bei zu kleinem Umsatz → tone neutral, aber CHF-Diff bleibt', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 5_000,
      personnelCostActual: 4_000,
      plTotalPersonnel: null,
      plNetRevenue: null,
      effectiveRevenue: 500, // < MIN_REVENUE_FOR_QUOTE
    });
    if (r.status !== 'ok') throw new Error('erwartet ok');
    expect(r.berechnetPct).toBeNull();
    expect(r.fibuPct).toBeNull();
    expect(r.diffPp).toBeNull();
    expect(r.tone).toBe('neutral');
    expect(r.diffCHF).toBe(1_000);
  });

  it('revenueMismatch, wenn P&L-Nettoumsatz > 5 % vom PKQ-Umsatz abweicht', () => {
    const r = buildErfolgsrechnungVergleich({
      berechnetCHF: 60_000,
      personnelCostActual: 60_000,
      plTotalPersonnel: null,
      plNetRevenue: 230_000, // +15 % ggü. 200'000
      effectiveRevenue: 200_000,
    });
    if (r.status !== 'ok') throw new Error('erwartet ok');
    expect(r.revenueMismatch).toBe(true);
  });
});

describe('buildErfolgsVergleichPaar — generische Ebene (Planung ODER Ist)', () => {
  it('missing, wenn der Erfolgsrechnungs-Wert fehlt/≤ 0 (niemals 0 anzeigen)', () => {
    expect(buildErfolgsVergleichPaar({ appCHF: 60_000, fibuCHF: null, revenue: 200_000 }).status).toBe('missing');
    expect(buildErfolgsVergleichPaar({ appCHF: 60_000, fibuCHF: 0, revenue: 200_000 }).status).toBe('missing');
    expect(buildErfolgsVergleichPaar({ appCHF: 60_000, fibuCHF: -5, revenue: 200_000 }).status).toBe('missing');
  });

  it('Plan-Ebene: App-Plan ↔ ER-Budget, gemeinsamer Nenner, Diff + Ampel', () => {
    const r = buildErfolgsVergleichPaar({ appCHF: 62_000, fibuCHF: 60_000, revenue: 200_000 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.appCHF).toBe(62_000);
    expect(r.fibuCHF).toBe(60_000);
    expect(r.diffCHF).toBe(2_000);
    expect(r.appPct).toBeCloseTo(31, 6);
    expect(r.fibuPct).toBeCloseTo(30, 6);
    expect(r.diffPp).toBeCloseTo(1, 6); // ≤ 1 Pp
    expect(r.tone).toBe('good');
  });

  it('grosse Abweichung → tone critical (> 3 Pp)', () => {
    const r = buildErfolgsVergleichPaar({ appCHF: 70_000, fibuCHF: 58_000, revenue: 200_000 });
    if (r.status !== 'ok') throw new Error('erwartet ok');
    expect(r.diffPp).toBeCloseTo(6, 6); // 35 % − 29 %
    expect(r.tone).toBe('critical');
  });

  it('Quoten null bei zu kleinem Umsatz → tone neutral, CHF-Diff bleibt', () => {
    const r = buildErfolgsVergleichPaar({ appCHF: 5_000, fibuCHF: 4_000, revenue: 500 });
    if (r.status !== 'ok') throw new Error('erwartet ok');
    expect(r.appPct).toBeNull();
    expect(r.fibuPct).toBeNull();
    expect(r.diffPp).toBeNull();
    expect(r.tone).toBe('neutral');
    expect(r.diffCHF).toBe(1_000);
  });

  it('erzeugt dieselbe Mathematik wie buildErfolgsrechnungVergleich (Ist-Ebene)', () => {
    const paar = buildErfolgsVergleichPaar({ appCHF: 62_000, fibuCHF: 60_000, revenue: 200_000 });
    const ist = buildErfolgsrechnungVergleich({
      berechnetCHF: 62_000,
      personnelCostActual: 60_000,
      plTotalPersonnel: null,
      plNetRevenue: 200_000,
      effectiveRevenue: 200_000,
    });
    if (paar.status !== 'ok' || ist.status !== 'ok') throw new Error('erwartet ok');
    expect(paar.diffCHF).toBe(ist.diffCHF);
    expect(paar.appPct).toBe(ist.berechnetPct);
    expect(paar.fibuPct).toBe(ist.fibuPct);
    expect(paar.diffPp).toBe(ist.diffPp);
    expect(paar.tone).toBe(ist.tone);
  });
});

describe('buildPkqBreakdown — PKQ-Herleitung für InfoTip', () => {
  it('legt Zähler, Nenner, Quelle und Quote offen', () => {
    const b = buildPkqBreakdown({
      personalIst: 60_000,
      revenue: 200_000,
      revenueIsAssumed: false,
      revenueLabel: 'Ist-Umsatz',
      monthLabel: 'Juni 2026',
      cutoffDay: null,
    });
    expect(b.pkq).toBeCloseTo(30, 6);
    expect(b.personalIst).toBe(60_000);
    expect(b.revenue).toBe(200_000);
    expect(b.revenueIsAssumed).toBe(false);
    expect(b.revenueLabel).toBe('Ist-Umsatz');
    expect(b.monthLabel).toBe('Juni 2026');
    expect(b.cutoffDay).toBeNull();
    expect(b.hasRevenue).toBe(true);
  });

  it('pkq null + hasRevenue false bei fehlendem Umsatz', () => {
    const b = buildPkqBreakdown({
      personalIst: 60_000,
      revenue: 0,
      revenueIsAssumed: false,
      revenueLabel: 'Ist-Umsatz',
      monthLabel: 'Juni 2026',
    });
    expect(b.pkq).toBeNull();
    expect(b.hasRevenue).toBe(false);
    expect(b.cutoffDay).toBeNull();
  });
});
