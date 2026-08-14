/**
 * cockpit-report-pdf.ts — strukturierter Cockpit-PDF-Export (Vektor, kein Raster)
 * ===============================================================================
 * Rendert die drei Report-Typen (Wochenübersicht, Letzte 4 Wochen, Wochenverlauf)
 * im selben Stil: Querformat A4, 13-mm-Ränder, Inhalt über die volle Breite.
 *
 *  - Kopfband: Logo + Restaurantname + Mandant links; Reporttyp/Zeitraum/Datum
 *    rechts; Akzentlinie in der Markenfarbe. Seitenzahl in der Fusszeile.
 *  - Kennzahlen in Sektionen (Umsatz · Gäste · Personal · Waren · Bewertungen),
 *    Zebra-Streifen, Kennzahlname halbfett mit grauer Notiz-Zeile, Zahlen
 *    rechtsbündig mit Tausender-Trennung, leere Felder «—» (nie 0).
 *  - Δ als farbiger Chip (CHF gross, % klein) — grün = GÜNSTIG, richtungs-
 *    abhängig (Umsatz über Budget grün, Kosten über Budget rot). Nie Farbe
 *    allein: Chips tragen immer Wert + Vorzeichen.
 *  - Ampel-Badges (Wert + Farbe + Label): WKQ ≤30 grün / ≤35 gelb / >35 rot;
 *    PKQ gegen 40 % (≤40 grün / ≤44 gelb / >44 rot); Ø-Verkauf & Produktivität
 *    gegen Budget (≥100 % grün / ≥95 % gelb / darunter rot).
 *  - Kompakte 3-Spalten-Legende + Farb-Legende-Zeile statt grossem Textblock.
 *
 * Reine Layout-/Modell-Logik: Builder (aus MrRow[]-Spalten bzw.
 * WochenverlaufDaten) sind pure Funktionen und node-testbar; der Renderer
 * zeichnet in ein übergebenes jsPDF (der Orchestrator setzt die Seitenzahlen,
 * weil die Gesamtseitenzahl erst am Ende feststeht).
 */

import type { jsPDF } from 'jspdf';
import type { MrRow, MrFormat, WochenverlaufDaten, JahresvergleichDaten } from '@/lib/monatsreport';
import { mapRowForExport } from '@/lib/monatsreport-export';
import type { RestaurantBranding } from '@/lib/pl-branding';

// ── Modell ───────────────────────────────────────────────────────────────────

export type CrTon = 'gruen' | 'gelb' | 'rot' | 'neutral';

export interface CrAmpel { stufe: 'gruen' | 'gelb' | 'rot'; label: string }

/** Ein Zahlwert einer Zelle: Haupttext + optionale kleine Unterzeile/Ampel. */
export interface CrWert {
  text: string;                 // '—' wenn leer (nie 0 erfinden)
  sub?: string | null;          // z.B. «18.3 % Anteil Gäste IN» / «255 Pers.»
  ampel?: CrAmpel | null;       // Ampel-Badge unter dem Wert
}

/** Δ-Chip: Hauptwert (CHF/PP, gross) + optional Prozent (klein darunter). */
export interface CrDelta { haupt: string; sub?: string | null; ton: 'gruen' | 'rot' | 'neutral' }

export interface CrZelle { ist: CrWert; budget: CrWert; delta: CrDelta | null }

export interface CrRow {
  label: string;
  notiz?: string | null;        // graue Zusatzzeile unter dem Namen (Basis/Anteile)
  bold?: boolean;
  /** Eine Zelle je Wochengruppe; null = Gruppe ohne Daten (alles «—»). */
  zellen: (CrZelle | null)[];
}

export interface CrSektion { titel: string; rows: CrRow[] }

export interface CrGruppe { header: string; sub?: string | null }

export interface CrReportModel {
  reportTyp: string;            // «Wochenübersicht» | «Letzte 4 Wochen» | «Wochenverlauf» | «Monatsübersicht» | «Jahresvergleich»
  zeitraum: string;
  gruppen: CrGruppe[];
  sektionen: CrSektion[];
  /** @deprecated Legenden werden NICHT mehr gerendert (Design-Muster: nur
   *  Kopfband + Tabelle + schmale Fusszeile). Feld bleibt für Kompatibilität. */
  legende?: string[];
}

// ── Formatierung (CH) ────────────────────────────────────────────────────────

function tsd(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/** Zahl mit fixen Nachkommastellen + Apostroph-Tausender (jsPDF-sicher). */
export function fmtZahl(v: number, dp: number): string {
  const neg = v < 0;
  const s = Math.abs(v).toFixed(dp);
  const [i, d] = s.split('.');
  return `${neg ? '-' : ''}${tsd(i)}${d ? `.${d}` : ''}`;
}

/** Wert nach MrFormat; null → «—» (nie 0). */
export function fmtWert(v: number | null | undefined, fmt: MrFormat | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (fmt) {
    case 'pct': return `${fmtZahl(v, 1)} %`;
    case 'count': return fmtZahl(Math.round(v), 0);
    // Hauptwert der Gruppen-Zeile ist in PERSONEN (Budget-Einheit).
    case 'countPax': return `${fmtZahl(Math.round(v), 0)} Pers.`;
    case 'hours': return `${fmtZahl(Math.round(v), 0)} h`;
    default: return fmtZahl(v, 0); // CHF: ganze Franken, einheitlich
  }
}

// ── Ampel-Schwellen ──────────────────────────────────────────────────────────

export function wkqAmpel(pct: number | null): CrAmpel | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const stufe = pct <= 30 ? 'gruen' : pct <= 35 ? 'gelb' : 'rot';
  const label = stufe === 'gruen' ? 'im Ziel' : stufe === 'gelb' ? 'erhöht' : 'über Ziel';
  return { stufe, label: `WKQ ${fmtZahl(pct, 1)} % ${label}` };
}

