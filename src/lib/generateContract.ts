/**
 * Arbeitsvertrag-Generator für oLiv Restaurant & Bar
 *
 * Reproduziert die offiziellen GastroSuisse / L-GAV Vertragsvorlagen:
 *   SL = Stundenlohn-Vertrag  (Vorlage: Nora Anais Guggisberg)
 *   ML = Monatslohn-Vertrag   (Vorlage: Karel Novak)
 *
 * Layout: 2-spaltiger Aufbau wie im Original (Sektionen 1-7 nebeneinander),
 * Sektion 8 (Bruttolohn) vollbreite, Sektion 9-13 wieder 2-spaltig.
 */

import jsPDF from 'jspdf';
import { Employee } from '@/types/personnel';
import { calcSL, calcML, LGAV } from './salaryCalc';

// ── Konstanten ────────────────────────────────────────────────────────────────

const EMPLOYER_NAME = 'oLiv Restaurant & Bar (Oliv Gastro AG)';
const EMPLOYER_ADDR = 'Seftigenstrasse 101, 3007 Bern';

// Seitenränder (mm)
const PL  = 12;   // page left margin
const PR  = 198;  // page right margin
const COL = 104;  // column separator x-position
const LR  = 101;  // left column right edge
const RX  = 107;  // right column start

const LH5 = 4.5;  // line height small
const LH4 = 4.0;

// ── Typen ─────────────────────────────────────────────────────────────────────

interface Ctx {
  doc: jsPDF;
  yL: number;   // y-position left column
  yR: number;   // y-position right column
  page: number;
}

// ── Vertragstyp-Erkennung ─────────────────────────────────────────────────────

export function detectContractTemplate(emp: Employee): 'ML' | 'SL' {
  if (emp.contractType === 'monthly') return 'ML';
  if (emp.contractType === 'hourly' || emp.contractType === 'irregular') return 'SL';
  if (emp.monthlySalary && emp.monthlySalary > 0) return 'ML';
  return 'SL';
}

// ── Format-Hilfsfunktionen ────────────────────────────────────────────────────

function fd(iso?: string): string {
  if (!iso) return '___________';
  return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fc(v?: number | null, dec = 2): string {
  if (v == null || isNaN(v)) return '___________';
  return v.toFixed(dec);
}

function pct(r: number): string { return (r * 100).toFixed(2); }

function permitLabel(p?: string): string {
  const m: Record<string, string> = { swiss: 'CH', C: 'C', B: 'B', L: 'L', G: 'G', other: 'Andere' };
  return p ? (m[p] ?? p) : '___________';
}

function maritalLabel(m?: string): string {
  const map: Record<string, string> = { single: 'ledig', married: 'verheiratet', divorced: 'geschieden', widowed: 'verwitwet' };
  return m ? (map[m] ?? m) : '___________';
}

function deptLabel(d?: string): string {
  if (d === 'küche')   return 'Küche';
  if (d === 'service') return 'Service';
  return '___________';
}

function cb(checked: boolean): string {
  return checked ? '■' : '□';
}

// ── Low-level Zeichenfunktionen ───────────────────────────────────────────────

function setFont(doc: jsPDF, size: number, style: 'normal' | 'bold' | 'italic' = 'normal') {
  doc.setFont('helvetica', style);
  doc.setFontSize(size);
  doc.setTextColor(0, 0, 0);
}

function textL(doc: jsPDF, x: number, y: number, text: string, opts?: { maxWidth?: number }) {
  if (opts?.maxWidth) {
    const lines = doc.splitTextToSize(text, opts.maxWidth);
    doc.text(lines, x, y);
    return lines.length;
  }
  doc.text(text, x, y);
  return 1;
}

function hlineFullWidth(doc: jsPDF, y: number) {
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.2);
  doc.line(PL, y, PR, y);
}

function vlineSep(doc: jsPDF, yTop: number, yBot: number) {
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.15);
  doc.line(COL, yTop, COL, yBot);
}

// ── Seiten-Verwaltung ─────────────────────────────────────────────────────────

function addPage(ctx: Ctx): Ctx {
  ctx.doc.addPage();
  return { doc: ctx.doc, yL: 20, yR: 20, page: ctx.page + 1 };
}

function pageFooter(doc: jsPDF, page: number) {
  setFont(doc, 7, 'normal');
  doc.setTextColor(140, 140, 140);
  doc.text(`© GastroSuisse – L-GAV Arbeitsvertrag – Seite ${page}`, 105, 290, { align: 'center' });
  doc.text('oLiv Restaurant & Bar – Vertraulich', 105, 294, { align: 'center' });
}

// ── Seiten-Header ─────────────────────────────────────────────────────────────

