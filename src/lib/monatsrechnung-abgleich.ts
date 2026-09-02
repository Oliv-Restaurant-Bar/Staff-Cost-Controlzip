/**
 * Monatsrechnungs-Abgleich für Dual-Lieferanten (Feldschlösschen, Fideco,
 * Spahni, Gasser, Terravigna).
 *
 * RANGORDNUNG: Monatsrechnung (final) > Lieferschein/Auftragsbestätigung
 * (provisorisch). Die Monatsrechnung ist die MASSGEBLICHE Quelle. Dieser
 * Vorschau-Helfer ermittelt Deckung und Differenzen; der produktive Schreibpfad
 * erhält Original-Lieferscheine als markierte Revisionshistorie und lässt nur
 * die autoritative Monatsrechnung wirtschaftlich zählen.
 *
 * Match je Lieferung gegen die erfassten Buchungen (Monate ±1):
 * 1. exakt über die LS-/Lieferungsnr (reference, case-insensitiv),
 * 2. sonst Datum (±fensterTage, Default 0 = exakt) + Betrag (brutto ±0.10).
 * Jede bestehende Buchung deckt höchstens EINE Lieferung.
 *
 * STUFE-1-MONATSRECHNUNG (Lieferanten OHNE Positions-Parser, z.B. Gourmador):
 * die Rechnung wird via kopfAlsLieferung() als EINE Gesamt-Lieferung
 * abgeglichen — nicht aufgeführte provisorische Lieferscheine werden vom
 * autoritativen Schreibpfad ebenfalls als ersetzt markiert, nie gelöscht.
 */
import { loadMonthInvoices, type InvoiceEntry } from '@/lib/waren-db';
import type { ParsedCsvRechnung } from '@/lib/waren-positionen';
import {
  gleicherWarenLieferant, istErsetzt, kanonischerWarenLieferant,
} from '@/lib/waren-monatsabgleich';
import type { TenantId } from '@/contexts/TenantContext';

/**
 * Stufe-1-Monatsrechnung als EINE Gesamt-Lieferung für den Abgleich/Import
 * (Dual-Lieferanten ohne Stufe-2-Parser, z.B. Gourmador). null, wenn der
 * Kopf unvollständig ist (Nr/Datum/Netto fehlen) — dann KEIN MR-Modus.
 */
export function kopfAlsLieferung(
  kopf: { rechnungsNr: string | null; rechnungsdatum: string | null; netto: number | null; mwst: number | null },
  profil: { name: string; kategorie: string; mwstSatz?: number },
): ParsedCsvRechnung | null {
  if (!kopf.rechnungsNr || !kopf.rechnungsdatum || kopf.netto === null) return null;
  const netto = kopf.netto;
  const mwst = kopf.mwst ?? 0;
  const satz = Math.abs(mwst) < 0.005
    ? 0
    : profil.mwstSatz === 2.6 || profil.mwstSatz === 8.1
      ? profil.mwstSatz
      : null;
  return {
    docKey: `${kopf.rechnungsNr}|${kopf.rechnungsdatum}|${profil.name}`,
    rechnungsNr: kopf.rechnungsNr, datum: kopf.rechnungsdatum, markt: profil.name,
    positionen: [{
      artNr: '', bezeichnung: 'Monatsrechnung gesamt', warengruppe: satz === 0 ? 'Leergut' : profil.kategorie,
      menge: 0, einheit: '', preis: 0, positionspreis: netto, mwstBetrag: mwst,
      mwstCode: satz === 0 ? 0 : satz === 2.6 ? 1 : 2,
      ...(satz !== null ? { mwstSatz: satz } : {}),
    }],
    nettoTotal: netto, mwstTotal: mwst, bruttoTotal: R2(netto + mwst),
  };
}

export interface AbgleichEintrag {
  /** Lieferung aus der Monatsrechnung (LS-Nr = rechnungsNr). */
  lieferung: ParsedCsvRechnung;
  /**
   * 'ueberschreiben' = bestehende Buchung wird mit den finalen Werten
   * überschrieben; 'unveraendert' = Treffer mit identischem Datum/Betrag
   * (wird trotzdem finalisiert); 'neu' = kein Treffer, frisch aus der Rechnung.
   */
  status: 'ueberschreiben' | 'unveraendert' | 'neu';
  /** Bei Treffer: die gematchte bestehende Buchung. */
  match?: InvoiceEntry;
  /** Treffer stammt NICHT aus einem bekannten Import (id-Präfix) — vermutlich
   *  manuell erfasst/bearbeitet: vor dem Überschreiben warnen. */
  manuell?: boolean;
  /** Abweichungen alt→neu (nur bei 'ueberschreiben'). */
  diffBetrag?: { alt: number; neu: number };
  diffDatum?: { alt: string; neu: string };
}