export function pkqAmpel(pct: number | null): CrAmpel | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const stufe = pct <= 40 ? 'gruen' : pct <= 44 ? 'gelb' : 'rot';
  const label = stufe === 'gruen' ? 'im Ziel' : stufe === 'gelb' ? 'erhöht' : 'über Ziel';
  return { stufe, label };
}

/** Ampel gegen Budget (mehr = besser): ≥100 % grün, ≥95 % gelb, sonst rot. */
export function budgetAmpel(ist: number | null, budget: number | null): CrAmpel | null {
  if (ist === null || budget === null || !(budget > 0)) return null;
  const q = ist / budget;
  const stufe = q >= 1 ? 'gruen' : q >= 0.95 ? 'gelb' : 'rot';
  const label = stufe === 'gruen' ? 'im Ziel' : stufe === 'gelb' ? 'knapp' : 'unter Ziel';
  return { stufe, label };
}

// ── Sektions-Zuordnung ───────────────────────────────────────────────────────

const SEKTION_IDS: Array<{ titel: string; ids: string[] }> = [
  {
    titel: 'Umsatz',
    ids: ['brutto_umsatz', 'netto_umsatz', 'take_away_umsatz', 'take_away_anteil',
      'food_umsatz', 'beverage_umsatz', 'avg_verkauf_gast'],
  },
  {
    titel: 'Gäste',
    ids: ['gaeste_in', 'reservierte_gaeste', 'gruppen_ab_20', 'gaeste_take_away'],
  },
  {
    titel: 'Personal',
    ids: ['prod_stunden_ist', 'produktivitaet', 'personalkosten', 'personalquote',
      'ueberstunden_total', 'ueberstunden_kosten_total'],
  },
  { titel: 'Waren', ids: ['warenkosten_total', 'warenkosten_food', 'warenkosten_beverage'] },
];

function istBewertungsRow(row: { id?: string; label?: string }): boolean {
  const id = row.id ?? '';
  const label = row.label ?? '';
  return /stern/i.test(id) || /google|tripadvisor|bewertung|rezension/i.test(id)
    || /google|tripadvisor|bewertung|rezension|stern/i.test(label);
}

function sektionFuer(row: { id?: string; label?: string }): string {
  for (const s of SEKTION_IDS) if (row.id && s.ids.includes(row.id)) return s.titel;
  if (istBewertungsRow(row)) return 'Bewertungen';
  // KEIN «Weitere Kennzahlen»-Sammelblock: unbekannte Zeilen werden per
  // id-/Label-Heuristik der fachlich passenden Sektion zugeordnet
  // (Warenkosten Food/Beverage gehören in den Waren-Block, nicht ans Ende).
  const t = `${row.id ?? ''} ${row.label ?? ''}`.toLowerCase();
  if (/waren|wareneinsatz|wkq/.test(t)) return 'Waren';
  if (/personal|stunden|produktiv|lohn|pkq/.test(t)) return 'Personal';
  if (/g(ä|ae)ste|reserv|gruppen|pax/.test(t)) return 'Gäste';
  return 'Umsatz';
}

const SEKTION_REIHENFOLGE = ['Umsatz', 'Gäste', 'Personal', 'Waren', 'Bewertungen'];

/** Zeilen (in Original-Reihenfolge) in geordnete Sektionen gruppieren. */
function gruppiereSektionen(rows: Array<{ sektion: string; row: CrRow }>): CrSektion[] {
  const map = new Map<string, CrRow[]>();
  for (const r of rows) map.set(r.sektion, [...(map.get(r.sektion) ?? []), r.row]);
  return SEKTION_REIHENFOLGE
    .filter(t => map.has(t))
    .map(titel => ({ titel, rows: map.get(titel)! }));
}

// ── Delta-Chip ───────────────────────────────────────────────────────────────

/** Δ, das auf der Anzeige-Rundung 0 ist → KEIN Chip (dezentes «—»). */
function istNullDelta(haupt: string): boolean {
  return /^[+\-−]?0(?:\.0)?(?:\s*(?:PP|%|h))?$/.test(haupt.trim());
}

function deltaChip(row: MrRow, devAbs: number | null, dev: number | null, devGut: boolean | null): CrDelta | null {
  if (devAbs === null) return null;
  const isPp = row.fmt === 'pct' || !!row.deltaPp;
  const haupt = isPp
    ? `${devAbs >= 0 ? '+' : ''}${fmtZahl(devAbs, 1)} PP`
    : `${devAbs >= 0 ? '+' : '-'}${fmtWert(Math.abs(devAbs), row.fmt).replace(/^—$/, '0')}`;
  if (istNullDelta(haupt)) return null;
  const sub = !isPp && dev !== null ? `${dev >= 0 ? '+' : ''}${fmtZahl(dev, 1)} %` : null;
  return { haupt, sub, ton: devGut === null ? 'neutral' : devGut ? 'gruen' : 'rot' };
}

