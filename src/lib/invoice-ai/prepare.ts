/**
 * prepare.ts — turns a photo or scanned PDF into small JPEG pages (base64) for
 * the AI call. Keeps the request under Vercel's 4.5 MB body limit and cuts cost:
 * long edge 1600 px, JPEG quality 0.85, at most 6 pages. Browser-only.
 */
import * as pdfjsLib from 'pdfjs-dist';
import { ensurePdfWorkerConfigured } from '@/lib/pdf-worker-setup';

export const KI_MAX_PAGES = 6;
const LONG_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export class KiPrepareError extends Error {
  constructor(public code: 'unsupported' | 'image-undecodable' | 'pdf-unreadable' | 'too-many-pages' | 'too-large') {
    super(code);
  }
}

export const isImageFile = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
export const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Largest scale factor so that the long edge is at most LONG_EDGE (never upscales). */
export function fitScale(width: number, height: number, longEdge = LONG_EDGE): number {
  const m = Math.max(width, height);
  return m > longEdge ? longEdge / m : 1;
}

function canvasToBase64Jpeg(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return url.slice(url.indexOf(',') + 1);
}

const isHeic = (f: File) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

/** iPhone photos: browsers other than Safari cannot decode HEIC, so convert it to JPEG first (library loaded only then). */
async function heicToJpeg(file: File): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}

async function imageToPage(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    // imageOrientation applies the EXIF rotation of phone photos.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (!isHeic(file)) throw new KiPrepareError('image-undecodable');
    try {
      bitmap = await createImageBitmap(await heicToJpeg(file), { imageOrientation: 'from-image' });
    } catch {
      throw new KiPrepareError('image-undecodable');
    }
  }
  try {
    const s = fitScale(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * s));
    canvas.height = Math.max(1, Math.round(bitmap.height * s));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new KiPrepareError('image-undecodable');
    ctx.fillStyle = '#fff'; // PNG transparency -> white
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = canvasToBase64Jpeg(canvas);
    canvas.width = 0; canvas.height = 0;
    return out;
  } finally {
    bitmap.close();
  }
}

async function pdfToPages(file: File): Promise<string[]> {
  ensurePdfWorkerConfigured();
  let doc: pdfjsLib.PDFDocumentProxy;
  try {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    throw new KiPrepareError('pdf-unreadable');
  }
  try {
    if (doc.numPages > KI_MAX_PAGES) throw new KiPrepareError('too-many-pages');
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // A4 at 72 dpi is only ~842 px: render so the long edge is exactly LONG_EDGE.
      const vp = page.getViewport({ scale: LONG_EDGE / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new KiPrepareError('pdf-unreadable');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      pages.push(canvasToBase64Jpeg(canvas));
      canvas.width = 0; canvas.height = 0;
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

/** Photo or PDF -> base64 JPEG pages. Throws KiPrepareError with a code the UI maps to a message. */
export async function preparePages(file: File): Promise<string[]> {
  const pages = isPdfFile(file) ? await pdfToPages(file)
    : isImageFile(file) ? [await imageToPage(file)]
    : (() => { throw new KiPrepareError('unsupported'); })();
  const total = pages.reduce((s, p) => s + p.length, 0);
  if (total > 4_000_000 || pages.some(p => p.length > 1_400_000)) throw new KiPrepareError('too-large');
  return pages;
}
