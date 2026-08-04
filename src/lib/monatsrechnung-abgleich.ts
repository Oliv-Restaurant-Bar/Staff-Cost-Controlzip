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

export interface ProvisorischVorschau {
  /** Lieferungen, die eine PROVISORISCHE Buchung (AB/Monatsrechnung) ersetzen. */
  ersetzt: number;
  /** Lieferungen ohne provisorischen Treffer (werden frisch gebucht). */
  neu: number;
  summeNetto: number;
}

/**
 * Vorschau für AB-als-Lieferschein-Profile (Terravigna): wie viele Lieferungen
 * der (massgeblichen) Rechnung ersetzen eine provisorische Auftragsbestätigungs-/
 * Monatsrechnungs-Buchung? Match wie im Kern: exakte Referenz (Monate ±1),
 * sonst Datum ±fensterTage + Betrag (brutto ±0.10); keine Doppelvergabe.
 * NUR Anzeige — massgeblich bleibt der Kern-Schreibpfad.
 */
export async function vorschauProvisorischeErsetzungen(
  tenantId: TenantId,
  lieferant: string,
  lieferungen: ParsedCsvRechnung[],
  fensterTage = 3,
): Promise<ProvisorischVorschau> {
  const monate = new Set<string>();
  for (const l of lieferungen) for (const m of nachbarMonate(l.datum)) monate.add(m);
  const bestand: InvoiceEntry[] = [];
  for (const m of [...monate].sort()) bestand.push(...await loadMonthInvoices(tenantId, m));
  const lief = lieferant.trim().toLowerCase();
  const prov = bestand.filter(e =>
    (e.quelle === 'auftragsbestaetigung' || e.quelle === 'monatsrechnung')
    && e.supplierName.trim().toLowerCase() === lief);
  const tageDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

  const vergeben = new Set<string>();
  let ersetzt = 0;
  for (const l of lieferungen) {
    const lsNr = l.rechnungsNr.trim().toLowerCase();
    const match = prov.find(e => !vergeben.has(e.id)
      && ((lsNr !== '' && (e.reference ?? '').trim().toLowerCase() === lsNr)
        || (tageDiff(e.date, l.datum) <= fensterTage && Math.abs(e.amountGross - l.bruttoTotal) <= 0.10)));
    if (match) { vergeben.add(match.id); ersetzt++; }
  }
  return {
    ersetzt,
    neu: lieferungen.length - ersetzt,
    summeNetto: R2(lieferungen.reduce((s, l) => s + l.nettoTotal, 0)),
  };
}