// ── Builder: Wochen-Reports (Wochenübersicht & Letzte 4 Wochen) ─────────────

export interface CrWochenSpalte { rows: MrRow[] | null; header: string; sub?: string | null }

/**
 * Modell aus N Wochen-Spalten (MrRow[] je Woche). Skeleton = letzte Spalte mit
 * Daten (neueste Woche); ältere Spalten werden per Zeilen-ID zugeordnet.
 * Kind-Zeilen (Lieferanten unter Warenkosten) werden ausgelassen — der
 * PDF-Report zeigt die verdichtete Sicht.
 */
export function buildWochenPdfModel(
  cols: CrWochenSpalte[],
  meta: { reportTyp: string; zeitraum: string; legende?: string[]; granularity?: 'woche' | 'monat' },
): CrReportModel {
  const gran = meta.granularity ?? 'woche';
  const skeletonCol = [...cols].reverse().find(c => c.rows && c.rows.length > 0);
  const skeleton = (skeletonCol?.rows ?? []).filter(r => r.type === 'data' && !r.childOf);
  const proSpalte = cols.map(c => {
    const map = new Map<string, MrRow>();
    for (const r of c.rows ?? []) if (r.type === 'data' && r.id) map.set(r.id, r);
    return map;
  });

  const zeilen: Array<{ sektion: string; row: CrRow }> = [];
  for (const sk of skeleton) {
    const zellen: (CrZelle | null)[] = cols.map((c, ci) => {
      if (!c.rows) return null;
      const r = sk.id ? proSpalte[ci].get(sk.id) : undefined;
      if (!r) return null;
      const m = mapRowForExport(r, gran);
      const ist: CrWert = { text: fmtWert(m.ist, r.fmt) };
      // Unterzeilen: Gruppen-Anzahl (countPax — Hauptwert ist in Personen),
      // Anteil (share), Ampeln.
      if (r.fmt === 'countPax' && m.istPax !== null) ist.sub = `${fmtZahl(Math.round(m.istPax), 0)} Gruppen`;
      else if (r.sharePct && m.istShare !== null && m.ist !== null) {
        ist.sub = `${fmtZahl(m.istShare, 1)} % ${r.shareHint ?? 'Anteil Gäste IN'}`;
      }
      const wkqInfo = gran === 'monat' ? r.wkqInline?.month : r.wkqInline?.week;
      if (r.id === 'warenkosten_total') ist.ampel = wkqAmpel(wkqInfo?.pct ?? null);
      else if (r.id === 'personalquote') ist.ampel = pkqAmpel(m.ist);
      else if (r.id === 'avg_verkauf_gast' || r.id === 'produktivitaet') {
        ist.ampel = budgetAmpel(m.ist, m.budget);
      }
      const budget: CrWert = { text: fmtWert(m.budget, r.fmt) };
      return { ist, budget, delta: deltaChip(r, m.devAbs, m.dev, m.devGut) };
    });

    const notizTeile: string[] = [];
    if (sk.id === 'warenkosten_total') {
      const w = gran === 'monat' ? sk.wkqInline?.month : sk.wkqInline?.week;
      if (w?.ziel != null) notizTeile.push(`Ziel-WKQ ${fmtZahl(w.ziel, 1)} %`);
      if (w?.food != null) notizTeile.push(`Food ${fmtZahl(w.food, 1)} %`);
      if (w?.bev != null) notizTeile.push(`Bev ${fmtZahl(w.bev, 1)} %`);
    }
    if (sk.id === 'personalquote') notizTeile.push('Personalkosten ÷ Netto-Umsatz');
    if (sk.id === 'produktivitaet') notizTeile.push('Netto-Umsatz ÷ produktive Std');
    if (sk.id === 'avg_verkauf_gast') notizTeile.push('Netto-Umsatz ÷ Gäste (gepaarte Tage)');
    if (sk.deltaVsVj) notizTeile.push('Δ vs. Vorjahr (kein Budget)');

    zeilen.push({
      sektion: sektionFuer(sk),
      row: {
        label: sk.label ?? '',
        notiz: notizTeile.length > 0 ? notizTeile.join(' · ') : null,
        bold: sk.bold,
        zellen,
      },
    });
  }

  return {
    reportTyp: meta.reportTyp,
    zeitraum: meta.zeitraum,
    gruppen: cols.map(c => ({ header: c.header, sub: c.sub ?? null })),
    sektionen: gruppiereSektionen(zeilen),
  };
}

// ── Builder: Jahresvergleich ─────────────────────────────────────────────────

/**
 * Modell aus den Jahresvergleich-Daten (1 Gruppe: Ist | Budget | Δ), Δ gegen
 * das Cockpit-KPI-Budget — IDENTISCHE Semantik wie die Bildschirmtabelle
 * (Vorjahr als Unterzeile beim Ist, wenn vorhanden).
 */
