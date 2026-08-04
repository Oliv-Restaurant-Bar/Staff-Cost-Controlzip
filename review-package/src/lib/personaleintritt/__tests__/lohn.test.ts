// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  berechneLohn,
  mindestlohnFuer,
  mindestlohnJahr,
  rundeLohn,
  lohnEinheitFuer,
  SL_TOTAL_FAKTOR,
  type MindestlohnEintrag,
} from '../lohn';

// Offizielle L-GAV-Werte 2026 (Auftrag Punkt 1): Monat ×13 + Stundenwerte je
// Wochenmodell — die Stundenwerte sind autoritative Tabellenwerte, KEINE Formel.
const SEED_2026: MindestlohnEintrag[] = [
  { jahr: 2026, klasse: 'Ia', monatX13: 3713, stunde42: 20.40, stunde435: 19.65, stunde45: 19.04 },
  { jahr: 2026, klasse: 'Ib', monatX13: 3943, stunde42: 21.66, stunde435: 20.86, stunde45: 20.22 },
  { jahr: 2026, klasse: 'II', monatX13: 4070, stunde42: 22.36, stunde435: 21.53, stunde45: 20.87 },
  { jahr: 2026, klasse: 'IIIa', monatX13: 4528, stunde42: 24.88, stunde435: 23.96, stunde45: 23.22 },
  { jahr: 2026, klasse: 'IIIb', monatX13: 4635, stunde42: 25.47, stunde435: 24.52, stunde45: 23.77 },
  { jahr: 2026, klasse: 'IV', monatX13: 5293, stunde42: 29.08, stunde435: 28.01, stunde45: 27.14 },
];

describe('mindestlohnFuer', () => {
  it('Monat: monat_x13 direkt (Basis exkl. 13. ≥ monat_x13)', () => {
    expect(mindestlohnFuer(SEED_2026, 2026, 'Ia', 'monat')).toBe(3713);
    expect(mindestlohnFuer(SEED_2026, 2026, 'IV', 'monat')).toBe(5293);
  });
  it('Stunde: offizieller Tabellenwert stunde_42 (42-h-Betriebe), KEINE Formel', () => {
    expect(mindestlohnFuer(SEED_2026, 2026, 'Ia', 'stunde')).toBe(20.40);
    expect(mindestlohnFuer(SEED_2026, 2026, 'IV', 'stunde')).toBe(29.08);
  });
  it('fehlender stunde_42-Wert ⇒ null (kein Formel-Fallback, fehlend ≠ 0)', () => {
    const ohneStunde: MindestlohnEintrag[] = [{ jahr: 2026, klasse: 'Ia', monatX13: 3713 }];
    expect(mindestlohnFuer(ohneStunde, 2026, 'Ia', 'stunde')).toBeNull();
    expect(mindestlohnFuer(ohneStunde, 2026, 'Ia', 'monat')).toBe(3713);
  });
  it('fehlender Tabelleneintrag ⇒ null (fehlend ≠ 0)', () => {
    expect(mindestlohnFuer(SEED_2026, 2025, 'Ia', 'monat')).toBeNull();
    expect(mindestlohnFuer([], 2026, 'Ia', 'monat')).toBeNull();
  });
});

describe('mindestlohnJahr', () => {
  it('liest das Jahr aus dem ISO-Datum', () => {
    expect(mindestlohnJahr('2026-09-01')).toBe(2026);
  });
  it('ungültig/fehlend ⇒ null', () => {
    expect(mindestlohnJahr(undefined)).toBeNull();
    expect(mindestlohnJahr('kein-datum')).toBeNull();
  });
});

