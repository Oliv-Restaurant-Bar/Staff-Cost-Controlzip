/**
 * kreditoren-abgleich – Kreditoren-Auszug als Kontrollebene über Warenrechnungen
 * ==============================================================================
 * - Lieferanten-Zuordnung (Waren ja/nein + Standard-Konto + Abrechnungsmodell)
 *   pro Mandant gemerkt: KV `waren_kreditoren_zuordnung_v1` (tenant-präfixiert).
 * - Abgleich: PRIMÄR über die BELEGNUMMER (Kreditor-Referenz ↔ Rechnungs-
 *   Referenz) + Lieferant; Betrag nur als Zusatz-Check. Das Buchungsdatum des
 *   Kreditors weicht systematisch vom Liefer-/Rechnungsdatum ab und ist NUR
 *   Fallback, wenn keine Belegnummer vorliegt (Lieferant + Betrag + Datumsnähe).
 *   Konzern-Gruppen: «Prodega»-Rechnungen zählen zum Kreditor «Transgourmet
 *   Schweiz AG» (ein Kreditorenkonto für beide Märkte). Für Dual-Lieferanten
 *   matcht der Kreditor NUR gegen die finalisierte Monatsrechnung — nie gegen
 *   provisorische Lieferscheine; existieren dort nur Lieferscheine, ist der
 *   Status «provisorisch» (kein Übernahme-Vorschlag, kein Überschreiben).
 * - Der Auszug ändert NIE bestehende Rechnungen; nur fehlende Buchungen werden
 *   als opt-in-Übernahme (provisorisch, quelle 'kreditoren_uebernahme')
 *   vorgeschlagen. Dublettenwache: gleiche BELEGNUMMER bereits erfasst ODER
 *   Lieferant + Datum (±Fenster) + Betrag (±Toleranz) → gesperrt.
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

/**
 * Konzern-Gruppen: mehrere Handelsnamen buchen auf EIN Kreditorenkonto.
 * Prodega-Märkte (Bern/Moosseedorf) laufen über «Transgourmet Schweiz AG».
 */
const KONZERN_GRUPPEN: string[][] = [
  ['transgourmet', 'prodega'],
];

function konzernGruppe(norm: string): string[] | null {
  for (const g of KONZERN_GRUPPEN) if (g.some(w => norm.includes(w))) return g;
  return null;
}

