/**
 * Monatsrechnungs-Abgleich für Dual-Lieferanten (Feldschlösschen-Modell,
 * generalisiert): Lieferscheine sind FÜHREND, die Monatsrechnung ist nur
 * Kontrolle + Lückenfüller — sie überschreibt NIE vorhandene Buchungen und
 * bucht NIE ihren Gesamtbetrag zusätzlich.
 *
 * Match je Lieferung der Monatsrechnung gegen die erfassten Buchungen:
 * 1. exakt über die LS-Nr (reference, case-insensitiv, Monate ±1),
 * 2. sonst gleiches Datum + Betrag (brutto ±0.10).
 */
import { loadMonthInvoices, type InvoiceEntry } from '@/lib/waren-db';
import type { ParsedCsvRechnung } from '@/lib/waren-positionen';
import type { TenantId } from '@/contexts/TenantContext';

export interface AbgleichEintrag {
  /** Lieferung aus der Monatsrechnung (LS-Nr = rechnungsNr). */
  lieferung: ParsedCsvRechnung;
  status: 'vorhanden' | 'fehlt';
  /** Bei 'vorhanden': die gematchte bestehende Buchung. */
  match?: InvoiceEntry;
}

export interface MonatsrechnungAbgleich {
  eintraege: AbgleichEintrag[];
  vorhanden: number;
  fehlt: number;
  /** Netto-Summe der bereits erfassten (gematchten) Buchungen. */
  summeErfasst: number;
  /** Netto-Summe aller Lieferungen laut Monatsrechnung. */
  summeMonatsrechnung: number;
}

const R2 = (n: number) => Math.round(n * 100) / 100;

function nachbarMonate(datum: string): string[] {
  const d = new Date(`${datum}T00:00:00Z`);
  const m = (off: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + off); return x.toISOString().slice(0, 7); };
  return [...new Set([m(-1), m(0), m(1)])];
}

/**
 * Vergleicht die Lieferungen einer Monatsrechnung mit dem Bestand.
 * Bereits gematchte Buchungen werden nicht doppelt vergeben (jede bestehende
 * Buchung deckt höchstens EINE Lieferung der Monatsrechnung).
 */
export async function abgleicheMonatsrechnung(
  tenantId: TenantId,
  lieferant: string,
  lieferungen: ParsedCsvRechnung[],
): Promise<MonatsrechnungAbgleich> {
  const monate = new Set<string>();
  for (const l of lieferungen) for (const m of nachbarMonate(l.datum)) monate.add(m);
  const bestand: InvoiceEntry[] = [];
  for (const m of [...monate].sort()) bestand.push(...await loadMonthInvoices(tenantId, m));
  const lief = lieferant.trim().toLowerCase();
  const kandidaten = bestand.filter(e => e.supplierName.trim().toLowerCase() === lief);

  const vergeben = new Set<string>();
  const eintraege: AbgleichEintrag[] = [];
  for (const l of lieferungen) {
    const lsNr = l.rechnungsNr.trim().toLowerCase();
    // 1) exakt über LS-Nr
    let match = lsNr === '' ? undefined : kandidaten.find(e =>
      !vergeben.has(e.id) && (e.reference ?? '').trim().toLowerCase() === lsNr);
    // 2) sonst Datum + Betrag (brutto ±0.10)
    if (!match) {
      match = kandidaten.find(e =>
        !vergeben.has(e.id) && e.date === l.datum && Math.abs(e.amountGross - l.bruttoTotal) <= 0.10);
    }
    if (match) vergeben.add(match.id);
    eintraege.push(match ? { lieferung: l, status: 'vorhanden', match } : { lieferung: l, status: 'fehlt' });
  }
  const vorhandenE = eintraege.filter(e => e.status === 'vorhanden');
  return {
    eintraege,
    vorhanden: vorhandenE.length,
    fehlt: eintraege.length - vorhandenE.length,
    summeErfasst: R2(vorhandenE.reduce((s, e) => s + (e.match?.amountNet ?? 0), 0)),
    summeMonatsrechnung: R2(lieferungen.reduce((s, l) => s + l.nettoTotal, 0)),
  };
}
