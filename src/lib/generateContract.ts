/**
 * Arbeitsvertrag-Generator für oLiv Restaurant & Bar
 *
 * Reproduziert die offiziellen GastroSuisse / L-GAV Vertragsvorlagen:
 *   SL = Stundenlohn-Vertrag
 *   ML = Monatslohn-Vertrag
 *
 * Checkboxen werden als gezeichnete Rechtecke gerendert (drawCB).
 * Helvetica-Font unterstützt keine ■/□ Unicode-Symbole.
 *
 * ⚠️  Abschnitt 8 (Bruttolohn) zeigt NUR Mitarbeitenden-relevante Werte.
 *    AG-Kosten (Vollkosten, Interner Stundenansatz) sind NICHT enthalten.
 */

import jsPDF from 'jspdf';
import { Employee } from '@/types/personnel';
import { ContractDraft } from '@/types/contract';
import { calcSL, LGAV } from './salaryCalc';

// ── Seitenmasse ───────────────────────────────────────────────────────────────

const PL  = 12;   // page left margin
const PR  = 198;  // page right margin
const COL = 104;  // column divider x
const LR  = 101;  // left column right edge
const RX  = 107;  // right column left edge

const LH5 = 4.5;
const LH4 = 4.0;
const CB_SIZE = 2.8;  // checkbox square side (mm)

// ── Arbeitgeber-Konstanten ────────────────────────────────────────────────────

const EMPLOYER_NAME = 'Oliv Gastro AG';
const EMPLOYER_ADDR = 'Waisenhausplatz 28, 3011 Bern';

// ── Interfaces ────────────────────────────────────────────────────────────────

interface ColCtx { doc: jsPDF; yL: number; yR: number; }

// ── Vertragstyp-Erkennung ─────────────────────────────────────────────────────

export function detectContractTemplate(emp: Employee): 'ML' | 'SL' {
  if (emp.contractType === 'monthly') return 'ML';
  if (emp.contractType === 'hourly' || emp.contractType === 'irregular') return 'SL';
  if (emp.monthlySalary && emp.monthlySalary > 0) return 'ML';
  return 'SL';
}

// ── Format-Helpers ────────────────────────────────────────────────────────────

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
  const map: Record<string, string> = {
    single: 'ledig', married: 'verheiratet', divorced: 'geschieden', widowed: 'verwitwet',
  };
  return m ? (map[m] ?? m) : '___________';
}
function deptLabel(d?: string): string {
  if (d === 'küche')   return 'Küche';
  if (d === 'service') return 'Service';
  return '___________';
}

// ── Font-Setter ───────────────────────────────────────────────────────────────

function setFont(doc: jsPDF, size: number, style: 'normal' | 'bold' | 'italic' = 'normal') {
  doc.setFont('helvetica', style);
  doc.setFontSize(size);
  doc.setTextColor(0, 0, 0);
}

// ── Checkbox: gezeichnetes Rechteck mit optionalem X ─────────────────────────
//
//  Aufruf: drawCB(doc, x, y, checked)
//    x/y = linke Baseline-Position (wie bei doc.text)
//    Das Kästchen wird um CB_SIZE × CB_SIZE gezeichnet und ist y-zentriert.

function drawCB(doc: jsPDF, x: number, y: number, checked: boolean) {
  const top = y - CB_SIZE + 0.4;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(x, top, CB_SIZE, CB_SIZE);

  if (checked) {
    // X aus zwei Diagonalen
    doc.setLineWidth(0.4);
    doc.line(x + 0.4, top + 0.4, x + CB_SIZE - 0.4, top + CB_SIZE - 0.4);
    doc.line(x + CB_SIZE - 0.4, top + 0.4, x + 0.4, top + CB_SIZE - 0.4);
  }
}

// ── Linien ────────────────────────────────────────────────────────────────────

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
function pageFooter(doc: jsPDF, page: number) {
  setFont(doc, 7, 'normal');
  doc.setTextColor(140, 140, 140);
  doc.text(`© GastroSuisse – L-GAV Arbeitsvertrag – Seite ${page}`, 105, 290, { align: 'center' });
  doc.text('oLiv Restaurant & Bar – Vertraulich', 105, 294, { align: 'center' });
}

