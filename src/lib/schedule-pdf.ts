/**
 * Dienstplan als PDF: A4 quer, eine volle Woche pro Seite.
 * Gleiche Datenbasis wie die öffentliche Seite (WeekPayload) — keine Löhne, nur Namen,
 * Schichten und grobe Abwesenheiten. Wird sowohl auf der Mitarbeiterseite als auch im
 * Veröffentlichen-Dialog verwendet.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  SHARE_DEPARTMENT_LABEL,
  type PublicDay,
  type ShareDepartment,
  type WeekPayload,
} from '@/lib/schedule-publish-payload';

type RGB = [number, number, number];

const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

export interface SchedulePdfTheme {
  /** Kurzname für den Dateinamen */
  slug: string;
  /** Betriebsname im Kopf */
  name: string;
  /** Logo (öffentlicher Pfad) und Höhe im PDF in mm */
  logoUrl: string;
  logoHeight: number;
  /** Logo hat einen weißen Hintergrund, der auf dem Seitenhintergrund wegfallen muss */
  logoWhiteBg?: boolean;
  /** Farben wie auf der Mitarbeiterseite */
  bg: RGB;
  ink: RGB;
  muted: RGB;
  line: RGB;
  brand: RGB; // Tabellenkopf
  accent: RGB; // Zierlinie
  tint: RGB; // Namensspalte, Wochenende
  /** Überschrift-Schrift wie auf der Mitarbeiterseite (ohne geladene Schriften: Helvetica / Times) */
  headingFont: 'jost' | 'cormorant';
}

export const PDF_THEMES: Record<string, SchedulePdfTheme> = {
  oliv: {
    slug: 'oliv',
    name: 'Oliv Restaurant & Bar',
    logoUrl: '/images/company-logo.png',
    logoHeight: 14,
    logoWhiteBg: true,
    bg: hex('#F6F5F0'),
    ink: hex('#1B1B19'),
    muted: hex('#6C6F66'),
    line: hex('#E2E4DA'),
    brand: hex('#1B1B19'),
    accent: hex('#8FA687'),
    tint: hex('#EBF0E7'),
    headingFont: 'jost',
  },
  beaulieu: {
    slug: 'beaulieu',
    name: 'Restaurant Beaulieu',
    logoUrl: '/beaulieu-logo-transparent.png',
    logoHeight: 17,
    bg: hex('#F5F2E7'),
    ink: hex('#26301A'),
    muted: hex('#6E705E'),
    line: hex('#E4E0CC'),
    brand: hex('#3F5420'),
    accent: hex('#D6A12B'),
    tint: hex('#F1EDD6'),
    headingFont: 'cormorant',
  },
};

/** Abwesenheits-Farben wie auf der Mitarbeiterseite */
const ABSENCE_COLORS: Record<string, { bg: RGB; fg: RGB }> = {
  Ferien: { bg: hex('#E4EFF7'), fg: hex('#285B82') },
  Feiertag: { bg: hex('#ECE6F5'), fg: hex('#58408A') },
  Frei: { bg: hex('#ECEBE4'), fg: hex('#65645B') },
  Abwesend: { bg: hex('#F6E7E3'), fg: hex('#8A392F') },
};

/** Schriftdateien (base64) für jsPDF — Jost wie die Mitarbeiterseite, Cormorant für Beaulieu-Titel. */
export interface PdfFonts {
  jostRegular: string;
  jostSemiBold: string;
  cormorantBold: string;
}

const FONT_FILES: Record<keyof PdfFonts, string> = {
  jostRegular: '/fonts/Jost_400Regular.ttf',
  jostSemiBold: '/fonts/Jost_600SemiBold.ttf',
  cormorantBold: '/fonts/CormorantGaramond_700Bold-latin.ttf',
};

/** Schriften im Browser laden; bei Fehler liefert null → PDF nutzt Helvetica/Times. */
export async function loadPdfFonts(): Promise<PdfFonts | null> {
  try {
    const entries = await Promise.all(
      Object.entries(FONT_FILES).map(async ([key, url]) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return [key, btoa(bin)] as const;
      }),
    );
    return Object.fromEntries(entries) as unknown as PdfFonts;
  } catch {
    return null;
  }
}

export interface PdfLogo {
  dataUrl: string;
  /** Seitenverhältnis Breite / Höhe */
  ratio: number;
}

/** Logo im Browser laden; bei Fehler ohne Logo weiterarbeiten. */
/** Weiß → transparent (Farbe-zu-Alpha), damit das Logo auf dem Seitenhintergrund nicht als Kasten erscheint. */
function whiteToAlpha(img: HTMLImageElement): string {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = Math.max(255 - px[i], 255 - px[i + 1], 255 - px[i + 2]) / 255;
    if (a <= 0) {
      px[i + 3] = 0;
      continue;
    }
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(255 - (255 - px[i + k]) / a);
    px[i + 3] = Math.round(a * (px[i + 3] / 255) * 255);
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}

