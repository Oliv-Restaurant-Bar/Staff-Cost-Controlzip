/**
 * cockpit-monat-seite.ts
 * ======================
 * Gestaltete Vektor-Seite «Cockpit — Monatsübersicht» für den PDF-Export —
 * gleiches Design-System wie Waren-/Personal-Block (cockpit-block-stil.ts):
 * Kopfband, KPI-Karten-Zeile, 4 gruppierte Abschnitte (Umsatz & Gäste ·
 * Personal · Waren · Bewertungen) mit Abschnittsband, Zebra-Tabellen, Ampeln.
 *
 * WICHTIG: Reines Layout — die ZAHLEN kommen 1:1 aus den bereits geladenen
 * Monatsreport-Zeilen (MrRow, Monats-Granularität). Die Δ-Berechnung und
 * -Färbung repliziert EXAKT die Bildschirm-Logik der ReportTable
 * (deltaPp/deltaVsVj/deltaPctBasis/deltaInverted) — nie neu erfinden.
 * Kinder-Zeilen (childOf, z.B. 2/4-Sterne, Lieferanten-Aufklappungen) sind am
 * Bildschirm standardmässig eingeklappt und erscheinen auch hier nicht.
 */

import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { RestaurantBranding } from '@/lib/pl-branding';
import type { MrRow } from '@/lib/monatsreport';
import {
  M, MUTED, GRUEN_INK, ROT_INK, BLATT, GOLD,
  kopfband, folgeKopf, kpiZeileBoxen, abschnitt, tabellenStil,
  zeichneAmpelPunktFarbe, type KpiBox, type Rgb,
} from '@/lib/cockpit-block-stil';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const GRUEN_DOT: Rgb = [46, 160, 100];
const ROT_DOT: Rgb = [214, 69, 53];

export interface MonatsSeiteInput {
  year: number;
  month: number; // 1-basiert
  /** Stand-Datum der Ist-Werte (YYYY-MM-DD) oder null. */
  standBis: string | null;
  rows: MrRow[];
}

// ─── Formatierung (identisch zur Bildschirm-Tabelle) ─────────────────────────

const fmtNum = (v: number, dec = 2) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: dec, maximumFractionDigits: dec });

function fmtWert(v: number | null, fmt: MrRow['fmt'], pax?: number | null): string {
  if (v === null || v === undefined) return '';
  if (fmt === 'countPax') {
    // Hauptwert = PERSONEN (Budget-Einheit), Gruppen-Anzahl in Klammern.
    const n = fmtNum(v, 0);
    return pax !== null && pax !== undefined
      ? `${n} Pers. (${fmtNum(pax, 0)} Gruppen)` : `${n} Pers.`;
  }
  if (fmt === 'count' || fmt === 'hours') return fmtNum(v, 0);
  if (fmt === 'pct') return `${v.toFixed(1)} %`;
  return fmtNum(v);
}

function fmtDeltaAbs(v: number | null, fmt: MrRow['fmt']): string {
  if (v === null) return '';
  const s = v >= 0 ? '+' : '';
  if (fmt === 'count' || fmt === 'hours' || fmt === 'countPax') return `${s}${fmtNum(v, 0)}`;
  if (fmt === 'pct') return `${s}${v.toFixed(1)} PP`;
  return `${s}${fmtNum(v)}`;
}

// ─── Δ-Logik: 1:1 die ReportTable-Regeln (Monats-Granularität) ───────────────

interface ZeileBerechnet {
  label: string;
  ist: string;
  budget: string;
  /** Δ-Hauptwert (abs) + %-Unterzeile. */
  deltaAbs: string;
  deltaPct: string;
  /** Δ-Färbung (grün = Verbesserung, rot = Verschlechterung), null = neutral. */
  deltaInk: Rgb | null;
  /** Ist-Wert-Färbung (warnAbove/tint). */
  istInk: Rgb | null;
  /** Ampelpunkt vor dem Ist-Wert (WKQ/PKQ-Ziel-Kennzahlen). */
  ampel: Rgb | null;
  bold: boolean;
  /** Zusatz-Unterzeile beim Ist (z.B. WKQ-% bei Warenkosten total). */
  istSub: string | null;
}