function drawPageHeader(ctx: Ctx, template: 'ML' | 'SL'): Ctx {
  const { doc } = ctx;
  let y = 12;

  setFont(doc, 9, 'bold');
  doc.text('Der vorliegende Arbeitsvertrag berücksichtigt die Erfordernisse des L-GAV.', PL, y);

  y += 7;
  setFont(doc, 8, 'bold');
  if (template === 'SL') {
    doc.text('Arbeitsvertrag für', PL, y);
    setFont(doc, 8, 'normal');
    doc.text('Mitarbeiter/in mit unregelmässigem Pensum', PL + 38, y);
    setFont(doc, 7.5, 'italic');
    doc.text('(z.B. "Aushilfen" im Stundenlohn)', PL + 38, y + 4.5);
  } else {
    doc.text('Arbeitsvertrag', PL, y);
    setFont(doc, 8, 'normal');
    doc.text(`${cb(true)} a)  für Vollzeitmitarbeiter/in`, PL + 30, y);
    doc.text(`${cb(false)} b)  für Teilzeitmitarbeiter/in (mit regelmässigem, festgelegtem Arbeitspensum)`, PL + 30, y + 4.5);
    setFont(doc, 7, 'italic');
    doc.text('(Zutreffendes ankreuzen bzw. Ziff. 5 ausfüllen, sonst gilt Variante a Vollzeitmitarbeiter/in)', PL + 38, y + 9);
  }

  y += template === 'ML' ? 16 : 12;
  setFont(doc, 8, 'normal');
  doc.text(`zwischen  ${EMPLOYER_NAME}, ${EMPLOYER_ADDR}`, PL, y);
  setFont(doc, 7.5, 'italic');
  doc.text('Arbeitgeber/in', PR, y, { align: 'right' });

  y += 4;
  setFont(doc, 8, 'normal');
  doc.text('und', PL, y);

  return { ...ctx, yL: y + 5, yR: y + 5 };
}

// ── Persönliche Daten (Kopfblock) ─────────────────────────────────────────────