// ── Spalten-Helpers ───────────────────────────────────────────────────────────

type Col = 'L' | 'R';
function colX(col: Col): number { return col === 'L' ? PL : RX; }
function colW(col: Col): number { return col === 'L' ? LR - PL : PR - RX; }
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

/**
 * Zeichnet eine Checkbox-Zeile:
 *   [ ] letter)  text
 *
 * Die Checkbox ist ein gezeichnetes Kästchen (drawCB), kein Unicode-Symbol.
 */
function sectionItem(
  doc: jsPDF,
  col: Col,
  y: number,
  checked: boolean,
  letter: string,
  text: string,
  indent = 0,
): number {
  const x = colX(col) + indent;

  drawCB(doc, x, y, checked);

  setFont(doc, 7.5, 'normal');
  doc.text(`${letter})`, x + CB_SIZE + 1, y);

  const textX = x + CB_SIZE + 8;
  const textW = colW(col) - CB_SIZE - 8 - indent;
  const lines = doc.splitTextToSize(text, textW);
  doc.text(lines, textX, y);

  return y + Math.max(LH5, lines.length * LH5);
}

// ── Seiten-Header ─────────────────────────────────────────────────────────────

function drawPageHeader(
  doc: jsPDF,
  template: 'ML' | 'SL',
  draft: ContractDraft,
  _emp: Employee,
): number {
  let y = 12;

  setFont(doc, 9, 'bold');
  doc.text('Der vorliegende Arbeitsvertrag berücksichtigt die Erfordernisse des L-GAV.', PL, y);
  y += 7;

  if (template === 'SL') {
    setFont(doc, 8, 'bold');
    doc.text('Arbeitsvertrag für', PL, y);
    setFont(doc, 8, 'normal');
    doc.text('Mitarbeiter/in mit unregelmässigem Pensum', PL + 38, y);
    setFont(doc, 7.5, 'italic');
    doc.text('(z.B. "Aushilfen" im Stundenlohn)', PL + 38, y + 4.5);
    y += 12;
  } else {
    // ML – Vollzeit / Teilzeit mit gezeichneten Checkboxen
    const isVollzeit = draft.employmentMode === 'vollzeit';

    setFont(doc, 8, 'bold');
    doc.text('Arbeitsvertrag', PL, y);

    const cbX = PL + 30;

    // Zeile a)
    drawCB(doc, cbX, y, isVollzeit);
    setFont(doc, 8, 'normal');
    doc.text('a)  für Vollzeitmitarbeiter/in', cbX + CB_SIZE + 1, y);

    // Zeile b)
    const yB = y + 5;
    drawCB(doc, cbX, yB, !isVollzeit);
    const teilzeitText = 'b)  für Teilzeitmitarbeiter/in (mit regelmässigem, festgelegtem Arbeitspensum)';
    doc.text(teilzeitText, cbX + CB_SIZE + 1, yB);

    setFont(doc, 7, 'italic');
    doc.text(
      '(Zutreffendes ankreuzen bzw. Ziff. 5 ausfüllen, sonst gilt Variante a Vollzeitmitarbeiter/in)',
      cbX + CB_SIZE + 5, yB + 4.5,
    );
    y += 16;
  }

  setFont(doc, 8, 'normal');
  doc.text(`zwischen  ${EMPLOYER_NAME}, ${EMPLOYER_ADDR}`, PL, y);
  setFont(doc, 7.5, 'italic');
  doc.text('Arbeitgeber/in', PR, y, { align: 'right' });
  y += 4;
  setFont(doc, 8, 'normal');
  doc.text('und', PL, y);

  return y + 5;
}

// ── Persönliche Daten ─────────────────────────────────────────────────────────

