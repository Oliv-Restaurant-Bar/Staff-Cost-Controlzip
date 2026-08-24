import { requireServerCapability } from '@/lib/server-authorization';
/**
 * Cockpit-PDF-Export: erzeugt aus einem gerenderten DOM-Panel (Monatsübersicht,
 * Wochenverlauf oder Jahresvergleich) ein einseitiges A4-PDF «genau so wie
 * angezeigt» — aber aufgeräumt (ohne interaktive Bedienelemente).
 *
 * Vorgehen:
 *  1. html2canvas rastert das Panel (scale 2 für Schärfe) mit einem onclone-Hook:
 *     Im Klon werden interaktive Controls (Klasse `pdf-hide`) ausgeblendet,
 *     capture-only-Zeilen (Klasse `pdf-only`) eingeblendet, die Live-Fussnote
 *     (Klasse `pdf-footnote`) entfernt und eine feste Renderbreite gesetzt,
 *     damit Spaltenköpfe/Labels nicht umbrechen. So bleibt die Live-Ansicht
 *     unverändert.
 *  2. Orientierung automatisch nach Seitenverhältnis (breit → landscape,
 *     hoch → portrait). Inhalt wird proportional in den nutzbaren Bereich
 *     eingepasst (contain, ~8 mm Rand), nie abgeschnitten, immer genau 1 Seite.
 *  3. Kopfzeile oberhalb des Captures: Ansichtsname + Zeitraum + Datum.
 *  4. Optionale Fussnote als sauberer, umgebrochener jsPDF-Text unter dem Bild.
 *
 * Bekannte Grenzen: sehr hohe Panels werden stark verkleinert (bleiben
 * vollständig lesbar). Recharts-SVGs müssen gerendert sein — der Aufrufer
 * wartet vorher einen Frame ab (siehe Seite).
 */

const MM_PER_PAGE = { a4w: 297, a4h: 210 }; // Landscape-Basismasse (mm)
const MARGIN_MM = 8;
const HEADER_MM = 12;          // Platz für die Kopfzeile über dem Bild
const CLONE_WIDTH_PX = 1400;   // feste Renderbreite im Klon → kein Umbruch

export interface CockpitPdfOptions {
  /** Ansichtsname, z.B. «Monatsübersicht». */
  title: string;
  /** Zeitraum/Subtitle, z.B. «Juli 2026» oder «01.01.–29.07.2026 vs. 2025». */
  subtitle: string;
  /** Dateiname ohne Endung, z.B. «cockpit-monatsuebersicht-2026-07». */
  fileName: string;
  /** Optionaler Erklärtext, wird als sauberer PDF-Text unter das Bild gesetzt. */
  footnote?: string;
  /**
   * Feste Seiten-Orientierung (z.B. Wochenverlauf: ≤2 Wochen Hochformat,
   * ≥3 Wochen Querformat). Ohne Angabe: automatisch nach Seitenverhältnis.
   */
  orientation?: 'portrait' | 'landscape';
  /**
   * Renderbreite des Klons in px (Default 1400). Schmaler = relativ grössere
   * Schrift auf der Seite (Hochformat mit wenigen Spalten), breiter = mehr
   * Spalten nebeneinander ohne Umbruch (Querformat mit vielen Wochen).
   */
  cloneWidthPx?: number;
}

/** Wartet zwei Animationsframes ab → Recharts/Layout sicher fertig gerendert. */
export function naechsterFrame(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Ermittelt einen nicht-transparenten Hintergrund (Element → Vorfahren → Weiss). */
function ermittleHintergrund(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg)) {
      return bg;
    }
    node = node.parentElement;
  }
  return '#ffffff';
}

/**
 * Bereitet den geklonten Panel-Baum für den Export auf (nur im Klon; die
 * Live-Ansicht bleibt unberührt):
 *  - `.pdf-hide`     → display:none (interaktive Controls raus)
 *  - `.pdf-only`     → sichtbar machen (capture-only Zusammenfassung)
 *  - `.pdf-footnote` → display:none (Fussnote kommt sauber als PDF-Text)
 *  - feste Breite, kein max-width, kein Clipping → keine Umbrüche/Abschnitte
 *  - Tabellen-Header: white-space:nowrap
 */
function bereiteKlonAuf(clonedRoot: HTMLElement, cloneWidth: number): void {
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-hide').forEach(el => { el.style.display = 'none'; });
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-footnote').forEach(el => { el.style.display = 'none'; });
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-only').forEach(el => {
    el.style.display = 'flex';
    el.style.visibility = 'visible';
  });

  // Feste Renderbreite, kein Clipping, aufs Inhaltsmass ausrichten.
  clonedRoot.style.width = `${cloneWidth}px`;
  clonedRoot.style.maxWidth = 'none';
  clonedRoot.style.overflow = 'visible';
  clonedRoot.style.padding = '8px';

  // Karten-Aussenabstände reduzieren + horizontalen Scroll-Clip aufheben.
  clonedRoot.querySelectorAll<HTMLElement>('.overflow-x-auto').forEach(el => {
    el.style.overflow = 'visible';
    el.style.maxWidth = 'none';
  });

  // Tabellen-Header nicht umbrechen (Spaltenköpfe bleiben einzeilig lesbar).
  clonedRoot.querySelectorAll<HTMLElement>('table thead th').forEach(el => {
    el.style.whiteSpace = 'nowrap';
  });
}