function drawPersonBlock(ctx: Ctx, emp: Employee): Ctx {
  const { doc } = ctx;
  let y = ctx.yL;

  hlineFullWidth(doc, y - 1);

  // Zeile 1: Name | Strasse | PLZ/Ort
  setFont(doc, 7.5, 'bold');
  doc.text('Name/Vorname', PL, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.name || '___________________', PL + 25, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Strasse', PL + 78, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.addressStreet || '___________________', PL + 90, y + 3.5);
  setFont(doc, 7.5, 'italic');
  doc.text('Mitarbeiter/in', PR, y + 3.5, { align: 'right' });

  y += 7;
  setFont(doc, 7.5, 'bold');
  doc.text('PLZ/Ort', PL + 78, y + 3.5);
  setFont(doc, 8, 'normal');
  const plzOrt = [emp.addressZip, emp.addressCity].filter(Boolean).join(' ') || '___________';
  doc.text(plzOrt, PL + 90, y + 3.5);

  // Zeile 2: Telefon | Handy | Geb | Zivilstand | Kinder
  y += 7;
  setFont(doc, 7.5, 'bold');
  doc.text('Telefon', PL, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.phone || '___________', PL + 14, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Handy', PL + 50, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Geburtsdatum', PL + 75, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(fd(emp.birthDate), PL + 101, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Zivilstand', PL + 133, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(maritalLabel(emp.maritalStatus), PL + 150, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Anzahl Kinder', PL + 172, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.numberOfChildren != null ? String(emp.numberOfChildren) : '-', PL + 190, y + 3.5);

  // Zeile 3: Krankenkasse | Ausweis | AHV-Nr.
  y += 7;
  setFont(doc, 7.5, 'bold');
  doc.text('Krankenkasse', PL, y + 3.5);
  setFont(doc, 7, 'italic');
  doc.text('(vom Mitarbeitenden selbst abgeschlossen)', PL + 24, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('Ausländerausweis', PL + 120, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(permitLabel(emp.permitType), PL + 147, y + 3.5);
  setFont(doc, 7.5, 'bold');
  doc.text('AHV-Nr.', PL + 160, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.ahvNumber || '___________________', PL + 174, y + 3.5);

  // Zeile 4: E-Mail
  y += 7;
  setFont(doc, 7.5, 'bold');
  doc.text('E-Mail', PL, y + 3.5);
  setFont(doc, 8, 'normal');
  doc.text(emp.email || '___________________', PL + 14, y + 3.5);

  y += 8;
  hlineFullWidth(doc, y);
  y += 3;

  setFont(doc, 7, 'italic');
  const note = 'Zur Erhöhung der Lesefreundlichkeit wird vorliegend vereinfachend auf die weibliche Form "Mitarbeiterin" verzichtet und an dieser Stelle vorab der Oberbegriff "Mitarbeitende" verwendet.';
  const lines = doc.splitTextToSize(note, PR - PL);
  doc.text(lines, PL, y);
  y += lines.length * 4 + 4;

  hlineFullWidth(doc, y);

  return { ...ctx, yL: y + 5, yR: y + 5 };
}

// ── Linke/Rechte Spalten-Hilfsfunktionen ─────────────────────────────────────

type Col = 'L' | 'R';

interface ColCtx {
  doc:  jsPDF;
  yL:   number;
  yR:   number;
}

function colX(col: Col): number  { return col === 'L' ? PL : RX; }
function colW(col: Col): number  { return col === 'L' ? LR - PL : PR - RX; }
function colY(ctx: ColCtx, col: Col): number { return col === 'L' ? ctx.yL : ctx.yR; }

function setColY(ctx: ColCtx, col: Col, y: number): ColCtx {
  return col === 'L' ? { ...ctx, yL: y } : { ...ctx, yR: y };
}

function sectionTitle(doc: jsPDF, col: Col, y: number, text: string): number {
  setFont(doc, 8, 'bold');
  doc.text(text, colX(col), y);
  return y + 5;
}

function sectionPara(doc: jsPDF, col: Col, y: number, text: string): number {
  setFont(doc, 7.5, 'normal');
  const lines = doc.splitTextToSize(text, colW(col));
  doc.text(lines, colX(col), y);
  return y + lines.length * LH5;
}

function sectionItem(doc: jsPDF, col: Col, y: number, check: boolean, letter: string, text: string, indent = 0): number {
  setFont(doc, 7.5, 'normal');
  const x = colX(col) + indent;
  doc.text(`${cb(check)} ${letter})`, x, y);
  const lines = doc.splitTextToSize(text, colW(col) - 14 - indent);
  doc.text(lines, x + 12, y);
  return y + Math.max(LH5, lines.length * LH5);
}

// ── Sektionen (linke Spalte) ──────────────────────────────────────────────────

function sec1(ctx: ColCtx, emp: Employee): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '1. Vertragsbeginn/Funktion/Beschäftigung');
  y = sectionPara(doc, 'L', y, 'Der vorliegende Vertrag tritt mit Unterzeichnung vollumfänglich an die Stelle allfälliger vorangehender Vereinbarungen und ersetzt diese vollständig.');
  y += 1;
  y = sectionPara(doc, 'L', y, 'Dieser Vertrag tritt nur in Kraft, sofern die notwendigen Arbeitsbewilligungen erteilt werden.');
  y += 2;
  setFont(doc, 7.5, 'normal');
  doc.text(`a)   Vertragsbeginn: ${fd(emp.contractStart)}`, PL, y); y += LH5;
  doc.text(`b)   Funktion: ${emp.positionTitle || '___________________'}`, PL, y); y += LH5;
  doc.text(`      Abteilung: ${deptLabel(emp.department)}`, PL, y); y += LH5 + 1;
  y = sectionPara(doc, 'L', y, 'Dem Mitarbeitenden können vorübergehend auch andere Arbeiten im Betrieb oder an einem zumutbaren anderen Arbeitsort zugewiesen werden.');
  y += 1;
  doc.text('c)   Beschäftigung in Raucherbetrieben und Raucherräumen:', PL, y); y += LH5;
  y = sectionItem(doc, 'L', y, true,  'aa', 'Der Mitarbeitende stimmt einer Beschäftigung in einem Raucherbetrieb oder in Raucherräumen zu.', 4);
  y = sectionItem(doc, 'L', y, false, 'bb', 'Der Mitarbeitende lehnt eine Beschäftigung in einem Raucherbetrieb ab.', 4);
  return setColY(ctx, 'L', y + 3);
}

function sec2(ctx: ColCtx, emp: Employee): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '2. Vertragsdauer');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  const isLimited = emp.isLimitedContract ?? false;
  y = sectionItem(doc, 'L', y, !isLimited, 'a', 'Der Vertrag wird auf unbestimmte Zeit abgeschlossen. Er ist gemäss Ziff. 3 und 4 kündbar.');
  y = sectionItem(doc, 'L', y, isLimited && !!emp.contractEnd,  'b', `Der Vertrag wird auf bestimmte Zeit abgeschlossen. Er dauert bis am ${fd(emp.contractEnd)}, ist aber kündbar.`);
  y = sectionItem(doc, 'L', y, false, 'c', 'Der Vertrag wird auf bestimmte Zeit abgeschlossen und ist nicht kündbar.');
  return setColY(ctx, 'L', y + 2);
}

