/**
 * Cockpit-PDF-Export: erzeugt aus einem gerenderten DOM-Panel (Monatsübersicht,
 * Wochenverlauf oder Jahresvergleich) ein einseitiges A4-PDF «genau so wie
 * angezeigt».
 *
 * Vorgehen:
 *  1. html2canvas rastert das Panel (scale 2 für Schärfe). Der Hintergrund wird
 *     aus dem `computed style` des Elements übernommen (dark-mode-sicher) —
 *     transparente Hintergründe fallen auf Weiss zurück, damit nichts «leer» wirkt.
 *  2. Orientierung automatisch nach Seitenverhältnis (breit → landscape,
 *     hoch → portrait). Inhalt wird proportional in den nutzbaren Bereich
 *     eingepasst (contain, ~8 mm Rand), nie abgeschnitten, immer genau 1 Seite.
 *  3. Kleine Kopfzeile oberhalb des Captures: Ansichtsname + Zeitraum + Datum.
 *
 * Bekannte Grenzen: sehr hohe/breite Panels werden stark verkleinert (bleiben
 * aber vollständig lesbar, da vektorfreier Screenshot). Recharts-SVGs müssen
 * gerendert sein — der Aufrufer wartet vorher einen Frame ab (siehe Seite).
 */

const MM_PER_PAGE = { a4w: 297, a4h: 210 }; // Landscape-Basismasse (mm)
const MARGIN_MM = 8;
const HEADER_MM = 12; // Platz für die Kopfzeile über dem Bild

export interface CockpitPdfOptions {
  /** Ansichtsname, z.B. «Monatsübersicht». */
  title: string;
  /** Zeitraum/Subtitle, z.B. «Juli 2026» oder «01.01.–29.07.2026 vs. 2025». */
  subtitle: string;
  /** Dateiname ohne Endung, z.B. «cockpit-monatsuebersicht-2026-07». */
  fileName: string;
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
 * Exportiert das übergebene Panel als einseitiges PDF. Temporär wird die Höhe
 * des Elements «entfesselt» (kein max-height/overflow), damit ein evtl.
 * scrollbarer Container vollständig ins Bild kommt; danach zurückgesetzt.
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
    // Volle gerenderte Grösse erfassen (scrollbare Bereiche einschliessen).
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
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
  const subZeile = `${opts.subtitle}  ·  Export: ${datum}`;
  pdf.text(subZeile, MARGIN_MM, MARGIN_MM + 8);

  // Nutzbarer Bereich für das Bild (unter der Kopfzeile).
  const availW = pageW - 2 * MARGIN_MM;
  const availH = pageH - 2 * MARGIN_MM - HEADER_MM;

  // Contain: proportional so skalieren, dass es vollständig in avail passt.
  const imgRatio = canvas.width / canvas.height;
  let drawW = availW;
  let drawH = drawW / imgRatio;
  if (drawH > availH) {
    drawH = availH;
    drawW = drawH * imgRatio;
  }
  // Zentriert im nutzbaren Bereich platzieren.
  const offsetX = MARGIN_MM + (availW - drawW) / 2;
  const offsetY = MARGIN_MM + HEADER_MM + (availH - drawH) / 2;

  pdf.addImage(imgData, 'PNG', offsetX, offsetY, drawW, drawH);
  pdf.save(`${opts.fileName}.pdf`);
}
