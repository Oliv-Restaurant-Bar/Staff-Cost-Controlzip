/**
 * cockpit-personal-block.ts — optionaler Personal-Block für den Cockpit-PDF-Export.
 * ==================================================================================
 * Drei zusätzliche Seiten (je eigene Seite) für den GEWÄHLTEN Monat/Stichtag —
 * gleiches Report-Design wie der Waren-Block (Kopfband, KPI-Zeile, Zebra,
 * Chips/Ampel; Fusszeile zentral via zeichneFusszeilen):
 *
 *  A) Überstunden Wochen-Ansicht — IMMER die letzten 4 Kalenderwochen bis zum
 *     Stichtag (rollierend). Je Fix-MA: Pensum · Wochen-Saldo je KW · Laufend.
 *     «Keine Zeiterfassung»-MA: «–» + Chip «ausgenommen · kein ÜStd-Konto»,
 *     NICHT im Total. Quelle: ueberstunden.ts (SSOT, leer statt 0).
 *
 *  B) Flex Kosten pro Mitarbeiter — Name · Abt. · Total AG/h · Plan Std ·
 *     Ist Std · Flex Plan · Flex Ist · Diff. Plan = ganzer Monat (Dienstplan),
 *     Ist = NUR hochgeladene Ist-Stunden (leer statt 0, kein Plan-Fallback).
 *     Quelle: personalkosten.ts (ladePersonalkostenDaten, Lohn-SSOT inkl.
 *     ::flexsplit und «ohne AG»-Flags via employee-rate.ts).
 *
 *  C) Flex-Auswertung Plan vs. Ist je KW — nur Wochen MIT hochgeladenem Ist
 *     (Wochen ohne Ist werden WEGGELASSEN, nicht als 0). Status-Punkt:
 *     grün = im/unter Plan · amber = bis 5 % darüber · rot = >5 % darüber.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TenantId } from '@/contexts/TenantContext';
import type { RestaurantBranding } from '@/lib/pl-branding';
import {
  ladeUeberstundenJahr, mondayOf, isoWeekOf, VOLLZEIT_WOCHE_H, UEBERSTUNDEN_START,
} from '@/lib/ueberstunden';
import { ladePersonalkostenDaten, type PersonalkostenDaten } from '@/lib/personalkosten';
import { loadSocialCostRates } from '@/lib/social-costs-db';
import { getEmployerCostRate, getEffectiveHourlyRate } from '@/lib/employee-rate';
import { loadScheduleForMonth, loadActualHoursForMonth } from '@/lib/supabase-db';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import {
  PW, M, INK2, MUTED, GRUEN_INK, AMBER_INK, ROT_INK, type Rgb,
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

export interface PbFlexMaZeile {
  name: string;
  dept: string;
  /** Total AG-Kosten pro Stunde (CHF/h); null = Lohn fehlt. */
  satz: number | null;
  /** true = ohne AG-Sozialkosten gerechnet (Flag pro Flex-MA). */
  agOff: boolean;
  planH: number;
  istH: number;   // nur hochgeladenes Ist
  planChf: number;
  istChf: number;
  diffChf: number; // Ist − Plan
}

export interface PbWochenZeile {
  label: string;      // «KW 32»
  von: string;        // ISO (auf Monat geklemmt)
  bis: string;
  planChf: number;
  istChf: number;
  diffChf: number;    // Ist − Plan
  diffPct: number | null;
  kumAbw: number;
}

export interface PersonalBlockDaten {
  monatLabel: string;
  /** Überstunden-Teil (letzte 4 KWs bis Stichtag). */
  kwLabels: string[];
  ueZeilen: PbUeberstundenZeile[];
  totalLaufend: number | null;
  /** Flex-Teil. */
  flexZeilen: PbFlexMaZeile[];
  flexTotalPlanH: number;
  flexTotalIstH: number;
  flexTotalPlanChf: number;
  flexTotalIstChf: number;
  flexAgOffCount: number;
  wochen: PbWochenZeile[];
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