/** Kreditor-Name matcht supplierName, wenn einer den anderen (normalisiert) enthält. */
export function supplierMatchesKreditor(
  supplierName: string, kreditorName: string, aliases: Record<string, string>,
): boolean {
  const s = normName(aliases[supplierName] ?? supplierName);
  const k = normName(kreditorName);
  if (!s || !k) return false;
  // Konzern-Gruppe: Prodega-Rechnungen gehören zum Transgourmet-Kreditor.
  const gs = konzernGruppe(s);
  if (gs && gs === konzernGruppe(k)) return true;
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
 * Belegnummer normalisieren: erstes Token (vor Komma/Leerzeichen — Kreditoren-
 * Texte hängen z.T. Zusätze an: «63908169, Transgourmet 04.20»), trailing
 * Satzzeichen weg, lowercase, führende Nullen weg.
 */
export function normRef(ref: string | null | undefined): string | null {
  const t = (ref ?? '').trim().split(/[,\s]+/)[0]
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase().replace(/^0+(?=\d)/, '');
  return t.length > 0 ? t : null;
}

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

    // 1) PRIMÄR: Belegnummer (Kreditor-Referenz ↔ Rechnungs-Referenz).
    //    Das Kreditor-Buchungsdatum weicht systematisch vom Lieferdatum ab —
    //    Datum ist hier KEIN Kriterium. Betrag nur als Zusatz-Check: bei
    //    mehrfach vergebenen Refs (kurze Portal-Nummern) wird der Ref-Topf
    //    als BATCH mit minimaler Betragsabweichung zugeordnet — deterministisch,
    //    unabhängig von der Buchungs-Reihenfolge im Auszug.
    const refInvoices = new Map<string, InvoiceEntry[]>();
    for (const inv of matchbar) {
      const r = normRef(inv.reference);
      if (!r) continue;
      const l = refInvoices.get(r) ?? [];
      l.push(inv); refInvoices.set(r, l);
    }
    const refAssign = new Map<KreditorBuchung, InvoiceEntry>();
    for (const [r, invs] of refInvoices) {
      const books = a.rechnungen.filter(b => normRef(b.referenz) === r);
      const pairs = books
        .flatMap(b => invs.map(inv => ({ b, inv, delta: Math.abs(inv.amountGross - b.betrag) })))
        .sort((x, y) => x.delta - y.delta);
      const usedB = new Set<KreditorBuchung>(); const usedI = new Set<string>();
      for (const p of pairs) {
        if (usedB.has(p.b) || usedI.has(p.inv.id)) continue;
        usedB.add(p.b); usedI.add(p.inv.id);
        refAssign.set(p.b, p.inv);
      }
    }
    // Alle Refs, die im Bestand des Lieferanten IRGENDWO vorkommen (auch bereits
    // zugeordnet) — eine Buchung mit bekannter Ref ohne freien Treffer ist eine
    // DUBLETTE und darf NIE in den Datums-Fallback rutschen.
    const bekannteRefs = new Set<string>();
    for (const inv of lieferantInvoices) {
      const r = normRef(inv.reference);
      if (r) bekannteRefs.add(r);
    }
    // Für einen Ref-Match reservierte Rechnungen: der Datums-Fallback einer
    // ref-losen Buchung darf sie NIE stehlen (auch wenn ihre Buchung erst
    // später in der Schleife drankommt).
    const refReserviert = new Set<string>([...refAssign.values()].map(inv => inv.id));

    for (const b of a.rechnungen) {
      const monat = b.datum.slice(0, 7);
      const bRef = normRef(b.referenz);
      let best: InvoiceEntry | undefined = refAssign.get(b);
      if (!best && bRef && bekannteRefs.has(bRef)) {
        // Ref existiert im Bestand, aber kein freier Treffer mehr →
        // Dublette; nie fallback-matchen, nie als fehlend anbieten.
        matches.push({ buchung: b, status: 'gesperrt_dublette', monat });
        continue;
      }
      // 2) FALLBACK ohne Belegnummern-Treffer: Betrag (±Toleranz) + Datumsnähe —
      //    nur gegen Rechnungen OHNE eigene (andere) Belegnummer, sonst würde
      //    eine falsche Rechnung per Datum gestohlen.
      if (!best) {
        let bestDist = Infinity;
        for (const inv of matchbar) {
          if (verwendet.has(inv.id) || refReserviert.has(inv.id)) continue;
          const invRef = normRef(inv.reference);
          if (bRef && invRef) continue; // beide haben Refs, die nicht matchen → nie per Datum
          if (Math.abs(inv.amountGross - b.betrag) > toleranz) continue;
          const dist = istDual
            ? (inv.date.slice(0, 7) === monat ? 0 : Infinity)  // Dual: gleicher Monat
            : daysDiff(inv.date, b.datum);
          if (dist <= (istDual ? 0 : DATUM_FENSTER_TAGE) && dist < bestDist) { best = inv; bestDist = dist; }
        }
      }
      if (best) {
        verwendet.add(best.id);
        matches.push({ buchung: b, status: 'erfasst', invoice: best, monat });
        continue;
      }
      // 3) Dual ohne finale Monatsrechnung, aber mit provisorischen Lieferscheinen im Monat
      if (istDual && lieferantInvoices.some(inv => inv.date.slice(0, 7) === monat && !(inv.final === true))) {
        matches.push({ buchung: b, status: 'provisorisch', monat });
        continue;
      }
      // 4) Dublettenwache: gleiche BELEGNUMMER bereits erfasst (egal welches
      //    Datum) ODER Lieferant + Datum (±Fenster) + Betrag (±Toleranz).
      const dublette =
        (bRef !== null && lieferantInvoices.some(inv => normRef(inv.reference) === bRef))
        || lieferantInvoices.some(inv =>
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

/**
 * Provisorische Kreditoren-Übernahme finden, die ein späterer DETAIL-Import
 * (CSV/PDF/Monatsrechnung) FINALISIEREN darf — gleiche Logik wie das
 * Cockpit-Matching: primär BELEGNUMMER (normRef) + Lieferant (lose, inkl.
 * Konzern-Gruppen — Kreditor-Name ≠ Handelsname). Fallback NUR gegen
 * Übernahmen OHNE Belegnummer: Bruttobetrag ±0.10 im übergebenen Bestand
 * (Periode steuert der Aufrufer über die Monats-Bestände). Bei Mehrdeutigkeit
 * im Fallback wird NIE automatisch ersetzt (mehrdeutig=true → manuell prüfen).
 */
export function findeKreditorenUebernahme(
  bestand: InvoiceEntry[],
  rechnungsNr: string,
  lieferant: string,
  brutto: number,
): { entry?: InvoiceEntry; mehrdeutig: boolean } {
  const kandidaten = bestand.filter(e =>
    e.quelle === 'kreditoren_uebernahme' && e.final !== true
    && supplierMatchesKreditor(lieferant, e.supplierName, {}));
  if (kandidaten.length === 0) return { mehrdeutig: false };
  const ref = normRef(rechnungsNr);
  if (ref) {
    const perRef = kandidaten.filter(e => normRef(e.reference) === ref);
    if (perRef.length > 0) {
      // gleiche Belegnummer mehrfach übernommen → passendster Betrag gewinnt
      const best = [...perRef].sort((a, b) =>
        Math.abs(a.amountGross - brutto) - Math.abs(b.amountGross - brutto))[0];
      return { entry: best, mehrdeutig: false };
    }
  }
  // Fallback ohne Belegnummer — nur gegen Übernahmen, die selbst KEINE Ref tragen
  // (eine Übernahme MIT anderer Ref darf nie per Betrag gekapert werden).
  const ohneRef = kandidaten.filter(e => normRef(e.reference) === null
    && Math.abs(e.amountGross - brutto) <= 0.10);
  if (ohneRef.length === 1) return { entry: ohneRef[0], mehrdeutig: false };
  if (ohneRef.length > 1) return { mehrdeutig: true };
  return { mehrdeutig: false };
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
