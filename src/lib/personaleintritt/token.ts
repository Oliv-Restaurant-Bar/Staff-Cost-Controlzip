/**
 * Personaleintritt — Einladungs-Token (WebCrypto, kein Supabase)
 * ==============================================================
 * In der DB liegt NUR der sha256-Hash (invite_token_hash) — der Klartext-Token
 * existiert ausschliesslich im Einladungslink (bewusste Spec-Abweichung:
 * ein DB-Leak verrät so keine gültigen Links).
 */

/** 32 Byte Zufall, base64url (43 Zeichen, ohne Padding). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** sha256-Hex über den Klartext-Token (identisch in der Edge Function). */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Gültigkeitsdauer der Einladung: 14 Tage. */
export const INVITE_GUELTIGKEIT_TAGE = 14;

export function inviteExpiryIso(from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + INVITE_GUELTIGKEIT_TAGE);
  return d.toISOString();
}

/** Öffentlicher Einladungslink für die Phase-2-Route. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/e/${token}`;
}