describe('berechneLohn — Modus A (grundlohn)', () => {
  it('ML: Basis = Eingabe, Einheit monat, keine SL-Zuschläge', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 4500,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBe(4500);
    expect(r.lohnEinheit).toBe('monat');
    expect(r.slZuschlaege).toBeNull();
    expect(r.unterMindestlohn).toBe(false);
    expect(r.blockierend).toBe(false);
  });
  it('ML + inkl. 13.: Basis = Eingabe × 12/13 (Anpassung 2)', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 5000, grundlohnInkl13: true,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBeCloseTo((5000 * 12) / 13, 10);
    expect(r.lohnEinheit).toBe('monat');
  });
  it('ML + inkl. 13.: Mindestlohn-Prüfung läuft auf der umgerechneten Basis', () => {
    // 4000 inkl. 13. ⇒ Basis 3692.31 < 3713 (Ia 2026) ⇒ blockierend
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 4000, grundlohnInkl13: true,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBeCloseTo((4000 * 12) / 13, 10);
    expect(r.unterMindestlohn).toBe(true);
    expect(r.blockierend).toBe(true);
  });
  it('SL ignoriert inkl. 13. (der 13. steckt im 8.33-%-Zuschlag)', () => {
    const r = berechneLohn({
      vertragstyp: 'SL', modus: 'grundlohn', grundlohn: 24, grundlohnInkl13: true,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBe(24);
  });
  it('SL: Zuschlags-Aufschlüsselung 10.65/2.27/8.33 auf der Basis', () => {
    const r = berechneLohn({
      vertragstyp: 'SL', modus: 'grundlohn', grundlohn: 24,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnEinheit).toBe('stunde');
    expect(r.slZuschlaege).not.toBeNull();
    expect(r.slZuschlaege!.ferien).toBeCloseTo(24 * 0.1065, 10);
    expect(r.slZuschlaege!.feiertag).toBeCloseTo(24 * 0.0227, 10);
    expect(r.slZuschlaege!.dreizehnter).toBeCloseTo(24 * 0.0833, 10);
    expect(r.slZuschlaege!.total).toBeCloseTo(24 * 1.2125, 10);
  });
  it('unter Mindestlohn ⇒ blockierend', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 3500,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.unterMindestlohn).toBe(true);
    expect(r.blockierend).toBe(true);
  });
  it('Einführungszeit: Mindest −8 % erlaubt', () => {
    const min8 = 3713 * 0.92; // 3415.96
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 3500,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026, einfuehrungszeit: true,
    });
    expect(r.mindestlohn).toBeCloseTo(min8, 10);
    expect(r.blockierend).toBe(false);
    // aber unter −8 % bleibt blockierend:
    const r2 = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 3400,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026, einfuehrungszeit: true,
    });
    expect(r2.blockierend).toBe(true);
  });
  it('ohne Lohnklasse keine Prüfung möglich ⇒ Hinweis, nicht blockierend', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'grundlohn', grundlohn: 3000,
      jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.blockierend).toBe(false);
    expect(r.hinweis).toMatch(/Lohnklasse/);
  });
});

describe('berechneLohn — Modus B (mindestlohn)', () => {
  it('ML: Basis = Tabellenwert', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'mindestlohn',
      lohnklasse: 'IIIa', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBe(4528);
    expect(r.blockierend).toBe(false);
  });
  it('SL: Basis = offizieller Stunden-Mindestlohn (stunde_42)', () => {
    const r = berechneLohn({
      vertragstyp: 'SL', modus: 'mindestlohn',
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBe(20.40);
  });
  it('SL + Einführungszeit: 20.40 − 8 % = 18.768 → gerundet 18.77 (Spec-Prüfwert)', () => {
    const r = berechneLohn({
      vertragstyp: 'SL', modus: 'mindestlohn',
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026, einfuehrungszeit: true,
    });
    expect(r.lohnBerechnet).toBeCloseTo(20.40 * 0.92, 10);
    expect(rundeLohn(r.lohnBerechnet!)).toBe(18.77);
  });
  it('mit Einführungszeit: Basis = Mindest −8 %, nicht blockierend', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'mindestlohn',
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026, einfuehrungszeit: true,
    });
    expect(r.lohnBerechnet).toBeCloseTo(3713 * 0.92, 10);
    expect(r.blockierend).toBe(false);
  });
  it('fehlender Tabelleneintrag ⇒ kein Wert + Hinweis', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'mindestlohn',
      lohnklasse: 'Ia', jahr: 2027, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBeNull();
    expect(r.hinweis).toMatch(/lgav_mindestlohn/);
  });
});

describe('berechneLohn — Modus C (zieltotal)', () => {
  it('ML: Basis = Ziel × 12/13', () => {
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'zieltotal', zielTotal: 5200,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBeCloseTo((5200 * 12) / 13, 10);
  });
  it('SL: Basis = Ziel / 1.2125', () => {
    const r = berechneLohn({
      vertragstyp: 'SL', modus: 'zieltotal', zielTotal: 30,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.lohnBerechnet).toBeCloseTo(30 / SL_TOTAL_FAKTOR, 10);
    expect(r.slZuschlaege!.total).toBeCloseTo(30, 10);
  });
  it('Rückrechnung unter Mindestlohn ⇒ blockierend', () => {
    // Ziel 4000 → Basis 3692.3 < 3713
    const r = berechneLohn({
      vertragstyp: 'ML', modus: 'zieltotal', zielTotal: 4000,
      lohnklasse: 'Ia', jahr: 2026, mindestloehne: SEED_2026,
    });
    expect(r.blockierend).toBe(true);
  });
});

describe('rundeLohn / lohnEinheitFuer', () => {
  it('rundet auf Rappen', () => {
    expect(rundeLohn(20.40 * 0.92)).toBe(18.77); // 18.768 → 18.77
    expect(rundeLohn(4800.005)).toBe(4800.01);
  });
  it('SL⇒stunde, ML⇒monat', () => {
    expect(lohnEinheitFuer('SL')).toBe('stunde');
    expect(lohnEinheitFuer('ML')).toBe('monat');
  });
});