function sec3(ctx: ColCtx, emp: Employee): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '3. Probezeit (Art. 5 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  const pm = emp.trialPeriodMonths ?? 3;
  y = sectionItem(doc, 'L', y, pm === 3 && !emp.trialPeriodMonths, 'a', 'Die Probezeit beträgt 3 Monate, die Kündigungsfrist beträgt 7 Tage.');
  y = sectionItem(doc, 'L', y, false, 'b', 'Die Probezeit beträgt 14 Tage, die Kündigungsfrist beträgt 3 Tage.');
  y = sectionItem(doc, 'L', y, pm === 0, 'c', 'Es besteht keine Probezeit.');
  y = sectionItem(doc, 'L', y, pm > 0 && pm <= 3, 'd', `Die Probezeit beträgt ${pm > 0 ? pm : '___'} Monat(e) (max. 3 Monate), die Kündigungsfrist beträgt 3 Tage (min. 3 Tage).`);
  return setColY(ctx, 'L', y + 2);
}

function sec4(ctx: ColCtx): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '4. Kündigung (Art. 6 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, true, 'a', 'Die Kündigungsfrist beträgt nach Ablauf der Probezeit 1 Monat (bzw. 2 Monate ab dem sechsten Dienstjahr), jeweils auf das Ende eines Monats.');
  y = sectionItem(doc, 'L', y, false, 'b', 'Allfällige längere Kündigungsfristen: ___________________________________________');
  return setColY(ctx, 'L', y + 2);
}

// ── Sektionen (rechte Spalte) ─────────────────────────────────────────────────

function sec5_SL(ctx: ColCtx, emp: Employee): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '5. Arbeitszeit und Ferien (Art. 15 und Art. 17 L-GAV)');
  const wh = emp.weeklyHours ?? 42;
  const pensum = Math.round(wh / 42 * 100);
  const vacDays = 35;
  const adjVac  = pensum < 100 ? Math.round(vacDays * pensum / 100) : vacDays;
  y = sectionPara(doc, 'R', y, 'Die einzelnen Arbeitseinsätze erfolgen jeweils nach Absprache im gegenseitigen Einvernehmen. Die durchschnittliche wöchentliche Arbeitszeit liegt unter 42 Stunden (in Kleinbetrieben unter 45 Stunden; in Saisonbetrieben unter 43,5 Stunden).');
  y += 1;
  y = sectionPara(doc, 'R', y, `Der Mitarbeitende hat Anspruch auf ${adjVac} Ferientage pro Dienstjahr (${vacDays} Tage bei 100%). Der Ferienlohn wird mit ${pct(LGAV.VACATION_RATE)}% des Bruttolohnes vergütet.`);
  y += 1;
  y = sectionPara(doc, 'R', y, `Der Mitarbeitende hat Anspruch auf 6 (0,5 Tage pro Monat) bezahlte Feiertage pro Kalenderjahr (Bundesfeiertag inbegriffen). Die Lohnzahlung für die Feiertage erfolgt durch eine Vergütung von ${pct(LGAV.PUBLIC_HOLIDAY_RATE)}% des Bruttolohnes.`);
  return setColY(ctx, 'R', y + 2);
}

function sec5_ML(ctx: ColCtx, emp: Employee): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '5. Arbeitszeit und Ferien (Art. 15 und Art. 17 L-GAV)');
  const wh = emp.weeklyHours ?? 42;
  const isVollzeit = wh >= 42;
  const vacDays = 35;
  const pensum  = Math.round(wh / 42 * 100);
  const adjVac  = isVollzeit ? vacDays : Math.round(vacDays * pensum / 100);

  setFont(doc, 7.5, 'bold');
  doc.text('a) Vollzeitmitarbeitende', RX, y); y += LH5;
  y = sectionPara(doc, 'R', y, 'Die durchschnittliche wöchentliche Arbeitszeit mit Einschluss der Präsenzzeit beträgt 42 Stunden, in Kleinbetrieben 45 Stunden. In Saisonbetrieben beträgt die durchschnittliche wöchentliche Arbeitszeit ganzjährig 43,5 Stunden.');
  y += 1;
  y = sectionPara(doc, 'R', y, `Der Ferienanspruch beträgt ${vacDays} Tage.`);
  y += 2;
  setFont(doc, 7.5, 'bold');
  doc.text('b) Teilzeitmitarbeitende', RX, y); y += LH5;
  y = sectionPara(doc, 'R', y, `Die durchschnittliche wöchentliche Arbeitszeit beträgt ${isVollzeit ? '___' : wh} Stunden. Der Ferienanspruch beträgt ${isVollzeit ? vacDays : adjVac} Tage (pro rata bei ${pensum}%).`);
  y += 2;
  setFont(doc, 7.5, 'bold');
  doc.text('c) Überstunden und Überzeit', RX, y); y += LH5;
  y = sectionPara(doc, 'R', y, 'Der Mitarbeitende ist im Rahmen des Zumutbaren zur Leistung von Überstunden und Überzeit verpflichtet. Kompensation durch Freizeit oder Auszahlung gemäss Art. 15 Ziff. 5 L-GAV.');
  return setColY(ctx, 'R', y + 2);
}