  // Pro MA (Name-basiert über Jahre gemerged; ids sind stabil): Saldi je KW.
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

  // ── B/C) Flex: Personalkosten-SSOT (Plan ganzer Monat, Ist nur Upload) ────
  const ratesBlob = await loadSocialCostRates(tenantId);
  const daten: PersonalkostenDaten = await ladePersonalkostenDaten(
    year, month, tenantId, tenantKey, ratesBlob.rates,
  );

  const flexZeilen: PbFlexMaZeile[] = [];
  let flexAgOffCount = 0;
  for (const emp of daten.flexEmployees) {
    const br = getEmployerCostRate(emp, daten.rates);
    const satz = br?.totalHourly ?? null;
    const agOff = br?.agOff === true;
    let planH = 0, istH = 0;
    for (const [_date, perEmp] of Object.entries(daten.planStdProTag)) {
      planH += perEmp[emp.id] ?? 0;
    }
    for (const [date, perEmp] of Object.entries(daten.istStdProTag)) {
      if (date <= heuteIso) istH += perEmp[emp.id] ?? 0;
    }
    if (planH <= 0 && istH <= 0) continue; // leer statt 0 — MA ohne Einsatz weglassen
    if (agOff) flexAgOffCount++;
    const istSplit = String(emp.id).endsWith('::flexsplit');
    flexZeilen.push({
      name: istSplit ? `${emp.name} (Stundenlohn-Phase)` : (emp.name ?? String(emp.id)),
      dept: emp.department ?? '–',
      satz, agOff,
      planH: r1(planH), istH: r1(istH),
      planChf: r2(planH * (satz ?? 0)),
      istChf: r2(istH * (satz ?? 0)),
      diffChf: r2(istH * (satz ?? 0) - planH * (satz ?? 0)),
    });
  }
  // Zusatzkosten-Zeilen für Fixlohn-MA (isAdditionalCost / isAdditionalCostPlan)
  // — identisch zur Flex-Kosten-Tabelle in PersonalFix (Plan aus Dienstplan-
  // Zusatz-Tagen, Ist aus als Zusatzkosten markierten Ist-Stunden).
  const monthDate = new Date(year, month - 1, 1);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const [scheduleRaw, actualRaw] = await Promise.all([
    loadScheduleForMonth(monthDate, tenantId),
    loadActualHoursForMonth(monthDate, tenantId),
  ]);
  for (const emp of daten.fixEmployees) {
    const wage = getEffectiveHourlyRate(emp, daten.rates);
    if (!wage) continue;
    let planH = 0, planChf = 0, istH = 0, istChf = 0;
    for (const [cellKey, ds] of Object.entries(scheduleRaw ?? {})) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== String(emp.id)) continue;
      if (typeof ds !== 'object' || ds == null || !(ds as { isAdditionalCostPlan?: boolean }).isAdditionalCostPlan) continue;
      const net = calculateDayNetHours(ds);
      if (net > 0) { planH += Math.round(net * 100) / 100; planChf += Math.round(net * wage * 100) / 100; }
    }
    for (const [cellKey, entry] of Object.entries(actualRaw ?? {})) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix) || date > heuteIso) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== String(emp.id)) continue;
      if (!entry?.isAdditionalCost) continue;
      const h = entry.hours ?? 0;
      if (h > 0) { istH += Math.round(h * 100) / 100; istChf += Math.round(h * wage * 100) / 100; }
    }
    if (planH <= 0 && istH <= 0) continue;
    flexZeilen.push({
      name: `${emp.name} (Zusatzkosten)`,
      dept: emp.department ?? '–',
      satz: wage, agOff: false,
      planH: r1(planH), istH: r1(istH),
      planChf: r2(planChf), istChf: r2(istChf),
      diffChf: r2(istChf - planChf),
    });
  }
  flexZeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  // ── C) Wochen: nur KWs MIT hochgeladenem Flex-Ist ─────────────────────────
  const flexIds = new Set(daten.flexEmployees.map(e => String(e.id)));
  const satzVonId = new Map<string, number>();
  for (const emp of daten.flexEmployees) {
    satzVonId.set(String(emp.id), getEmployerCostRate(emp, daten.rates)?.totalHourly ?? 0);
  }
  interface W { planChf: number; istChf: number; hatIst: boolean; von: string; bis: string; label: string }
  const wochenMap = new Map<string, W>();
  const wocheFuer = (date: string): W => {
    const mo = mondayOf(date);
    let w = wochenMap.get(mo);
    if (!w) {
      const { kw } = isoWeekOf(mo);
      w = { planChf: 0, istChf: 0, hatIst: false, von: date, bis: date, label: `KW ${kw}` };
      wochenMap.set(mo, w);
    }
    if (date < w.von) w.von = date;
    if (date > w.bis) w.bis = date;
    return w;
  };
  for (const [date, perEmp] of Object.entries(daten.planStdProTag)) {
    const w = wocheFuer(date);
    for (const [id, h] of Object.entries(perEmp)) {
      if (flexIds.has(id)) w.planChf += h * (satzVonId.get(id) ?? 0);
    }
  }
  for (const [date, perEmp] of Object.entries(daten.istStdProTag)) {
    if (date > heuteIso) continue;
    const w = wocheFuer(date);
    for (const [id, h] of Object.entries(perEmp)) {
      if (!flexIds.has(id)) continue;
      w.istChf += h * (satzVonId.get(id) ?? 0);
      w.hatIst = true;
    }
  }
  const wochen: PbWochenZeile[] = [];
  let kum = 0;
  for (const [mo, w] of [...wochenMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    void mo;
    if (!w.hatIst) continue; // «noch offen / kein Ist» — weglassen, nicht 0
    const plan = r2(w.planChf), ist = r2(w.istChf);
    const diff = r2(ist - plan);
    kum = r2(kum + diff);
    wochen.push({
      label: w.label, von: w.von, bis: w.bis,
      planChf: plan, istChf: ist, diffChf: diff,
      diffPct: plan > 0 ? r1((diff / plan) * 100) : null,
      kumAbw: kum,
    });
  }

  return {
    monatLabel: `${MONATE[month - 1]} ${year}`,
    kwLabels, ueZeilen, totalLaufend,
    flexZeilen,
    flexTotalPlanH: r1(flexZeilen.reduce((s, z) => s + z.planH, 0)),
    flexTotalIstH: r1(flexZeilen.reduce((s, z) => s + z.istH, 0)),
    flexTotalPlanChf: r2(flexZeilen.reduce((s, z) => s + z.planChf, 0)),
    flexTotalIstChf: r2(flexZeilen.reduce((s, z) => s + z.istChf, 0)),
    flexAgOffCount,
    wochen,
  };
}