export function buildJahresvergleichPdfModel(
  daten: JahresvergleichDaten,
  meta: { zeitraum: string; spaltenHeader: string },
): CrReportModel {
  const zeilen: Array<{ sektion: string; row: CrRow }> = [];
  for (const r of daten.rows) {
    const budget = r.budget ?? null;
    const devAbs = r.cur !== null && budget !== null ? r.cur - budget : null;
    const devPct = r.cur !== null && budget !== null && budget !== 0
      ? ((r.cur - budget) / Math.abs(budget)) * 100 : null;
    const devGut = devAbs === null ? null : (r.deltaInverted ? devAbs <= 0 : devAbs >= 0);
    const ist: CrWert = { text: fmtWert(r.cur, r.fmt) };
    if (r.vj !== null) ist.sub = `VJ ${daten.vjYear}: ${fmtWert(r.vj, r.fmt)}`;
    const pseudoRow = { fmt: r.fmt, deltaPp: r.fmt === 'pct' } as MrRow;
    zeilen.push({
      sektion: sektionFuer({ label: r.label }),
      row: {
        label: r.label,
        notiz: null,
        bold: r.bold,
        zellen: [{
          ist,
          budget: { text: fmtWert(budget, r.fmt) },
          delta: deltaChip(pseudoRow, devAbs, devPct, devGut),
        }],
      },
    });
  }
  return {
    reportTyp: 'Jahresvergleich',
    zeitraum: meta.zeitraum,
    gruppen: [{ header: meta.spaltenHeader, sub: null }],
    sektionen: gruppiereSektionen(zeilen),
  };
}

// ── Builder: Wochenverlauf ───────────────────────────────────────────────────

export function buildVerlaufPdfModel(
  daten: WochenverlaufDaten,
  meta: { zeitraum: string; legende?: string[] },
): CrReportModel {
  const fmtDatum = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? `${m[3]}.${m[2]}.` : iso;
  };
  const gruppen: CrGruppe[] = daten.weeks.map((w, i) => ({
    header: `KW ${w.kw}${daten.partialWeekIndex === i ? ' (laufend)' : ''}`,
    sub: `${fmtDatum(w.from)}–${fmtDatum(w.to)}`,
  }));

  const zeilen: Array<{ sektion: string; row: CrRow }> = [];
  for (const r of daten.rows) {
    if (r.childOf) continue;
    const zellen: (CrZelle | null)[] = daten.weeks.map((_w, i) => {
      const istV = r.values[i] ?? null;
      const budV = r.budgetValues?.[i] ?? null;
      const ist: CrWert = { text: fmtWert(istV, r.fmt) };
      if (r.wkqValues && r.wkqZiel != null) ist.ampel = wkqAmpel(r.wkqValues[i] ?? null);
      else if (r.id === 'personalquote' && r.fmt === 'pct') ist.ampel = pkqAmpel(istV);
      // Vorjahres-Vergleich (Ansicht «mit Vorjahr»): VJ-Wert als Unterzeile,
      // sofern die Zeile keine Ampel trägt (Ampel hat Vorrang).
      if (!ist.ampel && r.vjValues) {
        const vjV = r.vjValues[i] ?? null;
        if (vjV !== null) ist.sub = `VJ ${fmtWert(vjV, r.fmt)}`;
      }
      const budget: CrWert = { text: fmtWert(budV, r.fmt) };
      let delta: CrDelta | null = null;
      if (istV !== null && budV !== null) {
        const devAbs = istV - budV;
        const dev = budV > 0 ? (devAbs / budV) * 100 : null;
        const isPp = r.fmt === 'pct';
        const gut = r.budgetInverted ? devAbs <= 0 : devAbs >= 0;
        const haupt = isPp
          ? `${devAbs >= 0 ? '+' : ''}${fmtZahl(devAbs, 1)} PP`
          : `${devAbs >= 0 ? '+' : '-'}${fmtWert(Math.abs(devAbs), r.fmt)}`;
        // Δ auf Anzeige-Rundung 0 → kein Chip (dezentes «—» im Renderer).
        delta = istNullDelta(haupt) ? null : {
          haupt,
          sub: !isPp && dev !== null ? `${dev >= 0 ? '+' : ''}${fmtZahl(dev, 1)} %` : null,
          ton: gut ? 'gruen' : 'rot',
        };
      }
      return { ist, budget, delta };
    });
    zeilen.push({
      sektion: sektionFuer(r),
      row: { label: r.label, bold: r.bold, zellen },
    });
  }

  return {
    reportTyp: 'Wochenverlauf',
    zeitraum: meta.zeitraum,
    gruppen,
    sektionen: gruppiereSektionen(zeilen),
  };
}

// ── Renderer ─────────────────────────────────────────────────────────────────

