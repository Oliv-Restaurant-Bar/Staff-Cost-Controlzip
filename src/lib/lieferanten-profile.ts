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
export type ProfilParser = 'spahni' | 'fideco' | 'terravigna' | 'ambro' | 'transgourmet' | 'caporaso' | 'gasser' | 'gourmador';

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
  /** Auftragsbestätigung gilt als Lieferschein: wird PROVISORISCH gebucht,
   *  die (massgebliche) Monatsrechnung ersetzt/korrigiert sie später.
   *  Standard = false: AB/Offerte/Bestellung werden NIE gebucht (Sperre). */
  abAlsLieferschein?: boolean;
  /** «Monatsrechnung: ja/nein» (pro Lieferant einstellbar):
   *  - JA: Lieferscheine bleiben provisorisch, bis die Monatsrechnung sie
   *    ersetzt/finalisiert (Lieferschein→Monatsrechnung-Workflow).
   *  - NEIN: jede Einzelrechnung bucht sofort FINAL (keine provisorische Stufe).
   *  Ohne expliziten Wert wird aus dem Belegtyp abgeleitet (dual/monats-
   *  rechnung ⇒ ja, einzelrechnung ⇒ nein) — siehe hatMonatsrechnung(). */
  monatsrechnung?: boolean;
}

/** Effektives «Monatsrechnung ja/nein» eines Profils (explizit > Belegtyp). */
export function hatMonatsrechnung(p: LieferantenProfil): boolean {
  return p.monatsrechnung ?? (p.belegtyp === 'dual' || p.belegtyp === 'monatsrechnung');
}

/** Caporaso: fester Konto-Split über die MwSt-Basis der Rechnungssumme —
 *  2.6 %-Basis → 4060 Küche (Food), 8.1 %-Basis → 4701 Betriebsmaterial
 *  (Verpackung, kein Wareneinsatz). Warengruppen-Labels der Parser-Positionen. */
export const CAPORASO_KONTEN: Record<string, string> = {
  'Küche': '4060',
  'Betriebsmaterial': '4701',
};