export async function loadPdfLogo(url: string, whiteBg = false): Promise<PdfLogo | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('logo'));
      i.src = dataUrl;
    });
    return { dataUrl: whiteBg ? whiteToAlpha(img) : dataUrl, ratio: img.naturalWidth / img.naturalHeight };
  } catch {
    return null;
  }
}

export interface SchedulePdfWeek {
  payload: WeekPayload;
  /** ISO-Zeitstempel der Veröffentlichung (für „Stand") — bei Entwürfen weglassen */
  publishedAt?: string | null;
}

export interface SchedulePdfOptions {
  department: ShareDepartment;
  theme: SchedulePdfTheme;
  /** Nur diese Person drucken (Name wie im Plan). Ohne Angabe: ganze Abteilung. */
  onlyName?: string | null;
  /** Logo des Betriebs (siehe loadPdfLogo); ohne Logo erscheint der Betriebsname als Text */
  logo?: PdfLogo | null;
  /** Eingebettete Schriften (siehe loadPdfFonts); ohne Angabe Standardschriften */
  fonts?: PdfFonts | null;
}

const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 10;
const TOP = 38; // Platz für Kopfbereich (Logo + Titel)
const BOTTOM = 14; // Fußzeile
/** Unter dieser Schriftgröße (pt) werden Schichten nebeneinander statt untereinander gesetzt */
const READABLE_MIN = 6.5;

const slot = (s: { start: string; end: string } | null) => (s ? `${s.start}–${s.end}` : null);

/** Zellentext eines Tages: Schichten (je eine Zeile) oder die Abwesenheit. */
export function pdfCellText(d: PublicDay | undefined, sep = '\n'): string {
  if (!d) return '';
  const shifts = [slot(d.früh), slot(d.spät)].filter(Boolean) as string[];
  if (shifts.length > 0) return shifts.join(sep);
  return d.frühAbsence || d.spätAbsence || '';
}

export function pdfFileName(department: ShareDepartment, weeks: SchedulePdfWeek[], slug: string): string {
  const dep = SHARE_DEPARTMENT_LABEL[department].toLowerCase().replace('ü', 'ue');
  const kws = weeks.map(w => w.payload.kw);
  const range = kws.length === 1 ? `kw${kws[0]}` : `kw${kws[0]}-${kws[kws.length - 1]}`;
  return `dienstplan-${slug}-${dep}-${range}.pdf`;
}

/** Schriftgröße so wählen, dass die Wochentabelle auf eine Seite passt (Untergrenze 5,5 pt). */
function pickFontSize(lineCounts: number[]): number {
  const avail = PAGE_H - TOP - BOTTOM;
  for (let fs = 9; fs >= 5.5; fs -= 0.5) {
    const lineH = fs * 0.3528 * 1.18;
    const pad = fs > 7 ? 1.4 : 0.9;
    const rows = lineCounts.reduce((sum, n) => sum + n * lineH + 2 * pad, 0);
    const head = lineH + 2 * pad + 1;
    if (rows + head <= avail) return fs;
  }
  return 5.5;
}