// ─── PDF-Zeichnung ───────────────────────────────────────────────────────────

/** Status-Farbe Flex-Woche: grün = im/unter Plan · amber bis 5 % · rot >5 %. */
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
    { label: 'Flex Plan (Monat)', wert: `CHF ${fmtChf(d.flexTotalPlanChf)}` },
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

/** Fügt die drei Personal-Seiten ans PDF an (gleiches Design wie Waren-Block). */
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
      // Negative/positive Laufend-Werte einfärben.
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

  // ── B) Flex Kosten pro Mitarbeiter ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Personal · Flex Kosten pro Mitarbeiter', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Flex Kosten pro Mitarbeiter',
    `${d.flexZeilen.length} MA · ${d.flexAgOffCount} ohne AG-Sozialkosten gerechnet`);
  autoTable(pdf, {
    ...stil,
    styles: { ...stil.styles, fontSize: 7.8, cellPadding: { top: 1.7, bottom: 1.7, left: 2.2, right: 2.2 } },
    startY: y,
    head: [['Name', 'Abt.', 'Total AG/h', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff.']],
    body: [
      ...d.flexZeilen.map(z => [
        z.agOff ? `${z.name} *` : z.name,
        z.dept,
        z.satz === null ? 'Lohn fehlt' : fmtChf(z.satz),
        fmtH(z.planH), z.istH > 0 ? fmtH(z.istH) : '–',
        z.planChf > 0 ? fmtChf(z.planChf) : '–',
        z.istChf > 0 ? fmtChf(z.istChf) : '–',
        fmtChf(z.diffChf),
      ]),
      [{ content: 'Total', styles: { fontStyle: 'bold' as const } }, '', '',
        { content: fmtH(d.flexTotalPlanH), styles: { fontStyle: 'bold' as const, ...rechts } },
        { content: fmtH(d.flexTotalIstH), styles: { fontStyle: 'bold' as const, ...rechts } },
        { content: fmtChf(d.flexTotalPlanChf), styles: { fontStyle: 'bold' as const, ...rechts } },
        { content: fmtChf(d.flexTotalIstChf), styles: { fontStyle: 'bold' as const, ...rechts } },
        { content: fmtChf(r2(d.flexTotalIstChf - d.flexTotalPlanChf)), styles: { fontStyle: 'bold' as const, ...rechts } }],
    ] as Parameters<typeof autoTable>[1]['body'],
    columnStyles: { 2: rechts, 3: rechts, 4: rechts, 5: rechts, 6: rechts, 7: rechts },
    didDrawPage: mitFolgeKopf('Personal · Flex Kosten pro Mitarbeiter'),
  });
  const nachTabelle = (pdf as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY;
  if (typeof nachTabelle === 'number') {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text('Plan = ganzer Monat (Dienstplan) · Ist = nur hochgeladene Ist-Stunden (leer statt 0)'
      + (d.flexAgOffCount > 0 ? ' · * = ohne AG-Sozialkosten gerechnet' : ''),
      M, Math.min(nachTabelle + 4, 285));
  }

  // ── C) Flex-Auswertung Plan vs. Ist ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Personal · Flex-Auswertung Plan vs. Ist', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Wochen mit hochgeladenem Ist',
    'offene Wochen ohne Ist werden weggelassen');
  const statusZeilen = new Map<number, Rgb>();
  const wBody: Parameters<typeof autoTable>[1]['body'] = d.wochen.map((w, i) => {
    const farbe = flexStatusFarbe(w.diffPct, w.diffChf);
    statusZeilen.set(i, farbe);
    return [
      `${w.label}  (${fmtDat(w.von)}–${fmtDat(w.bis)})`,
      fmtChf(w.planChf), fmtChf(w.istChf),
      { content: fmtChf(w.diffChf), styles: { halign: 'right' as const, textColor: farbe } },
      { content: w.diffPct === null ? '–' : `${w.diffPct > 0 ? '+' : ''}${w.diffPct.toFixed(1)} %`, styles: { halign: 'right' as const, textColor: farbe } },
      fmtChf(w.kumAbw),
    ];
  });
  if (d.wochen.length > 0) {
    const letzte = d.wochen[d.wochen.length - 1];
    wBody.push([
      { content: 'Total (Wochen mit Ist)', styles: { fontStyle: 'bold' as const } },
      { content: fmtChf(r2(d.wochen.reduce((s, w) => s + w.planChf, 0))), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(r2(d.wochen.reduce((s, w) => s + w.istChf, 0))), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(letzte.kumAbw), styles: { fontStyle: 'bold' as const, ...rechts } },
      '', '',
    ]);
  }
  autoTable(pdf, {
    ...stil,
    startY: y,
    head: [['Woche', 'Flex Plan (CHF)', 'Flex Ist (CHF)', 'Diff. CHF', 'Diff. %', 'Kum. Abw.']],
    body: wBody,
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts, 5: rechts },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === 3 && statusZeilen.has(data.row.index)) {
        zeichneAmpelPunktFarbe(pdf, data.cell, statusZeilen.get(data.row.index)!);
      }
    },
    didDrawPage: mitFolgeKopf('Personal · Flex-Auswertung Plan vs. Ist'),
  });
  if (d.wochen.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.setTextColor(...INK2);
    pdf.text('Noch keine Woche mit hochgeladenen Ist-Stunden in diesem Monat.', M, y + 6);
  }
  void PW;
}
