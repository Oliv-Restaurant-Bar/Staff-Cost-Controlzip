/**
 * Lieferanten-Profile für die PDF-Rechnungserkennung (Mandant Beaulieu).
 *
 * Erkennung pro Lieferant über die MWST-Nr (zuverlässigster Schlüssel;
 * Name/IBAN als Fallback für Lieferanten ohne MWST-Nr, z.B. Hof am Stutz).
 * Die Profil-Tabelle ist in den Einstellungen editierbar und wird pro Mandant
 * im KV gespeichert (`waren_lieferanten_profile_v1`). Unbekannte MWST-Nrn
 * können direkt in der Import-Vorschau zugeordnet werden — die Zuordnung wird
 * dauerhaft als Profil gespeichert und greift beim nächsten PDF automatisch.
 */
import { kvGet, kvSet } from '@/lib/supabase-kv';
import { tenantKey } from '@/lib/tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';

/** MWST-Nr des eigenen Betriebs (Beaulieu) — taucht als Kunden-MWST-Nr auf
 *  Rechnungen auf (z.B. Rutishauser) und darf NIE als Lieferant matchen. */
export const EIGENE_MWST_NRN = ['336566594'];

/** Parser-Strategie für Stufe 2 (Positionen + Lieferdatum je Lieferung). */
export type ProfilParser = 'spahni' | 'fideco' | 'terravigna';

/**
 * Belegtyp des Lieferanten:
 * - 'dual': Einzel-Lieferscheine + Monatsrechnung (Feldschlösschen-Modell —
 *   Lieferschein führend, Monatsrechnung = Kontrolle + Lückenfüller).
 * - 'monatsrechnung': nur Monats-/Sammelrechnung (eine Buchung pro Rechnung).
 * - 'einzelrechnung': nur Einzelrechnungen (Default).
 */
export type ProfilBelegtyp = 'dual' | 'monatsrechnung' | 'einzelrechnung';

export interface LieferantenProfil {
  /** Stabile ID (Default-Profile: Kurzname; gelernte: `p-<mwstNr>`). */
  id: string;
  /** Lieferantenname, wie er als supplierName gebucht wird. */
  name: string;
  /** MWST-Nr, nur Ziffern (z.B. '219630115'); leer wenn keiner (Hof am Stutz). */
  mwstNr: string;
  /** Kategorie-Label (Warengruppe), z.B. 'Wein', 'Fleisch'. */
  kategorie: string;
  /** Standard-Warenkonto, z.B. '4020'. */
  konto: string;
  /** Üblicher MwSt-Satz in % (Vorbefüllung manuelle Erfassung). */
  mwstSatz?: number;
  /** Namens-Fallback: alle Tokens müssen im PDF-Text vorkommen (lowercase). */
  erkennungTokens?: string[];
  /** IBAN-Fallback (ohne Leerzeichen, uppercase). */
  iban?: string;
  /** Stufe-2-Parser (Positionen je Lieferung), wo das Layout es hergibt. */
  parser?: ProfilParser;
  /** Belegtyp (Default 'einzelrechnung'); 'dual' = Lieferschein führend. */
  belegtyp?: ProfilBelegtyp;
}

/** Vorbelegung gemäss Aufgabe — Konto in den Einstellungen anpassbar. */
export const DEFAULT_PROFILE_BEAULIEU: LieferantenProfil[] = [
  { id: 'obrist',      name: 'Obrist (Schenk Suisse)',  mwstNr: '219630115', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1 },
  { id: 'rutishauser', name: 'Rutishauser-DiVino',      mwstNr: '116319519', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1 },
  { id: 'terravigna',  name: 'Terravigna',              mwstNr: '108008709', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1, parser: 'terravigna' },
  { id: 'spahni',      name: 'Metzgerei Spahni',        mwstNr: '106963475', kategorie: 'Fleisch',          konto: '4060', mwstSatz: 2.6, parser: 'spahni', belegtyp: 'dual' },
  { id: 'fideco',      name: 'Fideco',                  mwstNr: '112839932', kategorie: 'Fleisch',          konto: '4060', mwstSatz: 2.6, parser: 'fideco', belegtyp: 'dual' },
  { id: 'gourmador',   name: 'Gourmador (frigemo)',     mwstNr: '105959488', kategorie: 'TK/Gemüse',        konto: '4060', mwstSatz: 2.6 },
  { id: 'bohnenblust', name: 'Bäckerei Bohnenblust',    mwstNr: '472136586', kategorie: 'Backwaren',        konto: '4060', mwstSatz: 2.6, belegtyp: 'dual' },
  { id: 'gasser',      name: 'Gasser',                  mwstNr: '107918916', kategorie: 'Food/Convenience', konto: '4060', mwstSatz: 2.6, belegtyp: 'dual' },
  { id: 'blaser',      name: 'Blaser Café',             mwstNr: '362510257', kategorie: 'Kaffee',           konto: '4070', mwstSatz: 2.6 },
  { id: 'hofamstutz',  name: 'Hof am Stutz',            mwstNr: '',          kategorie: 'Eier',             konto: '4060', mwstSatz: 0,
    erkennungTokens: ['hof am stutz'], iban: 'CH3830129016376058001' },
];

function profileKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'waren_lieferanten_profile_v1');
}

/** Nur Ziffern der MWST-Nr (CHE-219.630.115 → '219630115'). */
export function normalisiereMwstNr(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Lädt die Profile: gespeicherte Einträge überschreiben Defaults per id;
 * Defaults, die noch nie gespeichert wurden, bleiben sichtbar (Vorbelegung).
 * Parser-Strategie kommt IMMER aus den Defaults (nicht editierbar).
 */
export async function loadLieferantenProfile(tenantId: TenantId): Promise<LieferantenProfil[]> {
  let gespeichert: LieferantenProfil[] = [];
  try {
    const raw = await kvGet(profileKey(tenantId));
    if (Array.isArray(raw)) gespeichert = raw.filter((p): p is LieferantenProfil =>
      !!p && typeof p === 'object' && typeof (p as LieferantenProfil).id === 'string'
      && typeof (p as LieferantenProfil).name === 'string');
  } catch { /* Lesefehler ⇒ Defaults */ }
  const proId = new Map<string, LieferantenProfil>();
  for (const d of DEFAULT_PROFILE_BEAULIEU) proId.set(d.id, d);
  for (const g of gespeichert) {
    const def = DEFAULT_PROFILE_BEAULIEU.find(d => d.id === g.id);
    proId.set(g.id, {
      ...def, ...g,
      mwstNr: normalisiereMwstNr(g.mwstNr ?? def?.mwstNr ?? ''),
      // Parser + Fallback-Erkennung sind fest an die Default-Profile gebunden.
      parser: def?.parser,
      erkennungTokens: def?.erkennungTokens ?? g.erkennungTokens,
      iban: def?.iban ?? g.iban,
    });
  }
  return [...proId.values()];
}

export async function saveLieferantenProfile(tenantId: TenantId, profile: LieferantenProfil[]): Promise<void> {
  await kvSet(profileKey(tenantId), profile.map(p => ({ ...p, mwstNr: normalisiereMwstNr(p.mwstNr) })));
}

/**
 * Neue/aktualisierte Zuordnung MWST-Nr → Lieferant/Konto dauerhaft speichern
 * (aus der Import-Vorschau, «gilt dann dauerhaft»). Gibt die neue Liste zurück.
 */
export async function lerneProfil(
  tenantId: TenantId,
  zuordnung: { mwstNr: string; name: string; konto: string; kategorie: string; mwstSatz?: number },
): Promise<LieferantenProfil[]> {
  const nr = normalisiereMwstNr(zuordnung.mwstNr);
  const alle = await loadLieferantenProfile(tenantId);
  const vorhanden = alle.find(p => p.mwstNr === nr && nr !== '')
    ?? alle.find(p => p.name.trim().toLowerCase() === zuordnung.name.trim().toLowerCase());
  let next: LieferantenProfil[];
  if (vorhanden) {
    next = alle.map(p => p.id === vorhanden.id
      ? { ...p, mwstNr: nr || p.mwstNr, name: zuordnung.name, konto: zuordnung.konto, kategorie: zuordnung.kategorie, ...(zuordnung.mwstSatz !== undefined ? { mwstSatz: zuordnung.mwstSatz } : {}) }
      : p);
  } else {
    next = [...alle, { id: `p-${nr || Date.now()}`, name: zuordnung.name, mwstNr: nr, kategorie: zuordnung.kategorie, konto: zuordnung.konto, ...(zuordnung.mwstSatz !== undefined ? { mwstSatz: zuordnung.mwstSatz } : {}) }];
  }
  await saveLieferantenProfile(tenantId, next);
  return next;
}

/** Alle im Text gefundenen fremden MWST-Nrn (eigene ausgeschlossen). */
export function findeMwstNrnImText(text: string): string[] {
  const out: string[] = [];
  const re = /CHE[-\s.]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const nr = `${m[1]}${m[2]}${m[3]}`;
    if (!EIGENE_MWST_NRN.includes(nr) && !out.includes(nr)) out.push(nr);
  }
  return out;
}

/**
 * Profil im PDF-Text finden: 1. MWST-Nr (eigene Nr ignoriert), 2. Name-Tokens,
 * 3. IBAN. Gibt zusätzlich die gefundenen fremden MWST-Nrn zurück (für die
 * «Lieferant offen»-Zuordnung in der Vorschau).
 */
export function findeProfilImText(
  text: string,
  profile: LieferantenProfil[],
): { profil: LieferantenProfil | null; mwstNrn: string[] } {
  const mwstNrn = findeMwstNrnImText(text);
  for (const nr of mwstNrn) {
    const p = profile.find(x => x.mwstNr === nr);
    if (p) return { profil: p, mwstNrn };
  }
  const lower = text.toLowerCase();
  const kompakt = text.replace(/\s/g, '').toUpperCase();
  for (const p of profile) {
    if (p.erkennungTokens?.length && p.erkennungTokens.every(t => lower.includes(t))) return { profil: p, mwstNrn };
    if (p.iban && kompakt.includes(p.iban.replace(/\s/g, '').toUpperCase())) return { profil: p, mwstNrn };
  }
  return { profil: null, mwstNrn };
}