function drawPersonBlock(doc: jsPDF, emp: Employee, startY: number): number {
  let y = startY;
  hlineFullWidth(doc, y - 1);

  // Leicht grauer Hintergrund für den Personendaten-Block
  const ROW  = 6.8;
  const ROWS = 4;
  const PADV = 3.5;  // vertical padding above first row
  const blockH = PADV + ROWS * ROW + 2.5;

  doc.setFillColor(248, 249, 250);
  doc.rect(PL, y, PR - PL, blockH, 'F');

  // Spalten-Definitionen  (3 Spalten)
  // Spalte A: x=13 .. 74   Label A bei 13, Wert A bei 37
  // Spalte B: x=76 .. 136  Label B bei 76, Wert B bei 98
  // Spalte C: x=140 .. 198 Label C bei 140, Wert C bei 160
  const A_L = PL + 1;   const A_V = PL + 24;
  const B_L = PL + 64;  const B_V = PL + 84;
  const C_L = PL + 130; const C_V = PL + 151;

  // Hilfsroutine: Label fett, Wert normal
  const lv = (label: string, val: string, lx: number, vy: number, vx: number) => {
    setFont(doc, 7, 'bold');
    doc.text(label, lx, vy);
    setFont(doc, 7.5, 'normal');
    doc.text(val, vx, vy);
  };

  const plzOrt = [emp.addressZip, emp.addressCity].filter(Boolean).join(' ') || '___________';
  const kinder = emp.numberOfChildren != null ? String(emp.numberOfChildren) : '–';

  // Zeile 1: Name | Strasse | "Mitarbeiter/in" (rechts)
  const r1 = y + PADV + ROW * 0;
  lv('Name / Vorname', emp.name || '___________________', A_L, r1, A_V);
  lv('Strasse',        emp.addressStreet || '___________', B_L, r1, B_V);
  setFont(doc, 7, 'italic');
  doc.text('Mitarbeiter/in', PR, r1, { align: 'right' });

  // Zeile 2: PLZ/Ort | Telefon | Geburtsdatum
  const r2 = y + PADV + ROW * 1;
  lv('PLZ / Ort',   plzOrt,               A_L, r2, A_V);
  lv('Telefon',     emp.phone || '___________', B_L, r2, B_V);
  lv('Geburtsdatum', fd(emp.birthDate),   C_L, r2, C_V);

  // Zeile 3: E-Mail | Zivilstand | Anzahl Kinder
  const r3 = y + PADV + ROW * 2;
  lv('E-Mail',       emp.email || '___________________', A_L, r3, A_V);
  lv('Zivilstand',   maritalLabel(emp.maritalStatus),   B_L, r3, B_V);
  lv('Anz. Kinder',  kinder,                             C_L, r3, C_V);

  // Zeile 4: AHV-Nr. | Ausländerausweis | Krankenkasse
  const r4 = y + PADV + ROW * 3;
  lv('AHV-Nr.',           emp.ahvNumber || '___________________', A_L, r4, A_V);
  lv('Ausländerausweis',  permitLabel(emp.permitType),            B_L, r4, B_V);
  setFont(doc, 7, 'bold');
  doc.text('Krankenkasse', C_L, r4);
  setFont(doc, 6.5, 'italic');
  doc.text('(MA selbst abgeschlossen)', C_L, r4 + ROW * 0.55);

  y += blockH;
  hlineFullWidth(doc, y);
  y += 3;

  setFont(doc, 7, 'italic');
  const note = 'Zur Erhöhung der Lesefreundlichkeit wird vorliegend vereinfachend auf die weibliche Form "Mitarbeiterin" verzichtet und an dieser Stelle vorab der Oberbegriff "Mitarbeitende" verwendet.';
  const lines = doc.splitTextToSize(note, PR - PL);
  doc.text(lines, PL, y);
  y += lines.length * 4 + 4;
  hlineFullWidth(doc, y);

  return y + 5;
}

// ── Linke Spalte: Art. 1-4 ───────────────────────────────────────────────────

