/**
 * Phase-2-Client — spricht die Edge Function personaleintritt-public an.
 * KEIN direkter Tabellenzugriff (RLS bleibt authenticated-only); der
 * Einladungs-Token ist die einzige Berechtigung.
 */
import type { MaDaten, MaDokumentTyp } from './types';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/personaleintritt-public`;

export interface PublicEckdaten {
  status: string;
  vertragstyp?: 'SL' | 'ML';
  betrieb?: string;
  funktion?: string;
  eintritt?: string;
  pensumProzent?: number;
  probezeitTage?: number;
  vertragsdauer?: string;
  befristetBis?: string;
  maDaten: MaDaten;
}

export type PublicGetResult =
  | { kind: 'ok'; record: PublicEckdaten }
  | { kind: 'submitted'; status: string }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

async function postJson(body: Record<string, unknown>): Promise<Response> {
  return fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

export async function publicGet(token: string): Promise<PublicGetResult> {
  try {
    const res = await postJson({ action: 'get', token });
    if (res.status === 404 || res.status === 401) return { kind: 'invalid' };
    if (res.status === 410) return { kind: 'expired' };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: 'error', message: body.error ?? `Fehler (${res.status})` };
    if (body.submitted) return { kind: 'submitted', status: body.status ?? 'ausgefuellt' };
    return { kind: 'ok', record: body.record as PublicEckdaten };
  } catch {
    return { kind: 'error', message: 'Verbindung fehlgeschlagen — bitte erneut versuchen.' };
  }
}

export interface PublicWriteResult {
  ok: boolean;
  /** true, wenn der Datensatz bereits übermittelt wurde (Link verbraucht). */
  alreadySubmitted?: boolean;
  expired?: boolean;
  error?: string;
}

async function handleWrite(res: Response): Promise<PublicWriteResult> {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true };
  if (res.status === 409) return { ok: false, alreadySubmitted: true, error: body.error };
  if (res.status === 410) return { ok: false, expired: true, error: body.error };
  return { ok: false, error: body.error ?? `Fehler (${res.status})` };
}

export async function publicSave(token: string, maDaten: MaDaten): Promise<PublicWriteResult> {
  try {
    return await handleWrite(await postJson({ action: 'save', token, maDaten }));
  } catch {
    return { ok: false, error: 'Verbindung fehlgeschlagen — bitte erneut versuchen.' };
  }
}

export async function publicSubmit(token: string, maDaten: MaDaten): Promise<PublicWriteResult> {
  try {
    return await handleWrite(await postJson({ action: 'submit', token, maDaten }));
  } catch {
    return { ok: false, error: 'Verbindung fehlgeschlagen — bitte erneut versuchen.' };
  }
}

export async function publicUpload(
  token: string,
  typ: MaDokumentTyp,
  file: File,
): Promise<PublicWriteResult & { path?: string }> {
  try {
    const form = new FormData();
    form.set('action', 'upload');
    form.set('token', token);
    form.set('typ', typ);
    form.set('file', file);
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, path: body.path };
    if (res.status === 409) return { ok: false, alreadySubmitted: true, error: body.error };
    if (res.status === 410) return { ok: false, expired: true, error: body.error };
    return { ok: false, error: body.error ?? `Fehler (${res.status})` };
  } catch {
    return { ok: false, error: 'Verbindung fehlgeschlagen — bitte erneut versuchen.' };
  }
}