export function buildSchedulePdf(weeks: SchedulePdfWeek[], opts: SchedulePdfOptions): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const depLabel = SHARE_DEPARTMENT_LABEL[opts.department];
  const { theme, logo, fonts } = opts;

  let bodyFont = 'helvetica';
  let headFont = theme.headingFont === 'cormorant' ? 'times' : 'helvetica';
  if (fonts) {
    doc.addFileToVFS('Jost-Regular.ttf', fonts.jostRegular);
    doc.addFont('Jost-Regular.ttf', 'Jost', 'normal');
    doc.addFileToVFS('Jost-SemiBold.ttf', fonts.jostSemiBold);
    doc.addFont('Jost-SemiBold.ttf', 'Jost', 'bold');
    doc.addFileToVFS('Cormorant-Bold.ttf', fonts.cormorantBold);
    doc.addFont('Cormorant-Bold.ttf', 'Cormorant', 'bold');
    bodyFont = 'Jost';
    headFont = theme.headingFont === 'cormorant' ? 'Cormorant' : 'Jost';
  }

  weeks.forEach((w, idx) => {
    if (idx > 0) doc.addPage('a4', 'landscape');
    const p = w.payload;
    const start = parseISO(p.weekStart);
    const dates = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    const employees = opts.onlyName ? p.employees.filter(e => e.name === opts.onlyName) : p.employees;

    // Seitenhintergrund wie die Mitarbeiterseite
    doc.setFillColor(...theme.bg);
    doc.rect(0, 0, PAGE_W, PAGE_H, 'F');

    // Kopf: Logo links, Titel rechts
    if (logo) {
      const h = theme.logoHeight;
      doc.addImage(logo.dataUrl, 'PNG', MARGIN, 8, h * logo.ratio, h);
    } else {
      doc.setFont(headFont, 'bold');
      doc.setFontSize(15);
      doc.setTextColor(...theme.ink);
      doc.text(theme.name, MARGIN, 16);
    }
    doc.setFont(headFont, 'bold');
    doc.setFontSize(22);
    doc.setTextColor(...theme.ink);
    doc.text(`Dienstplan ${depLabel}`, PAGE_W - MARGIN, 15, { align: 'right' });
    doc.setFont(bodyFont, 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...theme.muted);
    const range = `${format(start, 'd. MMMM', { locale: de })} – ${format(parseISO(p.weekEnd), 'd. MMMM yyyy', { locale: de })}`;
    doc.text(`KW ${p.kw} · ${range}${opts.onlyName ? ` · ${opts.onlyName}` : ''}`, PAGE_W - MARGIN, 21.5, { align: 'right' });
    // Zierlinie in der Akzentfarbe
    doc.setFillColor(...theme.accent);
    doc.roundedRect(PAGE_W - MARGIN - 14, 25, 14, 0.9, 0.45, 0.45, 'F');

    const buildBody = (sep: string) =>
      employees.map(e => [
        e.name,
        ...dates.map(d => pdfCellText(e.days.find(x => x.date === format(d, 'yyyy-MM-dd')), sep)),
      ]);
    const countLines = (rows: string[][]) => rows.map(r => Math.max(...r.map(c => c.split('\n').length)));
    // Zwei Schichten untereinander ist besser lesbar; passt es nicht lesbar auf die Seite,
    // werden sie nebeneinander gesetzt (größere Abteilungen).
    let body = buildBody('\n');
    let fs = pickFontSize(countLines(body));
    if (fs < READABLE_MIN) {
      body = buildBody(' · ');
      fs = pickFontSize(countLines(body));
    }
    const nameW = 44;
    const dayW = (PAGE_W - 2 * MARGIN - nameW) / 7;

    autoTable(doc, {
      startY: TOP - 4,
      margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: BOTTOM },
      head: [['Name', ...dates.map(d => format(d, 'EEEEEE d.M.', { locale: de }))]],
      body,
      theme: 'grid',
      styles: {
        font: bodyFont,
        fontSize: fs,
        cellPadding: fs > 7 ? 1.5 : 0.9,
        lineColor: theme.line,
        lineWidth: 0.2,
        textColor: theme.ink,
        fillColor: [255, 255, 255],
        valign: 'middle',
      },
      headStyles: {
        fillColor: theme.brand,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'center',
        lineColor: theme.brand,
      },
      columnStyles: {
        0: { cellWidth: nameW, fontStyle: 'bold', fillColor: theme.tint, halign: 'left' },
        ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 1, { cellWidth: dayW, halign: 'center' as const }])),
      },
      didParseCell: data => {
        if (data.section !== 'body' || data.column.index === 0) return;
        const t = String(data.cell.raw ?? '');
        // Wochenende zart eingefärbt
        if (data.column.index >= 6) data.cell.styles.fillColor = [250, 249, 244];
        // Abwesenheit (kein Zeitbereich): Farben wie auf der Mitarbeiterseite
        if (t && !/\d/.test(t)) {
          const c = ABSENCE_COLORS[t] ?? ABSENCE_COLORS.Abwesend;
          data.cell.styles.fillColor = c.bg;
          data.cell.styles.textColor = c.fg;
          data.cell.styles.fontStyle = 'bold';
        } else if (t) {
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    // Fußzeile
    doc.setDrawColor(...theme.line);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, PAGE_H - 10, PAGE_W - MARGIN, PAGE_H - 10);
    doc.setFont(bodyFont, 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...theme.muted);
    const stand = w.publishedAt
      ? ` · Stand ${format(parseISO(w.publishedAt), "d. MMM yyyy, HH:mm 'Uhr'", { locale: de })}`
      : '';
    doc.text(`${theme.name}${stand}`, MARGIN, PAGE_H - 5.5);
    doc.text(`KW ${p.kw} · Seite ${idx + 1} / ${weeks.length}`, PAGE_W - MARGIN, PAGE_H - 5.5, { align: 'right' });
  });

  return doc;
}

export async function downloadSchedulePdf(weeks: SchedulePdfWeek[], opts: SchedulePdfOptions): Promise<void> {
  if (weeks.length === 0) return;
  const [logo, fonts] = await Promise.all([
    opts.logo !== undefined ? opts.logo : loadPdfLogo(opts.theme.logoUrl, opts.theme.logoWhiteBg),
    opts.fonts !== undefined ? opts.fonts : loadPdfFonts(),
  ]);
  const doc = buildSchedulePdf(weeks, { ...opts, logo, fonts });
  doc.save(pdfFileName(opts.department, weeks, opts.theme.slug));
}