function sec1(ctx: ColCtx, emp: Employee, draft: ContractDraft): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '1. Vertragsbeginn/Funktion/Beschäftigung');
  y = sectionPara(doc, 'L', y, 'Der vorliegende Vertrag tritt mit Unterzeichnung vollumfänglich an die Stelle allfälliger vorangehender Vereinbarungen und ersetzt diese vollständig.');
  y += 1;
  y = sectionPara(doc, 'L', y, 'Dieser Vertrag tritt nur in Kraft, sofern die notwendigen Arbeitsbewilligungen erteilt werden.');
  y += 2;
  const wh         = emp.weeklyHours ?? 42;
  const pensum     = Math.round(wh / 42 * 100);
  const pensumStr  = `${pensum}%`;
  const funktionStr = [emp.positionTitle, pensumStr].filter(Boolean).join(' ');

  setFont(doc, 7.5, 'normal');
  doc.text(`a)   Vertragsbeginn: ${fd(emp.contractStart)}`, PL, y); y += LH5;
  doc.text(`b)   Funktion: ${funktionStr || '___________________'}`, PL, y); y += LH5;
  doc.text(`      Abteilung: ${deptLabel(emp.department)}`, PL, y); y += LH5 + 1;
  y = sectionPara(doc, 'L', y, 'Dem Mitarbeitenden können vorübergehend auch andere Arbeiten im Betrieb oder an einem zumutbaren anderen Arbeitsort zugewiesen werden.');
  y += 1;
  doc.text('c)   Beschäftigung in Raucherbetrieben und Raucherräumen:', PL, y); y += LH5;
  y = sectionItem(doc, 'L', y, draft.smokingConsent === 'aa', 'aa',
    'Der Mitarbeitende stimmt einer Beschäftigung in einem Raucherbetrieb oder in Raucherräumen zu.', 4);
  y = sectionItem(doc, 'L', y, draft.smokingConsent === 'bb', 'bb',
    'Der Mitarbeitende lehnt eine Beschäftigung in einem Raucherbetrieb ab.', 4);
  return setColY(ctx, 'L', y + 3);
}

function sec2(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '2. Vertragsdauer');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, draft.duration === 'unlimited', 'a',
    'Der Vertrag wird auf unbestimmte Zeit abgeschlossen. Er ist gemäss Ziff. 3 und 4 kündbar.');
  y = sectionItem(doc, 'L', y, draft.duration === 'limited_cancellable', 'b',
    `Der Vertrag wird auf bestimmte Zeit abgeschlossen. Er dauert bis am ${fd(draft.endDate)}, ist aber kündbar.`);
  y = sectionItem(doc, 'L', y, draft.duration === 'limited_fixed', 'c',
    'Der Vertrag wird auf bestimmte Zeit abgeschlossen und ist nicht kündbar.');
  return setColY(ctx, 'L', y + 2);
}

function sec3(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '3. Probezeit (Art. 5 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, draft.probation === 'three_months_7d', 'a',
    'Die Probezeit beträgt 3 Monate, die Kündigungsfrist beträgt 7 Tage.');
  y = sectionItem(doc, 'L', y, draft.probation === 'fourteen_days', 'b',
    'Die Probezeit beträgt 14 Tage, die Kündigungsfrist beträgt 3 Tage.');
  y = sectionItem(doc, 'L', y, draft.probation === 'none', 'c',
    'Es besteht keine Probezeit.');
  const pm = draft.probationMonths ?? 3;
  const pd = draft.probationNoticeDays ?? 3;
  y = sectionItem(doc, 'L', y, draft.probation === 'custom', 'd',
    `Die Probezeit beträgt ${pm} Monat(e) (max. 3 Monate), die Kündigungsfrist beträgt ${pd} Tag(e) (min. 3 Tage).`);
  return setColY(ctx, 'L', y + 2);
}

function sec4(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '4. Kündigung (Art. 6 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, draft.notice === 'standard', 'a',
    'Die Kündigungsfrist beträgt nach Ablauf der Probezeit 1 Monat (bzw. 2 Monate ab dem sechsten Dienstjahr), jeweils auf das Ende eines Monats.');
  y = sectionItem(doc, 'L', y, draft.notice === 'extended', 'b',
    `Allfällige längere Kündigungsfristen: ${draft.noticeExtended || '___________________________________________'}`);
  return setColY(ctx, 'L', y + 2);
}

