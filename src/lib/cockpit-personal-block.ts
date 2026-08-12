/**
 * cockpit-personal-block.ts — optionaler Personal-Block für den Cockpit-PDF-Export.
 * ==================================================================================
 * Zwei zusätzliche Seiten (je eigene Seite) für den GEWÄHLTEN Monat/Stichtag —
 * gleiches Report-Design wie der Waren-Block (Kopfband, KPI-Zeile, Zebra,
 * Chips/Ampel; Fusszeile zentral via zeichneFusszeilen):
 *
 *  A) Überstunden Wochen-Ansicht — IMMER die letzten 4 Kalenderwochen bis zum
 *     Stichtag (rollierend). Je Fix-MA: Pensum · Wochen-Saldo je KW · Laufend.
 *     FARBLOGIK (Kosten): Überstunden (+) = ROT · Minusstunden (−) = GRÜN.
 *     «Keine Zeiterfassung»-MA: «–» + Chip «ausgenommen · kein ÜStd-Konto»,
 *     NICHT im Total. Quelle: ueberstunden.ts (SSOT, leer statt 0).
 *
 *  B) Flex-Auswertung Plan vs. Ist — VERSCHACHTELT je Woche & Mitarbeiter
 *     (wie die Waren-Anomalie-Analyse): pro Woche eine fette Kopfzeile
 *     (Zeitraum · Plan Std · Ist Std · Flex Plan · Flex Ist · Diff. mit
 *     Diff-% und Status-Ampelpunkt), darunter je Mitarbeiter eine Zeile.
 *     NUR Wochen MIT hochgeladenem Mirus-Ist (offene Wochen weggelassen,
 *     nicht als 0); je MA nur bis zum abgerechneten Stand. KEINE AG/h-Spalte.
 *     Die MA-Zeilen einer Woche summieren exakt aufs Wochentotal (Totale =
 *     Summe der gerundeten MA-Werte). Quelle: personalkosten.ts
 *     (ladePersonalkostenDaten, Lohn-SSOT inkl. ::flexsplit und «ohne AG»-
 *     Flags via employee-rate.ts).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TenantId } from '@/contexts/TenantContext';
import type { RestaurantBranding } from '@/lib/pl-branding';
import {
  ladeUeberstundenJahr, mondayOf, isoWeekOf, VOLLZEIT_WOCHE_H,
} from '@/lib/ueberstunden';
import { ladePersonalkostenDaten, type PersonalkostenDaten } from '@/lib/personalkosten';
import { loadSocialCostRates } from '@/lib/social-costs-db';
import { getEmployerCostRate } from '@/lib/employee-rate';
import {
  M, INK2, MUTED, GRUEN_INK, AMBER_INK, ROT_INK, type Rgb,
  kopfband, folgeKopf, kpiZeileBoxen, abschnitt, tabellenStil,
  zeichneChip, zeichneAmpelPunktFarbe,
} from '@/lib/cockpit-block-stil';

// ─── Datenmodell ─────────────────────────────────────────────────────────────

export interface PbUeberstundenZeile {
  name: string;
  /** Pensum in % (weeklyHours ÷ 42). */
  pensumPct: number;
  /** Wochen-Saldo je angezeigter KW (Reihenfolge = kwLabels); null = leer. */
  saldi: Array<number | null>;
  /** Laufendes Konto (ab Juli 2026) bis zum Stichtag; null = leer. */
  laufend: number | null;
  /** «Keine Zeiterfassung erforderlich» → ausgenommen, nicht im Total. */
  ausgenommen: boolean;
}

/** Mitarbeiter-Detailzeile innerhalb einer abgerechneten Woche. */
export interface PbWocheMaZeile {
  name: string;
  /** true = ohne AG-Sozialkosten gerechnet (Flag pro Flex-MA). */
  agOff: boolean;
  planH: number;
  istH: number;    // nur hochgeladenes Ist (bis Stichtag)
  planChf: number;
  istChf: number;
  diffChf: number; // Ist − Plan
}