function berechneZeile(row: MrRow): ZeileBerechnet | null {
  if (row.type !== 'data') return null;
  const ist = row.month ?? null;
  const budget = row.monthBudget ?? null;
  const vj = row.vjMonth ?? null;

  let dev: number | null = null;
  let inverted = !!row.deltaInverted;
  // countPax (Gruppen): Hauptwert = Personen = Budget-Einheit → Δ vs. Budget
  // (Spec 08/2026, keine VJ-Sonderregel mehr).
  const useVj = row.deltaVsVj
    || (!!row.sharePct && budget === null);
  const devAbsBase = useVj ? vj : budget;
  const devAbs = ist !== null && devAbsBase !== null ? ist - devAbsBase : null;
  if (row.deltaPp) {
    dev = ist !== null && budget !== null ? ist - budget : null;
    inverted = true;
  } else if (useVj) {
    dev = ist !== null && vj !== null && vj > 0 ? ((ist - vj) / vj) * 100 : null;
  } else if (row.deltaPctBasis) {
    const basis = row.deltaPctBasis.month;
    dev = devAbs !== null && basis !== null && basis > 0 ? (devAbs / basis) * 100 : null;
  } else {
    dev = ist !== null && budget !== null && budget > 0 ? ((ist - budget) / budget) * 100 : null;
  }
  const deltaInk: Rgb | null = dev === null ? null
    : (inverted ? dev <= 0 : dev >= 0) ? GRUEN_INK : ROT_INK;

  // warnAbove (PKQ > 40 %) färbt den Ist-Wert rot; tint (5★ grün / 1★ rot).
  const istInk: Rgb | null =
    row.warnAbove != null && ist !== null && ist > row.warnAbove ? ROT_INK
      : row.tint === 'green' ? GRUEN_INK
        : row.tint === 'red' ? ROT_INK : null;

  // Ampelpunkt: WKQ-Inline (Warenkosten) über Ziel = rot; PKQ vs. warnAbove.
  const wkq = row.wkqInline?.month ?? null;
  let ampel: Rgb | null = null;
  if (wkq?.pct != null && wkq.ziel != null) ampel = wkq.pct <= wkq.ziel ? GRUEN_DOT : ROT_DOT;
  else if (row.warnAbove != null && ist !== null) ampel = ist <= row.warnAbove ? GRUEN_DOT : ROT_DOT;

  const deltaPct = dev === null ? ''
    : row.deltaPp ? `${dev >= 0 ? '+' : ''}${dev.toFixed(1)} PP`
      : `${dev >= 0 ? '+' : ''}${dev.toFixed(1)} %`;
  // Bei PP-Zeilen (Quoten) ist «abs» und «%» identisch → nur eine Zeile.
  const deltaAbs = row.deltaPp ? deltaPct : fmtDeltaAbs(devAbs, row.fmt);

  return {
    label: row.label ?? '',
    ist: fmtWert(ist, row.fmt, row.monthPax ?? null),
    budget: fmtWert(budget, row.fmt),
    deltaAbs,
    deltaPct: row.deltaPp ? '' : deltaPct,
    deltaInk, istInk, ampel,
    bold: !!row.bold,
    istSub: wkq?.pct != null ? `WKQ ${wkq.pct.toFixed(1)} %` : null,
  };
}

// ─── Abschnitts-Zuordnung ────────────────────────────────────────────────────

const PERSONAL_IDS = new Set([
  'produktivitaet', 'personalkosten', 'personalquote',
]);

type SektionKey = 'umsatz' | 'personal' | 'waren' | 'bewertungen';

function sektionFuer(row: MrRow): SektionKey {
  const id = row.id ?? '';
  if (id.startsWith('warenkosten')) return 'waren';
  if (/_(stern|sterne)$/.test(id)) return 'bewertungen';
  if (PERSONAL_IDS.has(id) || id.startsWith('prod_stunden') || id.startsWith('ueberstunden')) {
    return 'personal';
  }
  return 'umsatz';
}

// ─── KPI-Karten ──────────────────────────────────────────────────────────────

