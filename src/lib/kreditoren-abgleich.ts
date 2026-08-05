/**
 * kreditoren-abgleich – Kreditoren-Auszug als Kontrollebene über Warenrechnungen
 * ==============================================================================
 * - Lieferanten-Zuordnung (Waren ja/nein + Standard-Konto + Abrechnungsmodell)
 *   pro Mandant gemerkt: KV `waren_kreditoren_zuordnung_v1` (tenant-präfixiert).
 * - Abgleich: erfasste Warenrechnungen werden Kreditor-Haben-Buchungen über
 *   Lieferant + Zeitraum + Betrag (Toleranz) zugeordnet. Für Dual-Lieferanten
 *   matcht der Kreditor NUR gegen die finalisierte Monatsrechnung — nie gegen
 *   provisorische Lieferscheine; existieren dort nur Lieferscheine, ist der
 *   Status «provisorisch» (kein Übernahme-Vorschlag, kein Überschreiben).
 * - Der Auszug ändert NIE bestehende Rechnungen; nur fehlende Buchungen werden
 *   als opt-in-Übernahme (provisorisch, quelle 'kreditoren_uebernahme')
 *   vorgeschlagen. Dublettenwache: Lieferant + Datum (±Fenster) + Betrag
 *   (±Toleranz) → gesperrt.
 *
 * Debug-Logs: [KREDITOREN]
 */

import { kvGet, kvSet } from './supabase-kv';
import { tenantKey } from './tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';
import {
  loadMonthInvoices, loadSupplierAliases, loadFibuMatchToleranz,
  type InvoiceEntry,
} from './waren-db';
import type { Kreditor, KreditorBuchung, KreditorAnalyse, AbrechnungsModell } from './kreditoren-parser';

// ─── Zuordnung (pro Mandant gemerkt) ─────────────────────────────────────────

export interface KreditorZuordnung {
  /** true = Waren-Lieferant, false = dauerhaft «kein Waren» (AHV, Strom, IT …) */
  waren: boolean;
  /** Standard-Warenkonto (z.B. '4060') */
  konto?: string;
  modell?: AbrechnungsModell;
  bestaetigt: string; // ISO
}

export type KreditorZuordnungMap = Record<string, KreditorZuordnung>;

const ZUORDNUNG_KEY = 'waren_kreditoren_zuordnung_v1';

/** Schlüssel: normalisierter Kreditor-Name (ohne Ort, lowercase). */
export function zuordnungKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function loadKreditorZuordnung(tenantId: TenantId): Promise<KreditorZuordnungMap> {
  try {
    const raw = await kvGet(tenantKey(tenantId, ZUORDNUNG_KEY));
    return (raw && typeof raw === 'object') ? raw as KreditorZuordnungMap : {};
  } catch (e) {
    console.warn('[KREDITOREN] Zuordnung laden fehlgeschlagen:', e);
    return {};
  }
}

export async function saveKreditorZuordnung(tenantId: TenantId, map: KreditorZuordnungMap): Promise<void> {
  await kvSet(tenantKey(tenantId, ZUORDNUNG_KEY), map);
}

// ─── Lieferanten-Namens-Matching (Kreditor-Name ↔ erfasster supplierName) ───

