// @vitest-environment node
/**
 * Personaleintritt — Validierung (REINE Logik, kein DOM/Supabase)
 * ===============================================================
 * AHV-Nummer (756.xxxx.xxxx.xx, EAN-13-Prüfziffer), IBAN (ISO 13616 mod-97),
 * Pflichtfelder je Vertragstyp für das Phase-2-Formular.
 */

import type { MaDaten, Vertragstyp } from './types';
import { MA_DOKUMENT_TYPEN } from './types';

// ─── AHV-Nummer ───────────────────────────────────────────────────────────────

/** Nur Ziffern extrahieren (erlaubt Eingaben mit/ohne Punkte). */
function ahvDigits(input: string): string {
  return (input ?? '').replace(/\D/g, '');
}

/**
 * Schweizer AHV-Nummer: 13 Ziffern, beginnt mit 756, EAN-13-Prüfziffer.
 * Akzeptiert «756.1234.5678.97» wie auch «7561234567897».
 */
export function isValidAhv(input: string): boolean {
  const d = ahvDigits(input);
  if (d.length !== 13 || !d.startsWith('756')) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = d.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? n : n * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === d.charCodeAt(12) - 48;
}

/** Formatiert 13 Ziffern als 756.xxxx.xxxx.xx (Eingabe unverändert, wenn unvollständig). */
export function formatAhv(input: string): string {
  const d = ahvDigits(input);
  if (d.length !== 13) return input;
  return `${d.slice(0, 3)}.${d.slice(3, 7)}.${d.slice(7, 11)}.${d.slice(11)}`;
}

// ─── IBAN ─────────────────────────────────────────────────────────────────────

/**
 * IBAN-Prüfung nach ISO 13616 (mod-97 == 1). Länderlängen für CH/LI/DE/AT/FR/IT
 * geprüft, andere Länder nur strukturell (2 Buchstaben + 2 Ziffern + 11–30 Zeichen).
 */
export function isValidIban(input: string): boolean {
  const iban = (input ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const laengen: Record<string, number> = { CH: 21, LI: 21, DE: 22, AT: 20, FR: 27, IT: 27 };
  const erwartet = laengen[iban.slice(0, 2)];
  if (erwartet != null && iban.length !== erwartet) return false;
  // mod-97 über umgestellte Zeichenkette (Buchstaben → 10..35), stückweise.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const val = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of val) rest = (rest * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

/** IBAN in 4er-Gruppen formatieren (Anzeige). */
export function formatIban(input: string): string {
  const iban = (input ?? '').replace(/\s/g, '').toUpperCase();
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

// ─── Datum ────────────────────────────────────────────────────────────────────

/** ISO-Datum (YYYY-MM-DD) mit realem Kalendertag. */
export function isValidIsoDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input ?? '')) return false;
  const [y, m, d] = input.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ─── Pflichtfelder Phase 2 ────────────────────────────────────────────────────

export interface PflichtfeldFehler {
  /** Pfad ins ma_daten-JSON, z. B. 'personalien.name' oder 'dokumente.ahv_karte'. */
  feld: string;
  label: string;
}

/**
 * Pflichtfeld-Prüfung für das Absenden in Phase 2.
 * Gibt die Liste fehlender/ungültiger Felder zurück (leer = vollständig).
 */
export function pruefePflichtfelder(maDaten: MaDaten, vertragstyp: Vertragstyp): PflichtfeldFehler[] {
  const fehler: PflichtfeldFehler[] = [];
  const p = maDaten.personalien ?? {};
  const v = maDaten.vertrag ?? {};
  const l = maDaten.lohnprogramm ?? {};
  const docs = maDaten.dokumente ?? {};

  const need = (cond: unknown, feld: string, label: string) => {
    const leer = cond == null || (typeof cond === 'string' && cond.trim() === '');
    if (leer) fehler.push({ feld, label });
  };

  // Personalien
  need(p.anrede, 'personalien.anrede', 'Anrede');
  need(p.name, 'personalien.name', 'Name');
  need(p.vorname, 'personalien.vorname', 'Vorname');
  need(p.strasse, 'personalien.strasse', 'Strasse');
  need(p.plz, 'personalien.plz', 'PLZ');
  need(p.ort, 'personalien.ort', 'Ort');
  need(p.geburtsdatum, 'personalien.geburtsdatum', 'Geburtsdatum');
  if (p.geburtsdatum && !isValidIsoDate(p.geburtsdatum)) {
    fehler.push({ feld: 'personalien.geburtsdatum', label: 'Geburtsdatum (ungültig)' });
  }
  need(p.heimatort_nationalitaet, 'personalien.heimatort_nationalitaet', 'Heimatort / Nationalität');
  need(p.telefon, 'personalien.telefon', 'Telefon');
  need(p.email, 'personalien.email', 'E-Mail');

  // Vertrag: Wochenstunden nur bei ML Pflicht (SL = unregelmässig)
  if (vertragstyp === 'ML' && !(typeof v.wochenstunden === 'number' && v.wochenstunden > 0)) {
    fehler.push({ feld: 'vertrag.wochenstunden', label: 'Wochenstunden' });
  }

  // Lohnprogramm
  need(l.zivilstand, 'lohnprogramm.zivilstand', 'Zivilstand');
  need(l.ahv_nr, 'lohnprogramm.ahv_nr', 'AHV-Nummer');
  if (l.ahv_nr && !isValidAhv(l.ahv_nr)) {
    fehler.push({ feld: 'lohnprogramm.ahv_nr', label: 'AHV-Nummer (ungültig)' });
  }
  need(l.iban, 'lohnprogramm.iban', 'IBAN');
  if (l.iban && !isValidIban(l.iban)) {
    fehler.push({ feld: 'lohnprogramm.iban', label: 'IBAN (ungültig)' });
  }
  need(l.ausweisart, 'lohnprogramm.ausweisart', 'Ausweisart');
  need(l.ausweis_nr, 'lohnprogramm.ausweis_nr', 'Ausweis-Nr.');
  need(l.aufenthaltsbewilligung, 'lohnprogramm.aufenthaltsbewilligung', 'Aufenthaltsbewilligung');

  // Ehepartner-Details nur bei verheiratet / eingetragener Partnerschaft
  const zivil = (l.zivilstand ?? '').toLowerCase();
  if (zivil === 'verheiratet' || zivil.includes('partnerschaft')) {
    need(l.ehepartner?.name, 'lohnprogramm.ehepartner.name', 'Name Ehepartner/in');
  }

  // Kinder: falls erfasst, je Kind Name + Geburtsdatum
  (l.kinder ?? []).forEach((kind, i) => {
    need(kind.name, `lohnprogramm.kinder.${i}.name`, `Kind ${i + 1}: Name`);
    need(kind.geburtsdatum, `lohnprogramm.kinder.${i}.geburtsdatum`, `Kind ${i + 1}: Geburtsdatum`);
    if (kind.geburtsdatum && !isValidIsoDate(kind.geburtsdatum)) {
      fehler.push({ feld: `lohnprogramm.kinder.${i}.geburtsdatum`, label: `Kind ${i + 1}: Geburtsdatum (ungültig)` });
    }
  });

  // Pflicht-Dokumente
  for (const dok of MA_DOKUMENT_TYPEN) {
    if (dok.pflicht) need(docs[dok.typ], `dokumente.${dok.typ}`, `Dokument: ${dok.label}`);
  }

  return fehler;
}