export interface MonatsrechnungAbgleich {
  eintraege: AbgleichEintrag[];
  ueberschrieben: number;
  unveraendert: number;
  neu: number;
  /** Anzahl Treffer, die vermutlich manuell erfasst/bearbeitet wurden. */
  manuell: number;
  /** Netto-Summe aller Lieferungen laut Monatsrechnung. */
  summeMonatsrechnung: number;
  /**
   * GEGENRICHTUNG: provisorische Buchungen des Lieferanten in den MONATEN der
   * Monatsrechnungs-Lieferungen (exakte Monate, nicht ±1), die von KEINER
   * Lieferung gematcht wurden — «erfasst, aber nicht in der Monatsrechnung».
   * Müssen einzeln bestätigt werden (behalten/entfernen), nie still behandelt.
   */
  nichtInMr: InvoiceEntry[];
  /** Netto-Summe der erfassten provisorischen Buchungen in den MR-Monaten
   *  (Basis für die sichtbare Differenz zur Monatsrechnung). */
  summeErfasst: number;
}

const R2 = (n: number) => Math.round(n * 100) / 100;
/** Bekannte Import-id-Präfixe — alles andere gilt als manuell erfasst. */
const IMPORT_ID_PREFIXE = ['fs-', 'lpdf-'];

function nachbarMonate(datum: string): string[] {
  const d = new Date(`${datum}T00:00:00Z`);
  const m = (off: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + off); return x.toISOString().slice(0, 7); };
  return [...new Set([m(-1), m(0), m(1)])];
}

const tageDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

/**
 * Vergleicht die Lieferungen einer (massgeblichen) Monatsrechnung mit dem
 * Bestand — Vorschau für «überschrieben / neu / unverändert» inkl. alt→neu.
 * NUR Anzeige; massgeblich bleibt der Kern-Schreibpfad (fs-import).
 */
export async function abgleicheMonatsrechnung(
  tenantId: TenantId,
  lieferant: string,
  lieferungen: ParsedCsvRechnung[],
  fensterTage = 0,
  supplierVatId?: string,
): Promise<MonatsrechnungAbgleich> {
  const monate = new Set<string>();
  for (const l of lieferungen) for (const m of nachbarMonate(l.datum)) monate.add(m);
  const bestand: InvoiceEntry[] = [];
  for (const m of [...monate].sort()) bestand.push(...await loadMonthInvoices(tenantId, m));
  const ziel = { supplierName: lieferant, supplierVatId };
  const kandidaten = bestand.filter(e => !istErsetzt(e) && gleicherWarenLieferant(e, ziel));

  const vergeben = new Set<string>();
  const eintraege: AbgleichEintrag[] = [];
  for (const l of lieferungen) {
    const lsNr = l.rechnungsNr.trim().toLowerCase();
    // 1) exakt über LS-Nr
    let match = lsNr === '' ? undefined : kandidaten.find(e =>
      !vergeben.has(e.id) && (e.reference ?? '').trim().toLowerCase() === lsNr);
    // 2) sonst Datum (±fensterTage) + Betrag (brutto ±0.10)
    if (!match) {
      match = kandidaten.find(e =>
        !vergeben.has(e.id) && tageDiff(e.date, l.datum) <= fensterTage
        && Math.abs(e.amountGross - l.bruttoTotal) <= 0.10);
    }
    if (!match) { eintraege.push({ lieferung: l, status: 'neu' }); continue; }
    vergeben.add(match.id);
    const gleicherBetrag = Math.abs(match.amountGross - l.bruttoTotal) <= 0.005;
    const gleichesDatum = match.date === l.datum;
    const manuell = !IMPORT_ID_PREFIXE.some(p => match!.id.startsWith(p));
    eintraege.push({
      lieferung: l,
      status: gleicherBetrag && gleichesDatum ? 'unveraendert' : 'ueberschreiben',
      match,
      ...(manuell ? { manuell: true } : {}),
      ...(!gleicherBetrag ? { diffBetrag: { alt: R2(match.amountGross), neu: R2(l.bruttoTotal) } } : {}),
      ...(!gleichesDatum ? { diffDatum: { alt: match.date, neu: l.datum } } : {}),
    });
  }
  // GEGENRICHTUNG: provisorische (!final) Buchungen des Lieferanten in den
  // EXAKTEN Monaten der MR-Lieferungen, die kein Match erhalten haben.
  const mrMonate = new Set(lieferungen.map(l => l.datum.slice(0, 7)));
  const imMrMonat = kandidaten.filter(e => mrMonate.has(e.date.slice(0, 7)) && !e.final);
  const nichtInMr = imMrMonat.filter(e => !vergeben.has(e.id));
  return {
    eintraege,
    ueberschrieben: eintraege.filter(e => e.status === 'ueberschreiben').length,
    unveraendert: eintraege.filter(e => e.status === 'unveraendert').length,
    neu: eintraege.filter(e => e.status === 'neu').length,
    manuell: eintraege.filter(e => e.manuell).length,
    summeMonatsrechnung: R2(lieferungen.reduce((s, l) => s + l.nettoTotal, 0)),
    nichtInMr,
    summeErfasst: R2(imMrMonat.reduce((s, e) => s + e.amountNet, 0)),
  };
}
