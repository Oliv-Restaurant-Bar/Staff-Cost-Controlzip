/**
 * Flex-Ist-Overrides (Tabelle «Flex Kosten pro Mitarbeiter», PersonalFix)
 * =======================================================================
 * Manuelle Übersteuerung des berechneten «Flex Ist»-Betrags (Ist-Std × AG/h)
 * pro Mitarbeiter sowie für die Total-Zeile.
 *
 * - Persistiert pro Mandant + Jahr + Monat als EIN KV-Blob (kvSet = Upsert,
 *   dublettensicher); der Key läuft über tenantKey(...) → mandantengetrennt.
 * - `addAg`: eingegebener Betrag ist Bruttolohn OHNE Arbeitgeberkosten und
 *   wird mit dem zentralen AG-Sozialkostenfaktor hochgerechnet.
 *   Ohne Häkchen gilt der Betrag 1:1 als vollständige AG-Kosten.
 * - Nichts wird still verändert: der Override ersetzt nur die Anzeige/den
 *   Export dieser Tabelle und ist jederzeit rücksetzbar (Eintrag entfernen).
 */

import { kvGet, kvSet } from '@/lib/supabase-kv';

export interface FlexIstOverride {
  /** Eingegebener CHF-Betrag. */
  amount: number;
  /** true = Betrag ist Brutto ohne AG-Kosten → mit AG-Faktor hochrechnen. */
  addAg: boolean;
}

export interface FlexIstOverrides {
  /** Overrides pro Mitarbeiter-ID. */
  employees: Record<string, FlexIstOverride>;
  /** Override der Total-Zeile (Gesamtbetrag aus der Lohnabrechnung). */
  total: FlexIstOverride | null;
}

export const EMPTY_FLEX_OVERRIDES: FlexIstOverrides = { employees: {}, total: null };

export function flexOverridesKey(year: number, month: number): string {
  return `pfix-flex-ist-overrides-${year}-${String(month).padStart(2, '0')}`;
}

/** Wirksamer Betrag eines Overrides (inkl. optionalem AG-Aufschlag). */
export function effectiveFlexIst(o: FlexIstOverride, agFactor: number): number {
  return o.addAg ? o.amount * agFactor : o.amount;
}

function sanitize(raw: unknown): FlexIstOverrides {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_FLEX_OVERRIDES };
  const r = raw as Partial<FlexIstOverrides>;
  const employees: Record<string, FlexIstOverride> = {};
  if (r.employees && typeof r.employees === 'object') {
    for (const [id, o] of Object.entries(r.employees)) {
      if (o && typeof o.amount === 'number' && isFinite(o.amount)) {
        employees[id] = { amount: o.amount, addAg: !!o.addAg };
      }
    }
  }
  const total = r.total && typeof r.total.amount === 'number' && isFinite(r.total.amount)
    ? { amount: r.total.amount, addAg: !!r.total.addAg }
    : null;
  return { employees, total };
}

export async function loadFlexIstOverrides(
  tenantKey: (key: string) => string,
  year: number,
  month: number,
): Promise<FlexIstOverrides> {
  try {
    const raw = await kvGet(tenantKey(flexOverridesKey(year, month)));
    return sanitize(raw);
  } catch {
    // Lesefehler ≠ leer — aber hier nur Anzeige-Overrides: leer zurückgeben,
    // gespeichert wird immer der komplette aktuelle UI-Zustand (kein Merge).
    return { ...EMPTY_FLEX_OVERRIDES };
  }
}

export async function saveFlexIstOverrides(
  tenantKey: (key: string) => string,
  year: number,
  month: number,
  data: FlexIstOverrides,
): Promise<void> {
  await kvSet(tenantKey(flexOverridesKey(year, month)), sanitize(data));
}
