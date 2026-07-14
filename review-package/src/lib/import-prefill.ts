/**
 * import-prefill.ts — Query-Param-Prefill aus der Import-Checkliste (rein)
 * ========================================================================
 * Die Checkliste (/import-cockpit) navigiert mit Query-Params in die
 * bestehenden Import-Flows (z. B. ?from=2026-07-01&to=2026-07-08&scope=range).
 *
 * WICHTIG: Die Params sind ADVISORY — Zielseiten zeigen den erwarteten
 * Zeitraum als Hinweis an (und wählen ihn ggf. vor), schränken Uploads aber
 * NIEMALS hart ein. Fehlen oder invalide Params → null (kein Hinweis).
 *
 * Reine Logik ohne DOM-/Supabase-Kopplung (nur URLSearchParams-Interface).
 */

export interface ImportPrefill {
  /** yyyy-MM-dd (validiert) */
  from: string | null;
  to: string | null;
  scope: 'day' | 'range' | 'month' | 'year' | null;
  /** Ziel-Sektion (z. B. 'tagesumsatz' | 'mirus' | 'maison' | 'erfolgsrechnung' | 'istkosten') */
  target: string | null;
  year: number | null;
  /** 1–12 */
  month: number | null;
}

const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SCOPES = ['day', 'range', 'month', 'year'] as const;

function validDay(v: string | null): string | null {
  return v && RE_DAY.test(v) ? v : null;
}

function validInt(v: string | null, min: number, max: number): number | null {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** Prefill-Params lesen und validieren. Gibt null zurück, wenn nichts Verwertbares da ist. */
export function parseImportPrefill(params: Pick<URLSearchParams, 'get'>): ImportPrefill | null {
  const from = validDay(params.get('from'));
  const to = validDay(params.get('to'));
  const scopeRaw = params.get('scope');
  const scope = (SCOPES as readonly string[]).includes(scopeRaw ?? '')
    ? (scopeRaw as ImportPrefill['scope'])
    : null;
  const target = params.get('target');
  const year = validInt(params.get('year'), 2000, 2100);
  const month = validInt(params.get('month'), 1, 12);

  const prefill: ImportPrefill = {
    from,
    to: to && from && to < from ? null : to,
    scope,
    target: target && target.length <= 40 ? target : null,
    year,
    month,
  };
  const hasAny = prefill.from || prefill.to || prefill.year || prefill.month;
  return hasAny ? prefill : null;
}

/** yyyy-MM-dd → dd.MM.yyyy */
function fmt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Menschlicher Zeitraum-Text für den Hinweis („01.07.–08.07.2026", „Juli 2026", „2026"). */
export function prefillRangeLabel(prefill: ImportPrefill): string | null {
  if (prefill.from && prefill.to) {
    if (prefill.from === prefill.to) return fmt(prefill.from);
    const [, m1, d1] = prefill.from.split('-');
    return `${d1}.${m1}.–${fmt(prefill.to)}`;
  }
  if (prefill.from) return `ab ${fmt(prefill.from)}`;
  if (prefill.year && prefill.month) return `${MONTHS_DE[prefill.month - 1]} ${prefill.year}`;
  if (prefill.year) return String(prefill.year);
  return null;
}