function sec6(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '6. Wichtige Hinweise');
  y = sectionPara(doc, 'R', y, 'Der Mitarbeitende ist orientiert: Über das Ende der Deckung für Berufsunfälle bei Beendigung des Arbeitsverhältnisses, die einunddreissigtägige Nachdeckung und die Abredeversicherung für Nichtberufsunfälle. Der Mitarbeitende ist verpflichtet, sich ab dem ersten Arbeitstag gemäss KVG für Krankenpflege zu versichern.');
  y += 1;
  y = sectionPara(doc, 'R', y, 'Gestützt auf die Lebensmittelgesetzgebung orientiert der Mitarbeitende den Arbeitgeber sofort bei Fieber, Durchfall, Erbrechen und eitrigen Wunden.');
  y += 1;
  y = sectionPara(doc, 'R', y, 'Sexuelle Belästigung und diskriminierendes Verhalten sind ausdrücklich untersagt. Entsprechendes Fehlverhalten kann zu einer fristlosen Kündigung führen.');
  return setColY(ctx, 'R', y + 2);
}

function sec7(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '7. Berufsausbildung');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante g)', RX, y); y += LH4;
  setFont(doc, 7.5, 'normal');
  doc.text('Der Mitarbeitende bestätigt folgende Berufsausbildung:', RX, y); y += LH5;
  const items = [
    ['a', 'mit eidgenössischem Berufsattest (EBA)'],
    ['b', 'mit eidgenössischem Fähigkeitszeugnis (EFZ)'],
    ['c', 'mit EFZ und mind. 6 Tage anerkannte Weiterbildung'],
    ['d', 'Berufsprüfung nach Art. 27 lit. a BBG'],
    ['e', 'mit anderem Zertifikat: ___________________________'],
    ['f', 'keine gastgewerbliche Berufslehre, aber Progresso-Ausbildung'],
    ['g', 'keine den L-GAV betreffende Ausbildung'],
  ];
  items.forEach(([letter, text]) => {
    y = sectionItem(doc, 'R', y, letter === 'g', letter, text);
  });
  return setColY(ctx, 'R', y + 2);
}

// ── Sektion 8: Bruttolohn (volle Breite) ──────────────────────────────────────

function sec8_SL(doc: jsPDF, y: number, emp: Employee): number {
  const factor  = emp.socialCostFactor ?? 1.13;
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.hourlyWage ?? 0;
  const sl      = calcSL(base, has13th, factor);

  hlineFullWidth(doc, y - 2);
  setFont(doc, 8, 'bold');
  doc.text('8. Bruttolohn (Art. 8 - 10 L-GAV)', PL, y); y += 5;
  setFont(doc, 7.5, 'normal');
  doc.text('Der Brutto-Stundenlohn setzt sich wie folgt zusammen:', PL, y); y += LH5 + 1;

  const labelX = PL + 4;
  const amtX   = 148;
  const refX   = 168;
  const w      = amtX - PL - 5;

  const lRow = (label: string, amount: string, ref: string) => {
    setFont(doc, 7.5, 'normal');
    doc.text(label, labelX, y);
    setFont(doc, 7.5, 'bold');
    doc.text(amount, amtX, y, { align: 'right' });
    setFont(doc, 7, 'italic');
    doc.text(ref, refX, y);
    y += LH5;
  };

  lRow(`- Stundenlohn (Basis-Stundenlohn brutto)`, `Fr.  ${fc(base)}`, '(1)');
  lRow(`- Ferienentschädigung (${pct(LGAV.VACATION_RATE)} %)`, `Fr.  ${fc(sl.vacationComp)}`, '(2)');
  lRow(`- Feiertagsentschädigung (${pct(LGAV.PUBLIC_HOLIDAY_RATE)} %)`, `Fr.  ${fc(sl.holidayComp)}`, '(3)');

  if (has13th) {
    lRow(`- 13. Monatslohn (Art. 12 L-GAV) — ${pct(LGAV.THIRTEENTH_RATE)} % auf Total (1)-(3)`, `Fr.  ${fc(sl.thirteenthComp)}`, '*');
    setFont(doc, 7, 'italic');
    doc.text('  * Berechnungsbasis: Total von (1) - (3)', labelX, y); y += LH4;
  } else {
    setFont(doc, 7.5, 'normal');
    doc.text('- 13. Monatslohn (Art. 12 L-GAV): nicht vereinbart', labelX, y); y += LH5;
  }

  y += 1;
  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.line(PL + 4, y, 160, y); y += 2;
  setFont(doc, 8, 'bold');
  doc.text('Total (Auszahlbarer Stundenlohn)', labelX, y);
  doc.text(`Fr.  ${fc(sl.totalPayableHourly)}`, amtX, y, { align: 'right' });
  y += LH5 + 1;

  // Interne Kostenstelle
  setFont(doc, 7.5, 'bold');
  doc.text(`Interner Stundenansatz (Kostenstelle) = Auszahlbarer Stundenlohn × AG-Sozialkostenfaktor ${factor.toFixed(2)}`, labelX, y);
  setFont(doc, 7.5, 'bold');
  doc.text(`Fr.  ${fc(sl.internalHourlyCost)}`, amtX, y, { align: 'right' });
  y += LH5 + 2;

  return y;
}