/** Vorbelegung gemäss Aufgabe — Konto in den Einstellungen anpassbar. */
export const DEFAULT_PROFILE_BEAULIEU: LieferantenProfil[] = [
  // Obrist/Schenk: Einzelrechnung, bucht sofort final. Namens-Fallback
  // «schenk suisse» (Buchungen laufen z.T. unter «Schenk Suisse S.A.»);
  // matcht NICHT «Schenk Family Wine».
  { id: 'obrist',      name: 'Obrist (Schenk Suisse)',  mwstNr: '219630115', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1, monatsrechnung: false,
    erkennungTokens: ['schenk suisse'] },
  // Rutishauser-DiVino: 08/2026 zunächst als Altlast entfernt, auf User-Wunsch
  // wieder aktiv (Wein-Einzelrechnungen, bucht sofort final wie Schenk).
  { id: 'rutishauser', name: 'Rutishauser-DiVino',      mwstNr: '116319519', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1, monatsrechnung: false },
  { id: 'terravigna',  name: 'Terravigna',              mwstNr: '108008709', kategorie: 'Wein',             konto: '4020', mwstSatz: 8.1, parser: 'terravigna', belegtyp: 'dual', abAlsLieferschein: true, monatsrechnung: true },
  { id: 'spahni',      name: 'Metzgerei Spahni',        mwstNr: '106963475', kategorie: 'Fleisch',          konto: '4060', mwstSatz: 2.6, parser: 'spahni', belegtyp: 'dual', monatsrechnung: true },
  { id: 'fideco',      name: 'Fideco',                  mwstNr: '112839932', kategorie: 'Fleisch',          konto: '4060', mwstSatz: 2.6, parser: 'fideco', belegtyp: 'dual' },
  // Gourmador: DUAL — Lieferscheine laufen provisorisch (importiert ODER
  // manuell erfasst); die Faktura (Monatsrechnung) gleicht gegen die
  // Lieferschein-Summe ab und ERSETZT sie (Differenz einzeln bestätigen).
  // Stufe-2-Parser: «Beleg-Nr. … vom …»-Blöcke je Lieferung.
  { id: 'gourmador',   name: 'Gourmador (frigemo)',     mwstNr: '105959488', kategorie: 'TK/Gemüse',        konto: '4060', mwstSatz: 2.6, parser: 'gourmador', belegtyp: 'dual', monatsrechnung: true },
  // The Asia Company: Einzelrechnung, bucht sofort final. Split aus der
  // rechnungseigenen «Zusammenfassung Kontierung» (Codes 420xx = alle Küche
  // → 4060); fremde Codes werden in der Vorschau gemeldet, nie geraten.
  { id: 'asia',        name: 'The Asia Company',        mwstNr: '115846638', kategorie: 'Küche',            konto: '4060', mwstSatz: 2.6, monatsrechnung: false },
  // Bäckerei Bohnenblust bewusst KEIN Profil: wird ausschliesslich MANUELL
  // erfasst (freie Mandantenwahl) — siehe BOHNENBLUST_AUSGESCHLOSSEN.
  // Oliv-Lieferanten (Profile gelten mandantenweit; Erkennung via MWST-Nr).
  { id: 'transgourmet', name: 'Transgourmet',           mwstNr: '116311185', kategorie: 'Food',             konto: '4000', mwstSatz: 2.6, parser: 'transgourmet', monatsrechnung: false },
  // Ambro: DUAL — Lieferscheine (eigener Beleg mit Belegnummer) laufen
  // provisorisch während des Monats, die Monatsrechnung ersetzt sie (wie
  // Terravigna). Alle Positionen Küche → Konto 4060.
  { id: 'ambro',        name: 'Ambro Food',             mwstNr: '102097525', kategorie: 'Food',             konto: '4060', mwstSatz: 2.6, parser: 'ambro', belegtyp: 'dual', monatsrechnung: true },
  // Gasser Gourmet: SAMMELRECHNUNG mit Lieferschein-Blöcken je Tag (wie
  // Fideco, eigenes Layout «LS-Nr  LS-Datum … Betrag») → Stufe-2-Parser.
  { id: 'gasser',      name: 'Gasser',                  mwstNr: '107918916', kategorie: 'Food/Convenience', konto: '4060', mwstSatz: 2.6, parser: 'gasser', belegtyp: 'dual' },
  { id: 'blaser',      name: 'Blaser Café',             mwstNr: '362510257', kategorie: 'Kaffee',           konto: '4070', mwstSatz: 2.6, monatsrechnung: false },
  // Caporaso: LIEFERSCHEIN-RECHNUNG (Einzelbeleg, bucht sofort final);
  // Konto-Split via MwSt-Basis (2.6 % → 4060 Küche, 8.1 % → 4701 Betriebs-
  // material). Keine MWST-Nr im Beleg-Kopf hinterlegt → Namens-Erkennung.
  { id: 'caporaso',    name: 'Caporaso',                mwstNr: '',          kategorie: 'Küche',            konto: '4060', mwstSatz: 2.6, parser: 'caporaso', monatsrechnung: false,
    erkennungTokens: ['caporaso'] },
  { id: 'hofamstutz',  name: 'Hof am Stutz',            mwstNr: '',          kategorie: 'Eier',             konto: '4060', mwstSatz: 0,
    erkennungTokens: ['hof am stutz'], iban: 'CH3830129016376058001' },
];

/** Vom Automatik-Import AUSGESCHLOSSEN (nur manuelle Erfassung): früher
 *  gespeicherte KV-Profile dieser IDs/MWST-Nrn werden beim Laden gefiltert. */
const BOHNENBLUST_AUSGESCHLOSSEN = { ids: ['bohnenblust'], mwstNrn: ['472136586'] };

/** Altlasten-Lieferanten (kein Lieferant mehr): früher gespeicherte
 *  KV-Profile dieser IDs/MWST-Nrn werden beim Laden gefiltert.
 *  Rutishauser wurde 08/2026 wieder aktiviert (kein Filter mehr). */
