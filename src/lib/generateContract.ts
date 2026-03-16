/**
 * Arbeitsvertrag-Generator für oLiv Restaurant & Bar
 *
 * Zwei Vorlagen gemäss L-GAV (Gesamtarbeitsvertrag Gastgewerbe Schweiz):
 *   ML = Monatslohn  – Festanstellung (Vollzeit / Teilzeit)
 *   SL = Stundenlohn – Aushilfe / unregelmässige Beschäftigung
 *
 * Lohnberechnung: siehe src/lib/salaryCalc.ts
 */

import jsPDF from 'jspdf';
import { Employee } from '@/types/personnel';
import { calcSL, calcML, LGAV } from './salaryCalc';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function fmtDate(iso?: string): string {
  if (!iso) return '__________________';
  const d = new Date(iso);
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtCHF(v?: number | null, decimals = 2): string {
  if (v == null || isNaN(v)) return '__________________';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(v);
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(2) + ' %';
}

function permitLabel(p?: string): string {
  const m: Record<string, string> = {
    swiss: 'Schweizer Bürger/in', C: 'Ausweis C', B: 'Ausweis B', L: 'Ausweis L', G: 'Ausweis G', other: 'Anderer Status',
  };
  return p ? (m[p] ?? p) : '__________________';
}

function maritalLabel(m?: string): string {
  const map: Record<string, string> = { single: 'Ledig', married: 'Verheiratet', divorced: 'Geschieden', widowed: 'Verwitwet' };
  return m ? (map[m] ?? m) : '__________________';
}

function deptLabel(d?: string): string {
  if (d === 'küche')   return 'Küche';
  if (d === 'service') return 'Service';
  return '__________________';
}

function noticePeriod(trialMonths?: number): string {
  if (!trialMonths) return '1 Monat auf Ende des Kalendermonats';
  return 'Während der Probezeit: 3 Arbeitstage; danach: 1 Monat auf Ende des Kalendermonats';
}

// ── Vertragstyp-Erkennung ─────────────────────────────────────────────────────

export function detectContractTemplate(emp: Employee): 'ML' | 'SL' {
  if (emp.contractType === 'monthly') return 'ML';
  if (emp.contractType === 'hourly' || emp.contractType === 'irregular') return 'SL';
  if (emp.monthlySalary && emp.monthlySalary > 0) return 'ML';
  return 'SL';
}

// ── PDF-Layout-Konstanten ─────────────────────────────────────────────────────

const ML = 18;          // left margin
const MR = 192;         // right margin
const LH = 5.5;         // standard line height
const PAGE_BOTTOM = 280;

interface Ctx { doc: jsPDF; y: number; }

function addPage(ctx: Ctx): Ctx {
  ctx.doc.addPage();
  return { doc: ctx.doc, y: 22 };
}

function guard(ctx: Ctx, need = 18): Ctx {
  return ctx.y + need > PAGE_BOTTOM ? addPage(ctx) : ctx;
}

// ── Zeichenprimitive ──────────────────────────────────────────────────────────

function heading(ctx: Ctx, text: string): Ctx {
  ctx = guard(ctx, 14);
  const { doc, y } = ctx;
  doc.setFillColor(232, 232, 245);
  doc.rect(ML - 2, y - 3.5, MR - ML + 4, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 30, 80);
  doc.text(text, ML, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  return { ...ctx, y: y + 8 };
}

function field(ctx: Ctx, label: string, value: string, labelW = 60): Ctx {
  ctx = guard(ctx, 8);
  const { doc, y } = ctx;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90, 90, 90);
  doc.text(label + ':', ML, y);
  doc.setTextColor(20, 20, 20);
  doc.setFont('helvetica', 'bold');
  const wrapped = doc.splitTextToSize(value, MR - ML - labelW);
  doc.text(wrapped, ML + labelW, y);
  doc.setFont('helvetica', 'normal');
  return { ...ctx, y: y + Math.max(LH, wrapped.length * LH) };
}

function para(ctx: Ctx, text: string): Ctx {
  ctx = guard(ctx, 14);
  const { doc, y } = ctx;
  const lines = doc.splitTextToSize(text, MR - ML);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  doc.text(lines, ML, y);
  return { ...ctx, y: y + lines.length * LH + 1.5 };
}

function note(ctx: Ctx, text: string): Ctx {
  ctx = guard(ctx, 10);
  const { doc, y } = ctx;
  const lines = doc.splitTextToSize(text, MR - ML - 4);
  doc.setFontSize(7.8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(110, 110, 110);
  doc.text(lines, ML + 2, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  return { ...ctx, y: y + lines.length * 5 + 2 };
}

function gap(ctx: Ctx, h = 3): Ctx {
  return { ...ctx, y: ctx.y + h };
}

function hline(ctx: Ctx): Ctx {
  ctx.doc.setDrawColor(200, 200, 200);
  ctx.doc.setLineWidth(0.2);
  ctx.doc.line(ML, ctx.y, MR, ctx.y);
  return { ...ctx, y: ctx.y + 3 };
}

function lohnRow(ctx: Ctx, label: string, value: string, bold = false, sub = false): Ctx {
  ctx = guard(ctx, 6);
  const { doc, y } = ctx;
  const indent = sub ? 4 : 0;
  doc.setFontSize(8.2);
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setTextColor(sub ? 80 : 30, sub ? 80 : 30, sub ? 80 : 30);
  doc.text(label, ML + indent, y);
  doc.text(value, MR, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 30, 30);
  return { ...ctx, y: y + LH };
}

// ── Seitenheader und Footer ───────────────────────────────────────────────────

function pageHeader(ctx: Ctx, template: 'ML' | 'SL'): Ctx {
  const { doc } = ctx;
  let y = ctx.y;

  // Firmenname links
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.text('oLiv Restaurant & Bar', ML, y);

  // Titel rechts
  doc.setFontSize(13);
  const title = template === 'ML'
    ? 'ARBEITSVERTRAG – MONATSLOHN'
    : 'ARBEITSVERTRAG – STUNDENLOHN';
  doc.text(title, MR, y, { align: 'right' });

  // Untertitel
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(110, 110, 110);
  doc.text('Seftigenstrasse 101 · 3007 Bern', ML, y + 5);
  doc.text(
    template === 'ML' ? 'Festanstellung · gemäss L-GAV' : 'Stundenlohn · gemäss L-GAV',
    MR, y + 5, { align: 'right' }
  );

  // Trennlinie
  doc.setDrawColor(40, 40, 120);
  doc.setLineWidth(0.5);
  doc.line(ML, y + 9, MR, y + 9);
  doc.setTextColor(30, 30, 30);

  return { ...ctx, y: y + 16 };
}

function pageFooter(doc: jsPDF, pageNum: number, totalPages: number): void {
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    `oLiv Restaurant & Bar – Arbeitsvertrag – Seite ${pageNum} / ${totalPages} – Vertraulich`,
    105, 289, { align: 'center' }
  );
}

// ── Unterschriftsblock ────────────────────────────────────────────────────────

function signatures(ctx: Ctx, city = 'Bern'): Ctx {
  ctx = guard(ctx, 55);
  const { doc } = ctx;
  let y = ctx.y + 6;

  doc.setFontSize(8.5);
  doc.setTextColor(50, 50, 50);
  doc.text(`Ort und Datum: ${city}, ___________________________________`, ML, y);
  y += 18;

  const mid = (ML + MR) / 2;
  doc.setDrawColor(130, 130, 130);
  doc.setLineWidth(0.3);
  doc.line(ML, y, mid - 8, y);
  doc.line(mid + 8, y, MR, y);

  y += 5;
  doc.setFontSize(7.5);
  doc.setTextColor(100, 100, 100);
  doc.text('oLiv Restaurant & Bar\n(Arbeitgeberin, Geschäftsführung)', ML, y);
  doc.text('Arbeitnehmer/in\n(Unterschrift)', mid + 8, y);

  return { ...ctx, y: y + 14 };
}

// ── Abschnitte (gemeinsam für ML und SL) ─────────────────────────────────────

function artVertragsparteien(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 1 · Vertragsparteien');
  ctx = field(ctx, 'Arbeitgeberin', 'oLiv Restaurant & Bar, Seftigenstrasse 101, 3007 Bern');
  ctx = field(ctx, 'Arbeitnehmer/in', emp.name || '__________________');

  const address = [emp.addressStreet, [emp.addressZip, emp.addressCity].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  ctx = field(ctx, 'Adresse', address || '__________________');
  if (emp.phone)    ctx = field(ctx, 'Telefon', emp.phone);
  if (emp.email)    ctx = field(ctx, 'E-Mail', emp.email);
  ctx = field(ctx, 'Geburtsdatum', fmtDate(emp.birthDate));
  ctx = field(ctx, 'Zivilstand', maritalLabel(emp.maritalStatus));
  ctx = field(ctx, 'Anzahl Kinder', emp.numberOfChildren != null ? String(emp.numberOfChildren) : '__________________');
  ctx = field(ctx, 'AHV-Nummer', emp.ahvNumber || '__________________');
  ctx = field(ctx, 'Aufenthaltsstatus', permitLabel(emp.permitType));
  return gap(ctx, 2);
}

function artBeginn(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 2 · Beginn und Dauer des Arbeitsverhältnisses');
  ctx = field(ctx, 'Eintrittsdatum', fmtDate(emp.contractStart));
  ctx = field(ctx, 'Vertragsart', emp.isLimitedContract ? 'Befristet' : 'Unbefristet');
  if (emp.isLimitedContract && emp.contractEnd) {
    ctx = field(ctx, 'Vertragsende', fmtDate(emp.contractEnd));
  }
  const probe = emp.trialPeriodMonths
    ? `${emp.trialPeriodMonths} Monat${emp.trialPeriodMonths > 1 ? 'e' : ''}`
    : 'Keine Probezeit vereinbart';
  ctx = field(ctx, 'Probezeit', probe);
  ctx = field(ctx, 'Kündigungsfrist', noticePeriod(emp.trialPeriodMonths));
  ctx = note(ctx, 'Grundlage: OR Art. 335b–335c. Der Vertrag richtet sich nach dem L-GAV für das Schweizer Gastgewerbe.');
  return gap(ctx, 2);
}

function artTaetigkeit(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 3 · Tätigkeit und Aufgabengebiet');
  ctx = field(ctx, 'Funktion / Stelle', emp.positionTitle || '__________________');
  ctx = field(ctx, 'Abteilung', deptLabel(emp.department));
  ctx = para(ctx, 'Die Arbeitgeberin kann dem/der Arbeitnehmer/in im Rahmen seiner/ihrer Kenntnisse und Fähigkeiten sowie der betrieblichen Erfordernisse auch andere zumutbare Aufgaben übertragen.');
  return gap(ctx, 2);
}

function artSozialversicherungen(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 7 · Sozialversicherungen');
  ctx = para(ctx, 'Arbeitnehmer/in und Arbeitgeberin entrichten die gesetzlich vorgeschriebenen Beiträge an AHV/IV/EO, Arbeitslosenversicherung (ALV), Pensionskasse (BVG, soweit beitragspflichtig) sowie Unfallversicherung (UVG, SUVA). Der Arbeitnehmeranteil wird vom Bruttolohn in Abzug gebracht und von der Arbeitgeberin an die zuständigen Kassen abgeführt.');
  if (emp.permitType && ['B', 'L', 'G', 'other'].includes(emp.permitType)) {
    ctx = gap(ctx, 1.5);
    ctx = field(ctx, 'Quellensteuer', 'Ja – wird monatlich an die Steuerbehörde abgeführt');
    ctx = note(ctx, 'Massgebend sind Zivilstand, Anzahl Kinder, Beschäftigungsgrad sowie Kanton gemäss Angaben auf dem Personalblatt.');
  }
  return gap(ctx, 2);
}

function artSchweigepflicht(ctx: Ctx): Ctx {
  ctx = heading(ctx, 'Art. 8 · Sorgfaltspflicht, Schweigepflicht und Nebenbeschäftigung');
  ctx = para(ctx, 'Der/die Arbeitnehmer/in ist verpflichtet, die Interessen der Arbeitgeberin zu wahren und sorgfältig zu arbeiten. Über alle Betriebs- und Geschäftsgeheimnisse (insbesondere Umsatzzahlen, Personalangaben, Lieferantenbeziehungen und betriebliche Abläufe) ist auch nach Beendigung des Arbeitsverhältnisses Stillschweigen zu bewahren.');
  ctx = para(ctx, 'Nebenbeschäftigungen, die die volle Arbeitsleistung beeinträchtigen oder Interessen der Arbeitgeberin verletzen könnten, bedürfen der vorgängigen schriftlichen Zustimmung.');
  return gap(ctx, 2);
}

function artSchlussbest(ctx: Ctx): Ctx {
  ctx = heading(ctx, 'Art. 9 · Schlussbestimmungen');
  ctx = para(ctx, 'Dieser Vertrag untersteht dem Schweizerischen Recht. Ergänzend gelten die Bestimmungen des Obligationenrechts (OR, insbesondere Art. 319 ff.), des Arbeitsgesetzes (ArG) sowie der L-GAV für das Schweizer Gastgewerbe in der jeweils gültigen Fassung.');
  ctx = para(ctx, 'Änderungen und Ergänzungen dieses Vertrages bedürfen der Schriftform. Gerichtsstand ist Bern. Im Zweifelsfall hat die deutsche Fassung Vorrang.');
  return gap(ctx, 2);
}

// ── ML-Abschnitte ─────────────────────────────────────────────────────────────

function artArbeitszeitML(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 4 · Arbeitszeit');
  const wh      = emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME;
  const pensum  = Math.round((wh / LGAV.WEEKLY_HOURS_FULLTIME) * 100);
  const mh      = Math.round(wh * 52 / 12);
  ctx = field(ctx, 'Beschäftigungsgrad', `${pensum} % (${wh} Stunden pro Woche, ca. ${mh} Stunden pro Monat)`);
  ctx = field(ctx, 'Normalarbeitszeit', `${LGAV.WEEKLY_HOURS_FULLTIME} Stunden/Woche gemäss L-GAV (Vollzeit)`);
  ctx = para(ctx, 'Die Einsatzzeiten werden durch den Dienstplan der Arbeitgeberin festgelegt. Die Arbeitgeberin ist berechtigt, die Arbeitszeiten den betrieblichen Bedürfnissen anzupassen, soweit dies gesetzlich und vertraglich zulässig ist. Mehrarbeit und Überstunden werden nach Möglichkeit durch Freizeit ausgeglichen; andernfalls gemäss OR und L-GAV vergütet.');
  return gap(ctx, 2);
}

function artLohnML(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 5 · Lohn');
  const factor  = emp.socialCostFactor ?? 1.13;
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.monthlySalary ?? 0;
  const wh      = emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME;
  const ml      = calcML(base, has13th, wh, factor);

  ctx = field(ctx, 'Monatslohn brutto', fmtCHF(base));
  ctx = field(ctx, '13. Monatslohn', has13th
    ? `Vereinbart – anteilig ${fmtCHF(base / 12)} pro Monat zurückgelegt, Auszahlung im Dezember`
    : 'Nicht vereinbart');

  ctx = gap(ctx, 2);
  // Kostenübersicht-Tabelle
  ctx = lohnRow(ctx, 'Monatslohn brutto (Vertrag)', fmtCHF(base));
  if (has13th) {
    ctx = lohnRow(ctx, `+ 13. Monatslohn (${fmtPct(1 / 12)} pro Monat)`, fmtCHF(ml.effectiveMonthlyGross - base), false, true);
    ctx = lohnRow(ctx, '= Effektiver Brutto/Monat (inkl. 13.)', fmtCHF(ml.effectiveMonthlyGross), true);
  }
  ctx = hline(ctx);
  ctx = lohnRow(ctx, 'AG-Sozialkosten (' + fmtPct(factor - 1) + ')', '+ ' + fmtCHF(ml.socialCostMonthly), false, true);
  ctx = hline(ctx);
  ctx = lohnRow(ctx, 'Vollkosten pro Monat', fmtCHF(ml.totalMonthlyEmployerCost), true);
  ctx = lohnRow(ctx, 'Jahresvollkosten', fmtCHF(ml.annualEmployerCost), false, true);
  ctx = hline(ctx);
  ctx = lohnRow(ctx, `Interner Stundenansatz (${ml.annualEmployerCost.toFixed(0)} ÷ ${wh} h ÷ 52 W)`, fmtCHF(ml.internalHourlyCost), true);

  ctx = gap(ctx, 2);
  ctx = para(ctx, 'Der Lohn wird monatlich, spätestens am letzten Arbeitstag des Monats, auf das von der Arbeitnehmerin/dem Arbeitnehmer angegebene Bankkonto überwiesen. Alle gesetzlichen Sozialabzüge (AHV, IV, EO, ALV, BVG, UVG) werden vom Bruttolohn in Abzug gebracht.');
  return gap(ctx, 2);
}

function artFerienML(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 6 · Ferien und Feiertage');
  const vacDays = emp.vacationDaysPerYear ?? 25;
  const wh      = emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME;
  const pensum  = Math.round((wh / LGAV.WEEKLY_HOURS_FULLTIME) * 100);
  const adjDays = pensum < 100 ? Math.round(vacDays * pensum / 100) : vacDays;

  ctx = field(ctx, 'Ferienanspruch', `${vacDays} Arbeitstage/Jahr bei 100 % · bei ${pensum} %: ${adjDays} Tage`);
  ctx = field(ctx, 'Feiertage', '6 bezahlte Feiertage pro Jahr gemäss Kanton Bern');
  ctx = para(ctx, 'Ferien sind grundsätzlich nach Absprache mit der Vorgesetzten und, wenn möglich, während betrieblicher Ruhephasen zu beziehen. Der Ferienbezug richtet sich nach den betrieblichen Bedürfnissen gemäss L-GAV.');
  return gap(ctx, 2);
}

// ── SL-Abschnitte ─────────────────────────────────────────────────────────────

function artArbeitszeitSL(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 4 · Arbeitszeit');
  ctx = field(ctx, 'Beschäftigungsart', 'Unregelmässig / nach Dienstplan (Aushilfe)');
  if (emp.weeklyHours) {
    ctx = field(ctx, 'Max. Wochenstunden', `${emp.weeklyHours} Stunden (nicht garantiert)`);
  }
  ctx = para(ctx, 'Es besteht kein Anspruch auf eine bestimmte Anzahl Arbeitsstunden pro Woche. Der Einsatz erfolgt nach betrieblichem Bedarf und nach Möglichkeit in gegenseitigem Einvernehmen. Dem/der Arbeitnehmer/in steht es frei, einzelne Einsätze bei triftigen Gründen abzulehnen.');
  return gap(ctx, 2);
}

function artLohnSL(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 5 · Lohn');
  const factor  = emp.socialCostFactor ?? 1.13;
  const has13th = emp.has13thSalary ?? false;
  const base    = emp.hourlyWage ?? 0;
  const sl      = calcSL(base, has13th, factor);

  ctx = field(ctx, 'Basis-Stundenlohn brutto', fmtCHF(base));
  ctx = para(ctx, 'Der Stundenlohn enthält alle L-GAV-Entschädigungen gemäss nachstehender Berechnung. Ferienentschädigung und Feiertagsentschädigung sind als prozentualer Zuschlag auf den Basis-Stundenlohn eingeschlossen:');

  ctx = gap(ctx, 1);
  // Aufschlüsselung
  ctx = lohnRow(ctx, 'Basis-Stundenlohn brutto', fmtCHF(base));
  ctx = lohnRow(ctx, `+ Ferienentschädigung ${fmtPct(LGAV.VACATION_RATE)} (25 Ferientage)`, fmtCHF(sl.vacationComp), false, true);
  ctx = lohnRow(ctx, `+ Feiertagsentschädigung ${fmtPct(LGAV.PUBLIC_HOLIDAY_RATE)} (6 Feiertage Kt. Bern)`, fmtCHF(sl.holidayComp), false, true);
  ctx = hline(ctx);
  ctx = lohnRow(ctx, 'Zwischensumme', fmtCHF(sl.subtotal), true);
  if (has13th) {
    ctx = lohnRow(ctx, `+ 13. Monatslohn-Zuschlag ${fmtPct(LGAV.THIRTEENTH_RATE)}`, fmtCHF(sl.thirteenthComp), false, true);
  }
  ctx = hline(ctx);
  ctx = lohnRow(ctx, 'Auszahlbarer Stundenlohn (Lohnzettel)', fmtCHF(sl.totalPayableHourly), true);
  ctx = hline(ctx);
  ctx = lohnRow(ctx, `AG-Sozialkosten (${fmtPct(factor - 1)})`, '+ ' + fmtCHF(sl.socialCostPerHour), false, true);
  ctx = hline(ctx);
  ctx = lohnRow(ctx, 'Interner Stundenansatz (Kostenstelle)', fmtCHF(sl.internalHourlyCost), true);

  ctx = gap(ctx, 2);
  ctx = para(ctx, 'Die Lohnabrechnung erfolgt monatlich auf Basis der erfassten Arbeitsstunden gemäss Arbeitszeitnachweis. Die Auszahlung erfolgt spätestens am letzten Arbeitstag des Monats auf das angegebene Bankkonto. Alle gesetzlichen Sozialabzüge werden vom Bruttolohn in Abzug gebracht.');
  return gap(ctx, 2);
}

function artFerienSL(ctx: Ctx, emp: Employee): Ctx {
  ctx = heading(ctx, 'Art. 6 · Ferien und Feiertage');
  ctx = field(ctx, 'Ferienanspruch', 'Als Entschädigung im Stundenlohn eingeschlossen (10.65 %)');
  ctx = field(ctx, 'Feiertage', 'Als Entschädigung im Stundenlohn eingeschlossen (2.27 %)');
  ctx = note(ctx, 'Da Ferien- und Feiertagsentschädigung bereits im Stundenansatz enthalten sind, besteht kein separater Anspruch auf bezahlte Ferientage oder bezahlte Feiertage. Massgebend ist L-GAV Art. 17.');
  return gap(ctx, 2);
}

// ── Haupt-Funktion ────────────────────────────────────────────────────────────

export function generateContract(
  emp: Employee
): { blobUrl: string; fileName: string; doc: jsPDF } {
  const template = detectContractTemplate(emp);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let ctx: Ctx = { doc, y: 18 };

  // ── Seite 1: Header + Inhalt ─────────────────────────────────────────────
  ctx = pageHeader(ctx, template);
  ctx = gap(ctx, 2);

  ctx = artVertragsparteien(ctx, emp);
  ctx = artBeginn(ctx, emp);
  ctx = artTaetigkeit(ctx, emp);

  if (template === 'ML') {
    ctx = artArbeitszeitML(ctx, emp);
    ctx = artLohnML(ctx, emp);
    ctx = artFerienML(ctx, emp);
  } else {
    ctx = artArbeitszeitSL(ctx, emp);
    ctx = artLohnSL(ctx, emp);
    ctx = artFerienSL(ctx, emp);
  }

  ctx = artSozialversicherungen(ctx, emp);
  ctx = artSchweigepflicht(ctx);
  ctx = artSchlussbest(ctx);

  ctx = gap(ctx, 4);
  ctx = signatures(ctx, 'Bern');

  // ── Footer auf allen Seiten ──────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    pageFooter(doc, p, totalPages);
  }

  // ── Ausgabe ──────────────────────────────────────────────────────────────
  const blob    = doc.output('blob');
  const blobUrl = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = (emp.name ?? 'Mitarbeiter').replace(/\s+/g, '_');
  const fileName = `Arbeitsvertrag_${template}_${safeName}_${dateStr}.pdf`;

  return { blobUrl, fileName, doc };
}