function sec8_ML(doc: jsPDF, y: number, emp: Employee): number {
  const factor  = emp.socialCostFactor ?? 1.13;
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.monthlySalary ?? 0;
  const wh      = emp.weeklyHours ?? 42;
  const ml      = calcML(base, has13th, wh, factor);

  hlineFullWidth(doc, y - 2);
  setFont(doc, 8, 'bold');
  doc.text('8. Bruttolohn (Art. 8 - 10 L-GAV)', PL, y); y += 5;
  setFont(doc, 7.5, 'normal');
  doc.text('Der monatliche Bruttolohn setzt sich wie folgt zusammen:', PL, y); y += LH5 + 1;

  const labelX = PL + 4;
  const amtX   = 148;

  const lRow = (label: string, amount: string) => {
    setFont(doc, 7.5, 'normal');
    doc.text(label, labelX, y);
    setFont(doc, 7.5, 'bold');
    doc.text(amount, amtX, y, { align: 'right' });
    y += LH5;
  };

  lRow('- Festlohn (Monatslohn brutto, laut Vertrag)', `Fr.  ${fc(base)}`);
  if (has13th) {
    lRow(`- monatl. Anteil 13. Monatslohn (Art. 12 L-GAV, ${pct(1/12)} % = 1/12)`, `Fr.  ${fc(ml.effectiveMonthlyGross - base)}`);
  } else {
    setFont(doc, 7.5, 'normal');
    doc.text('- 13. Monatslohn: nicht vereinbart', labelX, y); y += LH5;
  }

  y += 1;
  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.line(PL + 4, y, 160, y); y += 2;
  setFont(doc, 8, 'bold');
  const grossLabel = has13th ? 'Total (Effektiver monatlicher Bruttolohn inkl. 13. ML)' : 'Total (Monatlicher Bruttolohn)';
  doc.text(grossLabel, labelX, y);
  doc.text(`Fr.  ${fc(ml.effectiveMonthlyGross)}`, amtX, y, { align: 'right' });
  y += LH5 + 1;

  // AG-Sozialkosten
  setFont(doc, 7.5, 'normal');
  doc.text(`+ AG-Sozialkosten ${((factor - 1) * 100).toFixed(1)} % (AN-Beiträge exkl.)`, labelX, y);
  setFont(doc, 7.5, 'bold');
  doc.text(`Fr.  ${fc(ml.socialCostMonthly)}`, amtX, y, { align: 'right' });
  y += LH5;

  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.line(PL + 4, y, 160, y); y += 2;
  setFont(doc, 8, 'bold');
  doc.text('Vollkosten pro Monat (AG-Gesamtkosten)', labelX, y);
  doc.text(`Fr.  ${fc(ml.totalMonthlyEmployerCost)}`, amtX, y, { align: 'right' });
  y += LH5 + 1;

  // Interner Stundenansatz
  setFont(doc, 7.5, 'bold');
  doc.text(`Interner Stundenansatz (Kostenstelle) = Vollkosten pro Monat ÷ ${LGAV.MONTHLY_HOURS} h`, labelX, y);
  doc.text(`Fr.  ${fc(ml.internalHourlyCost)}`, amtX, y, { align: 'right' });
  y += LH5 + 2;

  return y;
}

// ── Sektionen 9-13 (2-spaltig, Seite 2) ─────────────────────────────────────