const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 13;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// Farbpalette 1:1 aus dem HTML-Muster (cockpit_report_mockup).
// Chips: HELL getönter Hintergrund + DUNKLE Schrift (nie satte Vollflächen).
const CHIP_BG: Record<'gruen' | 'gelb' | 'rot' | 'neutral', [number, number, number]> = {
  gruen: [231, 243, 236],   // --good-bg #e7f3ec
  gelb: [253, 243, 226],    // --warn-bg #fdf3e2
  rot: [251, 236, 235],     // --bad-bg  #fbeceb
  neutral: [238, 241, 239], // #eef1ef
};
const CHIP_INK: Record<'gruen' | 'gelb' | 'rot' | 'neutral', [number, number, number]> = {
  gruen: [21, 121, 74],     // --good-ink #15794a
  gelb: [176, 114, 20],     // --warn-ink #b07214
  rot: [192, 57, 43],       // --bad-ink  #c0392b
  neutral: [84, 96, 91],    // --ink2 #54605b
};
const ZEBRA: [number, number, number] = [250, 251, 250];       // --zebra #fafbfa
const SEKTION_BG: [number, number, number] = [245, 247, 245];  // --band #f5f7f5
const GRAU: [number, number, number] = [138, 147, 142];        // --muted #8a938e
const GRAU2: [number, number, number] = [84, 96, 91];          // --ink2 #54605b
const DUNKEL: [number, number, number] = [28, 35, 33];         // --ink #1c2321
const LINIE: [number, number, number] = [227, 231, 228];       // --line #e3e7e4

interface Spalten {
  labelW: number;
  gruppeW: number;
  istW: number;
  budgetW: number;
  deltaW: number;
}

/** Eine Werte-Gruppe (Ist·Budget·Δ) wird nie breiter als das — bei Einzel-
 *  Perioden-Reports (Monats-/Wochenübersicht) sonst über die ganze Breite
 *  gestreckt mit toter Fläche zwischen den Spalten. */
const MAX_GRUPPE_W = 84;

function berechneSpalten(nGruppen: number): Spalten {
  const n = Math.max(1, nGruppen);
  const minLabelW = Math.max(58, Math.min(80, CONTENT_W * 0.26));
  // Kompakte Gruppenbreite, gedeckelt; Label-Spalte absorbiert den Rest, so
  // dass die Werte-Gruppe(n) bündig am RECHTEN Rand sitzen (keine tote Fläche).
  const gruppeW = Math.min(MAX_GRUPPE_W, (CONTENT_W - minLabelW) / n);
  const labelW = CONTENT_W - n * gruppeW;
  // Ist·Budget·Δ gleichmässig breit — identisches Raster auf allen Seiten.
  const teilW = gruppeW / 3;
  return { labelW, gruppeW, istW: teilW, budgetW: teilW, deltaW: teilW };
}

/** Kopfband + Akzentlinie + Farb-Legende. Liefert y-Start des Inhalts. */
function zeichneKopf(
  pdf: jsPDF, model: CrReportModel, branding: RestaurantBranding,
  logo: string | null, heute: Date, folgeseite: boolean,
): number {
  const bandH = folgeseite ? 11 : 19;
  pdf.setFillColor(...branding.headerBg);
  pdf.rect(0, 0, PAGE_W, bandH, 'F');

  if (!folgeseite && logo) {
    // Logo-Seitenverhältnis der SVG-Wordmarks (~220×56) beibehalten.
    const logoH = 11;
    const logoW = logoH * (240 / 56);
    try { pdf.addImage(logo, 'PNG', MARGIN, (bandH - logoH) / 2, logoW, logoH); } catch { /* Logo optional */ }
    pdf.setTextColor(...branding.textPrimary);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
    pdf.text(branding.displayName, MARGIN + logoW + 5, bandH / 2 - 0.5);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
    pdf.setTextColor(...branding.textSecondary);
    pdf.text(branding.companyLine, MARGIN + logoW + 5, bandH / 2 + 3.6);
  } else {
    pdf.setTextColor(...branding.textPrimary);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
    pdf.text(`${branding.displayName} — ${model.reportTyp}`, MARGIN, bandH / 2 + 1.5);
  }

  // Rechts: Reporttyp + Zeitraum + Export-Datum.
  const datum = heute.toLocaleDateString('de-CH');
  pdf.setTextColor(...branding.textPrimary);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(folgeseite ? 9 : 12);
  pdf.text(model.reportTyp, PAGE_W - MARGIN, folgeseite ? bandH / 2 + 1.5 : bandH / 2 - 1.5, { align: 'right' });
  if (!folgeseite) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
    pdf.setTextColor(...branding.textSecondary);
    textMitDelta(pdf, `${model.zeitraum}  ·  Export ${datum}`, PAGE_W - MARGIN, bandH / 2 + 3.6, { align: 'right' });
  }

  // Akzentlinie (Markenfarbe).
  pdf.setFillColor(...branding.accentColor);
  pdf.rect(0, bandH, PAGE_W, 1.4, 'F');

  // KEINE Farb-Legende-Zeile mehr (Design-Muster: Kopfband → direkt Tabelle).
  return bandH + 1.4 + 4;
}