// ── Rechte Spalte: Art. 5-7 ──────────────────────────────────────────────────

function sec5(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '5. Arbeitszeit und Ferien (Art. 15 und Art. 17 L-GAV)');
  y = sectionPara(doc, 'R', y,
    'Die einzelnen Arbeitseins\u00e4tze erfolgen jeweils nach Absprache im gegenseitigen Einvernehmen. Die durchschnittliche w\u00f6chentliche Arbeitszeit liegt unter 42 Stunden (in Kleinbetrieben unter 45 Stunden; in Saisonbetrieben unter 43,5 Stunden). Der Mitarbeitende hat Anspruch auf 5 Wochen Ferien pro Dienstjahr. Der Ferienlohn wird mit 10,65% des Bruttolohnes verg\u00fctet. Der Mitarbeitende hat Anspruch auf 6 (0,5 Tage pro Monat) bezahlte Feiertage pro Kalenderjahr (Bundesfeiertag inbegriffen). Die Lohnzahlung f\u00fcr die Feiertage erfolgt durch eine Verg\u00fctung von 2,27% des Bruttolohnes.');
  return setColY(ctx, 'R', y + 2);
}

function sec6(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '6. Wichtige Hinweise');
  y = sectionPara(doc, 'R', y,
    'Der Mitarbeitende ist orientiert: \u00dcber das Ende der Deckung f\u00fcr Berufsunf\u00e4lle bei Beendigung des Arbeitsverh\u00e4ltnisses, die einunddrei\u00dfigt\u00e4gige Nachdeckung und die Abredeversicherung f\u00fcr Nichtberufsunf\u00e4lle bei der Unfallversicherung f\u00fcr Zwischensaison sowie Beendigung des Arbeitsverh\u00e4ltnisses, den Wiedereinschluss des Unfalls bei der Krankenpflegeversicherung und den Wechsel in eine Einzelversicherung bei der Krankengeldversicherung.');
  y += 1;
  y = sectionPara(doc, 'R', y,
    'Der Mitarbeitende ist verpflichtet, sich ab dem ersten Arbeitstag gem\u00e4ss den Bestimmungen des KVG f\u00fcr Krankenpflege zu versichern. Bei einem Besch\u00e4ftigungsgrad von unter 8 Stunden pro Woche ist der Abschluss der NBU-Versicherung Sache des Mitarbeiters. Gest\u00fctzt auf die Lebensmittelgesetzgebung orientiert die Arbeitgeber sofort bei Fieber, Durchfall, Erbrechen und eitrigen Wunden.');
  y += 1;
  y = sectionPara(doc, 'R', y,
    'Sexuelle Bel\u00e4stigung und diskriminierendes Verhalten sind ausdr\u00fccklich untersagt. Entsprechendes Fehlverhalten kann zu einer fristlosen K\u00fcndigung f\u00fchren.');
  return setColY(ctx, 'R', y + 2);
}

function sec7(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '7. Berufsausbildung');
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante g)', RX, y); y += LH4;
  const ed = draft.education;
  const items: [string, string, boolean][] = [
    ['a', 'mit eidgenössischem Berufsattest (EBA)',                       ed === 'eba'],
    ['b', 'mit eidgenössischem Fähigkeitszeugnis (EFZ)',                  ed === 'efz'],
    ['c', 'mit EFZ und mind. 6 Tage anerkannte Weiterbildung',            ed === 'efz_plus'],
    ['d', 'Berufsprüfung nach Art. 27 lit. a BBG',                        ed === 'berufspruefung'],
    ['e', `mit anderem Zertifikat: ${draft.educationOtherText || '___________________'}`, ed === 'other_cert'],
    ['f', 'keine gastgewerbliche Berufslehre, aber Progresso-Ausbildung', ed === 'progresso'],
    ['g', 'keine den L-GAV betreffende Ausbildung',                       ed === 'none'],
  ];
  items.forEach(([letter, text, checked]) => {
    y = sectionItem(doc, 'R', y, checked, letter, text);
  });
  return setColY(ctx, 'R', y + 2);
}