function sec9(ctx: ColCtx): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '9. Lohnreduktion Einführungszeit (Art. 10 L-GAV)');
  setFont(doc, 7.5, 'bold');
  doc.text('Mindestlohnstufe I (ungelernte Mitarbeitende)', PL, y); y += LH4;
  setFont(doc, 7, 'italic');
  doc.text('(WICHTIG: Zutreffendes ankreuzen, sonst gilt Variante b)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, false, 'a', 'Der Mitarbeitende war nie mindestens 4 Monate in einem L-GAV-Betrieb angestellt. Reduktion für erste 12 Monate um 8%.');
  y = sectionItem(doc, 'L', y, false, 'b', 'Der Mitarbeitende hat bereits mehr als 4 Monate in einem L-GAV-Betrieb gearbeitet. Reduktion für erste 3 Monate um 8%.');
  y = sectionItem(doc, 'L', y, true,  'c', 'Auf eine Lohnreduktion während der Einführungszeit wird verzichtet.');
  y += 2;
  setFont(doc, 7.5, 'bold');
  doc.text('Mindestlohnstufen II und IIIa (EBA und EFZ)', PL, y); y += LH4;
  setFont(doc, 7, 'italic');
  doc.text('(WICHTIG: Zutreffendes ankreuzen, sonst gilt Variante b)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, false, 'a', 'Erste Anstellung in einem L-GAV-Betrieb nach Abschluss der Ausbildung. Reduktion für erste 3 Monate um 8%.');
  y = sectionItem(doc, 'L', y, true,  'b', 'Es besteht keine Lohnreduktion während der Einführungszeit.');
  return setColY(ctx, 'L', y + 2);
}

function sec10L(ctx: ColCtx): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '10. Abzüge / Zulagen / Lohnauszahlung (Art. 13 und 14 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Vorbehalten bleiben Gesetzes- oder Prämienänderungen.)', PL, y); y += LH4;
  setFont(doc, 7.5, 'bold');
  doc.text('a) Abzüge', PL, y); y += LH5;
  const abzuege = [
    ['AHV/IV/EO', '5.3 %'],
    ['Arbeitslosenversicherung', '1.1 %'],
    ['Berufliche Vorsorge (BVG)', ''],
    ['Nichtberufsunfallversicherung', ''],
    ['Krankengeldversicherung', ''],
    ['Quellensteuer', ''],
    ['Vollzugskostenbeitrag L-GAV', ''],
  ];
  setFont(doc, 7.5, 'normal');
  abzuege.forEach(([label, pctVal]) => {
    doc.text(`- ${label}`, PL + 2, y);
    if (pctVal) { setFont(doc, 7, 'italic'); doc.text(pctVal, PL + 60, y); setFont(doc, 7.5, 'normal'); }
    doc.text('- Fr.', LR - 14, y, { align: 'right' });
    y += LH4;
  });
  return setColY(ctx, 'L', y + 2);
}

function sec10R(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  setFont(doc, 7.5, 'bold');
  doc.text('b) Monatliche Zulagen', RX, y); y += LH5;
  setFont(doc, 7.5, 'normal');
  doc.text('- Kinderzulagen                               + Fr.', RX, y); y += LH4;
  doc.text('- Entschädigung Berufswäsche (Art. 30 L-GAV)  + Fr.', RX, y); y += LH4;
  y += 1;
  setFont(doc, 7.5, 'bold');
  doc.text('Netto-Monatslohn                               Fr.', RX, y); y += LH5 + 2;

  setFont(doc, 7.5, 'bold');
  doc.text('c) Jährlicher Abzug', RX, y); y += LH5;
  setFont(doc, 7.5, 'normal');
  doc.text('- Vollzugskostenbeitrag L-GAV (jährl.)         - Fr.  89.–', RX, y); y += LH5 + 2;

  setFont(doc, 7.5, 'bold');
  doc.text('d) Lohnauszahlung', RX, y); y += LH5;
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', RX, y); y += LH4;
  y = sectionItem(doc, 'R', y, false, 'a', 'Der Lohn wird spätestens am Letzten des Monats ausbezahlt.');
  y = sectionItem(doc, 'R', y, true,  'b', 'Der Lohn wird spätestens am 6. des folgenden Monats ausbezahlt.');
  y = sectionItem(doc, 'R', y, false, 'c', 'Lohnauszahlung gemäss Art. 14 Ziff. 1 Abs. 2 L-GAV.');
  return setColY(ctx, 'R', y + 2);
}

function sec11(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '11. 13. Monatslohn');
  y = sectionPara(doc, 'R', y, 'Der 13. Monatslohn wird im Rahmen von Art. 12 L-GAV entrichtet.');
  return setColY(ctx, 'R', y + 2);
}

function sec12(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '12. Vereinbarungen nach Arbeitsgesetz');
  y = sectionPara(doc, 'R', y, 'a) Der Mitarbeitende ist einverstanden, Nachtarbeit zu leisten. Beginn und Ende der Nachtarbeit:');
  y = sectionItem(doc, 'R', y, true,  'aa', '24 – 7 Uhr', 4);
  y = sectionItem(doc, 'R', y, false, 'bb', '22 – 5 Uhr',  4);
  y += 1;
  y = sectionPara(doc, 'R', y, 'b) Der Mitarbeitende ist mit einer vorübergehenden Beschäftigung während 6 anstatt an 5 Arbeitstagen einverstanden.');
  return setColY(ctx, 'R', y + 2);
}

