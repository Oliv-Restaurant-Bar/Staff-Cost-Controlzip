/**
 * Reine Ableitungen für die NEUE Darstellung der Personalkosten-Seite
 * (Etappe 4, «vom Groben ins Feine»). KEINE neue Fachrechnung: alle Eingaben
 * stammen aus dem zentralen Kern (personalkosten.ts). Hier wird nur für die
 * Darstellung umgeformt (PKQ-Brücke / Wasserfall, kumulierter Kostenverlauf).
 *
 * Alle Funktionen sind pur und unit-getestet.
 */
import type { FlexTag } from './personalkosten';

// ── PKQ-Brücke (Wasserfall) ──────────────────────────────────────────────────

export interface PkqBrueckeStep {
  /** Stabiler Schlüssel für React-Keys / Tests. */
  key: 'ziel' | 'umsatz' | 'zwischen' | 'personal' | 'hochrechnung';
  /** Anzeige-Label (Effekt-Schritte tragen Vorzeichen im Text). */
  label: string;
  /**
   * 'level'  = absolute Quote (Balken vom Nullpunkt): Ziel / Zwischen / HR.
   * 'effect' = Delta-Schritt (schwebender Balken): Umsatz- / Personal-Effekt.
   */
  kind: 'level' | 'effect';
  /** Quotenwert in Prozentpunkten (bei 'level') bzw. Delta in pp (bei 'effect'). */
  valuePp: number;
  /** Kumulierter Startwert des Balkens (pp) — für den Wasserfall-Offset. */
  startPp: number;
  /** Kumulierter Endwert des Balkens (pp). */
  endPp: number;
  /** Ampel-Ton für Effekt-Schritte (Erhöhung = schlecht). */
  tone: 'good' | 'warn' | 'neutral';
}

export interface PkqBrueckeInput {
  /** Ziel-Personalquote in % (zentrale Einstellung, z.B. 35.5). */
  zielQuotePct: number;
  /** PK-Budget des Monats in CHF (Ziel-Quote × Umsatz-Budget) oder null. */
  pkBudgetCHF: number | null;
  /** Personalkosten-Hochrechnung in CHF (kHr.total). */
  personalHochrechnungCHF: number;
  /** Umsatz-Hochrechnung in CHF (ums.hochrechnung). */
  umsatzHochrechnungCHF: number;
}

