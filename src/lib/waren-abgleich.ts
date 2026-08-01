/**
 * Warenrechnungen ↔ Buchhaltung — Abgleich pro Lieferant (Teil B).
 *
 * Pure Logik (node-testbar). Datenquellen:
 *  - erfasst: InvoiceEntry[] des Monats (Warenrechnungen-Erfassung)
 *  - gebucht: SageJournalEntry[] («Ist Kosten Buchhaltung»-Import mit
 *    Buchungszeilen inkl. Buchungstext) — gefiltert auf die Warenkonten.
 *
 * DEGRADATION: Liegen für den Monat KEINE Buchungszeilen vor (z.B. nur der
 * Jahres-Kontoblatt-Import, der Buchungstexte verwirft, oder Mandant ohne
 * Journal), wird sauber degradiert: nur «erfasst total» vs. «Buchhaltung/ER
 * total» (aus computePLForMonth total_cogs) mit Differenz; pro Lieferant
 * steht «keine Buchhaltungsdaten» — es wird NIE ein Fehler geworfen.
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';
import { findSupplierInText, type SupplierAliasMap } from '@/lib/waren-pdf-erkennung';

export type AbgleichStatus =
  | 'ok'            // beide Quellen, Differenz unter Schwelle
  | 'abweichung'    // beide Quellen, Differenz über Schwelle → rot
  | 'nur-erfasst'   // Rechnung erfasst, keine Buchung gefunden → auffällig
  | 'nur-gebucht'   // Buchung vorhanden, keine Erfassung → auffällig
  | 'keine-fibu';   // degradiert: keine Buchhaltungsdaten auf Lieferanten-Ebene

export interface AbgleichZeile {
  lieferant: string;
  erfasst: number | null;   // CHF netto aus Warenrechnungen
  gebucht: number | null;   // CHF aus Buchungszeilen (Soll − Haben)
  diff: number | null;      // gebucht − erfasst (nur wenn beide vorhanden)
  status: AbgleichStatus;
  /** Anzahl erfasster Rechnungen bzw. zugeordneter Buchungen (Drilldown-Basis). */
  anzahlRechnungen: number;
  anzahlBuchungen: number;
  /** Zugeordnete Buchungszeilen (Drilldown, leer im degradierten Modus). */
  buchungen: SageJournalEntry[];
}

export interface WarenAbgleich {
  /** 'lieferanten' = Buchungszeilen vorhanden; 'nur-total' = degradiert. */
  mode: 'lieferanten' | 'nur-total';
  zeilen: AbgleichZeile[];
  erfasstTotal: number;
  /** Buchhaltungs-Total: Journal-Summe bzw. im degradierten Modus ER-total_cogs. */
  gebuchtTotal: number | null;
  diffTotal: number | null;
  /** Buchungen auf Warenkonten ohne Lieferanten-Zuordnung (nur mode=lieferanten). */
  nichtZugeordnet: SageJournalEntry[];
  nichtZugeordnetSumme: number;
}

/** Betrag einer Buchungszeile: Aufwandskonto → Soll − Haben. */
function buchungsBetrag(e: SageJournalEntry): number {
  if (e.soll || e.haben) return (e.soll ?? 0) - (e.haben ?? 0);
  return e.amount ?? 0;
}

/**
 * MANDANTEN-SCHUTZ: Die Journal-KV-Schlüssel `sage_journal_v1_*` sind
 * historisch NICHT mandanten-präfixiert — alle bisherigen Importe stammen aus
 * der Oliv-Buchhaltung. Für jeden anderen Mandanten darf dieses Journal NICHT
 * verwendet werden (sonst würden fremde Buchungen als eigene angezeigt) →
 * dort immer degradierter Modus (nur Total-Vergleich).
 */
export function journalVerfuegbarFuerTenant(tenantId: string): boolean {
  return tenantId === 'oliv';
}

export interface AbgleichInput {
  invoices: InvoiceEntry[];
  /** Buchungszeilen des Monats; leer/null → degradierter Modus. */
  journal: SageJournalEntry[] | null;
  /** Warenkonto-Nummern (z.B. ['4000','4020',…]) zum Filtern des Journals. */
  warenkontoNummern: string[];
  supplierNames: string[];
  aliases: SupplierAliasMap;
  /** ER-/Kontoblatt-Total (total_cogs) für den degradierten Modus. */
  buchhaltungTotal: number | null;
  /** Rote Markierung ab dieser absoluten Differenz (CHF). Default 50. */
  schwelleChf?: number;
}