/** Gruppen-/Spaltenköpfe. Liefert neues y. */
function zeichneTabellenkopf(pdf: jsPDF, model: CrReportModel, sp: Spalten, y: number, accent: [number, number, number]): number {
  const kopfH = 9.6;
  pdf.setFillColor(250, 250, 251);
  pdf.rect(MARGIN, y, CONTENT_W, kopfH, 'F');
  pdf.setTextColor(...DUNKEL);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
  pdf.text('Kennzahl', MARGIN + 2, y + 4.2);
  model.gruppen.forEach((g, i) => {
    const gx = MARGIN + sp.labelW + i * sp.gruppeW;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
    pdf.setTextColor(...DUNKEL);
    pdf.text(g.header, gx + sp.gruppeW / 2, y + 3.4, { align: 'center' });
    if (g.sub) {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.5);
      pdf.setTextColor(...GRAU);
      pdf.text(g.sub, gx + sp.gruppeW / 2, y + 6.0, { align: 'center' });
    }
    // Spaltenköpfe RECHTSBÜNDIG exakt über den zugehörigen Werten
    // (gleiche -1-mm-Kante wie die Zahlen/Chips darunter).
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.8);
    pdf.setTextColor(...GRAU);
    pdf.text('Ist', gx + sp.istW - 1, y + 8.6, { align: 'right' });
    pdf.text('Budget', gx + sp.istW + sp.budgetW - 1, y + 8.6, { align: 'right' });
    textMitDelta(pdf, 'Δ', gx + sp.gruppeW - 1, y + 8.6, { align: 'right' });
    // dünne Gruppen-Trennlinie
    if (i > 0) {
      pdf.setDrawColor(...LINIE);
      pdf.setLineWidth(0.2);
      pdf.line(gx, y + 0.5, gx, y + kopfH - 0.5);
    }
  });
  pdf.setDrawColor(...accent);
  pdf.setLineWidth(0.5);
  pdf.line(MARGIN, y + kopfH, MARGIN + CONTENT_W, y + kopfH);
  return y + kopfH + 0.8;
}

/**
 * «Δ»-sicheres Text-Rendering: Die jsPDF-Kernfonts (helvetica, WinAnsi) kennen
 * kein U+0394 und drucken stattdessen «"». Der Symbol-Kernfont enthält das
 * griechische Alphabet ('D' = Δ) — Segment-Rendering: Δ via Symbol-Font,
 * Rest im aktuellen Font; Ausrichtung über die Gesamtbreite gerechnet.
 */
function textMitDelta(pdf: jsPDF, text: string, x: number, y: number, opts?: { align?: 'left' | 'right' | 'center' }): void {
  if (!text.includes('Δ')) { pdf.text(text, x, y, opts); return; }
  const { fontName, fontStyle } = pdf.getFont();
  const segs = text.split('Δ');
  pdf.setFont('symbol', 'normal');
  const wDelta = pdf.getTextWidth('D');
  pdf.setFont(fontName, fontStyle);
  const widths = segs.map(s => pdf.getTextWidth(s));
  const total = widths.reduce((a, b) => a + b, 0) + wDelta * (segs.length - 1);
  const align = opts?.align ?? 'left';
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  segs.forEach((s, i) => {
    if (s) { pdf.text(s, cx, y); cx += widths[i]; }
    if (i < segs.length - 1) {
      pdf.setFont('symbol', 'normal');
      pdf.text('D', cx, y);
      cx += wDelta;
      pdf.setFont(fontName, fontStyle);
    }
  });
}