function kpiKarten(rows: MrRow[]): KpiBox[] {
  const byId = new Map<string, MrRow>();
  for (const r of rows) if (r.type === 'data' && r.id) byId.set(r.id, r);
  const boxen: KpiBox[] = [];
  const hinweis = (z: ZeileBerechnet | null): string =>
    z?.deltaPct ? ` (${z.deltaPct})` : z?.deltaAbs ? ` (${z.deltaAbs})` : '';

  const netto = byId.get('netto_umsatz');
  if (netto) {
    const z = berechneZeile(netto);
    boxen.push({ label: `Netto-Umsatz${hinweis(z)}`, wert: z?.ist ? `CHF ${z.ist}` : '–' });
  }
  const waren = byId.get('warenkosten_total');
  const wkq = waren?.wkqInline?.month ?? null;
  if (wkq?.pct != null) {
    const gut = wkq.ziel != null ? wkq.pct <= wkq.ziel : null;
    boxen.push({
      label: wkq.ziel != null ? `WKQ (Ziel max. ${wkq.ziel.toFixed(0)} %)` : 'WKQ',
      wert: `${wkq.pct.toFixed(1)} %`,
      ampel: gut === null ? undefined
        : gut ? { dot: GRUEN_DOT, ink: GRUEN_INK } : { dot: ROT_DOT, ink: ROT_INK },
    });
  }
  const pkq = byId.get('personalquote');
  if (pkq?.month != null) {
    const grenze = pkq.warnAbove ?? null;
    const gut = grenze != null ? pkq.month <= grenze : null;
    boxen.push({
      label: grenze != null ? `PKQ (max. ${grenze.toFixed(0)} %)` : 'Personalquote',
      wert: `${pkq.month.toFixed(1)} %`,
      ampel: gut === null ? undefined
        : gut ? { dot: GRUEN_DOT, ink: GRUEN_INK } : { dot: ROT_DOT, ink: ROT_INK },
    });
  }
  const prod = byId.get('produktivitaet');
  if (prod?.month != null) {
    const z = berechneZeile(prod);
    boxen.push({ label: `Produktivität${hinweis(z)}`, wert: fmtNum(prod.month) });
  }
  const gaeste = byId.get('gaeste_in');
  if (gaeste?.month != null) {
    const z = berechneZeile(gaeste);
    boxen.push({ label: `Gäste IN${hinweis(z)}`, wert: fmtNum(gaeste.month, 0) });
  }
  return boxen.slice(0, 5);
}

// ─── Seite zeichnen ──────────────────────────────────────────────────────────