export function buildWarenAbgleich(input: AbgleichInput): WarenAbgleich {
  const schwelle = input.schwelleChf ?? 50;

  // ── erfasst je Lieferant ──
  const erfasstMap = new Map<string, { sum: number; count: number }>();
  for (const inv of input.invoices) {
    const cur = erfasstMap.get(inv.supplierName) ?? { sum: 0, count: 0 };
    cur.sum += inv.amountNet;
    cur.count += 1;
    erfasstMap.set(inv.supplierName, cur);
  }
  const erfasstTotal = [...erfasstMap.values()].reduce((a, v) => a + v.sum, 0);

  // ── Journal auf Warenkonten filtern ──
  const kontoSet = new Set(input.warenkontoNummern);
  const warenBuchungen = (input.journal ?? []).filter(e =>
    kontoSet.has(String(e.accountNumber).replace(/^0+/, '')) || kontoSet.has(String(e.accountNumber)));

  // ── DEGRADATION: keine Buchungszeilen → nur Total-Vergleich ──
  if (warenBuchungen.length === 0) {
    const gebuchtTotal = input.buchhaltungTotal;
    const zeilen: AbgleichZeile[] = [...erfasstMap.entries()]
      .map(([lieferant, v]) => ({
        lieferant, erfasst: v.sum, gebucht: null, diff: null,
        status: 'keine-fibu' as const,
        anzahlRechnungen: v.count, anzahlBuchungen: 0, buchungen: [],
      }))
      .sort((a, b) => (b.erfasst ?? 0) - (a.erfasst ?? 0));
    return {
      mode: 'nur-total', zeilen, erfasstTotal,
      gebuchtTotal,
      diffTotal: gebuchtTotal !== null ? gebuchtTotal - erfasstTotal : null,
      nichtZugeordnet: [], nichtZugeordnetSumme: 0,
    };
  }

  // ── Buchungen je Lieferant zuordnen (Buchungstext ↔ Name/Alias) ──
  const gebuchtMap = new Map<string, { sum: number; entries: SageJournalEntry[] }>();
  const nichtZugeordnet: SageJournalEntry[] = [];
  for (const e of warenBuchungen) {
    const hit = findSupplierInText(e.text ?? '', input.supplierNames, input.aliases);
    if (hit) {
      const cur = gebuchtMap.get(hit) ?? { sum: 0, entries: [] };
      cur.sum += buchungsBetrag(e);
      cur.entries.push(e);
      gebuchtMap.set(hit, cur);
    } else {
      nichtZugeordnet.push(e);
    }
  }
  const nichtZugeordnetSumme = nichtZugeordnet.reduce((a, e) => a + buchungsBetrag(e), 0);
  const gebuchtTotal = warenBuchungen.reduce((a, e) => a + buchungsBetrag(e), 0);

  // ── Zeilen (Union beider Quellen) ──
  const alleNamen = new Set<string>([...erfasstMap.keys(), ...gebuchtMap.keys()]);
  const zeilen: AbgleichZeile[] = [...alleNamen].map(name => {
    const erf = erfasstMap.get(name) ?? null;
    const geb = gebuchtMap.get(name) ?? null;
    let status: AbgleichStatus;
    let diff: number | null = null;
    if (erf && geb) {
      diff = geb.sum - erf.sum;
      status = Math.abs(diff) > schwelle ? 'abweichung' : 'ok';
    } else if (erf) {
      status = 'nur-erfasst';
    } else {
      status = 'nur-gebucht';
    }
    return {
      lieferant: name,
      erfasst: erf?.sum ?? null,
      gebucht: geb?.sum ?? null,
      diff,
      status,
      anzahlRechnungen: erf?.count ?? 0,
      anzahlBuchungen: geb?.entries.length ?? 0,
      buchungen: geb?.entries ?? [],
    };
  }).sort((a, b) => Math.max(b.erfasst ?? 0, b.gebucht ?? 0) - Math.max(a.erfasst ?? 0, a.gebucht ?? 0));

  return {
    mode: 'lieferanten', zeilen, erfasstTotal, gebuchtTotal,
    diffTotal: gebuchtTotal - erfasstTotal,
    nichtZugeordnet, nichtZugeordnetSumme,
  };
}

/**
 * Dublettencheck vor dem Speichern (Punkt 11): existiert im Monat bereits
 * eine Rechnung mit gleichem Lieferant + Datum + Betrag (± 5 Rp.) — bzw.
 * gleicher Referenz — wird gewarnt (nie blockiert, der Nutzer entscheidet).
 */
export function findeDublette(
  vorhandene: InvoiceEntry[],
  neu: { supplierName: string; date: string; amountGross: number; reference?: string },
  ignoreId?: string,
): InvoiceEntry | null {
  for (const e of vorhandene) {
    if (ignoreId && e.id === ignoreId) continue;
    if (e.supplierName !== neu.supplierName) continue;
    const refMatch = !!neu.reference && !!e.reference
      && e.reference.trim().toLowerCase() === neu.reference.trim().toLowerCase();
    const feldMatch = e.date === neu.date && Math.abs(e.amountGross - neu.amountGross) < 0.05;
    if (refMatch || feldMatch) return e;
  }
  return null;
}
