/**
 * Ignorier-Liste für den FIBU-Abgleich («In der Buchhaltung, aber nicht erfasst»).
 *
 * Buchhaltungszeilen werden NIE gelöscht (die Buchhaltung ist die Kontrollquelle) —
 * sie werden nur im Abgleich als «bewusst ignoriert» markiert. Die Liste ist
 * mandantengetrennt und import-fest: Kandidaten werden bei jedem Journal-Import
 * neu aus dem Journal abgeleitet und hier per Wiedererkennungs-Schlüssel wieder
 * ausgeblendet.
 *
 * Schlüssel: mandant (via tenantKey) + Beleg-/Rechnungsnummer; ohne Nummer
 * Fallback Datum + Betrag + Buchungstext. Ein Schlüssel steht genau EINMAL in
 * der Liste (Map ⇒ Ersetzen statt Addieren).
 */
import { kvGet } from './supabase-kv';
import { tenantKey } from './tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';

export interface AbgleichIgnoriertEintrag {
  /** Wiedererkennungs-Schlüssel (siehe abgleichIgnoriertKey). */
  key: string;
  belegNr?: string;
  lieferant?: string;
  /** Buchungsdatum ISO (YYYY-MM-DD). */
  datumIso: string;
  betrag: number;
  /** Buchungstext (Anzeige + Fallback-Schlüssel). */
  text: string;
  /** Optionaler Grund («Privatbezug», …). */
  grund?: string;
  /** Zeitpunkt des Ignorierens (ISO). */
  ignoriertAm: string;
}

export interface AbgleichIgnoriertListe {
  eintraege: Record<string, AbgleichIgnoriertEintrag>;
}

const KEY = 'waren_abgleich_ignoriert_v1';