/** Kürzt Text mit «…» auf EINE Zeile innerhalb maxW (aktuelle Font-Einstellung). */
function einzeilig(pdf: jsPDF, text: string, maxW: number): string {
  if (pdf.getTextWidth(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && pdf.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function rowHoehe(row: CrRow): number {
  const hatSub = !!row.notiz || row.zellen.some(z => z && (z.ist.sub || z.ist.ampel || (z.delta && z.delta.sub)));
  return hatSub ? 9.2 : 6.2;
}

/**
 * @param schmal Mehr-Spalten-Ansichten (Letzte 4 Wochen, Wochenverlauf): die
 * Anteil-/WKQ-Notiz unter dem Ist-Wert wird WEGGELASSEN — die rechtsbündige
 * Sub-/Badge-Zeile würde in den Δ-Chip der Nachbargruppe bluten.
 */
function zeichneZeile(pdf: jsPDF, row: CrRow, sp: Spalten, y: number, h: number, zebra: boolean, schmal: boolean): void {
  if (zebra) {
    pdf.setFillColor(...ZEBRA);
    pdf.rect(MARGIN, y, CONTENT_W, h, 'F');
  }
  const baseY = y + (row.notiz || h > 8 ? 4.0 : h / 2 + 1.2);

  // Kennzahlname (halbfett) + Notiz-Zeile (grau, klein) — beide EINZEILIG
  // mit Ellipse gekürzt: `maxWidth` würde umbrechen und über die Zeilenhöhe
  // hinaus in Nachbarzeilen/-spalten bluten (Layout-Fehler im alten Export).
  pdf.setTextColor(...DUNKEL);
  pdf.setFont('helvetica', row.bold ? 'bold' : 'normal');
  pdf.setFontSize(row.bold ? 9 : 8.6);
  pdf.text(einzeilig(pdf, row.label, sp.labelW - 4), MARGIN + 2, baseY);
  if (row.notiz) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.4);
    pdf.setTextColor(...GRAU);
    textMitDelta(pdf, einzeilig(pdf, row.notiz, sp.labelW - 4), MARGIN + 2, baseY + 3.2);
  }

  row.zellen.forEach((z, i) => {
    const gx = MARGIN + sp.labelW + i * sp.gruppeW;
    // Gruppen-Trennlinie
    if (i > 0) {
      pdf.setDrawColor(...LINIE);
      pdf.setLineWidth(0.15);
      pdf.line(gx, y, gx, y + h);
    }
    const istX = gx + sp.istW - 1;
    const budX = gx + sp.istW + sp.budgetW - 1;
    pdf.setFont('helvetica', row.bold ? 'bold' : 'normal');
    pdf.setFontSize(8.4);
    if (!z) {
      pdf.setTextColor(...GRAU);
      pdf.text('—', istX, baseY, { align: 'right' });
      pdf.text('—', budX, baseY, { align: 'right' });
      return;
    }
    // Ist = Anker: halbfett und etwas grösser als Budget.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(row.bold ? 9 : 8.6);
    pdf.setTextColor(...DUNKEL);
    pdf.text(z.ist.text, istX, baseY, { align: 'right' });
    if (z.ist.ampel && !schmal) {
      // Ampel-Badge im Chip-Stil: hell getönt, dunkle Schrift, rechtsbündig.
      const label = z.ist.ampel.label;
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(6);
      const tw = pdf.getTextWidth(label);
      const padX = 1.6;
      const bw = tw + 2 * padX;
      const bh = 3.4;
      const bx = istX - bw;
      const by = baseY + 1.2;
      pdf.setFillColor(...CHIP_BG[z.ist.ampel.stufe]);
      pdf.roundedRect(bx, by, bw, bh, 0.9, 0.9, 'F');
      pdf.setTextColor(...CHIP_INK[z.ist.ampel.stufe]);
      pdf.text(label, bx + padX, by + 2.4);
    } else if (z.ist.sub && !schmal) {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.2);
      pdf.setTextColor(...GRAU);
      // Einzeilig auf die Zellenbreite gekürzt — darf nie in Nachbarspalten bluten.
      pdf.text(einzeilig(pdf, z.ist.sub, sp.istW + sp.budgetW - 4), istX, baseY + 3.5, { align: 'right' });
    }
    // Budget (dezenter als Ist — kleiner, normalgewichtig, --ink2)
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.8);
    pdf.setTextColor(...GRAU2);
    pdf.text(z.budget.text, budX, baseY, { align: 'right' });
    // Δ-Chip: dezent (hell getönt, dunkle Schrift), nur so breit wie nötig,
    // RECHTSBÜNDIG am rechten Zellenrand. CHF gross, % klein darunter.
    const deltaRechts = gx + sp.istW + sp.budgetW + sp.deltaW - 1;
    if (z.delta) {
      // Chip-Text muss DETERMINISTISCH in die Δ-Spalte passen: Fontgrösse
      // wird notfalls reduziert, bis der breiteste Text in chipW-2·padX
      // passt — nie über den Chip-Hintergrund hinaus zeichnen (blutet sonst
      // in engen Mehr-Gruppen-Ansichten in die Budget-Spalte).
      const padX = 1.8;
      const maxChipW = sp.deltaW - 2;
      const maxTextW = maxChipW - 2 * padX;
      // Grösse verkleinern; passt es selbst bei min nicht, wird der Text mit
      // «…» gekürzt — es wird GARANTIERT nie breiter als maxTextW gezeichnet.
      const fitText = (text: string, start: number, min: number): { text: string; size: number } => {
        for (let s = start; s > min; s -= 0.2) {
          pdf.setFontSize(s);
          if (pdf.getTextWidth(text) <= maxTextW) return { text, size: s };
        }
        pdf.setFontSize(min);
        return { text: einzeilig(pdf, text, maxTextW), size: min };
      };
      // Abw.-Werte bewusst NICHT fett (Lesbarkeit) — Farbchip bleibt.
      pdf.setFont('helvetica', 'normal');
      const haupt = fitText(z.delta.haupt, 7.2, 5.4);
      pdf.setFontSize(haupt.size);
      const wHaupt = pdf.getTextWidth(haupt.text);
      let sub: { text: string; size: number } | null = null;
      let wSub = 0;
      if (z.delta.sub) {
        pdf.setFont('helvetica', 'normal');
        sub = fitText(z.delta.sub, 5.8, 4.8);
        pdf.setFontSize(sub.size);
        wSub = pdf.getTextWidth(sub.text);
      }
      const chipW = Math.min(maxChipW, Math.max(wHaupt, wSub) + 2 * padX);
      const chipH = sub ? 7.6 : 4.8;
      const cx = deltaRechts - chipW;
      const cy = y + (h - chipH) / 2;
      pdf.setFillColor(...CHIP_BG[z.delta.ton]);
      pdf.roundedRect(cx, cy, chipW, chipH, 1, 1, 'F');
      pdf.setTextColor(...CHIP_INK[z.delta.ton]);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(haupt.size);
      pdf.text(haupt.text, deltaRechts - padX, cy + (sub ? 3.3 : chipH / 2 + 1.4), { align: 'right' });
      if (sub) {
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(sub.size);
        pdf.text(sub.text, deltaRechts - padX, cy + 6.2, { align: 'right' });
      }
    } else {
      // NULL / keine Änderung: unauffälliges «—» (kein grauer Block).
      pdf.setTextColor(...GRAU);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      pdf.text('—', deltaRechts, baseY, { align: 'right' });
    }
  });
}