function sec13(ctx: ColCtx, emp: Employee): ColCtx {
  // Show sec13 in left column after sec9/10L
  let y = Math.max(ctx.yL, ctx.yR);
  const doc = ctx.doc;
  hlineFullWidth(doc, y - 2);
  setFont(doc, 7.5, 'bold');
  doc.text('13. Besondere Vereinbarungen', PL, y); y += LH5;
  const special = [
    'Arztzeugnisse werden ab dem 1. Krankheitstag verlangt.',
    'Stundenrapporte sind bis zum 5. des Folgemonats einzureichen.',
    `Dieser Arbeitsvertrag tritt nur mit einem gültigen Aufenthaltstitel mit Erwerbserlaubnis in Kraft (${emp.permitType && emp.permitType !== 'swiss' ? `Ausweis ${emp.permitType}` : 'gilt für CH-Bürger nicht'}).`,
    'Dem Mitarbeitenden können ausnahmsweise auch andere zumutbare Arbeiten im Betrieb zugewiesen werden.',
  ];
  setFont(doc, 7.5, 'normal');
  special.forEach(s => {
    y = sectionPara(doc, 'L', y, '- ' + s);
    y += 1;
  });
  return { ...ctx, yL: y + 3, yR: y + 3 };
}

// ── Unterschriftsblock ────────────────────────────────────────────────────────

function signatures(doc: jsPDF, y: number): number {
  y += 8;
  setFont(doc, 8, 'normal');
  doc.text('Ort/Datum:', PL, y);
  y += 4;
  setFont(doc, 8, 'bold');
  doc.text('Bern, ___________________________________', PL, y);
  y += 14;
  doc.setDrawColor(0); doc.setLineWidth(0.3);
  const mid = (PL + PR) / 2;
  doc.line(PL, y, mid - 8, y);
  doc.line(mid + 8, y, PR, y);
  y += 4;
  setFont(doc, 7.5, 'normal');
  doc.text('Arbeitgeber/in (oLiv Restaurant & Bar)', PL, y);
  doc.text('Mitarbeiter/in (Unterschrift)', mid + 8, y);
  y += 8;
  setFont(doc, 7.5, 'normal');
  doc.text('Beilagen: _________________________________', PL, y);
  return y;
}

// ── Haupt-Generator ───────────────────────────────────────────────────────────

export function generateContract(
  emp: Employee,
): { blobUrl: string; fileName: string; doc: jsPDF } {
  const template = detectContractTemplate(emp);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── SEITE 1 ──────────────────────────────────────────────────────────────
  let ctx: Ctx = { doc, yL: 12, yR: 12, page: 1 };
  ctx = drawPageHeader(ctx, template);
  const cc: ColCtx = { doc: ctx.doc, yL: ctx.yL, yR: ctx.yR };
  let colCtx = drawPersonBlock(cc as unknown as Ctx, emp) as unknown as ColCtx;

  // Linke Spalte: Sektionen 1-4
  colCtx = sec1(colCtx, emp);
  colCtx = sec2(colCtx, emp);
  colCtx = sec3(colCtx, emp);
  colCtx = sec4(colCtx);

  // Rechte Spalte: Sektionen 5-7
  if (template === 'SL') {
    colCtx = sec5_SL(colCtx, emp);
  } else {
    colCtx = sec5_ML(colCtx, emp);
  }
  colCtx = sec6(colCtx);
  colCtx = sec7(colCtx);

  // Vertikale Trennlinie Seite 1
  const topOfSections = (colCtx as unknown as Ctx).yL;
  const botOfSections = Math.max(colCtx.yL, colCtx.yR);
  vlineSep(doc, topOfSections - 40, botOfSections + 2);

  pageFooter(doc, 1);

  // ── SEITE 2 ──────────────────────────────────────────────────────────────
  doc.addPage();
  let yPage2 = 18;

  // Sektion 8 (volle Breite)
  if (template === 'SL') {
    yPage2 = sec8_SL(doc, yPage2, emp);
  } else {
    yPage2 = sec8_ML(doc, yPage2, emp);
  }

  // Sektionen 9-12 wieder 2-spaltig
  let colCtx2: ColCtx = { doc, yL: yPage2 + 4, yR: yPage2 + 4 };
  hlineFullWidth(doc, yPage2 + 2);

  colCtx2 = sec9(colCtx2);
  colCtx2 = sec10L(colCtx2);
  colCtx2 = sec10R(colCtx2);
  colCtx2 = sec11(colCtx2);
  colCtx2 = sec12(colCtx2);

  // Trennlinie Seite 2 (2-spaltig)
  vlineSep(doc, yPage2 + 4, Math.max(colCtx2.yL, colCtx2.yR) + 2);

  // Sektion 13 + Unterschriften
  const finalCtx = sec13(colCtx2 as unknown as Ctx, emp) as unknown as ColCtx;
  const sigY = Math.max(finalCtx.yL ?? 240, finalCtx.yR ?? 240);
  signatures(doc, Math.min(sigY, 240));

  pageFooter(doc, 2);

  // ── Ausgabe ──────────────────────────────────────────────────────────────
  const blob    = doc.output('blob');
  const blobUrl = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = (emp.name ?? 'Mitarbeiter').replace(/\s+/g, '_');
  const fileName = `Arbeitsvertrag_${template}_${safeName}_${dateStr}.pdf`;

  return { blobUrl, fileName, doc };
}