export interface PbWochenZeile {
  label: string;      // «KW 32»
  von: string;        // ISO (auf Monat geklemmt)
  bis: string;
  planH: number;
  istH: number;
  planChf: number;
  istChf: number;
  diffChf: number;    // Ist − Plan
  diffPct: number | null;
  /** MA-Zeilen; summieren exakt aufs Wochentotal. */
  mitarbeiter: PbWocheMaZeile[];
}

export interface PersonalBlockDaten {
  monatLabel: string;
  /** Überstunden-Teil (letzte 4 KWs bis Stichtag). */
  kwLabels: string[];
  ueZeilen: PbUeberstundenZeile[];
  totalLaufend: number | null;
  /** Flex-Teil: nur Wochen MIT hochgeladenem Ist. */
  wochen: PbWochenZeile[];
  flexTotalPlanH: number;
  flexTotalIstH: number;
  flexTotalPlanChf: number;
  flexTotalIstChf: number;
  flexAgOffCount: number;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtChf = (n: number | null) =>
  n === null ? '–' : n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtH = (n: number | null) => (n === null ? '–' : `${r1(n).toFixed(1)} h`);
/** Saldo-Stunden mit Vorzeichen («leer statt 0» übernimmt der Aufrufer via null). */
const fmtSaldo = (n: number | null) =>
  n === null ? '–' : `${n > 0 ? '+' : ''}${r1(n).toFixed(1)}`;
const fmtDat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

function addTage(iso: string, tage: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + tage);
  return d.toISOString().slice(0, 10);
}

// ─── Datenladung ─────────────────────────────────────────────────────────────

/**
 * Lädt alle Personal-Block-Daten des gewählten Monats zum Stichtag `heuteIso`
 * (nur Tage ≤ Stichtag zählen als Ist; Zahlen 1:1 wie die Personal-Ansichten).
 */