// ── Sektion 8: Bruttolohn (nur AN-relevante Zahlen) ──────────────────────────

function sec8_SL(doc: jsPDF, y: number, emp: Employee): number {
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.hourlyWage ?? 0;
  const sl      = calcSL(base, has13th, 1.0);

  hlineFullWidth(doc, y - 2);
  setFont(doc, 8, 'bold');
  doc.text('8. Bruttolohn (Art. 8 - 10 L-GAV)', PL, y); y += 5;
  setFont(doc, 7.5, 'normal');
  doc.text('Der Brutto-Stundenlohn setzt sich wie folgt zusammen:', PL, y); y += LH5 + 1;

  const labelX = PL + 4;
  const amtX   = 148;
  const refX   = 168;

  const lRow = (label: string, amount: string, ref = '') => {
    setFont(doc, 7.5, 'normal');
    doc.text(label, labelX, y);
    setFont(doc, 7.5, 'bold');
    doc.text(amount, amtX, y, { align: 'right' });
    if (ref) { setFont(doc, 7, 'italic'); doc.text(ref, refX, y); }
    y += LH5;
  };

  lRow('- Stundenlohn (Basis-Stundenlohn brutto)', `Fr.  ${fc(base)}`, '(1)');
  lRow(`- Ferienentschädigung (${pct(LGAV.VACATION_RATE)} %)`, `Fr.  ${fc(sl.vacationComp)}`, '(2)');
  lRow(`- Feiertagsentschädigung (${pct(LGAV.PUBLIC_HOLIDAY_RATE)} %)`, `Fr.  ${fc(sl.holidayComp)}`, '(3)');

  if (has13th) {
    lRow(`- 13. Monatslohn (${pct(LGAV.THIRTEENTH_RATE)} % auf Total (1)-(3))`, `Fr.  ${fc(sl.thirteenthComp)}`, '*');
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
  doc.text('Total Brutto-Stundenlohn (auszahlbarer Betrag)', labelX, y);
  doc.text(`Fr.  ${fc(sl.totalPayableHourly)}`, amtX, y, { align: 'right' });
  y += LH5 + 2;
  return y;
}

function sec8_ML(doc: jsPDF, y: number, emp: Employee): number {
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.monthlySalary ?? 0;

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

  lRow('- Festlohn (Monatslohn brutto, laut Vertrag)', `Fr. ${fc(base)}`);

  if (has13th) {
    const thirteenth = base / 12;
    lRow(
      `- monatl. Anteil 13. Monatslohn (Art. 12 L-GAV, 1/12 = ${pct(LGAV.THIRTEENTH_RATE)} %)`,
      `Fr. ${fc(thirteenth)}`,
    );
    y += 1;
    doc.setDrawColor(0); doc.setLineWidth(0.4);
    doc.line(PL + 4, y, 160, y); y += 2;
    setFont(doc, 8, 'bold');
    doc.text('Total (Monatslohn brutto inkl. 13. Monatslohn-Anteil)', labelX, y);
    doc.text(`Fr. ${fc(base + thirteenth)}`, amtX, y, { align: 'right' });
    y += LH5;
  } else {
    setFont(doc, 7.5, 'normal');
    doc.text('- 13. Monatslohn: nicht vereinbart', labelX, y); y += LH5;
    y += 1;
    doc.setDrawColor(0); doc.setLineWidth(0.4);
    doc.line(PL + 4, y, 160, y); y += 2;
    setFont(doc, 8, 'bold');
    doc.text('Total (Monatslohn brutto)', labelX, y);
    doc.text(`Fr. ${fc(base)}`, amtX, y, { align: 'right' });
    y += LH5;
  }
  return y + 2;
}

// ── Sektion 9-13 (Seite 2) ───────────────────────────────────────────────────

function sec9(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '9. Lohnreduktion Einführungszeit (Art. 10 L-GAV)');
  setFont(doc, 7.5, 'bold');
  doc.text('Mindestlohnstufe I (ungelernte Mitarbeitende)', PL, y); y += LH4;
  setFont(doc, 7, 'italic');
  doc.text('(WICHTIG: Zutreffendes ankreuzen, sonst gilt Variante b)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, draft.wageRedI === 'first_12m', 'a',
    'Erstanstellung in L-GAV-Betrieb. Reduktion um 8% für die ersten 12 Monate.');
  y = sectionItem(doc, 'L', y, draft.wageRedI === 'first_3m', 'b',
    'Mehr als 4 Monate Erfahrung in L-GAV-Betrieb. Reduktion um 8% für die ersten 3 Monate.');
  y = sectionItem(doc, 'L', y, draft.wageRedI === 'none', 'c',
    'Auf eine Lohnreduktion während der Einführungszeit wird verzichtet.');
  y += 2;
  setFont(doc, 7.5, 'bold');
  doc.text('Mindestlohnstufen II und IIIa (EBA und EFZ)', PL, y); y += LH4;
  setFont(doc, 7, 'italic');
  doc.text('(WICHTIG: Zutreffendes ankreuzen, sonst gilt Variante b)', PL, y); y += LH4;
  y = sectionItem(doc, 'L', y, draft.wageRedII === 'first_3m', 'a',
    'Erste Anstellung nach Abschluss der Ausbildung. Reduktion um 8% für die ersten 3 Monate.');
  y = sectionItem(doc, 'L', y, draft.wageRedII === 'none', 'b',
    'Es besteht keine Lohnreduktion während der Einführungszeit.');
  return setColY(ctx, 'L', y + 2);
}