const ALTLASTEN_ENTFERNT = { ids: [] as string[], mwstNrn: [] as string[] };

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
      // AB-als-Lieferschein ist fest an die Default-Profile gebunden (Terravigna).
      abAlsLieferschein: def?.abAlsLieferschein,
    });
  }
  return [...proId.values()].filter(p =>
    !BOHNENBLUST_AUSGESCHLOSSEN.ids.includes(p.id)
    && !BOHNENBLUST_AUSGESCHLOSSEN.mwstNrn.includes(normalisiereMwstNr(p.mwstNr))
    && !ALTLASTEN_ENTFERNT.ids.includes(p.id)
    && !ALTLASTEN_ENTFERNT.mwstNrn.includes(normalisiereMwstNr(p.mwstNr)));
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
  zuordnung: {
    mwstNr: string; name: string; konto: string; kategorie: string; mwstSatz?: number;
    /** Erkennungs-Tokens/IBAN für die PDF-Wiedererkennung OHNE MWST-Nr. */
    erkennungTokens?: string[]; iban?: string;
  },
): Promise<LieferantenProfil[]> {
  const nr = normalisiereMwstNr(zuordnung.mwstNr);
  const alle = await loadLieferantenProfile(tenantId);
  const vorhanden = alle.find(p => p.mwstNr === nr && nr !== '')
    ?? alle.find(p => p.name.trim().toLowerCase() === zuordnung.name.trim().toLowerCase());
  // OHNE MWST-Nr muss das Profil per Name-Token/IBAN wiedererkennbar sein,
  // sonst legt jeder Re-Import denselben Lieferanten neu an (Duplikate).
  // Tokens: signifikante Namens-Wörter (≥3 Zeichen, lowercase) — alle müssen
  // im PDF-Text vorkommen (findeProfilImText). Lernen ist KUMULATIV: ein Undo
  // des Imports entfernt gelernte Profile bewusst NICHT.
  const autoTokens = nr === '' && !zuordnung.erkennungTokens
    ? zuordnung.name.toLowerCase().split(/[^a-zäöüéèà0-9]+/i).filter(t => t.length >= 3)
    : undefined;
  const extra = {
    ...(zuordnung.mwstSatz !== undefined ? { mwstSatz: zuordnung.mwstSatz } : {}),
    ...(zuordnung.iban ? { iban: zuordnung.iban } : {}),
  };
  const tokens = zuordnung.erkennungTokens ?? autoTokens;
  let next: LieferantenProfil[];
  if (vorhanden) {
    next = alle.map(p => p.id === vorhanden.id
      ? {
        ...p, mwstNr: nr || p.mwstNr, name: zuordnung.name, konto: zuordnung.konto, kategorie: zuordnung.kategorie, ...extra,
        // bestehende Tokens/IBAN nie wegwerfen — nur ergänzen, wenn leer
        ...(tokens && tokens.length > 0 && !(p.erkennungTokens?.length) ? { erkennungTokens: tokens } : {}),
      }
      : p);
  } else {
    next = [...alle, {
      id: `p-${nr || Date.now()}`, name: zuordnung.name, mwstNr: nr, kategorie: zuordnung.kategorie, konto: zuordnung.konto, ...extra,
      ...(tokens && tokens.length > 0 ? { erkennungTokens: tokens } : {}),
    }];
  }
  await saveLieferantenProfile(tenantId, next);
  return next;
}

/**
 * Mandant aus der BELEG-Adresse erkennen: «Oliv Gastro AG»/«Restaurant & Bar
 * Oliv»/«Oliv Restaurant & Bar» → oliv; «Restaurant Beaulieu AG» → beaulieu.
 * Beide oder keines gefunden → null (nie raten). Dient als Gegenprobe beim
 * Import: eine Rechnung des FALSCHEN Mandanten wird blockiert, nie umgebucht.
 *
 * AUSNAHME Bohnenblust: wird ausschliesslich MANUELL erfasst — die Beleg-
 * Adresse ist dort immer Beaulieu (auch für Oliv-Lieferungen), deshalb greift
 * hier KEINE adressbasierte Sperre (→ null).
 */
export function erkenneMandantImText(text: string): 'oliv' | 'beaulieu' | null {
  if (/Bohnenblust/i.test(text)) return null;
  const oliv = /Oliv\s+Gastro\s+AG|Restaurant\s*&?\s*Bar\s+Oliv|Oliv\s+Restaurant\s*&\s*Bar/i.test(text);
  const beaulieu = /Restaurant\s+Beaulieu(?:\s+AG)?/i.test(text);
  if (oliv && !beaulieu) return 'oliv';
  if (beaulieu && !oliv) return 'beaulieu';
  return null;
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
