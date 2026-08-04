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
function bereiteKlonAuf(clonedRoot: HTMLElement): void {
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-hide').forEach(el => { el.style.display = 'none'; });
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-footnote').forEach(el => { el.style.display = 'none'; });
  clonedRoot.querySelectorAll<HTMLElement>('.pdf-only').forEach(el => {
    el.style.display = 'flex';
    el.style.visibility = 'visible';
  });

  // Feste Renderbreite, kein Clipping, aufs Inhaltsmass ausrichten.
  clonedRoot.style.width = `${CLONE_WIDTH_PX}px`;
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

/**
 * Exportiert das übergebene Panel als einseitiges PDF.
 */
export async function exportCockpitPanelPDF(
  element: HTMLElement,
  opts: CockpitPdfOptions,
  heute: Date = new Date(),
): Promise<void> {
  const [html2canvas, { default: jsPDF }] = await Promise.all([
    import('html2canvas').then(m => m.default),
    import('jspdf'),
  ]);

  const background = ermittleHintergrund(element);

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: background,
    logging: false,
    width: CLONE_WIDTH_PX,
    windowWidth: CLONE_WIDTH_PX,
    onclone: (_doc, clonedEl) => bereiteKlonAuf(clonedEl as HTMLElement),
  });

  const imgData = canvas.toDataURL('image/png');

  // Orientierung nach Seitenverhältnis des Captures wählen.
  const landscape = canvas.width >= canvas.height;
  const pageW = landscape ? MM_PER_PAGE.a4w : MM_PER_PAGE.a4h;
  const pageH = landscape ? MM_PER_PAGE.a4h : MM_PER_PAGE.a4w;

  const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });

  // Kopfzeile.
  const datum = heute.toLocaleDateString('de-CH');
  pdf.setFontSize(12);
  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.text(opts.title, MARGIN_MM, MARGIN_MM + 3);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text(`${opts.subtitle}  ·  Export: ${datum}`, MARGIN_MM, MARGIN_MM + 8);

  // Platz für eine optionale Fussnote am Seitenende reservieren.
  const availW = pageW - 2 * MARGIN_MM;
  const footLines = opts.footnote
    ? pdf.setFontSize(7).splitTextToSize(opts.footnote, availW) as string[]
    : [];
  const footBlockH = footLines.length > 0 ? footLines.length * 2.8 + 3 : 0;

  // Nutzbarer Bereich für das Bild (unter Kopfzeile, über Fussnote).
  const availH = pageH - 2 * MARGIN_MM - HEADER_MM - footBlockH;

  // Contain: proportional so skalieren, dass es vollständig in avail passt.
  const imgRatio = canvas.width / canvas.height;
  let drawW = availW;
  let drawH = drawW / imgRatio;
  if (drawH > availH) {
    drawH = availH;
    drawW = drawH * imgRatio;
  }
  const offsetX = MARGIN_MM + (availW - drawW) / 2;
  const offsetY = MARGIN_MM + HEADER_MM;

  pdf.addImage(imgData, 'PNG', offsetX, offsetY, drawW, drawH);

  // Fussnote als sauberer, umgebrochener Text unter dem Bild.
  if (footLines.length > 0) {
    pdf.setFontSize(7);
    pdf.setTextColor(120, 120, 120);
    const footY = pageH - MARGIN_MM - footBlockH + 3;
    pdf.text(footLines, MARGIN_MM, footY);
  }

  pdf.save(`${opts.fileName}.pdf`);
}
