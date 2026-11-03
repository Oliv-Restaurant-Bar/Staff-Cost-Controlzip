/**
 * client.ts — browser side of "Mit KI lesen": prepares the pages, calls the
 * server function and validates the answer. Never saves anything.
 */
import { supabase } from '@/integrations/supabase/client';
import { tr } from '@/lib/unified-import/strings';
import { preparePages, KiPrepareError } from './prepare';
import { parseKiAntwort, type KiRechnung } from './schema';

export type KiLeseErgebnis =
  | { ok: true; daten: KiRechnung; model: string }
  | { ok: false; message: string };

const PREPARE_MESSAGE: Record<KiPrepareError['code'], string> = {
  'unsupported': tr('Dateityp wird nicht unterstützt (PDF, JPG, PNG, WebP oder HEIC).', 'File type not supported (PDF, JPG, PNG, WebP or HEIC).'),
  'image-undecodable': tr('Das Bild kann in diesem Browser nicht gelesen werden — bitte als JPG oder PDF teilen.', 'This browser cannot read the image — please share it as JPG or PDF.'),
  'pdf-unreadable': tr('Das PDF kann nicht geöffnet werden.', 'The PDF cannot be opened.'),
  'too-many-pages': tr('Das PDF hat zu viele Seiten (max. 6).', 'The PDF has too many pages (max. 6).'),
  'too-large': tr('Die Datei ist zu gross, auch nach dem Verkleinern.', 'The file is too large, even after shrinking.'),
};

const SERVER_MESSAGE: Record<string, string> = {
  'unauthorized': tr('Bitte neu anmelden.', 'Please sign in again.'),
  'forbidden': tr('Keine Berechtigung zum Erfassen von Rechnungen.', 'No permission to record invoices.'),
  'rate-limited': tr('Zu viele KI-Lesungen in der letzten Stunde — bitte später erneut versuchen.', 'Too many AI readings in the last hour — please try again later.'),
  'not-configured': tr('KI-Lesen ist auf diesem System noch nicht eingerichtet.', 'AI reading is not set up on this system yet.'),
  'bad-pages': tr('Die Datei konnte nicht übertragen werden.', 'The file could not be sent.'),
};

const FALLBACK = tr(
  'KI konnte den Beleg nicht lesen — bitte manuell erfassen.',
  'The AI could not read the document — please enter it manually.',
);

/** Reads one scan/photo with the AI. Only call this from an explicit user click. */
export async function leseRechnungPerKi(file: File): Promise<KiLeseErgebnis> {
  let pages: string[];
  try {
    pages = await preparePages(file);
  } catch (e) {
    return { ok: false, message: e instanceof KiPrepareError ? PREPARE_MESSAGE[e.code] : FALLBACK };
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { ok: false, message: SERVER_MESSAGE.unauthorized };
  let res: Response;
  try {
    res = await fetch('/api/read-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ pages }),
    });
  } catch {
    return { ok: false, message: FALLBACK };
  }
  let body: { ok?: boolean; error?: string; data?: unknown; model?: string } = {};
  try { body = await res.json(); } catch { /* HTML error page, e.g. 413 */ }
  if (res.status === 413) return { ok: false, message: PREPARE_MESSAGE['too-large'] };
  if (!res.ok || !body.ok) return { ok: false, message: SERVER_MESSAGE[body.error ?? ''] ?? FALLBACK };
  const parsed = parseKiAntwort(body.data);
  if (parsed.ok === false) return { ok: false, message: FALLBACK };
  return { ok: true, daten: parsed.daten, model: body.model ?? '' };
}