export interface PkqBrueckeErgebnis {
  steps: PkqBrueckeStep[];
  /** Zwischen-PKQ = PK-Budget ÷ Umsatz-Hochrechnung (× 100). */
  zwischenPkqPct: number;
  /** End-PKQ = Personalkosten-HR ÷ Umsatz-HR (× 100). */
  hochrechnungPkqPct: number;
  /** true, wenn keine Brücke möglich (kein Budget oder kein Umsatz). */
  incomplete: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Zerlegt die Personalquote-Hochrechnung in eine nachvollziehbare Kette:
 *   Ziel 35.5 %
 *   → +Effekt «Umsatz unter Plan»  (Budget-Kosten fix, aber Umsatz weicht ab)
 *   → Zwischen-PKQ = PK-Budget ÷ Umsatz-Hochrechnung
 *   → +Effekt «Personal über Budget» (Mehr-/Minderkosten gegenüber Budget)
 *   → PKQ-Hochrechnung = Personal-HR ÷ Umsatz-HR
 *
 * Mathematisch sauber, weil beide Effekte auf DENSELBEN Nenner
 * (Umsatz-Hochrechnung) bezogen sind:
 *   zielQuote + (pkBudget/umsHR − zielQuote) + (kHr−pkBudget)/umsHR
 *   = kHr / umsHR = PKQ-HR.
 *
 * Bei Umsatz ÜBER Plan wird der Umsatz-Effekt negativ (Label «Umsatz über
 * Plan»); analog «Personal unter Budget» bei Minderkosten.
 */
export function buildPkqBruecke(input: PkqBrueckeInput): PkqBrueckeErgebnis {
  const { zielQuotePct, pkBudgetCHF, personalHochrechnungCHF, umsatzHochrechnungCHF } = input;
  const incomplete = pkBudgetCHF == null || pkBudgetCHF <= 0 || umsatzHochrechnungCHF <= 0;

  if (incomplete) {
    // Ohne Budget/Umsatz keine sinnvolle Zerlegung — nur die konstante Ziel-Linie.
    const ziel = r1(zielQuotePct);
    return {
      steps: [
        { key: 'ziel', label: 'Ziel-Personalquote', kind: 'level', valuePp: ziel, startPp: 0, endPp: ziel, tone: 'neutral' },
      ],
      zwischenPkqPct: ziel,
      hochrechnungPkqPct: ziel,
      incomplete: true,
    };
  }

  const pkBudget = pkBudgetCHF as number;
  const zwischenPkq = (pkBudget / umsatzHochrechnungCHF) * 100;
  const hochrechnungPkq = (personalHochrechnungCHF / umsatzHochrechnungCHF) * 100;
  const umsatzEffektPp = zwischenPkq - zielQuotePct;
  const personalEffektPp = ((personalHochrechnungCHF - pkBudget) / umsatzHochrechnungCHF) * 100;

  const toneOf = (deltaPp: number): 'good' | 'warn' | 'neutral' =>
    deltaPp > 0.05 ? 'warn' : deltaPp < -0.05 ? 'good' : 'neutral';

  const ziel = zielQuotePct;
  // Rundungs-Schluss: Die LEVEL-Werte werden auf 0.1 pp gerundet; die
  // EFFEKT-Werte werden als Differenz der GERUNDETEN Levels ausgewiesen,
  // damit die angezeigte Kette immer exakt schliesst
  // (ziel + umsatzEffekt = zwischen; zwischen + personalEffekt = hochrechnung).
  const zielR = r1(ziel);
  const zwischenR = r1(zwischenPkq);
  const hrR = r1(hochrechnungPkq);
  const umsatzEffektR = r1(zwischenR - zielR);
  const personalEffektR = r1(hrR - zwischenR);
  const steps: PkqBrueckeStep[] = [
    {
      key: 'ziel', label: 'Ziel-Personalquote', kind: 'level',
      valuePp: zielR, startPp: 0, endPp: zielR, tone: 'neutral',
    },
    {
      key: 'umsatz',
      label: umsatzEffektPp >= 0 ? 'Umsatz unter Plan' : 'Umsatz über Plan',
      kind: 'effect', valuePp: umsatzEffektR,
      startPp: zielR, endPp: zwischenR, tone: toneOf(umsatzEffektPp),
    },
    {
      key: 'zwischen', label: 'Zwischen-PKQ', kind: 'level',
      valuePp: zwischenR, startPp: 0, endPp: zwischenR, tone: 'neutral',
    },
    {
      key: 'personal',
      label: personalEffektPp >= 0 ? 'Personal über Budget' : 'Personal unter Budget',
      kind: 'effect', valuePp: personalEffektR,
      startPp: zwischenR, endPp: hrR, tone: toneOf(personalEffektPp),
    },
    {
      key: 'hochrechnung', label: 'PKQ Hochrechnung', kind: 'level',
      valuePp: r1(hochrechnungPkq), startPp: 0, endPp: r1(hochrechnungPkq), tone: 'neutral',
    },
  ];

  return {
    steps,
    zwischenPkqPct: r1(zwischenPkq),
    hochrechnungPkqPct: r1(hochrechnungPkq),
    incomplete: false,
  };
}

// ── Kumulierter Kostenverlauf ────────────────────────────────────────────────

export interface VerlaufPunkt {
  date: string;
  /** Tag im Monat (1..daysInMonth). */
  day: number;
  /** Kumulierte Ist-Kosten (nur bis Stichtag; danach null → Linie endet). */
  istKum: number | null;
  /** Kumulierte Plan-Hochrechnung (durchgezogen ab Stichtag; davor null). */
  planKum: number | null;
  /** Kumulierte Budget-Linie (gleichmässig FIX + Budget-Tagesverteilung). */
  budgetKum: number | null;
}

export interface VerlaufInput {
  year: number;
  month: number;
  daysInMonth: number;
  /** Letzter abgeschlossener Ist-Tag (0 = noch keiner). */
  stichtag: number;
  /** FIX-Kosten des ganzen Monats (werden linear je Tag verteilt). */
  fixMonatCHF: number;
  /** Flex-Tageszellen aus dem Kern (effektivKosten je Tag). */
  flexTage: FlexTag[];
  /** Budget je Tag aus dem Budget-Modul ({date, betrag}); leer = keine Linie. */
  budgetProTag: { date: string; betrag: number }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Kumulierter Personalkosten-Verlauf über den Monat für die Verlaufsgrafik:
 *   - istKum:    durchgezogene Linie bis Stichtag (FIX anteilig d/daysInMonth +
 *                Σ Flex-effektivKosten der abgeschlossenen Tage).
 *   - planKum:   ab Stichtag (inkl. Stichtag als Anknüpfpunkt) die
 *                Hochrechnung weiter (FIX anteilig + Flex-Plan der Resttage).
 *   - budgetKum: gerade Budget-Linie (FIX anteilig + kumuliertes Budget/Tag);
 *                null, wenn kein Budget hinterlegt.
 *
 * Reine Darstellung — FIX wird linear je Tag verteilt (identische Annahme wie
 * die bestehende PKQ-Verlaufsgrafik), die Flex-Werte kommen 1:1 aus dem Kern.
 */
export function buildKumulierterVerlauf(input: VerlaufInput): VerlaufPunkt[] {
  const { year, month, daysInMonth, stichtag, fixMonatCHF, flexTage, budgetProTag } = input;
  const mm = pad2(month);
  const fixProTag = daysInMonth > 0 ? fixMonatCHF / daysInMonth : 0;
  const flexByDate = new Map(flexTage.map(t => [t.date, t]));
  const budgetByDate = new Map(budgetProTag.map(b => [b.date, b.betrag]));
  const hasBudget = budgetProTag.length > 0;

  const punkte: VerlaufPunkt[] = [];
  let istFlexKum = 0;
  let hrFlexKum = 0;
  let budgetTagKum = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${mm}-${pad2(d)}`;
    const tag = flexByDate.get(date);
    const fixKum = fixProTag * d;

    // Hochrechnung: Ist bis Stichtag, danach Plan (effektivKosten deckt beides ab).
    hrFlexKum += tag ? tag.effektivKosten : 0;
    const planKumVal = r2(fixKum + hrFlexKum);

    // Ist: nur abgeschlossene Tage tragen Flex-Ist bei.
    let istKum: number | null = null;
    if (d <= stichtag) {
      istFlexKum += tag && tag.istTag ? tag.istKosten : 0;
      istKum = r2(fixKum + istFlexKum);
    }

    budgetTagKum += budgetByDate.get(date) ?? 0;
    const budgetKum = hasBudget ? r2(fixKum + budgetTagKum) : null;

    // Plan-Linie erst ab Stichtag zeichnen (durchgezogene Ist-Linie davor).
    // Am Stichtag selbst beide Punkte setzen → Linien treffen sich sauber.
    const planKum = d >= stichtag ? planKumVal : null;

    punkte.push({ date, day: d, istKum, planKum, budgetKum });
  }
  return punkte;
}