export function zeichneMonatsUebersicht(
  pdf: jsPDF,
  input: MonatsSeiteInput,
  branding: RestaurantBranding,
  heute: Date,
): void {
  const { year, month, rows } = input;
  const zeitraum = `${MONATE[month - 1]} ${year}`;
  const titel = 'Cockpit — Monatsübersicht';
  // WICHTIG: beginnt auf der AKTUELLEN Seite (kein addPage am Anfang) — dieser
  // Teil ist im Mixed-Export immer der ERSTE Part (jsPDF legt Seite 1 selbst
  // an). Der Normalfall passt komplett auf eine Seite; NUR bei echtem Überlauf
  // (z. B. viele zusätzliche Zeilen) folgen Fortsetzungsseiten mit folgeKopf —
  // gleiche Degradation wie Waren-/Personal-Block, nie stilles Abschneiden.
  let y = kopfband(pdf, branding, titel, zeitraum, heute);

  y = kpiZeileBoxen(pdf, y, kpiKarten(rows));

  // Hauptzeilen (keine Trenner, keine eingeklappten Kinder) je Sektion.
  const sektionen: Record<SektionKey, Array<{ row: MrRow; z: ZeileBerechnet }>> = {
    umsatz: [], personal: [], waren: [], bewertungen: [],
  };
  for (const row of rows) {
    if (row.type !== 'data' || row.childOf) continue;
    const z = berechneZeile(row);
    if (z) sektionen[sektionFuer(row)].push({ row, z });
  }
  // «Ø-Verkauf pro Gast» gehört inhaltlich zu «Umsatz & Gäste»: direkt NACH
  // «Gruppen ab 20 Pax» und VOR «Gäste Take Away» einordnen (User-Vorgabe).
  {
    const u = sektionen.umsatz;
    const von = u.findIndex(e => e.row.id === 'avg_verkauf_gast');
    if (von >= 0) {
      const [avg] = u.splice(von, 1);
      const nachGruppen = u.findIndex(e => e.row.id === 'gruppen_ab_20');
      const vorTa = u.findIndex(e => e.row.id === 'gaeste_take_away');
      const ziel = nachGruppen >= 0 ? nachGruppen + 1 : vorTa >= 0 ? vorTa : u.length;
      u.splice(ziel, 0, avg);
    }
  }

  const standHinweis = input.standBis
    ? `Ist bis ${input.standBis.slice(8, 10)}.${input.standBis.slice(5, 7)}.` : 'Ist (Monat)';
  // Dichter als der Standard-Tabellenstil, damit alle 4 Abschnitte auf EINE
  // Seite passen (Anforderung «Seite füllen, kein Leerraum»).
  const basis = tabellenStil(branding);
  const stil = {
    ...basis,
    styles: { ...basis.styles, fontSize: 7.3, cellPadding: { top: 0.7, bottom: 0.7, left: 2.2, right: 2.2 } },
    headStyles: { ...basis.headStyles, fontSize: 7.2, cellPadding: { top: 1.2, bottom: 1.2, left: 2.2, right: 2.2 } },
    rowPageBreak: 'avoid' as const,
  };
  const rechts = { halign: 'right' as const };

  const titelFuer: Record<SektionKey, string> = {
    umsatz: 'Umsatz & Gäste', personal: 'Personal', waren: 'Waren', bewertungen: 'Bewertungen',
  };

  for (const key of ['umsatz', 'personal', 'waren', 'bewertungen'] as SektionKey[]) {
    const zeilen = sektionen[key];
    if (zeilen.length === 0) continue;
    // Abschnitt nie vom eigenen Tabellenkopf trennen: reicht der Platz für
    // Titel + Kopf + 2 Zeilen nicht mehr, auf die nächste Seite umbrechen.
    if (y > 258) {
      pdf.addPage('a4', 'portrait');
      folgeKopf(pdf, branding, titel);
      y = 16;
    }
    y = abschnitt(pdf, y, key === 'waren' ? GOLD : BLATT, titelFuer[key],
      key === 'umsatz' ? `${standHinweis} · Budget = Monat` : undefined);
    autoTable(pdf, {
      ...stil,
      startY: y,
      // «Δ» ist in jsPDF-Helvetica (WinAnsi) NICHT darstellbar → «Abw.».
      head: [['Kennzahl', 'Abw.', 'Ist (Monat)', 'Budget (Monat)']],
      body: zeilen.map(({ z }) => [
        z.label,
        z.deltaPct ? `${z.deltaAbs}\n${z.deltaPct}` : z.deltaAbs,
        z.istSub ? `${z.ist}\n${z.istSub}` : z.ist,
        z.budget,
      ]),
      columnStyles: { 0: { cellWidth: 74 }, 1: rechts, 2: rechts, 3: rechts },
      didParseCell: data => {
        if (data.section !== 'body') return;
        const z = zeilen[data.row.index]?.z;
        if (!z) return;
        if (z.bold) data.cell.styles.fontStyle = 'bold';
        if (data.column.index === 1) {
          // Abw.-Werte bewusst NICHT fett (Lesbarkeit) — Farbe bleibt.
          data.cell.styles.fontStyle = 'normal';
          if (z.deltaInk) data.cell.styles.textColor = z.deltaInk;
        }
        if (data.column.index === 2) {
          if (z.istInk) data.cell.styles.textColor = z.istInk;
          if (z.ampel) data.cell.styles.cellPadding = { top: 0.7, bottom: 0.7, left: 6.5, right: 2.2 };
        }
      },
      didDrawCell: data => {
        if (data.section !== 'body') return;
        const z = zeilen[data.row.index]?.z;
        if (!z) return;
        // %-Unterzeile der Δ-Spalte & Ist-Unterzeile dezent klein nachfärben:
        // autoTable rendert beide Zeilen gleich — kleine zweite Zeile wird
        // durch die geringe Schriftgrösse der Zelle bereits abgesetzt.
        if (data.column.index === 2 && z.ampel) {
          zeichneAmpelPunktFarbe(pdf, data.cell, z.ampel);
        }
      },
      didDrawPage: data => {
        if (data.pageNumber > 1) folgeKopf(pdf, branding, titel);
      },
    });
    y = (pdf as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable!.finalY + 3;
  }

  // Fussnote (füllt den Abschluss der Seite sauber).
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.8);
  pdf.setTextColor(...MUTED);
  pdf.text(
    'Abw. = Ist - Budget (Quoten in PP, Anteil-Zeilen vs. Vorjahr) · leere Felder = keine Datenquelle (nie 0) · '
    + 'Ampel: WKQ/PKQ über Ziel = rot',
    M, Math.min(y + 2, 285),
  );
}