const FUSS_H = 8; // Platz für die Fusszeile (Seitenzahl setzt der Orchestrator)

/**
 * Zeichnet einen Report ins übergebene jsPDF (beginnend auf einer NEUEN Seite,
 * ausser das Dokument ist noch leer und `ersteSeiteNutzen` gesetzt). Bricht
 * automatisch um. Fusszeilen/Seitenzahlen setzt der Aufrufer am Ende.
 */
/** Max. Wochengruppen pro Seite — mehr wird auf Folgeseiten fortgesetzt
 *  (8-Wochen-Verlauf würde sonst unlesbar schmal / Chips würden clippen). */
export const MAX_GRUPPEN_PRO_SEITE = 4;

export function zeichneCockpitReport(
  pdf: jsPDF,
  model: CrReportModel,
  branding: RestaurantBranding,
  logo: string | null,
  heute: Date,
  ersteSeiteNutzen: boolean,
): void {
  // Horizontale Pagination: >4 Wochengruppen in Teil-Reports splitten.
  if (model.gruppen.length > MAX_GRUPPEN_PRO_SEITE) {
    const teile = Math.ceil(model.gruppen.length / MAX_GRUPPEN_PRO_SEITE);
    for (let t = 0; t < teile; t++) {
      const von = t * MAX_GRUPPEN_PRO_SEITE;
      const bis = von + MAX_GRUPPEN_PRO_SEITE;
      const teil: CrReportModel = {
        ...model,
        zeitraum: `${model.zeitraum} · Teil ${t + 1}/${teile}`,
        gruppen: model.gruppen.slice(von, bis),
        sektionen: model.sektionen.map(s => ({
          titel: s.titel,
          rows: s.rows.map(r => ({ ...r, zellen: r.zellen.slice(von, bis) })),
        })),
      };
      zeichneCockpitReport(pdf, teil, branding, logo, heute, ersteSeiteNutzen && t === 0);
    }
    return;
  }
  if (!ersteSeiteNutzen) pdf.addPage('a4', 'landscape');
  const sp = berechneSpalten(model.gruppen.length);

  let y = zeichneKopf(pdf, model, branding, logo, heute, false);
  y = zeichneTabellenkopf(pdf, model, sp, y, branding.accentColor);

  let zebra = false;
  const neueSeite = (): void => {
    pdf.addPage('a4', 'landscape');
    y = zeichneKopf(pdf, model, branding, logo, heute, true);
    y = zeichneTabellenkopf(pdf, model, sp, y, branding.accentColor);
  };

  for (const sektion of model.sektionen) {
    const sektH = 4.6;
    if (y + sektH + 8 > PAGE_H - MARGIN - FUSS_H) neueSeite();
    // Sektions-Kopfzeile (schlank)
    pdf.setFillColor(...SEKTION_BG);
    pdf.rect(MARGIN, y, CONTENT_W, sektH, 'F');
    pdf.setFillColor(...branding.accentColor);
    pdf.rect(MARGIN, y, 1.6, sektH, 'F');
    pdf.setTextColor(...DUNKEL);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.8);
    pdf.text(sektion.titel.toUpperCase(), MARGIN + 4, y + 3.3);
    y += sektH + 0.5;
    zebra = false;

    for (const row of sektion.rows) {
      const h = rowHoehe(row);
      if (y + h > PAGE_H - MARGIN - FUSS_H) neueSeite();
      zeichneZeile(pdf, row, sp, y, h, zebra, model.gruppen.length > 1);
      zebra = !zebra;
      y += h;
    }
    y += 1.6;
  }
  // KEINE Legende mehr — nur Kopfband + Tabelle + schmale Fusszeile.
}

/**
 * Fusszeilen für ALLE Seiten des Dokuments (Seitenzahl rechts, Firma links) —
 * am Ende aufrufen, wenn die Gesamtseitenzahl feststeht.
 */
export function zeichneFusszeilen(pdf: jsPDF, companyLine: string): void {
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i);
    const w = pdf.internal.pageSize.getWidth();
    const hgt = pdf.internal.pageSize.getHeight();
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.8);
    pdf.setTextColor(...GRAU);
    pdf.text(companyLine, MARGIN, hgt - 5);
    pdf.text(`Seite ${i} / ${n}`, w - MARGIN, hgt - 5, { align: 'right' });
  }
}

/** Standalone-Export: ein oder mehrere Report-Modelle als eine PDF-Datei. */
export async function exportCockpitReportPdf(
  models: CrReportModel[],
  branding: RestaurantBranding,
  fileName: string,
  heute: Date = new Date(),
): Promise<void> {
  if (models.length === 0) return;
  const [{ default: jsPDF }, { renderLogoDataUrl }] = await Promise.all([
    import('jspdf'),
    import('@/lib/pl-branding'),
  ]);
  let logo: string | null = null;
  try { logo = (await renderLogoDataUrl(branding)) || null; } catch { logo = null; }
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  models.forEach((m, i) => zeichneCockpitReport(pdf, m, branding, logo, heute, i === 0));
  zeichneFusszeilen(pdf, branding.companyLine);
  pdf.save(`${fileName}.pdf`);
}