function sec10L(ctx: ColCtx): ColCtx {
  let y = ctx.yL;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'L', y, '10. Abzüge / Zulagen / Lohnauszahlung (Art. 13 und 14 L-GAV)');
  setFont(doc, 7, 'italic');
  doc.text('(Vorbehalten bleiben Gesetzes- oder Prämienänderungen.)', PL, y); y += LH4;
  setFont(doc, 7.5, 'bold');
  doc.text('a) Monatliche Abzüge', PL, y); y += LH5;
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

function sec10R(ctx: ColCtx, draft: ContractDraft): ColCtx {
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
  doc.text('d) Lohnauszahlung', RX, y); y += LH5;
  setFont(doc, 7, 'italic');
  doc.text('(Zutreffendes ankreuzen, sonst gilt Variante a)', RX, y); y += LH4;
  y = sectionItem(doc, 'R', y, draft.paymentTiming === 'last',       'a', 'Der Lohn wird spätestens am Letzten des Monats ausbezahlt.');
  y = sectionItem(doc, 'R', y, draft.paymentTiming === 'sixth',      'b', 'Der Lohn wird spätestens am 6. des folgenden Monats ausbezahlt.');
  y = sectionItem(doc, 'R', y, draft.paymentTiming === 'collective', 'c', 'Lohnauszahlung gemäss Art. 14 Ziff. 1 Abs. 2 L-GAV.');
  return setColY(ctx, 'R', y + 2);
}

function sec11(ctx: ColCtx): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '11. 13. Monatslohn');
  y = sectionPara(doc, 'R', y, 'Der 13. Monatslohn wird im Rahmen von Art. 12 L-GAV entrichtet.');
  return setColY(ctx, 'R', y + 2);
}

function sec12(ctx: ColCtx, draft: ContractDraft): ColCtx {
  let y = ctx.yR;
  const doc = ctx.doc;
  y = sectionTitle(doc, 'R', y, '12. Vereinbarungen nach Arbeitsgesetz');
  y = sectionPara(doc, 'R', y, 'a) Der Mitarbeitende ist einverstanden, Nachtarbeit zu leisten. Beginn und Ende der Nachtarbeit:');
  y = sectionItem(doc, 'R', y, draft.nightWork === 'aa', 'aa', '24 – 7 Uhr',       4);
  y = sectionItem(doc, 'R', y, draft.nightWork === 'bb', 'bb', '22 – 5 Uhr',       4);
  y = sectionItem(doc, 'R', y, draft.nightWork === 'cc', 'cc', '23 – 6 Uhr',       4);
  y = sectionItem(doc, 'R', y, draft.nightWork === 'dd', 'dd', '23:30 – 6:30 Uhr', 4);
  y += 1;
  y = sectionItem(doc, 'R', y, draft.sixDayWork, 'b',
    'Der Mitarbeitende ist mit einer vorübergehenden Beschäftigung während 6 anstatt an 5 Arbeitstagen einverstanden.');
  return setColY(ctx, 'R', y + 2);
}