const normText = (t: string) => (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Schlüssel-Input: minimale Felder eines Kandidaten/Journal-Zeile. */
export interface AbgleichKeyInput {
  belegNr?: string | null;
  datumIso: string;
  betrag: number;
  text: string;
  /** Aufgelöster Lieferant (falls zugeordnet) — Diskriminator gegen Beleg-Nr-Kollisionen. */
  lieferant?: string | null;
}

/**
 * Wiedererkennungs-Schlüssel: bevorzugt Beleg-/Rechnungsnummer, kollisions-
 * sicher ergänzt um Datum+Betrag (Belegnummern wiederholen sich über
 * Lieferanten/Jahre — ein Re-Import derselben Rechnung hat aber immer
 * dieselbe Nummer, dasselbe Datum und denselben Betrag ⇒ import-fest, auch
 * wenn Text/Konto leicht abweichen). Fallback ohne Nummer: Datum+Betrag+Text
 * (bewusst konservativ — ändert sich der Text, wird die Zeile wieder
 * sichtbar, nie still ausgeblendet). Mandant steckt im KV-Key (tenantKey).
 */
export function abgleichIgnoriertKey(k: AbgleichKeyInput): string {
  const betrag = (Math.round(k.betrag * 100) / 100).toFixed(2);
  const beleg = (k.belegNr ?? '').trim();
  // Lieferanten-Diskriminator: aufgelöster Lieferant, sonst konservativ der
  // Buchungstext — zwei Lieferanten mit gleicher Nummer/Datum/Betrag kollidieren
  // so nicht. Ändert sich die Zuordnung später, wird die Zeile wieder SICHTBAR
  // (fail-open, nie still ausgeblendet).
  const wer = normText(k.lieferant ?? '') || normText(k.text);
  if (beleg) return `beleg:${beleg.toLowerCase()}|${k.datumIso}|${betrag}|${wer}`;
  return `f:${k.datumIso}|${betrag}|${normText(k.text)}`;
}

function normalisiere(raw: unknown): AbgleichIgnoriertListe {
  const out: AbgleichIgnoriertListe = { eintraege: {} };
  if (!raw || typeof raw !== 'object') return out;
  const e = (raw as { eintraege?: unknown }).eintraege;
  if (!e || typeof e !== 'object') return out;
  for (const [key, v] of Object.entries(e as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const x = v as Partial<AbgleichIgnoriertEintrag>;
    if (typeof x.datumIso !== 'string' || typeof x.betrag !== 'number' || !Number.isFinite(x.betrag)) continue;
    out.eintraege[key] = {
      key,
      belegNr: typeof x.belegNr === 'string' && x.belegNr ? x.belegNr : undefined,
      lieferant: typeof x.lieferant === 'string' && x.lieferant ? x.lieferant : undefined,
      datumIso: x.datumIso,
      betrag: x.betrag,
      text: typeof x.text === 'string' ? x.text : '',
      grund: typeof x.grund === 'string' && x.grund ? x.grund : undefined,
      ignoriertAm: typeof x.ignoriertAm === 'string' ? x.ignoriertAm : '',
    };
  }
  return out;
}

/** Liste laden (tolerant; Lesefehler ⇒ leere Liste NUR für Anzeige — Schreibpfade lesen strikt frisch). */
export async function ladeAbgleichIgnoriert(tenantId: TenantId): Promise<AbgleichIgnoriertListe> {
  try {
    return normalisiere(await kvGet(tenantKey(tenantId, KEY)));
  } catch {
    return { eintraege: {} };
  }
}

/** Strikt speichern — Fehler werfen (kvSet schluckt sie still). */
async function speichere(tenantId: TenantId, liste: AbgleichIgnoriertListe): Promise<void> {
  const { kvSetStrict } = await import('./supabase-kv');
  await kvSetStrict(tenantKey(tenantId, KEY), liste);
}

/**
 * Zeile ignorieren: Liste FRISCH lesen (kein Cache — No-CAS-KV), Eintrag per
 * Schlüssel ERSETZEN (dublettensicher), strikt speichern.
 */
export async function ignoriereAbgleichZeile(
  tenantId: TenantId,
  input: AbgleichKeyInput & { grund?: string },
): Promise<AbgleichIgnoriertEintrag> {
  const liste = normalisiere(await kvGet(tenantKey(tenantId, KEY)));
  const key = abgleichIgnoriertKey(input);
  const eintrag: AbgleichIgnoriertEintrag = {
    key,
    belegNr: (input.belegNr ?? '').trim() || undefined,
    lieferant: (input.lieferant ?? '').trim() || undefined,
    datumIso: input.datumIso,
    betrag: Math.round(input.betrag * 100) / 100,
    text: input.text ?? '',
    grund: input.grund?.trim() || undefined,
    ignoriertAm: new Date().toISOString(),
  };
  liste.eintraege[key] = eintrag; // Ersetzen statt Addieren
  await speichere(tenantId, liste);
  return eintrag;
}

/** «Wieder aufnehmen» / Undo: Eintrag aus der Liste entfernen. */
export async function wiederAufnehmenAbgleichZeile(tenantId: TenantId, key: string): Promise<boolean> {
  const liste = normalisiere(await kvGet(tenantKey(tenantId, KEY)));
  if (!(key in liste.eintraege)) return false;
  delete liste.eintraege[key];
  await speichere(tenantId, liste);
  return true;
}

/**
 * Kandidaten gegen die Ignorier-Liste filtern.
 * Rückgabe: sichtbare Kandidaten + die als ignoriert erkannten (für die
 * «Ignorierte anzeigen»-Ansicht des aktuellen Zeitraums).
 */
export function filterIgnorierteKandidaten<T extends AbgleichKeyInput>(
  kandidaten: T[],
  liste: AbgleichIgnoriertListe,
): { sichtbar: T[]; ignoriert: T[] } {
  const sichtbar: T[] = [];
  const ignoriert: T[] = [];
  for (const k of kandidaten) {
    // Schlüssel enthält Beleg+Datum+Betrag (bzw. Datum+Betrag+Text) — Kollisionen
    // über Lieferanten/Jahre matchen nicht; unbekannte Schlüssel bleiben SICHTBAR.
    (abgleichIgnoriertKey(k) in liste.eintraege ? ignoriert : sichtbar).push(k);
  }
  return { sichtbar, ignoriert };
}