function normName(s: string): string {
  return s.toLowerCase()
    .replace(/\b(ag|gmbh|sa|sagl|co|cie|kg)\b\.?/g, '')
    .replace(/[^a-zäöüéèàç0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kreditor-Name matcht supplierName, wenn einer den anderen (normalisiert) enthält. */
export function supplierMatchesKreditor(
  supplierName: string, kreditorName: string, aliases: Record<string, string>,
): boolean {
  const s = normName(aliases[supplierName] ?? supplierName);
  const k = normName(kreditorName);
  if (!s || !k) return false;
  if (s === k || s.includes(k) || k.includes(s)) return true;
  // Erstes signifikantes Wort (≥4 Zeichen) beidseitig gleich → Match (Spahni, Terravigna …)
  const sw = s.split(' ').find(w => w.length >= 4);
  const kw = k.split(' ').find(w => w.length >= 4);
  return !!sw && !!kw && sw === kw;
}

// ─── Abgleich ────────────────────────────────────────────────────────────────

export type BuchungStatus = 'erfasst' | 'provisorisch' | 'fehlt' | 'gesperrt_dublette';

export interface BuchungMatch {
  buchung: KreditorBuchung;
  status: BuchungStatus;
  /** Gematchte erfasste Rechnung (bei 'erfasst') */
  invoice?: InvoiceEntry;
  monat: string; // YYYY-MM
}

export interface CockpitZeile {
  kreditorName: string;
  zuordnung: KreditorZuordnung;
  matches: BuchungMatch[];
  anzahlKreditor: number;
  anzahlErfasst: number;
  anzahlProvisorisch: number;
  anzahlFehlt: number;
  summeKreditor: number;   // brutto
  summeErfasst: number;    // brutto (gematchte Rechnungen)
  /** null wenn keine Buchungen (nie durch 0 teilen / leer statt 0) */
  differenz: number | null;
  ampel: 'gruen' | 'gelb' | 'rot';
}

export interface AbgleichErgebnis {
  zeilen: CockpitZeile[];
  monate: string[];
  toleranz: number;
}

function monthsBetween(vonISO: string, bisISO: string): string[] {
  const out: string[] = [];
  let [y, m] = vonISO.slice(0, 7).split('-').map(Number);
  const end = bisISO.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key === end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000);
}

const DATUM_FENSTER_TAGE = 10;

/**
 * Gleich einen geparsten Kreditoren-Auszug gegen die erfassten Warenrechnungen
 * des Mandanten ab. Liest nur — schreibt nichts.
 */
export async function abgleichKreditoren(
  tenantId: TenantId,
  analysen: KreditorAnalyse[],
  zuordnung: KreditorZuordnungMap,
  vonDatum: string,
  bisDatum: string,
): Promise<AbgleichErgebnis> {
  const monate = monthsBetween(vonDatum, bisDatum);
  const toleranz = await loadFibuMatchToleranz(tenantId);
  const aliases = await loadSupplierAliases(tenantId);

  const invoicesByMonth: Record<string, InvoiceEntry[]> = {};
  for (const m of monate) invoicesByMonth[m] = await loadMonthInvoices(tenantId, m);
  const alleInvoices = monate.flatMap(m => invoicesByMonth[m]);

  const zeilen: CockpitZeile[] = [];

  for (const a of analysen) {
    const z = zuordnung[zuordnungKey(a.kreditor.name)];
    if (!z || !z.waren) continue;

    // Erfasste Rechnungen dieses Lieferanten im Zeitraum
    const lieferantInvoices = alleInvoices.filter(inv =>
      supplierMatchesKreditor(inv.supplierName, a.kreditor.name, aliases));
    const istDual = z.modell === 'monatsrechnung' || z.modell === 'halbmonatlich';
    // Dual: Kreditor matcht nur gegen finalisierte Monatsrechnungen
    // Dual: NUR wirklich finalisierte Monatsrechnungen (final === true) —
    // eine alte provisorische 'monatsrechnung' ohne final darf keinen
    // Kreditor-Eintrag als «erfasst» markieren.
    const matchbar = istDual
      ? lieferantInvoices.filter(inv => inv.final === true)
      : lieferantInvoices;

    const verwendet = new Set<string>();
    const matches: BuchungMatch[] = [];

    for (const b of a.rechnungen) {
      const monat = b.datum.slice(0, 7);
      // 1) Betrags-/Zeitraum-Match (greedy, jede Rechnung nur einmal)
      let best: InvoiceEntry | undefined;
      let bestDist = Infinity;
      for (const inv of matchbar) {
        if (verwendet.has(inv.id)) continue;
        if (Math.abs(inv.amountGross - b.betrag) > toleranz) continue;
        const dist = istDual
          ? (inv.date.slice(0, 7) === monat ? 0 : Infinity)  // Dual: gleicher Monat
          : daysDiff(inv.date, b.datum);
        if (dist <= (istDual ? 0 : DATUM_FENSTER_TAGE) && dist < bestDist) { best = inv; bestDist = dist; }
      }
      if (best) {
        verwendet.add(best.id);
        matches.push({ buchung: b, status: 'erfasst', invoice: best, monat });
        continue;
      }
      // 2) Dual ohne finale Monatsrechnung, aber mit provisorischen Lieferscheinen im Monat
      if (istDual && lieferantInvoices.some(inv => inv.date.slice(0, 7) === monat && !(inv.final === true))) {
        matches.push({ buchung: b, status: 'provisorisch', monat });
        continue;
      }
      // 3) Dublettenwache: gleicher Lieferant + Datum (±Fenster) + Betrag (±Toleranz)
      const dublette = lieferantInvoices.some(inv =>
        Math.abs(inv.amountGross - b.betrag) <= toleranz && daysDiff(inv.date, b.datum) <= DATUM_FENSTER_TAGE);
      matches.push({ buchung: b, status: dublette ? 'gesperrt_dublette' : 'fehlt', monat });
    }

    const anzahlErfasst = matches.filter(m => m.status === 'erfasst').length;
    const anzahlProvisorisch = matches.filter(m => m.status === 'provisorisch').length;
    const anzahlFehlt = matches.filter(m => m.status === 'fehlt').length;
    const summeKreditor = Math.round(a.rechnungen.reduce((s, b) => s + b.betrag, 0) * 100) / 100;
    const summeErfasst = Math.round(matches.reduce((s, m) => s + (m.invoice?.amountGross ?? 0), 0) * 100) / 100;
    const differenz = a.rechnungen.length === 0 ? null : Math.round((summeKreditor - summeErfasst) * 100) / 100;

    zeilen.push({
      kreditorName: a.kreditor.name,
      zuordnung: z,
      matches,
      anzahlKreditor: a.rechnungen.length,
      anzahlErfasst, anzahlProvisorisch, anzahlFehlt,
      summeKreditor, summeErfasst, differenz,
      ampel: anzahlFehlt === 0 && anzahlErfasst > 0 ? 'gruen'
        : anzahlFehlt === 0 ? 'gelb'
        : anzahlErfasst + anzahlProvisorisch > 0 ? 'gelb' : 'rot',
    });
  }

  zeilen.sort((x, y) => (y.anzahlFehlt - x.anzahlFehlt) || x.kreditorName.localeCompare(y.kreditorName, 'de-CH'));
  console.log(`[KREDITOREN] Abgleich: ${zeilen.length} Waren-Lieferanten, fehlend total ${zeilen.reduce((s, z) => s + z.anzahlFehlt, 0)}`);
  return { zeilen, monate, toleranz };
}

// ─── Übernahme-Vorschlag → InvoiceEntry (provisorisch) ───────────────────────

export interface UebernahmeVorschlag {
  kreditorName: string;
  buchung: KreditorBuchung;
  konto: string;
  vatRate: number;
}

export function buildUebernahmeEntry(v: UebernahmeVorschlag, now: string): InvoiceEntry {
  const gross = v.buchung.betrag;
  const net = Math.round((gross / (1 + v.vatRate / 100)) * 100) / 100;
  return {
    id: `kred_${v.buchung.datum}_${(v.buchung.referenz ?? v.buchung.blg ?? 'x')}_${Math.random().toString(36).slice(2, 8)}`,
    date: v.buchung.datum,
    supplierName: v.kreditorName,
    amountGross: gross,
    amountNet: net,
    vatIncluded: true,
    vatRate: v.vatRate,
    reference: v.buchung.referenz,
    warenkonto: v.konto,
    note: 'Kreditoren-Übernahme (provisorisch)',
    quelle: 'kreditoren_uebernahme',
    final: false,
    createdAt: now,
    updatedAt: now,
  };
}