/** Rastert ein Panel und liefert Canvas + gewünschte Orientierung. */
async function capturePanel(
  html2canvas: typeof import('html2canvas').default,
  element: HTMLElement,
  opts: CockpitPdfOptions,
): Promise<{ canvas: HTMLCanvasElement; landscape: boolean }> {
  const background = ermittleHintergrund(element);
  const cloneWidth = opts.cloneWidthPx ?? CLONE_WIDTH_PX;
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: background,
    logging: false,
    width: cloneWidth,
    windowWidth: cloneWidth,
    onclone: (_doc, clonedEl) => bereiteKlonAuf(clonedEl as HTMLElement, cloneWidth),
  });
  // Orientierung: explizit (z.B. Wochenverlauf nach Wochen-Anzahl), sonst
  // automatisch nach Seitenverhältnis des Captures.
  const landscape = opts.orientation
    ? opts.orientation === 'landscape'
    : canvas.width >= canvas.height;
  return { canvas, landscape };
}

/** Zeichnet eine gerasterte Seite (Kopfzeile, Bild, Fussnote) ins PDF.
 *  Mit `branding` (Report-Verbund): Marken-Kopfband + Akzentlinie und
 *  einheitliche 13-mm-Ränder wie die Vektor-/Waren-Seiten. */
function zeichneSeite(
  pdf: import('jspdf').jsPDF,
  canvas: HTMLCanvasElement,
  landscape: boolean,
  opts: CockpitPdfOptions,
  heute: Date,
  branding?: import('@/lib/pl-branding').RestaurantBranding,
): void {
  const pageW = landscape ? MM_PER_PAGE.a4w : MM_PER_PAGE.a4h;
  const pageH = landscape ? MM_PER_PAGE.a4h : MM_PER_PAGE.a4w;
  const rand = branding ? 13 : MARGIN_MM;

  // Kopfzeile.
  const datum = heute.toLocaleDateString('de-CH');
  let kopfH: number;
  if (branding) {
    // Einheitliches Marken-Kopfband (Titel · Mandant · Zeitraum · Stand).
    const bandH = 16;
    pdf.setFillColor(...branding.headerBg);
    pdf.rect(0, 0, pageW, bandH, 'F');
    pdf.setTextColor(...branding.textPrimary);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12);
    pdf.text(opts.title, rand, bandH / 2 - 0.6);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
    pdf.setTextColor(...branding.textSecondary);
    pdf.text(`${branding.displayName}  ·  ${opts.subtitle}  ·  Stand ${datum}`, rand, bandH / 2 + 4);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
    pdf.setTextColor(...branding.textPrimary);
    pdf.text('Cockpit-Report', pageW - rand, bandH / 2 + 1.4, { align: 'right' });
    pdf.setFillColor(...branding.accentColor);
    pdf.rect(0, bandH, pageW, 1.2, 'F');
    kopfH = bandH + 1.2 + 4 - rand; // relativ zum Rand (siehe offsetY unten)
  } else {
    pdf.setFontSize(12);
    pdf.setTextColor(20, 20, 20);
    pdf.setFont('helvetica', 'bold');
    pdf.text(opts.title, rand, rand + 3);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(`${opts.subtitle}  ·  Export: ${datum}`, rand, rand + 8);
    kopfH = HEADER_MM;
  }

  // Platz für eine optionale Fussnote am Seitenende reservieren.
  const availW = pageW - 2 * rand;
  const footLines = opts.footnote
    ? pdf.setFontSize(7).splitTextToSize(opts.footnote, availW) as string[]
    : [];
  const footBlockH = footLines.length > 0 ? footLines.length * 2.8 + 3 : 0;

  // Nutzbarer Bereich für das Bild (unter Kopfzeile, über Fussnote).
  const availH = pageH - 2 * rand - kopfH - footBlockH;

  // Contain: proportional so skalieren, dass es vollständig in avail passt.
  const imgRatio = canvas.width / canvas.height;
  let drawW = availW;
  let drawH = drawW / imgRatio;
  if (drawH > availH) {
    drawH = availH;
    drawW = drawH * imgRatio;
  }
  const offsetX = rand + (availW - drawW) / 2;
  const offsetY = rand + kopfH;

  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', offsetX, offsetY, drawW, drawH);

  // Fussnote als sauberer, umgebrochener Text unter dem Bild.
  if (footLines.length > 0) {
    pdf.setFontSize(7);
    pdf.setTextColor(120, 120, 120);
    const footY = pageH - rand - footBlockH + 3;
    pdf.text(footLines, rand, footY);
  }
}