export async function ladePersonalBlockDaten(
  tenantId: TenantId,
  tenantKey: (k: string) => string,
  year: number,
  month: number,
  heuteIso: string,
): Promise<PersonalBlockDaten> {
  // ── A) Überstunden: letzte 4 KWs bis zum Stichtag (rollierend) ────────────
  const stichMonday = mondayOf(heuteIso);
  const mondays = [-3, -2, -1, 0].map(i => addTage(stichMonday, i * 7));
  const kwLabels = mondays.map(mo => {
    const { kw } = isoWeekOf(mo);
    return `KW ${kw}`;
  });

  // Jahres-Ergebnisse laden (Fenster kann über den Jahreswechsel reichen).
  const jahre = [...new Set(mondays.map(mo => Number(mo.slice(0, 4))))];
  const jahresDaten = await Promise.all(
    jahre.map(j => ladeUeberstundenJahr(tenantId, tenantKey, j, heuteIso)),
  );
  type UeErg = NonNullable<Awaited<ReturnType<typeof ladeUeberstundenJahr>>>['ergebnis'];
  const ergebnisse: UeErg[] = [];
  for (const jd of jahresDaten) if (jd) ergebnisse.push(jd.ergebnis);

  // Pro MA (id-basiert über Jahre gemerged): Saldi je KW.
  const ueZeilen: PbUeberstundenZeile[] = [];
  const proId = new Map<string, PbUeberstundenZeile & { _laufendJeJahr: Array<number | null> }>();
  for (const erg of ergebnisse) {
    for (const ma of erg.mitarbeiter) {
      let z = proId.get(ma.id);
      if (!z) {
        z = {
          name: ma.name,
          pensumPct: Math.round((ma.wochenSollH / VOLLZEIT_WOCHE_H) * 100),
          saldi: mondays.map(() => null),
          laufend: null,
          ausgenommen: ma.ausgenommen,
          _laufendJeJahr: [],
        };
        proId.set(ma.id, z);
      }
      z.ausgenommen = z.ausgenommen || ma.ausgenommen;
      z._laufendJeJahr.push(ma.laufend);
      for (const w of ma.wochen) {
        const idx = mondays.indexOf(w.monday);
        if (idx >= 0 && w.saldo !== null) z.saldi[idx] = r1(w.saldo);
      }
    }
  }
  // Total NICHT aus gerundeten Zeilen summieren — SSOT-Totale der Lib nutzen
  // (identisch zur Überstunden-Seite; Ausgenommene sind dort bereits draussen).
  let totalLaufend: number | null = null;
  for (const erg of ergebnisse) {
    if (erg.totalLaufend !== null) totalLaufend = (totalLaufend ?? 0) + erg.totalLaufend;
  }
  if (totalLaufend !== null) totalLaufend = r1(totalLaufend);
  for (const z of proId.values()) {
    const werte = z._laufendJeJahr.filter((v): v is number => v !== null);
    z.laufend = z.ausgenommen ? null : werte.length > 0 ? r1(werte.reduce((s, v) => s + v, 0)) : null;
    const { _laufendJeJahr: _drop, ...zeile } = z;
    ueZeilen.push(zeile);
  }
  ueZeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  // ── B) Flex je Woche & Mitarbeiter: Personalkosten-SSOT ───────────────────
  const ratesBlob = await loadSocialCostRates(tenantId);
  const daten: PersonalkostenDaten = await ladePersonalkostenDaten(
    year, month, tenantId, tenantKey, ratesBlob.rates,
  );

  const flexIds = new Set(daten.flexEmployees.map(e => String(e.id)));
  const infoVonId = new Map<string, { name: string; agOff: boolean; satz: number }>();
  for (const emp of daten.flexEmployees) {
    const br = getEmployerCostRate(emp, daten.rates);
    const istSplit = String(emp.id).endsWith('::flexsplit');
    infoVonId.set(String(emp.id), {
      name: istSplit ? `${emp.name} (Stundenlohn-Phase)` : (emp.name ?? String(emp.id)),
      agOff: br?.agOff === true,
      satz: br?.totalHourly ?? 0,
    });
  }

  interface WMa { planH: number; istH: number; hatIst: boolean }
  interface W { von: string; bis: string; label: string; hatIst: boolean; ma: Map<string, WMa> }
  const wochenMap = new Map<string, W>();
  const wocheFuer = (date: string): W => {
    const mo = mondayOf(date);
    let w = wochenMap.get(mo);
    if (!w) {
      const { kw } = isoWeekOf(mo);
      w = { von: date, bis: date, label: `KW ${kw}`, hatIst: false, ma: new Map() };
      wochenMap.set(mo, w);
    }
    if (date < w.von) w.von = date;
    if (date > w.bis) w.bis = date;
    return w;
  };
  const maFuer = (w: W, id: string): WMa => {
    let m = w.ma.get(id);
    if (!m) { m = { planH: 0, istH: 0, hatIst: false }; w.ma.set(id, m); }
    return m;
  };
  for (const [date, perEmp] of Object.entries(daten.planStdProTag)) {
    const w = wocheFuer(date);
    for (const [id, h] of Object.entries(perEmp)) {
      if (flexIds.has(id)) maFuer(w, id).planH += h;
    }
  }
  for (const [date, perEmp] of Object.entries(daten.istStdProTag)) {
    if (date > heuteIso) continue;
    const w = wocheFuer(date);
    for (const [id, h] of Object.entries(perEmp)) {
      if (!flexIds.has(id)) continue;
      const m = maFuer(w, id);
      m.istH += h;
      m.hatIst = true;
      w.hatIst = true;
    }
  }

  const wochen: PbWochenZeile[] = [];
  const rohProWoche: Array<{ planH: number; istH: number }> = [];
  const agOffMitEinsatz = new Set<string>();
  for (const [mo, w] of [...wochenMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    void mo;
    if (!w.hatIst) continue; // «noch offen / kein Ist» — weglassen, nicht 0
    const maZeilen: PbWocheMaZeile[] = [];
    let planHRoh = 0, istHRoh = 0;
    for (const [id, m] of w.ma.entries()) {
      if (m.planH <= 0 && m.istH <= 0) continue; // leer statt 0
      const info = infoVonId.get(id);
      if (!info) continue;
      const planChf = r2(m.planH * info.satz);
      const istChf = r2(m.istH * info.satz);
      if (info.agOff) agOffMitEinsatz.add(id);
      planHRoh += m.planH; istHRoh += m.istH;
      maZeilen.push({
        name: info.name, agOff: info.agOff,
        planH: r1(m.planH), istH: r1(m.istH),
        planChf, istChf, diffChf: r2(istChf - planChf),
      });
    }
    maZeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    // CHF-Wochentotal = Summe der GERUNDETEN MA-Zeilen → Zeilen summieren exakt
    // auf. Stunden-Totale aus den ROH-Summen (wie die Personal-Ansichten).
    const planH = r1(planHRoh);
    const istH = r1(istHRoh);
    rohProWoche.push({ planH: planHRoh, istH: istHRoh });
    const planChf = r2(maZeilen.reduce((s, z) => s + z.planChf, 0));
    const istChf = r2(maZeilen.reduce((s, z) => s + z.istChf, 0));
    const diffChf = r2(istChf - planChf);
    wochen.push({
      label: w.label, von: w.von, bis: w.bis,
      planH, istH, planChf, istChf, diffChf,
      diffPct: planChf > 0 ? r1((diffChf / planChf) * 100) : null,
      mitarbeiter: maZeilen,
    });
  }

  return {
    monatLabel: `${MONATE[month - 1]} ${year}`,
    kwLabels, ueZeilen, totalLaufend,
    wochen,
    flexTotalPlanH: r1(rohProWoche.reduce((s, w) => s + w.planH, 0)),
    flexTotalIstH: r1(rohProWoche.reduce((s, w) => s + w.istH, 0)),
    flexTotalPlanChf: r2(wochen.reduce((s, w) => s + w.planChf, 0)),
    flexTotalIstChf: r2(wochen.reduce((s, w) => s + w.istChf, 0)),
    flexAgOffCount: agOffMitEinsatz.size,
  };
}

// ─── PDF-Zeichnung ───────────────────────────────────────────────────────────

/** Status-Farbe Flex-Diff (Kosten): unter/im Plan = grün · bis 5 % darüber = amber · sonst rot. */
function flexStatusFarbe(diffPct: number | null, diffChf: number): Rgb {
  if (diffChf <= 0) return GRUEN_INK;
  if (diffPct !== null && diffPct <= 5) return AMBER_INK;
  return ROT_INK;
}

function kpiZeile(pdf: jsPDF, y: number, d: PersonalBlockDaten): number {
  const laufendFarbe: Rgb = (d.totalLaufend ?? 0) > 0 ? ROT_INK : GRUEN_INK;
  const flexDiff = r2(d.flexTotalIstChf - d.flexTotalPlanChf);
  return kpiZeileBoxen(pdf, y, [
    {
      label: 'Überstunden Total laufend',
      wert: d.totalLaufend === null ? '–' : `${fmtSaldo(d.totalLaufend)} h`,
      ampel: { dot: laufendFarbe, ink: laufendFarbe },
    },
    { label: 'Flex Plan (abger. Wochen)', wert: `CHF ${fmtChf(d.flexTotalPlanChf)}` },
    { label: 'Flex Ist (hochgeladen)', wert: `CHF ${fmtChf(d.flexTotalIstChf)}` },
    {
      label: 'Flex Diff Ist-Plan', wert: `CHF ${fmtChf(flexDiff)}`,
      ampel: (() => {
        const f = flexStatusFarbe(d.flexTotalPlanChf > 0 ? (flexDiff / d.flexTotalPlanChf) * 100 : null, flexDiff);
        return { dot: f, ink: f };
      })(),
    },
  ]);
}

/** Kleine graue Legende unterhalb der zuletzt gezeichneten Tabelle. */
function legende(pdf: jsPDF, text: string): void {
  const nachTabelle = (pdf as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY;
  if (typeof nachTabelle !== 'number') return;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
  pdf.setTextColor(...MUTED);
  pdf.text(text, M, Math.min(nachTabelle + 4, 285));
}

/** Fügt die beiden Personal-Seiten ans PDF an (gleiches Design wie Waren-Block). */
export function zeichnePersonalBlock(
  pdf: jsPDF, d: PersonalBlockDaten, branding: RestaurantBranding, heute: Date = new Date(),
): void {
  const rechts = { halign: 'right' as const };
  const stil = tabellenStil(branding);
  const accent = branding.accentColor;

  const mitFolgeKopf = (titel: string) => {
    let erste = true;
    return () => {
      if (!erste) folgeKopf(pdf, branding, titel);
      erste = false;
    };
  };

  // ── A) Überstunden Wochen-Ansicht ──
  pdf.addPage('a4', 'portrait');
  let y = kopfband(pdf, branding, 'Personal · Überstunden Wochen-Ansicht', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, `Letzte 4 Kalenderwochen (${d.kwLabels.join(' · ')})`,
    'Wochen-Saldo = Ist − anteiliges Soll · leer statt 0');
  const ausgenommenChip = 'ausgenommen · kein ÜStd-Konto';
  const ueBody = [
    ...d.ueZeilen.map(z => [
      z.name,
      `${z.pensumPct} %`,
      ...(z.ausgenommen ? d.kwLabels.map(() => '–') : z.saldi.map(fmtSaldo)),
      z.ausgenommen ? ausgenommenChip : fmtSaldo(z.laufend),
    ]),
    [{ content: 'Total laufend', styles: { fontStyle: 'bold' as const } },
      '', ...d.kwLabels.map(() => ''),
      { content: d.totalLaufend === null ? '–' : `${fmtSaldo(d.totalLaufend)} h`, styles: { fontStyle: 'bold' as const, ...rechts } }],
  ];
  const laufendCol = 2 + d.kwLabels.length;
  autoTable(pdf, {
    ...stil,
    startY: y,
    head: [['Mitarbeiter', 'Pensum', ...d.kwLabels, 'Laufend']],
    body: ueBody as Parameters<typeof autoTable>[1]['body'],
    columnStyles: Object.fromEntries(
      Array.from({ length: laufendCol }, (_, i) => [i + 1, rechts]),
    ),
    didParseCell: data => {
      if (data.section === 'body' && data.column.index === laufendCol
          && data.cell.raw === ausgenommenChip) {
        data.cell.text = [''];
      }
      // Platz für den rechtsbündigen Chip: «–» der letzten KW-Spalte ausblenden
      if (data.section === 'body' && data.column.index === laufendCol - 1
          && data.row.raw && (data.row.raw as unknown[])[laufendCol] === ausgenommenChip) {
        data.cell.text = [''];
      }
      // Kosten-Farblogik: Überstunden (+) rot, Minusstunden (−) grün.
      if (data.section === 'body' && data.column.index >= 2 && typeof data.cell.raw === 'string') {
        if (data.cell.raw.startsWith('+')) data.cell.styles.textColor = ROT_INK;
        else if (data.cell.raw.startsWith('-') || data.cell.raw.startsWith('−')) data.cell.styles.textColor = GRUEN_INK;
      }
    },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === laufendCol
          && data.cell.raw === ausgenommenChip) {
        zeichneChip(pdf, data.cell, ausgenommenChip, 'grau', 'rechts');
      }
    },
    didDrawPage: mitFolgeKopf('Personal · Überstunden Wochen-Ansicht'),
  });
  legende(pdf, 'Farblogik (Kosten): Überstunden (+) = rot · Minusstunden (-) = grün · 0/leer neutral');

  // ── B) Flex-Auswertung Plan vs. Ist je Woche & Mitarbeiter ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Personal · Flex-Auswertung Plan vs. Ist', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Flex je Woche & Mitarbeiter — nur abgerechnete Wochen',
    'offene Wochen ohne hochgeladenes Ist werden weggelassen');
  const diffFarbe = (diff: number): Rgb => (diff < 0 ? GRUEN_INK : diff > 0 ? ROT_INK : INK2);
  const wBody: Parameters<typeof autoTable>[1]['body'] = [];
  const wochenKopfZeilen = new Map<number, Rgb>();
  let agOffSichtbar = false;
  for (const w of d.wochen) {
    const farbe = flexStatusFarbe(w.diffPct, w.diffChf);
    wochenKopfZeilen.set(wBody.length, farbe);
    const b = { fontStyle: 'bold' as const };
    wBody.push([
      { content: `${w.label}  (${fmtDat(w.von)}–${fmtDat(w.bis)})`, styles: b },
      { content: fmtH(w.planH), styles: { ...b, ...rechts } },
      { content: fmtH(w.istH), styles: { ...b, ...rechts } },
      { content: fmtChf(w.planChf), styles: { ...b, ...rechts } },
      { content: fmtChf(w.istChf), styles: { ...b, ...rechts } },
      {
        content: `${fmtChf(w.diffChf)}${w.diffPct === null ? '' : `  (${w.diffPct > 0 ? '+' : ''}${w.diffPct.toFixed(1)} %)`}`,
        styles: { ...b, ...rechts, textColor: farbe },
      },
    ]);
    for (const z of w.mitarbeiter) {
      if (z.agOff) agOffSichtbar = true;
      wBody.push([
        `   ${z.agOff ? `${z.name} *` : z.name}`,
        fmtH(z.planH), z.istH > 0 ? fmtH(z.istH) : '–',
        z.planChf > 0 ? fmtChf(z.planChf) : '–',
        z.istChf > 0 ? fmtChf(z.istChf) : '–',
        { content: fmtChf(z.diffChf), styles: { ...rechts, textColor: diffFarbe(z.diffChf) } },
      ]);
    }
  }
  if (d.wochen.length > 0) {
    const totalDiff = r2(d.flexTotalIstChf - d.flexTotalPlanChf);
    wBody.push([
      { content: 'Total (abgerechnete Wochen)', styles: { fontStyle: 'bold' as const } },
      { content: fmtH(d.flexTotalPlanH), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtH(d.flexTotalIstH), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(d.flexTotalPlanChf), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(d.flexTotalIstChf), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(totalDiff), styles: { fontStyle: 'bold' as const, ...rechts, textColor: diffFarbe(totalDiff) } },
    ]);
  }
  autoTable(pdf, {
    ...stil,
    styles: { ...stil.styles, fontSize: 7.6, cellPadding: { top: 1.5, bottom: 1.5, left: 2.2, right: 2.2 } },
    startY: y,
    head: [['Woche / Mitarbeiter', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff.']],
    body: wBody,
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts, 5: rechts },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === 5 && wochenKopfZeilen.has(data.row.index)) {
        zeichneAmpelPunktFarbe(pdf, data.cell, wochenKopfZeilen.get(data.row.index)!);
      }
    },
    didDrawPage: mitFolgeKopf('Personal · Flex-Auswertung Plan vs. Ist'),
  });
  if (d.wochen.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.setTextColor(...INK2);
    pdf.text('Noch keine Woche mit hochgeladenen Ist-Stunden in diesem Monat.', M, y + 6);
  } else {
    legende(pdf, 'Diff = Ist - Plan: unter Plan (Ersparnis) = grün · über Plan = rot'
      + ' · Plan = ganze Woche (Dienstplan), Ist = nur hochgeladene Ist-Stunden'
      + (agOffSichtbar ? ' · * = ohne AG-Sozialkosten gerechnet' : ''));
  }
}
