/**
 * tagesdaten-zahlen.ts — STRIKTES Zahlen-Parsing für den Tagesdaten-Import
 * ========================================================================
 * Zentrale, strenge Betrags-Erkennung für alle Tagesdaten-Parser (Gäste,
 * Durchschnitt, Marketing, Umsatz). Grundsatz: NIE NaN, NIE stilles 0.
 *
 *   - Erkannte Formate → { ok: true, value: number }
 *   - Leere Zelle / «-» / «–» → { ok: true, value: null }  (leer statt 0)
 *   - Alles andere → { ok: false, roh } — der Aufrufer sammelt die Zelle als
 *     «nicht lesbar»; die Import-UI blockiert den Import und nennt Zeile/
 *     Spalte/Rohwert.
 *
 * Erkannte Formate (jeweils auch negativ, mit −/‐-Minusvarianten):
 *   1'234.56 · 1’234.56 · CHF 1'234.50 · Fr. 100 · 100 CHF · EUR/€
 *   1.234,56 (deutsch) · 1234,56 (Komma-Dezimal) · 1,234.56 (engl. Tausender)
 *   "1 234" / NBSP-Tausender · "8'584 P." (Personen-Suffix)
 */

/** Eine nicht lesbare Zelle für die Fehlermeldung der Import-UI. */
export interface UnlesbareZelle {
  /** Zeilen-Bezeichnung (Spalte 1 der Datei, z.B. «Gesamt»). */
  zeile: string;
  /** Spaltenkopf (z.B. «03.07.» oder «Zeitraum»). */
  spalte: string;
  /** Der Original-Zellinhalt, der nicht gelesen werden konnte. */
  roh: string;
}

/**
 * Ergebnis des strikten Zell-Parsings. Bewusst KEINE discriminated union:
 * tsconfig läuft mit strict:false, dort greift die ok-Narrowing nicht.
 *   ok=true  → value = Zahl oder null (leer/«-» ⇒ null, leer statt 0)
 *   ok=false → roh = Original-Zellinhalt (unlesbar; value ist null)
 */
export interface ZellWert {
  ok: boolean;
  value: number | null;
  /** Original-Rohwert bei ok=false, sonst null. */
  roh: string | null;
}

/** Reines Zahlmuster NACH der Bereinigung — alles andere ist unlesbar. */
const ZAHL_RE = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Parst einen bereits als Text vorliegenden Zellwert STRIKT.
 * Zahlen (typeof number) vorher direkt behandeln (parseBetragZelle).
 */
export function parseBetragText(raw: string): ZellWert {
  const original = raw;
  // NBSP/schmale Leerzeichen normalisieren, Unicode-Minus vereinheitlichen
  let s = raw
    .replace(/[\u00A0\u202F\u2009]/gu, ' ')
    .replace(/[\u2212\u2012\u2013]/gu, '-')
    .trim();

  // Leer, «-»/«–» sowie Python-/Export-Platzhalter «None»/«null» = kein Wert.
  if (!s || s === '-' || s === '–' || s === '—' || /^(none|null)$/iu.test(s)) {
    return { ok: true, value: null, roh: null };
  }

  // Währungs-/Einheiten-Deko entfernen (Präfix ODER Suffix)
  s = s
    .replace(/^(?:chf|fr\.?|eur|€)\s*/iu, '')
    .replace(/\s*(?:chf|fr\.?|eur|€)$/iu, '')
    .replace(/\s*P\.?\s*$/u, '') // Personen-Suffix «8'584 P.»
    .trim();

  if (!s || s === '-') return { ok: true, value: null, roh: null };

  // Vorzeichen abtrennen (auch «CHF -50.00» → nach Deko-Strip vorne)
  let sign = '';
  if (s.startsWith('-') || s.startsWith('+')) { sign = s[0] === '-' ? '-' : ''; s = s.slice(1).trim(); }

  // Tausender-Apostroph (beide Varianten) und Leerzeichen-Tausender entfernen
  s = s.replace(/['’‘]/gu, '').replace(/\s+/gu, '');

  // Dezimal-/Tausender-Trennzeichen auflösen:
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    // Deutsch: 1.234,56 → Punkte = Tausender, Komma = Dezimal
    s = s.replace(/\./gu, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    // Englisch: 1,234.56 → Kommas = Tausender
    s = s.replace(/,/gu, '');
  } else {
    // Einfacher Fall: höchstens EIN Komma als Dezimaltrenner
    s = s.replace(',', '.');
  }

  if (!ZAHL_RE.test(s)) return { ok: false, value: null, roh: original.trim() };
  const n = parseFloat(sign + s);
  if (!Number.isFinite(n)) return { ok: false, value: null, roh: original.trim() };
  return { ok: true, value: n, roh: null };
}

/** Zellwert (number ODER Text) strikt parsen — nie NaN, nie stilles 0. */
export function parseBetragZelle(raw: string | number | null | undefined): ZellWert {
  if (raw === null || raw === undefined) return { ok: true, value: null, roh: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { ok: true, value: raw, roh: null }
      : { ok: false, value: null, roh: String(raw) };
  }
  return parseBetragText(raw);
}

/**
 * Kompakte Fehlermeldung für die Import-UI: nennt betroffene Zeile/Spalte/
 * Rohwert (max. `limit` Beispiele) — der Import ist zu blockieren.
 */
export function unlesbareWerteMeldung(zellen: UnlesbareZelle[], limit = 8): string {
  const beispiele = zellen.slice(0, limit)
    .map(z => `${z.zeile} · Spalte ${z.spalte}: «${z.roh}»`)
    .join('; ');
  const rest = zellen.length > limit ? ` … und ${zellen.length - limit} weitere` : '';
  return `${zellen.length} Zellwert${zellen.length === 1 ? '' : 'e'} nicht lesbar — Import blockiert, bis das Format geklärt ist: ${beispiele}${rest}`;
}