/**
 * Exportiert das übergebene Panel als einseitiges PDF.
 */
export async function exportCockpitPanelPDF(
  element: HTMLElement,
  opts: CockpitPdfOptions,
  heute: Date = new Date(),
): Promise<void> {
  await exportCockpitPagesPDF([{ element, opts }], opts.fileName, heute);
}

/**
 * Exportiert MEHRERE Panels als mehrseitiges PDF (eine Seite pro Panel,
 * Orientierung pro Seite — z.B. Monatsübersicht hoch + 4-Wochen-Tabelle quer).
 */
/**
 * Hybrid-Export: Seiten sind entweder gerasterte DOM-Panels («raster», z.B.
 * Monatsübersicht) oder strukturierte Report-Modelle («model» — Vektor-Layout
 * aus cockpit-report-pdf: Wochenübersicht / Letzte 4 Wochen / Wochenverlauf).
 * Am Ende bekommen ALLE Seiten eine Fusszeile mit Seitenzahl.
 */
export type CockpitExportPart =
  | { kind: 'raster'; element: HTMLElement; opts: CockpitPdfOptions }
  | { kind: 'model'; model: import('@/lib/cockpit-report-pdf').CrReportModel }
  /** Freier Zeichner: fügt selbst Seiten ans PDF an (z.B. Waren-Block). */
  | { kind: 'zeichner'; zeichne: (pdf: import('jspdf').jsPDF) => void };

export async function exportCockpitMixedPDF(
  parts: CockpitExportPart[],
  branding: import('@/lib/pl-branding').RestaurantBranding,
  fileName: string,
  heute: Date = new Date(),
): Promise<void> {
  if (parts.length === 0) return;
  await requireServerCapability('cockpit-export');
  const brauchtRaster = parts.some(p => p.kind === 'raster');
  const [{ default: jsPDF }, reportMod, brandMod, html2canvas] = await Promise.all([
    import('jspdf'),
    import('@/lib/cockpit-report-pdf'),
    import('@/lib/pl-branding'),
    brauchtRaster ? import('html2canvas').then(m => m.default) : Promise.resolve(null),
  ]);
  let logo: string | null = null;
  try { logo = (await brandMod.renderLogoDataUrl(branding)) || null; } catch { logo = null; }

  // Erst alle Raster-Panels capturen (DOM stabil halten), dann zeichnen.
  const captured = new Map<number, { canvas: HTMLCanvasElement; landscape: boolean }>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.kind === 'raster') captured.set(i, await capturePanel(html2canvas!, p.element, p.opts));
  }

  // Einheitliches Format: Raster- und Waren-Seiten immer HOCHFORMAT (das
  // Capture wird proportional eingepasst). Nur die breiten Vektor-Matrizen
  // («Letzte 4 Wochen»/«Wochenverlauf») bleiben konstruktiv Querformat.
  const pdf = new jsPDF({
    orientation: parts[0].kind === 'model' ? 'landscape' : 'portrait',
    unit: 'mm', format: 'a4',
  });
  parts.forEach((p, i) => {
    if (p.kind === 'zeichner') {
      p.zeichne(pdf); // fügt selbst Seiten an (addPage im Zeichner)
    } else if (p.kind === 'model') {
      reportMod.zeichneCockpitReport(pdf, p.model, branding, logo, heute, i === 0);
    } else {
      const c = captured.get(i)!;
      if (i > 0) pdf.addPage('a4', 'portrait');
      zeichneSeite(pdf, c.canvas, false, p.opts, heute, branding);
    }
  });
  reportMod.zeichneFusszeilen(pdf, branding.companyLine);
  pdf.save(`${fileName}.pdf`);
}

export async function exportCockpitPagesPDF(
  pages: Array<{ element: HTMLElement; opts: CockpitPdfOptions }>,
  fileName: string,
  heute: Date = new Date(),
): Promise<void> {
  if (pages.length === 0) return;
  await requireServerCapability('cockpit-export');
  const [html2canvas, { default: jsPDF }] = await Promise.all([
    import('html2canvas').then(m => m.default),
    import('jspdf'),
  ]);

  // Erst alle Panels rastern (DOM stabil halten), dann Seiten zeichnen.
  const captured: Array<{ canvas: HTMLCanvasElement; landscape: boolean; opts: CockpitPdfOptions }> = [];
  for (const p of pages) {
    const { canvas, landscape } = await capturePanel(html2canvas, p.element, p.opts);
    captured.push({ canvas, landscape, opts: p.opts });
  }

  const pdf = new jsPDF({
    orientation: captured[0].landscape ? 'landscape' : 'portrait',
    unit: 'mm', format: 'a4',
  });
  captured.forEach((c, i) => {
    if (i > 0) pdf.addPage('a4', c.landscape ? 'landscape' : 'portrait');
    zeichneSeite(pdf, c.canvas, c.landscape, c.opts, heute);
  });

  pdf.save(`${fileName}.pdf`);
}