function sec13(doc: jsPDF, y: number, draft: ContractDraft): number {
  hlineFullWidth(doc, y - 2);
  setFont(doc, 7.5, 'bold');
  doc.text('13. Besondere Vereinbarungen', PL, y); y += LH5;
  setFont(doc, 7.5, 'normal');
  const lines = (draft.specialAgreements || '').split('\n').filter(Boolean);
  if (lines.length > 0) {
    lines.forEach(line => {
      const wrapped = doc.splitTextToSize(`- ${line}`, PR - PL - 4);
      doc.text(wrapped, PL + 4, y);
      y += wrapped.length * LH5 + 1;
    });
  } else {
    doc.text('–', PL + 4, y); y += LH5;
  }
  return y + 2;
}

function signatures(doc: jsPDF, y: number) {
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
  doc.text('Beilagen: _________________________________', PL, y);
}

// ── Haupt-Generator ───────────────────────────────────────────────────────────

export function generateContract(
  emp: Employee,
  draft: ContractDraft,
): { blobUrl: string; fileName: string; doc: jsPDF } {
  const template = detectContractTemplate(emp);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── SEITE 1 ──────────────────────────────────────────────────────────────
  let startY = drawPageHeader(doc, template, draft, emp);
  startY = drawPersonBlock(doc, emp, startY);

  let colCtx: ColCtx = { doc, yL: startY, yR: startY };
  const topOfSections = startY;

  colCtx = sec1(colCtx, emp, draft);
  colCtx = sec2(colCtx, draft);
  colCtx = sec3(colCtx, draft);
  colCtx = sec4(colCtx, draft);

  colCtx = sec5(colCtx);
  colCtx = sec6(colCtx);
  colCtx = sec7(colCtx, draft);

  vlineSep(doc, topOfSections, Math.max(colCtx.yL, colCtx.yR) + 2);
  pageFooter(doc, 1);

  // ── SEITE 2 ──────────────────────────────────────────────────────────────
  doc.addPage();
  let yPage2 = 18;

  if (template === 'SL') {
    yPage2 = sec8_SL(doc, yPage2, emp);
  } else {
    yPage2 = sec8_ML(doc, yPage2, emp);
  }

  hlineFullWidth(doc, yPage2 + 2);
  let colCtx2: ColCtx = { doc, yL: yPage2 + 6, yR: yPage2 + 6 };
  const topPage2 = yPage2 + 6;

  colCtx2 = sec9(colCtx2, draft);
  colCtx2 = sec10L(colCtx2);
  colCtx2 = sec10R(colCtx2, draft);
  colCtx2 = sec11(colCtx2);
  colCtx2 = sec12(colCtx2, draft);

  vlineSep(doc, topPage2, Math.max(colCtx2.yL, colCtx2.yR) + 2);

  const y13    = Math.max(colCtx2.yL, colCtx2.yR) + 4;
  const y13end = sec13(doc, y13, draft);

  signatures(doc, Math.min(y13end, 242));
  pageFooter(doc, 2);

  // ── Ausgabe ──────────────────────────────────────────────────────────────
  const blob     = doc.output('blob');
  const blobUrl  = URL.createObjectURL(blob);
  const dateStr  = new Date().toISOString().slice(0, 10);
  const safeName = (emp.name ?? 'Mitarbeiter').replace(/\s+/g, '_');
  const fileName = `Arbeitsvertrag_${template}_${safeName}_${dateStr}.pdf`;

  return { blobUrl, fileName, doc };
}
